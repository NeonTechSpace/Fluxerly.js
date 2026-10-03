// Consumer operations: profile banner URLs, attachment deletion, member role replacement with the designated bot and
// gateway guild and channel member counts, including lost responses, cancellation and connection loss.
// Journal `.env.test.consumer-operations.local` records the designated bot's original roles and the test role and
// channel markers with their returned IDs. An existing journal triggers recovery only: Only the recorded roles
// plus the unchanged zero-permission test role are restored, then restoration and removal of the role and channel are
// verified. An unexpected assignment or altered resource keeps the journal
import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import { Cause, Effect, Exit, Fiber, Scope } from "effect"
import WebSocket from "ws"
import { createGuildChannelFixture, cleanupGuildChannelFixtures } from "./channel-fixture.mjs"
import { cleanupGuildTestRole, createGuildTestRole } from "./guild-fixture.mjs"
import { restoreConsumerBotRoles } from "./consumer-role-fixture.js"
import {
    acquireLock,
    finalizeOwned,
    loadSandboxEnvironment,
    openJournal,
    verifySandboxIdentity,
} from "./support/harness.js"
import { createFailureClassifier, createOutcomeReporter } from "./support/reporting.js"
import { createRetryingSandboxApi } from "./support/sandbox-api.js"

const mode = process.argv[2]
const rawFetch = globalThis.fetch
const journalFile = openJournal("consumer-operations")
const idPattern = /^[1-9][0-9]*$/
// The largest valid snowflake is never a real member
const knownAbsentId = "9223372036854775807"
const report = createOutcomeReporter({ mode })
let stage = "configuration"
let lock
let token
let guildId
let botId
let journal
let client
let scope
let gateway
let verified = false

function sortedIds(value) {
    assert.ok(Array.isArray(value) && value.every((id) => typeof id === "string" && idPattern.test(id)))
    const ids = [...value].sort()
    assert.equal(new Set(ids).size, ids.length)
    return ids
}

function sameIds(actual, expected) {
    return JSON.stringify(sortedIds(actual)) === JSON.stringify(sortedIds(expected))
}

function resultValue(result) {
    assert.equal(typeof result?.isErr, "function")
    if (result.isErr()) throw result.error
    return result.value
}

async function value(operation) {
    if (Effect.isEffect(operation)) {
        const exit = await Effect.runPromiseExit(operation)
        if (Exit.isSuccess(exit)) return exit.value
        if (Cause.hasDies(exit.cause)) throw new Error("Unexpected native operation defect")
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
        if (failure?._tag === "Fail") throw failure.error
        throw new Error("Unexpected native operation interruption")
    }
    return resultValue(await operation)
}

async function failure(operation) {
    try {
        await value(operation)
    } catch (error) {
        return error
    }
    assert.fail("Expected an operation failure")
}

const api = createRetryingSandboxApi({ fetch: rawFetch, token: () => token })

const cleanupApi = (method, path, body) => api(method, path, body, true)

async function readBotMember() {
    const member = await api("GET", `/guilds/${guildId}/members/${botId}`)
    assert.equal(member.status, 200)
    assert.equal(member.data?.user?.id, botId)
    return member.data
}

function memberRoleIds(member) {
    return sortedIds(member?.roles)
}

// Fluxer has no compare-and-set role endpoint: this detects pre-existing conflicts, but cannot close a later race
async function assertCurrentBotRoles(expected) {
    assert.ok(
        sameIds(memberRoleIds(await readBotMember()), expected),
        "Conflicting bot-role change; retain recovery journal",
    )
}

async function readRoles() {
    const roles = await api("GET", `/guilds/${guildId}/roles`)
    assert.equal(roles.status, 200)
    assert.ok(Array.isArray(roles.data))
    return roles.data
}

async function ownedTestRole() {
    assert.match(journal?.roleId ?? "", idPattern)
    assert.match(journal?.roleName ?? "", /^fluxerly-sdk-role-[a-f0-9]{32}$/)
    const matches = (await readRoles()).filter((role) => role.name === journal.roleName)
    assert.equal(matches.length, 1, "Owned test role changed or missing; retain recovery journal")
    assert.equal(matches[0].id, journal.roleId)
    assert.equal(String(matches[0].permissions), "0")
    return journal.roleId
}

