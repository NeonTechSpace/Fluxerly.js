import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
    checkUpstream,
    documentsHash,
    eventChanges,
    gatewayChanges,
    openapiChanges,
    rateLimitBuckets,
    renderReport,
    runUpstream,
    validateManifest,
} from "../upstream.js"

const pinned = "a".repeat(40)
const current = "b".repeat(40)
const limits = "limits"
const gateway = "gateway"
const gatewayHash = (files) =>
    documentsHash(Object.entries(files).filter(([path]) => path.startsWith(`${gateway}/`)).map(([path, text]) => ({ path, text })))
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
            },
            gatewayDocs: { path: gateway, sha256: gatewayHash(files[pinned]) },
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
    [`${gateway}/events.md`]: events([["READY", table(["| session_id | string | Session |"])]]),
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
    assert.match(renderReport(result), /Baseline: .*repository pin/i)
})

function workspace(t, manifest) {
    const directory = mkdtempSync(join(tmpdir(), "fluxerly-upstream-"))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const manifestFile = join(directory, "manifest.json")
    writeFileSync(manifestFile, JSON.stringify(manifest))
    return {
        manifestFile,
        baselineFile: join(directory, "previous.json"),
        recordFile: join(directory, "current.json"),
        summaryFile: join(directory, "summary.md"),
    }
}

const changedDocument = { ...document, [`${gateway}/events.md`]: events([["READY", table(["| session_id | integer | Session |"])]]) }

test("The CLI keeps local comparisons and reviewed updates tied to the repository manifest", async (t) => {
    const { manifest, source } = upstream({ [pinned]: document, [current]: changedDocument })
    const files = workspace(t, manifest)
    const result = await runUpstream([], { ...files, source })
    assert.equal(result.exitCode, 1)
    assert.equal(result.baseline.kind, "repository-pin")
    assert.match(result.report, /Baseline: .*repository pin/i)
    assert.ok(result.report.includes(`https://github.com/${manifest.repository}/compare/${pinned}...${current}`))
    assert.equal(readFileSync(files.summaryFile, "utf8"), result.report + "\n", "The job summary contains the reported comparison")
    assert.deepEqual(JSON.parse(readFileSync(files.manifestFile, "utf8")), manifest, "A check never updates the reviewed pin")

    const updated = await runUpstream(["--update"], { ...files, source })
    assert.equal(updated.exitCode, 0)
    const nextManifest = JSON.parse(readFileSync(files.manifestFile, "utf8"))
    assert.equal(nextManifest.commit, current)
    assert.equal(nextManifest.gatewayDocs.sha256, gatewayHash(changedDocument))
    assert.equal((await runUpstream([], { ...files, source })).exitCode, 0)
})

test("Missing, malformed, invalid and incompatible previous observations fall back visibly and still record current upstream", async (t) => {
    const { manifest, source } = upstream({ [pinned]: document, [current]: changedDocument })
    const files = workspace(t, manifest)
    const cases = [
        undefined,
        "{",
        JSON.stringify({ ...manifest, commit: "main" }),
        JSON.stringify({ ...manifest, repository: "other/upstream" }),
        JSON.stringify({ ...manifest, branch: "other" }),
        JSON.stringify({ ...manifest, files: { ...manifest.files, openapi: { ...manifest.files.openapi, path: "other.json" } } }),
        JSON.stringify({ ...manifest, rateLimits: { ...manifest.rateLimits, path: "other" } }),
        JSON.stringify({ ...manifest, gatewayDocs: { ...manifest.gatewayDocs, path: "other" } }),
        // An observation recorded before the gateway folder replaced the single events document
        JSON.stringify({
            ...manifest,
            files: { ...manifest.files, gatewayEvents: { path: `${gateway}/events.md`, sha256: manifest.gatewayDocs.sha256 } },
            gatewayDocs: undefined,
        }),
    ]
    for (const content of cases) {
        if (content !== undefined) writeFileSync(files.baselineFile, content)
        const result = await runUpstream(["--baseline", files.baselineFile, "--record", files.recordFile], { ...files, source })
        assert.equal(result.exitCode, 1)
        assert.equal(result.result.pinnedCommit, pinned)
        assert.equal(result.baseline.kind, "repository-pin")
        assert.ok(result.baseline.reason, "Fallback has a reason")
        assert.ok(result.report.includes(result.baseline.reason), "Fallback reason is visible in the report")
        assert.ok(readFileSync(files.summaryFile, "utf8").includes(result.baseline.reason), "Fallback reason reaches the job summary")
        const recorded = JSON.parse(readFileSync(files.recordFile, "utf8"))
        assert.doesNotThrow(() => validateManifest(recorded))
        assert.equal(recorded.commit, current)
    }
    assert.deepEqual(JSON.parse(readFileSync(files.manifestFile, "utf8")), manifest)
})

