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
const historyPageSize = 100
const historyPageLimit = 5
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
const markerPattern = /^fluxerly-dm-[a-f0-9]{32}$/
const messageMarkerPattern = /^fluxerly-dm-[a-f0-9]{32}:[a-z][a-z0-9-]*$/
const id = (value) => typeof value === "string" && processId.test(value)
const sameIds = (left, right) =>
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])

function prepareSend(operation, channelId) {
    assert.ok(journal?.version === 2)
    assert.match(operation, /^[a-z][a-z0-9-]*$/)
    assert.ok(id(channelId))
    assert.equal(journal.pendingSends?.[operation], undefined)
    const entry = { channelId, marker: `${journal.marker}:${operation}` }
    journal.pendingSends[operation] = entry
    save()
    return entry
}

function recordSent(operation, sent) {
    const entry = journal.pendingSends?.[operation]
    assert.ok(entry)
    assert.match(sent?.id ?? "", processId)
    assert.equal(sent.channelId, entry.channelId)
    journal.messages.push({ ...entry, id: sent.id })
    delete journal.pendingSends[operation]
    save()
    return sent
}

function validateJournal() {
    assert.equal(journal?.version, 2)
    assert.equal(journal.guildId, guildId)
    assert.equal(journal.botId, botId)
    assert.equal(journal.recipient, recipient, "Recovery requires authorization for the journaled recipient")
    assert.match(journal.marker, markerPattern)
    assert.ok(Array.isArray(journal.messages))
    assert.ok(journal.pendingSends && typeof journal.pendingSends === "object" && !Array.isArray(journal.pendingSends))
    if (journal.dm !== undefined) {
        assert.ok(journal.dm && typeof journal.dm === "object")
        assert.equal(typeof journal.dm.wasOpen, "boolean")
        if (journal.dm.id !== undefined) assert.ok(id(journal.dm.id))
        if (journal.dm.opening !== undefined) {
            assert.equal(journal.dm.opening, true)
            assert.equal(journal.dm.wasOpen, false)
            assert.equal(journal.dm.id, undefined)
        }
        if (journal.dm.closing !== undefined) {
            assert.equal(journal.dm.closing, true)
            assert.equal(journal.dm.wasOpen, false)
            assert.ok(id(journal.dm.id))
            assert.equal(journal.dm.opening, undefined)
        }
        if (journal.dm.id === undefined) assert.equal(journal.dm.opening, true)
    }
    if (journal.group !== undefined) {
        assert.equal(journal.group.id, groupId, "Recovery requires the authorized group ID")
        assert.ok(id(journal.group.id))
        assert.equal(typeof journal.group.name, "string")
        assert.ok(Array.isArray(journal.group.recipients) && journal.group.recipients.every(id))
    }
    for (const entry of [...journal.messages, ...Object.values(journal.pendingSends)]) {
        assert.ok(entry && typeof entry === "object")
        assert.ok(id(entry.channelId))
        assert.match(entry.marker ?? "", messageMarkerPattern)
        assert.ok(entry.marker.startsWith(`${journal.marker}:`))
        if (entry.id !== undefined) assert.ok(id(entry.id))
        if (entry.edit !== undefined) {
            assert.ok(entry.edit && typeof entry.edit === "object")
            assert.match(entry.edit.intended ?? "", messageMarkerPattern)
            assert.ok(entry.edit.intended.startsWith(`${journal.marker}:`))
        }
    }
    for (const entry of journal.messages) assert.ok(id(entry.id), "Journaled message is missing its ID")
    for (const entry of Object.values(journal.pendingSends)) assert.equal(entry.id, undefined)
    const messageIds = journal.messages.map((entry) => `${entry.channelId}:${entry.id}`)
    assert.equal(new Set(messageIds).size, messageIds.length)
}

function ownedMessage(entry, message) {
    return (
        message?.author?.id === botId &&
        (message?.content === entry.marker || (entry.edit !== undefined && message?.content === entry.edit.intended))
    )
}

