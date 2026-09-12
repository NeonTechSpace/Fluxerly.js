import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync, writeFileSync, openSync, closeSync, writeSync, existsSync, unlinkSync } from "node:fs"
import { parseEnv } from "node:util"
import { Effect, Scope, Exit } from "effect"
import WebSocket from "ws"

// Manual, currently authorized recipient checks only; never run through check, CI or a schedule
const mode = process.argv[2]
const latestOnly = process.argv.includes("--latest-only")
const withoutGroup = process.argv.includes("--without-group")
const groupChecks = !latestOnly && !withoutGroup
assert.ok(mode === "default" || mode === "effect")
// Stored sandbox configuration identifies the bot, never a currently authorized private recipient
const recipient = process.env.FLUXER_TEST_DM_USER_ID
const groupId = process.env.FLUXER_TEST_GROUP_DM_ID
const extraGroupUser = process.env.FLUXER_TEST_GROUP_EXTRA_USER_ID
const processId = /^[1-9][0-9]{0,19}$/
function requireProcessId(value, name) {
    assert.ok(typeof value === "string" && processId.test(value), `Set the currently authorized ${name}`)
}
requireProcessId(recipient, "DM recipient")
if (groupId !== undefined) requireProcessId(groupId, "group ID")
if (extraGroupUser !== undefined) requireProcessId(extraGroupUser, "group participant")
const env = parseEnv(readFileSync(new URL("../../.env.test.local", import.meta.url), "utf8"))
const token = env.FLUXER_TEST_BOT_TOKEN
const guildId = env.FLUXER_TEST_GUILD_ID
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const journalPath = new URL("../../.env.test.users.local", import.meta.url)
const rawFetch = globalThis.fetch
const rawSend = WebSocket.prototype.send
const ownedSockets = new Set()
const presenceWrites = []
let lock, journal, bot, scope, botId
let verified = false,
    stage = "configuration"
