import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { openSync, closeSync, writeSync, existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { parseEnv, inspect } from "node:util"
import { Effect, Scope, Exit } from "effect"

const mode = process.argv[2]
assert.ok(mode === "default" || mode === "effect")
const rawFetch = globalThis.fetch
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const journalPath = new URL("../../.env.test.webhooks.local", import.meta.url)
let lock, journal, bot, hook, scope, token, guildId, botId
let stage = "configuration",
    verified = false
const report = (check) => console.log(JSON.stringify({ mode, check, passed: true }))
const save = () => writeFileSync(journalPath, JSON.stringify(journal))
const value = async (operation) => {
    if (Effect.isEffect(operation)) {
        const result = await Effect.runPromise(Effect.result(operation))
        if (result._tag === "Failure") throw result.failure
        return result.success
    }
    const result = await operation
    if (result.isErr()) throw result.error
    return result.value
}
async function api(method, path, body) {
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
    const data = await response.json().catch(() => null)
    assert.ok(response.ok || response.status === 404, "Sandbox request rejected")
    return { status: response.status, data }
}
async function cleanup() {
    if (!verified || !journal) return
    assert.equal(journal.guildId, guildId)
    assert.equal(journal.botId, botId)
    assert.match(journal.marker, /^fluxerly-wh-[a-f0-9]{32}$/)
    const hooks = await api("GET", `/guilds/${guildId}/webhooks`)
    assert.ok(Array.isArray(hooks.data))
    for (const item of hooks.data.filter(
        (item) =>
            item.id === journal.webhookId || item.name === journal.marker || item.name === `${journal.marker}-edited`,
    )) {
        assert.ok([journal.marker, `${journal.marker}-edited`].includes(item.name))
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
    unlinkSync(journalPath)
    journal = undefined
    report("webhook_and_channels_cleanup_verified")
}
const watchdog = setTimeout(() => {
    console.error(JSON.stringify({ mode, stage, passed: false, reason: "deadline", journalRetained: true }))
    process.exit(1)
}, 180_000).unref()
try {
    lock = openSync(lockPath, "wx")
    writeSync(lock, String(process.pid))
    const env = parseEnv(readFileSync(new URL("../../.env.test.local", import.meta.url), "utf8"))
    token = env.FLUXER_TEST_BOT_TOKEN
    guildId = env.FLUXER_TEST_GUILD_ID
    assert.match(guildId ?? "", /^\d+$/)
    assert.ok(token)
    stage = "sandbox_identity"
    const app = (await api("GET", "/applications/@me")).data
    const user = (await api("GET", "/users/@me")).data
    assert.equal(app.id, env.FLUXER_TEST_APPLICATION_ID)
    assert.equal(app.bot?.id, user.id)
    assert.equal(user.bot, true)
    assert.equal((await api("GET", `/guilds/${guildId}`)).data.id, guildId)
    botId = user.id
    verified = true
    report(stage)
    if (existsSync(journalPath)) {
        journal = JSON.parse(readFileSync(journalPath, "utf8"))
        await cleanup()
    }
    journal = { guildId, botId, marker: `fluxerly-wh-${randomUUID().replaceAll("-", "")}`, channels: [] }
    writeFileSync(journalPath, JSON.stringify(journal), { flag: "wx" })
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
            ? operation._unsafeUnwrap()
            : Effect.runPromise(operation.pipe(Effect.provideService(Scope.Scope, scope)))
    bot = await create(sdk.createClient({ token, cache: { messages: true } }))
    const webhookUpdates = []
    let observationOverflow
    const observeWebhookUpdate = (update) => {
        if (update.guildId !== journal.guildId || !journal.channels.some((channel) => channel.id === update.channelId))
            return
        if (webhookUpdates.length === 4) {
            observationOverflow ??= "Webhook update observation overflow"
            return
        }
        webhookUpdates.push(update.channelId)
    }
    if (mode === "default") bot.on("webhooksUpdate", observeWebhookUpdate)._unsafeUnwrap()
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
        (await value(bot.webhooks.fetchChannel(journal.channels[0].id))).some((item) => item.id === created.webhook.id),
    )
    assert.ok((await value(bot.webhooks.fetchGuild(guildId))).some((item) => item.id === created.webhook.id))
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
        if (mode === "default") bot.on(event, observe)._unsafeUnwrap()
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
                ? bot.messages.get({ id, channelId: journal.channels[1].id })._unsafeUnwrap()
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
    const source = await value(bot.messages.send(journal.channels[1].id, { content: "SDK webhook reference source" }))
    const replied = await value(
        hook.send({
            content: "SDK webhook reply",
            attachments: [{ filename: "reply.txt", data: new TextEncoder().encode("reply bytes") }],
            messageReference: { type: "reply", target: { id: source.id, channelId: source.channelId } },
        }),
    )
    const replyRemote = (await api("GET", `/channels/${replied.channelId}/messages/${replied.id}`)).data
    assert.deepEqual(replyRemote.message_reference, { message_id: source.id, channel_id: source.channelId, type: 0 })
    assert.equal(replyRemote.attachments.length, 1)
    const forwarded = await value(
        hook.send({
            messageReference: { type: "forward", source: { source: { id: source.id, channelId: source.channelId } } },
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
        (error) => error?._tag === "WebhookOperationError" && error.reason === "rejected",
    )
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
    await assert.rejects(
        () => value(hook.send({ content: lostContent })),
        (error) => error?._tag === "WebhookOperationError" && error.outcome === "unknown",
    )
    globalThis.fetch = rawFetch
    assert.equal(attempts, 1)
    const history = (await api("GET", `/channels/${sent.channelId}/messages?limit=100`)).data
    const found = history.filter((item) => item.content === lostContent && item.webhook_id === created.webhook.id)
    assert.equal(found.length, 1)
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
    for (const client of [hook, bot])
        if (client) {
            const operation = client.shutdown()
            await (Effect.isEffect(operation) ? Effect.runPromise(operation) : operation)
        }
    if (scope) await Effect.runPromise(Scope.close(scope, Exit.void))
    try {
        await cleanup()
    } catch {
        console.error(JSON.stringify({ mode, check: "cleanup", passed: false, journalRetained: true }))
        process.exitCode = 1
    }
    if (lock !== undefined) {
        closeSync(lock)
        unlinkSync(lockPath)
    }
    clearTimeout(watchdog)
}
