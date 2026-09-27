// Public consumer features: user profiles, attachment-backed embeds, forwards, attachment metadata edits and
// suppress flags, creating only a journaled test channel and its messages.
// Journal `.env.test.consumer-features.local` records the server ID and the test channel's unique marker and returned
// ID. An existing journal is recovered before a new run: the channel is matched by its marker, deleted and its
// removal verified
import assert from "node:assert/strict"
import { Effect, Exit, Scope } from "effect"
import { createGuildChannelFixture, cleanupGuildChannelFixtures } from "./channel-fixture.mjs"
import {
    acquireLock,
    finalizeOwned,
    loadSandboxEnvironment,
    openJournal,
    verifySandboxIdentity,
} from "./support/harness.js"
import { createOutcomeReporter } from "./support/reporting.js"
import { settle as value } from "./support/results.js"
import { createRetryingSandboxApi } from "./support/sandbox-api.js"

const mode = process.argv[2]
const rawFetch = globalThis.fetch
const journalFile = openJournal("consumer-features")
const report = createOutcomeReporter({ mode })
let stage = "configuration"
let lock
let token
let guildId
let botId
let journal
let client
let scope
let verified = false

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

async function failure(operation) {
    const result = operation()
    if (Effect.isEffect(result)) return Effect.runPromise(Effect.flip(result))
    const defaultApi = await result
    assert.ok(defaultApi.isErr())
    return defaultApi.error
}

function assertFrozen(value) {
    assert.ok(Object.isFrozen(value))
}

function profileFields(wire, includeBannerColor) {
    const fields = wire ?? {}
    const projected = {
        bio: fields.bio ?? null,
        pronouns: fields.pronouns ?? null,
        banner: fields.banner ?? null,
        accentColor: fields.accent_color ?? null,
    }
    if (includeBannerColor && Object.hasOwn(fields, "banner_color")) projected.bannerColor = fields.banner_color
    return projected
}

function verifyProfile(profile, wire, contextual) {
    assert.equal(profile.user.id, botId)
    assert.equal(wire.user?.id, botId)
    assert.deepEqual(profile.profile, profileFields(wire.user_profile, true))
    assert.equal(profile.isLimited, wire.profile_limited === true)
    if (contextual) {
        if (wire.guild_member_profile === null || wire.guild_member_profile === undefined)
            assert.equal(profile.guildProfile, null)
        else assert.deepEqual(profile.guildProfile, profileFields(wire.guild_member_profile, false))
    } else assert.equal(profile.guildProfile, null)
    assertFrozen(profile)
    assertFrozen(profile.user)
    assertFrozen(profile.profile)
    if (profile.guildProfile !== null) assertFrozen(profile.guildProfile)
}

function verifyResolvedMedia(embed) {
    for (const media of [embed.image, embed.thumbnail]) {
        assert.ok(media)
        const url = new URL(media.url)
        assert.equal(url.protocol, "https:")
        assert.notEqual(url.protocol, "attachment:")
    }
}

function verifySnapshot(snapshot, source, attachment, content) {
    assert.equal(snapshot.content ?? null, content)
    assert.equal(snapshot.type, source.type)
    assert.equal(snapshot.flags, source.flags)
    assert.equal(snapshot.attachments?.length, 1)
    assert.match(snapshot.attachments?.[0]?.id ?? "", /^[1-9][0-9]*$/)
    assert.notEqual(snapshot.attachments?.[0]?.id, attachment.id)
    assert.equal(snapshot.attachments?.[0]?.filename, attachment.filename)
    assert.equal(snapshot.attachments?.[0]?.title, attachment.title)
    assert.equal(snapshot.attachments?.[0]?.description, attachment.description)
    assert.equal(snapshot.embeds?.length, 1)
    verifyResolvedMedia(snapshot.embeds?.[0])
    assertFrozen(snapshot)
    assertFrozen(snapshot.attachments)
    assertFrozen(snapshot.attachments[0])
    assertFrozen(snapshot.embeds)
    assertFrozen(snapshot.embeds[0])
    assertFrozen(snapshot.embeds[0].image)
    assertFrozen(snapshot.embeds[0].thumbnail)
}

