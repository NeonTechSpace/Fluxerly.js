import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import {
    checkUpstream,
    documentsHash,
    eventChanges,
    gatewayChanges,
    openapiChanges,
    rateLimitBuckets,
    renderReport,
    endpointDocsConfig,
    endpointDocsDirectory,
    keepingCopies,
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
                // An empty directory is the repository root
                const prefix = directory ? `${directory}/` : ""
                const entries = new Map()
                for (const path of Object.keys(files[commit]).filter((path) => path.startsWith(prefix))) {
                    const [name, ...nested] = path.slice(prefix.length).split("/")
                    entries.set(`${prefix}${name}`, nested.length ? "dir" : "file")
                }
                return [...entries].map(([path, type]) => ({ path, type }))
            },
        },
    }
}

// The docs files the website's endpoint map reads, with a nested page and a file that isn't a page
const endpointPages = (version) => ({
    [endpointDocsConfig]: `export default { sidebar: [] } // ${version}`,
    [`${endpointDocsDirectory}/messages.mdx`]: `## Send message ${version}`,
    [`${endpointDocsDirectory}/users/mfa.mdx`]: "## MFA",
    [`${endpointDocsDirectory}/index.md`]: "# HTTP API",
    [`${endpointDocsDirectory}/diagram.svg`]: "<svg/>",
})
// The hashes an update pins for those files, config first and pages in path order
const endpointPins = (files) =>
    [endpointDocsConfig, `${endpointDocsDirectory}/index.md`, `${endpointDocsDirectory}/messages.mdx`, `${endpointDocsDirectory}/users/mfa.mdx`].map(
        (path) => ({ path, sha256: hash(files[path]) }),
    )

const document = {
    ...endpointPages("first"),
    "openapi.json": openapi({ "/users/@me": { get: returns("User", bot) } }, { User: { type: "object" } }),
    [`${gateway}/events.md`]: events([["READY", table(["| session_id | string | Session |"])]]),
    [`${limits}/Channel.ts`]: bucket("channel:read::channel_id"),
}

test("The pinned upstream manifest identifies an exact commit, document hashes and the rate-limit bucket hash", () => {
    const value = JSON.parse(readFileSync(new URL("../upstream/manifest.json", import.meta.url), "utf8"))
    assert.doesNotThrow(() => validateManifest(value))
    assert.throws(() => validateManifest({ ...value, commit: "main" }), /invalid/)
    assert.throws(() => validateManifest({ ...value, rateLimits: { path: "../outside", sha256: value.rateLimits.sha256 } }), /invalid/)
    // The repository pin lists the endpoint map's docs files: the config once, and only Markdown pages in the HTTP API folder
    const pages = value.endpointDocs
    assert.ok(pages.some((file) => file.path === endpointDocsConfig) && pages.length > 10)
    const page = pages.find((file) => file.path !== endpointDocsConfig)
    for (const endpointDocs of [
        pages.filter((file) => file.path !== endpointDocsConfig),
        [...pages, page],
        [...pages, { path: "fluxer_docs/src/content/docs/gateway/events.md", sha256: page.sha256 }],
        [...pages, { path: `${endpointDocsDirectory}/logo.svg`, sha256: page.sha256 }],
        [...pages, { path: `${endpointDocsDirectory}/../secrets.md`, sha256: page.sha256 }],
        [...pages.slice(1), { ...pages[0], sha256: "main" }],
    ])
        assert.throws(() => validateManifest({ ...value, endpointDocs }), /invalid/)
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
        commentFile: join(directory, "comment.md"),
    }
}

const changedDocument = {
    ...document,
    ...endpointPages("second"),
    [`${gateway}/events.md`]: events([["READY", table(["| session_id | integer | Session |"])]]),
}

test("The CLI keeps local comparisons and reviewed updates tied to the repository manifest", async (t) => {
    const { manifest, source } = upstream({ [pinned]: document, [current]: changedDocument })
    const files = workspace(t, manifest)
    const result = await runUpstream([], { ...files, source })
    assert.equal(result.result.drift, true)
    assert.equal(result.baseline.kind, "repository-pin")
    assert.match(result.report, /Baseline: .*repository pin/i)
    assert.ok(result.report.includes(`https://github.com/${manifest.repository}/compare/${pinned}...${current}`))
    assert.equal(readFileSync(files.summaryFile, "utf8"), result.report + "\n", "The job summary contains the reported comparison")
    assert.deepEqual(JSON.parse(readFileSync(files.manifestFile, "utf8")), manifest, "A check never updates the reviewed pin")

    await runUpstream(["--update", current], { ...files, source })
    const nextManifest = JSON.parse(readFileSync(files.manifestFile, "utf8"))
    assert.equal(nextManifest.commit, current)
    assert.equal(nextManifest.gatewayDocs.sha256, gatewayHash(changedDocument))
    // Moving the pin also pins the endpoint map's docs files at the new commit, next to the OpenAPI document
    assert.deepEqual(nextManifest.endpointDocs, endpointPins(changedDocument))
    assert.deepEqual(Object.keys(nextManifest), ["repository", "branch", "commit", "files", "endpointDocs", "gatewayDocs", "rateLimits"])
    assert.doesNotThrow(() => validateManifest(nextManifest))
    assert.equal((await runUpstream([], { ...files, source })).result.drift, false)
})