function journalBaseline() {
    assert.ok(journal && Array.isArray(journal.baselineRoleIds))
    return sortedIds(journal.baselineRoleIds)
}

const save = () => journalFile.save(journal)

async function cleanup() {
    if (!journal) return
    assert.equal(journal.kind, "consumer-operations")
    assert.equal(journal.guildId, guildId)
    assert.equal(journal.botId, botId)
    await restoreConsumerBotRoles(cleanupApi, journal, guildId, botId)
    if (journal.roleName !== undefined) await cleanupGuildTestRole(cleanupApi, journal, save)
    if (journal.channelFixtures !== undefined) await cleanupGuildChannelFixtures(cleanupApi, journal, save)
    journalFile.remove()
    journal = undefined
    report("test_resources_removed")
}

const safeFailure = createFailureClassifier({
    tags: [
        "AuthenticationError",
        "CancelledError",
        "ClientBusyError",
        "ClientClosedError",
        "ConfigurationError",
        "ConnectionError",
        "ConnectionTimeoutError",
        "CountOperationError",
        "GuildOperationError",
        "MessageOperationError",
        "RateLimitError",
    ],
    reasons: [
        "busy",
        "closed",
        "connectionLost",
        "input",
        "network",
        "notConnected",
        "notFound",
        "protocol",
        "rateLimit",
        "rejected",
        "response",
        "timeout",
    ],
    httpStatus: true,
})

function observeGateway() {
    const emitDescriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "emit")
    const sendDescriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "send")
    const originalEmit = WebSocket.prototype.emit
    const originalSend = WebSocket.prototype.send
    const sockets = new Map()
    const sent = new Map([
        [15, 0],
        [16, 0],
    ])
    let drop
    let dropped = false
    let malformed = false

    const observe = (socket) => {
        let observed = sockets.get(socket)
        if (!observed) {
            assert.ok(sockets.size < 2)
            const url = new URL(socket.url)
            assert.equal(url.protocol, "wss:")
            assert.equal(url.host, "gateway.fluxer.app")
            observed = { ready: 0, resumed: 0 }
            sockets.set(socket, observed)
        }
        return observed
    }

    WebSocket.prototype.emit = function (event, ...args) {
        try {
            if (["open", "message", "error", "close"].includes(event)) {
                const observed = observe(this)
                if (event === "message") {
                    const frame = JSON.parse(args[0].toString())
                    if (frame.op === 0 && frame.t === "READY") observed.ready++
                    if (frame.op === 0 && frame.t === "RESUMED") observed.resumed++
                    // Drop one response only inside this SDK process, without retaining its private frame body
                    if (frame.op === 0 && frame.t === drop?.event && frame.d?.nonce === drop.nonce) {
                        dropped = true
                        drop = undefined
                        return true
                    }
                }
            }
        } catch {
            malformed = true
        }
        return Reflect.apply(originalEmit, this, [event, ...args])
    }
    WebSocket.prototype.send = function (data, ...args) {
        try {
            const frame = JSON.parse(data.toString())
            if (frame.op === 15 || frame.op === 16) {
                sent.set(frame.op, sent.get(frame.op) + 1)
                if (drop?.op === frame.op) {
                    assert.equal(drop.nonce, undefined)
                    assert.equal(typeof frame.d?.nonce, "string")
                    drop.nonce = frame.d.nonce
                }
            }
        } catch {
            malformed = true
        }
        return Reflect.apply(originalSend, this, [data, ...args])
    }

    return {
        dropNext(event, op) {
            assert.equal(drop, undefined)
            assert.ok(event === "GUILD_COUNTS_UPDATE" || event === "CHANNEL_MEMBER_COUNTS_UPDATE")
            assert.equal(op, event === "GUILD_COUNTS_UPDATE" ? 15 : 16)
            dropped = false
            drop = { event, op, nonce: undefined }
        },
        clearDrop() {
            drop = undefined
        },
        count(op) {
            return sent.get(op)
        },
        async waitForCount(op, minimum) {
            const deadline = performance.now() + 15_000
            while (this.count(op) < minimum) {
                assert.ok(!malformed && performance.now() < deadline)
                await sleep(20)
            }
        },
        async waitForDropped() {
            const deadline = performance.now() + 15_000
            while (!dropped) {
                assert.ok(!malformed && performance.now() < deadline)
                await sleep(20)
            }
        },
        interrupt() {
            assert.ok(!malformed)
            const active = [...sockets.keys()].filter((socket) => socket.readyState === WebSocket.OPEN)
            assert.equal(active.length, 1)
            // Only this test process's authenticated SDK socket is interrupted
            active[0].terminate()
        },
        async waitForRecovery(client) {
            const deadline = performance.now() + 45_000
            while (client.state !== "Connected") {
                assert.ok(!malformed && client.state !== "Closed" && performance.now() < deadline)
                await sleep(20)
            }
            assert.equal(sockets.size, 2)
            const latest = [...sockets.values()][1]
            assert.equal(latest.ready, 0)
            assert.ok(latest.resumed >= 1)
        },
        restore() {
            if (emitDescriptor) Object.defineProperty(WebSocket.prototype, "emit", emitDescriptor)
            else delete WebSocket.prototype.emit
            if (sendDescriptor) Object.defineProperty(WebSocket.prototype, "send", sendDescriptor)
            else delete WebSocket.prototype.send
            sockets.clear()
        },
    }
}

