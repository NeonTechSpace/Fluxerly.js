import assert from "node:assert/strict"
import { randomUUID, createHash } from "node:crypto"
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { parseEnv } from "node:util"
import WebSocket from "ws"
import { Cause, Logger } from "effect"
import { fromEffectLogger } from "@neontechspace/fluxerly/effect"
import { observeUploads, safeFailure } from "./upload-diagnostics.mjs"
import { createGuildChannelFixture, cleanupGuildChannelFixtures } from "./channel-fixture.mjs"
import { createReactionEmoji, cleanupReactionEmoji } from "./reaction-fixture.mjs"
import { createGuildTestRole, cleanupGuildTestRole } from "./guild-fixture.mjs"
import { cleanupModeration } from "./moderation-fixture.mjs"
import { verifyAttachmentSources } from "./attachment-sources.mjs"

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
const pagination = process.argv[3] === "--pagination"
const cache = process.argv[3] === "--cache"
const collectors = process.argv[3] === "--collectors"
const embeds = process.argv[3] === "--embeds"
const smallAttachments = process.argv[3] === "--attachments-small"
const attachments = process.argv[3] === "--attachments" || smallAttachments
const attachmentSources = process.argv[3] === "--attachment-sources"
const reactions = process.argv[3] === "--reactions"
const pins = process.argv[3] === "--pins"
const guilds = process.argv[3] === "--guilds"
const channels = process.argv[3] === "--channels"
const batchDelete = process.argv[3] === "--batch-delete"
const cleanupCheck = process.argv[3] === "--cleanup"
const moderation = process.argv[3] === "--moderation"
const search = process.argv[3] === "--search"
const optionalTools = process.argv[3] === "--optional-tools"
const nonceOnly = process.argv[3] === "--nonce-only"
// This probe verifies outbound REST lifetime through both APIs, not delivery of the bot's own typing notices
const typing = process.argv[3] === "--typing"
let moderationUserId = process.env.FLUXER_TEST_MODERATION_USER_ID
const forceRecovery = recover || cache || collectors || attachments || reactions || pins || guilds || channels
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

async function waitForTypingRequests(requests, minimum) {
    const deadline = performance.now() + 15_000
    while (requests.length < minimum) {
        assert.ok(performance.now() < deadline, "Typing refresh deadline")
        await sleep(20)
    }
}

async function assertTypingStopped(requests) {
    const count = requests.length
    await sleep(8_250)
    assert.equal(requests.length, count)
}

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

async function waitForCondition(matches, deadlineMessage) {
    const deadline = performance.now() + 10_000
    while (!matches()) {
        assert.ok(performance.now() < deadline, deadlineMessage)
        await sleep(20)
    }
}

