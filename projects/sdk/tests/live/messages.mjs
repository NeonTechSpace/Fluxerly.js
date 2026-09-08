import assert from "node:assert/strict"
import { randomUUID, createHash } from "node:crypto"
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { parseEnv } from "node:util"
import WebSocket from "ws"
import { Logger } from "effect"
import { fromEffectLogger } from "@neontechspace/fluxerly/effect"
import { observeUploads, safeFailure } from "./upload-diagnostics.mjs"
import { createReactionEmoji, cleanupReactionEmoji } from "./reaction-fixture.mjs"
import { createGuildTestRole, cleanupGuildTestRole } from "./guild-fixture.mjs"

const rawFetch = globalThis.fetch
const mode = process.argv[2]
const recover = process.argv[3] === "--recover"
const diagnosticRecords = []
let diagnosticOverflow = false
const diagnosticLogger = Logger.make((entry) => {
    if (diagnosticRecords.length >= 100) {
        diagnosticOverflow = true
        return
    }
    diagnosticRecords.push({ message: entry.message, cause: entry.cause })
})
const manage = process.argv[3] === "--manage"
const changes = process.argv[3] === "--events"
const history = process.argv[3] === "--history"
const cache = process.argv[3] === "--cache"
const collectors = process.argv[3] === "--collectors"
const embeds = process.argv[3] === "--embeds"
const smallAttachments = process.argv[3] === "--attachments-small"
const attachments = process.argv[3] === "--attachments" || smallAttachments
const reactions = process.argv[3] === "--reactions"
const pins = process.argv[3] === "--pins"
const guilds = process.argv[3] === "--guilds"
const forceRecovery = recover || cache || collectors || attachments || reactions || pins || guilds
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const journalPath = new URL("../../.env.test.messages.local", import.meta.url)
const report = (check, passed) => console.log(JSON.stringify({ mode, check, passed }))
let stage = "configuration"
let lock
let token
let guildId
let verified = false
let journal
let gatewayProbe
const reportFailure = (error) => console.log(JSON.stringify({ mode, check: stage, ...safeFailure(error) }))

function observeGateway() {
    const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "emit")
    const original = WebSocket.prototype.emit
    const sockets = new Map()
    let malformed = false
    // Observe real inbound frames in this isolated test process without replacing transport, endpoints or SDK logic
    WebSocket.prototype.emit = function (event, ...args) {
        if (event === "open") sockets.set(this, { ready: 0, resumed: 0, heartbeat: 0 })
        const observed = sockets.get(this)
        if (observed && event === "message") {
            try {
                // Retain only protocol counters, never session IDs, credentials or message bodies
                const frame = JSON.parse(args[0].toString())
                if (frame.op === 0 && frame.t === "READY") observed.ready++
                if (frame.op === 0 && frame.t === "RESUMED") observed.resumed++
                if (frame.op === 11) observed.heartbeat++
            } catch {
                malformed = true
            }
        }
        return Reflect.apply(original, this, [event, ...args])
    }
    return {
        async interruptAndWait(client, states) {
            stage = "live_socket_interruption"
            assert.equal(client.state, "Connected")
            assert.equal(sockets.size, 1)
            const [first, initial] = [...sockets][0]
            const url = new URL(first.url)
            assert.equal(url.protocol, "wss:")
            assert.equal(url.host, "gateway.fluxer.app")
            assert.equal(initial.ready, 1)
            assert.equal(initial.resumed, 0)
            // Only this process's authenticated SDK socket is interrupted, never the host network or another bot
            first.terminate()
            report(stage, true)
            stage = "live_session_resume"
            const deadline = performance.now() + 45_000
            while (true) {
                assert.ok(!malformed && sockets.size <= 2)
                assert.ok(client.state !== "Closed" && performance.now() < deadline)
                const replacement = [...sockets][1]
                if (replacement) {
                    const [socket, observed] = replacement
                    // Re-identifying into a fresh READY session must not pass as successful session resumption
                    assert.equal(observed.ready, 0)
                    if (observed.resumed === 1 && observed.heartbeat > 0 && client.state === "Connected") {
                        assert.notEqual(socket, first)
                        assert.equal(first.readyState, WebSocket.CLOSED)
                        assert.ok(states.includes("Recovering"))
                        assert.ok(Number.isFinite(client.gatewayLatencyMs) && client.gatewayLatencyMs >= 0)
                        report("live_session_resumed", true)
                        report("post_resume_heartbeat", true)
                        break
                    }
                }
                await sleep(20)
            }
            stage = "post_resume_receive_and_reply"
        },
        verifyClosed() {
            assert.equal(sockets.size, 2)
            for (const socket of sockets.keys()) assert.equal(socket.readyState, WebSocket.CLOSED)
            report("recovery_sockets_closed", true)
        },
        restore() {
            if (descriptor) Object.defineProperty(WebSocket.prototype, "emit", descriptor)
            else delete WebSocket.prototype.emit
            sockets.clear()
        },
    }
}

