import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fetchReleases } from "../scripts/fetch-releases.js"

const repository = "NeonTechSpace/Fluxerly.js"
const source = "a".repeat(40)
const snapshot = (version = "1000.0.0") => ({
    schemaVersion: 3,
    version,
    sourceCommit: source,
    files: ["guides/index.md", "guides/quick-start.md", "guides/meta.json", "guides/glossary.md", "changelog.md", "reference/model.json", "reference/codes.json", "reference/links.json", "reference/endpoints.json"].map((path) => ({ path, content: `# ${path}\n` })),
})
const encode = (value) => Buffer.from(JSON.stringify(value))
function release(version = "1000.0.0", id = 1, value = snapshot(version)) {
    const bytes = encode(value)
    const asset = {
        name: "docs.json",
        id,
        state: "uploaded",
        size: bytes.length,
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    }
    return {
        metadata: { draft: false, prerelease: version.includes("-"), tag_name: `v${version}`, assets: [asset] },
        bytes,
    }
}
async function fixture(t, items = [], options = {}) {
    const root = await mkdtemp(join(tmpdir(), "fluxerly-release-import-"))
    t.after(async () => {
        await rm(root, { recursive: true, force: true })
        await assert.rejects(lstat(root), { code: "ENOENT" })
    })
    const calls = []
    const gh = async (args) => {
        calls.push(args)
        if (options.read) return options.read(args, calls.length, root)
        if (args.includes("--paginate")) return encode(options.pages ?? [items.map((item) => item.metadata)])
        const endpoint = args.find((arg) => arg.startsWith("repos/"))
        if (endpoint.includes("/releases/assets/"))
            return items.find((item) => String(item.metadata.assets[0]?.id) === endpoint.split("/").at(-1))?.bytes
        if (endpoint.includes("/commits/")) return encode({ sha: options.commit ?? source })
        throw new Error("Unexpected fixture request")
    }
    return { root, gh, calls, directory: join(root, "released"), run: () => fetchReleases({ root, gh }) }
}