async function verifyBanner(sdk) {
    stage = "bot_profile_banner_url"
    const profile = await value(client.users.fetchProfile(botId))
    assert.equal(profile.user.id, botId)
    const banner = sdk.assets.userBanner(profile)
    if (typeof profile.profile.banner === "string")
        assert.equal(banner, `https://fluxerusercontent.com/banners/${botId}/${profile.profile.banner}.webp`)
    else {
        assert.equal(profile.profile.banner, null)
        assert.equal(banner, null)
    }
    report(stage, true, { mediaDownloaded: false })
}

async function verifyAttachmentDeletion(channelId) {
    const text = `consumer-attachment-${crypto.randomUUID()}`
    const first = await value(
        client.messages.send(channelId, {
            content: text,
            attachments: [
                { filename: `first-${crypto.randomUUID()}.txt`, data: new TextEncoder().encode("first") },
                { filename: `second-${crypto.randomUUID()}.txt`, data: new TextEncoder().encode("second") },
            ],
        }),
    )
    assert.equal(first.attachments.length, 2)

    stage = "attachment_delete_preserves_other_file"
    await value(client.messages.deleteAttachment(first, first.attachments[0].id))
    const afterFirst = await api("GET", `/channels/${channelId}/messages/${first.id}`)
    assert.equal(afterFirst.status, 200)
    assert.equal(afterFirst.data?.content, text)
    assert.deepEqual(
        afterFirst.data?.attachments?.map((attachment) => attachment.id),
        [first.attachments[1].id],
    )
    report(stage)

    stage = "attachment_delete_preserves_content_message"
    await value(client.messages.deleteAttachment(first, first.attachments[1].id))
    const afterSecond = await api("GET", `/channels/${channelId}/messages/${first.id}`)
    assert.equal(afterSecond.status, 200)
    assert.equal(afterSecond.data?.content, text)
    assert.deepEqual(afterSecond.data?.attachments ?? [], [])
    report(stage)

    stage = "attachment_only_message_deleted_with_last_file"
    const attachmentOnly = await value(
        client.messages.send(channelId, {
            attachments: [{ filename: `only-${crypto.randomUUID()}.txt`, data: new TextEncoder().encode("only") }],
        }),
    )
    assert.equal(attachmentOnly.attachments.length, 1)
    await value(client.messages.deleteAttachment(attachmentOnly, attachmentOnly.attachments[0].id))
    assert.equal(
        (await api("GET", `/channels/${channelId}/messages/${attachmentOnly.id}`, undefined, true)).status,
        404,
    )
    report(stage)

    stage = "attachment_delete_lost_response_reconciled"
    const uncertain = await value(
        client.messages.send(channelId, {
            content: `consumer-lost-attachment-${crypto.randomUUID()}`,
            attachments: [{ filename: `lost-${crypto.randomUUID()}.txt`, data: new TextEncoder().encode("lost") }],
        }),
    )
    let dispatches = 0
    const clientFetch = globalThis.fetch
    globalThis.fetch = async (request, options) => {
        const url = new URL(typeof request === "string" || request instanceof URL ? request : request.url)
        if (
            options?.method === "DELETE" &&
            url.pathname ===
                `/v1/channels/${channelId}/messages/${uncertain.id}/attachments/${uncertain.attachments[0].id}`
        ) {
            dispatches++
            assert.equal(dispatches, 1)
            const response = await clientFetch(request, options)
            assert.equal(response.status, 204)
            await response.body?.cancel()
            throw new TypeError("Test-owned attachment response loss")
        }
        return clientFetch(request, options)
    }
    try {
        const error = await failure(client.messages.deleteAttachment(uncertain, uncertain.attachments[0].id))
        assert.equal(error?._tag, "MessageOperationError")
        assert.equal(error?.operation, "deleteAttachment")
        assert.equal(error?.reason, "network")
        assert.equal(error?.outcome, "unknown")
    } finally {
        globalThis.fetch = clientFetch
    }
    assert.equal(dispatches, 1)
    const reconciled = await api("GET", `/channels/${channelId}/messages/${uncertain.id}`)
    assert.equal(reconciled.status, 200)
    assert.equal(reconciled.data?.content, uncertain.content)
    assert.deepEqual(reconciled.data?.attachments ?? [], [])
    report(stage, true, { singleDispatch: true })
}

