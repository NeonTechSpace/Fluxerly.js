// Gateway payload capture for the conformance fixture tests/contract/fixtures/gateway-captures.json.
// Triggers common dispatches in one journaled temporary channel through the raw API and keeps only the bot's own
// dispatches in that channel. The scrubber replaces every string with a stable placeholder, passes numbers only under
// reviewed protocol field names and refuses unreviewed field names, and the run stops when the result still holds a
// secret or a captured string of four or more characters. The run prints event names and counts only, never payload
// values. Without `--write` it only verifies capture and scrubbing. With `--write` it replaces the committed fixture,
// which is the only way the fixture changes.
// Journal `.env.test.gateway-capture.local` (`.env.test.gateway-capture-write.local` with `--write`), written with or
// without `--write`, records the server ID and the test channel's unique marker and returned ID. An existing journal
// triggers recovery only: The channel is matched by its marker, deleted and its removal verified. The harness changes
// nothing else in the sandbox
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { format, resolveConfig } from "prettier"
import WebSocket from "ws"
import { cleanupGuildChannelFixtures, createGuildChannelFixture } from "./channel-fixture.mjs"
import {
    acquireLock,
    finalizeOwned,
    loadSandboxEnvironment,
    openJournal,
    verifySandboxIdentity,
} from "./support/harness.js"
import { captureEmoji, retainFrame } from "./support/capture-filter.js"
import { assertScrubbed, createScrubber } from "./support/gateway-scrub.js"
import { createOutcomeReporter } from "./support/reporting.js"
import { settle as value } from "./support/results.js"
import { createRetryingSandboxApi } from "./support/sandbox-api.js"

const write = process.argv[2] === "--write"
const rawFetch = globalThis.fetch
const journalFile = openJournal(write ? "gateway-capture-write" : "gateway-capture")
const report = createOutcomeReporter({})
const fixtureUrl = new URL("../contract/fixtures/gateway-captures.json", import.meta.url)
let stage = "configuration"
let lock
let token
let guildId
let botId
let journal
let client
let verified = false
let restoreGateway

const api = createRetryingSandboxApi({ fetch: rawFetch, token: () => token, allowNotFound: true })
const save = () => journalFile.save(journal)

async function cleanup() {
    if (!journal) return
    assert.equal(journal.guildId, guildId)
    await cleanupGuildChannelFixtures(api, journal, save)
    journalFile.remove()
    journal = undefined
    report("test_channel_and_messages_removed")
}

// Only the bot's own activity in the test channel is ever kept. The channel is recognized by its journaled marker
// before its ID is known, and everything else by the returned ID
const wanted = new Set([
    "CHANNEL_CREATE",
    "CHANNEL_UPDATE",
    "CHANNEL_DELETE",
    "MESSAGE_CREATE",
    "MESSAGE_UPDATE",
    "MESSAGE_DELETE",
    "MESSAGE_REACTION_ADD",
    "MESSAGE_REACTION_REMOVE",
    "TYPING_START",
])
const frames = []

// The channel's identity outlives the journal, which cleanup clears before the channel delete dispatch arrives
let ownership

function channelIdentity() {
    const fixture = journal?.channelFixtures?.explicitChild
    if (fixture) {
        ownership ??= { name: fixture.name }
        if (fixture.id !== undefined) ownership.id = fixture.id
    }
    return ownership
}

function observeFrames() {
    const original = WebSocket.prototype.emit
    WebSocket.prototype.emit = function (event, ...args) {
        if (event === "message") {
            try {
                const frame = JSON.parse(args[0].toString())
                if (
                    frame?.op === 0 &&
                    wanted.has(frame.t) &&
                    retainFrame(frame.t, frame.d, { channel: channelIdentity(), botId })
                )
                    frames.push({ type: frame.t, body: frame.d })
            } catch {
                // allow-silent: The SDK owns protocol validation, and an unreadable frame is simply not captured
            }
        }
        return Reflect.apply(original, this, [event, ...args])
    }
    return () => {
        WebSocket.prototype.emit = original
    }
}

async function waitForFrame(type, matches, description, { optional = false } = {}) {
    const deadline = performance.now() + (optional ? 8_000 : 20_000)
    for (;;) {
        const found = frames.find((frame) => frame.type === type && matches(frame.body))
        if (found) return found
        if (performance.now() >= deadline) {
            assert.ok(optional, `Timed out waiting for ${description}`)
            return undefined
        }
        await sleep(20)
    }
}

