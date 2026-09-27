import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import { checkUpstream, eventNames, renderReport, schemaChanges, validateManifest } from "../upstream.js"

const pinned = "a".repeat(40)
const current = "b".repeat(40)
const hash = (text) => createHash("sha256").update(text).digest("hex")
const openapi = (schemas) => JSON.stringify({ openapi: "3.1.0", components: { schemas } })
const events = (names) => ["# Gateway events", ...names.map((name) => `### <span id="${name}"></span>${name}`)].join("\n")

function manifest(files) {
    return {
        repository: "fluxerapp/fluxer",
        branch: "main",
        commit: pinned,
        files: {
            openapi: { path: "openapi.json", sha256: hash(files[pinned]["openapi.json"]) },
            gatewayEvents: { path: "events.md", sha256: hash(files[pinned]["events.md"]) },
        },
    }
}

function source(files) {
    const reads = []
    return {
        reads,
        resolveCommit: async (repository, branch) => {
            reads.push(`resolve ${repository} ${branch}`)
            return current
        },
        fetchFile: async (_repository, commit, path) => {
            reads.push(`${commit.slice(0, 1)} ${path}`)
            return Buffer.from(files[commit][path])
        },
    }
}

test("The pinned upstream manifest identifies an exact commit and document hashes", () => {
    const value = JSON.parse(readFileSync(new URL("../upstream/manifest.json", import.meta.url), "utf8"))
    assert.doesNotThrow(() => validateManifest(value))
    assert.throws(() => validateManifest({ ...value, commit: "main" }), /invalid/)
})

test("Unchanged upstream documents report no drift without reading the pinned copies", async () => {
    const document = { "openapi.json": openapi({ User: { type: "object" } }), "events.md": events(["READY"]) }
    const files = { [pinned]: document, [current]: document }
    const upstream = source(files)
    const result = await checkUpstream(manifest(files), upstream)
    assert.equal(result.drift, false)
    assert.equal(result.commit, current)
    assert.ok(upstream.reads.every((read) => !read.startsWith("a ")))
    assert.match(renderReport(result), /match the pinned manifest/)
})

test("Changed documents report the new commit with added, removed and changed schema and event names", async () => {
    const files = {
        [pinned]: {
            "openapi.json": openapi({ Guild: { type: "object" }, User: { type: "object" }, Old: {} }),
            "events.md": events(["READY", "TYPING_START"]),
        },
        [current]: {
            "openapi.json": openapi({ Guild: { type: "object", required: ["id"] }, User: { type: "object" }, New: {} }),
            "events.md": events(["READY", "MESSAGE_ACK"]),
        },
    }
    const result = await checkUpstream(manifest(files), source(files))
    assert.equal(result.drift, true)
    assert.deepEqual(result.schemas, { added: ["New"], removed: ["Old"], changed: ["Guild"] })
    assert.deepEqual(result.events, { added: ["MESSAGE_ACK"], removed: ["TYPING_START"] })
    const report = renderReport(result)
    // Names are escaped for Markdown, so decoding the character references recovers them
    const decoded = report.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))).replaceAll("&amp;", "&")
    for (const name of [current, "New", "Old", "Guild", "MESSAGE_ACK", "TYPING_START"])
        assert.ok(decoded.includes(name), name)
    assert.equal(report.includes("TYPING_START"), false, "Markdown emphasis characters are escaped")
})

test("Schema and event extraction ignore unrelated structure", () => {
    assert.deepEqual(schemaChanges({}, { components: { schemas: { A: {} } } }), { added: ["A"], removed: [], changed: [] })
    assert.deepEqual(eventNames("## Dispatch events\n### RESUMED\n### Not an event name\n#### NESTED"), ["RESUMED"])
})