test("An update records the requested commit and its hashes after the upstream branch has moved on", async (t) => {
    const reviewed = "c".repeat(40)
    const reviewedDocument = {
        ...endpointPages("reviewed"),
        "openapi.json": openapi({ "/users/@me": { get: returns("User", bot) } }, { User: { type: "object", title: "Reviewed" } }),
        [`${gateway}/events.md`]: events([["READY", table(["| session_id | boolean | Session |"])]]),
        [`${limits}/Channel.ts`]: bucket("channel:read::thread_id"),
    }
    // The fake branch head holds other documents, so reading it instead of the requested commit changes every hash
    const { manifest, source } = upstream({ [pinned]: document, [current]: changedDocument, [reviewed]: reviewedDocument })
    const files = workspace(t, manifest)
    await runUpstream(["--update", reviewed], { ...files, source })
    assert.deepEqual(JSON.parse(readFileSync(files.manifestFile, "utf8")), {
        ...manifest,
        commit: reviewed,
        files: { openapi: { path: "openapi.json", sha256: hash(reviewedDocument["openapi.json"]) } },
        endpointDocs: endpointPins(reviewedDocument),
        gatewayDocs: { path: gateway, sha256: gatewayHash(reviewedDocument) },
        rateLimits: { path: limits, sha256: hash("channel:read::thread_id") },
    })
    assert.ok(source.reads.every((read) => !read.startsWith("b ")), "Nothing is read at the branch head")
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
        assert.equal(result.result.drift, true)
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

test("An observation becomes the next run's baseline, reports nothing unchanged, and reports the next upstream change", async (t) => {
    const next = "c".repeat(40)
    const nextDocument = { ...changedDocument, [`${limits}/Channel.ts`]: bucket("channel:read::guild_id") }
    const { manifest, source } = upstream({ [pinned]: document, [current]: changedDocument, [next]: nextDocument })
    const files = workspace(t, manifest)
    const args = ["--baseline", files.baselineFile, "--record", files.recordFile]
    const first = await runUpstream(args, { ...files, source })
    assert.equal(first.result.drift, true)
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
    assert.equal(second.result.drift, false)
    assert.equal(second.baseline.kind, "previous-run")
    assert.deepEqual(second.baseline.manifest, recorded, "The next run reads exactly the recorded observation")
    assert.match(second.report, /Baseline: .*previous run/i)
    assert.equal(second.result.pinnedCommit, current, "The repository pin is not used as the previous baseline")
    assert.equal(readFileSync(files.recordFile, "utf8"), recordedText, "Unchanged upstream is still recorded for artifact renewal")

    source.resolveCommit = async () => next
    const third = await runUpstream(args, { ...files, source })
    assert.equal(third.result.drift, true)
    assert.match(third.report, /Baseline: .*previous run/i)
    assert.equal(third.result.pinnedCommit, current)
    assert.deepEqual(third.result.buckets, { added: ["channel:read::guild_id"], removed: ["channel:read::channel_id"] })
    assert.ok(third.report.includes(`https://github.com/${manifest.repository}/compare/${current}...${next}`))
    writeFileSync(files.baselineFile, readFileSync(files.recordFile, "utf8"))
    assert.equal((await runUpstream(args, { ...files, source })).result.drift, false)
    assert.deepEqual(JSON.parse(readFileSync(files.manifestFile, "utf8")), manifest)
})

test("A run that compares with the previous observation and the pin reads each upstream file once", async (t) => {
    const { manifest, source } = upstream({ [pinned]: document, [current]: changedDocument })
    const files = workspace(t, manifest)
    // The previous run saw the pinned commit, so both comparisons read the branch head and the pinned commit
    writeFileSync(files.baselineFile, JSON.stringify(manifest))
    const result = await runUpstream(["--baseline", files.baselineFile], { ...files, source })
    assert.equal(result.baseline.kind, "previous-run")
    assert.ok(result.sincePin)
    assert.deepEqual(source.reads.filter((read) => read === "b openapi.json"), ["b openapi.json"])
    assert.deepEqual(source.reads, [...new Set(source.reads)], "No file or listing is read twice")
})

test("A new upstream commit that leaves every watched document unchanged is not document drift", async (t) => {
    const { manifest, source } = upstream({ [pinned]: document, [current]: document })
    const files = workspace(t, manifest)
    writeFileSync(files.baselineFile, JSON.stringify(manifest))
    const observed = await runUpstream(["--record", files.recordFile, "--baseline", files.baselineFile], { ...files, source })
    assert.equal(observed.baseline.kind, "previous-run")
    assert.equal(observed.result.commit, current)
    assert.equal(observed.result.drift, false)
    assert.equal(JSON.parse(readFileSync(files.recordFile, "utf8")).commit, current, "The new commit still becomes the next baseline")
})

test("A watched document change stays reported against the repository pin after the run that signalled it", async (t) => {
    // Each run used to compare only with the previous observation, so a change showed in one run and was gone from the next
    const next = "c".repeat(40)
    const nextDocument = { ...changedDocument, [`${limits}/Channel.ts`]: bucket("channel:read::guild_id") }
    const { manifest, source } = upstream({ [pinned]: document, [current]: changedDocument, [next]: nextDocument })
    const files = workspace(t, manifest)
    const args = ["--baseline", files.baselineFile, "--record", files.recordFile]
    const first = await runUpstream(args, { ...files, source })
    assert.equal(first.result.drift, true)
    assert.equal(first.baseline.kind, "repository-pin")
    assert.equal(first.sincePin, undefined, "A run that already compared with the pin reports it once")
    writeFileSync(files.baselineFile, readFileSync(files.recordFile, "utf8"))

    // Upstream moving during the run must not split the report across two commits
    let resolved = 0
    source.resolveCommit = async () => (resolved++ ? next : current)
    const second = await runUpstream(args, { ...files, source })
    assert.equal(second.result.drift, false, "Only the change since the previous run counts as new")
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
        ["--update"],
        ["--update", "main"],
        ["--update", current.slice(0, 12)],
        ["--update", current.toUpperCase()],
        ["--update", current, "--update", current],
        ["--update", current, "--record", files.recordFile],
        ["--update", current, "--baseline", files.baselineFile],
        ["--update", current, "--comment", files.commentFile],
        ["--comment"],
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

test("The report groups access by what OpenAPI lists, so a route with no security requirement is not called usable", async () => {
    // Fluxer's voice server routes declare no security requirement but check their own credential at runtime
    const paths = (edit) => ({
        "/users/@me": { get: returns("User", bot) },
        "/voice/join": { post: { ...returns("User", []), ...edit } },
        "/phone": { post: { ...returns("User", session), ...edit } },
    })
    const files = {
        [pinned]: { ...document, "openapi.json": openapi(paths({}), { User: { type: "object" } }) },
        [current]: { ...document, "openapi.json": openapi(paths({ deprecated: true }), { User: { type: "object" } }) },
    }
    const { manifest, source } = upstream(files)
    const report = renderReport(await checkUpstream(manifest, source))
    const listed = report.indexOf("OpenAPI lists bot, OAuth2 or no security requirement:")
    const other = report.indexOf("Other operations and schemas:")
    assert.ok(listed !== -1 && other !== -1, "Both headings appear")
    assert.ok(report.includes("Access groups follow OpenAPI metadata"), "The groups are marked as metadata")
    assert.ok(listed < report.indexOf("POST /voice/join") && report.indexOf("POST /voice/join") < other)
    assert.ok(other < report.indexOf("POST /phone"))
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

// A commit history, newest first, read as GitHub pages it. The small page size makes every walk cross a page boundary
function withHistory(source, history, missing = []) {
    const pageSize = 2
    return {
        ...source,
        checkPath: async (_repository, _commit, path) => {
            if (missing.includes(path)) throw new Error("Upstream request returned HTTP 404")
        },
        listCommits: async (_repository, head, { path, page }) => {
            const reachable = history.slice(history.findIndex(({ sha }) => sha === head))
            const listed = path ? reachable.filter(({ paths }) => paths.some((item) => item === path || item.startsWith(`${path}/`))) : reachable
            return listed.slice((page - 1) * pageSize, page * pageSize).map(({ sha, subject }) => ({ sha, subject }))
        },
    }
}

const commit = (character, subject, ...paths) => ({ sha: character.repeat(40), subject, paths })
const commentArgs = (files) => ["--baseline", files.baselineFile, "--record", files.recordFile, "--comment", files.commentFile]

test("The comment lists only commits after the baseline that touch a watched path, oldest first", async (t) => {
    const { manifest, source } = upstream({ [pinned]: document, [current]: document })
    const history = [
        commit("b", "Gateway change", "fluxer_gateway/src/session.erl"),
        commit("c", "App only change", "fluxer_app/src/App.tsx"),
        commit("d", "Workspace change", "pnpm-workspace.yaml"),
        commit("e", "API change", "fluxer_api/src/api/user.ts"),
        // The baseline touches no watched path, so no path listing ever shows it
        commit("a", "Baseline", "fluxer_app/src/Old.tsx"),
        commit("9", "Already reported", "fluxer_gateway/src/old.erl"),
    ]
    const files = workspace(t, manifest)
    const run = await runUpstream(commentArgs(files), { ...files, source: withHistory(source, history) })
    assert.deepEqual(run.commits.map(({ subject }) => subject), ["API change", "Workspace change", "Gateway change"])
    const comment = readFileSync(files.commentFile, "utf8")
    assert.ok(comment.indexOf("API change") < comment.indexOf("Gateway change"))
    assert.ok(comment.includes(`https://github.com/${manifest.repository}/commit/${current}`))
    assert.doesNotMatch(comment, /App only change|Already reported/)
    assert.ok(readFileSync(files.summaryFile, "utf8").includes("Gateway change"), "The job summary carries the list too")
})

test("A week with nothing new writes no comment, and a document change alone writes one", async (t) => {
    const { manifest, source } = upstream({ [pinned]: document, [current]: document })
    const files = workspace(t, manifest)
    // The baseline itself was reported last time
    const unwatched = [commit("b", "App only change", "fluxer_app/src/App.tsx"), commit("a", "Baseline", "fluxer_gateway/src/old.erl")]
    const quiet = await runUpstream(commentArgs(files), { ...files, source: withHistory(source, unwatched) })
    assert.deepEqual(quiet.commits, [])
    assert.equal(existsSync(files.commentFile), false, "A new commit outside the watched paths is not reported")
    assert.equal(JSON.parse(readFileSync(files.recordFile, "utf8")).commit, current, "The observation still moves on")

    const unmoved = await runUpstream(commentArgs(files), { ...files, source: withHistory({ ...source, resolveCommit: async () => pinned }, unwatched.slice(1)) })
    assert.deepEqual(unmoved.commits, [])
    assert.equal(existsSync(files.commentFile), false, "An unmoved branch is not reported")

    const changed = upstream({ [pinned]: document, [current]: changedDocument })
    const changedFiles = workspace(t, changed.manifest)
    const run = await runUpstream(commentArgs(changedFiles), { ...changedFiles, source: withHistory(changed.source, unwatched) })
    assert.equal(run.result.drift, true)
    assert.match(readFileSync(changedFiles.commentFile, "utf8"), /READY/)
})

test("A comment reports only the change since the last report, while the job summary also compares with the pin", async (t) => {
    const next = "c".repeat(40)
    const nextDocument = { ...changedDocument, [`${limits}/Channel.ts`]: bucket("channel:read::guild_id") }
    const { manifest, source } = upstream({ [pinned]: document, [current]: changedDocument, [next]: nextDocument })
    const files = workspace(t, manifest)
    writeFileSync(files.baselineFile, JSON.stringify({ ...manifest, commit: current, gatewayDocs: { path: gateway, sha256: gatewayHash(changedDocument) } }))
    const history = [commit("c", "Bucket change", "fluxer_api/src/api/limits.ts"), commit("b", "Baseline", "fluxer_app/src/Old.tsx")]
    await runUpstream(commentArgs(files), { ...files, source: withHistory({ ...source, resolveCommit: async () => next }, history) })
    assert.doesNotMatch(readFileSync(files.commentFile, "utf8"), /Since the repository pin/)
    assert.match(readFileSync(files.summaryFile, "utf8"), /Since the repository pin/)
})

test("A missing watched path or a baseline outside the branch history fails the check and writes no comment", async (t) => {
    const { manifest, source } = upstream({ [pinned]: document, [current]: changedDocument })
    const history = [commit("b", "Gateway change", "fluxer_gateway/src/session.erl"), commit("a", "Baseline")]
    const files = workspace(t, manifest)
    await assert.rejects(
        runUpstream(commentArgs(files), { ...files, source: withHistory(source, history, ["fluxer_gateway/src"]) }),
        /watched upstream path fluxer_gateway\/src/,
    )
    await assert.rejects(runUpstream(commentArgs(files), { ...files, source: withHistory(source, history.slice(0, 1)) }), /not in the upstream branch history/)
    assert.equal(existsSync(files.commentFile), false)
})

test("Upstream text in a comment cannot mention, reference, link or inject Markdown", async (t) => {
    const route = (edit) => ({ "/users/@me": { get: { ...returns("User", bot), ...edit } } })
    const changed = { ...document, "openapi.json": openapi(route({ deprecated: true }), { User: { type: "object" } }) }
    const { manifest, source } = upstream({ [pinned]: document, [current]: changed })
    const subjects = [
        "Fix @octocat and @org/team (#3693) GH-12 gh-13 owner/repo#14 owner/repo@abc1234 a@b.example",
        "https://github.com/owner/repo/issues/15 www.github.com/owner/repo/issues/16 github.com/owner/repo/pull/17 owner/repo/discussions/18",
        "[link](https://example.invalid) ![image](https://example.invalid/i.png) <img src=x> `code` | cell &#64;entity *bold* _em_",
    ]
    const files = workspace(t, manifest)
    await runUpstream(commentArgs(files), {
        ...files,
        source: withHistory(source, [
            ...subjects.map((subject, index) => commit("bcd"[index], subject, "fluxer_api/src/api/user.ts")),
            commit("a", "Baseline"),
        ]),
    })
    const comment = readFileSync(files.commentFile, "utf8")
    // Generated commit links are ours. GitHub decodes entities before it looks for mentions, so they count as their character
    const text = comment.replaceAll(/\]\(https:\/\/github\.com\/fluxerapp\/fluxer\/[^)]+\)/g, "]")
    const decoded = text.replaceAll(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    assert.doesNotMatch(decoded, /@[a-z0-9]/i, "Mentions")
    assert.doesNotMatch(decoded, /#\d/, "Issue references")
    assert.doesNotMatch(decoded, /gh-\d/i, "Short issue references")
    assert.doesNotMatch(decoded, /\/\d/, "Issue paths")
    assert.doesNotMatch(decoded, /:\/\/|www\./i, "Bare links")
    const listed = text.split("\n").filter((line) => line.startsWith("- [")).map((line) => line.slice(line.indexOf("]") + 2))
    assert.equal(listed.length, subjects.length)
    for (const line of listed) assert.doesNotMatch(line, /[<>`|[\]*_]|&(?!#\d+;)/, "Markdown and HTML")
    assert.ok(comment.includes("users"), "The route stays readable")
})

test("A long subject is cut, and a comment GitHub would refuse is cut at a line end while the job summary keeps everything", async (t) => {
    const { manifest, source } = upstream({ [pinned]: document, [current]: document })
    const count = 700
    const history = [
        ...Array.from({ length: count }, (_, index) => ({
            sha: index.toString(16).padStart(40, "f"),
            subject: `Change ${index} ${"x".repeat(300)}`,
            paths: ["fluxer_gateway/src/session.erl"],
        })),
        commit("a", "Baseline"),
    ]
    const files = workspace(t, manifest)
    const fake = withHistory({ ...source, resolveCommit: async () => history[0].sha }, history)
    fake.fetchFile = async (_repository, _commit, path) => Buffer.from(document[path])
    fake.listDirectory = async (_repository, _commit, directory) =>
        Object.keys(document).filter((path) => path.startsWith(`${directory}/`)).map((path) => ({ path, type: "file" }))
    const run = await runUpstream(commentArgs(files), { ...files, source: fake })
    assert.equal(run.commits.length, count)
    const comment = readFileSync(files.commentFile, "utf8")
    assert.ok(comment.length <= 65_536, `${comment.length} characters`)
    assert.ok(comment.includes("Change 699"), "The oldest commits come first")
    assert.equal(comment.includes("Change 0 "), false)
    assert.ok(readFileSync(files.summaryFile, "utf8").includes("Change 0 "))
    assert.equal(comment.includes("x".repeat(250)), false)
})

test("The command exits 0 when Fluxer changed and 1 when the check itself breaks, reading GitHub's real request shapes", (t) => {
    const pin = JSON.parse(readFileSync(new URL("../upstream/manifest.json", import.meta.url), "utf8"))
    const directory = mkdtempSync(join(tmpdir(), "fluxerly-upstream-cli-"))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    // The command keeps its copies beside itself and removes those a run did not read, so the test runs its own copy of the
    // command. The real one would empty the copies kept in this checkout
    const checkout = fileURLToPath(new URL("../.cache/upstream/", import.meta.url))
    const kept = () => (existsSync(checkout) ? readdirSync(checkout).sort() : [])
    const keptBefore = kept()
    const script = join(directory, "release", "upstream.js")
    mkdirSync(join(directory, "release", "upstream"), { recursive: true })
    writeFileSync(join(directory, "release", "package.json"), JSON.stringify({ type: "module" }))
    copyFileSync(new URL("../upstream.js", import.meta.url), script)
    copyFileSync(new URL("../upstream/manifest.json", import.meta.url), join(directory, "release", "upstream", "manifest.json"))
    // A copy no run reads, which the command's own copies folder loses after a run
    const copies = join(directory, "release", ".cache", "upstream")
    const unread = join(copies, "d".repeat(40))
    mkdirSync(copies, { recursive: true })
    writeFileSync(unread, "Unread copy")
    const fake = join(directory, "fake-github.mjs")
    // Every read succeeds with different bytes than the pin, so all three watched documents count as changed
    writeFileSync(
        fake,
        `
        const head = "c".repeat(40)
        const json = (value) => new Response(JSON.stringify(value))
        globalThis.fetch = async (input) => {
            const url = new URL(input)
            if (process.env.FAKE_FAILURE && url.pathname.endsWith(process.env.FAKE_FAILURE)) return new Response("", { status: 404 })
            if (url.host === "raw.githubusercontent.com") return new Response("{}")
            if (url.pathname.endsWith("/commits/main")) return new Response(head)
            if (url.pathname.includes("/contents/")) return json([])
            if (url.pathname.endsWith("/commits")) {
                if (url.searchParams.get("sha") !== head || url.searchParams.get("per_page") !== "100") return new Response("", { status: 400 })
                if (url.searchParams.get("page") !== "1") return json([])
                return json([
                    { sha: head, commit: { message: "Gateway change\\n\\nLater body text" } },
                    { sha: ${JSON.stringify(pin.commit)}, commit: { message: "Baseline" } },
                ])
            }
            return new Response("", { status: 500 })
        }
        `,
    )
    const run = (name, failure) => {
        const comment = join(directory, `${name}.md`)
        const { GITHUB_STEP_SUMMARY: _, ...env } = process.env
        const result = spawnSync(process.execPath, ["--import", fake, script, "--record", join(directory, `${name}.json`), "--comment", comment], {
            encoding: "utf8",
            timeout: 30_000,
            windowsHide: true,
            env: { ...env, ...(failure ? { FAKE_FAILURE: failure } : {}) },
        })
        assert.ifError(result.error)
        return { status: result.status, stderr: result.stderr, comment }
    }
    const changed = run("changed")
    assert.equal(changed.status, 0, changed.stderr)
    assert.equal(existsSync(unread), false, "The run keeps its copies in its own folder")
    assert.deepEqual(kept(), keptBefore, "The checkout's kept copies stay")
    const comment = readFileSync(changed.comment, "utf8")
    assert.match(comment, /Watched documents changed/)
    assert.match(comment, /Gateway change/)
    assert.doesNotMatch(comment, /Later body text/)

    const missing = run("missing", "packages/errors")
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /packages\/errors/)
    assert.equal(existsSync(missing.comment), false)
})

test("A detailed change list joins its details with commas and counts the rest", async () => {
    const properties = (type) => Object.fromEntries("abcdefgh".split("").map((name) => [name, { type }]))
    const reachable = (type) => openapi({ "/users/@me": { get: returns("User", bot) } }, { User: { type: "object", properties: properties(type) } })
    const { manifest, source } = upstream({
        [pinned]: { ...document, "openapi.json": reachable("string") },
        [current]: { ...document, "openapi.json": reachable("integer") },
    })
    const report = renderReport(await checkUpstream(manifest, source))
    const decoded = report.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    assert.match(decoded, /, plus \d+ more/)
    assert.equal(decoded.includes(";"), false, "Public report text has no semicolons")
})

// The Git object ID a folder listing names a file by
const objectId = (text) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex")

// The fake upstream with each listed file's Git object ID, as GitHub's folder listing gives it, and a root folder
function withObjectIds(files, source) {
    return {
        ...source,
        listDirectory: async (repository, commit, directory) => {
            if (directory !== "") {
                const entries = await source.listDirectory(repository, commit, directory)
                return entries.map((entry) => (entry.type === "file" ? { ...entry, sha: objectId(files[commit][entry.path]) } : entry))
            }
            source.reads.push(`${commit.slice(0, 1)} /`)
            const names = new Set(Object.keys(files[commit]).map((path) => path.split("/")[0]))
            return [...names].map((path) => (path in files[commit] ? { path, type: "file", sha: objectId(files[commit][path]) } : { path, type: "dir" }))
        },
    }
}

test("Kept copies let a repeated check download no unchanged file, and a changed file only once", async (t) => {
    const folder = mkdtempSync(join(tmpdir(), "fluxerly-upstream-copies-"))
    t.after(() => rmSync(folder, { recursive: true, force: true }))
    const files = { [pinned]: document, [current]: changedDocument }
    const { manifest, source } = upstream(files)
    const fake = withObjectIds(files, source)
    const paths = workspace(t, manifest)
    const downloads = () => source.reads.filter((read) => !read.endsWith("/"))
    const first = await runUpstream([], { ...paths, source: fake, copiesFolder: folder })
    assert.ok(downloads().length > 0)
    const kept = readdirSync(folder).sort()
    source.reads.length = 0
    const again = await runUpstream([], { ...paths, source: fake, copiesFolder: folder })
    assert.deepEqual(downloads(), [], "Every file comes from its kept copy")
    assert.deepEqual(again.result, first.result)
    assert.deepEqual(readdirSync(folder).sort(), kept)

    // A copy that no longer hashes to its ID is downloaded again
    writeFileSync(join(folder, objectId(changedDocument[`${gateway}/events.md`])), "Damaged copy")
    source.reads.length = 0
    assert.deepEqual((await runUpstream([], { ...paths, source: fake, copiesFolder: folder })).result, first.result)
    assert.deepEqual(downloads(), [`b ${gateway}/events.md`])
})

test("A downloaded file that differs from the Git object its folder lists fails, and an unlisted ID downloads as before", async (t) => {
    const folder = mkdtempSync(join(tmpdir(), "fluxerly-upstream-copies-"))
    t.after(() => rmSync(folder, { recursive: true, force: true }))
    const files = { [pinned]: document, [current]: document }
    const { source } = upstream(files)
    const lying = withObjectIds({ ...files, [current]: { ...document, [`${gateway}/events.md`]: "Other bytes" } }, source)
    await assert.rejects(keepingCopies(lying, folder).fetchFile("fluxerapp/fluxer", current, `${gateway}/events.md`), /does not match the Git object/)
    assert.deepEqual(readdirSync(folder), [])
    // The plain fake lists no IDs, so its files are downloaded and nothing is kept
    const plain = keepingCopies(source, folder)
    assert.equal((await plain.fetchFile("fluxerapp/fluxer", current, `${gateway}/events.md`)).toString(), document[`${gateway}/events.md`])
    await plain.prune()
    assert.deepEqual(readdirSync(folder), [])
})

// A Fluxer source file whose rules the SDK copies, such as a request limit its OpenAPI document leaves out
const rules = "packages/schema/src/domains/webhook/WebhookRequestSchemas.ts"
const withRules = (files, text) => ({ ...files, [rules]: text })
const watchingRules = (manifest, text) => ({ ...manifest, sourceFacts: [{ path: rules, sha256: hash(text) }] })

test("A changed Fluxer source file the SDK copies rules from is drift, and an unchanged one is not", async (t) => {
    const before = "export const waveform = z.string().max(256)\n"
    const after = "export const waveform = z.string().max(512)\n"
    const unchanged = upstream({ [pinned]: withRules(document, before), [current]: withRules(document, before) })
    const quiet = await checkUpstream(watchingRules(unchanged.manifest, before), unchanged.source)
    assert.equal(quiet.drift, false)
    assert.deepEqual(quiet.sourceFacts, [{ path: rules, pinned: hash(before), current: hash(before), changed: false }])
    assert.ok(renderReport(quiet).includes(`| ${rules.replaceAll("_", "&#95;")} | unchanged |`))
    assert.doesNotMatch(renderReport(quiet), /copies rules from/)

    const { manifest, source } = upstream({ [pinned]: withRules(document, before), [current]: withRules(document, after) })
    const files = workspace(t, watchingRules(manifest, before))
    const args = ["--baseline", files.baselineFile, "--record", files.recordFile]
    const first = await runUpstream(args, { ...files, source })
    assert.equal(first.result.drift, true)
    assert.match(first.report, /### Fluxer source files the SDK copies rules from\n\nReview the SDK limits and checks that cite each changed file\n\n- Changed \(1\): /)
    // The observation records the new hash, so the next run reports nothing new
    assert.deepEqual(JSON.parse(readFileSync(files.recordFile, "utf8")).sourceFacts, [{ path: rules, sha256: hash(after) }])
    writeFileSync(files.baselineFile, readFileSync(files.recordFile, "utf8"))
    const second = await runUpstream(args, { ...files, source })
    assert.equal(second.result.drift, false)
    assert.equal(second.sincePin.drift, true, "The change stays visible against the repository pin")

    await runUpstream(["--update", current], { ...files, source })
    const pin = JSON.parse(readFileSync(files.manifestFile, "utf8"))
    assert.deepEqual(pin.sourceFacts, [{ path: rules, sha256: hash(after) }])
    assert.equal(Object.keys(pin).at(-1), "sourceFacts")
})

test("A previous observation recorded before a source file was watched compares that file with the repository pin", async (t) => {
    const text = "export const limit = 25\n"
    const { manifest, source } = upstream({ [pinned]: withRules(document, text), [current]: withRules(document, "export const limit = 50\n") })
    const files = workspace(t, watchingRules(manifest, text))
    // An observation from before sourceFacts existed
    writeFileSync(files.baselineFile, JSON.stringify(manifest))
    const result = await runUpstream(["--baseline", files.baselineFile], { ...files, source })
    assert.equal(result.baseline.kind, "previous-run")
    assert.equal(result.baseline.reason, undefined)
    assert.deepEqual(result.result.sourceFacts.map(({ path, changed }) => ({ path, changed })), [{ path: rules, changed: true }])
})

test("The manifest's watched source files are relative, hashed and listed once", () => {
    const value = JSON.parse(readFileSync(new URL("../upstream/manifest.json", import.meta.url), "utf8"))
    const facts = value.sourceFacts
    assert.ok(facts.length > 0)
    for (const sourceFacts of [
        [...facts, facts[0]],
        [...facts, { path: "../outside.ts", sha256: facts[0].sha256 }],
        [...facts, { path: "/absolute.ts", sha256: facts[0].sha256 }],
        [{ ...facts[0], sha256: "main" }],
        { path: facts[0].path, sha256: facts[0].sha256 },
    ])
        assert.throws(() => validateManifest({ ...value, sourceFacts }), /invalid/)
})

test("Every Fluxer schema, constants or voice note file the SDK cites as the source of a copied rule is watched", () => {
    const sdk = fileURLToPath(new URL("../../sdk/", import.meta.url))
    const watched = new Set(JSON.parse(readFileSync(new URL("../upstream/manifest.json", import.meta.url), "utf8")).sourceFacts.map(({ path }) => path))
    const cited = new Set()
    const sources = [
        ...readdirSync(join(sdk, "src"), { recursive: true }).filter((name) => name.endsWith(".ts")).map((name) => join(sdk, "src", name)),
        join(sdk, "tests/contract/fixtures/openapi-server-facts.json"),
    ]
    for (const file of sources)
        for (const [path] of readFileSync(file, "utf8").matchAll(/(?:packages\/(?:schema|constants)\/src|fluxer_app\/src\/features\/voice)\/[\w/.-]+\.ts/g))
            cited.add(path)
    assert.ok(cited.size > 5)
    assert.deepEqual([...cited].filter((path) => !watched.has(path)).sort(), [])
})

// Fluxer's voice docs and code are hashed by the Git object ID of each file under a watched path, as GitHub's listings name it
const gitId = (text) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex")
const voiceHash = (files, path) =>
    hash(
        Object.keys(files)
            .filter((name) => name === path || name.startsWith(`${path}/`))
            .map((name) => `${name} ${gitId(files[name])}`)
            .sort()
            .join("\n"),
    )
const voiceDocs = "fluxer_docs/src/content/docs/voice"
const liveKit = "fluxer_api/src/api/infrastructure/LiveKitService.ts"
const voicePaths = [voiceDocs, liveKit]
const watchingVoice = (manifest, files) => ({ ...manifest, voice: voicePaths.map((path) => ({ path, sha256: voiceHash(files, path) })) })
const voiceDocument = {
    ...document,
    [`${voiceDocs}/index.md`]: "# Voice\n\nMedia uses LiveKit",
    [`${voiceDocs}/permissions/index.md`]: "# Voice permissions",
    [liveKit]: "export class LiveKitService {}",
}

test("A change under a watched voice path is drift that names its files, and a removed path is reported instead of failing", async (t) => {
    const unchanged = upstream({ [pinned]: voiceDocument, [current]: voiceDocument })
    const quiet = await checkUpstream(watchingVoice(unchanged.manifest, voiceDocument), unchanged.source)
    assert.equal(quiet.drift, false)
    assert.deepEqual(
        quiet.voice.map(({ path, changed, found }) => ({ path, changed, found })),
        voicePaths.map((path) => ({ path, changed: false, found: true })),
    )
    assert.ok(unchanged.source.reads.every((read) => !read.startsWith("a ")), "An unchanged voice path reads nothing at the baseline")
    assert.ok(renderReport(quiet).includes("| Voice files in fluxer&#95;docs/src/content/docs/voice | unchanged |"))
    assert.doesNotMatch(renderReport(quiet), /Fluxer voice docs and code/)

    // The new voice system replaces the guide's transport section, adds a page and removes the LiveKit service
    const { [liveKit]: _, [`${voiceDocs}/permissions/index.md`]: __, ...rest } = voiceDocument
    const replaced = { ...rest, [`${voiceDocs}/index.md`]: "# Voice\n\nMedia uses WebTransport", [`${voiceDocs}/bots.md`]: "# Bot voice" }
    const { manifest, source } = upstream({ [pinned]: voiceDocument, [current]: replaced })
    const files = workspace(t, watchingVoice(manifest, voiceDocument))
    const args = ["--baseline", files.baselineFile, "--record", files.recordFile, "--comment", files.commentFile]
    const first = await runUpstream(args, { ...files, source: withHistory(source, [commit("b", "Voice", "fluxer_app/src/Voice.tsx"), commit("a", "Baseline")]) })
    assert.equal(first.result.drift, true)
    assert.deepEqual(first.result.voice[0].files, {
        added: [`${voiceDocs}/bots.md`],
        removed: [`${voiceDocs}/permissions/index.md`],
        changed: [`${voiceDocs}/index.md`],
    })
    assert.deepEqual(first.result.voice[1].files, { added: [], removed: [liveKit], changed: [] })
    assert.equal(first.result.voice[1].found, false)
    const comment = readFileSync(files.commentFile, "utf8")
    assert.match(comment, /### Fluxer voice docs and code/)
    assert.match(comment, /Files added in fluxer&#95;docs\/src\/content\/docs\/voice \(1\): fluxer&#95;docs\/src\/content\/docs\/voice\/bots\.md/)
    assert.match(comment, /\| Voice files in fluxer&#95;api\/src\/api\/infrastructure\/LiveKitService\.ts \| changed, not found \|/)
    // The observation records the new hashes, so the next run reports nothing new
    assert.deepEqual(JSON.parse(readFileSync(files.recordFile, "utf8")).voice, voicePaths.map((path) => ({ path, sha256: voiceHash(replaced, path) })))
    writeFileSync(files.baselineFile, readFileSync(files.recordFile, "utf8"))
    rmSync(files.commentFile)
    const second = await runUpstream(args, { ...files, source: withHistory(source, [commit("b", "Voice", "fluxer_app/src/Voice.tsx")]) })
    assert.equal(second.result.drift, false)
    assert.equal(existsSync(files.commentFile), false)
    assert.equal(second.sincePin.drift, true, "The change stays visible against the repository pin")

    // An update pins the current hashes, a missing path included, so the check stays green after Fluxer removed it
    await runUpstream(["--update", current], { ...files, source })
    const pin = JSON.parse(readFileSync(files.manifestFile, "utf8"))
    assert.deepEqual(pin.voice, voicePaths.map((path) => ({ path, sha256: voiceHash(replaced, path) })))
    assert.equal(Object.keys(pin).at(-1), "voice")
    assert.equal((await runUpstream([], { ...files, source })).result.drift, false)
})

test("A previous observation recorded before voice paths were watched compares them with the repository pin", async (t) => {
    const changed = { ...voiceDocument, [liveKit]: "export class LiveKitService { grant() {} }" }
    const { manifest, source } = upstream({ [pinned]: voiceDocument, [current]: changed })
    const files = workspace(t, watchingVoice(manifest, voiceDocument))
    writeFileSync(files.baselineFile, JSON.stringify(manifest))
    const result = await runUpstream(["--baseline", files.baselineFile], { ...files, source })
    assert.equal(result.baseline.kind, "previous-run")
    assert.equal(result.baseline.reason, undefined)
    assert.deepEqual(result.result.voice.map(({ path, changed }) => ({ path, changed })), [
        { path: voiceDocs, changed: false },
        { path: liveKit, changed: true },
    ])
})

test("A new folder named for voice, RTC, media or WebTransport is reported once without failing, and other new folders are not", async (t) => {
    const before = { ...document, "packages/schema/index.ts": "", "fluxer_app/pkgs/livekit-client/index.ts": "" }
    const after = {
        ...before,
        "fluxer_voice/Cargo.toml": "",
        "packages/webtransport_client/index.ts": "",
        "packages/RTC/index.ts": "",
        "fluxer_app/pkgs/media-engine/index.ts": "",
        "packages/markdown/index.ts": "",
        // A file is not a folder, and a nested folder is not a package
        "voice.md": "",
        "packages/schema/voice/index.ts": "",
    }
    const { manifest, source } = upstream({ [pinned]: before, [current]: after })
    const folders = ["fluxer_app", "fluxer_app/pkgs/livekit-client", "fluxer_docs", gateway, limits, "packages", "packages/schema"]
    const files = workspace(t, { ...manifest, folders })
    const args = ["--baseline", files.baselineFile, "--record", files.recordFile, "--comment", files.commentFile]
    const history = [commit("b", "Voice server", "fluxer_voice/Cargo.toml"), commit("a", "Baseline")]
    const first = await runUpstream(args, { ...files, source: withHistory(source, history) })
    assert.equal(first.result.drift, false, "No watched document changed")
    assert.deepEqual(first.commits, [], "No commit touched a watched path")
    assert.deepEqual(first.result.newVoiceFolders, ["fluxer_app/pkgs/media-engine", "fluxer_voice", "packages/RTC", "packages/webtransport_client"])
    const comment = readFileSync(files.commentFile, "utf8")
    assert.match(comment, /### New folders that may hold voice work/)
    assert.match(comment, /- Added \(4\): fluxer&#95;app\/pkgs\/media-engine, fluxer&#95;voice, packages\/RTC, packages\/webtransport&#95;client/)
    assert.doesNotMatch(comment, /packages\/markdown/)
    const recorded = JSON.parse(readFileSync(files.recordFile, "utf8"))
    assert.ok(recorded.folders.includes("fluxer_voice") && recorded.folders.includes("packages/markdown"))
    assert.equal(recorded.folders.includes("fluxer_api/pkgs"), false, "A missing package folder is skipped")

    writeFileSync(files.baselineFile, JSON.stringify(recorded))
    rmSync(files.commentFile)
    const second = await runUpstream(args, { ...files, source: withHistory(source, history.slice(0, 1)) })
    assert.deepEqual(second.result.newVoiceFolders, [])
    assert.equal(existsSync(files.commentFile), false, "A folder is reported the week it appears")
    assert.equal(second.sincePin.newVoiceFolders.length, 4, "The job summary still lists it against the repository pin")
    assert.match(readFileSync(files.summaryFile, "utf8"), /fluxer&#95;voice/)

    await runUpstream(["--update", current], { ...files, source })
    assert.deepEqual(JSON.parse(readFileSync(files.manifestFile, "utf8")).folders, recorded.folders)
})

test("The repository pin watches Fluxer's voice docs and code, and its folder list, with valid entries", () => {
    const value = JSON.parse(readFileSync(new URL("../upstream/manifest.json", import.meta.url), "utf8"))
    assert.deepEqual(
        value.voice.map(({ path }) => path),
        [voiceDocs, liveKit, "packages/voice_engine_v2", "fluxer_app/pkgs/livekit-client"],
    )
    for (const path of ["fluxer_api", "packages/voice_engine_v2", "fluxer_app/pkgs/livekit-client", "fluxer_api/pkgs/media_proxy_utils"])
        assert.ok(value.folders.includes(path), path)
    const voice = value.voice
    for (const invalid of [
        { voice: [...voice, voice[0]] },
        { voice: [{ path: "../outside", sha256: voice[0].sha256 }] },
        { voice: [{ ...voice[0], sha256: "main" }] },
        { folders: [...value.folders, value.folders[0]] },
        { folders: ["/absolute"] },
        { folders: ["packages/../outside"] },
        { folders: [""] },
        { folders: "packages" },
    ])
        assert.throws(() => validateManifest({ ...value, ...invalid }), /invalid/)
})