async function api(method, path, body) {
    for (let attempt = 0; attempt < 3; attempt++) {
        // Direct sandbox readback must not share the SDK's temporary fetch observation in cache mode
        const response = await rawFetch(`https://api.fluxer.app/v1${path}`, {
            method,
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
            headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        const data = response.status === 204 ? null : await response.json().catch(() => null)
        if (response.status === 429 && attempt < 2) {
            const delay =
                Math.max(Number(response.headers.get("retry-after")) || 0, Number(data?.retry_after) || 0) * 1000
            assert.ok(Number.isFinite(delay) && delay > 0 && delay <= 10_000)
            await sleep(delay)
            continue
        }
        if (reactions && !response.ok && response.status !== 404) {
            const known = new Set([
                "INVALID_BASE64_FORMAT",
                "BASE64_LENGTH_INVALID",
                "INVALID_IMAGE_FORMAT",
                "IMAGE_SIZE_EXCEEDS_LIMIT",
                "FAILED_TO_UPLOAD_IMAGE",
                "STRING_LENGTH_INVALID",
            ])
            const validation = Array.isArray(data?.errors)
                ? data.errors.slice(0, 8).map((error) => ({
                      field: ["image", "name"].includes(error?.path) ? error.path : "unclassified",
                      code: known.has(error?.code)
                          ? error.code
                          : known.has(error?.message)
                            ? error.message
                            : "unclassified",
                  }))
                : []
            console.log(JSON.stringify({ mode, check: stage, method, status: response.status, validation }))
        }
        if (!response.ok && response.status !== 404)
            throw Object.assign(new Error("Sandbox HTTP request failed"), {
                status: response.status,
                ...(data?.code === "INVALID_FORM_BODY" ? { code: "INVALID_FORM_BODY" } : {}),
            })
        return { status: response.status, data }
    }
    throw new Error("Sandbox request budget exhausted")
}

async function verifyGuildMembers(ops, channelId, botId, interrupt) {
    stage = "guild_member_readback"
    const target = { guildId, userId: botId }
    const rawGuild = (await api("GET", `/guilds/${guildId}`)).data
    const fetchedGuild = await ops.guild()
    assert.equal(fetchedGuild.id, rawGuild.id)
    assert.equal(fetchedGuild.ownerId, rawGuild.owner_id)
    const before = (await api("GET", `/guilds/${guildId}/members/${botId}`)).data
    const fetched = await ops.member(target)
    assert.equal(fetched.userId, botId)
    assert.deepEqual([...fetched.roleIds].sort(), [...before.roles].sort())
    assert.deepEqual(await ops.self(), fetched)
    const page = await ops.page()
    const rawPage = (await api("GET", `/guilds/${guildId}/members?limit=2`)).data
    assert.deepEqual(
        page.map((member) => member.userId),
        rawPage.map((member) => member.user.id),
    )
    assert.ok(Object.isFrozen(fetched) && Object.isFrozen(fetched.roleIds))
    report(stage, true)
    stage = "test_role_creation"
    const roleId = await createGuildTestRole(
        api,
        journal,
        () => writeFileSync(journalPath, JSON.stringify(journal)),
        ops.createRole,
    )
    const seen = []
    const stop = await ops.on("guildMemberUpdate", (member) => {
        if (member.guildId === guildId && member.userId === botId) {
            assert.ok(seen.length < 16)
            seen.push(member)
        }
    })
    const waitRole = async (present) => {
        const deadline = performance.now() + 10_000
        while (!seen.some((member) => member.roleIds.includes(roleId) === present)) {
            assert.ok(performance.now() < deadline, "Member event deadline")
            await sleep(20)
        }
        seen.length = 0
        const actual = (await api("GET", `/guilds/${guildId}/members/${botId}`)).data
        assert.deepEqual([...actual.roles].sort(), [...before.roles, ...(present ? [roleId] : [])].sort())
        assert.deepEqual([...(await ops.member(target)).roleIds].sort(), [...actual.roles].sort())
    }
    try {
        stage = "reaction_role_workflow"
        const message = await ops.send()
        const collector = await ops.collect(message, target, roleId)
        try {
            await ops.react(message)
            assert.equal((await collector.wait()).reason, "limit")
            await waitRole(true)
            const raw = (await api("GET", `/channels/${channelId}/messages/${message.id}`)).data
            assert.equal(raw.content, "SDK role assigned")
        } finally {
            await collector.stop()
        }
        await ops.remove(target, roleId)
        await waitRole(false)
        report(stage, true)
        await verifyGuildCache(ops, target, roleId)
        await interrupt()
        assert.equal(await ops.getGuild(), undefined)
        assert.equal(await ops.getMember(target), undefined)
        assert.equal(await ops.getRole(roleId), undefined)
        report("guild_cache_gap_clear", true)
        stage = "member_role_after_resume"
        await ops.add(target, roleId)
        await waitRole(true)
        await ops.remove(target, roleId)
        await waitRole(false)
        assert.deepEqual(fetched.roleIds, before.roles)
        report(stage, true)
        await verifyGuildRoles(ops, roleId)
    } finally {
        await stop()
    }
}

async function verifyGuildCache(ops, target, roleId) {
    stage = "guild_cache_local_lookup"
    const guild = await ops.guild()
    const member = await ops.member(target)
    const roles = await ops.roles()
    const role = roles.find((value) => value.id === roleId)
    assert.ok(role)
    const originalFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = (...args) => {
        requests++
        return originalFetch(...args)
    }
    try {
        for (let index = 0; index < 10; index++) {
            assert.deepEqual(await ops.getGuild(), guild)
            assert.deepEqual(await ops.getMember(target), member)
            assert.deepEqual(await ops.getRole(roleId), role)
        }
        assert.equal(requests, 0)
    } finally {
        globalThis.fetch = originalFetch
    }
    report(stage, true)

    const waitColor = async (color) => {
        const deadline = performance.now() + 10_000
        while ((await ops.getRole(roleId))?.color !== color) {
            assert.ok(performance.now() < deadline, "Cached role event deadline")
            await sleep(20)
        }
    }
    stage = "guild_cache_external_event"
    const changed = await api("PATCH", `/guilds/${guildId}/roles/${roleId}`, { color: 0x345678 })
    assert.equal(changed.status, 200)
    await waitColor(0x345678)
    report(stage, true)

    stage = "guild_cache_uncertain_write"
    let dispatched = 0
    globalThis.fetch = async (...args) => {
        const response = await originalFetch(...args)
        if (args[1]?.method === "PATCH" && new URL(args[0]).pathname === `/v1/guilds/${guildId}/roles/${roleId}`) {
            dispatched++
            assert.equal(response.status, 200)
            await response.arrayBuffer()
            // The owned role really changed; lose the response only after its real gateway event was observed
            await waitColor(0x456789)
            throw new Error("Test-owned response loss")
        }
        return response
    }
    try {
        await assert.rejects(ops.editRole(roleId, { color: 0x456789 }), (error) => error.outcome === "unknown")
        assert.equal(dispatched, 1)
        assert.equal(await ops.getRole(roleId), undefined)
    } finally {
        globalThis.fetch = originalFetch
    }
    const readback = (await api("GET", `/guilds/${guildId}/roles`)).data.find((value) => value.id === roleId)
    assert.equal(readback.color, 0x456789)
    await ops.roles()
    assert.equal((await ops.getRole(roleId)).color, readback.color)
    report(stage, true)
}

async function verifyGuildRoles(ops, roleId) {
    stage = "role_management_after_resume"
    const seen = []
    const stops = []
    for (const event of ["guildRoleCreate", "guildRoleUpdate", "guildRoleUpdateBulk", "guildRoleDelete"]) {
        stops.push(
            await ops.on(event, (value) => {
                if (value.guildId !== guildId) return
                assert.ok(seen.length < 64)
                seen.push({ event, value })
            }),
        )
    }
    const waitEvent = async (event, predicate) => {
        const deadline = performance.now() + 10_000
        while (!seen.some((item) => item.event === event && predicate(item.value))) {
            assert.ok(performance.now() < deadline, "Role event deadline")
            await sleep(20)
        }
    }
    try {
        journal.secondRole = { guildId }
        stage = "role_create"
        const secondId = await createGuildTestRole(
            api,
            journal.secondRole,
            () => writeFileSync(journalPath, JSON.stringify(journal)),
            ops.createRole,
        )
        stage = "role_create_event"
        await waitEvent("guildRoleCreate", (role) => role.id === secondId && role.permissions === 0n)
        stage = "role_list_readback"
        const listed = await ops.roles()
        const raw = (await api("GET", `/guilds/${guildId}/roles`)).data
        assert.deepEqual(
            listed.map((role) => role.id),
            raw.map((role) => role.id),
        )
        for (const role of listed) {
            const independent = raw.find((item) => item.id === role.id)
            assert.equal(role.permissions.toString(), independent.permissions)
            assert.equal(role.position, independent.position)
        }
        const first = listed.find((role) => role.id === roleId)
        const second = listed.find((role) => role.id === secondId)
        assert.ok(first && second)
        const beforeOrder = listed.indexOf(first) - listed.indexOf(second)
        stage = "role_edit_readback"
        const edited = await ops.editRole(roleId, { color: 0x123456, permissions: 0n })
        assert.equal(edited.color, 0x123456)
        assert.equal(edited.permissions, 0n)
        stage = "role_edit_event"
        await waitEvent("guildRoleUpdate", (role) => role.id === roleId && role.color === 0x123456)
        assert.equal(
            (await api("GET", `/guilds/${guildId}/roles`)).data.find((role) => role.id === roleId).color,
            0x123456,
        )
        stage = "role_reorder"
        await ops.reorderRoles([
            { id: roleId, position: first.position === second.position ? (beforeOrder < 0 ? 0 : 1) : second.position },
            { id: secondId, position: first.position === second.position ? (beforeOrder < 0 ? 1 : 0) : first.position },
        ])
        stage = "role_reorder_readback"
        const reordered = await ops.roles()
        const firstAfter = reordered.find((role) => role.id === roleId)
        const secondAfter = reordered.find((role) => role.id === secondId)
        assert.ok(firstAfter && secondAfter)
        assert.ok((reordered.indexOf(firstAfter) - reordered.indexOf(secondAfter)) * beforeOrder < 0)
        const untouched = (roles) =>
            roles.filter((role) => role.id !== roleId && role.id !== secondId).map((role) => role.id)
        assert.deepEqual(untouched(reordered), untouched(listed))
        const readback = (await api("GET", `/guilds/${guildId}/roles`)).data
        assert.deepEqual(
            reordered.map((role) => [role.id, role.position]),
            readback.map((role) => [role.id, role.position]),
        )
        stage = "role_reorder_event"
        await waitEvent("guildRoleUpdateBulk", (value) =>
            value.roles.some(
                (role) =>
                    (role.id === roleId && role.position === firstAfter.position && role.position !== first.position) ||
                    (role.id === secondId &&
                        role.position === secondAfter.position &&
                        role.position !== second.position),
            ),
        )
        for (const id of [roleId, secondId]) {
            stage = "role_delete"
            await ops.deleteRole(id)
            stage = "role_delete_event"
            await waitEvent("guildRoleDelete", (role) => role.id === id)
        }
        stage = "role_delete_readback"
        const after = (await api("GET", `/guilds/${guildId}/roles`)).data
        assert.ok(!after.some((role) => role.id === roleId || role.id === secondId))
        assert.deepEqual(untouched(after), untouched(listed))
        const member = (await api("GET", `/guilds/${guildId}/members/@me`)).data
        assert.ok(!member.roles.includes(roleId) && !member.roles.includes(secondId))
        stage = "role_management_after_resume"
        report(stage, true)
    } finally {
        for (const stop of stops) await stop()
    }
}

async function verifyReactions(ops, channelId, botId, interrupt) {
    stage = "reaction_custom_emoji_prerequisite"
    const emoji = await createReactionEmoji(
        api,
        journal,
        () => writeFileSync(journalPath, JSON.stringify(journal)),
        botId,
    )
    const customPath = encodeURIComponent(`${emoji.name}:${emoji.id}`)
    const message = await ops.send({ content: "SDK reaction verification" })
    const received = []
    const stops = []
    const collect = async (options) => {
        const collector = await ops.collect(message, { timeoutMs: 10_000, ...options })
        stops.push(() => collector.stop())
        return collector
    }
    const wait = async (event, matches = () => true) => {
        const deadline = performance.now() + 10_000
        while (performance.now() < deadline) {
            const index = received.findIndex((item) => item.event === event && matches(item.value))
            if (index !== -1) return received.splice(index, 1)[0].value
            await sleep(20)
        }
        throw Error("Reaction event deadline")
    }
    const reactors = async (path) => {
        const result = await api("GET", `/channels/${channelId}/messages/${message.id}/reactions/${path}`)
        assert.equal(result.status, 200)
        assert.ok(Array.isArray(result.data))
        return result.data.map((user) => user.id)
    }
    try {
        for (const event of [
            "messageReactionAdd",
            "messageReactionRemove",
            "messageReactionRemoveAll",
            "messageReactionRemoveEmoji",
        ])
            stops.push(
                await ops.on(event, (value) => {
                    if (value.id === message.id && value.channelId === channelId) {
                        assert.ok(received.length < 32)
                        received.push({ event, value })
                    }
                }),
            )
        stage = "reaction_collector_timeout_and_stop"
        const timed = await collect({ timeoutMs: 50 })
        assert.deepEqual(await timed.wait(), { reason: "timeout", reactions: [] })
        const stopped = await collect({})
        await stopped.stop()
        assert.deepEqual(await stopped.wait(), { reason: "stopped", reactions: [] })
        report(stage, true)
        const selected = await collect({
            emoji,
            filter: (reaction) => reaction.userId === botId,
        })
        stage = "unicode_reaction_add_readback"
        await ops.add(message, "👍")
        const added = await wait("messageReactionAdd", (value) => value.emoji.name === "👍")
        assert.equal(added.userId, botId)
        assert.deepEqual(await reactors(encodeURIComponent("👍")), [botId])
        report(stage, true)
        stage = "custom_reaction_add_readback"
        await ops.add(message, emoji)
        assert.equal((await wait("messageReactionAdd", (value) => value.emoji.id === emoji.id)).userId, botId)
        assert.deepEqual(await reactors(customPath), [botId])
        report(stage, true)
        stage = "reaction_collector_selected_custom_addition"
        const collected = await selected.wait()
        assert.equal(collected.reason, "limit")
        assert.equal(collected.reactions.length, 1)
        assert.equal(collected.reactions[0].id, message.id)
        assert.equal(collected.reactions[0].channelId, channelId)
        assert.equal(collected.reactions[0].userId, botId)
        assert.equal(collected.reactions[0].emoji.id, emoji.id)
        assert.ok(
            Object.isFrozen(collected) &&
                Object.isFrozen(collected.reactions) &&
                Object.isFrozen(collected.reactions[0]),
        )
        report(stage, true)
        stage = "reaction_users_page_readback"
        for (const [input, path] of [
            ["👍", encodeURIComponent("👍")],
            [emoji, customPath],
        ]) {
            const page = await ops.users(message, input, { limit: 1 })
            const raw = await api(
                "GET",
                `/channels/${channelId}/messages/${message.id}/reactions/${path}/users?limit=1`,
            )
            assert.equal(raw.status, 200)
            assert.deepEqual(page, {
                items: raw.data.items.map((user) => ({
                    id: user.id,
                    username: user.username,
                    isBot: user.bot === true,
                })),
                hasMore: raw.data.has_more,
                nextAfter: raw.data.next_after,
            })
            assert.deepEqual(
                page.items.map((user) => user.id),
                [botId],
            )
            assert.ok(Object.isFrozen(page) && Object.isFrozen(page.items) && Object.isFrozen(page.items[0]))
            assert.deepEqual(await ops.users(message, input, { after: botId }), {
                items: [],
                hasMore: false,
                nextAfter: null,
            })
        }
        report(stage, true)
        stage = "own_reaction_remove"
        const guild = (await api("GET", `/guilds/${guildId}`)).data
        assert.equal(guild.id, guildId)
        assert.match(guild.owner_id, /^\d+$/)
        assert.notEqual(guild.owner_id, botId)
        stage = "named_reaction_removal"
        // This test-owned message has only the bot's reactions; targeting the guild owner must preserve them
        await ops.removeUser(message, "👍", guild.owner_id)
        assert.equal(
            (await wait("messageReactionRemove", (value) => value.userId === guild.owner_id)).userId,
            guild.owner_id,
        )
        assert.deepEqual(await reactors(encodeURIComponent("👍")), [botId])
        await ops.removeUser(message, "👍", botId)
        await wait("messageReactionRemove", (value) => value.userId === botId)
        assert.deepEqual(await reactors(encodeURIComponent("👍")), [])
        assert.deepEqual(await reactors(customPath), [botId])
        await ops.add(message, "👍")
        await wait("messageReactionAdd", (value) => value.emoji.name === "👍")
        report(stage, true)
        stage = "own_reaction_remove"
        await ops.remove(message, "👍")
        assert.equal((await wait("messageReactionRemove", (value) => value.emoji.name === "👍")).userId, botId)
        assert.deepEqual(await reactors(encodeURIComponent("👍")), [])
        assert.deepEqual(await reactors(customPath), [botId])
        report(stage, true)
        stage = "reaction_progress_edit_readback"
        const progress = await collect({ emoji: "🔥", maxReactions: 2, progressEdit: "SDK reaction progress observed" })
        for (let index = 0; index < 2; index++) {
            await ops.add(message, "🔥")
            await wait("messageReactionAdd", (value) => value.emoji.name === "🔥")
            const deadline = performance.now() + 10_000
            let verified = false
            while (performance.now() < deadline) {
                const raw = await api("GET", `/channels/${channelId}/messages/${message.id}`)
                if (raw.status === 200 && raw.data.content === `SDK reaction progress observed ${index + 1}`) {
                    verified = true
                    break
                }
                await sleep(100)
            }
            assert.ok(verified, "Progress edit was not visible through raw API")
            await ops.remove(message, "🔥")
            await wait("messageReactionRemove", (value) => value.emoji.name === "🔥")
        }
        assert.equal((await progress.wait()).reason, "limit")
        report(stage, true)
        stage = "reaction_progress_failure"
        const failedProgress = await collect({ progressEdit: "SDK missing progress target", progressFailure: true })
        const failedResult = failedProgress.wait().catch((error) => error)
        await ops.add(message, "🔥")
        await wait("messageReactionAdd", (value) => value.emoji.name === "🔥")
        assert.equal((await failedResult).reason, "handler")
        await ops.remove(message, "🔥")
        await wait("messageReactionRemove", (value) => value.emoji.name === "🔥")
        report(stage, true)
        let progressStarted = false,
            progressCleaned = false
        const gap = await collect({
            emoji: "🔥",
            timeoutMs: 30_000,
            maxReactions: 2,
            progressWait: true,
            onProgress: (state) => {
                if (state === "started") progressStarted = true
                else progressCleaned = true
            },
        })
        // Attach the failure observer before interruption to avoid an unhandled expected rejection
        const gapResult = gap.wait().then(
            () => null,
            (error) => error,
        )
        await ops.add(message, "🔥")
        await wait("messageReactionAdd", (value) => value.emoji.name === "🔥")
        const progressDeadline = performance.now() + 10_000
        while (!progressStarted && performance.now() < progressDeadline) await sleep(20)
        assert.ok(progressStarted)
        await interrupt()
        stage = "reaction_collector_connection_gap"
        const gapError = await gapResult
        assert.equal(gapError?._tag, "CollectorError")
        assert.equal(gapError.reason, "connectionLost")
        assert.ok(progressCleaned)
        report(stage, true)
        const resumedCollector = await collect({
            emoji: "👍",
            filter: (reaction) => reaction.userId === botId,
        })
        stage = "reaction_subscription_after_resume"
        await ops.remove(message, emoji)
        await wait("messageReactionRemove", (value) => value.emoji.id === emoji.id)
        assert.deepEqual(await reactors(customPath), [])
        assert.deepEqual(await ops.users(message, emoji), { items: [], hasMore: false, nextAfter: null })
        await ops.add(message, "👍")
        await wait("messageReactionAdd")
        const resumedResult = await resumedCollector.wait()
        assert.equal(resumedResult.reason, "limit")
        assert.equal(resumedResult.reactions.length, 1)
        assert.equal(resumedResult.reactions[0].userId, botId)
        assert.equal(resumedResult.reactions[0].emoji.name, "👍")
        report(stage, true)
        stage = "message_read_paths_after_resume"
        const read = await ops.reads(message)
        const remote = await api("GET", `/channels/${channelId}/messages/${message.id}`)
        assert.equal(remote.status, 200)
        assert.equal(read.message.id, remote.data.id)
        assert.equal(read.message.content, remote.data.content)
        assert.deepEqual(
            read.history.map((item) => item.id),
            [message.id],
        )
        const remotePins = await api("GET", `/channels/${channelId}/messages/pins?limit=1`)
        assert.equal(remotePins.status, 200)
        assert.deepEqual(
            read.pins.items.map((item) => item.message.id),
            remotePins.data.items.map((item) => item.message.id),
        )
        assert.equal(read.pins.hasMore, remotePins.data.has_more)
        report(stage, true)
        stage = "reaction_clear_emoji_event"
        await ops.add(message, emoji)
        await wait("messageReactionAdd", (value) => value.emoji.id === emoji.id)
        await ops.clearEmoji(message, "👍")
        await wait("messageReactionRemoveEmoji", (value) => value.emoji.name === "👍")
        assert.deepEqual(await reactors(encodeURIComponent("👍")), [])
        assert.deepEqual(await reactors(customPath), [botId])
        report(stage, true)
        stage = "reaction_clear_all_event"
        await ops.add(message, "👍")
        await wait("messageReactionAdd")
        await ops.clearAll(message)
        await wait("messageReactionRemoveAll")
        assert.deepEqual(await reactors(encodeURIComponent("👍")), [])
        assert.deepEqual(await reactors(customPath), [])
        report(stage, true)
        stage = "reaction_users_missing_message"
        assert.equal((await api("DELETE", `/channels/${channelId}/messages/${message.id}`)).status, 204)
        await assert.rejects(ops.users(message, "👍"), {
            _tag: "MessageOperationError",
            operation: "fetchReactionUsers",
            reason: "notFound",
        })
        report(stage, true)
    } finally {
        for (const stop of stops) await stop()
    }
}

async function verifyPins(ops, channelId, interrupt) {
    stage = "pin_fixture_messages"
    const first = await ops.send({ content: "SDK pin verification one" })
    const second = await ops.send({ content: "SDK pin verification two" })
    assert.equal(first.channelId, channelId)
    assert.equal(second.channelId, channelId)
    assert.equal(first.pinned, false)
    const updates = []
    const notices = []
    const stops = []
    const wait = async (items, matches) => {
        const deadline = performance.now() + 10_000
        while (performance.now() < deadline) {
            const index = items.findIndex(matches)
            if (index !== -1) return items.splice(index, 1)[0]
            await sleep(20)
        }
        throw Error("Pin event deadline")
    }
    const read = async (message) => {
        const response = await api("GET", `/channels/${channelId}/messages/${message.id}`)
        assert.equal(response.status, 200)
        assert.equal(response.data.id, message.id)
        assert.equal(response.data.channel_id, channelId)
        return response.data
    }
    const page = async (query) => {
        const result = await ops.pins(query)
        const params = new URLSearchParams({ limit: String(query.limit ?? 50) })
        if (query.before) params.set("before", query.before)
        const raw = await api("GET", `/channels/${channelId}/messages/pins?${params}`)
        assert.equal(raw.status, 200)
        assert.deepEqual(
            result.items.map((item) => ({ id: item.message.id, pinned: item.message.pinned, time: item.pinnedAt })),
            raw.data.items.map((item) => ({ id: item.message.id, pinned: item.message.pinned, time: item.pinned_at })),
        )
        assert.equal(result.hasMore, raw.data.has_more)
        assert.equal(result.nextBefore, result.hasMore ? result.items.at(-1).pinnedAt : null)
        assert.ok(Object.isFrozen(result) && Object.isFrozen(result.items))
        return result
    }
    try {
        stops.push(
            await ops.on("messageUpdate", (value) => {
                if (value.channelId === channelId && [first.id, second.id].includes(value.id)) {
                    assert.ok(updates.length < 32)
                    updates.push(value)
                }
            }),
        )
        stops.push(
            await ops.on("channelPinsUpdate", (value) => {
                if (value.channelId === channelId) {
                    assert.ok(notices.length < 32)
                    notices.push(value)
                }
            }),
        )
        stage = "pin_state_and_events"
        await ops.pin(first)
        assert.equal((await read(first)).pinned, true)
        assert.equal((await wait(updates, (item) => item.id === first.id && item.pinned === true)).pinned, true)
        const notice = await wait(notices, () => true)
        assert.ok(Object.isFrozen(notice))
        assert.equal(typeof notice.lastPinTimestamp, "string")
        await ops.pin(first)
        assert.equal((await page({})).items.length, 1)
        await ops.pin(second)
        await wait(updates, (item) => item.id === second.id && item.pinned === true)
        await wait(notices, () => true)
        report(stage, true)
        stage = "pin_pages_readback"
        const firstPage = await page({ limit: 1 })
        assert.equal(firstPage.items.length, 1)
        assert.equal(firstPage.hasMore, true)
        await page({ limit: 1, before: firstPage.nextBefore })
        assert.deepEqual(new Set((await page({})).items.map((item) => item.message.id)), new Set([first.id, second.id]))
        report(stage, true)
        await interrupt()
        stage = "unpin_after_resume_preserves_message"
        await ops.unpin(first)
        assert.equal((await read(first)).pinned, false)
        assert.equal((await read(first)).content, first.content)
        assert.equal((await read(second)).pinned, true)
        await wait(updates, (item) => item.id === first.id && item.pinned === false)
        await wait(notices, () => true)
        assert.deepEqual(
            (await page({})).items.map((item) => item.message.id),
            [second.id],
        )
        await ops.unpin(first)
        await ops.unpin(second)
        await wait(updates, (item) => item.id === second.id && item.pinned === false)
        await wait(notices, () => true)
        assert.deepEqual(await page({}), { items: [], hasMore: false, nextBefore: null })
        report(stage, true)
        stage = "pin_missing_target_failure"
        assert.equal((await api("DELETE", `/channels/${channelId}/messages/${first.id}`)).status, 204)
        await assert.rejects(ops.pin(first), { _tag: "MessageOperationError", operation: "pin", reason: "notFound" })
        report(stage, true)
    } finally {
        for (const stop of stops) await stop()
    }
}

function cacheOptions() {
    return {
        messages: {
            maxEntries: 1_000,
            maxBytes: 8 * 1024 * 1024,
            // Keep default live fixtures indefinitely while proving active expiry with one explicitly marked snapshot
            maxAgeMs: (message) => (message.content.startsWith("cache-expire-") ? 100 : null),
        },
    }
}

async function waitForCache(get, target, matches) {
    const deadline = performance.now() + 10_000
    while (true) {
        const snapshot = await get(target)
        if (matches(snapshot)) return snapshot
        assert.ok(performance.now() < deadline)
        await sleep(20)
    }
}

async function verifyAttachments(ops, channelId) {
    const filename = `fixture-${randomUUID()}.bin`
    const data = new Uint8Array((smallAttachments ? 1 : 50) * 1024 * 1024)
    for (let index = 0; index < data.length; index++) data[index] = index % 251
    const digest = createHash("sha256").update(data).digest("hex")
    stage = "attachments_collector_registration"
    const wait = await ops.collect({
        filter: (message) => message.attachments.some((file) => file.filename === filename),
        timeoutMs: 90_000,
    })
    report(stage, true)
    stage = smallAttachments ? "attachments_1_mib_send" : "attachments_50_mib_send"
    const sent = await ops.send(
        {
            attachments: [
                {
                    data,
                    filename,
                    contentType: "application/octet-stream",
                    title: "SDK fixture",
                    description: "Nonprivate binary verification fixture",
                    spoiler: true,
                },
            ],
        },
        { timeoutMs: 60_000 },
    )
    const file = sent.attachments[0]
    stage = "attachments_created_metadata"
    assert.equal(sent.attachments.length, 1)
    assert.equal(file.filename, filename)
    assert.equal(file.size, data.length)
    assert.equal(file.title, "SDK fixture")
    assert.equal(file.description, "Nonprivate binary verification fixture")
    assert.ok((file.flags & 8) !== 0)
    assert.ok(Object.isFrozen(sent.attachments) && Object.isFrozen(file))
    report(stage, true)
    stage = "attachments_download_byte_readback"
    const url = new URL(file.url)
    assert.equal(url.protocol, "https:")
    assert.ok(
        url.hostname === "fluxerusercontent.com" ||
            url.hostname.endsWith(".fluxerusercontent.com") ||
            url.hostname === "fluxer.app" ||
            url.hostname.endsWith(".fluxer.app"),
    )
    const download = await rawFetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) })
    assert.ok(download.ok)
    const hash = createHash("sha256")
    let size = 0
    for await (const chunk of download.body) {
        size += chunk.length
        assert.ok(size <= data.length)
        hash.update(chunk)
    }
    assert.equal(size, data.length)
    assert.equal(hash.digest("hex"), digest)
    report(stage, true)
    stage = "attachments_events_cache_and_history"
    const collected = await wait()
    assert.equal(collected.messages[0]?.attachments[0]?.id, file.id)
    await waitForCache(ops.get, sent, (message) => message?.attachments[0]?.id === file.id)
    assert.equal((await ops.fetch(sent)).attachments[0]?.id, file.id)
    assert.ok((await ops.history()).some((message) => message.id === sent.id && message.attachments[0]?.id === file.id))
    const raw = (await api("GET", `/channels/${channelId}/messages/${sent.id}`)).data
    assert.equal(raw.attachments[0].size, data.length)
    report(stage, true)
    stage = "attachments_reply_retain_add_remove"
    const small = { data: new Uint8Array([0, 1, 255, 13, 10]), filename: "small.bin" }
    const replied = await ops.reply(sent, { attachments: [small] })
    assert.equal(replied.attachments[0]?.size, 5)
    const replyWire = (await api("GET", `/channels/${channelId}/messages/${replied.id}`)).data
    assert.equal(replyWire.message_reference.message_id, sent.id)
    assert.equal((await ops.edit(sent, { content: "Keep existing file" })).attachments[0]?.id, file.id)
    const added = await ops.edit(sent, { attachments: [{ id: file.id }, small] })
    assert.equal(added.attachments.length, 2)
    assert.ok(added.attachments.some((item) => item.id === file.id))
    const kept = added.attachments.find((item) => item.id !== file.id)
    assert.equal((await ops.edit(sent, { attachments: [{ id: kept.id }] })).attachments[0]?.id, kept.id)
    // Raw mutation verifies gateway projection/cache update independently of SDK REST intake
    await api("PATCH", `/channels/${channelId}/messages/${sent.id}`, { content: "Gateway cleared", attachments: [] })
    await waitForCache(
        ops.get,
        sent,
        (message) => message?.content === "Gateway cleared" && message.attachments.length === 0,
    )
    assert.equal(collected.messages[0].attachments[0].id, file.id)
    const cleared = await ops.edit(replied, { content: "SDK cleared", attachments: [] })
    assert.deepEqual(cleared.attachments, [])
    assert.deepEqual((await api("GET", `/channels/${channelId}/messages/${replied.id}`)).data.attachments ?? [], [])
    const rejected = await ops.editFailure(replied, { attachments: [] })
    assert.equal(rejected.reason, "input")
    report(stage, true)
}

