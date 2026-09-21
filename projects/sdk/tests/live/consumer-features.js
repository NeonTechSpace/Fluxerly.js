import assert from "node:assert/strict"
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { parseEnv } from "node:util"
import { Effect, Exit, Scope } from "effect"
import { createGuildChannelFixture, cleanupGuildChannelFixtures } from "./channel-fixture.mjs"

// Opt-in coverage for public consumer features that create only a journaled test channel and its messages
const mode = process.argv[2]
const rawFetch = globalThis.fetch
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const journalPath = new URL("../../.env.test.consumer-features.local", import.meta.url)
const report = (check, passed = true, details = {}) => console.log(JSON.stringify({ mode, check, passed, ...details }))
let stage = "configuration"
let lock
let token
let guildId
let botId
let journal
let client
let scope
let verified = false

async function api(method, path, body) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const response = await rawFetch(`https://api.fluxer.app/v1${path}`, {
            method,
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
            headers: {
                Authorization: `Bot ${token}`,
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        const data = response.status === 204 ? null : await response.json().catch(() => null)
        if (response.status === 429 && attempt < 2) {
            const delay =
                Math.max(Number(response.headers.get("retry-after")) || 0, Number(data?.retry_after) || 0) * 1_000
            assert.ok(Number.isFinite(delay) && delay > 0 && delay <= 10_000)
            await sleep(delay)
            continue
        }
        if (!response.ok && response.status !== 404)
            throw Object.assign(new Error("Sandbox HTTP request failed"), { status: response.status })
        return { status: response.status, data }
    }
    throw new Error("Sandbox HTTP request budget exhausted")
}

const save = () => writeFileSync(journalPath, JSON.stringify(journal))

async function cleanup() {
    if (!journal) return
    assert.equal(journal.guildId, guildId)
    await cleanupGuildChannelFixtures(api, journal, save)
    unlinkSync(journalPath)
    journal = undefined
    report("test_channel_and_messages_removed")
}

async function value(operation) {
    if (Effect.isEffect(operation)) {
        const result = await Effect.runPromise(Effect.result(operation))
        if (result._tag === "Failure") throw result.failure
        return result.success
    }
    const result = await operation
    if (result.isErr()) throw result.error
    return result.value
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
        assert.equal(rejected?.delivery, "notSent")
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
    lock = openSync(lockPath, "wx")
    writeSync(lock, String(process.pid))
    stage = "configuration"
    const env = parseEnv(readFileSync(new URL("../../.env.test.local", import.meta.url), "utf8"))
    token = env.FLUXER_TEST_BOT_TOKEN
    guildId = env.FLUXER_TEST_GUILD_ID
    const applicationId = env.FLUXER_TEST_APPLICATION_ID
    assert.ok(token && token === token.trim())
    assert.match(guildId ?? "", /^[1-9][0-9]*$/)
    assert.match(applicationId ?? "", /^[1-9][0-9]*$/)

    stage = "sandbox_identity"
    const application = await api("GET", "/oauth2/applications/@me")
    const bot = await api("GET", "/users/@me")
    const guild = await api("GET", `/guilds/${guildId}`)
    assert.equal(application.status, 200)
    assert.equal(application.data?.id, applicationId)
    assert.equal(bot.status, 200)
    assert.equal(bot.data?.bot, true)
    assert.match(bot.data?.id ?? "", /^[1-9][0-9]*$/)
    assert.equal(application.data?.bot?.id, bot.data.id)
    assert.equal(guild.status, 200)
    assert.equal(guild.data?.id, guildId)
    botId = bot.data.id
    verified = true
    report(stage, true, { clientSecretUsed: false })

    stage = "recover_prior_test"
    if (existsSync(journalPath)) {
        journal = JSON.parse(readFileSync(journalPath, "utf8"))
        await cleanup()
    }
    journal = { guildId }
    writeFileSync(journalPath, JSON.stringify(journal), { flag: "wx" })
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
    if (mode === "default") {
        const created = sdk.createClient({ token })
        assert.ok(created.isOk())
        client = created.value
    } else {
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
            ? { category: error._tag, reason: error.reason, outcome: error.outcome ?? error.delivery }
            : { category: error?.code === "ERR_ASSERTION" ? "assertion" : "unexpected" }),
    })
    process.exitCode = 1
} finally {
    globalThis.fetch = rawFetch
    let quiescent = true
    const retainEvidence = (finalizer) => {
        quiescent = false
        report("cleanup", false, {
            finalizer,
            journalRetained: journal !== undefined,
            lockRetained: lock !== undefined,
        })
        process.exitCode = 1
    }
    if (client && client.state !== "Closed")
        try {
            await value(client.shutdown())
        } catch {
            retainEvidence("client_shutdown")
        }
    if (scope)
        try {
            await Effect.runPromise(Scope.close(scope, Exit.void))
        } catch {
            retainEvidence("scope_close")
        }
    if (quiescent)
        try {
            if (verified && journal) await cleanup()
        } catch {
            report("cleanup", false, { journalRetained: journal !== undefined })
            process.exitCode = 1
        }
    if (quiescent && lock !== undefined) {
        try {
            closeSync(lock)
            unlinkSync(lockPath)
        } catch {
            report("lock_cleanup", false, { lockRetained: true })
            process.exitCode = 1
        }
    }
}
