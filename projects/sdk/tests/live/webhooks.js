// Webhook lifecycle: creation, token and bot reads, edits and moves, messages with files, replies, forwards, permission
// errors, a lost send response recovered by resending its nonce and revocation, in two test-owned channels.
// Journal `.env.test.webhooks.local` records sandbox and bot identity, a unique marker, the channel and webhook IDs
// and names, never webhook tokens. An existing journal triggers recovery only: Webhook creator and destination
// are verified against the designated bot and owned channels before deletion, then the channels are removed
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { inspect } from "node:util"
import { Effect, Scope, Exit } from "effect"
import {
    acquireLock,
    finalizeOwned,
    loadSandboxEnvironment,
    openJournal,
    verifySandboxIdentity,
} from "./support/harness.js"
import { createReporter } from "./support/reporting.js"
import { settle as value } from "./support/results.js"
import { createSandboxApi, successOrNotFound } from "./support/sandbox-api.js"

const mode = process.argv[2]
assert.ok(mode === "default" || mode === "effect")
const rawFetch = globalThis.fetch
const journalFile = openJournal("webhooks")
let lock, journal, bot, hook, scope, token, guildId, botId
let stage = "configuration",
    verified = false
const report = createReporter({ mode }, { passed: true })
const save = () => journalFile.save(journal)
const api = createSandboxApi({ fetch: rawFetch, token: () => token, accept: successOrNotFound })
async function cleanup() {
    if (!verified || !journal) return
    assert.equal(journal.guildId, guildId)
    assert.equal(journal.botId, botId)
    assert.match(journal.marker, /^fluxerly-wh-[a-f0-9]{32}$/)
    const hooks = await api("GET", `/guilds/${guildId}/webhooks`)
    assert.ok(Array.isArray(hooks.data))
    for (const item of hooks.data.filter(
        (item) =>
            item.id === journal.webhookId ||
            [journal.marker, `${journal.marker}-token`, `${journal.marker}-edited`].includes(item.name),
    )) {
        assert.ok([journal.marker, `${journal.marker}-token`, `${journal.marker}-edited`].includes(item.name))
        assert.equal(item.user?.id, botId)
        assert.equal(item.guild_id, guildId)
        assert.ok(journal.channels.some((channel) => channel.id === item.channel_id))
        journal.webhookId = item.id
        journal.webhookPending = false
        save()
        await api("DELETE", `/webhooks/${item.id}`)
        assert.equal((await api("GET", `/webhooks/${item.id}`)).status, 404)
    }
    const after = await api("GET", `/guilds/${guildId}/webhooks`)
    assert.ok(!journal.webhookPending || journal.webhookId, "Unresolved webhook creation, retain journal")
    assert.ok(
        !after.data.some(
            (item) =>
                item.id === journal.webhookId ||
                item.name === journal.marker ||
                item.name === `${journal.marker}-token` ||
                item.name === `${journal.marker}-edited`,
        ),
    )
    const channels = await api("GET", `/guilds/${guildId}/channels`)
    assert.ok(Array.isArray(channels.data))
    for (const entry of journal.channels) {
        assert.ok([`${journal.marker}-a`, `${journal.marker}-b`].includes(entry.name))
        const matches = channels.data.filter((item) => item.id === entry.id || item.name === entry.name)
        assert.ok(matches.length <= 1)
        if (!matches.length) {
            assert.ok(entry.id, "Unresolved channel creation, retain journal")
            assert.equal((await api("GET", `/channels/${entry.id}`)).status, 404)
            continue
        }
        const item = matches[0]
        assert.equal(item.name, entry.name)
        assert.equal(item.guild_id, guildId)
        await api("DELETE", `/channels/${item.id}`)
        assert.equal((await api("GET", `/channels/${item.id}`)).status, 404)
    }
    journalFile.remove()
    journal = undefined
    report("webhook_and_channels_cleanup_verified")
}
// Local checks of the deadline path can shorten the three-minute deadline, never extend it
const watchdogOverride = Number(process.env.FLUXERLY_LIVE_WATCHDOG_MS)
const watchdogMs =
    Number.isSafeInteger(watchdogOverride) && watchdogOverride > 0 && watchdogOverride < 180_000
        ? watchdogOverride
        : 180_000
