import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import { checkUpstream, eventChanges, openapiChanges, rateLimitBuckets, renderReport, validateManifest } from "../upstream.js"

const pinned = "a".repeat(40)
const current = "b".repeat(40)
const limits = "limits"
const hash = (text) => createHash("sha256").update(text).digest("hex")
const openapi = (paths, schemas) => JSON.stringify({ openapi: "3.1.0", paths, components: { schemas } })
const bot = [{ botToken: [] }, { sessionToken: [] }]
const session = [{ sessionToken: [] }]
const returns = (name, security) => ({
    security,
    responses: { 200: { content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` } } } } },
})
const events = (sections) =>
    ["# Gateway events", "## Dispatch events", ...sections.map(([name, body]) => `### <span id="${name}"></span>${name}\n\n${body}`)].join(
        "\n\n",
    )
const table = (rows) => ["| Field | Type | Description |", "| --- | --- | --- |", ...rows].join("\n")
const bucket = (name, limit = 10) => `export const Configs = {\n\tX: {\n\t\tbucket: '${name}',\n\t\tconfig: {limit: ${limit}},\n\t},\n}\n`

function upstream(files) {
    const bucketHash = hash(rateLimitBuckets(Object.entries(files[pinned]).filter(([path]) => path.startsWith(`${limits}/`)).map(([, text]) => text)).join("\n"))
    const reads = []
    return {
        manifest: {
            repository: "fluxerapp/fluxer",
            branch: "main",
            commit: pinned,
            files: {
                openapi: { path: "openapi.json", sha256: hash(files[pinned]["openapi.json"]) },
                gatewayEvents: { path: "events.md", sha256: hash(files[pinned]["events.md"]) },
            },
            rateLimits: { path: limits, sha256: bucketHash },
        },
        source: {
            reads,
            resolveCommit: async () => current,
            fetchFile: async (_repository, commit, path) => {
                reads.push(`${commit.slice(0, 1)} ${path}`)
                return Buffer.from(files[commit][path])
            },
            listDirectory: async (_repository, commit, directory) => {
                reads.push(`${commit.slice(0, 1)} ${directory}/`)
                const entries = new Map()
                for (const path of Object.keys(files[commit]).filter((path) => path.startsWith(`${directory}/`))) {
                    const [name, ...nested] = path.slice(directory.length + 1).split("/")
                    entries.set(`${directory}/${name}`, nested.length ? "dir" : "file")
                }
                return [...entries].map(([path, type]) => ({ path, type }))
            },
        },
    }
}

const document = {
    "openapi.json": openapi({ "/users/@me": { get: returns("User", bot) } }, { User: { type: "object" } }),
    "events.md": events([["READY", table(["| session_id | string | Session |"])]]),
    [`${limits}/Channel.ts`]: bucket("channel:read::channel_id"),
}

test("The pinned upstream manifest identifies an exact commit, document hashes and the rate-limit bucket hash", () => {
    const value = JSON.parse(readFileSync(new URL("../upstream/manifest.json", import.meta.url), "utf8"))
    assert.doesNotThrow(() => validateManifest(value))
    assert.throws(() => validateManifest({ ...value, commit: "main" }), /invalid/)
    assert.throws(() => validateManifest({ ...value, rateLimits: { path: "../outside", sha256: value.rateLimits.sha256 } }), /invalid/)
})

test("Unchanged upstream documents report no drift without reading the pinned copies", async () => {
    const { manifest, source } = upstream({ [pinned]: document, [current]: document })
    const result = await checkUpstream(manifest, source)
    assert.equal(result.drift, false)
    assert.equal(result.commit, current)
    assert.ok(source.reads.every((read) => !read.startsWith("a ")))
    assert.match(renderReport(result), /match the pinned manifest/)
})

test("OpenAPI changes are reported per endpoint and field, with wording-only edits and user-only surface kept apart", () => {
    const before = JSON.parse(
        openapi(
            {
                "/users/@me": { get: returns("User", bot) },
                "/guilds": { post: returns("Guild", bot) },
                "/old": { get: returns("Guild", bot) },
                "/oauth2/userinfo": { get: returns("Guild", [{ oauth2Token: ["identify"] }]) },
                "/phone": { post: returns("Phone", session) },
            },
            {
                User: { type: "object", properties: { id: { type: "string", description: "ID" }, flags: { enum: ["a", "b"] } }, profile: { $ref: "#/components/schemas/Profile" } },
                Profile: { type: "object", description: "A profile" },
                Guild: { type: "object", default: { title: "Home" }, properties: { order: { default: ["a", "b"] } } },
                Phone: { type: "object", properties: { code: { type: "string" } } },
            },
        ),
    )
    const after = JSON.parse(
        openapi(
            {
                "/users/@me": { get: returns("User", bot) },
                "/guilds": { post: returns("Guild", session) },
                "/oauth2/userinfo": { get: returns("Guild", [{ oauth2Token: ["email", "identify"] }]) },
                "/phone": { post: returns("Phone", session) },
                "/premium": { get: returns("Premium", session) },
            },
            {
                User: {
                    type: "object",
                    properties: { id: { type: "string", description: "Snowflake" }, flags: { enum: ["a", "c"] }, description: { type: "string" } },
                    profile: { $ref: "#/components/schemas/Profile" },
                },
                Profile: { type: "object", description: "The profile" },
                Guild: { type: "object", default: { title: "Lobby" }, properties: { order: { default: ["b", "a"] } } },
                Phone: { type: "object", properties: { code: { type: "integer" } } },
                Premium: { type: "object" },
            },
        ),
    )
    const { endpoints, schemas } = openapiChanges(before, after)
    assert.deepEqual(endpoints.application.removed, ["GET /old"])
    const endpoint = (name) => endpoints.application.changed.find((entry) => entry.name === name)?.details.join("\n") ?? ""
    assert.deepEqual(
        endpoints.application.changed.map(({ name }) => name),
        ["GET /oauth2/userinfo", "POST /guilds"],
    )
    assert.match(endpoint("POST /guilds"), /tokens.*- botToken/)
    assert.match(endpoint("GET /oauth2/userinfo"), /tokens.*\+ oauth2Token \(email, identify\)/, "A changed scope is a change")
    assert.deepEqual(endpoints.userOnly.added, ["GET /premium"])
    assert.deepEqual(
        schemas.application.changed.map(({ name }) => name),
        ["Guild", "User"],
    )
    const guild = schemas.application.changed[0].details.join("\n")
    assert.match(guild, /default\.title/, "A title inside a default value is data, not wording")
    assert.match(guild, /order\.default\[0\]/, "A reordered default value is a change")
    const user = schemas.application.changed[1].details.join("\n")
    assert.match(user, /\+ properties\.description/, "A field named description is structure, not wording")
    assert.match(user, /flags\.enum: \+ c, - b/)
    assert.doesNotMatch(user, /Snowflake/)
    assert.deepEqual(schemas.application.wordingOnly, ["Profile"])
    assert.deepEqual(schemas.userOnly.added, ["Premium"])
    assert.deepEqual(
        schemas.userOnly.changed.map(({ name }) => name),
        ["Phone"],
    )
})

test("Gateway event sections separate field table changes from text edits", () => {
    const before = events([
        ["READY", `Sent after Identify\n\n${table(["| session_id | string | Session |"])}\n\n#### Guild ready object\n\n${table(["| id | snowflake | Guild |"])}`],
        ["TYPING_START", "Someone started typing"],
        ["VOICE_STATE_ACK", "Acknowledged"],
    ])
    const after = events([
        [
            "READY",
            `Sent after Identify\n\n${table(["| session_id | integer | Session |", "| guilds<sup>1</sup> | array | Guilds |"])}\n\n#### Guild ready object\n\n${table([])}`,
        ],
        ["TYPING_START", "A user started typing"],
        ["MESSAGE_ACK", "Read"],
    ])
    const result = eventChanges(before, after)
    assert.deepEqual(result.added, ["MESSAGE_ACK"])
    assert.deepEqual(result.removed, ["VOICE_STATE_ACK"])
    assert.deepEqual(result.fields, [{ name: "READY", details: ["~ session_id", "- Guild ready object > id", "+ guilds"] }])
    assert.deepEqual(result.textOnly, ["TYPING_START"])
})

test("Rate-limit bucket identity changes count as drift, while changed limit values do not", async () => {
    const limitOnly = { ...document, [`${limits}/Channel.ts`]: bucket("channel:read::channel_id", 20) }
    const unchanged = upstream({ [pinned]: document, [current]: limitOnly })
    assert.equal((await checkUpstream(unchanged.manifest, unchanged.source)).drift, false)

    const renamed = {
        ...document,
        [`${limits}/Channel.ts`]: bucket("channel:read::guild_id"),
        [`${limits}/Global.ts`]: bucket("global:read"),
    }
    const changed = upstream({ [pinned]: document, [current]: renamed })
    const result = await checkUpstream(changed.manifest, changed.source)
    assert.equal(result.drift, true)
    assert.deepEqual(result.buckets, { added: ["channel:read::guild_id"], removed: ["channel:read::channel_id"] })
    assert.match(renderReport(result), /Rate-limit buckets in limits \| changed/)

    const nested = upstream({ [pinned]: document, [current]: { ...document, [`${limits}/new/New.ts`]: bucket("guild:read::guild_id") } })
    await assert.rejects(checkUpstream(nested.manifest, nested.source), /subdirectory/, "A nested config fails instead of hiding its buckets")
})

test("The report escapes upstream text and caps long change lists", async () => {
    const many = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`S${index}`, { type: "object" }]))
    const files = {
        [pinned]: document,
        [current]: {
            ...document,
            "openapi.json": openapi({ "/users/@me": { get: returns("TYPING_START", bot) } }, { ...many, TYPING_START: {} }),
        },
    }
    const { manifest, source } = upstream(files)
    const report = renderReport(await checkUpstream(manifest, source))
    assert.equal(report.includes("TYPING_START"), false, "Markdown emphasis characters are escaped")
    const decoded = report.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    assert.ok(decoded.includes("TYPING_START"))
    assert.match(report, /and \d+ more/)
})