async function verifyEmbeds(ops, channelId) {
    stage = "embeds_send_collect_and_cache"
    const imageUrl = "https://fluxer.app/static/img/web-apple-touch-icon.d11b564b6ae672d1.png"
    const title = `embed-${randomUUID()}`
    const wait = await ops.collect({
        filter: (message) => message.embeds.some((embed) => embed.title === title),
        timeoutMs: 10_000,
    })
    const waiting = wait()
    // Observe failure immediately while the send is in flight
    waiting.catch(() => {})
    const sent = await ops.send({
        embeds: [
            {
                title,
                description: "SDK-owned sandbox embed",
                url: "https://fluxer.app",
                color: 0x3d66b8,
                timestamp: "2026-09-08T14:30:00.000Z",
                author: { name: "Sandbox bot", url: "https://fluxer.app", iconUrl: imageUrl },
                footer: { text: "Owned fixture", iconUrl: imageUrl },
                image: { url: imageUrl, description: "Fluxer public icon" },
                thumbnail: { url: imageUrl, description: "Fluxer public thumbnail" },
                fields: [
                    { name: "Status", value: "Passed", inline: true },
                    { name: "Details", value: "Verified" },
                ],
            },
        ],
    })
    stage = "embeds_created_snapshot"
    assert.equal(sent.content, "")
    assert.equal(sent.embeds[0]?.title, title)
    assert.ok(Object.isFrozen(sent.embeds) && Object.isFrozen(sent.embeds[0]?.fields?.[0]))
    const collected = await waiting
    stage = "embeds_collected_snapshot"
    assert.equal(collected.messages[0]?.id, sent.id)
    assert.equal(collected.messages[0]?.embeds[0]?.title, title)
    await waitForCache(ops.get, sent, (message) => message?.embeds[0]?.title === title)
    const actual = (await api("GET", `/channels/${channelId}/messages/${sent.id}`)).data
    stage = "embeds_independent_readback"
    assert.equal(actual?.embeds?.[0]?.title, title)
    assert.equal(actual?.embeds?.[0]?.fields?.[1]?.inline, false)
    stage = "embeds_destination_url"
    assert.equal(new URL(actual?.embeds?.[0]?.url).href, "https://fluxer.app/")
    stage = "embeds_image_url"
    assert.equal(actual?.embeds?.[0]?.image?.url, imageUrl)
    stage = "embeds_thumbnail_url"
    assert.equal(actual?.embeds?.[0]?.thumbnail?.url, imageUrl)
    stage = "embeds_icon_projection"
    assert.equal(sent.embeds[0]?.author?.iconUrl, imageUrl)
    assert.equal(sent.embeds[0]?.footer?.iconUrl, imageUrl)
    stage = "embeds_media_description_projection"
    assert.equal(sent.embeds[0]?.image?.description, "Fluxer public icon")
    assert.equal(sent.embeds[0]?.thumbnail?.description, "Fluxer public thumbnail")
    assert.equal((await ops.fetch(sent)).embeds[0]?.title, title)
    assert.ok((await ops.history()).some((message) => message.id === sent.id && message.embeds[0]?.title === title))
    report(stage, true)

    stage = "embeds_reply_and_edit"
    const replied = await ops.reply(sent, { embeds: [{ title: "Embed reply" }] })
    const replyWire = (await api("GET", `/channels/${channelId}/messages/${replied.id}`)).data
    assert.equal(replyWire?.message_reference?.message_id, sent.id)
    assert.equal(replyWire?.embeds?.[0]?.title, "Embed reply")
    assert.equal(replyWire?.mention_everyone, false)
    const preserved = await ops.edit(sent, { content: "Text alongside embed" })
    assert.equal(preserved.embeds[0]?.title, title)
    const replacement = await ops.edit(sent, { embeds: [{ title: "Replacement" }] })
    assert.equal(replacement.content, "Text alongside embed")
    assert.deepEqual(
        replacement.embeds.map((embed) => embed.title),
        ["Replacement"],
    )
    // Mutate through independent HTTP so cache readback establishes gateway update intake, not REST intake
    await api("PATCH", `/channels/${channelId}/messages/${sent.id}`, { embeds: [{ title: "Gateway update" }] })
    await waitForCache(ops.get, sent, (message) => message?.embeds[0]?.title === "Gateway update")
    assert.equal(collected.messages[0]?.embeds[0]?.title, title)
    report(stage, true)

    stage = "embeds_empty_edit_rejection_and_clear"
    const rejected = await ops.editFailure(sent, { embeds: [] })
    assert.equal(rejected?._tag, "MessageOperationError")
    assert.equal(rejected?.reason, "rejected")
    assert.equal(rejected?.status, 400)
    assert.equal((await ops.fetch(sent)).embeds[0]?.title, "Gateway update")
    const cleared = await ops.edit(sent, { content: "Plain text", embeds: [] })
    assert.deepEqual(cleared.embeds, [])
    const readback = (await api("GET", `/channels/${channelId}/messages/${sent.id}`)).data
    assert.equal(readback?.content, "Plain text")
    assert.deepEqual(readback?.embeds ?? [], [])
    report(stage, true)
}