const noPings = { parse: [], users: [], roles: [], replied_user: false }

async function triggerAndCollect(channelId) {
    const found = []
    const keep = (label, frame) => found.push({ label, type: frame.type, body: frame.body })
    const channelEntry = journal.channelFixtures.explicitChild
    keep(
        "channel-create",
        await waitForFrame("CHANNEL_CREATE", (body) => body.id === channelId, "the channel create dispatch"),
    )

    stage = "message_create"
    const first = (
        await api("POST", `/channels/${channelId}/messages`, {
            content: `capture-${randomUUID()}`,
            allowed_mentions: noPings,
        })
    ).data
    assert.match(first?.id ?? "", /^\d+$/)
    keep(
        "message-create",
        await waitForFrame("MESSAGE_CREATE", (body) => body.id === first.id, "the message create dispatch"),
    )

    stage = "message_create_reply"
    const second = (
        await api("POST", `/channels/${channelId}/messages`, {
            content: `capture-reply-${randomUUID()} <@${botId}>`,
            allowed_mentions: { parse: ["users"] },
            message_reference: { message_id: first.id },
            embeds: [
                {
                    title: `capture-title-${randomUUID()}`,
                    description: `capture-description-${randomUUID()}`,
                    url: "https://example.invalid/capture",
                    color: 5814783,
                    timestamp: "2026-01-02T03:04:05.000Z",
                    footer: { text: `capture-footer-${randomUUID()}` },
                    author: { name: `capture-author-${randomUUID()}` },
                    fields: [
                        { name: `capture-field-${randomUUID()}`, value: `capture-value-${randomUUID()}`, inline: true },
                    ],
                },
            ],
        })
    ).data
    assert.match(second?.id ?? "", /^\d+$/)
    keep(
        "message-create-reply-embed",
        await waitForFrame("MESSAGE_CREATE", (body) => body.id === second.id, "the reply create dispatch"),
    )

    stage = "message_update"
    const edited = `capture-edited-${randomUUID()}`
    await api("PATCH", `/channels/${channelId}/messages/${first.id}`, { content: edited, allowed_mentions: noPings })
    keep(
        "message-update",
        await waitForFrame(
            "MESSAGE_UPDATE",
            (body) => body.id === first.id && body.content === edited,
            "the message update dispatch",
        ),
    )

    stage = "reactions"
    const emoji = encodeURIComponent(captureEmoji)
    await api("PUT", `/channels/${channelId}/messages/${first.id}/reactions/${emoji}/@me`)
    keep(
        "reaction-add",
        await waitForFrame("MESSAGE_REACTION_ADD", (body) => body.message_id === first.id, "the reaction add dispatch"),
    )
    await api("DELETE", `/channels/${channelId}/messages/${first.id}/reactions/${emoji}/@me`)
    keep(
        "reaction-remove",
        await waitForFrame(
            "MESSAGE_REACTION_REMOVE",
            (body) => body.message_id === first.id,
            "the reaction remove dispatch",
        ),
    )

    stage = "typing_start"
    await api("POST", `/channels/${channelId}/typing`)
    const typing = await waitForFrame("TYPING_START", (body) => body.user_id === botId, "the typing dispatch", {
        optional: true,
    })
    if (typing) keep("typing-start", typing)
    report(stage, true, { received: typing !== undefined })

    stage = "channel_update"
    const topic = `capture-topic-${randomUUID()}`
    await api("PATCH", `/channels/${channelId}`, { topic })
    keep(
        "channel-update",
        await waitForFrame(
            "CHANNEL_UPDATE",
            (body) => body.id === channelId && body.topic === topic,
            "the channel update dispatch",
        ),
    )

    stage = "message_delete"
    await api("DELETE", `/channels/${channelId}/messages/${second.id}`)
    keep(
        "message-delete",
        await waitForFrame("MESSAGE_DELETE", (body) => body.id === second.id, "the message delete dispatch"),
    )

    stage = "channel_delete"
    await cleanup()
    keep(
        "channel-delete",
        await waitForFrame("CHANNEL_DELETE", (body) => body.id === channelId, "the channel delete dispatch"),
    )
    assert.ok(channelEntry.id === channelId)
    return { found, ids: [channelId, first.id, second.id], names: [channelEntry.name], texts: [edited, topic] }
}

