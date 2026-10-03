// Announcement creation, following, publishing, conversion, rejection and lost-response reconciliation.
// Journal `.env.test.announcements.local` records sandbox and bot identity, channel name markers and IDs, and
// follower webhook IDs, never tokens or message bodies. An existing journal triggers recovery only: reconcile
// channels by their markers, remove followers only in those owned channels, then verify channel removal
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { Effect, Exit, Scope } from "effect"
import {
    acquireLock,
    finalizeOwned,
    loadSandboxEnvironment,
    openJournal,
    snowflake,
    verifySandboxIdentity,
} from "./support/harness.js"
import { createReporter } from "./support/reporting.js"
import { settle as value } from "./support/results.js"
import { createSandboxApi, successOrNotFound } from "./support/sandbox-api.js"

const mode = process.argv[2]
assert.ok(mode === "default" || mode === "effect")
const rawFetch = globalThis.fetch
const journalFile = openJournal("announcements")
const report = createReporter({ mode }, { passed: true })
let lock, journal, bot, scope, token, guildId, botId
let verified = false
let stage = "configuration"
const save = () => journalFile.save(journal)
const api = createSandboxApi({ fetch: rawFetch, token: () => token, accept: successOrNotFound })

async function cleanup() {
    if (!verified || !journal) return
    assert.equal(journal.guildId, guildId)
    assert.equal(journal.botId, botId)
    assert.match(journal.marker, /^fluxerly-ann-[a-f0-9]{32}$/)
    assert.ok(Array.isArray(journal.channels) && journal.channels.length <= 3)
    const inventory = (await api("GET", `/guilds/${guildId}/channels`)).data
    assert.ok(Array.isArray(inventory))
    const owned = []
    for (const entry of journal.channels) {
        assert.ok(["a", "b", "c"].some((suffix) => entry.name === `${journal.marker}-${suffix}`))
        const matches = inventory.filter((item) => item.id === entry.id || item.name === entry.name)
        assert.ok(matches.length <= 1)
        if (!matches.length) {
            assert.ok(entry.id || entry.rejected, "Unresolved channel creation")
            if (entry.id) assert.equal((await api("GET", `/channels/${entry.id}`)).status, 404)
            continue
        }
        const channel = matches[0]
        assert.equal(channel.guild_id, guildId)
        assert.equal(channel.name, entry.name)
        entry.id = channel.id
        owned.push(entry)
        save()
    }
    // Every destination is an owned channel, so its follower inventory can reconcile a lost follow response
    for (const entry of owned) {
        const hooks = (await api("GET", `/channels/${entry.id}/webhooks`)).data
        assert.ok(Array.isArray(hooks))
        for (const hook of hooks) {
            assert.equal(hook.type, 2)
            assert.equal(hook.guild_id, guildId)
            assert.equal(hook.channel_id, entry.id)
            if (hook.user) assert.equal(hook.user.id, botId)
            if (hook.source_channel) assert.equal(hook.source_channel.id, journal.channels[0].id)
            if (hook.source_guild) assert.equal(hook.source_guild.id, guildId)
            await api("DELETE", `/webhooks/${hook.id}`)
            assert.equal((await api("GET", `/webhooks/${hook.id}`)).status, 404)
        }
        assert.equal((await api("GET", `/channels/${entry.id}/webhooks`)).data.length, 0)
    }
    for (const entry of owned) {
        await api("DELETE", `/channels/${entry.id}`)
        assert.equal((await api("GET", `/channels/${entry.id}`)).status, 404)
    }
    journalFile.remove()
    journal = undefined
    report("followers_and_channels_cleanup_verified")
}

const watchdog = setTimeout(() => {
    console.error(JSON.stringify({ mode, stage, passed: false, reason: "deadline", journalRetained: true }))
    process.exit(1)
}, 300_000).unref()