async function verifyProfiles(ops) {
    stage = "bot_profile_without_context"
    const profile = await ops.fetchProfile(botId)
    const raw = await api("GET", `/users/${botId}/profile`)
    assert.equal(raw.status, 200)
    verifyProfile(profile, raw.data, false)
    report(stage)

    stage = "bot_profile_with_sandbox_context"
    const contextual = await ops.fetchProfile(botId, { guildId })
    const contextualRaw = await api("GET", `/users/${botId}/profile?guild_id=${guildId}`)
    assert.equal(contextualRaw.status, 200)
    verifyProfile(contextual, contextualRaw.data, true)
    report(stage, true, { providerExpiredPremiumCleanup: "possible" })
}

async function verifyConsumerMessages(ops, MessageFlags, channelId) {
    assert.equal(MessageFlags.SuppressEmbeds, 4)
    assert.equal(MessageFlags.SuppressNotifications, 4096)
    const filename = `forward-${crypto.randomUUID().replaceAll("-", "")}.png`
    const originalContent = `forward-source-${crypto.randomUUID()}`
    const initialTitle = "Forward source title"
    const initialDescription = "Forward source description"
    const image = Uint8Array.from(
        Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9YQAAAABJRU5ErkJggg==",
            "base64",
        ),
    )

    stage = "attachment_backed_image_and_thumbnail"
    const source = await ops.send(channelId, {
        content: originalContent,
        attachments: [
            { data: image, filename },
            {
                data: new TextEncoder().encode("Consumer feature attachment fixture"),
                filename: "report.txt",
                title: initialTitle,
                description: initialDescription,
            },
        ],
        embeds: [{ image: { url: `attachment://${filename}` }, thumbnail: { url: `attachment://${filename}` } }],
    })
    stage = "attachment_backed_metadata"
    assert.equal(source.attachments.length, 1)
    assert.equal(source.attachments[0]?.title, initialTitle)
    assert.equal(source.attachments[0]?.description, initialDescription)
    stage = "attachment_backed_media_resolution"
    verifyResolvedMedia(source.embeds[0])
    stage = "attachment_backed_independent_readback"
    const sourceRaw = await api("GET", `/channels/${channelId}/messages/${source.id}`)
    assert.equal(sourceRaw.status, 200)
    assert.equal(sourceRaw.data.attachments?.[0]?.id, source.attachments[0]?.id)
    assert.equal(sourceRaw.data.attachments?.[0]?.title, initialTitle)
    assert.equal(sourceRaw.data.attachments?.[0]?.description, initialDescription)
    verifyResolvedMedia(sourceRaw.data.embeds?.[0])
    report(stage)

    stage = "forward_created_snapshot"
    const forwarded = await ops.forward(channelId, { source })
    assert.equal(forwarded.messageReference?.id, source.id)
    assert.equal(forwarded.messageReference?.channelId, channelId)
    assert.equal(forwarded.messageReference?.type, 1)
    assert.equal(forwarded.messageSnapshots?.length, 1)
    assertFrozen(forwarded.messageSnapshots)
    verifySnapshot(forwarded.messageSnapshots[0], source, source.attachments[0], originalContent)
    const forwardedRaw = await api("GET", `/channels/${channelId}/messages/${forwarded.id}`)
    assert.equal(forwardedRaw.status, 200)
    assert.equal(forwardedRaw.data.message_reference?.message_id, source.id)
    assert.equal(forwardedRaw.data.message_reference?.channel_id, channelId)
    assert.equal(forwardedRaw.data.message_reference?.type, 1)
    assert.equal(forwardedRaw.data.message_snapshots?.length, 1)
    assert.equal(forwardedRaw.data.message_snapshots[0]?.content, originalContent)
    assert.match(forwardedRaw.data.message_snapshots[0]?.attachments?.[0]?.id ?? "", /^[1-9][0-9]*$/)
    assert.notEqual(forwardedRaw.data.message_snapshots[0]?.attachments?.[0]?.id, source.attachments[0].id)
    report(stage)

    stage = "forward_selected_media_snapshot"
    const selected = await ops.forward(channelId, {
        source,
        attachmentIds: [source.attachments[0].id],
        embedIndices: [0],
    })
    assert.equal(selected.messageReference?.id, source.id)
    assert.equal(selected.messageReference?.channelId, channelId)
    assert.equal(selected.messageReference?.type, 1)
    assert.equal(selected.messageSnapshots?.length, 1)
    assertFrozen(selected.messageSnapshots)
    verifySnapshot(selected.messageSnapshots[0], source, source.attachments[0], null)
    const selectedRaw = await api("GET", `/channels/${channelId}/messages/${selected.id}`)
    assert.equal(selectedRaw.status, 200)
    assert.equal(selectedRaw.data.message_reference?.message_id, source.id)
    assert.equal(selectedRaw.data.message_reference?.type, 1)
    assert.equal(selectedRaw.data.message_snapshots?.[0]?.content ?? null, null)
    assert.equal(selected.messageSnapshots[0].content, selectedRaw.data.message_snapshots[0].content)
    assert.match(selectedRaw.data.message_snapshots?.[0]?.attachments?.[0]?.id ?? "", /^[1-9][0-9]*$/)
    assert.notEqual(selectedRaw.data.message_snapshots?.[0]?.attachments?.[0]?.id, source.attachments[0].id)
    report(stage)

    stage = "retained_attachment_metadata_change"
    const changedTitle = "Forward source title changed"
    const changedDescription = "Forward source description changed"
    const changed = await ops.edit(source, {
        content: `${originalContent}-changed`,
        attachments: [{ id: source.attachments[0].id, title: changedTitle, description: changedDescription }],
    })
    assert.equal(changed.attachments[0]?.id, source.attachments[0].id)
    assert.equal(changed.attachments[0]?.title, changedTitle)
    assert.equal(changed.attachments[0]?.description, changedDescription)
    const changedRaw = await api("GET", `/channels/${channelId}/messages/${source.id}`)
    assert.equal(changedRaw.data.content, `${originalContent}-changed`)
    assert.equal(changedRaw.data.attachments?.[0]?.title, changedTitle)
    assert.equal(changedRaw.data.attachments?.[0]?.description, changedDescription)
    report(stage)

    stage = "retained_attachment_metadata_clear"
    const cleared = await ops.edit(changed, {
        attachments: [{ id: source.attachments[0].id, title: null, description: null }],
    })
    assert.equal(cleared.attachments[0]?.id, source.attachments[0].id)
    assert.equal(cleared.attachments[0]?.title, undefined)
    assert.equal(cleared.attachments[0]?.description, undefined)
    const clearedRaw = await api("GET", `/channels/${channelId}/messages/${source.id}`)
    assert.equal(clearedRaw.data.attachments?.[0]?.title ?? undefined, undefined)
    assert.equal(clearedRaw.data.attachments?.[0]?.description ?? undefined, undefined)
    const immutableForward = await ops.fetch(forwarded)
    verifySnapshot(immutableForward.messageSnapshots?.[0], source, source.attachments[0], originalContent)
    const immutableSelectedForward = await ops.fetch(selected)
    verifySnapshot(immutableSelectedForward.messageSnapshots?.[0], source, source.attachments[0], null)
    report(stage)

    stage = "suppress_flags_create"
    const flags = await ops.send(channelId, {
        content: `suppressed-${crypto.randomUUID()}`,
        flags: MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications,
    })
    assert.equal(flags.flags & (MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications), 4100)
    const flagsRaw = await api("GET", `/channels/${channelId}/messages/${flags.id}`)
    assert.equal(flagsRaw.data.flags & (MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications), 4100)
    report(stage)

    stage = "suppress_embeds_flag_edit"
    const embedsSuppressed = await ops.edit(flags, { flags: MessageFlags.SuppressEmbeds })
    assert.equal(embedsSuppressed.flags & (MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications), 4)
    const embedsSuppressedRaw = await api("GET", `/channels/${channelId}/messages/${flags.id}`)
    assert.equal(embedsSuppressedRaw.data.flags & (MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications), 4)
    report(stage)

    stage = "forward_input_rejected_without_dispatch"
    let requests = 0
    globalThis.fetch = async (...args) => {
        requests++
        return rawFetch(...args)
    }
    try {
        const rejected = await failure(() => ops.forwardFailure(channelId, { source, attachmentIds: ["invalid"] }))
        assert.equal(rejected?._tag, "MessageError")
        assert.equal(rejected?.reason, "input")
        assert.equal(rejected?.outcome, "notDispatched")
    } finally {
        globalThis.fetch = rawFetch
    }
    assert.equal(requests, 0)
    report(stage)

    stage = "lost_suppress_flags_edit_reconciled"
    let dispatched = 0
    globalThis.fetch = async (url, init) => {
        const response = await rawFetch(url, init)
        if (init?.method === "PATCH" && new URL(url).pathname === `/v1/channels/${channelId}/messages/${flags.id}`) {
            dispatched++
            assert.equal(response.status, 200)
            await response.arrayBuffer()
            throw new TypeError("Test-owned response loss")
        }
        return response
    }
    try {
        const lost = await failure(() => ops.editFailure(flags, { flags: 0 }))
        assert.equal(lost?._tag, "MessageOperationError")
        assert.equal(lost?.operation, "edit")
        assert.equal(lost?.outcome, "unknown")
    } finally {
        globalThis.fetch = rawFetch
    }
    assert.equal(dispatched, 1)
    const reconciled = await api("GET", `/channels/${channelId}/messages/${flags.id}`)
    assert.equal(reconciled.status, 200)
    assert.equal(reconciled.data.flags & (MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications), 0)
    report(stage)
}

