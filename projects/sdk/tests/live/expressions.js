import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync, writeFileSync, openSync, closeSync, writeSync, existsSync, unlinkSync } from "node:fs"
import { parseEnv } from "node:util"
import { crc32, deflateSync } from "node:zlib"
import { Effect, Scope, Exit } from "effect"

const mode = process.argv[2]
assert.ok(mode === "default" || mode === "effect")
const rawFetch = globalThis.fetch
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const journalPath = new URL("../../.env.test.expressions.local", import.meta.url)
let lock, journal, client, webhookClient, scope, token, guildId, botId
let verified = false,
    stage = "configuration"
const report = (check) => console.log(JSON.stringify({ mode, check, passed: true }))
const save = () => writeFileSync(journalPath, JSON.stringify(journal))
const observations = { emojis: { sequence: 0, value: undefined }, stickers: { sequence: 0, value: undefined } }
const incompleteChecks = []
async function expressionEvent(kind, predicate, after = -1) {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
        const observed = observations[kind]
        if (observed.sequence > after && observed.value && predicate(observed.value.items)) return
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error("Timed out waiting for test-owned expression event")
}
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
    assert.ok(response.ok || response.status === 404, `Sandbox HTTP ${response.status}`)
    return { status: response.status, data }
}

// Authored solid-color 128px PNG; no remote image or user file enters the fixture
function image() {
    const chunk = (name, data) => {
        const bytes = Buffer.concat([Buffer.from(name), data])
        const length = Buffer.alloc(4),
            checksum = Buffer.alloc(4)
        length.writeUInt32BE(data.length)
        checksum.writeUInt32BE(crc32(bytes))
        return Buffer.concat([length, bytes, checksum])
    }
    const header = Buffer.alloc(13)
    header.writeUInt32BE(128, 0)
    header.writeUInt32BE(128, 4)
    header[8] = 8
    header[9] = 6
    const pixels = Buffer.alloc(128 * 513)
    for (let y = 0; y < 128; y++)
        for (let x = 0; x < 128; x++) {
            const offset = y * 513 + 1 + x * 4
            pixels.set([40, 130, 220, 255], offset)
        }
    return `data:image/png;charset=utf-8;base64,${Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]).toString("base64")}`
}

async function cleanup() {
    if (!verified || !journal) return
    assert.equal(journal.guildId, guildId)
    assert.equal(journal.botId, botId)
    assert.match(journal.marker, /^fx_[a-f0-9]{16}$/)
    if (journal.webhook) {
        const hooks = (await api("GET", `/guilds/${guildId}/webhooks`)).data
        assert.ok(Array.isArray(hooks))
        const matches = hooks.filter((item) => item.id === journal.webhook.id || item.name === journal.marker)
        assert.ok(matches.length <= 1)
        assert.ok(matches.length || journal.webhook.id, "Unresolved webhook creation; retain journal")
        for (const item of matches) {
            assert.equal(item.name, journal.marker)
            assert.equal(item.user?.id, botId)
            assert.equal(item.channel_id, journal.channel.id)
            journal.webhook.id = item.id
            save()
            await api("DELETE", `/webhooks/${item.id}`)
            assert.equal((await api("GET", `/webhooks/${item.id}`)).status, 404)
        }
    }
    // Delete the test channel first so no test message refers to a removed sticker
    if (journal.channel) {
        const channels = await api("GET", `/guilds/${guildId}/channels`)
        assert.ok(Array.isArray(channels.data))
        const matches = channels.data.filter((item) => item.name === journal.marker || item.id === journal.channel.id)
        assert.ok(matches.length <= 1)
        assert.ok(matches.length || journal.channel.id, "Unresolved channel creation; retain journal")
        for (const channel of matches) {
            assert.equal(channel.name, journal.marker)
            assert.equal(channel.guild_id, guildId)
            journal.channel.id = channel.id
            save()
            await api("DELETE", `/channels/${channel.id}`)
            assert.equal((await api("GET", `/channels/${channel.id}`)).status, 404)
        }
    }
    for (const kind of ["emojis", "stickers"]) {
        const path = `/guilds/${guildId}/${kind}`
        const listed = await api("GET", path)
        assert.ok(Array.isArray(listed.data))
        for (const entry of journal[kind]) {
            assert.ok(entry.name.startsWith(journal.marker))
            const names = [entry.name, `${entry.name}_edit`]
            const matches = listed.data.filter((item) => names.includes(item.name) || entry.ids.includes(item.id))
            assert.ok(matches.length <= (entry.clone ? 2 : 1))
            assert.ok(
                matches.length || entry.ids.length || entry.rejected,
                "Unresolved expression creation; retain journal",
            )
            for (const item of matches) {
                assert.ok(names.includes(item.name))
                assert.equal(item.user?.id, botId)
                if (!entry.ids.includes(item.id)) {
                    entry.ids.push(item.id)
                    save()
                }
                await api("DELETE", `${path}/${item.id}?purge=false`)
            }
        }
        const after = await api("GET", path)
        assert.ok(Array.isArray(after.data))
        assert.ok(
            !after.data.some((item) =>
                journal[kind].some(
                    (entry) => entry.ids.includes(item.id) || [entry.name, `${entry.name}_edit`].includes(item.name),
                ),
            ),
        )
    }
    unlinkSync(journalPath)
    journal = undefined
    report("test_channel_messages_and_expressions_removed_without_purging")
}