async function verifyCacheProjectionConflict(send, fetch, get, channelId) {
    stage = "cache_full_projection_conflict"
    const sent = await send(channelId, { content: "Cache conflict verification", embeds: [{ description: "before" }] })
    const originalFetch = globalThis.fetch
    let release
    const waiting = new Promise((resolve) => {
        release = resolve
    })
    let ready = false
    let held = false
    globalThis.fetch = async (...args) => {
        const response = await originalFetch(...args)
        if (
            !held &&
            args[1]?.method === "GET" &&
            new URL(args[0]).pathname === `/v1/channels/${channelId}/messages/${sent.id}`
        ) {
            held = true
            const json = response.json.bind(response)
            response.json = async () => {
                const body = await json()
                ready = true
                await waiting
                return body
            }
        }
        return response
    }
    const pending = fetch(sent)
    const settled = pending.catch(() => undefined)
    try {
        const deadline = performance.now() + 10_000
        while (!ready) {
            assert.ok(performance.now() < deadline, "Held read deadline")
            await sleep(20)
        }
        // Hold only consumption of an actual old HTTP response; do not fabricate its body or a gateway event
        const changed = await api("PATCH", `/channels/${channelId}/messages/${sent.id}`, {
            embeds: [{ description: "after" }],
        })
        assert.equal(changed.status, 200)
        await waitForCache(get, sent, (snapshot) => snapshot?.embeds[0]?.description === "after")
        release()
        assert.equal((await pending).embeds[0]?.description, "before")
        assert.equal(await get(sent), undefined)
        const remote = await api("GET", `/channels/${channelId}/messages/${sent.id}`)
        assert.equal(remote.data?.embeds[0]?.description, "after")
        report(stage, true)
    } finally {
        release()
        await settled
        globalThis.fetch = originalFetch
    }
}

async function verifyCacheExpiry(send, get, channelId) {
    stage = "cache_active_expiry"
    const sent = await send(channelId, { content: `cache-expire-${randomUUID()}` })
    assert.equal((await get(sent)).id, sent.id)
    await waitForCache(get, sent, (snapshot) => snapshot === undefined)
    const actual = await api("GET", `/channels/${channelId}/messages/${sent.id}`)
    assert.equal(actual.status, 200)
    assert.equal(actual.data?.content, sent.content)
    report(stage, true)
}

async function cleanup() {
    if (!journal) return
    assert.equal(journal.guildId, guildId)
    assert.match(journal.name, /^fluxerly-sdk-test-[a-f0-9]{32}$/)
    let emojiFailure
    try {
        await cleanupReactionEmoji(api, journal)
        if (journal.emojiName !== undefined) report("test_emoji_removed", true)
    } catch (error) {
        emojiFailure = error
    }
    let roleFailure
    try {
        await cleanupGuildTestRole(api, journal)
        if (journal.roleName !== undefined) report("test_role_removed", true)
    } catch (error) {
        roleFailure = error
    }
    const listed = await api("GET", `/guilds/${guildId}/channels`)
    assert.ok(Array.isArray(listed.data))
    // The unique marker is persisted before creation, so a lost POST response can be reconciled without retrying creation
    const matches = listed.data.filter((channel) => channel.name === journal.name)
    assert.ok(matches.length <= 1)
    if (matches.length === 0) {
        // Without a returned ID, absence cannot prove that an interrupted creation will not complete later
        assert.match(journal.channelId ?? "", /^\d+$/)
        assert.equal((await api("GET", `/channels/${journal.channelId}`)).status, 404)
    }
    for (const channel of matches) {
        assert.match(channel.id, /^\d+$/)
        assert.equal(channel.guild_id, guildId)
        assert.equal(channel.type, 0)
        const current = await api("GET", `/channels/${channel.id}`)
        assert.equal(current.data?.name, journal.name)
        assert.equal(current.data?.guild_id, guildId)
        await api("DELETE", `/channels/${channel.id}`)
        assert.equal((await api("GET", `/channels/${channel.id}`)).status, 404)
    }
    const after = await api("GET", `/guilds/${guildId}/channels`)
    assert.ok(Array.isArray(after.data) && !after.data.some((channel) => channel.name === journal.name))
    report("test_channel_and_messages_removed", true)
    if (emojiFailure) throw emojiFailure
    if (roleFailure) throw roleFailure
    unlinkSync(journalPath)
    journal = undefined
}

async function prepareManagement(channelId, botId) {
    stage = "management_seed"
    const content = `manage-${randomUUID()}`
    const created = await api("POST", `/channels/${channelId}/messages`, {
        content,
        embeds: [{ title: "SDK preservation fixture", description: "Temporary sandbox data" }],
        allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
    })
    assert.equal(created.status, 200)
    assert.match(created.data?.id ?? "", /^\d+$/)
    const target = { channelId, id: created.data.id }
    const before = (await api("GET", `/channels/${channelId}/messages/${target.id}`)).data
    assert.equal(before?.content, content)
    assert.equal(before?.author?.id, botId)
    assert.equal(before?.embeds?.length, 1)
    assert.equal(before.embeds[0].type, "rich")
    return { target, before, content }
}