const watchdog = setTimeout(() => {
    console.error(JSON.stringify({ mode, stage, passed: false, reason: "deadline", journalRetained: true }))
    process.exit(1)
}, watchdogMs).unref()
try {
    lock = acquireLock()
    const sandbox = loadSandboxEnvironment()
    token = sandbox.token
    guildId = sandbox.guildId
    stage = "sandbox_identity"
    const identity = await verifySandboxIdentity(async (path) => (await api("GET", path)).data, sandbox)
    botId = identity.botId
    verified = true
    report(stage)
    if (journalFile.exists()) {
        journal = journalFile.read()
        stage = "recovery_only"
        await cleanup()
        report(stage)
    } else {
        journal = { guildId, botId, marker: `fluxerly-wh-${randomUUID().replaceAll("-", "")}`, channels: [] }
        journalFile.create(journal)
        stage = "create_owned_channels"
        for (const suffix of ["a", "b"]) {
            const entry = { name: `${journal.marker}-${suffix}` }
            journal.channels.push(entry)
            save()
            const channel = (await api("POST", `/guilds/${guildId}/channels`, { name: entry.name, type: 0 })).data
            assert.equal(channel.guild_id, guildId)
            assert.equal(channel.name, entry.name)
            entry.id = channel.id
            save()
        }
        const sdk = await import(mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect")
        scope = Scope.makeUnsafe()
        const create = (operation) =>
            mode === "default"
                ? operation
                : Effect.runPromise(operation.pipe(Effect.provideService(Scope.Scope, scope)))
        bot = await create(sdk.createClient({ token, cache: { messages: true } }))
        const webhookUpdates = []
        let observationOverflow
        const observeWebhookUpdate = (update) => {
            if (
                update.guildId !== journal.guildId ||
                !journal.channels.some((channel) => channel.id === update.channelId)
            )
                return
            // Create, edit, the move (one update per channel) and the delete each send one update
            if (webhookUpdates.length === 5) {
                observationOverflow ??= "Webhook update observation overflow"
                return
            }
            webhookUpdates.push(update.channelId)
        }
        if (mode === "default") bot.on("webhooksUpdate", observeWebhookUpdate)
        else
            await Effect.runPromise(
                bot
                    .on("webhooksUpdate", (update) => Effect.sync(() => observeWebhookUpdate(update)))
                    .pipe(Effect.provideService(Scope.Scope, scope)),
            )
        await value(bot.connect())
        const waitWebhookUpdate = async (channelId) => {
            const until = Date.now() + 10_000
            while (!webhookUpdates.includes(channelId) && !observationOverflow && Date.now() < until)
                await new Promise((resolve) => setTimeout(resolve, 25))
            assert.equal(observationOverflow, undefined, observationOverflow)
            assert.ok(webhookUpdates.includes(channelId))
        }
        stage = "webhook_create"
        journal.webhookPending = true
        save()
        const created = await value(
            bot.webhooks.create(
                journal.channels[0].id,
                { name: journal.marker },
                { auditReason: "SDK webhook verification" },
            ),
        )
        journal.webhookId = created.webhook.id
        journal.webhookPending = false
        save()
        assert.equal(created.webhook.guildId, guildId)
        assert.equal(created.webhook.channelId, journal.channels[0].id)
        await waitWebhookUpdate(journal.channels[0].id)
        const credential = created.credentials.revealToken()
        assert.ok(!JSON.stringify(created).includes(credential) && !inspect(created).includes(credential))
        hook = await create(sdk.createWebhookClient(created.credentials))
        report(stage)
        stage = "webhook_read_edit_move"
        const tokenSnapshot = await value(hook.fetch())
        assert.equal(tokenSnapshot.id, created.webhook.id)
        assert.ok(!JSON.stringify(tokenSnapshot).includes(credential) && !inspect(tokenSnapshot).includes(credential))
        await value(hook.edit({ name: `${journal.marker}-token`, avatar: null }))
        assert.equal((await api("GET", `/webhooks/${created.webhook.id}`)).data.name, `${journal.marker}-token`)
        assert.equal((await value(bot.webhooks.fetch(created.webhook.id))).id, created.webhook.id)
        assert.ok(
            (await value(bot.webhooks.fetchForChannel(journal.channels[0].id))).some(
                (item) => item.id === created.webhook.id,
            ),
        )
        assert.ok((await value(bot.webhooks.fetchForGuild(guildId))).some((item) => item.id === created.webhook.id))
        await value(
            bot.webhooks.edit(created.webhook.id, {
                name: `${journal.marker}-edited`,
                avatar: null,
                channelId: journal.channels[1].id,
            }),
        )
        const remote = (await api("GET", `/webhooks/${created.webhook.id}`)).data
        assert.equal(remote.name, `${journal.marker}-edited`)
        assert.equal(remote.channel_id, journal.channels[1].id)
        report(stage)
        stage = "webhook_message_and_files"
        const seen = new Map()
        const observe = (message) => {
            if (message.channelId === journal.channels[1].id)
                seen.set(message.id, { webhookId: message.webhookId, content: message.content })
        }
        for (const event of ["messageCreate", "messageUpdate"]) {
            if (mode === "default") bot.on(event, observe)
            else
                await Effect.runPromise(
                    bot
                        .on(event, (message) => Effect.sync(() => observe(message)))
                        .pipe(Effect.provideService(Scope.Scope, scope)),
                )
        }
        const waitObserved = async (id, content) => {
            const until = Date.now() + 10_000
            while (seen.get(id)?.content !== content && Date.now() < until)
                await new Promise((resolve) => setTimeout(resolve, 25))
            assert.deepEqual(seen.get(id), { webhookId: created.webhook.id, content })
            const cached =
                mode === "default"
                    ? bot.messages.get({ id, channelId: journal.channels[1].id })
                    : await Effect.runPromise(bot.messages.get({ id, channelId: journal.channels[1].id }))
            assert.equal(cached.webhookId, created.webhook.id)
            assert.equal(cached.content, content)
        }
        const sent = await value(
            hook.send({
                content: "SDK webhook check",
                flags: 4096,
                username: "SDK webhook fixture",
                embeds: [{ title: "Verification" }],
                attachments: [{ filename: "check.txt", data: new TextEncoder().encode("webhook fixture bytes") }],
            }),
        )
        assert.equal(sent.channelId, journal.channels[1].id)
        assert.equal(sent.webhookId, created.webhook.id)
        assert.equal(sent.flags & 4100, 4096)
        assert.equal((await api("GET", `/channels/${sent.channelId}/messages/${sent.id}`)).data.flags & 4100, 4096)
        await waitObserved(sent.id, "SDK webhook check")
        assert.equal(sent.author.username, "SDK webhook fixture")
        assert.equal(sent.embeds[0]?.title, "Verification")
        assert.equal(sent.attachments.length, 1)
        const attachmentUrl = new URL(sent.attachments[0].url)
        assert.ok(
            attachmentUrl.protocol === "https:" &&
                ["fluxer.app", "fluxerusercontent.com"].some(
                    (host) => attachmentUrl.hostname === host || attachmentUrl.hostname.endsWith(`.${host}`),
                ),
        )
        const file = await rawFetch(attachmentUrl, { redirect: "error", signal: AbortSignal.timeout(15_000) })
        assert.ok(file.ok)
        assert.equal(await file.text(), "webhook fixture bytes")
        assert.equal((await value(hook.fetchMessage(sent.id))).id, sent.id)
        stage = "webhook_reply_with_upload"
        const source = await value(
            bot.messages.send(journal.channels[1].id, { content: "SDK webhook reference source" }),
        )
        const replied = await value(
            hook.send({
                content: "SDK webhook reply",
                attachments: [{ filename: "reply.txt", data: new TextEncoder().encode("reply bytes") }],
                messageReference: { type: "reply", target: { id: source.id, channelId: source.channelId } },
            }),
        )
        const replyRemote = (await api("GET", `/channels/${replied.channelId}/messages/${replied.id}`)).data
        assert.equal(replyRemote.message_reference?.message_id, source.id)
        assert.equal(replyRemote.message_reference?.channel_id, source.channelId)
        assert.equal(replyRemote.message_reference?.guild_id, guildId)
        assert.equal(replyRemote.message_reference?.type, 0)
        assert.equal(replyRemote.attachments.length, 1)
        stage = "webhook_forward_snapshot"
        const forwarded = await value(
            hook.send({
                messageReference: {
                    type: "forward",
                    source: { source: { id: source.id, channelId: source.channelId } },
                },
                username: "SDK webhook forward",
            }),
        )
        const forwardRemote = (await api("GET", `/channels/${forwarded.channelId}/messages/${forwarded.id}`)).data
        assert.equal(forwardRemote.message_reference?.type, 1)
        assert.equal(forwardRemote.message_reference?.message_id, source.id)
        assert.equal(forwardRemote.message_snapshots?.[0]?.content, "SDK webhook reference source")
        assert.equal(forwarded.author.username, "SDK webhook forward")
        await assert.rejects(
            () =>
                value(
                    hook.send({
                        messageReference: {
                            type: "forward",
                            source: { source: { id: source.id, channelId: journal.channels[0].id } },
                        },
                    }),
                ),
            (error) => error?._tag === "WebhookOperationError" && error.reason === "notFound" && error.status === 404,
        )
        stage = "webhook_permission_error_classification"
        await assert.rejects(
            () => value(hook.editMessage(source.id, { content: "Must not replace bot message" })),
            (error) =>
                error?._tag === "WebhookOperationError" &&
                error.outcome === "rejected" &&
                error.status === 403 &&
                error.apiError?.code === "missingPermissions" &&
                error.apiError.providerCode === "MISSING_PERMISSIONS" &&
                error.message.includes(error.apiError.explanation) &&
                error.message.includes("403"),
        )
        assert.equal(
            (await api("GET", `/channels/${source.channelId}/messages/${source.id}`)).data.content,
            "SDK webhook reference source",
        )
        report(stage)
        stage = "webhook_message_edit"
        await value(hook.editMessage(sent.id, { content: "SDK webhook edited", embeds: [], flags: 4 }))
        await waitObserved(sent.id, "SDK webhook edited")
        assert.equal(
            (await api("GET", `/channels/${sent.channelId}/messages/${sent.id}`)).data.content,
            "SDK webhook edited",
        )
        assert.equal((await api("GET", `/channels/${sent.channelId}/messages/${sent.id}`)).data.flags & 4100, 4)
        const clearedFlags = await value(hook.editMessage(sent.id, { flags: 0 }))
        assert.equal(clearedFlags.flags & 4100, 0)
        assert.equal((await api("GET", `/channels/${sent.channelId}/messages/${sent.id}`)).data.flags & 4100, 0)
        report(stage)
        stage = "webhook_unknown_send_reconciliation"
        let attempts = 0
        globalThis.fetch = async (url, init) => {
            if (init?.method === "POST" && String(url).includes(`/webhooks/${created.webhook.id}/`)) {
                attempts++
                assert.equal(new Headers(init.headers).has("authorization"), false)
                const response = await rawFetch(url, init)
                assert.ok(response.ok)
                await response.body?.cancel()
                throw new Error("Test-owned response loss")
            }
            return rawFetch(url, init)
        }
        const lostContent = `${journal.marker}-lost`
        const nonce = randomUUID().replaceAll("-", "")
        await assert.rejects(
            () => value(hook.send({ content: lostContent, nonce })),
            (error) => error?._tag === "WebhookOperationError" && error.outcome === "unknown",
        )
        globalThis.fetch = rawFetch
        assert.equal(attempts, 1)
        // Resending with the same nonce must return the message the lost response created, not a second one
        const resent = await value(hook.send({ content: lostContent, nonce }))
        const history = (await api("GET", `/channels/${sent.channelId}/messages?limit=100`)).data
        const found = history.filter((item) => item.content === lostContent && item.webhook_id === created.webhook.id)
        assert.equal(found.length, 1)
        assert.equal(resent.id, found[0].id)
        await value(hook.deleteMessage(found[0].id))
        assert.equal((await api("GET", `/channels/${sent.channelId}/messages/${found[0].id}`)).status, 404)
        report(stage)
        stage = "webhook_delete_and_revocation"
        await value(hook.deleteMessage(sent.id))
        assert.equal((await api("GET", `/channels/${sent.channelId}/messages/${sent.id}`)).status, 404)
        await value(hook.delete())
        assert.equal(observationOverflow, undefined, observationOverflow)
        assert.equal((await api("GET", `/webhooks/${created.webhook.id}`)).status, 404)
        await assert.rejects(
            () => value(hook.send({ content: "Must not appear" })),
            (error) => error?._tag === "WebhookOperationError" && error.reason === "notFound",
        )
        report(stage)
    }
} catch (error) {
    console.error(
        JSON.stringify({
            mode,
            stage,
            passed: false,
            category: ["WebhookOperationError", "ConfigurationError"].includes(error?._tag) ? error._tag : "check",
            reason: error?._tag === "WebhookOperationError" ? error.reason : undefined,
            status: error?._tag === "WebhookOperationError" ? error.status : undefined,
        }),
    )
    process.exitCode = 1
} finally {
    globalThis.fetch = rawFetch
    const shutdown = (client) => async () => {
        const operation = client.shutdown()
        await (Effect.isEffect(operation) ? Effect.runPromise(operation) : operation)
    }
    // Keep the journal, lock and deadline if failed local cleanup may have left a writer alive
    await finalizeOwned({
        writers: [
            hook && ["webhook_client_shutdown", shutdown(hook)],
            bot && ["bot_client_shutdown", shutdown(bot)],
            scope && ["scope_close", () => Effect.runPromise(Scope.close(scope, Exit.void))],
        ],
        cleanup,
        lock,
        watchdog,
        onFailure: (finalizer) => {
            if (finalizer === "cleanup")
                console.error(
                    JSON.stringify({ mode, check: "cleanup", passed: false, journalRetained: journal !== undefined }),
                )
            else if (finalizer === "sandbox_lock")
                console.error(JSON.stringify({ mode, check: "lock_cleanup", passed: false, lockRetained: true }))
            else
                console.error(
                    JSON.stringify({
                        mode,
                        check: "local_cleanup",
                        finalizer,
                        passed: false,
                        journalRetained: journal !== undefined,
                        lockRetained: lock !== undefined,
                    }),
                )
            process.exitCode = 1
        },
    })
}