async function verifyRoleReplacement() {
    const roleId = await ownedTestRole()
    const baseline = journalBaseline()
    assert.ok(!baseline.includes(roleId))
    const target = { guildId, userId: botId }
    const desired = sortedIds([...baseline, roleId])
    stage = "member_roles_replace_with_owned_role"
    await ownedTestRole()
    await assertCurrentBotRoles(baseline)
    const assigned = await value(client.members.setRoles(target, desired))
    assert.equal(assigned.userId, botId)
    assert.ok(sameIds(assigned.roleIds, desired))
    await assertCurrentBotRoles(desired)
    report(stage)

    stage = "member_roles_restore_baseline"
    await ownedTestRole()
    await assertCurrentBotRoles(desired)
    const restored = await value(client.members.setRoles(target, baseline))
    assert.equal(restored.userId, botId)
    assert.ok(sameIds(restored.roleIds, baseline))
    await assertCurrentBotRoles(baseline)
    report(stage)

    stage = "member_roles_lost_response_reconciled"
    await ownedTestRole()
    await assertCurrentBotRoles(baseline)
    let dispatches = 0
    const clientFetch = globalThis.fetch
    globalThis.fetch = async (request, options) => {
        const url = new URL(typeof request === "string" || request instanceof URL ? request : request.url)
        if (options?.method === "PATCH" && url.pathname === `/v1/guilds/${guildId}/members/${botId}`) {
            dispatches++
            assert.equal(dispatches, 1)
            const response = await clientFetch(request, options)
            assert.equal(response.status, 200)
            await response.body?.cancel()
            throw new TypeError("Test-owned role response loss")
        }
        return clientFetch(request, options)
    }
    try {
        const error = await failure(client.members.setRoles(target, desired))
        assert.equal(error?._tag, "GuildOperationError")
        assert.equal(error?.operation, "members.setRoles")
        assert.equal(error?.reason, "network")
        assert.equal(error?.outcome, "unknown")
    } finally {
        globalThis.fetch = clientFetch
    }
    assert.equal(dispatches, 1)
    await assertCurrentBotRoles(desired)
    await ownedTestRole()
    await assertCurrentBotRoles(desired)
    await value(client.members.setRoles(target, baseline))
    await assertCurrentBotRoles(baseline)
    report(stage, true, { singleDispatch: true })
}