async function verifyOptionalTools(ops, channelId, botId) {
    const marker = `optional-tools-${randomUUID().replaceAll("-", "")}`
    const commandName = `verify-${marker}`
    let prefix = "!"
    let invocation = `${prefix}${commandName}`
    const responseContent = `${marker} response`
    const embedTitle = `${marker} builder`
    const response = ops.builders
        .message()
        .content(responseContent)
        .embed(ops.builders.embed().title(embedTitle).field("Mode", "live", true))
        .build()
    const claims = []
    const executions = []
    const replies = []
    const rejections = []
    const feedbackReplies = []
    const unmatched = []
    const unmatchedReplies = []
    const cooldown = await ops.cooldowns(claims)

    stage = "optional_tools_router_attachment"
    await ops.assertConnected()
    const initial = await ops.create({
        prefix: () => prefix,
        ignoreBots: false,
        parse: ops.parseQuoted,
        onUnmatched: ops.reject(async (message, outcome) => {
            if (message.channelId !== channelId || message.author.id !== botId) return
            unmatched.push({ messageId: message.id, outcome })
            unmatchedReplies.push(
                await ops.reply(message, { content: `${marker} ${outcome._tag}`, allowedMentions: {} }),
            )
        }),
    })
    const router = await ops.register(initial, {
        name: commandName,
        description: "Live command feedback check",
        guard: ops.guard(
            (message) =>
                message.channelId === channelId && message.author.id === botId && message.content === invocation,
        ),
        cooldown: { store: cooldown.store, durationMs: 60_000 },
        onReject: ops.reject(async (message, rejection) => {
            if (rejection._tag === "CommandCooldownActive")
                feedbackReplies.push(await ops.reply(message, { content: `${marker} cooldown`, allowedMentions: {} }))
            rejections.push(rejection)
        }),
        execute: ops.execute(async (message) => {
            executions.push(message.id)
            replies.push(await ops.reply(message, response))
        }),
    })
    assert.notEqual(router, initial)
    assert.equal(router.commands[0].description, "Live command feedback check")
    let subscription = await ops.attach(router)
    try {
        stage = "optional_tools_command_dispatch"
        const first = await ops.send({ content: invocation })
        await waitForCondition(() => replies.length === 1, "Optional command reply deadline")
        assert.deepEqual(executions, [first.id])
        const reply = replies[0]
        report(stage, true)

        stage = "optional_tools_builder_raw_readback"
        const rawReply = await api("GET", `/channels/${channelId}/messages/${reply.id}`)
        assert.equal(rawReply.status, 200)
        assert.equal(rawReply.data?.channel_id, channelId)
        assert.equal(rawReply.data?.content, responseContent)
        assert.equal(rawReply.data?.embeds?.[0]?.title, embedTitle)
        assert.equal(rawReply.data?.embeds?.[0]?.fields?.[0]?.name, "Mode")
        assert.equal(rawReply.data?.message_reference?.message_id, first.id)
        assert.equal(rawReply.data?.mention_everyone, false)
        assert.deepEqual(rawReply.data?.mentions, [])
        report(stage, true)

        stage = "optional_tools_local_cooldown"
        prefix = "?"
        invocation = `${prefix}${commandName}`
        const second = await ops.send({ content: invocation })
        await waitForCondition(() => rejections.length === 1, "Optional command feedback deadline")
        assert.equal(rejections[0]._tag, "CommandCooldownActive")
        assert.ok(rejections[0].retryAtMs > Date.now())
        const feedbackHistory = await api("GET", `/channels/${channelId}/messages?limit=100`)
        assert.ok(
            feedbackHistory.data.some(
                (message) =>
                    message.content === `${marker} cooldown` && message.message_reference?.message_id === second.id,
            ),
        )
        assert.deepEqual(
            claims.map((claim) => claim._tag),
            ["CooldownAcquired", "CooldownActive"],
        )
        assert.deepEqual(executions, [first.id])
        report(stage, true)

        stage = "optional_tools_unmatched_feedback"
        const unknown = await ops.send({ content: `${prefix}unknown-${marker}` })
        await waitForCondition(() => unmatchedReplies.length === 1, "Unknown-command feedback deadline")
        assert.equal(unmatched[0].messageId, unknown.id)
        assert.deepEqual(unmatched[0].outcome, { _tag: "CommandUnknownName", name: `unknown-${marker}` })
        const malformed = await ops.send({ content: `${prefix}${commandName} \"unterminated` })
        await waitForCondition(() => unmatchedReplies.length === 2, "Parser-rejection feedback deadline")
        assert.equal(unmatched[1].messageId, malformed.id)
        assert.deepEqual(unmatched[1].outcome, { _tag: "CommandParserRejected" })
        for (const [index, command] of [unknown, malformed].entries()) {
            const readback = await api("GET", `/channels/${channelId}/messages/${unmatchedReplies[index].id}`)
            assert.equal(readback.status, 200)
            assert.equal(readback.data.content, `${marker} ${unmatched[index].outcome._tag}`)
            assert.equal(readback.data.message_reference?.message_id, command.id)
            assert.equal(readback.data.mention_everyone, false)
            assert.deepEqual(readback.data.mentions, [])
        }
        assert.deepEqual(executions, [first.id])
        assert.equal(claims.length, 2)
        report(stage, true)

        stage = "optional_tools_unsubscribe"
        await ops.close(subscription)
        subscription = undefined
        await cooldown.clear()
        const observed = []
        const observer = await ops.observe((message) => {
            if (message.channelId === channelId && message.author.id === botId) observed.push(message.id)
        })
        try {
            const unmatchedAfterUnsubscribe = await ops.send({ content: `${prefix}unknown-${marker}` })
            const afterUnsubscribe = await ops.send({ content: invocation })
            await waitForCondition(
                () => observed.includes(afterUnsubscribe.id) && observed.includes(unmatchedAfterUnsubscribe.id),
                "Optional command post-unsubscribe gateway deadline",
            )
            await sleep(250)
            assert.deepEqual(executions, [first.id])
            assert.equal(claims.length, 2)
            assert.equal(unmatched.length, 2)
            const rawHistory = await api("GET", `/channels/${channelId}/messages?limit=100`)
            assert.equal(rawHistory.status, 200)
            assert.ok(Array.isArray(rawHistory.data))
            assert.deepEqual(
                rawHistory.data
                    .filter((message) =>
                        [first.id, second.id, afterUnsubscribe.id].includes(message?.message_reference?.message_id),
                    )
                    .map((message) => message.id)
                    .sort(),
                [reply.id, feedbackReplies[0].id].sort(),
            )
        } finally {
            await observer.close()
        }
        report(stage, true)
        report("optional_tools", true)
    } finally {
        if (subscription !== undefined) await ops.close(subscription)
    }
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
            await collector.close?.()
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
        stage = "role_hoist_positions"
        await ops.setHoistPositions([
            { id: roleId, hoistPosition: 1 },
            { id: secondId, hoistPosition: 0 },
        ])
        const hoisted = (await api("GET", `/guilds/${guildId}/roles`)).data
        assert.equal(hoisted.find((role) => role.id === roleId).hoist_position, 1)
        assert.equal(hoisted.find((role) => role.id === secondId).hoist_position, 0)
        assert.deepEqual(
            hoisted.map((role) => [role.id, role.position, role.hoist]),
            readback.map((role) => [role.id, role.position, role.hoist]),
        )
        assert.deepEqual(
            hoisted
                .filter((role) => role.id !== roleId && role.id !== secondId)
                .map((role) => [role.id, role.hoist_position]),
            readback
                .filter((role) => role.id !== roleId && role.id !== secondId)
                .map((role) => [role.id, role.hoist_position]),
        )
        await waitEvent("guildRoleUpdateBulk", (value) =>
            value.roles.some((role) => role.id === roleId && role.hoistPosition === 1),
        )
        report(stage, true)
        stage = "role_hoist_uncertain_write"
        const beforeLoss = globalThis.fetch
        let hoistDispatches = 0
        globalThis.fetch = async (...args) => {
            const response = await beforeLoss(...args)
            if (
                args[1]?.method === "PATCH" &&
                new URL(args[0]).pathname === `/v1/guilds/${guildId}/roles/hoist-positions`
            ) {
                hoistDispatches++
                assert.equal(response.status, 204)
                await response.arrayBuffer()
                await waitEvent("guildRoleUpdateBulk", (value) =>
                    value.roles.some((role) => role.id === roleId && role.hoistPosition === 2),
                )
                throw new Error("Test-owned response loss")
            }
            return response
        }
        try {
            await assert.rejects(
                ops.setHoistPositions([{ id: roleId, hoistPosition: 2 }]),
                (error) => error.outcome === "unknown",
            )
            assert.equal(hoistDispatches, 1)
            assert.equal(await ops.getRole(roleId), undefined)
        } finally {
            globalThis.fetch = beforeLoss
        }
        assert.equal(
            (await api("GET", `/guilds/${guildId}/roles`)).data.find((role) => role.id === roleId).hoist_position,
            2,
        )
        assert.equal((await ops.roles()).find((role) => role.id === roleId).hoistPosition, 2)
        report(stage, true)
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

async function verifyCacheRestAdmissionAndExpiry(send, reply, get, channelId) {
    stage = "cache_rest_send_and_reply"
    const seed = await send(channelId, { content: `cache-rest-seed-${randomUUID()}` })
    assert.equal((await get(seed))?.content, seed.content)
    const replied = await reply(seed, { content: `cache-rest-reply-${randomUUID()}` })
    assert.equal((await get(replied))?.content, replied.content)
    report(stage, true)
    await verifyCacheExpiry(send, get, channelId)
}

async function verifyCacheGatewayRebuild(get, channelId) {
    stage = "cache_gateway_rebuild_after_recovery"
    const content = `cache-gateway-rebuild-${randomUUID()}`
    const sent = await api("POST", `/channels/${channelId}/messages`, { content })
    assert.equal(sent.status, 200)
    assert.match(sent.data?.id ?? "", /^\d+$/)
    const target = { channelId, id: sent.data.id }
    await waitForCache(get, target, (snapshot) => snapshot?.content === content)
    const remote = await api("GET", `/channels/${channelId}/messages/${target.id}`)
    assert.equal(remote.status, 200)
    assert.equal(remote.data?.content, content)
    report("cache_rebuilt_after_recovery", true)
}

async function verifyChannels(ops, mainChannelId, botId, interrupt) {
    const rawChannel = async (id) => {
        const response = await api("GET", `/channels/${id}`)
        assert.equal(response.status, 200)
        assert.equal(response.data?.id, id)
        assert.equal(response.data?.guild_id, guildId)
        return response.data
    }
    const rawOverwrites = (channel) => channel.permission_overwrites ?? []
    const normalizeOverwrites = (overwrites) =>
        [...overwrites]
            .map((overwrite) => [
                overwrite.id,
                overwrite.type === 0 ? "role" : overwrite.type === 1 ? "member" : overwrite.type,
                String(overwrite.allow),
                String(overwrite.deny),
            ])
            .sort((left, right) => left.join("/").localeCompare(right.join("/")))
    const assertSnapshot = (snapshot, id, type) => {
        assert.equal(snapshot?.id, id)
        assert.equal(snapshot?.guildId, guildId)
        assert.equal(snapshot?.type, type)
        assert.ok(Object.isFrozen(snapshot))
        if (snapshot.permissionOverwrites !== undefined) assert.ok(Object.isFrozen(snapshot.permissionOverwrites))
    }
    const seen = {
        guildChannelCreate: [],
        guildChannelUpdate: [],
        guildChannelDelete: [],
        guildChannelUpdateBulk: [],
    }
    const stops = []
    const waitFor = async (predicate, message) => {
        const deadline = performance.now() + 15_000
        while (true) {
            const value = await predicate()
            if (value !== undefined) return value
            assert.ok(performance.now() < deadline, message)
            await sleep(20)
        }
    }
    const waitForEvent = (event, from, predicate) =>
        waitFor(() => seen[event].slice(from).find(predicate), `Guild channel ${event} deadline`)
    const waitForCache = (id, predicate) =>
        waitFor(async () => {
            const snapshot = await ops.get(id)
            return predicate(snapshot) ? snapshot : undefined
        }, "Guild channel cache deadline")
    const createFixture = (key, input) =>
        createGuildChannelFixture(
            journal,
            () => writeFileSync(journalPath, JSON.stringify(journal)),
            key,
            input,
            (input) => ops.create(guildId, input),
        )

    stage = "channel_remote_reads"
    const initial = await ops.fetch(mainChannelId)
    assertSnapshot(initial, mainChannelId, 0)
    const initialRaw = await rawChannel(mainChannelId)
    assert.equal(initial.name, initialRaw.name)
    assert.equal((await ops.get(mainChannelId))?.id, mainChannelId)
    const listed = await ops.fetchAll(guildId)
    const rawListed = await api("GET", `/guilds/${guildId}/channels`)
    assert.ok(Array.isArray(rawListed.data))
    assert.deepEqual(
        listed.map((channel) => channel.id),
        rawListed.data.map((channel) => channel.id),
    )
    assert.ok(listed.every(Object.isFrozen))
    report(stage, true)

    try {
        for (const event of Object.keys(seen)) {
            stops.push(
                await ops.on(event, (value) => {
                    if (event === "guildChannelUpdateBulk") {
                        if (value.guildId !== guildId) return
                        assert.ok(seen[event].length < 64)
                        assert.equal(value.guildId, guildId)
                        assert.ok(Object.isFrozen(value) && Object.isFrozen(value.channels))
                        for (const channel of value.channels) assertSnapshot(channel, channel.id, channel.type)
                    } else {
                        if (value.guildId !== guildId) return
                        assert.ok(seen[event].length < 64)
                        assert.equal(value.guildId, guildId)
                        assertSnapshot(value, value.id, value.type)
                        if (value.permissionOverwrites !== undefined)
                            assert.ok(value.permissionOverwrites.every(Object.isFrozen))
                    }
                    seen[event].push(value)
                }),
            )
        }

        stage = "channel_category_create"
        const categoryA = await createFixture("categoryA", { type: 4 })
        assertSnapshot(categoryA, categoryA.id, 4)
        const createdCategoryA = await waitForEvent(
            "guildChannelCreate",
            0,
            (value) => value.id === categoryA.id && value.type === 4,
        )
        assert.equal(createdCategoryA.name, categoryA.name)
        assert.equal((await rawChannel(categoryA.id)).name, categoryA.name)
        const categoryB = await createFixture("categoryB", { type: 4 })
        assertSnapshot(categoryB, categoryB.id, 4)
        const createdCategoryB = await waitForEvent(
            "guildChannelCreate",
            0,
            (value) => value.id === categoryB.id && value.type === 4,
        )
        assert.equal(createdCategoryB.name, categoryB.name)
        assert.equal((await rawChannel(categoryB.id)).name, categoryB.name)
        report(stage, true)

        stage = "channel_permission_overwrites"
        let updates = seen.guildChannelUpdate.length
        await ops.setPermissionOverwrite(categoryA.id, { id: guildId, type: "role", allow: 0n, deny: 0n })
        await waitForEvent("guildChannelUpdate", updates, (value) => value.id === categoryA.id)
        updates = seen.guildChannelUpdate.length
        await ops.setPermissionOverwrite(categoryA.id, { id: botId, type: "member", allow: 0n, deny: 0n })
        await waitForEvent("guildChannelUpdate", updates, (value) => value.id === categoryA.id)
        let categoryARaw = await rawChannel(categoryA.id)
        assert.deepEqual(
            normalizeOverwrites(rawOverwrites(categoryARaw)),
            normalizeOverwrites([
                { id: guildId, type: "role", allow: "0", deny: "0" },
                { id: botId, type: "member", allow: "0", deny: "0" },
            ]),
        )
        updates = seen.guildChannelUpdate.length
        await ops.removePermissionOverwrite(categoryA.id, botId)
        await waitForEvent("guildChannelUpdate", updates, (value) => value.id === categoryA.id)
        categoryARaw = await rawChannel(categoryA.id)
        assert.deepEqual(
            normalizeOverwrites(rawOverwrites(categoryARaw)),
            normalizeOverwrites([{ id: guildId, type: "role", allow: "0", deny: "0" }]),
        )
        updates = seen.guildChannelUpdate.length
        await ops.setPermissionOverwrite(categoryB.id, { id: botId, type: "member", allow: 0n, deny: 0n })
        await waitForEvent("guildChannelUpdate", updates, (value) => value.id === categoryB.id)
        const categoryBRaw = await rawChannel(categoryB.id)
        assert.deepEqual(
            normalizeOverwrites(rawOverwrites(categoryBRaw)),
            normalizeOverwrites([{ id: botId, type: "member", allow: "0", deny: "0" }]),
        )
        report(stage, true)

        stage = "channel_inheritance_and_explicit_overwrites"
        const inherited = await createFixture("inheritedChild", { type: 0, parentId: categoryA.id })
        assertSnapshot(inherited, inherited.id, 0)
        await waitForEvent("guildChannelCreate", 0, (value) => value.id === inherited.id)
        const inheritedRaw = await rawChannel(inherited.id)
        assert.equal(inheritedRaw.parent_id, categoryA.id)
        assert.deepEqual(
            normalizeOverwrites(rawOverwrites(inheritedRaw)),
            normalizeOverwrites(rawOverwrites(categoryARaw)),
        )
        const explicit = await createFixture("explicitChild", {
            type: 0,
            parentId: categoryA.id,
            permissionOverwrites: [],
        })
        assertSnapshot(explicit, explicit.id, 0)
        await waitForEvent("guildChannelCreate", 0, (value) => value.id === explicit.id)
        const explicitRaw = await rawChannel(explicit.id)
        assert.equal(explicitRaw.parent_id, categoryA.id)
        assert.deepEqual(rawOverwrites(explicitRaw), [])
        report(stage, true)

        stage = "channel_edit_readback"
        const editedCategoryName = `${journal.channelFixtures.categoryA.marker}-edited`
        updates = seen.guildChannelUpdate.length
        const editedCategory = await ops.edit(categoryA.id, { name: editedCategoryName })
        assertSnapshot(editedCategory, categoryA.id, 4)
        assert.equal(editedCategory.name, editedCategoryName)
        await waitForEvent(
            "guildChannelUpdate",
            updates,
            (value) => value.id === categoryA.id && value.name === editedCategoryName,
        )
        categoryARaw = await rawChannel(categoryA.id)
        assert.equal(categoryARaw.name, editedCategoryName)
        report(stage, true)

        stage = "channel_reorder_keep_permissions"
        let bulk = seen.guildChannelUpdateBulk.length
        await ops.reorder(guildId, [{ id: explicit.id, parentId: categoryB.id, syncPermissionsOnMove: false }])
        await waitForEvent("guildChannelUpdateBulk", bulk, (value) =>
            value.channels.some((channel) => channel.id === explicit.id && channel.parentId === categoryB.id),
        )
        let movedRaw = await rawChannel(explicit.id)
        assert.equal(movedRaw.parent_id, categoryB.id)
        assert.deepEqual(rawOverwrites(movedRaw), [])
        report(stage, true)

        stage = "channel_reorder_copy_permissions"
        bulk = seen.guildChannelUpdateBulk.length
        await ops.reorder(guildId, [{ id: explicit.id, parentId: categoryA.id, syncPermissionsOnMove: true }])
        await waitForEvent("guildChannelUpdateBulk", bulk, (value) =>
            value.channels.some((channel) => channel.id === explicit.id && channel.parentId === categoryA.id),
        )
        movedRaw = await rawChannel(explicit.id)
        assert.equal(movedRaw.parent_id, categoryA.id)
        assert.deepEqual(normalizeOverwrites(rawOverwrites(movedRaw)), normalizeOverwrites(rawOverwrites(categoryARaw)))
        bulk = seen.guildChannelUpdateBulk.length
        await ops.reorder(guildId, [{ id: explicit.id, parentId: categoryB.id, syncPermissionsOnMove: true }])
        await waitForEvent("guildChannelUpdateBulk", bulk, (value) =>
            value.channels.some((channel) => channel.id === explicit.id && channel.parentId === categoryB.id),
        )
        movedRaw = await rawChannel(explicit.id)
        assert.equal(movedRaw.parent_id, categoryB.id)
        assert.deepEqual(normalizeOverwrites(rawOverwrites(movedRaw)), normalizeOverwrites(rawOverwrites(categoryBRaw)))
        report(stage, true)

        stage = "channel_cache_unknown_write"
        await ops.fetch(explicit.id)
        await waitForCache(explicit.id, (value) => value?.id === explicit.id)
        const uncertainName = `${journal.channelFixtures.explicitChild.marker}-uncertain`
        const originalFetch = globalThis.fetch
        let dispatched = 0
        updates = seen.guildChannelUpdate.length
        globalThis.fetch = async (...args) => {
            const response = await originalFetch(...args)
            if (args[1]?.method === "PATCH" && new URL(args[0]).pathname === `/v1/channels/${explicit.id}`) {
                dispatched++
                assert.equal(response.status, 200)
                await response.arrayBuffer()
                await waitForEvent(
                    "guildChannelUpdate",
                    updates,
                    (value) => value.id === explicit.id && value.name === uncertainName,
                )
                await waitForCache(explicit.id, (value) => value?.name === uncertainName)
                throw new Error("Test-owned channel response loss")
            }
            return response
        }
        try {
            await assert.rejects(ops.edit(explicit.id, { name: uncertainName }), (error) => {
                assert.equal(error?._tag, "ChannelOperationError")
                assert.equal(error.operation, "channels.edit")
                assert.equal(error.outcome, "unknown")
                return true
            })
            assert.equal(dispatched, 1)
            assert.equal(await ops.get(explicit.id), undefined)
        } finally {
            globalThis.fetch = originalFetch
        }
        movedRaw = await rawChannel(explicit.id)
        assert.equal(movedRaw.name, uncertainName)
        assert.equal((await ops.fetch(explicit.id)).name, uncertainName)
        assert.equal((await ops.get(explicit.id))?.name, uncertainName)
        report(stage, true)

        stage = "channel_cache_recovery_gap"
        await ops.fetch(categoryA.id)
        assert.equal((await ops.get(categoryA.id))?.id, categoryA.id)
        await interrupt()
        assert.equal(await ops.get(categoryA.id), undefined)
        report(stage, true)

        stage = "channel_after_resume"
        const resumedCategory = await ops.fetch(categoryA.id)
        assert.equal(resumedCategory.name, editedCategoryName)
        updates = seen.guildChannelUpdate.length
        const resumedName = `${journal.channelFixtures.categoryA.marker}-resumed`
        const afterResume = await ops.edit(categoryA.id, { name: resumedName })
        assert.equal(afterResume.name, resumedName)
        await waitForEvent(
            "guildChannelUpdate",
            updates,
            (value) => value.id === categoryA.id && value.name === resumedName,
        )
        assert.equal((await rawChannel(categoryA.id)).name, resumedName)
        report(stage, true)

        stage = "channel_delete_readback"
        const beforeDelete = await ops.fetch(explicit.id)
        const deletes = seen.guildChannelDelete.length
        await ops.delete(explicit.id)
        const deleted = await waitForEvent("guildChannelDelete", deletes, (value) => value.id === explicit.id)
        assertSnapshot(deleted, explicit.id, 0)
        assert.equal(deleted.name, beforeDelete.name)
        assert.equal(deleted.parentId, beforeDelete.parentId)
        assert.deepEqual(
            normalizeOverwrites(deleted.permissionOverwrites ?? []),
            normalizeOverwrites(beforeDelete.permissionOverwrites ?? []),
        )
        assert.equal((await api("GET", `/channels/${explicit.id}`)).status, 404)
        assert.equal(await ops.get(explicit.id), undefined)
        report(stage, true)
    } finally {
        for (const stop of stops) await stop()
    }
}

async function cleanup() {
    if (!journal) return
    assert.equal(journal.guildId, guildId)
    assert.match(journal.name, /^fluxerly-sdk-test-[a-f0-9]{32}$/)
    let moderationFailure
    try {
        await cleanupModeration(api, journal, moderationUserId)
        if (journal.moderation) report("moderation_ban_and_timeout_cleared", true)
    } catch (error) {
        moderationFailure = error
    }
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
    let channelFixtureFailure
    try {
        await cleanupGuildChannelFixtures(api, journal)
        if (journal.channelFixtures !== undefined) report("test_owned_channels_removed", true)
    } catch (error) {
        channelFixtureFailure = error
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
    if (moderationFailure) throw moderationFailure
    if (emojiFailure) throw emojiFailure
    if (roleFailure) throw roleFailure
    if (channelFixtureFailure) throw channelFixtureFailure
    unlinkSync(journalPath)
    journal = undefined
}

async function verifyModeration(ops, botId) {
    stage = "moderation_target_verification"
    assert.match(moderationUserId ?? "", /^[1-9][0-9]*$/)
    assert.notEqual(moderationUserId, botId)
    const guild = (await api("GET", `/guilds/${guildId}`)).data
    assert.equal(guild?.id, guildId)
    assert.notEqual(guild.owner_id, moderationUserId)
    const target = { guildId, userId: moderationUserId }
    const member = await api("GET", `/guilds/${guildId}/members/${moderationUserId}`)
    assert.equal(member.status, 200)
    assert.equal(member.data?.user?.id, moderationUserId)
    assert.equal(member.data.communication_disabled_until ?? null, null)
    const roles = await api("GET", `/guilds/${guildId}/roles`)
    assert.equal(roles.status, 200)
    assert.ok(Array.isArray(roles.data))
    const assigned = new Set([guildId, ...member.data.roles])
    assert.ok(!roles.data.some((role) => assigned.has(role.id) && (BigInt(role.permissions) & 8n) !== 0n))
    assert.ok(!(await ops.bans()).some((ban) => ban.userId === moderationUserId))
    assert.equal((await api("GET", `/guilds/${guildId}/audit-logs?user_id=${botId}&limit=10`)).status, 200)
    journal.moderation = { userId: moderationUserId, botId, reason: `${journal.name}-moderation` }
    const save = () => writeFileSync(journalPath, JSON.stringify(journal))
    save()
    const notices = []
    const stops = []
    for (const event of ["guildMemberUpdate", "guildMemberRemove", "guildBanAdd", "guildBanRemove"])
        stops.push(
            await ops.on(event, (value) => {
                if (value.guildId === guildId && value.userId === moderationUserId && notices.length < 40)
                    notices.push({ event, value })
            }),
        )
    const waitFor = async (predicate, timeout = 10_000) => {
        const deadline = performance.now() + timeout
        while (!predicate()) {
            assert.ok(performance.now() < deadline)
            await sleep(20)
        }
    }
    const memberPath = `https://api.fluxer.app/v1/guilds/${guildId}/members/${moderationUserId}`
    let loseTimeoutResponse = false
    let timeoutAttempts = 0
    globalThis.fetch = async (url, init) => {
        if (String(url) === memberPath && init.method === "PATCH") {
            const until = JSON.parse(init.body).communication_disabled_until
            if (until !== null) {
                journal.moderation.timeoutUntil = until
                save()
            }
            const response = await rawFetch(url, init)
            if (loseTimeoutResponse && response.status === 200) {
                timeoutAttempts++
                await response.body?.cancel()
                throw new Error("Test-owned response loss")
            }
            return response
        }
        return rawFetch(url, init)
    }
    try {
        report(stage, true)
        stage = "moderation_timeout_and_clear"
        const timed = await ops.timeout(target, 60_000, { auditReason: journal.moderation.reason })
        const observed = (await api("GET", `/guilds/${guildId}/members/${moderationUserId}`)).data
        assert.equal(Date.parse(timed.communicationDisabledUntil), Date.parse(observed.communication_disabled_until))
        await waitFor(() =>
            notices.some(
                (n) =>
                    n.event === "guildMemberUpdate" &&
                    Date.parse(n.value.communicationDisabledUntil) === Date.parse(timed.communicationDisabledUntil),
            ),
        )
        assert.equal((await ops.clearTimeout(target)).communicationDisabledUntil, null)
        assert.equal(
            (await api("GET", `/guilds/${guildId}/members/${moderationUserId}`)).data?.communication_disabled_until,
            null,
        )
        report(stage, true)
        stage = "moderation_lost_timeout_response"
        loseTimeoutResponse = true
        await assert.rejects(
            ops.timeout(target, 60_000),
            (error) => error._tag === "GuildOperationError" && error.outcome === "unknown",
        )
        loseTimeoutResponse = false
        assert.equal(timeoutAttempts, 1)
        assert.equal(
            Date.parse((await ops.fetch(target)).communicationDisabledUntil),
            Date.parse(journal.moderation.timeoutUntil),
        )
        await ops.clearTimeout(target)
        report(stage, true)
        stage = "moderation_kick"
        await ops.kick(target, { auditReason: journal.moderation.reason })
        assert.equal((await api("GET", `/guilds/${guildId}/members/${moderationUserId}`)).status, 404)
        assert.equal(await ops.get(target), undefined)
        await waitFor(() => notices.some((n) => n.event === "guildMemberRemove"))
        report(stage, true)
        stage = "moderation_temporary_ban_expiry"
        await ops.ban(target, { reason: journal.moderation.reason, durationSeconds: 60 })
        const listed = (await ops.bans()).find((ban) => ban.userId === moderationUserId)
        assert.equal(listed?.reason, journal.moderation.reason)
        assert.ok(Date.parse(listed?.expiresAt) > Date.now())
        report("moderation_temporary_ban_recorded", true)
        stage = "moderation_ban_add_event"
        await waitFor(() => notices.some((n) => n.event === "guildBanAdd"))
        report(stage, true)
        stage = "moderation_temporary_ban_remote_expiry"
        const expiryDeadline = performance.now() + 130_000
        while ((await ops.bans()).some((ban) => ban.userId === moderationUserId)) {
            assert.ok(performance.now() < expiryDeadline)
            await sleep(5_000)
        }
        const expired = await api("GET", `/guilds/${guildId}/bans`)
        assert.equal(expired.status, 200)
        assert.ok(Array.isArray(expired.data) && !expired.data.some((ban) => ban.user?.id === moderationUserId))
        report(stage, true)
        stage = "moderation_permanent_ban_and_unban"
        await ops.ban(target, { reason: journal.moderation.reason }, { auditReason: journal.moderation.reason })
        assert.equal((await ops.bans()).find((ban) => ban.userId === moderationUserId)?.expiresAt, null)
        const removals = notices.filter((notice) => notice.event === "guildBanRemove").length
        await ops.unban(target, { auditReason: journal.moderation.reason })
        assert.ok(!(await ops.bans()).some((ban) => ban.userId === moderationUserId))
        await waitFor(() => notices.filter((notice) => notice.event === "guildBanRemove").length > removals)
        assert.equal((await api("GET", `/guilds/${guildId}/members/${moderationUserId}`)).status, 404)
        report(stage, true)
        stage = "moderation_audit_reasons"
        const audit = await api("GET", `/guilds/${guildId}/audit-logs?user_id=${botId}&limit=20`)
        assert.equal(audit.status, 200)
        assert.ok(Array.isArray(audit.data?.audit_log_entries))
        for (const action of [20, 22, 23, 24])
            assert.ok(
                audit.data.audit_log_entries.some(
                    (entry) =>
                        entry.action_type === action &&
                        entry.user_id === botId &&
                        entry.target_id === moderationUserId &&
                        entry.reason === journal.moderation.reason,
                ),
            )
        report(stage, true)
        report("moderation_target_needs_manual_rejoin", true)
    } finally {
        globalThis.fetch = rawFetch
        for (const stop of stops) await stop()
    }
}
async function verifyBatchDeletion(ops, channelId, botId) {
    const notices = []
    const stop = await ops.on((notice) => {
        if (notice.channelId === channelId && notices.length < 10) notices.push(notice)
    })
    const seed = async () => {
        const sent = await ops.send({ content: `batch-delete-${randomUUID()}` })
        const actual = await api("GET", `/channels/${channelId}/messages/${sent.id}`)
        assert.equal(actual.status, 200)
        assert.equal(actual.data?.author?.id, botId)
        assert.equal(actual.data?.content, sent.content)
        return sent
    }
    try {
        stage = "batch_delete_selected_messages"
        const first = await seed()
        const second = await seed()
        const retained = await seed()
        assert.equal((await ops.get(first))?.id, first.id)
        await ops.deleteMany([first.id, second.id])
        for (const message of [first, second]) {
            assert.equal((await api("GET", `/channels/${channelId}/messages/${message.id}`)).status, 404)
            assert.equal(await ops.get(message), undefined)
        }
        assert.equal((await api("GET", `/channels/${channelId}/messages/${retained.id}`)).status, 200)
        assert.equal((await ops.get(retained))?.id, retained.id)
        const deadline = performance.now() + 10_000
        while (!notices.some((notice) => notice.ids.includes(first.id) && notice.ids.includes(second.id))) {
            assert.ok(performance.now() < deadline)
            await sleep(20)
        }
        report(stage, true)
        stage = "batch_delete_missing_ids"
        await ops.deleteMany([first.id, second.id])
        report(stage, true)
        stage = "batch_delete_lost_response"
        const uncertain = await seed()
        let attempts = 0
        globalThis.fetch = async (url, init) => {
            if (String(url) === `https://api.fluxer.app/v1/channels/${channelId}/messages/bulk-delete`) {
                attempts++
                const response = await rawFetch(url, init)
                if (response.status === 204) {
                    await response.body?.cancel()
                    throw new Error("Test-owned response loss")
                }
                return response
            }
            return rawFetch(url, init)
        }
        try {
            await assert.rejects(
                ops.deleteMany([uncertain.id]),
                (error) =>
                    error._tag === "MessageOperationError" && error.reason === "network" && error.outcome === "unknown",
            )
        } finally {
            globalThis.fetch = rawFetch
        }
        assert.equal(attempts, 1)
        assert.equal((await api("GET", `/channels/${channelId}/messages/${uncertain.id}`)).status, 404)
        assert.equal(await ops.get(uncertain), undefined)
        report(stage, true)
    } finally {
        await stop()
    }
}

async function verifyCleanup(ops, channelId, botId) {
    const marker = `cleanup-${randomUUID()}`
    const seed = async (suffix) => ops.send({ content: `${marker}-${suffix}` })
    stage = "cleanup_preview_exact_plan"
    const first = await seed("first")
    const second = await seed("second")
    const plan = await ops.preview({
        authorId: botId,
        filter: (message) => message.content.startsWith(marker),
        maxScanned: 500,
        maxSelected: 200,
    })
    assert.deepEqual(new Set(plan.selectedMessages.map((message) => message.id)), new Set([first.id, second.id]))
    const late = await seed("late")
    const progress = []
    const cleanupReport = await ops.cleanup(plan, { onProgress: (event) => progress.push(event.state) })
    assert.deepEqual(new Set(cleanupReport.selectedMessageIds), new Set([first.id, second.id]))
    assert.equal(cleanupReport.submittedBatches.length, 1)
    assert.deepEqual(progress, ["submitting", "submitted"])
    for (const message of [first, second])
        assert.equal((await api("GET", `/channels/${channelId}/messages/${message.id}`)).status, 404)
    assert.equal((await api("GET", `/channels/${channelId}/messages/${late.id}`)).status, 200)
    report(stage, true)

    stage = "cleanup_partial_response_loss"
    const partialMarker = `cleanup-loss-${randomUUID()}`
    for (let index = 0; index < 101; index++) await ops.send({ content: `${partialMarker}-${index}` })
    const partialPlan = await ops.preview({
        authorId: botId,
        filter: (message) => message.content.startsWith(partialMarker),
        maxScanned: 500,
        maxSelected: 150,
    })
    assert.equal(partialPlan.selectedMessages.length, 101)
    let submissions = 0
    globalThis.fetch = async (url, init) => {
        if (String(url) === `https://api.fluxer.app/v1/channels/${channelId}/messages/bulk-delete`) {
            submissions++
            const response = await rawFetch(url, init)
            if (submissions === 2 && response.status === 204) {
                await response.body?.cancel()
                throw new Error("Test-owned cleanup response loss")
            }
            return response
        }
        return rawFetch(url, init)
    }
    let failure
    try {
        await assert.rejects(ops.cleanup(partialPlan), (error) => {
            failure = error
            return error?._tag === "MessageCleanupError" && error.reason === "network" && error.outcome === "unknown"
        })
    } finally {
        globalThis.fetch = rawFetch
    }
    assert.equal(submissions, 2)
    assert.equal(failure?.submittedBatches.length, 1)
    const terminalIds = partialPlan.selectedMessages.slice(100).map((message) => message.id)
    const earlierBatchIds = partialPlan.selectedMessages.slice(0, 100).map((message) => message.id)
    assert.deepEqual(failure?.terminalBatchIds, terminalIds)
    for (const id of terminalIds) assert.equal((await api("GET", `/channels/${channelId}/messages/${id}`)).status, 404)
    stage = "cleanup_partial_raw_readback"
    assert.equal((await api("GET", `/channels/${channelId}/messages/${earlierBatchIds[0]}`)).status, 404)
    const boundedHistory = await api("GET", `/channels/${channelId}/messages?limit=100`)
    assert.equal(boundedHistory.status, 200)
    assert.ok(Array.isArray(boundedHistory.data))
    assert.ok(!boundedHistory.data.some((message) => message.content?.startsWith(partialMarker)))
    report(stage, true)
}

async function verifyWorkflowReads(ops, botId) {
    stage = "workflow_guild_list_readonly"
    const page = await ops.guildList()
    const membership = page.find((guild) => guild.id === guildId)
    assert.ok(membership)
    if (membership.permissions !== undefined) assert.equal(typeof membership.permissions, "bigint")
    if (membership.approximateMemberCount !== undefined)
        assert.ok(Number.isSafeInteger(membership.approximateMemberCount))
    if (membership.approximatePresenceCount !== undefined)
        assert.ok(Number.isSafeInteger(membership.approximatePresenceCount))
    report(stage, true)
    stage = "workflow_hierarchy_self_readonly"
    assert.equal(await ops.hierarchy({ guildId, userId: botId }), true)
    report(stage, true)
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

function verifyReceivedMetadata(snapshot, wire) {
    const requireObserved = (wireKey, snapshotKey, project = (value) => value) => {
        assert.ok(Object.hasOwn(wire, wireKey), `Readback omitted required ${wireKey}`)
        assert.ok(snapshotKey in snapshot, `SDK snapshot omitted required ${snapshotKey}`)
        assert.deepEqual(snapshot[snapshotKey], project(wire[wireKey]))
    }
    const compareIfObserved = (wireKey, snapshotKey, project = (value) => value) => {
        // The SDK snapshot may come from a send or gateway response while this direct GET is a later,
        // context-dependent observation. Optional fields such as guild_id can therefore be omitted by one source.
        if (Object.hasOwn(wire, wireKey) && snapshotKey in snapshot)
            assert.deepEqual(snapshot[snapshotKey], project(wire[wireKey]))
    }
    const projectReference = (value) =>
        value === null
            ? null
            : {
                  id: value.message_id,
                  channelId: value.channel_id,
                  ...(Object.hasOwn(value, "guild_id") ? { guildId: value.guild_id } : {}),
                  ...(Object.hasOwn(value, "type") ? { type: value.type } : {}),
              }
    const projectReaction = (reaction) => ({
        emoji: {
            name: reaction.emoji.name,
            ...(Object.hasOwn(reaction.emoji, "id") ? { id: reaction.emoji.id } : {}),
            ...(Object.hasOwn(reaction.emoji, "animated") ? { animated: reaction.emoji.animated } : {}),
        },
        count: reaction.count,
        ...(Object.hasOwn(reaction, "me") ? { me: reaction.me } : {}),
    })
    requireObserved("timestamp", "createdAt")
    requireObserved("type", "type")
    requireObserved("flags", "flags")
    requireObserved("mention_everyone", "mentionedEveryone")
    requireObserved("mentions", "mentions", (mentions) =>
        mentions.map((mention) => ({ id: mention.id, username: mention.username, isBot: mention.bot === true })),
    )
    requireObserved("mention_roles", "mentionRoleIds")
    compareIfObserved("edited_timestamp", "editedAt")
    compareIfObserved("guild_id", "guildId")
    compareIfObserved("mention_channels", "mentionChannels", (channels) =>
        channels === null
            ? null
            : channels.map((channel) => ({ id: channel.id, name: channel.name, type: channel.type })),
    )
    compareIfObserved("reactions", "reactions", (reactions) =>
        reactions === null ? null : reactions.map(projectReaction),
    )
    compareIfObserved("message_reference", "messageReference", projectReference)
    compareIfObserved("referenced_message", "referencedMessage", (reference) =>
        reference === null ? null : { id: reference.id, channelId: reference.channel_id },
    )
    assert.ok(Object.isFrozen(snapshot))
    for (const nested of [
        snapshot.mentions,
        snapshot.mentions?.[0],
        snapshot.mentionRoleIds,
        snapshot.mentionChannels,
        snapshot.mentionChannels?.[0],
        snapshot.reactions,
        snapshot.reactions?.[0],
        snapshot.reactions?.[0]?.emoji,
        snapshot.messageReference,
        snapshot.referencedMessage,
    ])
        if (nested !== undefined && nested !== null) assert.ok(Object.isFrozen(nested))
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

/** Search only the journaled test channel. Each later attempt is explicit application retry after an indexing page, never SDK polling */
async function verifyMessageSearch(ops, channelId) {
    stage = "message_search_seed"
    const content = `search-${randomUUID()}`
    const created = await api("POST", `/channels/${channelId}/messages`, {
        content,
        allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
    })
    assert.equal(created.status, 200)
    assert.match(created.data?.id ?? "", /^\d+$/)
    assert.equal(created.data?.channel_id, channelId)
    const target = { id: created.data.id, channelId }
    // The raw test-owned seed was created while disconnected, so only an indexed hit could incorrectly hydrate it
    assert.equal(await ops.get(target), undefined)

    const attempts = 12
    let sawIndexing = false
    for (let attempt = 1; attempt <= attempts; attempt++) {
        stage = "message_search_page"
        const requests = ops.searchRequests()
        const page = await ops.search({ channelId }, { content })
        if (page.indexing) {
            sawIndexing = true
            // Returning this union before our next explicit call establishes no hidden indexing poll
            assert.equal(ops.searchRequests(), requests + 1)
            report("message_search_indexing_visible", true)
            if (attempt < attempts) await sleep(1_000)
            continue
        }
        const found = page.messages.some((message) => message.id === target.id && message.channelId === channelId)
        if (!found) {
            if (attempt < attempts) {
                await sleep(1_000)
                continue
            }
            stage = "message_search_owned_hit_timeout"
            assert.fail("Hosted search returned ready pages without the journaled test message")
        }
        stage = "message_search_cache_exclusion"
        assert.equal(await ops.get(target), undefined)
        stage = "message_search_traversal"
        const seen = []
        for await (const message of ops.iterate({ channelId }, { content }, { maxItems: 25, maxPages: 2 })) {
            assert.ok(seen.length < 25)
            seen.push(message)
        }
        assert.ok(seen.some((message) => message.id === target.id && message.channelId === channelId))
        assert.equal(await ops.get(target), undefined)
        report("message_search_page_and_traversal", true)
        return
    }
    stage = sawIndexing ? "message_search_indexing_timeout" : "message_search_owned_hit_timeout"
    assert.fail("Hosted search did not return the journaled test message within the bounded caller retry budget")
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

async function verifyPagination(ops, channelId, botId) {
    const seeded = await prepareHistory(channelId, botId)
    const expected = seeded.cases[0].ids
    const gather = async (iterable) => {
        const items = []
        for await (const item of iterable) items.push(item)
        return items
    }
    const previousFetch = globalThis.fetch
    let requests = 0
    let responseMode = "normal"
    let started, release
    let held
    globalThis.fetch = async (...args) => {
        const url = new URL(args[0])
        if (url.origin !== "https://api.fluxer.app" || url.pathname !== `/v1/channels/${channelId}/messages`)
            return previousFetch(...args)
        requests++
        if (responseMode === "retry") {
            responseMode = "normal"
            return new Response(null, { status: 503 })
        }
        const response = await previousFetch(...args)
        if (responseMode !== "hold") return response
        responseMode = "normal"
        // Consume the actual owned-channel response before simulating delayed delivery and awaited cancellation
        await response.arrayBuffer()
        started()
        await new Promise((resolve) => {
            if (args[1].signal.aborted) resolve()
            else args[1].signal.addEventListener("abort", resolve, { once: true })
        })
        await held
        throw new DOMException("Test-owned response cancellation", "AbortError")
    }
    try {
        stage = "pagination_history_readback"
        const all = await gather(ops.history({ maxItems: 10, pageSize: 2 }))
        assert.deepEqual(
            all.map((item) => item.id),
            expected,
        )
        assert.equal(requests, 4)
        await seeded.verify(Object.freeze(all), seeded.cases[0])
        report(stage, true)
        stage = "pagination_early_exit_and_page_limit"
        requests = 0
        for await (const _item of ops.history({ maxItems: 10, pageSize: 2 })) break
        assert.equal(requests, 1)
        requests = 0
        await assert.rejects(gather(ops.history({ maxItems: 10, pageSize: 2, maxPages: 1 })), {
            _tag: "PaginationError",
            reason: "pageLimit",
        })
        assert.equal(requests, 1)
        report(stage, true)
        stage = "pagination_transient_read_recovery"
        responseMode = "retry"
        requests = 0
        assert.equal((await gather(ops.history({ maxItems: 1 })))[0].id, expected[0])
        assert.equal(requests, 2)
        report(stage, true)
        stage = "pagination_cancellation_cleanup_and_reuse"
        responseMode = "hold"
        const ready = new Promise((resolve) => {
            started = resolve
        })
        held = new Promise((resolve) => {
            release = resolve
        })
        const controller = new AbortController()
        let settled = false
        const waiting = ops.cancelHistory(controller.signal).finally(() => {
            settled = true
        })
        await ready
        controller.abort()
        try {
            await sleep(25)
            assert.equal(settled, false)
        } finally {
            release()
        }
        await waiting
        assert.equal((await gather(ops.history({ maxItems: 1 })))[0].id, expected[0])
        report(stage, true)
    } finally {
        release?.()
        globalThis.fetch = previousFetch
    }
    stage = "pagination_members_readback"
    const members = await gather(ops.members({ maxItems: 2, pageSize: 1 }))
    const rawMembers = await api("GET", `/guilds/${guildId}/members?limit=2`)
    assert.equal(rawMembers.status, 200)
    assert.deepEqual(
        members.map((item) => item.userId),
        rawMembers.data.map((item) => item.user.id),
    )
    report(stage, true)
    stage = "pagination_selected_reactor_readback"
    const message = { channelId, id: expected.at(-1) }
    await ops.react(message)
    const reactors = await gather(ops.users(message, "👍", { maxItems: 10, pageSize: 1 }))
    const rawUsers = await api(
        "GET",
        `/channels/${channelId}/messages/${message.id}/reactions/${encodeURIComponent("👍")}/users?limit=100`,
    )
    assert.equal(rawUsers.status, 200)
    assert.deepEqual(
        reactors.map((item) => item.id),
        rawUsers.data.items.map((item) => item.id),
    )
    assert.deepEqual(
        reactors.map((item) => item.id),
        [botId],
    )
    report(stage, true)
    stage = "pagination_pin_pages_readback"
    await ops.pin(message)
    await sleep(10)
    const other = { channelId, id: expected[0] }
    await ops.pin(other)
    const rawPins = await api("GET", `/channels/${channelId}/messages/pins?limit=50`)
    assert.equal(rawPins.status, 200)
    const pinItems = await gather(ops.pins({ maxItems: 10, pageSize: 1 }))
    assert.deepEqual(
        pinItems.map((item) => item.message.id),
        rawPins.data.items.map((item) => item.message.id),
    )
    assert.equal(pinItems.length, 2)
    await ops.unpin(message)
    await ops.unpin(other)
    assert.equal((await api("GET", `/channels/${channelId}/messages/pins?limit=50`)).data.items.length, 0)
    report(stage, true)
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

async function verifyNonce(ops, channelId) {
    const marker = randomUUID().replaceAll("-", "").slice(0, 8)
    const selected = `${marker}-s`
    stage = "nonce_selected_send"
    const first = await ops.send({ content: `${marker}-first`, nonce: selected })
    assert.equal(first.nonce, selected)
    const duplicate = await ops.send({ content: `${marker}-first`, nonce: selected })
    assert.equal(duplicate.id, first.id)
    assert.equal(duplicate.nonce, selected)
    const selectedReadback = await api("GET", `/channels/${channelId}/messages/${first.id}`)
    assert.equal(selectedReadback.status, 200)
    assert.equal(selectedReadback.data?.id, first.id)
    assert.equal(selectedReadback.data?.content, `${marker}-first`)
    report(stage, true)

    stage = "nonce_omitted_defaults"
    const generatedA = await ops.send({ content: `${marker}-generated-a` })
    const generatedB = await ops.send({ content: `${marker}-generated-b` })
    assert.match(generatedA.nonce ?? "", /^.{1,32}$/)
    assert.match(generatedB.nonce ?? "", /^.{1,32}$/)
    assert.notEqual(generatedA.nonce, generatedB.nonce)
    assert.notEqual(generatedA.id, generatedB.id)
    report(stage, true)

    stage = "nonce_reply_and_forward"
    const reply = await ops.reply(first, { content: `${marker}-reply`, nonce: `${marker}-r` })
    const forward = await ops.forward(channelId, {
        source: first,
        nonce: `${marker}-f`,
    })
    assert.equal(reply.nonce, `${marker}-r`)
    assert.equal(forward.nonce, `${marker}-f`)
    for (const sent of [reply, forward]) {
        const readback = await api("GET", `/channels/${channelId}/messages/${sent.id}`)
        assert.equal(readback.status, 200)
        assert.equal(readback.data?.id, sent.id)
    }
    report(stage, true)

    stage = "nonce_lost_response_no_replay"
    const lostNonce = `${marker}-u`
    const lostContent = `${marker}-unknown`
    const originalFetch = globalThis.fetch
    let submits = 0
    globalThis.fetch = async (...args) => {
        const request = args[1]
        const url = new URL(String(args[0]))
        if (url.pathname === `/v1/channels/${channelId}/messages` && request?.method === "POST") {
            const payload = JSON.parse(String(request.body))
            if (payload.nonce === lostNonce) {
                submits++
                const response = await originalFetch(...args)
                assert.ok(response.ok)
                await response.body?.cancel()
                throw new TypeError("nonce fixture lost response")
            }
        }
        return originalFetch(...args)
    }
    try {
        const failure = await ops.sendUnknown({ content: lostContent, nonce: lostNonce })
        assert.equal(failure?._tag, "MessageError")
        assert.equal(failure?.delivery, "unknown")
    } finally {
        globalThis.fetch = originalFetch
    }
    assert.equal(submits, 1)
    const history = await api("GET", `/channels/${channelId}/messages?limit=100`)
    assert.equal(history.status, 200)
    assert.ok(Array.isArray(history.data))
    assert.equal(history.data.filter((message) => message.content === lostContent).length, 1)
    report(stage, true)
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
            await collector.close?.()
        }
    }

    async function collectProgress(label, count = 1) {
        const progressMarker = `collector-progress-${randomUUID()}`
        const acknowledgement = `collector acknowledgement ${randomUUID()}`
        const sent = []
        const started = []
        const replies = []
        const cleaned = []
        const releaseFirst = Promise.withResolvers()
        let firstMessage
        let active
        stage = `collector_progress_${label}`
        const collector = await open({
            filter: (message) => message.author.id === botId && message.content.startsWith(progressMarker),
            maxMessages: count,
            timeoutMs: 30_000,
            progressReply: acknowledgement,
            progressGate: (message) => {
                firstMessage ??= message.id
                return message.id === firstMessage ? releaseFirst.promise : Promise.resolve()
            },
            onProgress: (event, message, reply) => {
                if (event === "started") {
                    assert.equal(active, undefined, "Collector message handlers must not overlap")
                    active = message.id
                    started.push(message.id)
                } else if (event === "reply") {
                    assert.equal(active, message.id)
                    replies.push({ message, reply })
                } else if (event === "cleaned") {
                    assert.equal(active, message.id)
                    active = undefined
                    cleaned.push(message.id)
                }
            },
        })
        try {
            sent.push(await send(channelId, { content: `${progressMarker}-0` }))
            await waitForProgressStart(started)
            // Keep the first callback active until every planned source message has been created
            for (let index = 1; index < count; index++)
                sent.push(await send(channelId, { content: `${progressMarker}-${index}` }))
            releaseFirst.resolve()
            const result = await collector.wait()
            assert.equal(result.error, undefined)
            assert.equal(result.value.reason, "limit")
            assert.deepEqual(
                result.value.messages.map((message) => message.id),
                sent.map((message) => message.id),
            )
            assert.deepEqual(
                started,
                sent.map((message) => message.id),
            )
            assert.deepEqual(
                cleaned,
                sent.map((message) => message.id),
            )
            assert.equal(active, undefined)
            assert.equal(replies.length, sent.length)
            for (const [index, { message, reply }] of replies.entries()) {
                assert.equal(message.id, sent[index].id)
                const actual = await api("GET", `/channels/${channelId}/messages/${reply.id}`)
                assert.equal(actual.status, 200)
                assert.equal(actual.data?.channel_id, channelId)
                assert.equal(actual.data?.content, `${acknowledgement}-${message.id}`)
                assert.equal(actual.data?.message_reference?.message_id, message.id)
                assert.equal(actual.data?.mention_everyone, false)
                assert.deepEqual(actual.data?.mentions, [])
            }
            report(stage, true)
        } finally {
            releaseFirst.resolve()
            await collector.stop()
            await collector.close?.()
        }
    }

    async function waitForProgressStart(started) {
        const deadline = performance.now() + 10_000
        while (started.length === 0 && performance.now() < deadline) await sleep(20)
        assert.equal(started.length, 1, "Collector progress handler deadline")
    }

    async function cancelProgress() {
        const progressMarker = `collector-cancel-${randomUUID()}`
        const started = []
        const cleanupStarted = []
        const cleaned = []
        const releaseCleanup = Promise.withResolvers()
        let active
        const collector = await open({
            filter: (message) => message.author.id === botId && message.content.startsWith(progressMarker),
            maxMessages: 1,
            timeoutMs: 30_000,
            progressWait: true,
            progressCancel: true,
            progressCleanup: async () => {
                await releaseCleanup.promise
            },
            onProgress: (event, message) => {
                if (event === "started") {
                    assert.equal(active, undefined)
                    active = message.id
                    started.push(message.id)
                } else if (event === "cleanupStarted") {
                    assert.equal(active, message.id)
                    cleanupStarted.push(message.id)
                } else if (event === "cleaned") {
                    assert.equal(active, message.id)
                    active = undefined
                    cleaned.push(message.id)
                }
            },
        })
        try {
            const sent = await send(channelId, { content: `${progressMarker}-source` })
            await waitForProgressStart(started)
            stage = "collector_progress_cancellation"
            assert.equal(typeof collector.cancel, "function")
            const outcome = collector.wait()
            let outcomeSettled = false
            void outcome.then(() => {
                outcomeSettled = true
            })
            const cancellation = Promise.resolve(collector.cancel())
            let cancellationSettled = false
            void cancellation.then(() => {
                cancellationSettled = true
            })
            await waitForProgressStart(cleanupStarted)
            await Promise.resolve()
            assert.equal(outcomeSettled, false)
            if (collector.cancelKind === "scope") assert.equal(cancellationSettled, false)
            releaseCleanup.resolve()
            await cancellation
            const result = await outcome
            if (collector.cancelKind === "signal") {
                assert.equal(result.value, undefined)
                assert.equal(result.error?._tag, "CancelledError")
            } else {
                assert.equal(result.error, undefined)
                assert.equal(result.value.reason, "stopped")
            }
            assert.deepEqual(started, [sent.id])
            assert.deepEqual(cleanupStarted, [sent.id])
            assert.deepEqual(cleaned, [sent.id])
            assert.equal(active, undefined)
            report(stage, true)
        } finally {
            releaseCleanup.resolve()
            await collector.stop()
            await collector.close?.()
        }
    }

    async function recoverProgress() {
        const progressMarker = `collector-recovery-${randomUUID()}`
        const started = []
        const cleaned = []
        let active
        const gap = await open({
            filter: (message) => message.author.id === botId && message.content.startsWith(progressMarker),
            maxMessages: 1,
            timeoutMs: 30_000,
            progressWait: true,
            onProgress: (event, message) => {
                if (event === "started") {
                    assert.equal(active, undefined)
                    active = message.id
                    started.push(message.id)
                } else if (event === "cleaned") {
                    assert.equal(active, message.id)
                    active = undefined
                    cleaned.push(message.id)
                }
            },
        })
        try {
            const result = gap.wait()
            const sent = await send(channelId, { content: `${progressMarker}-source` })
            await waitForProgressStart(started)
            await interrupt()
            stage = "collector_connection_gap"
            const outcome = await result
            assert.equal(outcome.value, undefined)
            assert.equal(outcome.error?._tag, "CollectorError")
            assert.equal(outcome.error?.reason, "connectionLost")
            assert.equal("messages" in outcome.error, false)
            assert.deepEqual(started, [sent.id])
            assert.deepEqual(cleaned, [sent.id])
            assert.equal(active, undefined)
            report(stage, true)
        } finally {
            await gap.stop()
            await gap.close?.()
        }
    }

    await collectAndSend(2, 2, 30_000, "limit")
    await collectAndSend(5, 1, 5_000, "timeout")
    await collectProgress("replies_readback", 2)
    await cancelProgress()
    await collectProgress("after_cancellation")
    await recoverProgress()
    await collectProgress("after_resume")
    report("collector_after_resume", true)
}

// Failure containment only: A forced exit is never reported as successful cleanup
setTimeout(
    () => {
        report("process_timeout", false)
        process.exit(1)
    },
    attachments || attachmentSources || moderation || search ? 240_000 : typing ? 60_000 : 120_000,
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
                    pagination ||
                    cache ||
                    collectors ||
                    embeds ||
                    attachments ||
                    attachmentSources ||
                    reactions ||
                    pins ||
                    guilds ||
                    channels ||
                    batchDelete ||
                    cleanupCheck ||
                    moderation ||
                    search ||
                    optionalTools ||
                    nonceOnly ||
                    typing)),
    )
    stage = "sandbox_lock"
    lock = openSync(lockPath, "wx")
    writeSync(lock, String(process.pid))
    stage = "configuration"
    const env = parseEnv(readFileSync(new URL("../../.env.test.local", import.meta.url), "utf8"))
    moderationUserId ??= env.FLUXER_TEST_MODERATION_USER_ID
    if (moderation) assert.match(moderationUserId ?? "", /^[1-9][0-9]*$/)
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
    let typingCacheTarget
    if (typing) {
        stage = "typing_cache_seed"
        const seeded = (await api("POST", `/channels/${channel.id}/messages`, { content: `typing-${randomUUID()}` }))
            .data
        assert.match(seeded?.id ?? "", /^\d+$/)
        typingCacheTarget = { id: seeded.id, channelId: channel.id }
    }
    const ping = `ping-${randomUUID()}`
    const pong = `pong-${randomUUID()}`
    const sdkRequests = []
    const typingRequests = []
    if (cache || search || typing) {
        // Sandbox setup and independent readback keep using rawFetch. This observes only the SDK's own REST behavior
        globalThis.fetch = async (...args) => {
            const url = new URL(args[0])
            if (cache || search) sdkRequests.push(url.pathname)
            const response = await rawFetch(...args)
            if (typing && url.pathname === `/v1/channels/${channel.id}/typing`)
                typingRequests.push({
                    at: performance.now(),
                    body: args[1]?.body,
                    method: args[1]?.method,
                    status: response.status,
                })
            return response
        }
    }
    if (attachments || attachmentSources)
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
        const { builders, commands, createClient } = await import("@neontechspace/fluxerly")
        const created = createClient({
            token,
            ...(cache || typing || embeds || attachments || batchDelete || search ? { cache: cacheOptions() } : {}),
            ...(guilds ? { cache: { guilds: true, members: true, roles: true } } : {}),
            ...(channels ? { cache: { channels: true } } : {}),
            ...(moderation ? { cache: { members: true } } : {}),
            ...(recover ? { logging: { development: true, logger: fromEffectLogger(diagnosticLogger) } } : {}),
        })
        assert.ok(created.isOk())
        client = created.value
        const cacheGet = async (target) => {
            if (!cache && !typing && !search) return undefined
            const cached = client.messages.get(target)
            assert.ok(cached.isOk())
            return cached.value
        }
        const cacheSend = async (channelId, input) => {
            const sent = await client.messages.send(channelId, input)
            assert.ok(sent.isOk())
            return sent.value
        }
        const cacheReply = async (target, input) => {
            const sent = await client.messages.reply(target, input)
            assert.ok(sent.isOk())
            return sent.value
        }
        if (nonceOnly)
            await verifyNonce(
                {
                    send: async (input) => cacheSend(channel.id, input),
                    reply: async (target, input) => {
                        const sent = await client.messages.reply(target, input)
                        assert.ok(sent.isOk())
                        return sent.value
                    },
                    forward: async (destination, input) => {
                        const sent = await client.messages.forward(destination, input)
                        assert.ok(sent.isOk())
                        return sent.value
                    },
                    sendUnknown: async (input) => {
                        const result = await client.messages.send(channel.id, input)
                        assert.ok(result.isErr())
                        return result.error
                    },
                },
                channel.id,
            )
        const done = Promise.withResolvers()
        const stopState = forceRecovery
            ? client.observeState((state) => {
                  states.push(state)
              })
            : undefined
        let timer
        try {
            if (typing) {
                stage = "typing_one_shot"
                const oneShot = await client.messages.typing(channel.id)
                assert.ok(oneShot.isOk())
                assert.deepEqual(typingRequests, [
                    { at: typingRequests[0]?.at, body: undefined, method: "POST", status: 204 },
                ])
                // This message was created before the SDK client existed. A typing request cannot hydrate or admit it.
                assert.equal(await cacheGet(typingCacheTarget), undefined)
                report("typing_one_shot_no_cache_admission", true)

                stage = "typing_scoped_refresh"
                const scopedStart = typingRequests.length
                const complete = Promise.withResolvers()
                const scoped = client.messages.keepTyping(channel.id, () => complete.promise)
                let completed
                try {
                    await waitForTypingRequests(typingRequests, scopedStart + 2)
                } finally {
                    complete.resolve("completed")
                    completed = await scoped
                }
                assert.ok(completed.isOk())
                assert.equal(completed.value, "completed")
                const refreshes = typingRequests.slice(scopedStart)
                assert.equal(refreshes.length, 2)
                assert.ok(
                    refreshes.every(
                        (request) => request.method === "POST" && request.body === undefined && request.status === 204,
                    ),
                )
                assert.ok(refreshes[1].at - refreshes[0].at >= 7_900)
                report(stage, true)

                stage = "typing_completion_cleanup"
                await assertTypingStopped(typingRequests)
                report(stage, true)

                stage = "typing_cancellation_cleanup"
                const cancellation = new AbortController()
                const entered = Promise.withResolvers()
                const pending = client.messages.keepTyping(
                    channel.id,
                    (signal) =>
                        new Promise((resolve) => {
                            entered.resolve()
                            if (signal.aborted) resolve()
                            else signal.addEventListener("abort", resolve, { once: true })
                        }),
                    { signal: cancellation.signal },
                )
                await entered.promise
                cancellation.abort()
                const cancelled = await pending
                assert.ok(cancelled.isErr())
                assert.equal(cancelled.error._tag, "CancelledError")
                await assertTypingStopped(typingRequests)
                report(stage, true)
                stage = "sdk_receive_and_reply"
            }
            if (search) {
                await verifyMessageSearch(
                    {
                        search: async (context, query) => {
                            const result = await client.messages.search(context, query)
                            if (result.isErr()) throw result.error
                            return result.value
                        },
                        iterate: async function* (context, filters, limits) {
                            for await (const result of client.messages.iterateSearch(context, filters, limits)) {
                                if (result.isErr()) throw result.error
                                yield result.value
                            }
                        },
                        get: cacheGet,
                        searchRequests: () => sdkRequests.filter((path) => path === "/v1/search/messages").length,
                    },
                    channel.id,
                )
                stage = "sdk_receive_and_reply"
            }
            if (pagination) {
                const value = async (operation) => {
                    const result = await operation
                    if (result.isErr()) throw result.error
                    return result.value
                }
                const items = async function* (iterable) {
                    for await (const result of iterable) {
                        if (result.isErr()) throw result.error
                        yield result.value
                    }
                }
                await verifyPagination(
                    {
                        history: (query) => items(client.messages.iterateHistory(channel.id, query)),
                        members: (query) => items(client.members.iterate(guildId, query)),
                        users: (target, emoji, query) =>
                            items(client.messages.iterateReactionUsers(target, emoji, query)),
                        pins: (query) => items(client.messages.iteratePins(channel.id, query)),
                        react: (target) => value(client.messages.addReaction(target, "👍")),
                        pin: (target) => value(client.messages.pin(target)),
                        unpin: (target) => value(client.messages.unpin(target)),
                        cancelHistory: async (signal) => {
                            for await (const result of client.messages.iterateHistory(
                                channel.id,
                                { maxItems: 1 },
                                { signal },
                            )) {
                                assert.ok(result.isErr())
                                assert.equal(result.error._tag, "CancelledError")
                                return
                            }
                            assert.fail("Cancelled traversal unexpectedly completed")
                        },
                    },
                    channel.id,
                    user.id,
                )
            }
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
                await verifyCacheRestAdmissionAndExpiry(cacheSend, cacheReply, cacheGet, channel.id)
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
            if (moderation) {
                const run = async (operation) => {
                    const result = await operation
                    if (result.isErr()) throw result.error
                    return result.value
                }
                await verifyModeration(
                    {
                        timeout: (target, duration, options) => run(client.members.timeout(target, duration, options)),
                        clearTimeout: (target) => run(client.members.clearTimeout(target)),
                        fetch: (target) => run(client.members.fetch(target)),
                        get: (target) => run(client.members.get(target)),
                        kick: (target, options) => run(client.members.kick(target, options)),
                        ban: (target, input, options) => run(client.guilds.ban(target, input, options)),
                        unban: (target, options) => run(client.guilds.unban(target, options)),
                        bans: () => run(client.guilds.fetchBans(guildId)),
                        on: async (event, handler) => {
                            const subscription = await run(client.on(event, handler))
                            return async () => {
                                subscription.unsubscribe()
                                await run(subscription.waitForClose())
                            }
                        },
                    },
                    user.id,
                )
            }
            if (batchDelete) {
                const run = async (operation) => {
                    const result = await operation
                    if (result.isErr()) throw result.error
                    return result.value
                }
                await verifyBatchDeletion(
                    {
                        send: (input) => run(client.messages.send(channel.id, input)),
                        get: (target) => run(client.messages.get(target)),
                        deleteMany: (ids) => run(client.messages.deleteMany(channel.id, ids)),
                        on: async (handler) => {
                            const subscription = await run(client.on("messageDeleteBulk", handler))
                            return async () => {
                                subscription.unsubscribe()
                                await run(subscription.waitForClose())
                            }
                        },
                    },
                    channel.id,
                    user.id,
                )
            }
            if (cleanupCheck) {
                const run = async (operation) => {
                    const result = await operation
                    if (result.isErr()) throw result.error
                    return result.value
                }
                await verifyWorkflowReads(
                    {
                        guildList: () => run(client.guilds.fetchPage({ withCounts: true })),
                        hierarchy: (target) => run(client.members.fetchHierarchyCheck(target)),
                    },
                    user.id,
                )
                await verifyCleanup(
                    {
                        send: (input) => run(client.messages.send(channel.id, input)),
                        preview: (selection) => run(client.messages.previewCleanup(channel.id, selection)),
                        cleanup: (plan, options) => run(client.messages.cleanup(plan, options)),
                    },
                    channel.id,
                    user.id,
                )
            }
            if (optionalTools) {
                const run = async (operation) => {
                    const result = await operation
                    if (result.isErr()) throw result.error
                    return result.value
                }
                await verifyOptionalTools(
                    {
                        builders,
                        parseQuoted: commands.parseQuoted,
                        assertConnected: async () => assert.equal(client.state, "Connected"),
                        create: (options) => run(Promise.resolve(commands.create(options))),
                        register: (router, command) => run(Promise.resolve(router.register(command))),
                        attach: (router) => run(Promise.resolve(router.attach(client))),
                        send: (input) => run(client.messages.send(channel.id, input)),
                        reply: (message, input) => run(client.messages.reply(message, input)),
                        cooldowns: async (claims) => {
                            const store = await run(Promise.resolve(commands.memoryCooldowns({ maxEntries: 4 })))
                            return {
                                store: {
                                    claim(input) {
                                        const claim = store.claim(input)
                                        if (claim.isOk()) claims.push(claim.value)
                                        return claim
                                    },
                                },
                                clear: () => store.clear(),
                            }
                        },
                        guard: (matches) => {
                            return ({ message }) => matches(message)
                        },
                        execute: (runCommand) => {
                            return async ({ message }) => runCommand(message)
                        },
                        reject:
                            (onReject) =>
                            ({ message }, rejection) =>
                                onReject(message, rejection),
                        close: async (subscription) => {
                            subscription.unsubscribe()
                            await run(subscription.waitForClose())
                        },
                        observe: async (receive) => {
                            const observer = await run(client.on("messageCreate", receive))
                            return {
                                close: async () => {
                                    observer.unsubscribe()
                                    await run(observer.waitForClose())
                                },
                            }
                        },
                    },
                    channel.id,
                    user.id,
                )
            }
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
                        setHoistPositions: (positions) => run(client.roles.setHoistPositions(guildId, positions)),
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
            if (channels) {
                const run = async (operation) => {
                    const result = await operation
                    if (result.isErr()) throw result.error
                    return result.value
                }
                await verifyChannels(
                    {
                        get: (id) => run(client.channels.get(id)),
                        fetch: (id) => run(client.channels.fetch(id)),
                        fetchAll: (id) => run(client.channels.fetchAll(id)),
                        create: (id, input) => run(client.channels.create(id, input)),
                        edit: (id, input) => run(client.channels.edit(id, input)),
                        delete: (id) => run(client.channels.delete(id)),
                        reorder: (id, positions) => run(client.channels.reorder(id, positions)),
                        setPermissionOverwrite: (id, overwrite) =>
                            run(client.channels.setPermissionOverwrite(id, overwrite)),
                        removePermissionOverwrite: (id, targetId) =>
                            run(client.channels.removePermissionOverwrite(id, targetId)),
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
            if (embeds || attachments || attachmentSources) {
                const unwrap = async (operation) => {
                    const result = await operation
                    if (result.isErr()) reportFailure(result.error)
                    assert.ok(result.isOk())
                    return result.value
                }
                const attachmentOps = {
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
                    download: (attachment, options) => unwrap(client.attachments.download(attachment, options)),
                    downloadFailure: async (attachment, options) => {
                        const result = await client.attachments.download(attachment, options)
                        assert.ok(result.isErr())
                        return result.error
                    },
                    stream: async function* (attachment, options) {
                        for await (const result of client.attachments.stream(attachment, options)) {
                            assert.ok(result.isOk())
                            yield result.value
                        }
                    },
                    cancelDownload: async (attachment, size, signal) => {
                        const result = await client.attachments.download(attachment, {
                            maxBytes: size,
                            timeoutMs: 60_000,
                            signal,
                        })
                        assert.ok(result.isErr())
                        assert.equal(result.error._tag, "CancelledError")
                    },
                }
                if (attachmentSources)
                    await verifyAttachmentSources({
                        ops: attachmentOps,
                        channelId: channel.id,
                        rawFetch,
                        getFetch: () => globalThis.fetch,
                        setFetch: (value) => (globalThis.fetch = value),
                        setStage: (value) => (stage = value),
                        report,
                    })
                else await (attachments ? verifyAttachments : verifyEmbeds)(attachmentOps, channel.id)
            }
            if (forceRecovery && !reactions && !pins && !guilds && !channels) {
                if (cache) sdkRequests.length = 0
                if (collectors)
                    await verifyCollectors(
                        async (options) => {
                            const {
                                progressReply,
                                progressWait,
                                progressCancel,
                                progressGate,
                                progressCleanup,
                                onProgress,
                                ...settings
                            } = options
                            const cancellation = progressCancel ? new AbortController() : undefined
                            const opened = client.messages.collect(channel.id, {
                                ...settings,
                                ...(cancellation ? { signal: cancellation.signal } : {}),
                                ...(progressReply || progressWait
                                    ? {
                                          onMessage: async (message, signal) => {
                                              onProgress?.("started", message)
                                              try {
                                                  if (progressGate) await progressGate(message, signal)
                                                  if (progressWait)
                                                      await new Promise((resolve) => {
                                                          if (signal.aborted) resolve()
                                                          else signal.addEventListener("abort", resolve, { once: true })
                                                      })
                                                  else {
                                                      const reply = await client.messages.reply(
                                                          message,
                                                          { content: `${progressReply}-${message.id}` },
                                                          { signal },
                                                      )
                                                      if (reply.isErr()) throw reply.error
                                                      onProgress?.("reply", message, reply.value)
                                                  }
                                              } finally {
                                                  if (progressCleanup) {
                                                      onProgress?.("cleanupStarted", message)
                                                      await progressCleanup(message)
                                                  }
                                                  onProgress?.("cleaned", message)
                                              }
                                          },
                                      }
                                    : {}),
                            })
                            assert.ok(opened.isOk())
                            return {
                                wait: () => opened.value.waitForClose(),
                                stop: () => opened.value.stop(),
                                ...(cancellation ? { cancel: () => cancellation.abort(), cancelKind: "signal" } : {}),
                            }
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
                await verifyCacheGatewayRebuild(cacheGet, channel.id)
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
        const { Deferred, Effect, Exit, Fiber, Scope, Stream } = await import("effect")
        const { builders, commands, createClient } = await import("@neontechspace/fluxerly/effect")
        const exit = await Effect.runPromiseExit(
            Effect.scoped(
                Effect.gen(function* () {
                    client = yield* createClient({
                        token,
                        ...(cache || typing || embeds || attachments || batchDelete || search
                            ? { cache: cacheOptions() }
                            : {}),
                        ...(guilds ? { cache: { guilds: true, members: true, roles: true } } : {}),
                        ...(channels ? { cache: { channels: true } } : {}),
                        ...(moderation ? { cache: { members: true } } : {}),
                        ...(recover ? { logging: { development: true } } : {}),
                    })
                    const cacheGet = async (target) => {
                        if (!cache && !search) return undefined
                        const cached = await Effect.runPromiseExit(client.messages.get(target))
                        assert.ok(Exit.isSuccess(cached))
                        return cached.value
                    }
                    const cacheSend = (channelId, input) => Effect.runPromise(client.messages.send(channelId, input))
                    const cacheReply = (target, input) => Effect.runPromise(client.messages.reply(target, input))
                    if (nonceOnly)
                        yield* Effect.promise(() =>
                            verifyNonce(
                                {
                                    send: (input) => cacheSend(channel.id, input),
                                    reply: (target, input) => Effect.runPromise(client.messages.reply(target, input)),
                                    forward: (destination, input) =>
                                        Effect.runPromise(client.messages.forward(destination, input)),
                                    sendUnknown: (input) =>
                                        Effect.runPromise(client.messages.send(channel.id, input).pipe(Effect.flip)),
                                },
                                channel.id,
                            ),
                        )
                    if (search) {
                        yield* Effect.promise(() =>
                            verifyMessageSearch(
                                {
                                    search: (context, query) =>
                                        Effect.runPromise(client.messages.search(context, query)),
                                    iterate: (context, filters, limits) =>
                                        Stream.toAsyncIterable(client.messages.iterateSearch(context, filters, limits)),
                                    get: cacheGet,
                                    searchRequests: () =>
                                        sdkRequests.filter((path) => path === "/v1/search/messages").length,
                                },
                                channel.id,
                            ),
                        )
                        stage = "sdk_receive_and_reply"
                    }
                    if (typing) {
                        stage = "typing_one_shot"
                        yield* client.messages.typing(channel.id)
                        assert.deepEqual(typingRequests, [
                            { at: typingRequests[0]?.at, body: undefined, method: "POST", status: 204 },
                        ])
                        // This message was created before the SDK client existed. A typing request cannot hydrate or admit it.
                        assert.equal(yield* client.messages.get(typingCacheTarget), undefined)
                        report("typing_one_shot_no_cache_admission", true)

                        stage = "typing_scoped_refresh"
                        const scopedStart = typingRequests.length
                        const complete = Deferred.makeUnsafe()
                        const scoped = yield* Effect.forkChild(
                            client.messages.keepTyping(channel.id, Deferred.await(complete)),
                        )
                        yield* Effect.promise(() => waitForTypingRequests(typingRequests, scopedStart + 2))
                        Deferred.doneUnsafe(complete, Effect.succeed("completed"))
                        assert.equal(yield* Fiber.join(scoped), "completed")
                        const refreshes = typingRequests.slice(scopedStart)
                        assert.equal(refreshes.length, 2)
                        assert.ok(
                            refreshes.every(
                                (request) =>
                                    request.method === "POST" && request.body === undefined && request.status === 204,
                            ),
                        )
                        assert.ok(refreshes[1].at - refreshes[0].at >= 7_900)
                        report(stage, true)

                        stage = "typing_completion_cleanup"
                        yield* Effect.promise(() => assertTypingStopped(typingRequests))
                        report(stage, true)

                        stage = "typing_cancellation_cleanup"
                        const entered = Deferred.makeUnsafe()
                        const pending = yield* Effect.forkChild(
                            client.messages.keepTyping(
                                channel.id,
                                Effect.sync(() => Deferred.doneUnsafe(entered, Effect.void)).pipe(
                                    Effect.andThen(Effect.never),
                                ),
                            ),
                        )
                        yield* Deferred.await(entered)
                        yield* Fiber.interrupt(pending)
                        const cancelled = yield* Fiber.await(pending)
                        assert.ok(Exit.isFailure(cancelled) && Cause.hasInterruptsOnly(cancelled.cause))
                        yield* Effect.promise(() => assertTypingStopped(typingRequests))
                        report(stage, true)
                        stage = "sdk_receive_and_reply"
                    }
                    if (pagination)
                        yield* Effect.promise(() =>
                            verifyPagination(
                                {
                                    history: (query) =>
                                        Stream.toAsyncIterable(client.messages.iterateHistory(channel.id, query)),
                                    members: (query) => Stream.toAsyncIterable(client.members.iterate(guildId, query)),
                                    users: (target, emoji, query) =>
                                        Stream.toAsyncIterable(
                                            client.messages.iterateReactionUsers(target, emoji, query),
                                        ),
                                    pins: (query) =>
                                        Stream.toAsyncIterable(client.messages.iteratePins(channel.id, query)),
                                    react: (target) => Effect.runPromise(client.messages.addReaction(target, "👍")),
                                    pin: (target) => Effect.runPromise(client.messages.pin(target)),
                                    unpin: (target) => Effect.runPromise(client.messages.unpin(target)),
                                    cancelHistory: async (signal) => {
                                        const result = await Effect.runPromiseExit(
                                            Stream.runDrain(
                                                client.messages.iterateHistory(channel.id, { maxItems: 1 }),
                                            ),
                                            { signal },
                                        )
                                        assert.ok(Exit.isFailure(result) && Cause.hasInterrupts(result.cause))
                                    },
                                },
                                channel.id,
                                user.id,
                            ),
                        )
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
                        yield* Effect.promise(() =>
                            verifyCacheRestAdmissionAndExpiry(cacheSend, cacheReply, cacheGet, channel.id),
                        )
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
                    if (moderation) {
                        const scope = yield* Effect.scope
                        const run = async (operation) => {
                            const result = await Effect.runPromise(Effect.result(operation))
                            if (result._tag === "Failure") throw result.failure
                            return result.success
                        }
                        yield* Effect.promise(() =>
                            verifyModeration(
                                {
                                    timeout: (target, duration, options) =>
                                        run(client.members.timeout(target, duration, options)),
                                    clearTimeout: (target) => run(client.members.clearTimeout(target)),
                                    fetch: (target) => run(client.members.fetch(target)),
                                    get: (target) => run(client.members.get(target)),
                                    kick: (target, options) => run(client.members.kick(target, options)),
                                    ban: (target, input, options) => run(client.guilds.ban(target, input, options)),
                                    unban: (target, options) => run(client.guilds.unban(target, options)),
                                    bans: () => run(client.guilds.fetchBans(guildId)),
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
                                user.id,
                            ),
                        )
                    }
                    if (batchDelete) {
                        const scope = yield* Effect.scope
                        const run = async (operation) => {
                            const result = await Effect.runPromise(Effect.result(operation))
                            if (result._tag === "Failure") throw result.failure
                            return result.success
                        }
                        yield* Effect.promise(() =>
                            verifyBatchDeletion(
                                {
                                    send: (input) => run(client.messages.send(channel.id, input)),
                                    get: (target) => run(client.messages.get(target)),
                                    deleteMany: (ids) => run(client.messages.deleteMany(channel.id, ids)),
                                    on: async (handler) => {
                                        const subscription = await run(
                                            client
                                                .on("messageDeleteBulk", (notice) => Effect.sync(() => handler(notice)))
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
                            ),
                        )
                    }
                    if (cleanupCheck) {
                        const run = async (operation) => {
                            const result = await Effect.runPromise(Effect.result(operation))
                            if (result._tag === "Failure") throw result.failure
                            return result.success
                        }
                        yield* Effect.promise(() =>
                            verifyWorkflowReads(
                                {
                                    guildList: () => run(client.guilds.fetchPage({ withCounts: true })),
                                    hierarchy: (target) => run(client.members.fetchHierarchyCheck(target)),
                                },
                                user.id,
                            ),
                        )
                        yield* Effect.promise(() =>
                            verifyCleanup(
                                {
                                    send: (input) => run(client.messages.send(channel.id, input)),
                                    preview: (selection) => run(client.messages.previewCleanup(channel.id, selection)),
                                    cleanup: (plan, options) => run(client.messages.cleanup(plan, options)),
                                },
                                channel.id,
                                user.id,
                            ),
                        )
                    }
                    if (optionalTools) {
                        const scope = yield* Effect.scope
                        const run = async (operation) => {
                            const result = await Effect.runPromise(Effect.result(operation))
                            if (result._tag === "Failure") throw result.failure
                            return result.success
                        }
                        yield* Effect.promise(() =>
                            verifyOptionalTools(
                                {
                                    builders,
                                    parseQuoted: commands.parseQuoted,
                                    assertConnected: async () => assert.equal(client.state, "Connected"),
                                    create: (options) => run(commands.create(options)),
                                    register: (router, command) => run(router.register(command)),
                                    attach: (router) => run(router.attach(client).pipe(Scope.provide(scope))),
                                    send: (input) => run(client.messages.send(channel.id, input)),
                                    reply: (message, input) => run(client.messages.reply(message, input)),
                                    cooldowns: async (claims) => {
                                        const store = await run(commands.memoryCooldowns({ maxEntries: 4 }))
                                        const recordClaim = (claim) => Effect.sync(() => claims.push(claim))
                                        return {
                                            store: {
                                                claim: (input) => store.claim(input).pipe(Effect.tap(recordClaim)),
                                            },
                                            clear: () => run(store.clear()),
                                        }
                                    },
                                    guard: (matches) => {
                                        return ({ message }) => Effect.sync(() => matches(message))
                                    },
                                    execute: (runCommand) => {
                                        return ({ message }) => Effect.promise(() => runCommand(message))
                                    },
                                    reject:
                                        (onReject) =>
                                        ({ message }, rejection) =>
                                            Effect.promise(() => onReject(message, rejection)),
                                    close: (subscription) =>
                                        run(
                                            Effect.gen(function* () {
                                                yield* subscription.unsubscribe()
                                                yield* subscription.waitForClose()
                                            }),
                                        ),
                                    observe: async (receive) => {
                                        const observer = await run(
                                            client
                                                .on("messageCreate", (message) => Effect.sync(() => receive(message)))
                                                .pipe(Scope.provide(scope)),
                                        )
                                        return {
                                            close: () =>
                                                run(
                                                    Effect.gen(function* () {
                                                        yield* observer.unsubscribe()
                                                        yield* observer.waitForClose()
                                                    }),
                                                ),
                                        }
                                    },
                                },
                                channel.id,
                                user.id,
                            ),
                        )
                    }
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
                                    setHoistPositions: (positions) =>
                                        run(client.roles.setHoistPositions(guildId, positions)),
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
                    if (channels) {
                        const scope = yield* Effect.scope
                        const run = async (operation) => {
                            const result = await Effect.runPromise(Effect.result(operation))
                            if (result._tag === "Failure") throw result.failure
                            return result.success
                        }
                        yield* Effect.promise(() =>
                            verifyChannels(
                                {
                                    get: (id) => run(client.channels.get(id)),
                                    fetch: (id) => run(client.channels.fetch(id)),
                                    fetchAll: (id) => run(client.channels.fetchAll(id)),
                                    create: (id, input) => run(client.channels.create(id, input)),
                                    edit: (id, input) => run(client.channels.edit(id, input)),
                                    delete: (id) => run(client.channels.delete(id)),
                                    reorder: (id, positions) => run(client.channels.reorder(id, positions)),
                                    setPermissionOverwrite: (id, overwrite) =>
                                        run(client.channels.setPermissionOverwrite(id, overwrite)),
                                    removePermissionOverwrite: (id, targetId) =>
                                        run(client.channels.removePermissionOverwrite(id, targetId)),
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
                    if (embeds || attachments || attachmentSources) {
                        const scope = yield* Effect.scope
                        const run = async (operation) => {
                            const result = await Effect.runPromise(Effect.result(operation))
                            if (result._tag === "Failure") reportFailure(result.failure)
                            assert.equal(result._tag, "Success")
                            return result.success
                        }
                        const attachmentOps = {
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
                            download: (attachment, options) => run(client.attachments.download(attachment, options)),
                            downloadFailure: (attachment, options) =>
                                Effect.runPromise(client.attachments.download(attachment, options).pipe(Effect.flip)),
                            stream: (attachment, options) =>
                                Stream.toAsyncIterable(client.attachments.stream(attachment, options)),
                            cancelDownload: async (attachment, size, signal) => {
                                const cancelled = await Effect.runPromiseExit(
                                    client.attachments.download(attachment, { maxBytes: size, timeoutMs: 60_000 }),
                                    { signal },
                                )
                                assert.ok(Exit.isFailure(cancelled))
                                if (Exit.isFailure(cancelled)) assert.equal(Cause.hasInterrupts(cancelled.cause), true)
                            },
                        }
                        yield* Effect.promise(() =>
                            attachmentSources
                                ? verifyAttachmentSources({
                                      ops: attachmentOps,
                                      channelId: channel.id,
                                      rawFetch,
                                      getFetch: () => globalThis.fetch,
                                      setFetch: (value) => (globalThis.fetch = value),
                                      setStage: (value) => (stage = value),
                                      report,
                                  })
                                : (attachments ? verifyAttachments : verifyEmbeds)(attachmentOps, channel.id),
                        )
                    }
                    if (forceRecovery && !reactions && !pins && !guilds && !channels) {
                        if (cache) sdkRequests.length = 0
                        if (collectors) {
                            yield* Effect.promise(() =>
                                verifyCollectors(
                                    async (options) => {
                                        const {
                                            progressReply,
                                            progressWait,
                                            progressCancel,
                                            progressGate,
                                            progressCleanup,
                                            onProgress,
                                            ...settings
                                        } = options
                                        const collectorScope = Scope.makeUnsafe()
                                        let opened
                                        try {
                                            opened = await Effect.runPromise(
                                                client.messages
                                                    .collect(channel.id, {
                                                        ...settings,
                                                        ...(progressReply || progressWait
                                                            ? {
                                                                  onMessage: (message) =>
                                                                      Effect.gen(function* () {
                                                                          yield* Effect.sync(() =>
                                                                              onProgress?.("started", message),
                                                                          )
                                                                          if (progressGate)
                                                                              yield* Effect.promise(() =>
                                                                                  progressGate(message),
                                                                              )
                                                                          if (progressWait) yield* Effect.never
                                                                          else {
                                                                              const reply =
                                                                                  yield* client.messages.reply(
                                                                                      message,
                                                                                      {
                                                                                          content: `${progressReply}-${message.id}`,
                                                                                      },
                                                                                  )
                                                                              yield* Effect.sync(() =>
                                                                                  onProgress?.("reply", message, reply),
                                                                              )
                                                                          }
                                                                      }).pipe(
                                                                          Effect.ensuring(
                                                                              Effect.gen(function* () {
                                                                                  if (progressCleanup) {
                                                                                      yield* Effect.sync(() =>
                                                                                          onProgress?.(
                                                                                              "cleanupStarted",
                                                                                              message,
                                                                                          ),
                                                                                      )
                                                                                      yield* Effect.promise(() =>
                                                                                          progressCleanup(message),
                                                                                      )
                                                                                  }
                                                                                  yield* Effect.sync(() =>
                                                                                      onProgress?.("cleaned", message),
                                                                                  )
                                                                              }),
                                                                          ),
                                                                      ),
                                                              }
                                                            : {}),
                                                    })
                                                    .pipe(Scope.provide(collectorScope)),
                                            )
                                        } catch (error) {
                                            await Effect.runPromise(Scope.close(collectorScope, Exit.void))
                                            throw error
                                        }
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
                                            close: () => Effect.runPromise(Scope.close(collectorScope, Exit.void)),
                                            ...(progressCancel
                                                ? {
                                                      cancel: () =>
                                                          Effect.runPromise(Scope.close(collectorScope, Exit.void)),
                                                      cancelKind: "scope",
                                                  }
                                                : {}),
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
                        yield* Effect.promise(() => verifyCacheGatewayRebuild(cacheGet, channel.id))
                        yield* Effect.promise(() =>
                            verifyCacheProjectionConflict(
                                cacheSend,
                                (target) => Effect.runPromise(client.messages.fetch(target)),
                                cacheGet,
                                channel.id,
                            ),
                        )
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
        if ((attachments || attachmentSources) && Exit.isFailure(exit))
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
    stage = "received_message_metadata_readback"
    const seedWire = (await api("GET", `/channels/${channel.id}/messages/${seed.id}`)).data
    verifyReceivedMetadata(seed, seedWire)
    verifyReceivedMetadata(reply, actual)
    report(stage, true)
    report("sdk_receive_and_reply", true)
    if (forceRecovery) report("post_resume_receive_and_reply", true)
    report("reply_reference_and_mentions_verified", true)
    report("sdk_closed", true)
} catch (error) {
    // Never print assertions, HTTP bodies, native causes, configured identities or credentials
    if (attachments || attachmentSources || reactions || pins || guilds || channels || moderation) reportFailure(error)
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
