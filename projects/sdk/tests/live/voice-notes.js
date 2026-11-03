// Voice notes in test-owned channels: A voice note sent as a message, as the starter of a forum post and through a
// webhook whose waveform is exactly the 256 characters a webhook send allows, each with a voiceWaveform result for
// synthetic WAV audio, read back from Fluxer for the voice note flag, duration and waveform. A 257-character webhook
// waveform must fail locally before dispatch.
// Journal `.env.test.voice-notes.local` records sandbox and bot identity, a unique marker, the channel fixtures with
// their markers and IDs, the forum post's thread ID and the webhook's name and ID, never webhook tokens or message
// bodies. An existing journal triggers recovery only: The webhook is verified against the designated bot and the
// owned text channel before deletion, the owned channels are removed, which deletes their messages and the post, and
// the journaled thread and the active thread list are then checked for leftovers under those channels
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { Effect, Exit, Scope } from "effect"
import { cleanupGuildChannelFixtures, createGuildChannelFixture } from "./channel-fixture.mjs"
import {
    acquireLock,
    finalizeOwned,
    loadSandboxEnvironment,
    openJournal,
    snowflake,
    sandboxBotId,
} from "./support/harness.js"
import { createReporter, recoveredOnly } from "./support/reporting.js"
import { settle as value } from "./support/results.js"
import { createDeadlineSandboxApi } from "./support/sandbox-api.js"
import {
    messageNoteSeconds,
    sampleRate,
    syntheticSamples,
    wavFile,
    webhookNoteSeconds,
} from "./support/voice-note-audio.js"
import { harnessWatchdogMs, pacedDeadlineMs } from "./support/watchdogs.js"

const mode = process.argv[2]
assert.ok(mode === "default" || mode === "effect")
assert.equal(process.argv.length, 3)

const rawFetch = globalThis.fetch
const journalFile = openJournal("voice-notes")
const markerPattern = /^fluxerly-voice-notes-[a-f0-9]{32}$/
const threadTypes = [10, 11, 12]
/** MessageFlags.VoiceMessage on the wire (packages/constants/src/ChannelConstants.ts:122 at 5f3fc0b1) */
const voiceMessageFlag = 1 << 13
const report = createReporter({ mode }, { passed: true })

// Whole-run bounds derived from the work: About 30 requests, three uploads that Fluxer probes as media and one webhook
// deletion get 90 seconds, with one minute for a spent per-minute edge limit. The shared pacer then adds a slot for
// each request: at most 30 in the operation, counting both clients' discovery, each upload's plan, transfer,
// completion and send, and every readback, and at most 18 in cleanup. The process watchdog in support/watchdogs.js
// covers both
const edgeWindowMs = 60_000
const operationMs = pacedDeadlineMs(30_000 + edgeWindowMs, 30, { clients: 2 })
const cleanupMs = pacedDeadlineMs(30_000 + edgeWindowMs, 18)

let lock, journal, bot, hook, scope, token, guildId, botId
let verified = false
let stage = "configuration"
const operationDeadline = new AbortController()
let requestDeadline = operationDeadline.signal
const save = () => journalFile.save(journal)
const api = createDeadlineSandboxApi({ fetch: rawFetch, token: () => token, deadline: () => requestDeadline })
const deadlineTimer = setTimeout(() => operationDeadline.abort(), operationMs).unref()
// This is failure containment, not cleanup evidence. The journal remains for a later verified recovery
const watchdog = setTimeout(() => {
    console.error(JSON.stringify({ mode, stage, passed: false, reason: "deadline", journalRetained: !!journal }))
    process.exit(1)
}, harnessWatchdogMs()).unref()

const ownedChannelIds = () =>
    new Set(
        Object.values(journal?.channelFixtures ?? {})
            .map((entry) => entry.id)
            .filter((id) => id !== undefined),
    )