async function scenario(sdk) {
    scope = Scope.makeUnsafe()
    bot = await (mode === "default"
        ? sdk.createClient({ token })
        : Effect.runPromise(sdk.createClient({ token }).pipe(Effect.provideService(Scope.Scope, scope))))
    const events = { guildChannelCreate: [], guildChannelUpdate: [], messageCreate: [] }
    let overflow = false
    for (const [event, observations] of Object.entries(events)) {
        const observe = (item) => {
            if (!journal.channels.some((entry) => entry.id === (item.channelId ?? item.id) || entry.name === item.name))
                return
            if (observations.length >= 24) overflow = true
            else observations.push(item)
        }
        if (mode === "default") bot.on(event, observe)
        else
            await Effect.runPromise(
                bot
                    .on(event, (item) => Effect.sync(() => observe(item)))
                    .pipe(Effect.provideService(Scope.Scope, scope)),
            )
    }
    const waitFor = async (event, predicate, timeoutMs, required = true) => {
        const until = Date.now() + timeoutMs
        let found
        while (!(found = events[event].find(predicate)) && !overflow && Date.now() < until) await sleep(25)
        assert.equal(overflow, false, "Owned event observation overflow")
        if (required) assert.ok(found, `Missing ${event} observation`)
        return found
    }
    await value(bot.connect())
    for (const [suffix, type] of [
        ["a", sdk.ChannelType.Announcement],
        ["b", sdk.ChannelType.Text],
        ["c", sdk.ChannelType.Text],
    ]) {
        stage = `create_${suffix}`
        const entry = { name: `${journal.marker}-${suffix}` }
        journal.channels.push(entry)
        save()
        let created
        try {
            created = await value(bot.channels.create(guildId, { name: entry.name, type }))
        } catch (error) {
            if (["rejected", "notDispatched"].includes(error?.outcome)) {
                entry.rejected = true
                save()
            }
            throw error
        }
        entry.id = created.id
        save()
        assert.equal(created.guildId, guildId)
        assert.equal(created.type, type)
        assert.equal((await value(bot.channels.fetch(created.id))).type, type)
        assert.equal((await waitFor("guildChannelCreate", (item) => item.id === created.id, 30_000)).type, type)
        report(stage, { restAndGateway: true })
    }
    const [a, b, c] = journal.channels
    stage = "follow_and_follower_webhook"
    const followed = await value(bot.channels.follow(a.id, { targetChannelId: b.id }))
    journal.webhookIds = [followed.webhookId]
    save()
    assert.equal(followed.channelId, a.id)
    assert.match(followed.webhookId, snowflake)
    const follower = (await value(bot.webhooks.fetchForChannel(b.id))).find((item) => item.id === followed.webhookId)
    assert.ok(follower)
    assert.equal(follower.type, sdk.WebhookType.ChannelFollower)
    assert.equal(follower.guildId, guildId)
    assert.equal(follower.channelId, b.id)
    assert.equal(Object.hasOwn(follower, "token"), false)
    if (follower.sourceGuild) assert.equal(follower.sourceGuild.id, guildId)
    if (follower.sourceChannel) assert.equal(follower.sourceChannel.id, a.id)
    report(stage, { sourceGuildPresent: !!follower.sourceGuild, sourceChannelPresent: !!follower.sourceChannel })

    stage = "follow_notice_idless_reference"
    const notice = await waitFor(
        "messageCreate",
        (item) => item.channelId === b.id && item.type === sdk.MessageType.ChannelFollowAdd,
        30_000,
        false,
    )
    const checkNotice = (item) => {
        assert.equal(item.type, sdk.MessageType.ChannelFollowAdd)
        assert.equal(item.messageReference?.channelId, a.id)
        assert.equal(item.messageReference?.id, undefined)
    }
    if (notice) checkNotice(notice)
    report(stage, { observed: !!notice, observation: notice ? "decoded" : "bounded_notice_absence" })

    stage = "follower_stats"
    const stats = await value(bot.channels.fetchFollowerStats(a.id))
    for (const count of [stats.channelCount, stats.guildCount]) assert.ok(Number.isSafeInteger(count) && count >= 0)
    report(stage, { channelCount: stats.channelCount, guildCount: stats.guildCount })

    stage = "publish_and_crosspost_copy"
    const source = await value(bot.messages.send(a.id, { content: "SDK announcement fixture" }))
    const published = await value(bot.messages.publish(source))
    assert.equal(published.id, source.id)
    assert.equal(published.channelId, a.id)
    assert.equal(published.flags & sdk.MessageFlags.Crossposted, sdk.MessageFlags.Crossposted)
    const copy = await waitFor(
        "messageCreate",
        (item) => item.channelId === b.id && item.messageReference?.id === source.id,
        60_000,
    )
    assert.equal(copy.flags & sdk.MessageFlags.IsCrosspost, sdk.MessageFlags.IsCrosspost)
    assert.equal(copy.messageReference.channelId, a.id)
    assert.equal(copy.messageReference.guildId, guildId)
    const history = await value(bot.messages.fetchHistory(b.id, { limit: 100 }))
    const historyCopy = history.find((item) => item.id === copy.id)
    assert.ok(historyCopy)
    assert.equal(historyCopy.flags & sdk.MessageFlags.IsCrosspost, sdk.MessageFlags.IsCrosspost)
    assert.equal(historyCopy.messageReference?.id, source.id)
    if (notice) {
        const historyNotice = history.find((item) => item.id === notice.id)
        assert.ok(historyNotice)
        checkNotice(historyNotice)
    }
    assert.equal((await value(bot.messages.fetchCrosspostSource(copy))).guild.id, guildId)
    report(stage, { historyDecoded: true, sourceGuildVerified: true })

    stage = "conversion_to_announcement"
    assert.equal(
        (await value(bot.channels.edit(c.id, { type: sdk.ChannelType.Announcement }))).type,
        sdk.ChannelType.Announcement,
    )
    assert.equal((await value(bot.channels.fetch(c.id))).type, sdk.ChannelType.Announcement)
    await waitFor(
        "guildChannelUpdate",
        (item) => item.id === c.id && item.type === sdk.ChannelType.Announcement,
        30_000,
    )
    report(stage)

    stage = "invalid_follow_target_rejected"
    await assert.rejects(
        () => value(bot.channels.follow(a.id, { targetChannelId: c.id })),
        (error) => {
            report("invalid_follow_target_outcome", {
                passed:
                    error?._tag === "ChannelOperationError" &&
                    error.outcome === "rejected" &&
                    error.apiError?.code === "invalidFollowTargetChannel" &&
                    error.apiError.providerCode === "INVALID_FOLLOW_TARGET_CHANNEL",
                category: error?._tag,
                reason: error?.reason,
                outcome: error?.outcome,
                status: error?.status,
                providerCode: error?.apiError?.providerCode,
                apiCode: error?.apiError?.code,
            })
            return (
                error?._tag === "ChannelOperationError" &&
                error.outcome === "rejected" &&
                error.apiError?.code === "invalidFollowTargetChannel" &&
                error.apiError.providerCode === "INVALID_FOLLOW_TARGET_CHANNEL"
            )
        },
    )
    assert.equal((await value(bot.webhooks.fetchForChannel(c.id))).length, 0)
    report(stage, { providerCode: "INVALID_FOLLOW_TARGET_CHANNEL", noWebhookCreated: true })

    stage = "conversion_back_to_text"
    assert.equal((await value(bot.channels.edit(c.id, { type: sdk.ChannelType.Text }))).type, sdk.ChannelType.Text)
    assert.equal((await value(bot.channels.fetch(c.id))).type, sdk.ChannelType.Text)
    await waitFor("guildChannelUpdate", (item) => item.id === c.id && item.type === sdk.ChannelType.Text, 30_000)
    report(stage)

    stage = "lost_follow_response_reconciliation"
    let attempts = 0
    globalThis.fetch = async (url, init) => {
        if (init?.method === "POST" && new URL(String(url)).pathname === `/v1/channels/${a.id}/followers`) {
            attempts++
            const response = await rawFetch(url, init)
            assert.ok(response.ok)
            await response.body?.cancel()
            throw new Error("Test-owned follow response loss")
        }
        return rawFetch(url, init)
    }
    try {
        await assert.rejects(
            () => value(bot.channels.follow(a.id, { targetChannelId: c.id })),
            (error) =>
                error?._tag === "ChannelOperationError" && error.reason === "network" && error.outcome === "unknown",
        )
    } finally {
        globalThis.fetch = rawFetch
    }
    assert.equal(attempts, 1)
    const reconciled = await value(bot.webhooks.fetchForChannel(c.id))
    assert.equal(reconciled.length, 1)
    assert.equal(reconciled[0].type, sdk.WebhookType.ChannelFollower)
    if (reconciled[0].sourceChannel) assert.equal(reconciled[0].sourceChannel.id, a.id)
    journal.webhookIds.push(reconciled[0].id)
    save()
    report(stage, { attempts, inventoryMatches: reconciled.length })

    stage = "unfollow_verified"
    for (const [channel, webhookId] of [
        [b, followed.webhookId],
        [c, reconciled[0].id],
    ]) {
        await value(bot.webhooks.delete(webhookId))
        assert.ok(!(await value(bot.webhooks.fetchForChannel(channel.id))).some((item) => item.id === webhookId))
        assert.equal((await api("GET", `/webhooks/${webhookId}`)).status, 404)
    }
    report(stage)
}