async function authorizeRecoveryTargets() {
    assert.equal(journal.guildId, guildId)
    assert.equal(journal.botId, botId)
    assert.equal(journal.recipient, recipient, "Recovery requires authorization for the journaled recipient")
    assert.match(journal.marker, markerPattern)
    const legacy = journal.version !== 2
    const dm = legacy
        ? { id: journal.dmId, opening: journal.dmWasOpen === false && journal.dmId === undefined }
        : journal.dm
    const group = legacy ? { id: journal.groupId } : journal.group
    const allowedChannels = new Set()
    const privateChannels = await privateList()
    if (dm?.id !== undefined) {
        const current = privateChannels.filter((channel) => channel.id === dm.id)
        if (current.length === 0)
            assert.ok(
                !legacy && dm.wasOpen === false && dm.closing === true,
                "Journaled DM is not currently authorized",
            )
        else {
            assert.equal(current.length, 1, "Journaled DM is not currently authorized")
            assert.equal(current[0].type, 1)
            assert.ok(
                current[0].recipients?.some((user) => user.id === recipient),
                "Journaled DM recipient changed",
            )
        }
        allowedChannels.add(dm.id)
    }
    if (group?.id !== undefined) {
        assert.equal(group.id, groupId, "Recovery requires the authorized group ID")
        const current = await api("GET", `/channels/${group.id}`)
        verifyGroup(current)
        allowedChannels.add(group.id)
    }
    if (!legacy) {
        for (const entry of [...journal.messages, ...Object.values(journal.pendingSends)])
            assert.ok(allowedChannels.has(entry.channelId), "Journaled message channel is not authorized")
    }
    if (dm?.opening) assert.ok(dm.id === undefined)
}

async function reconcilePendingDmOpen() {
    if (!journal.dm?.opening) return
    assert.equal(journal.dm.id, undefined)
    const matches = (await privateList()).filter(
        (channel) => channel.type === 1 && channel.recipients?.some((user) => user.id === recipient),
    )
    assert.equal(matches.length, 1, "Uncertain DM open could not be reconciled safely")
    assert.ok(id(matches[0].id))
    journal.dm.id = matches[0].id
    delete journal.dm.opening
    save()
}

async function scanMessages(channelId, marker) {
    let before
    const seen = new Set()
    const matches = []
    for (let pageNumber = 0; pageNumber < historyPageLimit; pageNumber++) {
        const query = before === undefined ? "" : `&before=${before}`
        const path = `/channels/${channelId}/messages?limit=${historyPageSize}${query}`
        const page = await api("GET", path)
        assert.equal(page.status, 200)
        assert.ok(Array.isArray(page.data) && page.data.length <= historyPageSize)
        let previous = before
        for (const message of page.data) {
            assert.ok(id(message?.id))
            assert.ok(!seen.has(message.id), "Message history cursor did not advance")
            if (previous !== undefined)
                assert.ok(BigInt(message.id) < BigInt(previous), "Message history is not strictly backwards")
            seen.add(message.id)
            if (message.author?.id === botId && (marker === undefined || message.content === marker))
                matches.push(message)
            previous = message.id
        }
        if (page.data.length < historyPageSize) return matches
        const next = page.data.at(-1)?.id
        assert.ok(id(next))
        if (before !== undefined) assert.ok(BigInt(next) < BigInt(before), "Message history cursor did not advance")
        before = next
    }
    throw new Error("Message recovery scan reached its 500-message limit")
}

async function reconcilePendingSends() {
    for (const [operation, entry] of Object.entries(journal.pendingSends)) {
        const matches = await scanMessages(entry.channelId, entry.marker)
        assert.equal(matches.length, 1, "Uncertain send could not be reconciled safely")
        journal.messages.push({ ...entry, id: matches[0].id })
        delete journal.pendingSends[operation]
        save()
    }
}