async function cleanup() {
    if (!verified || !journal) return
    const priorRequestDeadline = requestDeadline
    requestDeadline = AbortSignal.timeout(cleanupMs)
    try {
        assert.equal(journal.guildId, guildId)
        assert.equal(journal.botId, botId)
        assert.match(journal.marker ?? "", markerPattern)
        assert.ok(Array.isArray(journal.threadIds) && journal.threadIds.every((id) => snowflake.test(id)))
        if (journal.webhook !== undefined) {
            assert.equal(journal.webhook.name, `${journal.marker}-hook`)
            if (journal.webhook.id !== undefined) assert.match(journal.webhook.id, snowflake)
            const channelId = journal.channelFixtures?.voiceNotes?.id
            const matches = (item) => item.id === journal.webhook.id || item.name === journal.webhook.name
            const hooks = (await api("GET", `/guilds/${guildId}/webhooks`)).data
            assert.ok(Array.isArray(hooks))
            for (const item of hooks.filter(matches)) {
                assert.equal(item.name, journal.webhook.name)
                assert.equal(item.user?.id, botId)
                assert.equal(item.guild_id, guildId)
                assert.ok(channelId !== undefined && item.channel_id === channelId)
                journal.webhook.id = item.id
                save()
                assert.equal((await api("DELETE", `/webhooks/${item.id}`)).status, 204)
                assert.equal((await api("GET", `/webhooks/${item.id}`)).status, 404)
            }
            assert.ok(journal.webhook.id !== undefined || journal.webhook.rejected, "Unresolved webhook creation")
            const after = (await api("GET", `/guilds/${guildId}/webhooks`)).data
            assert.ok(Array.isArray(after) && !after.some(matches))
        }
        await cleanupGuildChannelFixtures(api, journal, save)
        const owned = ownedChannelIds()
        for (const id of journal.threadIds) {
            const current = await api("GET", `/channels/${id}`)
            if (current.status === 404) continue
            // A post that outlived its deleted forum is removed only while it still names an owned parent
            assert.equal(current.status, 200)
            assert.equal(current.data?.guild_id, guildId)
            assert.ok(threadTypes.includes(current.data?.type) && owned.has(current.data?.parent_id))
            assert.equal((await api("DELETE", `/channels/${id}`)).status, 204)
            assert.equal((await api("GET", `/channels/${id}`)).status, 404)
        }
        const active = (await api("GET", `/guilds/${guildId}/threads/active`)).data
        assert.ok(Array.isArray(active?.threads) && !active.threads.some((thread) => owned.has(thread.parent_id)))
        journalFile.remove()
        journal = undefined
        report("webhook_channels_and_post_cleanup_verified")
    } finally {
        requestDeadline = priorRequestDeadline
    }
}