test("A failed observation becomes the next run's baseline, passes unchanged, and signals the next upstream change", async (t) => {
    const next = "c".repeat(40)
    const nextDocument = { ...changedDocument, [`${limits}/Channel.ts`]: bucket("channel:read::guild_id") }
    const { manifest, source } = upstream({ [pinned]: document, [current]: changedDocument, [next]: nextDocument })
    const files = workspace(t, manifest)
    const args = ["--baseline", files.baselineFile, "--record", files.recordFile]
    const first = await runUpstream(args, { ...files, source })
    assert.equal(first.exitCode, 1)
    const recordedText = readFileSync(files.recordFile, "utf8")
    const recorded = JSON.parse(recordedText)
    assert.deepEqual(recorded, {
        ...manifest,
        commit: current,
        files: {
            openapi: { path: "openapi.json", sha256: hash(changedDocument["openapi.json"]) },
        },
        gatewayDocs: { path: gateway, sha256: gatewayHash(changedDocument) },
        rateLimits: { path: limits, sha256: hash("channel:read::channel_id") },
    })
    writeFileSync(files.baselineFile, recordedText)
    const second = await runUpstream(args, { ...files, source })
    assert.equal(second.exitCode, 0)
    assert.equal(second.baseline.kind, "previous-run")
    assert.deepEqual(second.baseline.manifest, recorded, "The next run reads exactly the recorded observation")
    assert.match(second.report, /Baseline: .*previous run/i)
    assert.equal(second.result.pinnedCommit, current, "The repository pin is not used as the previous baseline")
    assert.equal(readFileSync(files.recordFile, "utf8"), recordedText, "Unchanged upstream is still recorded for artifact renewal")

    source.resolveCommit = async () => next
    const third = await runUpstream(args, { ...files, source })
    assert.equal(third.exitCode, 1)
    assert.match(third.report, /Baseline: .*previous run/i)
    assert.equal(third.result.pinnedCommit, current)
    assert.deepEqual(third.result.buckets, { added: ["channel:read::guild_id"], removed: ["channel:read::channel_id"] })
    assert.ok(third.report.includes(`https://github.com/${manifest.repository}/compare/${current}...${next}`))
    writeFileSync(files.baselineFile, readFileSync(files.recordFile, "utf8"))
    assert.equal((await runUpstream(args, { ...files, source })).exitCode, 0)
    assert.deepEqual(JSON.parse(readFileSync(files.manifestFile, "utf8")), manifest)
})

test("A new upstream commit that leaves every watched document unchanged passes in observation mode", async (t) => {
    // A commit-only change used to fail the daily run although all watched documents were unchanged
    const { manifest, source } = upstream({ [pinned]: document, [current]: document })
    const files = workspace(t, manifest)
    writeFileSync(files.baselineFile, JSON.stringify(manifest))
    const observed = await runUpstream(["--record", files.recordFile, "--baseline", files.baselineFile], { ...files, source })
    assert.equal(observed.baseline.kind, "previous-run")
    assert.equal(observed.result.commit, current)
    assert.equal(observed.exitCode, 0)
    assert.equal(JSON.parse(readFileSync(files.recordFile, "utf8")).commit, current, "The new commit still becomes the next baseline")
})

test("A watched document change stays reported against the repository pin after the run that signalled it", async (t) => {
    // Each run used to compare only with the previous observation, so a change showed in one red run and was gone from the next
    const next = "c".repeat(40)
    const nextDocument = { ...changedDocument, [`${limits}/Channel.ts`]: bucket("channel:read::guild_id") }
    const { manifest, source } = upstream({ [pinned]: document, [current]: changedDocument, [next]: nextDocument })
    const files = workspace(t, manifest)
    const args = ["--baseline", files.baselineFile, "--record", files.recordFile]
    const first = await runUpstream(args, { ...files, source })
    assert.equal(first.exitCode, 1)
    assert.equal(first.baseline.kind, "repository-pin")
    assert.equal(first.sincePin, undefined, "A run that already compared with the pin reports it once")
    writeFileSync(files.baselineFile, readFileSync(files.recordFile, "utf8"))

    // Upstream moving during the run must not split the report across two commits
    let resolved = 0
    source.resolveCommit = async () => (resolved++ ? next : current)
    const second = await runUpstream(args, { ...files, source })
    assert.equal(second.exitCode, 0, "Only the change since the previous run fails the check")
    assert.equal(second.sincePin.pinnedCommit, pinned)
    assert.equal(second.sincePin.commit, current)
    assert.equal(second.sincePin.drift, true)
    assert.deepEqual(second.sincePin.gateway.fields, [{ name: "READY", details: ["~ session_id"] }])
    assert.equal(second.sincePin.buckets, undefined)
    assert.ok(second.report.includes(`https://github.com/${manifest.repository}/compare/${pinned}...${current}`))
    assert.match(second.report, /READY/)
    assert.ok(readFileSync(files.summaryFile, "utf8").endsWith(second.report + "\n"), "The job summary contains the pin comparison")
    assert.deepEqual(JSON.parse(readFileSync(files.manifestFile, "utf8")), manifest)
})

