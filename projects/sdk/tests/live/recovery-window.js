import assert from "node:assert/strict"
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { parseEnv } from "node:util"
import { Cause, Effect, Exit, Scope, Stream } from "effect"
import WebSocket from "ws"

const mode = process.argv[2]
const cycleOffsetsMs = [0, 55_000, 110_000]
const observationWindowMs = 165_000
const recoveryTimeoutMs = 50_000
const delayedHelloMs = 750
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const report = (check, details = {}) => console.log(JSON.stringify({ mode, check, passed: true, ...details }))
let stage = "configuration"
let lock
let client
let driver
let probe
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
    if (Effect.isEffect(operation))
        return fromExit(await Effect.runPromiseExit(/** @type {Effect.Effect<any, any, never>} */ (operation)))
    const result = await operation
    if (result.isErr()) throw result.error
    return result.value
}

async function api(path) {
    const response = await fetch(`https://api.fluxer.app/v1${path}`, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bot ${token}` },
    })
    if (response.status !== 200) {
        await response.body?.cancel()
        throw Error("Sandbox identity request failed")
    }
    return response.json()
}

function safeFailure(error) {
    const known = new Set([
        "ConfigurationError",
        "ConnectionError",
        "ConnectionTimeoutError",
        "MemberChunkError",
        "ClientClosedError",
        "TestInterrupted",
    ])
    return {
        category: known.has(error?._tag) ? error._tag : error?.code === "ERR_ASSERTION" ? "assertion" : "unexpected",
    }
}

async function waitUntil(target, observationStarted) {
    while (performance.now() - observationStarted < target) {
        assert.equal(client.state, "Connected")
        probe.verifyHealthy()
        await sleep(250)
    }
}

function observeGateway() {
    const emitDescriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "emit")
    const sendDescriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "send")
    const originalEmit = WebSocket.prototype.emit
    const originalSend = WebSocket.prototype.send
    const sockets = new Map()
    const delayedFrames = new Set()
    let malformed = false
    let delayRequest

    const recordFor = (socket) => {
        let record = sockets.get(socket)
        if (!record) {
            record = {
                identifies: 0,
                resumes: 0,
                ready: 0,
                resumed: 0,
                heartbeatAcks: 0,
                delayedHello: false,
                delayedHelloDelivered: false,
            }
            sockets.set(socket, record)
        }
        return record
    }

    const verifySocket = (socket) => {
        const url = new URL(socket.url)
        assert.equal(url.protocol, "wss:")
        assert.equal(url.host, "gateway.fluxer.app")
    }

    WebSocket.prototype.send = function (data, ...args) {
        try {
            const frame = JSON.parse(data.toString())
            if ((frame.op === 2 || frame.op === 6) && frame?.d?.token === token) {
                verifySocket(this)
                const record = recordFor(this)
                if (frame.op === 2) record.identifies++
                else record.resumes++
            }
        } catch {
            malformed = true
        }
        return Reflect.apply(originalSend, this, [data, ...args])
    }

    WebSocket.prototype.emit = function (event, ...args) {
        if (event === "open") recordFor(this)
        const record = sockets.get(this)
        if (record && event === "message") {
            let frame
            try {
                // Retain protocol counters only, never credentials, session IDs or event bodies
                frame = JSON.parse(args[0].toString())
                if (frame.op === 0 && frame.t === "READY") record.ready++
                if (frame.op === 0 && frame.t === "RESUMED") record.resumed++
                if (frame.op === 11) record.heartbeatAcks++
            } catch {
                malformed = true
            }
            if (frame?.op === 10 && delayRequest && delayRequest.previous !== this) {
                const request = delayRequest
                delayRequest = undefined
                record.delayedHello = true
                const deferred = Promise.withResolvers()
                const pending = { deferred, timer: undefined }
                pending.timer = setTimeout(() => {
                    delayedFrames.delete(pending)
                    try {
                        Reflect.apply(originalEmit, this, [event, ...args])
                        record.delayedHelloDelivered = true
                    } finally {
                        deferred.resolve(undefined)
                    }
                }, delayedHelloMs)
                delayedFrames.add(pending)
                request.deferred.resolve(record)
                return true
            }
        }
        return Reflect.apply(originalEmit, this, [event, ...args])
    }

    const authenticated = () => [...sockets.entries()].filter(([, record]) => record.identifies + record.resumes === 1)

    return {
        initialSocket() {
            assert.ok(!malformed)
            const entries = authenticated()
            assert.equal(entries.length, 1)
            const [socket, record] = entries[0]
            assert.equal(record.identifies, 1)
            assert.equal(record.ready, 1)
            assert.equal(record.resumes, 0)
            assert.equal(socket.readyState, WebSocket.OPEN)
            return socket
        },
        armHelloDelay(previous) {
            assert.equal(delayRequest, undefined)
            const deferred = Promise.withResolvers()
            delayRequest = { deferred, previous }
            return deferred.promise
        },
        recoveryAfter(previous, expectedSocketCount) {
            assert.ok(!malformed)
            assert.ok(sockets.size <= expectedSocketCount)
            const entries = authenticated().filter(
                ([socket]) => socket !== previous && socket.readyState === WebSocket.OPEN,
            )
            assert.equal(entries.length <= 1, true)
            if (entries.length === 0) return undefined
            const [socket, record] = entries[0]
            const ready =
                (record.resumes === 1 && record.resumed === 1 && record.identifies === 0 && record.ready === 0) ||
                (record.identifies === 1 && record.ready === 1 && record.resumes === 0 && record.resumed === 0)
            return { heartbeatObserved: record.heartbeatAcks > 0, ready, record, socket }
        },
        verifyHealthy(expectedSocketCount) {
            assert.ok(!malformed)
            assert.equal(delayRequest, undefined)
            if (expectedSocketCount !== undefined) assert.equal(sockets.size, expectedSocketCount)
            const open = authenticated().filter(([socket]) => socket.readyState === WebSocket.OPEN)
            assert.equal(open.length, 1)
        },
        async settleDelays() {
            await Promise.all([...delayedFrames].map((pending) => pending.deferred.promise))
            assert.equal(delayedFrames.size, 0)
            assert.equal(delayRequest, undefined)
        },
        cancelDelays() {
            delayRequest?.deferred.resolve(undefined)
            delayRequest = undefined
            for (const pending of delayedFrames) {
                clearTimeout(pending.timer)
                pending.deferred.resolve(undefined)
            }
            delayedFrames.clear()
        },
        verifyClosed() {
            assert.ok(!malformed)
            for (const socket of sockets.keys()) {
                assert.equal(socket.readyState, WebSocket.CLOSED)
                for (const event of ["open", "message", "error", "close"]) assert.equal(socket.listenerCount(event), 0)
            }
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

async function selectedBotStream() {
    const batches = []
    const accept = (chunk) => {
        assert.equal(chunk.guildId, guildId)
        assert.equal(chunk.index, 0)
        assert.equal(chunk.count, 1)
        assert.ok(Object.isFrozen(chunk) && Object.isFrozen(chunk.members))
        assert.equal(chunk.members.length, 1)
        assert.equal(chunk.members[0].userId, botId)
        assert.ok(Object.isFrozen(chunk.members[0]))
        assert.deepEqual(chunk.omittedUserIds, [])
        batches.push(chunk)
    }
    const query = { userIds: [botId] }
    const options = { timeoutMs: 10_000 }
    if (mode === "default") {
        for await (const result of client.members.iterateChunks(guildId, query, options)) {
            if (result.isErr()) throw result.error
            accept(result.value)
        }
    } else
        fromExit(
            await Effect.runPromiseExit(
                client.members
                    .iterateChunks(guildId, query, options)
                    .pipe(Stream.runForEach((chunk) => Effect.sync(() => accept(chunk)))),
            ),
        )
    assert.equal(batches.length, 1)
}

async function verifyPostRecovery(cycle) {
    stage = `cycle_${cycle}_self_read`
    const self = await value(client.users.fetchSelf({ timeoutMs: 10_000 }))
    assert.equal(self.id, botId)
    assert.equal(self.isBot, true)
    report(stage, { freshRead: true })

    stage = `cycle_${cycle}_member_stream`
    await selectedBotStream()
    report(stage, { selectedBotOnly: true })
}

async function createDriver(sdk) {
    if (mode === "default") {
        client = await value(
            sdk.createClient({ token, connection: { startupTimeoutMs: 45_000, maxStartupAttempts: 3 } }),
        )
        return {
            connect: () => value(client.connect()),
            close: () => value(client.shutdown()),
        }
    }

    const scope = Scope.makeUnsafe()
    try {
        client = await value(
            sdk
                .createClient({ token, connection: { startupTimeoutMs: 45_000, maxStartupAttempts: 3 } })
                .pipe(Scope.provide(scope)),
        )
    } catch (error) {
        await Effect.runPromise(Scope.close(scope, Exit.void))
        throw error
    }
    return {
        connect: () => value(client.connect()),
        async close() {
            try {
                if (client.state !== "Closed") await value(client.shutdown())
            } finally {
                await Effect.runPromise(Scope.close(scope, Exit.void))
            }
        },
    }
}

const watchdog = setTimeout(() => {
    console.log(
        JSON.stringify({
            mode,
            check: stage,
            passed: false,
            category: "process_timeout",
            lockRetained: lock !== undefined,
        }),
    )
    process.exit(1)
}, 240_000).unref()

try {
    assert.ok(mode === "default" || mode === "effect")
    assert.equal(process.argv.length, 3)
    stage = "sandbox_lock"
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
    assert.match(bot.id, /^[1-9][0-9]*$/)
    botId = bot.id
    const botMember = await api(`/guilds/${guildId}/members/${botId}`)
    assert.equal(botMember.user?.id, botId)
    report(stage, { clientSecretUsed: false, serverMutations: false })

    probe = observeGateway()
    const sdk = await import(mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect")
    driver = await createDriver(sdk)
    assert.equal(client.state, "Disconnected")

    stage = "connected_baseline"
    await driver.connect()
    assert.equal(client.state, "Connected")
    let activeSocket = probe.initialSocket()
    report(stage, { authenticatedSocketCount: 1 })

    const observationStarted = performance.now()
    for (let index = 0; index < cycleOffsetsMs.length; index++) {
        const cycle = index + 1
        await waitUntil(cycleOffsetsMs[index], observationStarted)
        stage = `cycle_${cycle}_owned_socket_loss`
        assert.equal(activeSocket.readyState, WebSocket.OPEN)
        const delayed = cycle === 2 ? probe.armHelloDelay(activeSocket) : undefined
        activeSocket.terminate()
        report(stage, { testOwnedSocketOnly: true })

        stage = `cycle_${cycle}_recovery`
        const deadline = performance.now() + recoveryTimeoutMs
        let recoveringObserved = false
        let recovered
        while (performance.now() < deadline) {
            recoveringObserved ||= client.state === "Recovering"
            assert.notEqual(client.state, "Closed")
            recovered = probe.recoveryAfter(activeSocket, cycle + 1)
            if (recovered?.ready && recovered.heartbeatObserved && client.state === "Connected") break
            await sleep(5)
        }
        assert.ok(recovered?.ready && recovered.heartbeatObserved)
        assert.ok(recoveringObserved)
        assert.notEqual(recovered.socket, activeSocket)
        assert.equal(activeSocket.readyState, WebSocket.CLOSED)
        assert.ok(Number.isFinite(client.gatewayLatencyMs) && client.gatewayLatencyMs >= 0)
        if (delayed) {
            assert.equal(await delayed, recovered.record)
            await probe.settleDelays()
            assert.equal(recovered.record.delayedHello, true)
            assert.equal(recovered.record.delayedHelloDelivered, true)
        }
        activeSocket = recovered.socket
        probe.verifyHealthy(cycle + 1)
        report(stage, {
            cycle,
            helloDelayMs: cycle === 2 ? delayedHelloMs : 0,
            heartbeatAckObserved: true,
            latencyAvailable: true,
            reidentified: recovered.record.identifies === 1,
            resumed: recovered.record.resumes === 1,
        })
        await verifyPostRecovery(cycle)
    }

    stage = "minimum_observation_window"
    await waitUntil(observationWindowMs, observationStarted)
    assert.ok(performance.now() - observationStarted >= observationWindowMs)
    probe.verifyHealthy(cycleOffsetsMs.length + 1)
    report(stage, { cycles: cycleOffsetsMs.length, minimumElapsedMs: observationWindowMs })
} catch (error) {
    console.log(JSON.stringify({ mode, check: stage, passed: false, ...safeFailure(error) }))
    process.exitCode = 1
} finally {
    let cleanupVerified = false
    try {
        probe?.cancelDelays()
        if (driver) await driver.close()
        if (client) {
            assert.equal(client.state, "Closed")
            probe?.verifyClosed()
            report("client_cleanup", { clientClosed: true, socketsClosed: true, listenersReleased: true })
        }
        cleanupVerified = true
    } catch {
        console.log(JSON.stringify({ mode, check: "client_cleanup", passed: false, category: "cleanup" }))
        process.exitCode = 1
    } finally {
        probe?.restore()
        if (cleanupVerified) clearTimeout(watchdog)
        if (lock !== undefined && cleanupVerified) {
            try {
                assert.equal(readFileSync(lockPath, "utf8"), String(process.pid))
                closeSync(lock)
                lock = undefined
                unlinkSync(lockPath)
                assert.equal(existsSync(lockPath), false)
                report("sandbox_lock_released", { lockVerified: true })
            } catch {
                console.log(JSON.stringify({ mode, check: "sandbox_lock_cleanup", passed: false }))
                process.exitCode = 1
            }
        } else if (lock !== undefined) {
            console.log(
                JSON.stringify({
                    mode,
                    check: "sandbox_lock_retained",
                    passed: false,
                    reason: "cleanup_unverified",
                }),
            )
        }
    }
}
