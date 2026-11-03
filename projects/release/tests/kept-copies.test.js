// The SDK's fixture generators and its guild feature check read upstream files through the kept copies the drift check
// keeps. Each test uses its own copies folder and fake GitHub, so no test touches the checkout's copies or the network
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { writeExamples } from "../../sdk/scripts/openapi-examples.js"
import { writeGatewayDocs } from "../../sdk/scripts/gateway-docs.js"
import { readGuildSources } from "../../sdk/tests/contract/upstream-guild-features.js"

const commit = "a".repeat(40)
const sha256 = (text) => createHash("sha256").update(text).digest("hex")
const objectId = (text) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex")
// A copy no generator reads, which must stay, since only the drift check prunes the shared folder
const unrelated = "f".repeat(40)

function folders(t) {
    const directory = mkdtempSync(join(tmpdir(), "fluxerly-kept-copies-"))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const copies = join(directory, "copies")
    return { directory, copies }
}

// GitHub's folder listing and raw file hosts for the upstream files in `files`, recording each request
function fakeGitHub(t, files) {
    const requests = []
    const original = globalThis.fetch
    t.after(() => (globalThis.fetch = original))
    globalThis.fetch = async (input) => {
        const url = new URL(String(input))
        if (url.host === "raw.githubusercontent.com") {
            const path = decodeURIComponent(url.pathname.split("/").slice(4).join("/"))
            requests.push(`file ${path}`)
            return path in files.current ? new Response(files.current[path]) : new Response("", { status: 404 })
        }
        const listed = url.pathname.match(/^\/repos\/fluxerapp\/fluxer\/contents\/(.+)$/)
        if (url.host === "api.github.com" && listed && url.searchParams.get("ref") === commit) {
            const directory = decodeURIComponent(listed[1])
            requests.push(`list ${directory}`)
            const entries = Object.entries(files.current)
                .filter(([path]) => path.split("/").slice(0, -1).join("/") === directory)
                .map(([path, text]) => ({ path, type: "file", sha: objectId(text) }))
            return new Response(JSON.stringify(entries))
        }
        return new Response("", { status: 500 })
    }
    return requests
}

function manifest(directory, pins) {
    const file = join(directory, "manifest.json")
    writeFileSync(
        file,
        JSON.stringify({
            repository: "fluxerapp/fluxer",
            branch: "main",
            commit,
            files: { openapi: { path: "fluxer_api/openapi.json", sha256: pins.openapi ?? "0".repeat(64) } },
            gatewayDocs: { path: "fluxer_docs/gateway", sha256: pins.gateway ?? "0".repeat(64) },
            rateLimits: { path: "fluxer_api/rate_limit_configs", sha256: "0".repeat(64) },
        }),
    )
    return file
}

for (const { name, run, paths } of [
    { name: "The OpenAPI example generator", paths: ["fluxer_api/openapi.json"], run: writeExamples },
    {
        name: "The gateway documentation generator",
        paths: ["fluxer_docs/gateway/events.md", "fluxer_docs/gateway/threads.md"],
        run: writeGatewayDocs,
    },
]) {
    test(`${name} downloads an upstream file only when no kept copy matches it, and checks every read against the pin`, async (t) => {
        const { directory, copies } = folders(t)
        const files = { current: Object.fromEntries(paths.map((path) => [path, `${path} first`])) }
        const requests = fakeGitHub(t, files)
        // Pins that no fake file matches, so each run stops at the pin check right after reading. A kept copy must not
        // get past it
        const options = { copiesFolder: copies, manifestFile: manifest(directory, {}), fixtureFile: join(directory, "fixture.json") }
        const downloads = () => requests.filter((request) => request.startsWith("file "))

        await assert.rejects(run(options), /pinned hash/)
        assert.deepEqual(downloads().sort(), paths.map((path) => `file ${path}`).sort())
        assert.deepEqual(readdirSync(copies).sort(), paths.map((path) => objectId(files.current[path])).sort())
        writeFileSync(join(copies, unrelated), "Another check's copy")

        requests.length = 0
        await assert.rejects(run(options), /pinned hash/)
        assert.deepEqual(downloads(), [], "An unchanged file comes from its kept copy")
        assert.ok(requests.length > 0, "Each run lists the folder fresh")

        // A damaged copy and a changed file are each downloaded again
        writeFileSync(join(copies, objectId(files.current[paths[0]])), "Damaged copy")
        if (paths[1]) files.current[paths[1]] = `${paths[1]} second`
        requests.length = 0
        await assert.rejects(run(options), /pinned hash/)
        assert.deepEqual(downloads().sort(), paths.map((path) => `file ${path}`).sort())
        assert.ok(existsSync(join(copies, unrelated)), "A generator never prunes the shared copies")
        assert.equal(existsSync(options.fixtureFile), false)
    })
}