const watchdog = setTimeout(() => {
    console.error(JSON.stringify({ mode, stage, passed: false, reason: "deadline", journalRetained: true }))
    process.exit(1)
}, 240_000).unref()
try {
    lock = openSync(lockPath, "wx")
    writeSync(lock, String(process.pid))
    const env = parseEnv(readFileSync(new URL("../../.env.test.local", import.meta.url), "utf8"))
    token = env.FLUXER_TEST_BOT_TOKEN
    guildId = env.FLUXER_TEST_GUILD_ID
    assert.ok(token)
    assert.match(guildId ?? "", /^[1-9][0-9]*$/)
    stage = "sandbox_identity"
    const app = await api("GET", "/applications/@me"),
        self = await api("GET", "/users/@me")
    assert.equal(app.data.id, env.FLUXER_TEST_APPLICATION_ID)
    assert.equal(app.data.bot?.id, self.data.id)
    assert.equal(self.data.bot, true)
    assert.equal((await api("GET", `/guilds/${guildId}`)).data.id, guildId)
    botId = self.data.id
    verified = true
    report(stage)
    if (existsSync(journalPath)) {
        journal = JSON.parse(readFileSync(journalPath, "utf8"))
        await cleanup()
    }
    journal = {
        guildId,
        botId,
        marker: `fx_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
        emojis: [],
        stickers: [],
    }
    save()
    const sdk = await import(mode === "default" ? "../../dist/index.js" : "../../dist/effect.js")
    const options = { token, cache: { emojis: true, stickers: true, messages: true } }
    if (mode === "default") client = sdk.createClient(options)._unsafeUnwrap()
    else {
        scope = Scope.makeUnsafe()
        client = await Effect.runPromise(sdk.createClient(options).pipe(Scope.provide(scope)))
    }
    for (const [kind, event] of [
        ["emojis", "guildEmojisUpdate"],
        ["stickers", "guildStickersUpdate"],
    ]) {
        const observe = (snapshot) => {
            if (snapshot.guildId !== guildId) return
            assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.items))
            assert.ok(
                snapshot.items.every(
                    (item) => Object.isFrozen(item) && !Object.hasOwn(item, "user") && !Object.hasOwn(item, "image"),
                ),
            )
            observations[kind].sequence++
            observations[kind].value = snapshot
        }
        if (mode === "default") await value(client.on(event, observe))
        else
            await Effect.runPromise(
                client.on(event, (snapshot) => Effect.sync(() => observe(snapshot))).pipe(Scope.provide(scope)),
            )
    }
    await value(client.connect())
    let sticker, emoji
    for (const kind of ["emojis", "stickers"]) {
        stage = `${kind}_create_list_metadata_edit`
        const entry = { name: `${journal.marker}_one`, ids: [] }
        journal[kind].push(entry)
        save()
        const created = await value(
            client[kind].create(guildId, {
                name: entry.name,
                image: image(),
                ...(kind === "stickers" ? { description: "SDK live fixture", tags: ["test"] } : {}),
            }),
        )
        entry.ids.push(created.id)
        save()
        await expressionEvent(kind, (items) => items.some((item) => item.id === created.id && item.name === entry.name))
        if (kind === "emojis") emoji = created
        const remote = (await api("GET", `/guilds/${guildId}/${kind}`)).data.find((item) => item.id === created.id)
        assert.equal(remote.name, entry.name)
        assert.equal(remote.user?.id, botId)
        assert.equal((await value(client[kind].fetchMetadata(created.id))).guildId, guildId)
        assert.ok((await value(client[kind].fetchAll(guildId))).some((item) => item.id === created.id))
        const edit =
            kind === "stickers"
                ? { ...created, name: `${entry.name}_edit`, description: "Edited", tags: [] }
                : { name: `${entry.name}_edit` }
        await value(client[kind].edit(created, edit))
        const changed = (await api("GET", `/guilds/${guildId}/${kind}`)).data.find((item) => item.id === created.id)
        assert.equal(changed.name, edit.name)
        await expressionEvent(kind, (items) => items.some((item) => item.id === created.id && item.name === edit.name))
        if (kind === "stickers") {
            assert.equal(changed.description, "Edited")
            assert.deepEqual(changed.tags, [])
            sticker = created
        }
        report(stage)
        stage = `${kind}_lost_edit_response_reconciliation`
        let attempts = 0
        globalThis.fetch = async (url, init) => {
            const response = await rawFetch(url, init)
            if (String(url).endsWith(`/guilds/${guildId}/${kind}/${created.id}`) && init?.method === "PATCH") {
                attempts++
                await response.arrayBuffer()
                assert.equal(response.status, 200)
                throw new Error("Discarded test-owned edit response")
            }
            return response
        }
        try {
            await assert.rejects(
                value(
                    client[kind].edit(
                        created,
                        kind === "stickers" ? { ...edit, name: entry.name } : { name: entry.name },
                    ),
                ),
                (error) => error.reason === "network" && error.outcome === "unknown",
            )
        } finally {
            globalThis.fetch = rawFetch
        }
        assert.equal(attempts, 1)
        assert.equal(
            (await api("GET", `/guilds/${guildId}/${kind}`)).data.find((item) => item.id === created.id)?.name,
            entry.name,
        )
        report(stage)
        stage = `${kind}_clone`
        entry.clone = true
        save()
        try {
            const cloned = await value(client[kind].clone(guildId, created.id))
            entry.ids.push(cloned.id)
            save()
            assert.notEqual(cloned.id, created.id)
            assert.equal(
                (await api("GET", `/guilds/${guildId}/${kind}`)).data.find((item) => item.id === cloned.id)?.user?.id,
                botId,
            )
            report(stage)
        } catch (error) {
            if (
                error?._tag !== "GuildOperationError" ||
                error.operation !== `${kind}.clone` ||
                error.reason !== "rejected" ||
                error.outcome !== "rejected" ||
                error.status !== 403
            )
                throw error
            const skippedAssertions = ["clone_returns_distinct_expression", "clone_persists_with_test_bot_owner"]
            incompleteChecks.push({ check: stage, skippedAssertions })
            console.error(
                JSON.stringify({
                    mode,
                    check: stage,
                    passed: false,
                    incomplete: true,
                    reason: "cloning_unavailable",
                    status: 403,
                    skippedAssertions,
                }),
            )
            process.exitCode = 1
        }
        stage = `${kind}_partial_batch`
        const good = { name: `${journal.marker}_ok`, ids: [] },
            bad = { name: `${journal.marker}_bad`, ids: [] }
        journal[kind].push(good, bad)
        save()
        const batch = await value(
            client[kind].createMany(guildId, [
                { name: good.name, image: image() },
                { name: bad.name, image: "bm90IGFuIGltYWdl" },
            ]),
        )
        assert.equal(batch.success.length, 1)
        assert.deepEqual(batch.failed, [{ name: bad.name }])
        good.ids.push(batch.success[0].id)
        bad.rejected = true
        save()
        const readback = (await api("GET", `/guilds/${guildId}/${kind}`)).data
        assert.ok(readback.some((item) => item.id === good.ids[0]))
        assert.ok(!readback.some((item) => item.name === bad.name))
        await expressionEvent(kind, (items) => items.some((item) => item.id === good.ids[0]))
        const beforeDeleteEvent = observations[kind].sequence
        await value(client[kind].delete(batch.success[0]))
        await expressionEvent(kind, (items) => !items.some((item) => item.id === good.ids[0]), beforeDeleteEvent)
        assert.ok(!(await api("GET", `/guilds/${guildId}/${kind}`)).data.some((item) => item.id === good.ids[0]))
        report(stage)
    }
    report("expression_create_edit_delete_events_received")
    stage = "sticker_send_reply_and_remote_readback"
    journal.channel = {}
    save()
    const channel = await value(client.channels.create(guildId, { type: 0, name: journal.marker }))
    journal.channel.id = channel.id
    save()
    const sent = await value(client.messages.send(channel.id, { stickerIds: [sticker.id] }))
    assert.equal(sent.stickers[0]?.id, sticker.id)
    assert.equal((await api("GET", `/channels/${channel.id}/messages/${sent.id}`)).data.stickers[0]?.id, sticker.id)
    const reply = await value(client.messages.reply(sent, { stickerIds: [sticker.id] }))
    assert.equal((await value(client.messages.fetch(reply))).stickers[0]?.id, sticker.id)
    report(stage)
    stage = "created_emoji_used_directly_as_reaction"
    await value(client.messages.addReaction(sent, emoji))
    const reaction = (await api("GET", `/channels/${channel.id}/messages/${sent.id}`)).data.reactions.find(
        (item) => item.emoji.id === emoji.id,
    )
    assert.equal(reaction.me, true)
    assert.equal(reaction.count, 1)
    report(stage)
    stage = "webhook_sticker_send_and_readback"
    journal.webhook = {}
    save()
    const hook = await value(client.webhooks.create(channel.id, { name: journal.marker }))
    journal.webhook.id = hook.webhook.id
    save()
    if (mode === "default") webhookClient = sdk.createWebhookClient(hook.credentials)._unsafeUnwrap()
    else webhookClient = await Effect.runPromise(sdk.createWebhookClient(hook.credentials).pipe(Scope.provide(scope)))
    const posted = await value(webhookClient.send({ stickerIds: [sticker.id] }))
    assert.equal(posted.stickers[0]?.id, sticker.id)
    const webhookRead = (await api("GET", `/channels/${channel.id}/messages/${posted.id}`)).data
    assert.equal(webhookRead.webhook_id, hook.webhook.id)
    assert.equal(webhookRead.stickers[0]?.id, sticker.id)
    report(stage)
    if (incompleteChecks.length)
        console.error(
            JSON.stringify({
                mode,
                check: "expressions_live_suite",
                passed: false,
                incomplete: true,
                incompleteChecks,
            }),
        )
} catch (error) {
    console.error(
        JSON.stringify({
            mode,
            stage,
            passed: false,
            tag: error?._tag ?? error?.name ?? "Error",
            reason: error?.reason ?? null,
            status: error?.status ?? null,
        }),
    )
    process.exitCode = 1
} finally {
    globalThis.fetch = rawFetch
    let quiescent = true
    const retainEvidence = (finalizer) => {
        quiescent = false
        console.error(
            JSON.stringify({
                mode,
                stage: "cleanup",
                passed: false,
                finalizer,
                journalRetained: journal !== undefined,
                lockRetained: lock !== undefined,
            }),
        )
        process.exitCode = 1
    }
    for (const [finalizer, ownedClient] of [
        ["webhook_client_shutdown", webhookClient],
        ["client_shutdown", client],
    ])
        if (ownedClient)
            try {
                const closed = ownedClient.shutdown()
                if (Effect.isEffect(closed)) await Effect.runPromise(closed)
                else await closed
            } catch {
                retainEvidence(finalizer)
            }
    if (scope)
        try {
            await Effect.runPromise(Scope.close(scope, Exit.void))
        } catch {
            retainEvidence("scope_close")
        }
    if (quiescent)
        try {
            await cleanup()
        } catch {
            console.error(
                JSON.stringify({ mode, stage: "cleanup", passed: false, journalRetained: journal !== undefined }),
            )
            process.exitCode = 1
        }
    if (quiescent && lock !== undefined) {
        try {
            closeSync(lock)
            unlinkSync(lockPath)
        } catch {
            console.error(JSON.stringify({ mode, stage: "lock_cleanup", passed: false, lockRetained: true }))
            process.exitCode = 1
        }
    }
    // Keep the deadline if a failed owned finalizer may have left a writer alive
    if (quiescent) clearTimeout(watchdog)
}