function scrubAndCheck(collected, identity, sandbox) {
    stage = "scrub"
    const scrubber = createScrubber({ botId })
    const captures = collected.found.map(({ label, type, body }) => ({
        label,
        event: type,
        payload: scrubber.scrub(body),
    }))
    const secrets = [
        sandbox.token,
        guildId,
        botId,
        sandbox.applicationId,
        identity.user.username,
        identity.user.global_name,
        identity.guild.name,
        ...collected.ids,
        ...collected.names,
        ...collected.texts,
    ]
    assertScrubbed(captures, { secrets, originals: scrubber.originals, kept: scrubber.kept })
    report(stage, true, { captures: captures.length, strings: scrubber.originals.size })
    return captures
}

// A watchdog is failure containment only. A passing invocation exits naturally after verified cleanup
setTimeout(() => {
    report("process_timeout", false)
    process.exit(1)
}, 220_000).unref()

try {
    assert.ok(process.argv[2] === undefined || write)
    assert.equal(process.argv[3], undefined)
    stage = "sandbox_lock"
    lock = acquireLock()
    stage = "configuration"
    const sandbox = loadSandboxEnvironment()
    token = sandbox.token
    guildId = sandbox.guildId

    stage = "sandbox_identity"
    const identity = await verifySandboxIdentity(async (path) => (await api("GET", path)).data, {
        ...sandbox,
        applicationPath: "/oauth2/applications/@me",
    })
    botId = identity.botId
    verified = true
    report(stage, true, { clientSecretUsed: false })

    stage = "recover_prior_test"
    if (journalFile.exists()) {
        journal = journalFile.read()
        stage = "recovery_only"
        await cleanup()
        report(stage)
    } else {
        journal = { guildId }
        journalFile.create(journal)

        stage = "connect"
        restoreGateway = observeFrames()
        const { createClient } = await import("@neontechspace/fluxerly")
        client = createClient({ token })
        await value(client.connect())
        report(stage)

        stage = "create_test_channel"
        const channel = await createGuildChannelFixture(journal, save, "explicitChild", { type: 0 }, (input) =>
            api("POST", `/guilds/${guildId}/channels`, input).then((response) => {
                assert.equal(response.status, 200)
                return {
                    id: response.data?.id,
                    guildId: response.data?.guild_id,
                    type: response.data?.type,
                    name: response.data?.name,
                }
            }),
        )
        assert.equal(channel.guildId, guildId)
        report(stage)

        const collected = await triggerAndCollect(channel.id)
        const counts = {}
        for (const frame of frames) counts[frame.type] = (counts[frame.type] ?? 0) + 1
        report("captured_events", true, { counts })

        stage = "client_shutdown"
        await value(client.shutdown())
        restoreGateway()
        restoreGateway = undefined
        report(stage)

        const captures = scrubAndCheck(collected, identity, { ...sandbox })
        if (write) {
            stage = "write_fixture"
            const path = fileURLToPath(fixtureUrl)
            const text = JSON.stringify({ captures }, null, 4)
            const options = (await resolveConfig(path)) ?? {}
            writeFileSync(path, await format(text, { ...options, parser: "json" }))
            report(stage, true, { captures: captures.length })
        }
    }
} catch (error) {
    report(stage, false, {
        ...(error?.code === "ERR_ASSERTION"
            ? { assertionLine: Number(error.stack?.match(/gateway-capture\.js:(\d+):\d+/)?.[1]) || undefined }
            : {}),
        ...(typeof error?.status === "number" ? { httpStatus: error.status } : {}),
        category:
            error?.code === "ERR_ASSERTION" ? "assertion" : error?.name === "ScrubRefusal" ? "scrub" : "unexpected",
    })
    process.exitCode = 1
} finally {
    restoreGateway?.()
    // Keep the journal and lock if a failed owned finalizer may have left a writer alive
    await finalizeOwned({
        writers: [client && client.state !== "Closed" && ["client_shutdown", () => value(client.shutdown())]],
        cleanup: async () => {
            if (verified && journal) await cleanup()
        },
        lock,
        onFailure: (finalizer) => {
            if (finalizer === "cleanup") report("cleanup", false, { journalRetained: journal !== undefined })
            else if (finalizer === "sandbox_lock") report("lock_cleanup", false, { lockRetained: true })
            else
                report("cleanup", false, {
                    finalizer,
                    journalRetained: journal !== undefined,
                    lockRetained: lock !== undefined,
                })
            process.exitCode = 1
        },
    })
}