test("The OpenAPI example generator reads a kept copy that matches the pin like a download", async (t) => {
    const { directory, copies } = folders(t)
    const text = JSON.stringify({ openapi: "3.1.0" })
    const files = { current: { "fluxer_api/openapi.json": text } }
    const requests = fakeGitHub(t, files)
    const options = { copiesFolder: copies, manifestFile: manifest(directory, { openapi: sha256(text) }), fixtureFile: join(directory, "fixture.json") }
    // Past the pin check, the made-up document lacks the schemas the SDK decodes, which fails generation the same way
    // whether the document was downloaded or kept
    const first = await run(options)
    requests.length = 0
    assert.deepEqual(await run(options), first)
    assert.deepEqual(requests.filter((request) => request.startsWith("file ")), [])

    async function run(settings) {
        return writeExamples(settings).then(
            () => "written",
            (error) => error.message,
        )
    }
    assert.doesNotMatch(first, /pinned hash/)
})

test("The guild feature check reads the head fresh and downloads only guild files no kept copy matches", async (t) => {
    const { copies } = folders(t)
    const revision = "c".repeat(40)
    const files = {
        "fluxer_api/src/api/guild/services/data/GuildOperationsService.ts": "const USER_TOGGLEABLE_GUILD_FEATURES = new Set([])",
        "fluxer_api/src/api/guild/services/data/Other.ts": "other",
        "fluxer_api/src/api/guild/services/content/EmojiService.ts": "emoji",
        "fluxer_api/src/api/guild/services/content/StickerService.ts": "sticker",
    }
    const calls = []
    const github = (path) => {
        calls.push(path)
        if (path === "commits/main") return { sha: revision }
        const [target, ref] = path.replace(/^contents\//, "").split("?ref=")
        assert.equal(ref, revision, "Every file read is pinned to the resolved revision")
        if (target in files) return { encoding: "base64", content: Buffer.from(files[target]).toString("base64") }
        return Object.entries(files)
            .filter(([file]) => file.split("/").slice(0, -1).join("/") === target)
            .map(([file, text]) => ({ path: file, type: "file", sha: objectId(text) }))
    }
    const downloads = () => calls.filter((call) => /\.ts\?ref=/.test(call))

    const first = await readGuildSources({ github, copiesFolder: copies })
    assert.equal(first.revision, revision)
    assert.equal(first.services.Sticker, "sticker")
    assert.equal(downloads().length, 3)
    writeFileSync(join(copies, unrelated), "Another check's copy")

    calls.length = 0
    assert.deepEqual(await readGuildSources({ github, copiesFolder: copies }), first)
    assert.deepEqual(calls, [
        "commits/main",
        `contents/fluxer_api/src/api/guild/services/data?ref=${revision}`,
        `contents/fluxer_api/src/api/guild/services/content?ref=${revision}`,
    ])

    files["fluxer_api/src/api/guild/services/content/EmojiService.ts"] = "emoji changed"
    calls.length = 0
    assert.equal((await readGuildSources({ github, copiesFolder: copies })).services.Emoji, "emoji changed")
    assert.deepEqual(downloads(), [`contents/fluxer_api/src/api/guild/services/content/EmojiService.ts?ref=${revision}`])
    assert.ok(existsSync(join(copies, unrelated)), "The check never prunes the shared copies")
})