async function scenario(sdk) {
    const { ChannelType, MessageFlags } = sdk
    assert.equal(MessageFlags.VoiceMessage, voiceMessageFlag)
    const marker = journal.marker
    scope = Scope.makeUnsafe()
    const scoped = (operation) =>
        mode === "default" ? operation : Effect.runPromise(operation.pipe(Effect.provideService(Scope.Scope, scope)))
    // HTTP requests work without a gateway connection, so the check opens none
    bot = await scoped(sdk.createClient({ token }))

    const messageNote = sdk.voiceWaveform(syntheticSamples(messageNoteSeconds), sampleRate)
    const webhookNote = sdk.voiceWaveform(syntheticSamples(webhookNoteSeconds), sampleRate)
    assert.equal(webhookNote.waveform.length, 256)
    const voiceNote = (note, seconds) => ({
        flags: MessageFlags.VoiceMessage,
        attachments: [
            {
                data: wavFile(syntheticSamples(seconds)),
                filename: "voice-note.wav",
                contentType: "audio/wav",
                ...note,
            },
        ],
    })
    // The SDK's projection and Fluxer's stored message must both carry the flag, the duration and the waveform sent
    const assertVoiceNote = async (message, channelId, note) => {
        assert.equal(message.channelId, channelId)
        assert.equal(message.flags & MessageFlags.VoiceMessage, MessageFlags.VoiceMessage)
        assert.equal(message.content, "")
        assert.equal(message.attachments.length, 1)
        assert.equal(message.attachments[0].duration, note.duration)
        assert.equal(message.attachments[0].waveform, note.waveform)
        const raw = await api("GET", `/channels/${channelId}/messages/${message.id}`)
        assert.equal(raw.status, 200)
        assert.equal(raw.data?.flags & voiceMessageFlag, voiceMessageFlag)
        assert.equal(raw.data.content, "")
        assert.equal(raw.data.attachments?.length, 1)
        const [attachment] = raw.data.attachments
        assert.match(attachment.content_type ?? "", /^audio\//)
        assert.equal(attachment.duration, note.duration)
        assert.equal(attachment.waveform, note.waveform)
        const fetched = await value(bot.messages.fetch({ id: message.id, channelId }))
        assert.equal(fetched.flags & MessageFlags.VoiceMessage, MessageFlags.VoiceMessage)
        assert.equal(fetched.attachments[0]?.duration, note.duration)
        assert.equal(fetched.attachments[0]?.waveform, note.waveform)
        return { contentType: attachment.content_type }
    }

    stage = "create_owned_channels"
    const createChannel = (key, input) =>
        createGuildChannelFixture(journal, save, key, input, (channelInput) =>
            value(bot.channels.create(guildId, channelInput)),
        )
    const channel = await createChannel("voiceNotes", { type: ChannelType.Text })
    const forum = await createChannel("forum", { type: ChannelType.Forum, topic: "SDK voice note check" })
    report(stage)

    stage = "message_voice_note"
    const sent = await value(bot.messages.send(channel.id, voiceNote(messageNote, messageNoteSeconds)))
    const sentReadback = await assertVoiceNote(sent, channel.id, messageNote)
    report(stage, { duration: messageNote.duration, waveformLength: messageNote.waveform.length, ...sentReadback })

    stage = "forum_post_voice_note"
    const post = await value(
        bot.threads.createPost(forum.id, {
            name: `${marker}-post`,
            message: voiceNote(messageNote, messageNoteSeconds),
        }),
    )
    assert.match(post.thread.id, snowflake)
    journal.threadIds.push(post.thread.id)
    save()
    assert.equal(post.thread.parentId, forum.id)
    assert.equal(post.thread.type, ChannelType.PublicThread)
    const postReadback = await assertVoiceNote(post.message, post.thread.id, messageNote)
    report(stage, postReadback)

    stage = "webhook_create_and_local_waveform_limit"
    journal.webhook = { name: `${marker}-hook` }
    save()
    let createdHook
    try {
        createdHook = await value(bot.webhooks.create(channel.id, { name: journal.webhook.name }))
    } catch (error) {
        if (["rejected", "notDispatched"].includes(error?.outcome)) {
            journal.webhook.rejected = true
            save()
        }
        throw error
    }
    journal.webhook.id = createdHook.webhook.id
    save()
    hook = await scoped(sdk.createWebhookClient(createdHook.credentials))
    const tooLong = voiceNote({ ...webhookNote, waveform: `${webhookNote.waveform}A` }, webhookNoteSeconds)
    await assert.rejects(
        () => value(hook.send(tooLong)),
        (error) =>
            error?._tag === "WebhookOperationError" &&
            error.outcome === "notDispatched" &&
            error.inputValidation?.path === "attachments[].waveform",
    )
    report(stage)

    stage = "webhook_voice_note"
    const hookSent = await value(hook.send(voiceNote(webhookNote, webhookNoteSeconds)))
    assert.equal(hookSent.webhookId, createdHook.webhook.id)
    const hookReadback = await assertVoiceNote(hookSent, channel.id, webhookNote)
    await value(hook.delete())
    assert.equal((await api("GET", `/webhooks/${createdHook.webhook.id}`)).status, 404)
    report(stage, { duration: webhookNote.duration, waveformLength: webhookNote.waveform.length, ...hookReadback })
}

try {
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
        journal = { guildId, botId, marker: `fluxerly-voice-notes-${randomUUID().replaceAll("-", "")}`, threadIds: [] }
        journalFile.create(journal)
        const sdk = await import(mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect")
        await scenario(sdk)
    }
} catch (error) {
    // Do not emit configured IDs, markers, message bodies, raw failures or credentials
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
            apiCode: error?.apiError?.code,
            inputPath: error?.inputValidation?.path,
            journalRetained: !!journal,
        }),
    )
    process.exitCode = 1
} finally {
    // Keep the journal, lock and deadlines if a failed owned finalizer may have left a writer alive
    const quiescent = await finalizeOwned({
        writers: [
            hook && ["webhook_client_shutdown", () => value(hook.shutdown())],
            bot && ["client_shutdown", () => value(bot.shutdown())],
            scope && ["scope_close", () => Effect.runPromise(Scope.close(scope, Exit.void))],
        ],
        cleanup,
        lock,
        watchdog,
        onFailure: (finalizer) => {
            console.error(JSON.stringify({ mode, finalizer, passed: false, journalRetained: !!journal }))
            process.exitCode = 1
        },
    })
    if (quiescent) clearTimeout(deadlineTimer)
}