// A watchdog is failure containment only. A passing invocation exits naturally after verified cleanup
setTimeout(() => {
    report("process_timeout", false)
    process.exit(1)
}, 180_000).unref()

try {
    assert.ok(mode === "default" || mode === "effect")
    assert.equal(process.argv.length, 3)
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
        await cleanup()
    }
    journal = { guildId }
    journalFile.create(journal)
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

    const sdk = await import(mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect")
    if (mode === "default") client = sdk.createClient({ token })
    else {
        scope = Scope.makeUnsafe()
        client = await Effect.runPromise(sdk.createClient({ token }).pipe(Effect.provideService(Scope.Scope, scope)))
    }
    await verifyProfiles({ fetchProfile: (id, query) => value(client.users.fetchProfile(id, query)) })
    await verifyConsumerMessages(
        {
            send: (id, input) => value(client.messages.send(id, input)),
            forward: (id, input) => value(client.messages.forward(id, input)),
            forwardFailure: (id, input) => client.messages.forward(id, input),
            edit: (target, input) => value(client.messages.edit(target, input)),
            editFailure: (target, input) => client.messages.edit(target, input),
            fetch: (target) => value(client.messages.fetch(target)),
        },
        sdk.MessageFlags,
        channel.id,
    )
    stage = "client_shutdown"
    await value(client.shutdown())
    report(stage)
} catch (error) {
    report(stage, false, {
        ...(error?.code === "ERR_ASSERTION"
            ? { assertionLine: Number(error.stack?.match(/consumer-features\.js:(\d+):\d+/)?.[1]) || undefined }
            : {}),
        ...(typeof error?.status === "number" ? { httpStatus: error.status } : {}),
        ...(["MessageError", "MessageOperationError", "UserOperationError", "ClientClosedError"].includes(error?._tag)
            ? { category: error._tag, reason: error.reason, outcome: error.outcome }
            : { category: error?.code === "ERR_ASSERTION" ? "assertion" : "unexpected" }),
    })
    process.exitCode = 1
} finally {
    globalThis.fetch = rawFetch
    // Keep the journal and lock if a failed owned finalizer may have left a writer alive
    await finalizeOwned({
        writers: [
            client && client.state !== "Closed" && ["client_shutdown", () => value(client.shutdown())],
            scope && ["scope_close", () => Effect.runPromise(Scope.close(scope, Exit.void))],
        ],
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
