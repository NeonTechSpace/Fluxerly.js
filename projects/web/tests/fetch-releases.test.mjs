import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fetchReleases } from "../scripts/fetch-releases.mjs"

const repository = "NeonTechSpace/Fluxerly.js"
const source = "a".repeat(40)
const snapshot = (version = "1000.0.0") => ({
    schemaVersion: 1,
    version,
    sourceCommit: source,
    files: ["index.md", "quick-start.md", "changelog.md"].map((path) => ({ path, content: `# ${path}\n` })),
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
        canary = release("1000.1.0-canary.1", 2)
    const f = await fixture(t, [stable, canary], { pages: [[stable.metadata], [canary.metadata]] })
    assert.deepEqual(await f.run(), { imported: ["1000.0.0", "1000.1.0-canary.1"] })
    assert.deepEqual(await readdir(f.directory), ["1000.0.0.json", "1000.1.0-canary.1.json"])
    assert.ok((await readFile(join(f.directory, "1000.0.0.json"))).equals(stable.bytes))
    assert.ok((await readFile(join(f.directory, "1000.1.0-canary.1.json"))).equals(canary.bytes))
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
        ["api", "--hostname", "github.com", `repos/${repository}/commits/v1000.1.0-canary.1`],
    ])
})

test("Drafts are skipped without reading assets or source tags", async (t) => {
    const draft = { draft: true, tag_name: "unpublished", assets: [] }
    const f = await fixture(t, [], { pages: [[draft]] })
    assert.deepEqual(await f.run(), { imported: [] })
    assert.equal(f.calls.length, 1)
})

test("Malformed inventories and incomplete or duplicate docs assets are rejected without output", async (t) => {
    const item = release()
    const inventories = [
        null,
        {},
        [item.metadata],
        [[null]],
        [[{ ...item.metadata, draft: undefined }]],
        [[{ ...item.metadata, assets: [] }]],
        [[{ ...item.metadata, assets: [...item.metadata.assets, ...item.metadata.assets] }]],
    ]
    for (const pages of inventories) {
        const f = await fixture(t, [item], { pages })
        if (pages === null) f.gh = async () => encode(null)
        await assert.rejects(fetchReleases({ root: f.root, gh: f.gh }))
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

test("The production snapshot validator rejects traversal, duplicate files and missing provenance", async (t) => {
    const invalid = [
        { ...snapshot(), version: "../escape" },
        { ...snapshot(), sourceCommit: "main" },
        { ...snapshot(), files: [{ path: "../escape.md", content: "Private fixture body" }] },
        { ...snapshot(), files: [...snapshot().files, snapshot().files[0]] },
        { ...snapshot(), files: snapshot().files.slice(1) },
    ]
    for (const value of invalid) {
        const f = await fixture(t, [release("1000.0.0", 1, value)])
        await assert.rejects(f.run(), (error) => error.message === "Invalid docs snapshot")
        assert.deepEqual(await readdir(f.directory), [])
    }
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
    await assert.rejects(
        f.run(),
        (error) => error.message === "Authenticated GitHub release read failed; no automatic retry was attempted",
    )
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
        read: async (args, count, root) => {
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