function assertPositiveCounts(result, key, expectedId) {
    assert.equal(result.counts.length, 1)
    assert.equal(result.counts[0][key], expectedId)
    assert.ok(Number.isSafeInteger(result.counts[0].memberCount) && result.counts[0].memberCount > 0)
    assert.ok(Number.isSafeInteger(result.counts[0].onlineCount) && result.counts[0].onlineCount >= 0)
}

async function verifyCounts(channelId) {
    stage = "gateway_counts_connect"
    await value(client.connect())
    const connectedDeadline = performance.now() + 35_000
    while (client.state !== "Connected") {
        assert.ok(client.state !== "Closed" && performance.now() < connectedDeadline)
        await sleep(20)
    }
    report(stage)

    stage = "gateway_counts_target_observation"
    const guildCounts = await value(client.guilds.fetchCounts([guildId]))
    assertPositiveCounts(guildCounts, "guildId", guildId)
    const channelCounts = await value(client.channels.fetchMemberCounts(guildId, [channelId]))
    assertPositiveCounts(channelCounts, "channelId", channelId)
    report(stage)

    stage = "gateway_counts_partial_omission"
    const partialGuilds = await value(client.guilds.fetchCounts([guildId, knownAbsentId]))
    assertPositiveCounts(
        { counts: partialGuilds.counts.filter((count) => count.guildId === guildId) },
        "guildId",
        guildId,
    )
    assert.deepEqual(partialGuilds.omittedGuildIds, [knownAbsentId])
    const partialChannels = await value(client.channels.fetchMemberCounts(guildId, [channelId, knownAbsentId]))
    assertPositiveCounts(
        { counts: partialChannels.counts.filter((count) => count.channelId === channelId) },
        "channelId",
        channelId,
    )
    assert.deepEqual(partialChannels.omittedChannelIds, [knownAbsentId])
    report(stage)

    stage = "gateway_counts_dropped_response_timeout"
    const timeoutBefore = gateway.count(15)
    gateway.dropNext("GUILD_COUNTS_UPDATE", 15)
    try {
        const pending = failure(client.guilds.fetchCounts([guildId], { timeoutMs: 10_000 }))
        await gateway.waitForCount(15, timeoutBefore + 1)
        await gateway.waitForDropped()
        const error = await pending
        assert.equal(error?._tag, "CountOperationError")
        assert.equal(error?.operation, "guilds.fetchCounts")
        assert.equal(error?.reason, "timeout")
    } finally {
        gateway.clearDrop()
    }
    assert.equal(gateway.count(15), timeoutBefore + 1)
    report(stage, true, { singleDispatch: true })

    stage = "gateway_counts_pending_cancellation"
    const cancellationBefore = gateway.count(16)
    gateway.dropNext("CHANNEL_MEMBER_COUNTS_UPDATE", 16)
    try {
        if (mode === "default") {
            const controller = new AbortController()
            const pending = client.channels.fetchMemberCounts(guildId, [channelId], { signal: controller.signal })
            let settled = false
            void pending.then(
                () => (settled = true),
                () => (settled = true),
            )
            await gateway.waitForCount(16, cancellationBefore + 1)
            await gateway.waitForDropped()
            assert.equal(settled, false)
            controller.abort()
            const result = await pending
            assert.ok(result.isErr())
            assert.equal(result.error?._tag, "CancelledError")
        } else {
            const fiber = Effect.runFork(client.channels.fetchMemberCounts(guildId, [channelId]))
            let settled = false
            const awaiting = Effect.runPromise(Fiber["await"](fiber)).then((exit) => {
                settled = true
                return exit
            })
            await gateway.waitForCount(16, cancellationBefore + 1)
            await gateway.waitForDropped()
            assert.equal(settled, false)
            await Effect.runPromise(Fiber.interrupt(fiber))
            const exit = await awaiting
            assert.ok(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
        }
    } finally {
        gateway.clearDrop()
    }
    assert.equal(gateway.count(16), cancellationBefore + 1)
    report(stage, true, { singleDispatch: true })

    stage = "gateway_counts_connection_lost"
    const recoveryBefore = gateway.count(15)
    gateway.dropNext("GUILD_COUNTS_UPDATE", 15)
    let pending
    try {
        pending = failure(client.guilds.fetchCounts([guildId]))
        let settled = false
        void pending.then(
            () => (settled = true),
            () => (settled = true),
        )
        await gateway.waitForCount(15, recoveryBefore + 1)
        await gateway.waitForDropped()
        assert.equal(settled, false)
        gateway.interrupt()
        const error = await pending
        assert.equal(error?._tag, "CountOperationError")
        assert.equal(error?.operation, "guilds.fetchCounts")
        assert.equal(error?.reason, "connectionLost")
    } finally {
        gateway.clearDrop()
    }
    assert.equal(gateway.count(15), recoveryBefore + 1)
    await gateway.waitForRecovery(client)
    assert.equal(gateway.count(15), recoveryBefore + 1)
    const recovered = await value(client.guilds.fetchCounts([guildId]))
    assertPositiveCounts(recovered, "guildId", guildId)
    report(stage, true, { recoveredCount: true, singleDispatch: true })
}

const watchdog = setTimeout(() => {
    report(stage, false, { code: "process_timeout", journalRetained: journal !== undefined })
    process.exit(1)
}, 240_000).unref()

try {
    assert.ok(mode === "default" || mode === "effect")
    assert.equal(process.argv.length, 3)
    stage = "sandbox_lock"
    lock = acquireLock()

    const sandbox = loadSandboxEnvironment()
    token = sandbox.token
    guildId = sandbox.guildId

    stage = "sandbox_identity"
    const identity = await verifySandboxIdentity(async (path) => (await api("GET", path)).data, {
        ...sandbox,
        applicationPath: "/oauth2/applications/@me",
        concurrent: true,
    })
    botId = identity.botId
    verified = true
    report(stage, true, { clientSecretUsed: false })

    stage = "recover_prior_test"
    if (journalFile.exists()) {
        journal = journalFile.read()
        stage = "recovery_only"
        await cleanup()
        report(stage)
    } else {
        journal = { kind: "consumer-operations", guildId, botId }
        journalFile.create(journal)
        journal.baselineRoleIds = memberRoleIds(await readBotMember())
        save()
        const roleId = await createGuildTestRole(api, journal, save)
        assert.ok(!journalBaseline().includes(roleId))
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
        report("journaled_test_role_and_channel_created")

        const sdk = await import(mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect")
        if (mode === "default") client = sdk.createClient({ token })
        else {
            scope = Scope.makeUnsafe()
            client = await value(sdk.createClient({ token }).pipe(Scope.provide(scope)))
        }
        gateway = observeGateway()
        await verifyBanner(sdk)
        await verifyAttachmentDeletion(channel.id)
        await verifyRoleReplacement()
        await verifyCounts(channel.id)

        stage = "client_shutdown"
        await value(client.shutdown())
        assert.equal(client.state, "Closed")
        report(stage)
    }
} catch (error) {
    report(stage, false, safeFailure(error))
    process.exitCode = 1
} finally {
    globalThis.fetch = rawFetch
    gateway?.restore()
    // Keep the journal, lock and deadline if a failed owned finalizer may have left a writer alive
    await finalizeOwned({
        writers: [
            client && client.state !== "Closed" && ["client_shutdown", () => value(client.shutdown())],
            scope && ["scope_close", () => Effect.runPromise(Scope.close(scope, Exit.void))],
        ],
        cleanup: async () => {
            if (verified && journal) await cleanup()
        },
        lock,
        watchdog,
        onFailure: (finalizer) => {
            if (finalizer === "cleanup")
                report("resource_cleanup", false, { code: "cleanup_failed", journalRetained: journal !== undefined })
            else if (finalizer === "sandbox_lock")
                report("lock_cleanup", false, { code: "cleanup_failed", lockRetained: true })
            else
                report("client_cleanup", false, {
                    code: "cleanup_failed",
                    finalizer,
                    journalRetained: journal !== undefined,
                    lockRetained: lock !== undefined,
                })
            process.exitCode = 1
        },
    })
}