async function verifyManaged(snapshot, content, seed) {
    assert.equal(snapshot.id, seed.target.id)
    assert.equal(snapshot.channelId, seed.target.channelId)
    assert.equal(snapshot.content, content)
    assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.author))
    const current = (await api("GET", `/channels/${snapshot.channelId}/messages/${snapshot.id}`)).data
    assert.equal(current?.content, content)
    assert.deepEqual(current?.embeds, seed.before.embeds)
    assert.deepEqual(current?.attachments, seed.before.attachments)
    assert.equal(current?.flags, seed.before.flags)
    assert.equal(current?.mention_everyone, false)
    assert.deepEqual(current?.mentions, [])
    report(stage, true)
}

function verifyMissing(error, operation) {
    assert.equal(error?._tag, "MessageOperationError")
    assert.equal(error.operation, operation)
    assert.equal(error.reason, "notFound")
    assert.equal(error.outcome, "rejected")
    assert.equal(error.status, 404)
}

function verifyClearRejection(error) {
    assert.equal(error?._tag, "MessageOperationError")
    assert.equal(error.operation, "edit")
    assert.equal(error.reason, "rejected")
    assert.equal(error.outcome, "rejected")
    assert.equal(error.status, 400)
}

function observeMessageChanges(channelId) {
    const received = { messageUpdate: [], messageDelete: [], messageDeleteBulk: [] }
    return {
        receive(event, payload) {
            if (payload.channelId !== channelId) return
            assert.ok(received[event].length < 32)
            assert.ok(Object.isFrozen(payload))
            received[event].push(payload)
        },
        async exercise(botId, get) {
            stage = "create_change_event_seeds"
            const content = `event-${randomUUID()}`
            const seeds = []
            for (let index = 0; index < 3; index++) {
                const seed = (
                    await api("POST", `/channels/${channelId}/messages`, {
                        content: `${content}-${index}`,
                        allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
                    })
                ).data
                assert.match(seed?.id ?? "", /^\d+$/)
                assert.equal(seed.channel_id, channelId)
                assert.equal(seed.author?.id, botId)
                seeds.push(seed)
            }
            if (get) {
                for (const seed of seeds) {
                    const snapshot = await waitForCache(
                        get,
                        { id: seed.id, channelId },
                        (current) => current?.content === seed.content,
                    )
                    assert.equal(snapshot.author.id, botId)
                }
                report("cache_gateway_create", true)
            }
            const waitFor = async (event, matches) => {
                const until = performance.now() + 15_000
                while (true) {
                    const found = received[event].find(matches)
                    if (found) return found
                    assert.ok(performance.now() < until)
                    await sleep(20)
                }
            }
            // Raw API mutations prove the SDK receives real gateway events rather than synthesizing method results
            stage = "live_message_update_event"
            await api("PATCH", `/channels/${channelId}/messages/${seeds[0].id}`, {
                content: `${content}-edited`,
                allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
            })
            const updated = await waitFor(
                "messageUpdate",
                (message) => message.id === seeds[0].id && message.content === `${content}-edited`,
            )
            assert.equal(updated.author.id, botId)
            assert.ok(Object.isFrozen(updated.author))
            assert.equal(
                (await api("GET", `/channels/${channelId}/messages/${updated.id}`)).data?.content,
                updated.content,
            )
            if (get) {
                const cached = await waitForCache(get, updated, (current) => current?.content === updated.content)
                assert.equal(cached.author.id, botId)
                report("cache_gateway_update", true)
            }
            report(stage, true)
            stage = "live_message_delete_event"
            await api("DELETE", `/channels/${channelId}/messages/${seeds[0].id}`)
            const deleted = await waitFor("messageDelete", (message) => message.id === seeds[0].id)
            if ("content" in deleted) assert.equal(deleted.content, updated.content)
            if ("authorId" in deleted) assert.equal(deleted.authorId, botId)
            assert.equal((await api("GET", `/channels/${channelId}/messages/${deleted.id}`)).status, 404)
            if (get) {
                await waitForCache(get, deleted, (current) => current === undefined)
                report("cache_gateway_delete", true)
            }
            report(stage, true)
            stage = "live_message_delete_bulk_event"
            const ids = seeds.slice(1).map((seed) => seed.id)
            const result = await api("POST", `/channels/${channelId}/messages/bulk-delete`, { message_ids: ids })
            assert.equal(result.status, 204)
            const batch = await waitFor("messageDeleteBulk", (batch) => ids.every((id) => batch.ids.includes(id)))
            assert.deepEqual([...batch.ids].sort(), [...ids].sort())
            assert.ok(Object.isFrozen(batch.ids))
            for (const id of ids) assert.equal((await api("GET", `/channels/${channelId}/messages/${id}`)).status, 404)
            assert.ok(!received.messageDelete.some((message) => ids.includes(message.id)))
            if (get) {
                for (const id of ids) await waitForCache(get, { id, channelId }, (current) => current === undefined)
                report("cache_gateway_bulk_delete", true)
            }
            report(stage, true)
        },
    }
}

async function prepareHistory(channelId, botId) {
    stage = "history_seed"
    const seeds = []
    for (let index = 0; index < 5; index++) {
        const seed = (
            await api("POST", `/channels/${channelId}/messages`, {
                content: `history-${randomUUID()}`,
                allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
            })
        ).data
        assert.match(seed?.id ?? "", /^\d+$/)
        assert.equal(seed.channel_id, channelId)
        assert.equal(seed.author?.id, botId)
        seeds.push(seed)
    }
    const ids = seeds.map((seed) => seed.id)
    for (let index = 1; index < ids.length; index++) assert.ok(BigInt(ids[index]) > BigInt(ids[index - 1]))
    return {
        cases: [
            { name: "history_default", query: undefined, ids: [...ids].reverse() },
            { name: "history_latest_page", query: { limit: 2 }, ids: [ids[4], ids[3]] },
            { name: "history_older_page", query: { limit: 2, before: ids[3] }, ids: [ids[2], ids[1]] },
            { name: "history_last_page", query: { limit: 2, before: ids[1] }, ids: [ids[0]] },
            { name: "history_empty_page", query: { before: ids[0] }, ids: [] },
            { name: "history_after", query: { limit: 2, after: ids[0] }, ids: [ids[2], ids[1]] },
            { name: "history_around", query: { limit: 3, around: ids[2] }, ids: [ids[3], ids[2], ids[1]] },
            { name: "history_maximum_limit", query: { limit: 100 }, ids: [...ids].reverse() },
        ],
        async verify(page, check) {
            assert.ok(Object.isFrozen(page))
            assert.deepEqual(
                page.map((message) => message.id),
                check.ids,
            )
            const query = new URLSearchParams(check.query)
            const actual = await api("GET", `/channels/${channelId}/messages?${query}`)
            assert.equal(actual.status, 200)
            assert.ok(Array.isArray(actual.data))
            assert.deepEqual(
                page.map((message) => message.id),
                actual.data.map((message) => message.id),
            )
            for (let index = 0; index < page.length; index++) {
                const message = page[index]
                assert.equal(message.channelId, channelId)
                assert.equal(message.author.id, botId)
                assert.equal(message.content, actual.data[index].content)
                assert.ok(Object.isFrozen(message) && Object.isFrozen(message.author))
            }
            report(check.name, true)
        },
    }
}

async function verifyCollectors(open, send, channelId, botId, interrupt) {
    const marker = `collector-${randomUUID()}`
    const filter = (message) => message.author.id === botId && message.content.startsWith(marker)
    async function collectAndSend(maxMessages, count, timeoutMs, reason) {
        stage = `collector_${reason}`
        const collector = await open({ filter, maxMessages, timeoutMs })
        const sent = []
        try {
            // Intake is ready before sending. No retry of ambiguous mutations; the existing channel journal owns cleanup
            for (let index = 0; index < count; index++)
                sent.push(await send(channelId, { content: `${marker}-${reason}-${index}` }))
            const result = await collector.wait()
            assert.equal(result.error, undefined)
            assert.equal(result.value.reason, reason)
            assert.deepEqual(
                result.value.messages.map((message) => message.id),
                sent.map((message) => message.id),
            )
            assert.ok(Object.isFrozen(result.value) && Object.isFrozen(result.value.messages))
            for (const message of result.value.messages) {
                assert.equal(message.channelId, channelId)
                assert.equal(message.author.id, botId)
                const actual = await api("GET", `/channels/${channelId}/messages/${message.id}`)
                assert.equal(actual.status, 200)
                assert.equal(actual.data?.content, message.content)
            }
            report(stage, true)
        } finally {
            await collector.stop()
        }
    }
    await collectAndSend(2, 2, 30_000, "limit")
    await collectAndSend(5, 1, 5_000, "timeout")
    const gap = await open({ filter: () => false, timeoutMs: 60_000 })
    try {
        await interrupt()
        stage = "collector_connection_gap"
        const result = await gap.wait()
        assert.equal(result.value, undefined)
        assert.equal(result.error?._tag, "CollectorError")
        assert.equal(result.error?.reason, "connectionLost")
        assert.equal("messages" in result.error, false)
        report(stage, true)
        await collectAndSend(1, 1, 30_000, "limit")
        report("collector_after_resume", true)
    } finally {
        await gap.stop()
    }
}

// Failure containment only: A forced exit is never reported as successful cleanup
setTimeout(
    () => {
        report("process_timeout", false)
        process.exit(1)
    },
    attachments ? 240_000 : 120_000,
).unref()