test("An empty paginated release inventory imports no archive", async (t) => {
    const f = await fixture(t)
    assert.deepEqual(await f.run(), { imported: [] })
    assert.deepEqual(await readdir(f.directory), [])
    assert.deepEqual(f.calls, [
        ["api", "--hostname", "github.com", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`],
    ])
})

test("Published stable and prerelease assets are checksum/source verified and read back byte-for-byte", async (t) => {
    const stable = release(),
        nightly = release("1000.1.0-nightly.1", 2)
    const f = await fixture(t, [stable, nightly], { pages: [[stable.metadata], [nightly.metadata]] })
    assert.deepEqual(await f.run(), { imported: ["1000.0.0", "1000.1.0-nightly.1"] })
    assert.deepEqual(await readdir(f.directory), ["1000.0.0.json", "1000.1.0-nightly.1.json"])
    assert.ok((await readFile(join(f.directory, "1000.0.0.json"))).equals(stable.bytes))
    assert.ok((await readFile(join(f.directory, "1000.1.0-nightly.1.json"))).equals(nightly.bytes))
    assert.deepEqual(f.calls.slice(1), [
        [
            "api",
            "--hostname",
            "github.com",
            `repos/${repository}/releases/assets/1`,
            "-H",
            "Accept: application/octet-stream",
        ],
        ["api", "--hostname", "github.com", `repos/${repository}/commits/v1000.0.0`],
        [
            "api",
            "--hostname",
            "github.com",
            `repos/${repository}/releases/assets/2`,
            "-H",
            "Accept: application/octet-stream",
        ],
        ["api", "--hostname", "github.com", `repos/${repository}/commits/v1000.1.0-nightly.1`],
    ])
})

test("Drafts are skipped without reading assets or source tags", async (t) => {
    const draft = { draft: true, tag_name: "unpublished", assets: [] }
    const f = await fixture(t, [], { pages: [[draft]] })
    assert.deepEqual(await f.run(), { imported: [] })
    assert.equal(f.calls.length, 1)
})

test("Imports retain Stable history and the newest Nightly while ignoring old rc versions", async (t) => {
    // Retired Canary releases must still parse, but their assets are never read. The dated nightly is newer than every
    // older numbered nightly of its core, whatever their numbers
    const items = [release("1000.0.0-nightly.9", 1), release("1000.0.0", 2), release("1000.0.0-rc.0", 3),
        release("1000.0.1", 4), release("1000.0.0-nightly.10", 5), release("1000.0.0-rc.1", 6),
        release("1000.1.0-canary.4", 8), release("1000.0.0-canary.2", 9), release("1000.0.0-nightly.20261019.2", 10)]
    const draft = release("1000.1.0-nightly.0", 7)
    draft.metadata.draft = true
    const f = await fixture(t, [...items, draft], { pages: [items.slice(0, 3).map((item) => item.metadata),
        [...items.slice(3).map((item) => item.metadata), draft.metadata]] })
    assert.deepEqual((await f.run()).imported, ["1000.0.0", "1000.0.1", "1000.0.0-nightly.20261019.2"])
    for (const id of [1, 3, 5, 6, 7, 8, 9]) assert.ok(!f.calls.some((args) => args.includes(`repos/${repository}/releases/assets/${id}`)))
    assert.ok(!f.calls.some((args) => args.some((arg) => arg.includes("canary"))))
    assert.deepEqual((await readdir(f.directory)).sort(), ["1000.0.0-nightly.20261019.2.json", "1000.0.0.json", "1000.0.1.json"])
    for (const item of [items[1], items[3], items[8]]) {
        const version = item.metadata.tag_name.slice(1)
        assert.deepEqual(await readFile(join(f.directory, `${version}.json`)), item.bytes)
    }
})

test("An inventory of only retired Canary releases imports nothing and reads no asset", async (t) => {
    const f = await fixture(t, [release("1000.0.0-canary.0", 1), release("1000.0.0-canary.1", 2)])
    assert.deepEqual(await f.run(), { imported: [] })
    assert.deepEqual(await readdir(f.directory), [])
    assert.equal(f.calls.length, 1)
})

test("A broken newest prerelease fails instead of falling back to an older release", async (t) => {
    const previous = release("1000.0.0-nightly.0", 1)
    const newest = release("1000.0.0-nightly.1", 2)
    newest.bytes = Buffer.from("Invalid newest snapshot")
    const f = await fixture(t, [previous, newest])
    await assert.rejects(f.run(), /checksum mismatch/)
    assert.deepEqual(await readdir(f.directory), [])
    assert.ok(!f.calls.some((args) => args.includes(`repos/${repository}/releases/assets/1`)))
})

test("Malformed inventories and incomplete or duplicate docs assets are rejected without output", async (t) => {
    const item = release()
    const inventories = [
        [null, /Invalid paginated GitHub release inventory/],
        [{}, /Invalid paginated GitHub release inventory/],
        [[item.metadata], /Invalid paginated GitHub release inventory/],
        [[[null]], /Invalid published GitHub release metadata/],
        [[[{ ...item.metadata, draft: undefined }]], /Invalid published GitHub release metadata/],
        [[[{ ...item.metadata, assets: [] }]], /no unique docs snapshot/],
        [[[{ ...item.metadata, assets: [...item.metadata.assets, ...item.metadata.assets] }]], /no unique docs snapshot/],
    ]
    for (const [pages, reason] of inventories) {
        const f = await fixture(t, [item], { pages })
        if (pages === null) f.gh = async () => encode(null)
        await assert.rejects(fetchReleases({ root: f.root, gh: f.gh }), reason)
        assert.deepEqual(await readdir(f.directory), [])
    }
})

test("Invalid asset metadata and tampered or truncated bytes fail before any archive write", async (t) => {
    for (const patch of [
        { id: 0 },
        { id: 1.5 },
        { size: -1 },
        { size: 1.5 },
        { size: 64 * 1024 * 1024 + 1 },
        { state: "new" },
        { digest: undefined },
        { digest: "sha256:invalid" },
        { digest: `sha256:${"0".repeat(64)}` },
    ]) {
        const item = release()
        Object.assign(item.metadata.assets[0], patch)
        const f = await fixture(t, [item])
        await assert.rejects(f.run(), /asset metadata|checksum/)
        assert.deepEqual(await readdir(f.directory), [])
    }
    for (const modify of [
        (bytes) => Buffer.concat([bytes, Buffer.from("tampering")]),
        (bytes) => bytes.subarray(0, -1),
    ]) {
        const item = release()
        item.bytes = modify(item.bytes)
        const f = await fixture(t, [item])
        await assert.rejects(f.run(), /checksum/)
        assert.deepEqual(await readdir(f.directory), [])
    }
})

test("An invalid imported snapshot fails with a generic reason and writes nothing", async (t) => {
    // The validator's rules are covered in docs.test.js. The import wraps its detail and writes no archive
    const value = { ...snapshot(), files: [{ path: "../escape.md", content: "Private fixture body" }] }
    const f = await fixture(t, [release("1000.0.0", 1, value)])
    await assert.rejects(f.run(), (error) => error.message === "Invalid docs snapshot")
    assert.deepEqual(await readdir(f.directory), [])
})

test("Release tag, source commit and repeated exact version must identify the same archive", async (t) => {
    const wrongTag = release()
    wrongTag.metadata.tag_name = "v1000.1.0"
    const cases = [
        { items: [wrongTag] },
        { items: [release()], options: { commit: "b".repeat(40) } },
        { items: [release(), release("1000.0.0", 2)] },
    ]
    for (const { items, options } of cases) {
        const f = await fixture(t, items, options)
        await assert.rejects(f.run(), /unique docs version|release source/)
        assert.deepEqual(await readdir(f.directory), [])
    }
})

test("A partial remote read failure does not import a misleading partial release inventory or expose details", async (t) => {
    const first = release(),
        second = release("1000.1.0", 2)
    const f = await fixture(t, [], {
        read: (args) => {
            if (args.includes("--paginate")) return encode([[first.metadata, second.metadata]])
            const endpoint = args.find((arg) => arg.startsWith("repos/"))
            if (endpoint.endsWith("/assets/1")) return first.bytes
            if (endpoint.includes("/commits/")) return encode({ sha: source })
            throw new Error("Private provider response body and test-only credential")
        },
    })
    await assert.rejects(f.run(), (error) => /release read failed/.test(error.message) &&
        !error.message.includes("Private provider response body") && !error.message.includes("credential"))
    // The failed read is the last one: no retry and no further release is read
    assert.equal(f.calls.length, 4)
    assert.deepEqual(await readdir(f.directory), [])
})

test("Existing archives and files added during reads are preserved and reject the import", async (t) => {
    const existing = await fixture(t, [release()])
    await mkdir(existing.directory)
    await writeFile(join(existing.directory, "user-owned.json"), "Keep this file")
    await assert.rejects(existing.run(), /empty generated archive directory/)
    assert.equal(existing.calls.length, 0)
    assert.equal(await readFile(join(existing.directory, "user-owned.json"), "utf8"), "Keep this file")
    const concurrent = await fixture(t, [], {
        read: async (_args, _count, root) => {
            await writeFile(join(root, "released", "concurrent.json"), "Keep concurrent file")
            return encode([[]])
        },
    })
    await assert.rejects(concurrent.run(), /changed during import/)
    assert.equal(await readFile(join(concurrent.directory, "concurrent.json"), "utf8"), "Keep concurrent file")
})

test("A generated archive symlink is rejected without reading GitHub or touching its target", async (t) => {
    const f = await fixture(t)
    const outside = join(f.root, "authored")
    await mkdir(outside)
    await writeFile(join(outside, "keep.md"), "Keep authored content")
    await symlink(outside, f.directory, process.platform === "win32" ? "junction" : "dir")
    await assert.rejects(f.run(), /real generated directory/)
    assert.equal(f.calls.length, 0)
    assert.equal(await readFile(join(outside, "keep.md"), "utf8"), "Keep authored content")
})

test("Import errors are whole sentences without semicolons", async (t) => {
    const failing = await fixture(t, [], { read: () => { throw new Error("Private provider response body") } })
    await assert.rejects(failing.run(), { message: "Authenticated GitHub release read failed. No automatic retry was attempted" })
    const existing = await fixture(t, [release()])
    await mkdir(existing.directory)
    await writeFile(join(existing.directory, "user-owned.json"), "Keep this file")
    await assert.rejects(existing.run(), { message: "Release import requires an empty generated archive directory. Existing files are preserved" })
    const concurrent = await fixture(t, [], {
        read: async (_args, _count, root) => {
            await writeFile(join(root, "released", "concurrent.json"), "Keep concurrent file")
            return encode([[]])
        },
    })
    await assert.rejects(concurrent.run(), { message: "Release archive changed during import. Existing files are preserved" })
})

const assetReads = (calls) => calls.filter((args) => args.some((arg) => arg.includes("/releases/assets/")))
const cacheOf = (f) => join(f.root, ".cache", "releases")
const emptyArchive = async (f) => {
    await rm(f.directory, { recursive: true, force: true })
}

test("A kept copy of an asset is used instead of downloading it again, and the import stays the same", async (t) => {
    const stable = release(),
        nightly = release("1000.1.0-nightly.1", 2)
    const f = await fixture(t, [stable, nightly])
    const first = await f.run()
    assert.equal(assetReads(f.calls).length, 2)
    assert.deepEqual((await readdir(cacheOf(f))).sort(), [stable, nightly].map((item) => `${item.metadata.assets[0].digest.slice(7)}.json`).sort())
    await emptyArchive(f)
    f.calls.length = 0
    assert.deepEqual(await f.run(), first)
    // The release list and source tags are read again, since they can change, but no asset is
    assert.equal(assetReads(f.calls).length, 0)
    assert.ok(f.calls.some((args) => args.includes("--paginate")))
    assert.deepEqual(await readFile(join(f.directory, "1000.0.0.json")), stable.bytes)
    assert.deepEqual(await readFile(join(f.directory, "1000.1.0-nightly.1.json")), nightly.bytes)
})

test("A kept copy that no longer matches its digest is downloaded again and replaced", async (t) => {
    const stable = release()
    const f = await fixture(t, [stable])
    await f.run()
    const copy = join(cacheOf(f), `${stable.metadata.assets[0].digest.slice(7)}.json`)
    // Same length, other bytes, so only the digest tells them apart
    await writeFile(copy, Buffer.alloc(stable.bytes.length, 0x20))
    await emptyArchive(f)
    f.calls.length = 0
    await f.run()
    assert.equal(assetReads(f.calls).length, 1)
    assert.deepEqual(await readFile(copy), stable.bytes)
    assert.deepEqual(await readFile(join(f.directory, "1000.0.0.json")), stable.bytes)
})

test("Filling only the cache writes no archive, leaves other files alone and keeps only retained releases' copies", async (t) => {
    const old = release("1000.0.0-nightly.1", 1),
        stable = release("1000.0.0", 2)
    const f = await fixture(t, [old])
    await fetchReleases({ root: f.root, gh: f.gh, write: false })
    await assert.rejects(lstat(f.directory), { code: "ENOENT" })
    await writeFile(join(cacheOf(f), "notes.txt"), "Not a copy")
    // A newer nightly replaces the old one, whose copy goes, while a file that isn't a copy stays
    const newer = release("1000.0.0-nightly.2", 3)
    const next = await fixture(t, [stable, newer])
    await mkdir(next.directory)
    await writeFile(join(next.directory, "user-owned.json"), "Keep this file")
    await mkdir(cacheOf(next), { recursive: true })
    for (const name of await readdir(cacheOf(f))) await writeFile(join(cacheOf(next), name), await readFile(join(cacheOf(f), name)))
    assert.deepEqual((await fetchReleases({ root: next.root, gh: next.gh, write: false })).imported, ["1000.0.0", "1000.0.0-nightly.2"])
    assert.deepEqual(
        (await readdir(cacheOf(next))).sort(),
        ["notes.txt", ...[stable, newer].map((item) => `${item.metadata.assets[0].digest.slice(7)}.json`)].sort(),
    )
    assert.deepEqual(await readdir(next.directory), ["user-owned.json"])
})