const report = (check, extra = {}) => console.log(JSON.stringify({ mode, check, passed: true, ...extra }))
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
    return { status: response.status, data }
}
const privateList = async () => {
    const response = await api("GET", "/users/@me/channels")
    assert.equal(response.status, 200)
    assert.ok(Array.isArray(response.data))
    return response.data
}
async function cleanup() {
    if (!verified || !journal) return
    assert.equal(journal.guildId, guildId)
    assert.equal(journal.botId, botId)
    assert.equal(journal.recipient, recipient, "Recovery requires authorization for the journaled recipient")
    assert.match(journal.marker, /^fluxerly-dm-[a-f0-9]{32}$/)
    if (journal.profile) {
        const current = await api("GET", `/guilds/${guildId}/members/@me`)
        assert.equal(current.status, 200)
        assert.equal(current.data.user?.id, botId)
        const original = journal.profile.original
        const changed = journal.profile.changed
        assert.ok(
            current.data.nick === changed.nick || current.data.nick === original.nick,
            "Unrelated profile change; preserve it",
        )
        assert.ok(
            current.data.mention_flags === changed.mention_flags ||
                (current.data.mention_flags ?? null) === original.mention_flags,
        )
        assert.equal((await api("PATCH", `/guilds/${guildId}/members/@me`, original)).status, 200)
        const restored = await api("GET", `/guilds/${guildId}/members/@me`)
        assert.equal(restored.data.nick ?? null, original.nick)
        assert.equal(restored.data.mention_flags ?? null, original.mention_flags)
        delete journal.profile
        save()
        report("bot_server_profile_restored")
    }
    if (journal.groupId) assert.equal(journal.groupId, groupId, "Recovery requires the authorized group ID")
    for (const channelId of [journal.dmId, journal.groupId].filter(Boolean)) {
        assert.match(channelId, /^[1-9][0-9]{0,19}$/)
        const channel = await api("GET", `/channels/${channelId}`)
        if (channel.status === 404) continue
        assert.equal(channel.status, 200)
        assert.ok(channel.data.type === 1 || channel.data.type === 3)
        const messages = await api("GET", `/channels/${channelId}/messages?limit=100`)
        assert.equal(messages.status, 200)
        assert.ok(Array.isArray(messages.data))
        for (const message of messages.data.filter(
            (item) =>
                item.author?.id === botId &&
                typeof item.content === "string" &&
                item.content.startsWith(`${journal.marker}:`),
        )) {
            assert.equal((await api("DELETE", `/channels/${channelId}/messages/${message.id}`)).status, 204)
            assert.equal((await api("GET", `/channels/${channelId}/messages/${message.id}`)).status, 404)
        }
        const after = await api("GET", `/channels/${channelId}/messages?limit=100`)
        assert.equal(after.status, 200)
        assert.ok(
            !after.data.some(
                (item) =>
                    item.author?.id === botId &&
                    typeof item.content === "string" &&
                    item.content.startsWith(`${journal.marker}:`),
            ),
        )
    }
    if (journal.groupId) {
        const group = await api("GET", `/channels/${journal.groupId}`)
        verifyGroup(group)
        assert.ok(
            group.data.name === journal.marker || group.data.name === journal.groupName,
            "Unrelated group rename; preserve it",
        )
        assert.equal((await api("PATCH", `/channels/${journal.groupId}`, { name: journal.groupName })).status, 200)
        const restored = await api("GET", `/channels/${journal.groupId}`)
        verifyGroup(restored)
        assert.equal(restored.data.name, journal.groupName)
        assert.deepEqual(restored.data.recipients.map((user) => user.id).sort(), journal.groupRecipients)
        report("group_name_and_membership_restored")
    }
    if (journal.dmId && !journal.dmWasOpen) {
        assert.equal((await api("DELETE", `/channels/${journal.dmId}`)).status, 204)
        assert.ok(!(await privateList()).some((channel) => channel.id === journal.dmId))
    }
    unlinkSync(journalPath)
    journal = undefined
    report("test_messages_and_private_channel_cleanup_verified")
}
function verifyGroup(group) {
    assert.equal(group.status, 200)
    assert.equal(group.data.id, groupId)
    assert.equal(group.data.type, 3)
    assert.equal(group.data.owner_id, recipient)
    assert.ok(Array.isArray(group.data.recipients))
    const members = new Set(group.data.recipients.map((user) => user.id))
    assert.ok(members.has(recipient))
    assert.ok(
        [...members].every((id) => id === recipient || id === botId || id === extraGroupUser),
        "Unexpected group participant",
    )
}
const watchdog = setTimeout(() => {
    console.error(JSON.stringify({ mode, stage, passed: false, reason: "deadline", journalRetained: true }))
    process.exit(1)
}, 180_000).unref()
try {
    lock = openSync(lockPath, "wx")
    writeSync(lock, String(process.pid))
    assert.ok(token)
    assert.match(guildId ?? "", /^[1-9][0-9]*$/)
    stage = "sandbox_and_recipient_identity"
    const app = await api("GET", "/applications/@me")
    const self = await api("GET", "/users/@me")
    assert.equal(app.status, 200)
    assert.equal(self.status, 200)
    assert.equal(app.data.id, env.FLUXER_TEST_APPLICATION_ID)
    assert.equal(app.data.bot?.id, self.data.id)
    assert.equal(self.data.bot, true)
    assert.equal((await api("GET", `/guilds/${guildId}`)).data.id, guildId)
    botId = self.data.id
    assert.notEqual(recipient, botId)
    const member = await api("GET", `/guilds/${guildId}/members/${recipient}`)
    assert.equal(member.status, 200)
    assert.equal(member.data.user?.id, recipient)
    verified = true
    report(stage)
    if (existsSync(journalPath)) {
        journal = JSON.parse(readFileSync(journalPath, "utf8"))
        await cleanup()
    }
    if (groupChecks && groupId) {
        stage = "group_preflight"
        assert.match(groupId, /^[1-9][0-9]{0,19}$/)
        const group = await api("GET", `/channels/${groupId}`)
        verifyGroup(group)
        assert.ok(
            typeof group.data.name === "string" && group.data.name.length > 0,
            "Give the temporary group a name before testing",
        )
    }
    const before = await privateList()
    const existing = before.find(
        (channel) => channel.type === 1 && channel.recipients?.some((user) => user.id === recipient),
    )
    journal = {
        guildId,
        botId,
        recipient,
        marker: `fluxerly-dm-${randomUUID().replaceAll("-", "")}`,
        dmWasOpen: !!existing,
        ...(existing ? { dmId: existing.id } : {}),
    }
    writeFileSync(journalPath, JSON.stringify(journal), { flag: "wx" })
    scope = Scope.makeUnsafe()
    const sdk = await import(mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect")
    const created = sdk.createClient({ token, cache: { users: true, directMessages: true, messages: true } })
    bot =
        mode === "default"
            ? created._unsafeUnwrap()
            : await Effect.runPromise(created.pipe(Effect.provideService(Scope.Scope, scope)))
    if (latestOnly) {
        stage = "explicit_dm_latest_message_batch"
        const dm = await value(bot.directMessages.open(recipient))
        journal.dmId = dm.id
        save()
        assert.ok(dm.recipients.some((user) => user.id === recipient))
        const sent = await value(bot.messages.send(dm.id, { content: `${journal.marker}:batch`, allowedMentions: {} }))
        const latest = await value(bot.directMessages.fetchLatestMessages([dm.id]))
        assert.deepEqual(latest.omittedChannelIds, [])
        assert.equal(latest.messages[dm.id]?.id, sent.id)
        const independent = await api("POST", "/users/@me/channels/messages/preload", { channels: [dm.id] })
        assert.equal(independent.status, 200)
        assert.equal(independent.data[dm.id]?.id, sent.id)
        report(stage)
        stage = "latest_message_batch_failure_and_recovery"
        let attempts = 0
        globalThis.fetch = async (url, init) => {
            if (init?.method === "POST" && new URL(url).pathname === "/v1/users/@me/channels/messages/preload") {
                attempts++
                throw new TypeError("Test-owned batch response loss")
            }
            return rawFetch(url, init)
        }
        await assert.rejects(
            () => value(bot.directMessages.fetchLatestMessages([dm.id])),
            (error) =>
                error?._tag === "UserOperationError" && error.reason === "network" && error.outcome === "unknown",
        )
        assert.equal(attempts, 1)
        globalThis.fetch = rawFetch
        assert.equal((await value(bot.directMessages.fetchLatestMessages([dm.id]))).messages[dm.id]?.id, sent.id)
        report(stage)
    } else {
        const cached = (operation) => (mode === "default" ? operation._unsafeUnwrap() : value(operation))
        WebSocket.prototype.send = function (data, ...args) {
            try {
                const payload = JSON.parse(String(data))
                if ((payload.op === 2 || payload.op === 6) && payload.d?.token === token) {
                    ownedSockets.add(this)
                    this.once("close", () => ownedSockets.delete(this))
                }
                if (ownedSockets.has(this) && payload.op === 3)
                    presenceWrites.push({
                        socket: this,
                        status: payload.d?.status,
                        text: payload.d?.custom_status?.text,
                    })
            } catch {}
            return rawSend.call(this, data, ...args)
        }
        stage = "public_users"
        const user = await value(bot.users.fetch(recipient))
        assert.equal(user.id, recipient)
        assert.equal((await value(bot.users.fetchSelf())).id, botId)
        assert.ok(!("email" in user) && !("acls" in user))
        assert.equal((await cached(bot.users.get(recipient))).id, recipient)
        report(stage)
        const seen = new Set()
        const observe = (message) => {
            if (message.author?.id === botId && message.content.startsWith(journal.marker)) seen.add(message.id)
        }
        if (mode === "default") bot.on("messageCreate", observe)._unsafeUnwrap()
        else
            await Effect.runPromise(
                bot
                    .on("messageCreate", (message) => Effect.sync(() => observe(message)))
                    .pipe(Effect.provideService(Scope.Scope, scope)),
            )
        await cached(bot.presence.set({ status: "idle", customStatus: { text: journal.marker } }))
        await value(bot.connect())
        const waitUntil = async (predicate) => {
            const until = Date.now() + 15_000
            while (!predicate() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25))
            assert.ok(predicate(), "Expected live observation did not arrive")
        }
        await waitUntil(() => presenceWrites.some((write) => write.status === "idle" && write.text === journal.marker))
        report("presence_intent_written_after_ready", { providerAcknowledgement: false })
        stage = "open_dm"
        const dm = await value(bot.directMessages.open(recipient))
        journal.dmId = dm.id
        save()
        assert.equal(dm.type, "dm")
        assert.ok(dm.recipients.some((user) => user.id === recipient))
        assert.equal((await value(bot.directMessages.open(recipient))).id, dm.id)
        assert.equal((await value(bot.directMessages.fetch(dm.id))).id, dm.id)
        assert.ok((await value(bot.directMessages.fetchAll())).some((channel) => channel.id === dm.id))
        report(stage)
        stage = "dm_send_and_readback"
        const sent = await value(
            bot.directMessages.send(recipient, { content: `${journal.marker}:hello`, allowedMentions: {} }),
        )
        assert.equal(sent.channelId, dm.id)
        const readback = await api("GET", `/channels/${dm.id}/messages/${sent.id}`)
        assert.equal(readback.data.author.id, botId)
        assert.equal(readback.data.content, `${journal.marker}:hello`)
        const until = Date.now() + 10_000
        while (!seen.has(sent.id) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50))
        assert.ok(seen.has(sent.id), "DM gateway message not observed")
        await value(bot.messages.edit(sent, { content: `${journal.marker}:edited` }))
        assert.equal(
            (await api("GET", `/channels/${dm.id}/messages/${sent.id}`)).data.content,
            `${journal.marker}:edited`,
        )
        report(stage)
        stage = "explicit_dm_latest_message_batch"
        const batchMessage = await value(bot.messages.send(dm.id, { content: `${journal.marker}:batch` }))
        const latest = await value(bot.directMessages.fetchLatestMessages([dm.id]))
        assert.deepEqual(latest.omittedChannelIds, [])
        assert.equal(
            latest.messages[dm.id]?.id,
            batchMessage.id,
            "Concurrent DM activity prevented latest-message verification",
        )
        const latestReadback = await api("POST", "/users/@me/channels/messages/preload", { channels: [dm.id] })
        assert.equal(latestReadback.status, 200)
        assert.equal(latestReadback.data[dm.id]?.id, batchMessage.id)
        report(stage)
        stage = "unknown_dm_send_not_retried"
        let sends = 0
        globalThis.fetch = async (url, init) => {
            const response = await rawFetch(url, init)
            if (init?.method === "POST" && new URL(url).pathname === `/v1/channels/${dm.id}/messages`) {
                sends++
                await response.arrayBuffer()
                throw new TypeError("Test-owned response loss")
            }
            return response
        }
        try {
            await assert.rejects(
                () => value(bot.directMessages.send(recipient, { content: `${journal.marker}:lost` })),
                (error) => error._tag === "MessageError" && error.delivery === "unknown",
            )
        } finally {
            globalThis.fetch = rawFetch
        }
        assert.equal(sends, 1)
        const history = await api("GET", `/channels/${dm.id}/messages?limit=100`)
        assert.equal(
            history.data.filter(
                (message) => message.author?.id === botId && message.content === `${journal.marker}:lost`,
            ).length,
            1,
        )
        report(stage)
        stage = "bot_server_profile"
        const originalProfile = await api("GET", `/guilds/${guildId}/members/@me`)
        assert.equal(originalProfile.status, 200)
        assert.equal(originalProfile.data.user?.id, botId)
        journal.profile = {
            original: {
                nick: originalProfile.data.nick ?? null,
                mention_flags: originalProfile.data.mention_flags ?? null,
            },
            changed: {
                nick: `flx-${randomUUID().replaceAll("-", "").slice(0, 24)}`,
                mention_flags: originalProfile.data.mention_flags === 2 ? 1 : 2,
            },
        }
        save()
        const editedProfile = await value(
            bot.members.editSelf(guildId, {
                nickname: journal.profile.changed.nick,
                mentionFlags: journal.profile.changed.mention_flags,
            }),
        )
        assert.equal(editedProfile.nickname, journal.profile.changed.nick)
        const profileReadback = await api("GET", `/guilds/${guildId}/members/@me`)
        assert.equal(profileReadback.data.nick, journal.profile.changed.nick)
        assert.equal(profileReadback.data.mention_flags, journal.profile.changed.mention_flags)
        report(stage)
        stage = "presence_and_dm_recovery"
        const previousSocket = [...ownedSockets].find((socket) => socket.readyState === WebSocket.OPEN)
        assert.ok(previousSocket)
        previousSocket.terminate()
        await waitUntil(() =>
            presenceWrites.some(
                (write) => write.socket !== previousSocket && write.status === "idle" && write.text === journal.marker,
            ),
        )
        assert.equal(bot.state, "Connected")
        assert.equal(await cached(bot.users.get(recipient)), undefined)
        assert.equal(await cached(bot.directMessages.get(dm.id)), undefined)
        const recovered = await value(bot.messages.send(dm.id, { content: `${journal.marker}:recovered` }))
        assert.equal(
            (await api("GET", `/channels/${dm.id}/messages/${recovered.id}`)).data.content,
            `${journal.marker}:recovered`,
        )
        report(stage, { providerPresenceAcknowledgement: false })
        stage = "existing_group"
        if (!groupChecks || !groupId) {
            console.log(
                JSON.stringify({
                    mode,
                    check: "existing_group",
                    skipped: true,
                    reason: "No authorized group selected",
                }),
            )
        } else {
            assert.match(groupId, /^[1-9][0-9]{0,19}$/)
            const original = await api("GET", `/channels/${groupId}`)
            verifyGroup(original)
            assert.ok(
                typeof original.data.name === "string" && original.data.name.length > 0,
                "Give the temporary group a name before testing",
            )
            journal.groupId = groupId
            journal.groupName = original.data.name
            journal.groupRecipients = original.data.recipients.map((user) => user.id).sort()
            save()
            const group = await value(bot.directMessages.fetch(groupId))
            assert.equal(group.type, "group")
            assert.equal(group.ownerId, recipient)
            await value(bot.directMessages.editGroup(group.id, { name: journal.marker }))
            assert.equal((await api("GET", `/channels/${group.id}`)).data.name, journal.marker)
            const groupMessage = await value(bot.messages.send(group.id, { content: `${journal.marker}:group` }))
            assert.equal(
                (await api("GET", `/channels/${group.id}/messages/${groupMessage.id}`)).data.content,
                `${journal.marker}:group`,
            )
            report(stage)
        }
    }
} catch (error) {
    console.error(
        JSON.stringify({
            mode,
            stage,
            passed: false,
            tag: error?._tag ?? error?.name ?? "Error",
            reason: typeof error?.reason === "string" ? error.reason : undefined,
            status: typeof error?.status === "number" ? error.status : undefined,
        }),
    )
    process.exitCode = 1
} finally {
    globalThis.fetch = rawFetch
    try {
        if (bot && bot.state === "Connected") {
            await (mode === "default"
                ? bot.presence.set({ status: "online", customStatus: null })._unsafeUnwrap()
                : value(bot.presence.set({ status: "online", customStatus: null })))
            const until = Date.now() + 6_000
            while (presenceWrites.at(-1)?.status !== "online" && Date.now() < until)
                await new Promise((resolve) => setTimeout(resolve, 25))
            assert.equal(presenceWrites.at(-1)?.status, "online")
        }
    } catch {
        console.error(JSON.stringify({ mode, check: "presence_reset", passed: false }))
        process.exitCode = 1
    }
    try {
        if (bot && bot.state !== "Closed") {
            const stopped = bot.shutdown()
            await (Effect.isEffect(stopped) ? Effect.runPromise(stopped) : stopped)
        }
        if (scope) await Effect.runPromise(Scope.close(scope, Exit.void))
        await cleanup()
    } catch {
        console.error(JSON.stringify({ mode, check: "cleanup", passed: false, journalRetained: true }))
        process.exitCode = 1
    }
    clearTimeout(watchdog)
    WebSocket.prototype.send = rawSend
    if (lock !== undefined) {
        closeSync(lock)
        unlinkSync(lockPath)
    }
}
