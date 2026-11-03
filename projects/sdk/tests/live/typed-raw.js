// Typed raw access against hosted Fluxer: client.rest.call on a read with path parameters and a query, a write with a
// JSON body, GET /gateway/bot, which the route type corrections add, a send with a file and an edit that keeps it beside
// a new file, and the bot's own message arriving as a raw MESSAGE_CREATE that the SDK marks as documented. Each response is checked for the fields its route type promises.
// Journal `.env.test.typed-raw.local` records sandbox and bot identity and the temporary channel's unique name before it
// is created, then its returned ID. The bot's message lives in that channel, so deleting the channel removes it. An
// existing journal triggers recovery only: The journaled channel is deleted and its absence verified
import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import { cleanupMainTestChannel, createMainTestChannel } from "./channel-fixture.mjs"
import {
    acquireLock,
    finalizeOwned,
    loadSandboxEnvironment,
    openJournal,
    sandboxBotId,
    snowflake,
} from "./support/harness.js"
import { createReporter, recoveredOnly } from "./support/reporting.js"
import { settle as value } from "./support/results.js"
import { createRetryingSandboxApi } from "./support/sandbox-api.js"
import { harnessWatchdogMs } from "./support/watchdogs.js"

const mode = process.argv[2]
assert.ok(mode === "default" || mode === "effect")
assert.equal(process.argv.length, 3)

const rawFetch = globalThis.fetch
const journalFile = openJournal("typed-raw")
const report = createReporter({ mode }, { passed: true })
// Fluxer delivers the bot's own MESSAGE_CREATE within a second or two. The wait bounds a missing delivery
const eventWaitMs = 15_000

let lock, journal, client, scope, token, guildId, botId, Effect, Exit, Scope
let verified = false
let stage = "configuration"
const save = () => journalFile.save(journal)
const api = createRetryingSandboxApi({ fetch: rawFetch, token: () => token, allowNotFound: true })
const watchdog = setTimeout(() => {
    console.error(JSON.stringify({ mode, stage, passed: false, reason: "deadline", journalRetained: !!journal }))
    process.exit(1)
}, harnessWatchdogMs()).unref()

async function cleanup() {
    if (!verified || !journal) return
    assert.equal(journal.guildId, guildId)
    assert.equal(journal.botId, botId)
    await cleanupMainTestChannel(api, journal, save)
    journalFile.remove()
    journal = undefined
    report("channel_cleanup_verified")
}