try {
    assert.ok(mode === "default" || mode === "effect")
    assert.ok(
        process.argv.length === 3 ||
            (process.argv.length === 4 &&
                (recover ||
                    manage ||
                    changes ||
                    history ||
                    cache ||
                    collectors ||
                    embeds ||
                    attachments ||
                    reactions ||
                    pins ||
                    guilds)),
    )
    stage = "sandbox_lock"
    lock = openSync(lockPath, "wx")
    writeSync(lock, String(process.pid))
    stage = "configuration"
    const env = parseEnv(readFileSync(new URL("../../.env.test.local", import.meta.url), "utf8"))
    token = env.FLUXER_TEST_BOT_TOKEN
    guildId = env.FLUXER_TEST_GUILD_ID
    const applicationId = env.FLUXER_TEST_APPLICATION_ID
    assert.ok(token && token === token.trim())
    assert.match(guildId ?? "", /^\d+$/)
    assert.match(applicationId ?? "", /^\d+$/)
    stage = "sandbox_identity"
    const application = (await api("GET", "/applications/@me")).data
    const user = (await api("GET", "/users/@me")).data
    assert.equal(application?.id, applicationId)
    assert.equal(user?.bot, true)
    assert.equal(application?.bot?.id, user.id)
    assert.equal((await api("GET", `/guilds/${guildId}`)).data?.id, guildId)
    verified = true
    report(stage, true)
    stage = "recover_prior_test"
    if (existsSync(journalPath)) {
        journal = JSON.parse(readFileSync(journalPath, "utf8"))
        await cleanup()
    }
    journal = { guildId, name: `fluxerly-sdk-test-${randomUUID().replaceAll("-", "")}` }
    writeFileSync(journalPath, JSON.stringify(journal), { flag: "wx" })
    stage = "create_test_channel"
    const channel = (await api("POST", `/guilds/${guildId}/channels`, { name: journal.name, type: 0 })).data
    assert.match(channel?.id ?? "", /^\d+$/)
    assert.equal(channel.guild_id, guildId)
    assert.equal(channel.name, journal.name)
    journal.channelId = channel.id
    writeFileSync(journalPath, JSON.stringify(journal))
    const ping = `ping-${randomUUID()}`
    const pong = `pong-${randomUUID()}`
    const sdkRequests = []
    if (cache) {
        // Sandbox setup and independent readback keep using rawFetch. This observes only the SDK's own REST behavior
        globalThis.fetch = async (...args) => {
            sdkRequests.push(new URL(args[0]).pathname)
            return rawFetch(...args)
        }
    }
    if (attachments)
        globalThis.fetch = observeUploads(rawFetch, (record) =>
            console.log(JSON.stringify({ mode, check: stage, ...record })),
        )
    let client
    let seed
    let reply
    const states = []
    if (forceRecovery) gatewayProbe = observeGateway()
    stage = "sdk_receive_and_reply"
    if (mode === "default") {
        const { createClient } = await import("@neontechspace/fluxerly")
        const created = createClient({
            token,
            ...(cache || embeds || attachments ? { cache: cacheOptions() } : {}),
            ...(guilds ? { cache: { guilds: true, members: true, roles: true } } : {}),
            ...(recover ? { logging: { development: true, logger: fromEffectLogger(diagnosticLogger) } } : {}),
        })
        assert.ok(created.isOk())
        client = created.value
        const cacheGet = async (target) => {
            if (!cache) return undefined
            const cached = client.messages.get(target)
            assert.ok(cached.isOk())
            return cached.value
        }
        const cacheSend = async (channelId, input) => {
            const sent = await client.messages.send(channelId, input)
            assert.ok(sent.isOk())
            return sent.value
        }
        const done = Promise.withResolvers()
        const stopState = forceRecovery
            ? client.observeState((state) => {
                  states.push(state)
              })
            : undefined
        let timer
        try {
            if (history || cache) {
                const probe = await prepareHistory(channel.id, user.id)
                assert.equal(client.state, "Disconnected")
                for (const check of probe.cases) {
                    stage = check.name
                    const page = await client.messages.fetchHistory(channel.id, check.query)
                    assert.ok(page.isOk())
                    await probe.verify(page.value, check)
                    if (cache)
                        for (const message of page.value) {
                            const cached = await cacheGet(message)
                            assert.equal(cached?.content, message.content)
                        }
                }
                if (cache) report("cache_rest_history", true)
                stage = "sdk_receive_and_reply"
            }
            if (manage || cache) {
                const managed = await prepareManagement(channel.id, user.id)
                assert.equal(client.state, "Disconnected")
                stage = "sdk_fetch_disconnected"
                const fetched = await client.messages.fetch(managed.target)
                assert.ok(fetched.isOk())
                await verifyManaged(fetched.value, managed.content, managed)
                if (cache) {
                    assert.equal((await cacheGet(managed.target))?.content, managed.content)
                    report("cache_rest_fetch", true)
                }
                stage = "sdk_edit_and_preserve_embed"
                const edited = await client.messages.edit(fetched.value, {
                    content: `${managed.content}-edited @everyone`,
                })
                assert.ok(edited.isOk())
                await verifyManaged(edited.value, `${managed.content}-edited @everyone`, managed)
                if (cache) {
                    assert.equal((await cacheGet(edited.value))?.content, edited.value.content)
                    report("cache_rest_edit", true)
                }
                stage = "sdk_empty_edit_rejected_without_change"
                const cleared = await client.messages.edit(edited.value, { content: "" })
                assert.ok(cleared.isErr())
                verifyClearRejection(cleared.error)
                await verifyManaged(edited.value, `${managed.content}-edited @everyone`, managed)
                stage = "sdk_delete_and_confirm_absence"
                const deleted = await client.messages.delete(edited.value)
                assert.ok(deleted.isOk())
                assert.equal(deleted.value, undefined)
                assert.equal((await api("GET", `/channels/${channel.id}/messages/${managed.target.id}`)).status, 404)
                if (cache) {
                    assert.equal(await cacheGet(managed.target), undefined)
                    report("cache_rest_delete", true)
                }
                report(stage, true)
                stage = "sdk_missing_target_errors"
                verifyMissing((await client.messages.fetch(managed.target)).error, "fetch")
                verifyMissing((await client.messages.edit(managed.target, { content: "gone" })).error, "edit")
                verifyMissing((await client.messages.delete(managed.target)).error, "delete")
                report(stage, true)
                stage = "sdk_receive_and_reply"
            }
            let beforeRecovery
            if (cache) {
                stage = "cache_pre_recovery_rest_intake"
                beforeRecovery = await cacheSend(channel.id, { content: `cache-before-recovery-${randomUUID()}` })
                assert.equal((await cacheGet(beforeRecovery))?.content, beforeRecovery.content)
                report(stage, true)
                stage = "sdk_receive_and_reply"
            }
            const registered = client.on("messageCreate", async (message, signal) => {
                if (message.channelId !== channel.id || message.author.id !== user.id || message.content !== ping)
                    return
                // Deliberately consume this test bot's own seed event; default bot examples filter bot authors
                const sent = await client.messages.reply(message, { content: pong }, { signal })
                done.resolve(sent)
            })
            assert.ok(registered.isOk())
            const terminal = registered.value.waitForClose().then(
                (result) => {
                    if (result.isErr()) done.resolve(result)
                },
                () => done.resolve(null),
            )
            assert.ok((await client.connect()).isOk())
            if (guilds) {
                const run = async (operation) => {
                    const result = await operation
                    if (result.isErr()) throw result.error
                    return result.value
                }
                await verifyGuildMembers(
                    {
                        guild: () => run(client.guilds.fetch(guildId)),
                        getGuild: () => run(client.guilds.get(guildId)),
                        getMember: (target) => run(client.members.get(target)),
                        getRole: (id) => run(client.roles.get({ guildId, id })),
                        roles: () => run(client.roles.fetchAll(guildId)),
                        createRole: (input) => run(client.roles.create(guildId, input)),
                        editRole: (id, input) => run(client.roles.edit({ guildId, id }, input)),
                        deleteRole: (id) => run(client.roles.delete({ guildId, id })),
                        reorderRoles: (positions) => run(client.roles.reorder(guildId, positions)),
                        member: (target) => run(client.members.fetch(target)),
                        self: () => run(client.members.fetchSelf(guildId)),
                        page: () => run(client.members.fetchPage(guildId, { limit: 2 })),
                        add: (target, roleId) => run(client.members.addRole(target, roleId)),
                        remove: (target, roleId) => run(client.members.removeRole(target, roleId)),
                        send: () =>
                            run(client.messages.send(channel.id, { content: "SDK reaction role verification" })),
                        react: (target) => run(client.messages.addReaction(target, "✅")),
                        collect: async (message, target, roleId) => {
                            const collector = await run(
                                client.messages.collectReactions(message, {
                                    emoji: "✅",
                                    timeoutMs: 10_000,
                                    filter: (reaction) => reaction.userId === user.id,
                                    onReaction: async (_reaction, signal) => {
                                        await run(client.members.addRole(target, roleId, { signal }))
                                        await run(
                                            client.messages.edit(message, { content: "SDK role assigned" }, { signal }),
                                        )
                                    },
                                }),
                            )
                            return { wait: () => run(collector.waitForClose()), stop: () => collector.stop() }
                        },
                        on: async (event, handler) => {
                            const subscription = await run(client.on(event, handler))
                            return async () => {
                                subscription.unsubscribe()
                                await run(subscription.waitForClose())
                            }
                        },
                    },
                    channel.id,
                    user.id,
                    () => gatewayProbe.interruptAndWait(client, states),
                )
            }
            if (pins) {
                const run = async (operation) => {
                    const result = await operation
                    if (result.isErr()) throw result.error
                    return result.value
                }
                await verifyPins(
                    {
                        send: (input) => run(client.messages.send(channel.id, input)),
                        pin: (target) => run(client.messages.pin(target)),
                        unpin: (target) => run(client.messages.unpin(target)),
                        pins: (query) => run(client.messages.fetchPins(channel.id, query)),
                        on: async (event, handler) => {
                            const subscription = await run(client.on(event, handler))
                            return async () => {
                                subscription.unsubscribe()
                                await run(subscription.waitForClose())
                            }
                        },
                    },
                    channel.id,
                    () => gatewayProbe.interruptAndWait(client, states),
                )
            }
            if (reactions) {
                const unwrap = async (operation) => {
                    const result = await operation
                    if (result.isErr()) reportFailure(result.error)
                    assert.ok(result.isOk())
                    return result.value
                }
                await verifyReactions(
                    {
                        send: (input) => unwrap(client.messages.send(channel.id, input)),
                        add: (target, emoji) => unwrap(client.messages.addReaction(target, emoji)),
                        remove: (target, emoji) => unwrap(client.messages.removeReaction(target, emoji)),
                        removeUser: (target, emoji, userId) =>
                            unwrap(client.messages.removeUserReaction(target, emoji, userId)),
                        clearEmoji: (target, emoji) => unwrap(client.messages.clearReaction(target, emoji)),
                        clearAll: (target) => unwrap(client.messages.clearReactions(target)),
                        reads: async (target) => ({
                            message: await unwrap(client.messages.fetch(target)),
                            history: await unwrap(
                                client.messages.fetchHistory(target.channelId, { around: target.id, limit: 1 }),
                            ),
                            pins: await unwrap(client.messages.fetchPins(target.channelId, { limit: 1 })),
                        }),
                        collect: async (target, options) => {
                            const { progressEdit, progressFailure, progressWait, onProgress, ...settings } = options
                            let count = 0
                            const collector = await unwrap(
                                client.messages.collectReactions(target, {
                                    ...settings,
                                    ...(progressEdit || progressWait
                                        ? {
                                              onReaction: async (_reaction, signal) => {
                                                  onProgress?.("started")
                                                  try {
                                                      if (progressWait)
                                                          await new Promise((resolve) => {
                                                              if (signal.aborted) resolve()
                                                              else
                                                                  signal.addEventListener("abort", resolve, {
                                                                      once: true,
                                                                  })
                                                          })
                                                      else
                                                          await unwrap(
                                                              client.messages.edit(
                                                                  progressFailure ? { ...target, id: "1" } : target,
                                                                  { content: `${progressEdit} ${++count}` },
                                                                  { signal },
                                                              ),
                                                          )
                                                  } finally {
                                                      onProgress?.("cleaned")
                                                  }
                                              },
                                          }
                                        : {}),
                                }),
                            )
                            return {
                                stop: async () => collector.stop(),
                                wait: async () => {
                                    const result = await collector.waitForClose()
                                    if (result.isErr()) throw result.error
                                    return result.value
                                },
                            }
                        },
                        users: async (target, emoji, query) => {
                            const result = await client.messages.fetchReactionUsers(target, emoji, query)
                            if (result.isErr()) throw result.error
                            return result.value
                        },
                        on: async (event, handler) => {
                            const subscription = await unwrap(client.on(event, handler))
                            return async () => {
                                subscription.unsubscribe()
                                await unwrap(subscription.waitForClose())
                            }
                        },
                    },
                    channel.id,
                    user.id,
                    () => gatewayProbe.interruptAndWait(client, states),
                )
            }
            if (embeds || attachments) {
                const unwrap = async (operation) => {
                    const result = await operation
                    if (result.isErr()) reportFailure(result.error)
                    assert.ok(result.isOk())
                    return result.value
                }
                await (attachments ? verifyAttachments : verifyEmbeds)(
                    {
                        send: (input, options) => unwrap(client.messages.send(channel.id, input, options)),
                        reply: (target, input) => unwrap(client.messages.reply(target, input)),
                        edit: (target, input) => unwrap(client.messages.edit(target, input)),
                        editFailure: async (target, input) => {
                            const result = await client.messages.edit(target, input)
                            assert.ok(result.isErr())
                            return result.error
                        },
                        fetch: (target) => unwrap(client.messages.fetch(target)),
                        history: () => unwrap(client.messages.fetchHistory(channel.id)),
                        get: (target) => unwrap(client.messages.get(target)),
                        collect: async (options) => {
                            const collector = await unwrap(client.messages.collect(channel.id, options))
                            return () => unwrap(collector.waitForClose())
                        },
                    },
                    channel.id,
                )
            }
            if (forceRecovery && !reactions && !pins && !guilds) {
                if (cache) sdkRequests.length = 0
                if (collectors)
                    await verifyCollectors(
                        async (options) => {
                            const opened = client.messages.collect(channel.id, options)
                            assert.ok(opened.isOk())
                            return { wait: () => opened.value.waitForClose(), stop: () => opened.value.stop() }
                        },
                        cacheSend,
                        channel.id,
                        user.id,
                        () => gatewayProbe.interruptAndWait(client, states),
                    )
                else await gatewayProbe.interruptAndWait(client, states)
                if (cache) {
                    assert.equal(await cacheGet(beforeRecovery), undefined)
                    assert.deepEqual(sdkRequests, [])
                    const remote = await api("GET", `/channels/${channel.id}/messages/${beforeRecovery.id}`)
                    assert.equal(remote.status, 200)
                    assert.equal(remote.data?.content, beforeRecovery.content)
                    report("cache_recovery_gap_clears_without_autofetch", true)
                }
            }
            const sent = await client.messages.send(channel.id, { content: ping })
            assert.ok(sent.isOk())
            seed = sent.value
            timer = setTimeout(() => done.resolve(null), 20_000)
            const replied = await done.promise
            assert.ok(replied?.isOk())
            reply = replied.value
            registered.value.unsubscribe()
            assert.ok((await registered.value.waitForClose()).isOk())
            await terminal
            if (cache) {
                assert.equal((await cacheGet(seed))?.content, seed.content)
                assert.equal((await cacheGet(reply))?.content, reply.content)
                report("cache_rest_send_and_reply", true)
                if (forceRecovery) report("cache_rebuilt_after_recovery", true)
                await verifyCacheProjectionConflict(
                    cacheSend,
                    async (target) => {
                        const result = await client.messages.fetch(target)
                        assert.ok(result.isOk())
                        return result.value
                    },
                    cacheGet,
                    channel.id,
                )
                await verifyCacheExpiry(cacheSend, cacheGet, channel.id)
            }
            if (changes || cache) {
                const probe = observeMessageChanges(channel.id)
                const updates = client.on("messageUpdate", (message) => probe.receive("messageUpdate", message))
                assert.ok(updates.isOk())
                const deletion = client.events("messageDelete")
                const bulk = client.events("messageDeleteBulk")
                assert.ok(deletion.isOk() && bulk.isOk())
                const consume = async (event, subscription) => {
                    while (true) {
                        const result = await subscription.next()
                        assert.ok(result.isOk())
                        if (result.value === null) return
                        probe.receive(event, result.value)
                    }
                }
                const readers = [consume("messageDelete", deletion.value), consume("messageDeleteBulk", bulk.value)]
                const readsDone = Promise.allSettled(readers)
                try {
                    await probe.exercise(user.id, cache ? cacheGet : undefined)
                } finally {
                    updates.value.unsubscribe()
                    deletion.value.unsubscribe()
                    bulk.value.unsubscribe()
                    assert.ok((await updates.value.waitForClose()).isOk())
                    assert.ok((await readsDone).every((result) => result.status === "fulfilled"))
                }
            }
        } finally {
            clearTimeout(timer)
            assert.ok((await client.shutdown()).isOk())
            stopState?.()
        }
    } else {
        const { Deferred, Effect, Exit, Scope, Stream } = await import("effect")
        const { createClient } = await import("@neontechspace/fluxerly/effect")
        const exit = await Effect.runPromiseExit(
            Effect.scoped(
                Effect.gen(function* () {
                    client = yield* createClient({
                        token,
                        ...(cache || embeds || attachments ? { cache: cacheOptions() } : {}),
                        ...(guilds ? { cache: { guilds: true, members: true, roles: true } } : {}),
                        ...(recover ? { logging: { development: true } } : {}),
                    })
                    const cacheGet = async (target) => {
                        if (!cache) return undefined
                        const cached = await Effect.runPromiseExit(client.messages.get(target))
                        assert.ok(Exit.isSuccess(cached))
                        return cached.value
                    }
                    const cacheSend = (channelId, input) => Effect.runPromise(client.messages.send(channelId, input))
                    if (history || cache) {
                        const probe = yield* Effect.promise(() => prepareHistory(channel.id, user.id))
                        assert.equal(client.state, "Disconnected")
                        for (const check of probe.cases) {
                            stage = check.name
                            const page = yield* client.messages.fetchHistory(channel.id, check.query)
                            yield* Effect.promise(() => probe.verify(page, check))
                            if (cache)
                                for (const message of page) {
                                    const cached = yield* Effect.promise(() => cacheGet(message))
                                    assert.equal(cached?.content, message.content)
                                }
                        }
                        if (cache) report("cache_rest_history", true)
                        stage = "sdk_receive_and_reply"
                    }
                    if (manage || cache) {
                        const managed = yield* Effect.promise(() => prepareManagement(channel.id, user.id))
                        assert.equal(client.state, "Disconnected")
                        stage = "sdk_fetch_disconnected"
                        const fetched = yield* client.messages.fetch(managed.target)
                        yield* Effect.promise(() => verifyManaged(fetched, managed.content, managed))
                        if (cache) {
                            assert.equal(
                                (yield* Effect.promise(() => cacheGet(managed.target)))?.content,
                                managed.content,
                            )
                            report("cache_rest_fetch", true)
                        }
                        stage = "sdk_edit_and_preserve_embed"
                        const edited = yield* client.messages.edit(fetched, {
                            content: `${managed.content}-edited @everyone`,
                        })
                        yield* Effect.promise(() =>
                            verifyManaged(edited, `${managed.content}-edited @everyone`, managed),
                        )
                        if (cache) {
                            assert.equal((yield* Effect.promise(() => cacheGet(edited)))?.content, edited.content)
                            report("cache_rest_edit", true)
                        }
                        stage = "sdk_empty_edit_rejected_without_change"
                        const cleared = yield* client.messages.edit(edited, { content: "" }).pipe(Effect.flip)
                        verifyClearRejection(cleared)
                        yield* Effect.promise(() =>
                            verifyManaged(edited, `${managed.content}-edited @everyone`, managed),
                        )
                        stage = "sdk_delete_and_confirm_absence"
                        assert.equal(yield* client.messages.delete(edited), undefined)
                        const absent = yield* Effect.promise(() =>
                            api("GET", `/channels/${channel.id}/messages/${managed.target.id}`),
                        )
                        assert.equal(absent.status, 404)
                        if (cache) {
                            assert.equal(yield* Effect.promise(() => cacheGet(managed.target)), undefined)
                            report("cache_rest_delete", true)
                        }
                        report(stage, true)
                        stage = "sdk_missing_target_errors"
                        verifyMissing(yield* client.messages.fetch(managed.target).pipe(Effect.flip), "fetch")
                        verifyMissing(
                            yield* client.messages.edit(managed.target, { content: "gone" }).pipe(Effect.flip),
                            "edit",
                        )
                        verifyMissing(yield* client.messages.delete(managed.target).pipe(Effect.flip), "delete")
                        report(stage, true)
                        stage = "sdk_receive_and_reply"
                    }
                    let beforeRecovery
                    if (cache) {
                        stage = "cache_pre_recovery_rest_intake"
                        beforeRecovery = yield* Effect.promise(() =>
                            cacheSend(channel.id, { content: `cache-before-recovery-${randomUUID()}` }),
                        )
                        assert.equal(
                            (yield* Effect.promise(() => cacheGet(beforeRecovery)))?.content,
                            beforeRecovery.content,
                        )
                        report(stage, true)
                        stage = "sdk_receive_and_reply"
                    }
                    if (forceRecovery)
                        yield* Effect.forkScoped(
                            Stream.runForEach(client.observeState(), (state) =>
                                Effect.sync(() => {
                                    states.push(state)
                                }),
                            ),
                        )
                    const done = yield* Deferred.make()
                    const subscription = yield* client.on("messageCreate", (message) =>
                        Effect.gen(function* () {
                            if (
                                message.channelId !== channel.id ||
                                message.author.id !== user.id ||
                                message.content !== ping
                            )
                                return
                            const sent = yield* client.messages.reply(message, { content: pong })
                            yield* Deferred.succeed(done, sent)
                        }),
                    )
                    yield* client.connect()
                    if (guilds) {
                        const scope = yield* Effect.scope
                        const run = async (operation) => {
                            const result = await Effect.runPromise(Effect.result(operation))
                            if (result._tag === "Failure") throw result.failure
                            return result.success
                        }
                        yield* Effect.promise(() =>
                            verifyGuildMembers(
                                {
                                    guild: () => run(client.guilds.fetch(guildId)),
                                    getGuild: () => run(client.guilds.get(guildId)),
                                    getMember: (target) => run(client.members.get(target)),
                                    getRole: (id) => run(client.roles.get({ guildId, id })),
                                    roles: () => run(client.roles.fetchAll(guildId)),
                                    createRole: (input) => run(client.roles.create(guildId, input)),
                                    editRole: (id, input) => run(client.roles.edit({ guildId, id }, input)),
                                    deleteRole: (id) => run(client.roles.delete({ guildId, id })),
                                    reorderRoles: (positions) => run(client.roles.reorder(guildId, positions)),
                                    member: (target) => run(client.members.fetch(target)),
                                    self: () => run(client.members.fetchSelf(guildId)),
                                    page: () => run(client.members.fetchPage(guildId, { limit: 2 })),
                                    add: (target, roleId) => run(client.members.addRole(target, roleId)),
                                    remove: (target, roleId) => run(client.members.removeRole(target, roleId)),
                                    send: () =>
                                        run(
                                            client.messages.send(channel.id, {
                                                content: "SDK reaction role verification",
                                            }),
                                        ),
                                    react: (target) => run(client.messages.addReaction(target, "✅")),
                                    collect: async (message, target, roleId) => {
                                        const collector = await run(
                                            client.messages
                                                .collectReactions(message, {
                                                    emoji: "✅",
                                                    timeoutMs: 10_000,
                                                    filter: (reaction) => reaction.userId === user.id,
                                                    onReaction: () =>
                                                        Effect.gen(function* () {
                                                            yield* client.members.addRole(target, roleId)
                                                            yield* client.messages.edit(message, {
                                                                content: "SDK role assigned",
                                                            })
                                                        }),
                                                })
                                                .pipe(Scope.provide(scope)),
                                        )
                                        return {
                                            wait: () => run(collector.waitForClose()),
                                            stop: () => run(collector.stop()),
                                        }
                                    },
                                    on: async (event, handler) => {
                                        const subscription = await run(
                                            client
                                                .on(event, (value) => Effect.sync(() => handler(value)))
                                                .pipe(Scope.provide(scope)),
                                        )
                                        return async () => {
                                            await run(subscription.unsubscribe())
                                            await run(subscription.waitForClose())
                                        }
                                    },
                                },
                                channel.id,
                                user.id,
                                () => gatewayProbe.interruptAndWait(client, states),
                            ),
                        )
                    }
                    if (pins) {
                        const scope = yield* Effect.scope
                        const run = async (operation) => {
                            const result = await Effect.runPromise(Effect.result(operation))
                            if (result._tag === "Failure") throw result.failure
                            return result.success
                        }
                        yield* Effect.promise(() =>
                            verifyPins(
                                {
                                    send: (input) => run(client.messages.send(channel.id, input)),
                                    pin: (target) => run(client.messages.pin(target)),
                                    unpin: (target) => run(client.messages.unpin(target)),
                                    pins: (query) => run(client.messages.fetchPins(channel.id, query)),
                                    on: async (event, handler) => {
                                        const subscription = await run(
                                            client
                                                .on(event, (value) => Effect.sync(() => handler(value)))
                                                .pipe(Scope.provide(scope)),
                                        )
                                        return async () => {
                                            await run(subscription.unsubscribe())
                                            await run(subscription.waitForClose())
                                        }
                                    },
                                },
                                channel.id,
                                () => gatewayProbe.interruptAndWait(client, states),
                            ),
                        )
                    }
                    if (reactions) {
                        const scope = yield* Effect.scope
                        const run = async (operation) => {
                            const result = await Effect.runPromise(Effect.result(operation))
                            if (result._tag === "Failure") reportFailure(result.failure)
                            assert.equal(result._tag, "Success")
                            return result.success
                        }
                        yield* Effect.promise(() =>
                            verifyReactions(
                                {
                                    send: (input) => run(client.messages.send(channel.id, input)),
                                    add: (target, emoji) => run(client.messages.addReaction(target, emoji)),
                                    remove: (target, emoji) => run(client.messages.removeReaction(target, emoji)),
                                    removeUser: (target, emoji, userId) =>
                                        run(client.messages.removeUserReaction(target, emoji, userId)),
                                    clearEmoji: (target, emoji) => run(client.messages.clearReaction(target, emoji)),
                                    clearAll: (target) => run(client.messages.clearReactions(target)),
                                    reads: async (target) => ({
                                        message: await run(client.messages.fetch(target)),
                                        history: await run(
                                            client.messages.fetchHistory(target.channelId, {
                                                around: target.id,
                                                limit: 1,
                                            }),
                                        ),
                                        pins: await run(client.messages.fetchPins(target.channelId, { limit: 1 })),
                                    }),
                                    collect: async (target, options) => {
                                        const { progressEdit, progressFailure, progressWait, onProgress, ...settings } =
                                            options
                                        let count = 0
                                        const collector = await run(
                                            client.messages
                                                .collectReactions(target, {
                                                    ...settings,
                                                    ...(progressEdit || progressWait
                                                        ? {
                                                              onReaction: () =>
                                                                  Effect.gen(function* () {
                                                                      onProgress?.("started")
                                                                      if (progressWait) yield* Effect.never
                                                                      else
                                                                          yield* client.messages.edit(
                                                                              progressFailure
                                                                                  ? { ...target, id: "1" }
                                                                                  : target,
                                                                              { content: `${progressEdit} ${++count}` },
                                                                          )
                                                                  }).pipe(
                                                                      Effect.ensuring(
                                                                          Effect.sync(() => onProgress?.("cleaned")),
                                                                      ),
                                                                  ),
                                                          }
                                                        : {}),
                                                })
                                                .pipe(Scope.provide(scope)),
                                        )
                                        return {
                                            stop: () => run(collector.stop()),
                                            wait: async () => {
                                                const result = await Effect.runPromise(
                                                    Effect.result(collector.waitForClose()),
                                                )
                                                if (result._tag === "Failure") throw result.failure
                                                return result.success
                                            },
                                        }
                                    },
                                    users: async (target, emoji, query) => {
                                        const result = await Effect.runPromise(
                                            Effect.result(client.messages.fetchReactionUsers(target, emoji, query)),
                                        )
                                        if (result._tag === "Failure") throw result.failure
                                        return result.success
                                    },
                                    on: async (event, handler) => {
                                        const subscription = await run(
                                            client
                                                .on(event, (value) => Effect.sync(() => handler(value)))
                                                .pipe(Scope.provide(scope)),
                                        )
                                        return async () => {
                                            await run(subscription.unsubscribe())
                                            await run(subscription.waitForClose())
                                        }
                                    },
                                },
                                channel.id,
                                user.id,
                                () => gatewayProbe.interruptAndWait(client, states),
                            ),
                        )
                    }
                    if (embeds || attachments) {
                        const scope = yield* Effect.scope
                        const run = async (operation) => {
                            const result = await Effect.runPromise(Effect.result(operation))
                            if (result._tag === "Failure") reportFailure(result.failure)
                            assert.equal(result._tag, "Success")
                            return result.success
                        }
                        yield* Effect.promise(() =>
                            (attachments ? verifyAttachments : verifyEmbeds)(
                                {
                                    send: (input, options) => run(client.messages.send(channel.id, input, options)),
                                    reply: (target, input) => run(client.messages.reply(target, input)),
                                    edit: (target, input) => run(client.messages.edit(target, input)),
                                    editFailure: (target, input) =>
                                        Effect.runPromise(client.messages.edit(target, input).pipe(Effect.flip)),
                                    fetch: (target) => Effect.runPromise(client.messages.fetch(target)),
                                    history: () => Effect.runPromise(client.messages.fetchHistory(channel.id)),
                                    get: (target) => Effect.runPromise(client.messages.get(target)),
                                    collect: async (options) => {
                                        const collector = await run(
                                            client.messages.collect(channel.id, options).pipe(Scope.provide(scope)),
                                        )
                                        return () => Effect.runPromise(collector.waitForClose())
                                    },
                                },
                                channel.id,
                            ),
                        )
                    }
                    if (forceRecovery && !reactions && !pins && !guilds) {
                        if (cache) sdkRequests.length = 0
                        if (collectors) {
                            const collectorScope = yield* Effect.scope
                            yield* Effect.promise(() =>
                                verifyCollectors(
                                    async (options) => {
                                        const opened = await Effect.runPromise(
                                            client.messages
                                                .collect(channel.id, options)
                                                .pipe(Scope.provide(collectorScope)),
                                        )
                                        return {
                                            wait: () =>
                                                Effect.runPromise(
                                                    opened.waitForClose().pipe(
                                                        Effect.match({
                                                            onSuccess: (value) => ({ value }),
                                                            onFailure: (error) => ({ error }),
                                                        }),
                                                    ),
                                                ),
                                            stop: () => Effect.runPromise(opened.stop()),
                                        }
                                    },
                                    cacheSend,
                                    channel.id,
                                    user.id,
                                    () => gatewayProbe.interruptAndWait(client, states),
                                ),
                            )
                        } else yield* Effect.promise(() => gatewayProbe.interruptAndWait(client, states))
                        if (cache) {
                            assert.equal(yield* Effect.promise(() => cacheGet(beforeRecovery)), undefined)
                            assert.deepEqual(sdkRequests, [])
                            const remote = yield* Effect.promise(() =>
                                api("GET", `/channels/${channel.id}/messages/${beforeRecovery.id}`),
                            )
                            assert.equal(remote.status, 200)
                            assert.equal(remote.data?.content, beforeRecovery.content)
                            report("cache_recovery_gap_clears_without_autofetch", true)
                        }
                    }
                    seed = yield* client.messages.send(channel.id, { content: ping })
                    reply = yield* Deferred.await(done).pipe(Effect.timeout(20_000))
                    yield* subscription.unsubscribe()
                    yield* subscription.waitForClose()
                    if (cache) {
                        assert.equal((yield* Effect.promise(() => cacheGet(seed)))?.content, seed.content)
                        assert.equal((yield* Effect.promise(() => cacheGet(reply)))?.content, reply.content)
                        report("cache_rest_send_and_reply", true)
                        if (forceRecovery) report("cache_rebuilt_after_recovery", true)
                        yield* Effect.promise(() =>
                            verifyCacheProjectionConflict(
                                cacheSend,
                                (target) => Effect.runPromise(client.messages.fetch(target)),
                                cacheGet,
                                channel.id,
                            ),
                        )
                        yield* Effect.promise(() => verifyCacheExpiry(cacheSend, cacheGet, channel.id))
                    }
                    if (changes || cache) {
                        const probe = observeMessageChanges(channel.id)
                        yield* Effect.scoped(
                            Effect.gen(function* () {
                                yield* client.on("messageUpdate", (message) =>
                                    Effect.sync(() => probe.receive("messageUpdate", message)),
                                )
                                for (const event of ["messageDelete", "messageDeleteBulk"]) {
                                    yield* Effect.forkScoped(
                                        Stream.runForEach(client.events(event), (message) =>
                                            Effect.sync(() => probe.receive(event, message)),
                                        ),
                                    )
                                }
                                yield* Effect.promise(() => probe.exercise(user.id, cache ? cacheGet : undefined))
                            }),
                        )
                    }
                }),
            ).pipe(
                recover
                    ? Effect.provideService(Logger.CurrentLoggers, new Set([diagnosticLogger]))
                    : (effect) => effect,
            ),
        )
        if (attachments && Exit.isFailure(exit))
            for (const reason of exit.cause.reasons.slice(0, 8)) {
                if (reason._tag === "Fail") reportFailure(reason.error)
                else if (reason._tag === "Die") reportFailure(reason.defect)
                else console.log(JSON.stringify({ mode, check: stage, type: "interrupted" }))
            }
        assert.ok(Exit.isSuccess(exit))
    }
    assert.equal(client.state, "Closed")
    if (recover) {
        stage = "recovery_diagnostics"
        assert.equal(diagnosticOverflow, false)
        assert.ok(diagnosticRecords.every((entry) => entry.cause.reasons.length === 0))
        const records = diagnosticRecords.map((entry) => entry.message[1])
        for (const event of ["connecting", "attempt", "connected", "connectionLost", "retry", "closing", "closed"])
            assert.ok(records.some((entry) => entry.event === event))
        assert.ok(
            records.some(
                (entry) => entry.event === "connected" && entry.mode === "resume" && entry.phase === "recovery",
            ),
        )
        assert.ok(records.some((entry) => entry.event === "retry" && Number.isFinite(entry.delayMs)))
        assert.ok(
            records.every((entry) =>
                Object.keys(entry).every((key) =>
                    ["event", "phase", "attempt", "delayMs", "mode", "failure"].includes(key),
                ),
            ),
        )
        assert.ok(!JSON.stringify(diagnosticRecords).includes(token))
        report("recovery_diagnostics", true)
    }
    gatewayProbe?.verifyClosed()
    stage = "live_reply_readback"
    const actual = (await api("GET", `/channels/${channel.id}/messages/${reply.id}`)).data
    assert.equal(actual?.channel_id, channel.id)
    assert.equal(actual?.content, pong)
    assert.equal(actual?.message_reference?.message_id, seed.id)
    assert.equal(actual?.mention_everyone, false)
    assert.deepEqual(actual?.mentions, [])
    report("sdk_receive_and_reply", true)
    if (forceRecovery) report("post_resume_receive_and_reply", true)
    report("reply_reference_and_mentions_verified", true)
    report("sdk_closed", true)
} catch (error) {
    // Never print assertions, HTTP bodies, native causes, configured identities or credentials
    if (attachments || reactions || pins || guilds) reportFailure(error)
    report(stage, false)
    process.exitCode = 1
} finally {
    gatewayProbe?.restore()
    globalThis.fetch = rawFetch
    if (verified && journal) {
        try {
            await cleanup()
        } catch {
            report("cleanup_failed_journal_retained", false)
            process.exitCode = 1
        }
    }
    if (lock !== undefined) {
        closeSync(lock)
        unlinkSync(lockPath)
    }
}