test("The CLI rejects missing paths, repeated arguments and updates mixed with observation mode before upstream reads", async (t) => {
    const { manifest, source } = upstream({ [pinned]: document, [current]: document })
    const files = workspace(t, manifest)
    for (const args of [
        ["--baseline"],
        ["--record", "--baseline", files.baselineFile],
        ["--baseline", files.baselineFile, "--baseline", files.baselineFile],
        ["--update", "--record", files.recordFile],
        ["--update", "--baseline", files.baselineFile],
        ["--unknown"],
    ]) await assert.rejects(runUpstream(args, { ...files, source }))
    assert.deepEqual(source.reads, [])
    assert.deepEqual(JSON.parse(readFileSync(files.manifestFile, "utf8")), manifest)
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

test("Inserted enum values, bit flags and parameters are reported alone, and experiment-gated additions are labelled", () => {
    const threads = { "x-fluxer-experiment": "channel_threads" }
    const before = JSON.parse(
        openapi(
            {
                "/webhooks/{id}": {
                    post: { ...returns("ChannelType", bot), parameters: [{ name: "id", in: "path" }, { name: "wait", in: "query" }] },
                },
            },
            {
                ChannelType: { enum: [0, 2, 998], "x-enumNames": ["TEXT", "VOICE", "LINK"], "x-enumDescriptions": ["Text", "Voice", "Link"] },
                Flags: { "x-bitflagValues": [{ name: "STAFF", value: "1" }, { name: "BOT", value: "16" }] },
                Message: { type: "object", properties: { flags: { $ref: "#/components/schemas/Flags" } } },
            },
        ),
    )
    const after = JSON.parse(
        openapi(
            {
                "/webhooks/{id}": {
                    post: {
                        ...returns("ChannelType", bot),
                        parameters: [
                            { name: "id", in: "path" },
                            { name: "thread_id", in: "query", schema: { type: "string", ...threads } },
                            { name: "wait", in: "query" },
                        ],
                    },
                },
                "/channels/{id}/threads": { post: { ...returns("Message", bot), ...threads } },
            },
            {
                ChannelType: {
                    enum: [0, 2, 11, 998],
                    "x-enumNames": ["TEXT", "VOICE", "PUBLIC_THREAD", "LINK"],
                    "x-enumDescriptions": ["Text", "Voice", "A thread", "Link"],
                },
                Flags: { "x-bitflagValues": [{ name: "STAFF", value: "1" }, { name: "HIDDEN", value: "8" }, { name: "BOT", value: "16" }] },
                Message: { type: "object", properties: { flags: { $ref: "#/components/schemas/Flags" }, thread: { type: "object", ...threads } } },
            },
        ),
    )
    const { endpoints, schemas } = openapiChanges(before, after)
    assert.deepEqual(endpoints.application.added, ["POST /channels/{id}/threads [experiment: channel_threads]"])
    assert.deepEqual(endpoints.application.changed, [
        { name: "POST /webhooks/{id} [experiment: channel_threads]", details: ["+ parameters.thread_id (query)"] },
    ])
    const schema = (name) => schemas.application.changed.find((entry) => entry.name.startsWith(name))?.details ?? []
    assert.deepEqual(schema("ChannelType"), ["enum: + 11", "+ x-enumNames.11"], "Existing value names are unchanged")
    assert.deepEqual(schema("Flags"), ["+ x-bitflagValues.8"])
    assert.deepEqual(
        schemas.application.changed.map(({ name }) => name),
        ["ChannelType", "Flags", "Message [experiment: channel_threads]"],
    )
})

test("A gateway documentation folder reports added files and the sections they define", async () => {
    const threads = events([["THREAD_CREATE", table(["| id | snowflake | Thread |"])]])
    const { manifest, source } = upstream({ [pinned]: document, [current]: { ...document, [`${gateway}/threads.md`]: threads } })
    const result = await checkUpstream(manifest, source)
    assert.equal(result.drift, true)
    assert.equal(result.gatewayDocs.changed, true)
    assert.deepEqual(result.gateway.files, { added: ["threads.md"], removed: [] })
    assert.deepEqual(result.gateway.added, ["THREAD_CREATE"])
    assert.deepEqual(result.gateway.fields, [], "The unchanged events document reports nothing")
    const report = renderReport(result)
    assert.match(report, /Gateway documents in gateway \| changed/)
    assert.match(report, /Files added \(1\): threads\.md/)

    const unrelated = gatewayChanges([{ path: "a.md", text: "### READY\nOne" }], [{ path: "a.md", text: "### READY\nOne" }, { path: "b.md", text: "Notes" }])
    assert.deepEqual(unrelated.textOnly, [], "A file boundary ends the previous file's last section")
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