async function deleteKnownMessage(entry) {
    const current = await api("GET", `/channels/${entry.channelId}/messages/${entry.id}`)
    if (current.status === 404) return
    assert.equal(current.status, 200)
    assert.ok(ownedMessage(entry, current.data), "Known message no longer has test ownership")
    if (entry.edit !== undefined) {
        entry.marker = current.data.content
        delete entry.edit
        save()
    }
    const removed = await api("DELETE", `/channels/${entry.channelId}/messages/${entry.id}`)
    assert.ok(removed.status === 204 || removed.status === 404)
    assert.equal((await api("GET", `/channels/${entry.channelId}/messages/${entry.id}`)).status, 404)
}

async function deleteJournaledMessages() {
    await reconcilePendingSends()
    for (const entry of [...journal.messages]) {
        await deleteKnownMessage(entry)
        journal.messages = journal.messages.filter((candidate) => candidate !== entry)
        save()
    }
}

async function upgradeLegacyJournal() {
    assert.equal(journal.guildId, guildId)
    assert.equal(journal.botId, botId)
    assert.equal(journal.recipient, recipient, "Recovery requires authorization for the journaled recipient")
    assert.match(journal.marker, markerPattern)
    assert.ok(
        journal.dmId !== undefined || journal.dmWasOpen === false,
        "Legacy journal cannot prove a pending DM open",
    )
    for (const channelId of [journal.dmId, journal.groupId].filter(Boolean)) {
        assert.ok(id(channelId))
        for (const message of await scanMessages(channelId, undefined)) {
            if (
                message.author?.id !== botId ||
                typeof message.content !== "string" ||
                !message.content.startsWith(`${journal.marker}:`)
            )
                continue
            const entry = { channelId, id: message.id, marker: message.content }
            await deleteKnownMessage(entry)
        }
    }
    journal = {
        version: 2,
        guildId: journal.guildId,
        botId: journal.botId,
        recipient: journal.recipient,
        marker: journal.marker,
        dm:
            journal.dmId === undefined
                ? { wasOpen: false, opening: true }
                : { id: journal.dmId, wasOpen: journal.dmWasOpen === true },
        messages: [],
        pendingSends: {},
        ...(journal.profile === undefined ? {} : { profile: journal.profile }),
        ...(journal.groupId === undefined
            ? {}
            : { group: { id: journal.groupId, name: journal.groupName, recipients: journal.groupRecipients } }),
    }
    save()
}

async function restoreProfile() {
    if (!journal.profile) return
    const current = await api("GET", `/guilds/${guildId}/members/@me`)
    assert.equal(current.status, 200)
    assert.equal(current.data.user?.id, botId)
    const original = journal.profile.original
    const changed = journal.profile.changed
    const profileMatches = (profile) =>
        (current.data.nick ?? null) === profile.nick && (current.data.mention_flags ?? null) === profile.mention_flags
    assert.ok(profileMatches(original) || profileMatches(changed), "Unrelated profile change; preserve it")
    if (profileMatches(changed)) {
        assert.equal((await api("PATCH", `/guilds/${guildId}/members/@me`, original)).status, 200)
        const restored = await api("GET", `/guilds/${guildId}/members/@me`)
        assert.equal(restored.data.nick ?? null, original.nick)
        assert.equal(restored.data.mention_flags ?? null, original.mention_flags)
        report("bot_server_profile_restored")
    }
    delete journal.profile
    save()
}