async function scenario(sdk) {
    if (mode === "effect") {
        ;({ Effect, Exit, Scope } = await import("effect"))
        scope = Scope.makeUnsafe()
        client = await value(sdk.createClient({ token }).pipe(Scope.provide(scope)))
    } else client = sdk.createClient({ token })

    stage = "channel"
    const channel = await createMainTestChannel(api, journal, { create: () => journalFile.create(journal), save })
    const channelId = channel.id
    report(stage)

    // Only raw dispatches of the owned channel are kept, so other checks' traffic cannot fill the list
    const raws = []
    const observe = (dispatch) => {
        if (dispatch.t === "MESSAGE_CREATE" && dispatch.d?.channel_id === channelId && raws.length < 16)
            raws.push(dispatch)
    }
    if (mode === "default") client.on("raw", observe)
    else
        await Effect.runPromise(
            client.on("raw", (dispatch) => Effect.sync(() => observe(dispatch))).pipe(Scope.provide(scope)),
        )
    stage = "connect"
    await value(client.connect())
    report(stage)

    stage = "rest_call_gateway_bot"
    // GET /gateway/bot is typed only because a reviewed correction adds its bot token, which this call proves
    const gateway = await value(client.rest.call("GET /gateway/bot"))
    assert.equal(gateway.status, 200)
    assert.equal(typeof gateway.body.url, "string")
    assert.match(gateway.body.url, /^wss?:\/\//)
    assert.ok(Number.isSafeInteger(gateway.body.shards) && gateway.body.shards >= 1)
    for (const field of ["total", "remaining", "reset_after", "max_concurrency"])
        assert.ok(Number.isSafeInteger(gateway.body.session_start_limit[field]), field)
    report(stage)

    stage = "rest_call_send_message"
    const content = `${journal.name} typed`
    const sent = await value(
        client.rest.call("POST /channels/{channel_id}/messages", {
            params: { channel_id: channelId },
            body: { content, allowed_mentions: { parse: [] } },
        }),
    )
    assert.equal(sent.status, 200)
    assert.match(sent.body.id, snowflake)
    assert.equal(sent.body.channel_id, channelId)
    assert.equal(sent.body.content, content)
    assert.equal(sent.body.author.id, botId)
    assert.equal(typeof sent.body.timestamp, "string")
    assert.ok(Array.isArray(sent.body.mentions) && sent.body.mentions.length === 0)
    report(stage)

    stage = "raw_documented_message_create"
    const until = performance.now() + eventWaitMs
    let raw
    while (!(raw = raws.find((dispatch) => dispatch.d?.id === sent.body.id))) {
        assert.ok(performance.now() < until, "Missing raw MESSAGE_CREATE")
        await sleep(25)
    }
    assert.equal(raw.documented, true)
    assert.equal(raw.d.channel_id, channelId)
    assert.equal(raw.d.author?.id, botId)
    assert.ok(Number.isSafeInteger(raw.s) && Number.isSafeInteger(raw.shardId))
    report(stage)

    stage = "rest_call_read_messages"
    // A path parameter and an integer query, which the corrections type as a number
    const listed = await value(
        client.rest.call("GET /channels/{channel_id}/messages", {
            params: { channel_id: channelId },
            query: { limit: 5 },
        }),
    )
    assert.equal(listed.status, 200)
    assert.ok(Array.isArray(listed.body) && listed.body.length >= 1 && listed.body.length <= 5)
    const read = listed.body.find((message) => message.id === sent.body.id)
    assert.ok(read, "The sent message is missing from the read")
    assert.equal(read.channel_id, channelId)
    assert.equal(read.content, content)
    assert.equal(read.author.id, botId)
    report(stage)

    stage = "rest_call_edit_keeps_attachment"
    // Fluxer replaces an edited message's attachments with the sent list, so the kept one must reach it beside the new file
    const withFile = await value(
        client.rest.call("POST /channels/{channel_id}/messages", {
            params: { channel_id: channelId },
            body: { content, attachments: [{ id: 0, filename: "one.txt", description: "first" }] },
            files: [{ data: new TextEncoder().encode("one"), filename: "one.txt" }],
        }),
    )
    assert.equal(withFile.body.attachments.length, 1)
    const first = withFile.body.attachments[0]
    assert.equal(first.filename, "one.txt")
    assert.equal(first.description, "first")
    const edited = await value(
        client.rest.call("PATCH /channels/{channel_id}/messages/{message_id}", {
            params: { channel_id: channelId, message_id: withFile.body.id },
            body: { attachments: [{ id: first.id }] },
            files: [{ data: new TextEncoder().encode("two"), filename: "two.txt" }],
        }),
    )
    assert.deepEqual(
        edited.body.attachments.map((attachment) => attachment.filename),
        ["one.txt", "two.txt"],
    )
    assert.equal(edited.body.attachments[0].id, first.id)
    report(stage)

    stage = "client_shutdown"
    await value(client.shutdown())
    assert.equal(client.state, "Closed")
    report(stage)
}

try {
    stage = "sandbox_lock"
    lock = acquireLock()
    const sandbox = loadSandboxEnvironment()
    token = sandbox.token
    guildId = sandbox.guildId
    stage = "sandbox_identity"
    botId = await sandboxBotId(async (path) => (await api("GET", path)).data, sandbox)
    verified = true
    report(stage)
    if (journalFile.exists()) {
        journal = journalFile.read()
        stage = "recovery_only"
        await cleanup()
        recoveredOnly()
        report(stage)
    } else {
        journal = { guildId, botId }
        const sdk = await import(mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect")
        await scenario(sdk)
    }
} catch (error) {
    // Do not emit configured IDs, channel names, message bodies, raw failures or credentials
    console.error(
        JSON.stringify({
            mode,
            stage,
            passed: false,
            category: error?._tag ?? (error?.code === "ERR_ASSERTION" ? "assertion" : "check"),
            operation: typeof error?.operation === "string" ? error.operation : undefined,
            reason: error?.reason,
            outcome: error?.outcome,
            status: error?.status,
            providerCode: error?.apiError?.providerCode,
            journalRetained: journalFile.exists(),
        }),
    )
    process.exitCode = 1
} finally {
    // Keep the journal, lock and watchdog if a failed owned finalizer may have left a writer alive
    await finalizeOwned({
        writers: [
            client && client.state !== "Closed" && ["client_shutdown", () => value(client.shutdown())],
            scope && ["scope_close", () => Effect.runPromise(Scope.close(scope, Exit.void))],
        ],
        // A journal exists only once the channel's name was recorded, so nothing before that needs cleanup
        cleanup: () => (journal && journalFile.exists() ? cleanup() : undefined),
        lock,
        watchdog,
        onFailure: (finalizer) => {
            console.error(JSON.stringify({ mode, finalizer, passed: false, journalRetained: journalFile.exists() }))
            process.exitCode = 1
        },
    })
}
