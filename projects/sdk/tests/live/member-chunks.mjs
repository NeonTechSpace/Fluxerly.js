import assert from "node:assert/strict"
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { parseEnv } from "node:util"
import { Cause, Effect, Exit, Scope, Stream } from "effect"
import WebSocket from "ws"

const mode = process.argv[2]
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const absentId = "18446744073709551615"
const report = (check, passed = true, details = {}) => console.log(JSON.stringify({ mode, check, passed, ...details }))
let stage = "configuration"
let lock
let client
let scope
let watch
let token
let guildId
let botId

function fromExit(exit) {
    if (Exit.isSuccess(exit)) return exit.value
    if (Cause.hasDies(exit.cause)) throw Error("Unexpected SDK defect")
    if (Cause.hasInterruptsOnly(exit.cause)) throw { _tag: "TestInterrupted" }
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    if (failure?._tag === "Fail") throw failure.error
    throw Error("Unexpected operation outcome")
}
async function value(operation) {
    if (Effect.isEffect(operation)) return fromExit(await Effect.runPromiseExit(operation))
    const result = await operation
    if (result.isErr()) throw result.error
    return result.value
}
const outcome = (operation) =>
    operation.then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
    )
function expectFailure(result, reason, tag = "MemberChunkError") {
    assert.equal(result.ok, false)
    assert.equal(result.error?._tag, tag)
    if (reason !== undefined) assert.equal(result.error.reason, reason)
}
async function api(path) {
    const response = await fetch(`https://api.fluxer.app/v1${path}`, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bot ${token}` },
    })
    assert.equal(response.status, 200)
    return response.json()
}
function safeFailure(error) {
    const reasons = new Set([
        "input",
        "notConnected",
        "busy",
        "response",
        "overflow",
        "timeout",
        "connectionLost",
        "rateLimit",
    ])
    const tags = new Set(["MemberChunkError", "CancelledError", "ClientClosedError", "TestInterrupted"])
    return {
        category: tags.has(error?._tag) ? error._tag : error?.code === "ERR_ASSERTION" ? "assertion" : "unexpected",
        ...(reasons.has(error?.reason) ? { reason: error.reason } : {}),
    }
}

function observeGateway() {
    const emitDescriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "emit")
    const sendDescriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "send")
    const emit = WebSocket.prototype.emit
    const send = WebSocket.prototype.send
    const sockets = new Map()
    let sent = 0
    let dropping
    let dropped = false
    let problem = false
    let guildSeen = false
    WebSocket.prototype.emit = function (event, ...args) {
        try {
            if (["open", "message", "error", "close"].includes(event)) {
                if (!sockets.has(this)) {
                    assert.ok(sockets.size < 2)
                    const url = new URL(this.url)
                    assert.equal(url.protocol, "wss:")
                    assert.equal(url.host, "gateway.fluxer.app")
                    sockets.set(this, { ready: 0, resumed: 0 })
                }
                if (event === "message") {
                    const frame = JSON.parse(args[0].toString())
                    if (frame.op === 0 && frame.t === "READY") sockets.get(this).ready++
                    if (frame.op === 0 && frame.t === "RESUMED") sockets.get(this).resumed++
                    if (frame.op === 0 && frame.t === "GUILD_CREATE" && frame.d?.id === guildId && !frame.d.unavailable)
                        guildSeen = true
                    if (
                        frame.op === 0 &&
                        frame.t === "GUILD_MEMBERS_CHUNK" &&
                        dropping?.nonce !== undefined &&
                        frame.d?.nonce === dropping.nonce
                    ) {
                        dropped = true
                        dropping = undefined
                        return true
                    }
                }
            }
        } catch {
            problem = true
        }
        return Reflect.apply(emit, this, [event, ...args])
    }
    WebSocket.prototype.send = function (data, ...args) {
        try {
            const frame = JSON.parse(data.toString())
            if (frame.op === 8) {
                sent++
                if (dropping) {
                    assert.equal(dropping.nonce, undefined)
                    assert.match(frame.d?.nonce ?? "", /^[a-f0-9]{32}$/)
                    dropping.nonce = frame.d.nonce
                }
            }
        } catch {
            problem = true
        }
        return Reflect.apply(send, this, [data, ...args])
    }
    const waitFor = async (predicate, timeoutMs = 15_000) => {
        const deadline = performance.now() + timeoutMs
        while (!predicate()) {
            assert.ok(!problem && performance.now() < deadline)
            await sleep(20)
        }
        assert.ok(!problem)
    }
    return {
        count: () => sent,
        drop() {
            assert.equal(dropping, undefined)
            dropped = false
            dropping = {}
        },
        clearDrop() {
            dropping = undefined
        },
        waitForDropped: () => waitFor(() => dropped),
        ready: () => waitFor(() => client.state === "Connected" && guildSeen, 35_000),
        interrupt() {
            assert.ok(!problem)
            const active = [...sockets.keys()].filter((socket) => socket.readyState === WebSocket.OPEN)
            assert.equal(active.length, 1)
            active[0].terminate()
        },
        async recovered() {
            await waitFor(() => sockets.size === 2 && client.state === "Connected", 45_000)
            assert.equal([...sockets.values()][1].ready, 0)
            assert.ok([...sockets.values()][1].resumed >= 1)
        },
        verifyClosed() {
            assert.ok(!problem)
            assert.ok([...sockets.keys()].every((socket) => socket.readyState === WebSocket.CLOSED))
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

async function consume(query, options, signal) {
    const batches = []
    const accept = (chunk) => {
        // The verified sandbox fits one provider batch. This harness never accumulates an arbitrary live guild roster
        assert.equal(chunk.guildId, guildId)
        assert.equal(chunk.count, 1)
        assert.equal(chunk.index, 0)
        assert.ok(chunk.members.length < 1_000 && batches.length === 0)
        assert.ok(Object.isFrozen(chunk) && Object.isFrozen(chunk.members))
        batches.push(chunk)
    }
    if (mode === "default") {
        for await (const result of client.members.iterateChunks(guildId, query, {
            ...options,
            ...(signal ? { signal } : {}),
        })) {
            if (result.isErr()) throw result.error
            accept(result.value)
        }
    } else
        fromExit(
            await Effect.runPromiseExit(
                client.members
                    .iterateChunks(guildId, query, options)
                    .pipe(Stream.runForEach((chunk) => Effect.sync(() => accept(chunk)))),
                signal ? { signal } : undefined,
            ),
        )
    assert.equal(batches.length, 1)
    return batches[0]
}

const watchdog = setTimeout(() => {
    report(stage, false, { code: "process_timeout", lockRetained: lock !== undefined })
    process.exit(1)
}, 240_000).unref()
try {
    assert.ok(mode === "default" || mode === "effect")
    assert.equal(process.argv.length, 3)
    lock = openSync(lockPath, "wx")
    writeSync(lock, String(process.pid))
    const env = parseEnv(readFileSync(new URL("../../.env.test.local", import.meta.url), "utf8"))
    token = env.FLUXER_TEST_BOT_TOKEN
    guildId = env.FLUXER_TEST_GUILD_ID
    const applicationId = env.FLUXER_TEST_APPLICATION_ID
    assert.ok(token && token === token.trim())
    assert.match(guildId ?? "", /^[1-9][0-9]*$/)
    assert.match(applicationId ?? "", /^[1-9][0-9]*$/)
    stage = "sandbox_identity"
    const [application, bot, guild] = await Promise.all([
        api("/oauth2/applications/@me"),
        api("/users/@me"),
        api(`/guilds/${guildId}`),
    ])
    assert.equal(application.id, applicationId)
    assert.equal(bot.bot, true)
    assert.equal(application.bot?.id, bot.id)
    assert.equal(guild.id, guildId)
    botId = bot.id
    assert.match(botId, /^[1-9][0-9]*$/)
    const botMember = await api(`/guilds/${guildId}/members/${botId}`)
    assert.equal(botMember.user?.id, botId)
    const baseline = await api(`/guilds/${guildId}/members?limit=1000`)
    assert.ok(Array.isArray(baseline) && baseline.length > 0 && baseline.length < 1_000)
    report(stage, true, { serverMutations: false })
    const sdk = await import(mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect")
    if (mode === "default") client = await value(sdk.createClient({ token }))
    else {
        scope = Scope.makeUnsafe()
        client = await value(sdk.createClient({ token }).pipe(Scope.provide(scope)))
    }
    watch = observeGateway()
    await value(client.connect())
    await watch.ready()

    stage = "selected_members_and_presences"
    const selected = await consume({ userIds: [botId, absentId], presences: true })
    assert.deepEqual(
        selected.members.map((member) => member.userId),
        [botId],
    )
    assert.equal(selected.members[0].username, botMember.user.username)
    assert.deepEqual([...selected.members[0].roleIds].sort(), [...botMember.roles].sort())
    assert.deepEqual(selected.omittedUserIds, [absentId])
    assert.ok(
        Array.isArray(selected.presences) &&
            selected.presences.every((presence) => presence.userId === botId && presence.guildId === guildId),
    )
    report(stage, true, { visiblePresenceObserved: selected.presences.length > 0 })

    stage = "member_prefix_query"
    const name = botMember.nick ?? botMember.user.global_name ?? botMember.user.username
    assert.ok(typeof name === "string" && name.length > 0)
    const searched = await consume({ query: name, limit: 100 })
    assert.ok(searched.members.some((member) => member.userId === botId))
    assert.equal(searched.presences, undefined)
    report(stage)

    stage = "full_list_readback"
    let full
    for (let attempt = 0; attempt < 2; attempt++) {
        const result = await outcome(consume({ all: true, presences: true }))
        if (result.ok) {
            full = result.value
            break
        }
        expectFailure(result, "rateLimit")
        assert.ok(
            attempt === 0 &&
                Number.isSafeInteger(result.error.retryAfterMs) &&
                result.error.retryAfterMs > 0 &&
                result.error.retryAfterMs <= 30_000,
        )
        // Explicit harness retry of one confirmed full-list rejection, never an SDK retry or a replay of an uncertain request
        await sleep(result.error.retryAfterMs + 100)
    }
    assert.ok(full)
    assert.deepEqual(
        full.members.map((member) => member.userId).sort(),
        baseline.map((member) => member.user.id).sort(),
    )
    report(stage, true, { visiblePresenceObserved: full.presences.length > 0, multiBatchLive: false })

    stage = "repeated_full_list_request"
    let before = watch.count()
    const limited = await outcome(consume({ all: true }))
    if (limited.ok) {
        // Hosting can disable gateway rate limits. Acceptance cannot verify the confirmed-rejection path
        assert.deepEqual(
            limited.value.members.map((member) => member.userId).sort(),
            baseline.map((member) => member.user.id).sort(),
        )
    } else {
        expectFailure(limited, "rateLimit")
        assert.ok(limited.error.retryAfterMs > 0 && limited.error.retryAfterMs <= 30_000)
    }
    assert.equal(watch.count(), before + 1)
    report(stage, true, { singleDispatch: true, confirmedRateLimitObserved: !limited.ok })

    stage = "single_batch_byte_overflow"
    before = watch.count()
    expectFailure(await outcome(consume({ userIds: [botId] }, { maxPendingBytes: 1 })), "overflow")
    assert.equal(watch.count(), before + 1)
    report(stage)

    stage = "dropped_response_timeout"
    before = watch.count()
    watch.drop()
    let pending = outcome(consume({ userIds: [botId] }, { timeoutMs: 5_000 }))
    await watch.waitForDropped()
    expectFailure(await pending, "timeout")
    watch.clearDrop()
    assert.equal(watch.count(), before + 1)
    report(stage, true, { singleDispatch: true })

    stage = "pending_cancellation"
    before = watch.count()
    watch.drop()
    const controller = new AbortController()
    pending = outcome(consume({ userIds: [botId] }, undefined, controller.signal))
    await watch.waitForDropped()
    controller.abort()
    expectFailure(await pending, undefined, mode === "default" ? "CancelledError" : "TestInterrupted")
    watch.clearDrop()
    assert.equal(watch.count(), before + 1)
    report(stage, true, { singleDispatch: true })

    stage = "connection_loss_and_resumed_request"
    before = watch.count()
    watch.drop()
    pending = outcome(consume({ userIds: [botId] }))
    await watch.waitForDropped()
    watch.interrupt()
    expectFailure(await pending, "connectionLost")
    watch.clearDrop()
    await watch.recovered()
    assert.equal(watch.count(), before + 1)
    assert.equal((await consume({ userIds: [botId] })).members[0].userId, botId)
    report(stage, true, { resumed: true, failedRequestNotResent: true })

    stage = "pending_client_closure"
    watch.drop()
    pending = outcome(consume({ userIds: [botId] }))
    await watch.waitForDropped()
    await value(client.shutdown())
    expectFailure(await pending, undefined, "ClientClosedError")
    assert.equal(client.state, "Closed")
    watch.verifyClosed()
    report(stage, true, { socketsClosed: true })
} catch (error) {
    report(stage, false, safeFailure(error))
    process.exitCode = 1
} finally {
    let quiescent = true
    const retainEvidence = (finalizer) => {
        quiescent = false
        report("client_cleanup", false, { finalizer, lockRetained: lock !== undefined })
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
            watch?.verifyClosed()
        } catch {
            retainEvidence("socket_verification")
        }
    watch?.restore()
    if (quiescent && lock !== undefined)
        try {
            assert.equal(readFileSync(lockPath, "utf8"), String(process.pid))
            closeSync(lock)
            unlinkSync(lockPath)
        } catch {
            retainEvidence("sandbox_lock_cleanup")
        }
    if (quiescent) clearTimeout(watchdog)
}