async function restoreGroup() {
    if (!journal.group) return
    const current = await api("GET", `/channels/${journal.group.id}`)
    verifyGroup(current)
    const recipients = current.data.recipients.map((user) => user.id).sort()
    assert.ok(sameIds(recipients, journal.group.recipients), "Unrelated group membership change; preserve it")
    assert.ok(
        current.data.name === journal.group.name || current.data.name === journal.marker,
        "Unrelated group rename; preserve it",
    )
    if (current.data.name === journal.marker) {
        assert.equal((await api("PATCH", `/channels/${journal.group.id}`, { name: journal.group.name })).status, 200)
        const restored = await api("GET", `/channels/${journal.group.id}`)
        verifyGroup(restored)
        assert.equal(restored.data.name, journal.group.name)
        assert.ok(sameIds(restored.data.recipients.map((user) => user.id).sort(), journal.group.recipients))
        report("group_name_and_membership_restored")
    }
    delete journal.group
    save()
}

async function restoreDmState() {
    if (!journal.dm?.id || journal.dm.wasOpen) return
    const before = (await privateList()).filter((channel) => channel.id === journal.dm.id)
    if (before.length === 0) {
        assert.equal(journal.dm.closing, true, "Unrelated DM state; preserve it")
        return
    }
    assert.equal(before.length, 1, "Unrelated DM state; preserve it")
    assert.equal(before[0].type, 1)
    assert.ok(
        before[0].recipients?.some((user) => user.id === recipient),
        "Unrelated DM recipient; preserve it",
    )
    journal.dm.closing = true
    save()
    const removed = await api("DELETE", `/channels/${journal.dm.id}`)
    assert.ok(removed.status === 204 || removed.status === 404)
    assert.ok(!(await privateList()).some((channel) => channel.id === journal.dm.id))
}