try {
    lock = acquireLock()
    const sandbox = loadSandboxEnvironment()
    token = sandbox.token
    guildId = sandbox.guildId
    stage = "sandbox_identity"
    botId = (await verifySandboxIdentity(async (path) => (await api("GET", path)).data, sandbox)).botId
    verified = true
    report(stage)
    if (journalFile.exists()) {
        journal = journalFile.read()
        stage = "recovery_only"
        await cleanup()
        report(stage)
    } else {
        journal = { guildId, botId, marker: `fluxerly-ann-${randomUUID().replaceAll("-", "")}`, channels: [] }
        journalFile.create(journal)
        const sdk = await import(mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect")
        await scenario(sdk)
    }
} catch (error) {
    console.error(
        JSON.stringify({
            mode,
            stage,
            passed: false,
            category: error?._tag ?? (error?.code === "ERR_ASSERTION" ? "assertion" : "check"),
            reason: error?.reason,
            outcome: error?.outcome,
            status: error?.status,
            providerCode: error?.apiError?.providerCode,
            apiCode: error?.apiError?.code,
            safetyCheck: error?.check,
            field: error?._tag === "ConfigurationError" ? error.field : undefined,
        }),
    )
    process.exitCode = 1
} finally {
    globalThis.fetch = rawFetch
    await finalizeOwned({
        writers: [
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
}