async function cleanup() {
    if (!verified || !journal) return
    if (journal.version === 2) validateJournal()
    await authorizeRecoveryTargets()
    if (journal.version !== 2) await upgradeLegacyJournal()
    await reconcilePendingDmOpen()
    validateJournal()
    await deleteJournaledMessages()
    await restoreProfile()
    await restoreGroup()
    await restoreDmState()
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
        report("recovery_only_complete")
    } else {
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
            version: 2,
            guildId,
            botId,
            recipient,
            marker: `fluxerly-dm-${randomUUID().replaceAll("-", "")}`,
            dm: { wasOpen: !!existing, ...(existing ? { id: existing.id } : { opening: true }) },
            messages: [],
            pendingSends: {},
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
            journal.dm.id = dm.id
            delete journal.dm.opening
            save()
            assert.ok(dm.recipients.some((user) => user.id === recipient))
            const batch = prepareSend("latest-batch", dm.id)
            const sent = recordSent(
                "latest-batch",
                await value(bot.messages.send(dm.id, { content: batch.marker, allowedMentions: {} })),
            )
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
            await waitUntil(() =>
                presenceWrites.some((write) => write.status === "idle" && write.text === journal.marker),
            )
            report("presence_intent_written_after_ready", { providerAcknowledgement: false })
            stage = "open_dm"
            const dm = await value(bot.directMessages.open(recipient))
            journal.dm.id = dm.id
            delete journal.dm.opening
            save()
            assert.equal(dm.type, "dm")
            assert.ok(dm.recipients.some((user) => user.id === recipient))
            assert.equal((await value(bot.directMessages.open(recipient))).id, dm.id)
            assert.equal((await value(bot.directMessages.fetch(dm.id))).id, dm.id)
            assert.ok((await value(bot.directMessages.fetchAll())).some((channel) => channel.id === dm.id))
            report(stage)
            stage = "dm_send_and_readback"
            const hello = prepareSend("dm-hello", dm.id)
            const sent = recordSent(
                "dm-hello",
                await value(bot.directMessages.send(recipient, { content: hello.marker, allowedMentions: {} })),
            )
            assert.equal(sent.channelId, dm.id)
            const readback = await api("GET", `/channels/${dm.id}/messages/${sent.id}`)
            assert.equal(readback.data.author.id, botId)
            assert.equal(readback.data.content, hello.marker)
            const until = Date.now() + 10_000
            while (!seen.has(sent.id) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50))
            assert.ok(seen.has(sent.id), "DM gateway message not observed")
            const edited = `${journal.marker}:dm-edited`
            const recorded = journal.messages.find((entry) => entry.id === sent.id)
            assert.ok(recorded)
            recorded.edit = { intended: edited }
            save()
            await value(bot.messages.edit(sent, { content: edited }))
            assert.equal((await api("GET", `/channels/${dm.id}/messages/${sent.id}`)).data.content, edited)
            recorded.marker = edited
            delete recorded.edit
            save()
            report(stage)
            stage = "explicit_dm_latest_message_batch"
            const batch = prepareSend("dm-batch", dm.id)
            const batchMessage = recordSent(
                "dm-batch",
                await value(bot.messages.send(dm.id, { content: batch.marker })),
            )
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
            const lost = prepareSend("dm-lost", dm.id)
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
                    () => value(bot.directMessages.send(recipient, { content: lost.marker })),
                    (error) => error._tag === "MessageError" && error.delivery === "unknown",
                )
            } finally {
                globalThis.fetch = rawFetch
            }
            assert.equal(sends, 1)
            await reconcilePendingSends()
            assert.ok(journal.messages.some((entry) => entry.marker === lost.marker))
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
                    (write) =>
                        write.socket !== previousSocket && write.status === "idle" && write.text === journal.marker,
                ),
            )
            assert.equal(bot.state, "Connected")
            assert.equal(await cached(bot.users.get(recipient)), undefined)
            assert.equal(await cached(bot.directMessages.get(dm.id)), undefined)
            const recovery = prepareSend("dm-recovered", dm.id)
            const recovered = recordSent(
                "dm-recovered",
                await value(bot.messages.send(dm.id, { content: recovery.marker })),
            )
            assert.equal(
                (await api("GET", `/channels/${dm.id}/messages/${recovered.id}`)).data.content,
                recovery.marker,
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
                journal.group = {
                    id: groupId,
                    name: original.data.name,
                    recipients: original.data.recipients.map((user) => user.id).sort(),
                }
                save()
                const group = await value(bot.directMessages.fetch(groupId))
                assert.equal(group.type, "group")
                assert.equal(group.ownerId, recipient)
                await value(bot.directMessages.editGroup(group.id, { name: journal.marker }))
                assert.equal((await api("GET", `/channels/${group.id}`)).data.name, journal.marker)
                const groupSend = prepareSend("group-message", group.id)
                const groupMessage = recordSent(
                    "group-message",
                    await value(bot.messages.send(group.id, { content: groupSend.marker })),
                )
                assert.equal(
                    (await api("GET", `/channels/${group.id}/messages/${groupMessage.id}`)).data.content,
                    groupSend.marker,
                )
                report(stage)
            }
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
    let quiescent = true
    const retainEvidence = (finalizer) => {
        quiescent = false
        console.error(
            JSON.stringify({
                mode,
                check: "cleanup",
                passed: false,
                finalizer,
                journalRetained: journal !== undefined,
                lockRetained: lock !== undefined,
            }),
        )
        process.exitCode = 1
    }
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
    if (bot && bot.state !== "Closed")
        try {
            const stopped = bot.shutdown()
            await (Effect.isEffect(stopped) ? Effect.runPromise(stopped) : stopped)
        } catch {
            retainEvidence("bot_client_shutdown")
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
                JSON.stringify({ mode, check: "cleanup", passed: false, journalRetained: journal !== undefined }),
            )
            process.exitCode = 1
        }
    WebSocket.prototype.send = rawSend
    if (quiescent && lock !== undefined) {
        try {
            closeSync(lock)
            unlinkSync(lockPath)
        } catch {
            console.error(JSON.stringify({ mode, check: "lock_cleanup", passed: false, lockRetained: true }))
            process.exitCode = 1
        }
    }
    // Keep the deadline if a failed owned finalizer may have left a writer alive
    if (quiescent) clearTimeout(watchdog)
}
