import assert from "node:assert/strict"
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { parseEnv } from "node:util"
import { Cause, Effect, Exit, Scope, Stream } from "effect"
import WebSocket from "ws"

const mode = process.argv[2]
const totalShards = 2
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const report = (check, passed = true, details = {}) => console.log(JSON.stringify({ mode, check, passed, ...details }))
const skipped = (check, reason) =>
    console.log(JSON.stringify({ mode, check, status: "SKIPPED", skipped: true, reason }))
let stage = "configuration"
let lock
let client
let scope
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
    if (Effect.isEffect(operation)) return fromExit(await Effect.runPromiseExit(operation))
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
        "ShardConnectionError",
        "MemberChunkError",
        "ClientClosedError",
        "TestInterrupted",
    ])
    return {
        category: known.has(error?._tag) ? error._tag : error?.code === "ERR_ASSERTION" ? "assertion" : "unexpected",
    }
}

function shardForGuild(id) {
    return Number((BigInt(id) >> 22n) % BigInt(totalShards))
}

function stateForShard(shardId) {
    const state = client.shards.find((shard) => shard.shardId === shardId)
    assert.ok(state)
    return state.state
}

async function waitFor(predicate, timeoutMs, pollMs = 25) {
    const deadline = performance.now() + timeoutMs
    while (!predicate()) {
        assert.ok(performance.now() < deadline)
        await sleep(pollMs)
    }
}

function observeGateway() {
    const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "send")
    const original = WebSocket.prototype.send
    const sockets = new Map()
    let invalid = false

    const track = (socket, data) => {
        let frame
        try {
            frame = JSON.parse(data.toString())
        } catch {
            return
        }
        if (frame?.d?.token !== token) return

        const url = new URL(socket.url)
        assert.equal(url.protocol, "wss:")
        assert.equal(url.host, "gateway.fluxer.app")
        assert.deepEqual(Object.keys(frame).sort(), ["d", "op"])

        if (frame.op === 2) {
            assert.deepEqual(Object.keys(frame.d).sort(), ["properties", "shard", "token"])
            assert.equal(typeof frame.d.properties, "object")
            assert.ok(Array.isArray(frame.d.shard))
            assert.equal(frame.d.shard.length, 2)
            const [shardId, shardTotal] = frame.d.shard
            assert.ok(Number.isSafeInteger(shardId) && shardId >= 0 && shardId < totalShards)
            assert.equal(shardTotal, totalShards)
            assert.equal(sockets.has(socket), false)
            sockets.set(socket, { shardId, identifies: 1, resumes: 0 })
        } else if (frame.op === 6) {
            assert.deepEqual(Object.keys(frame.d).sort(), ["seq", "session_id", "token"])
            assert.equal(typeof frame.d.session_id, "string")
            assert.ok(Number.isSafeInteger(frame.d.seq) && frame.d.seq >= 0)
            const entry = sockets.get(socket) ?? { shardId: undefined, identifies: 0, resumes: 0 }
            entry.resumes++
            sockets.set(socket, entry)
        } else throw Error("Unexpected authenticated gateway command")
    }

    WebSocket.prototype.send = function (data, ...args) {
        try {
            track(this, data)
        } catch {
            invalid = true
        }
        return Reflect.apply(original, this, [data, ...args])
    }

    const identified = () =>
        [...sockets.entries()]
            .filter(([, entry]) => entry.identifies === 1)
            .map(([socket, entry]) => ({ socket, shardId: entry.shardId }))

    return {
        initialShards() {
            assert.ok(!invalid)
            const entries = identified()
            assert.equal(entries.length, totalShards)
            return entries.map((entry) => entry.shardId).sort((left, right) => left - right)
        },
        identifyCount() {
            assert.ok(!invalid)
            return identified().length
        },
        socketForShard(shardId) {
            assert.ok(!invalid)
            const entries = identified().filter((entry) => entry.shardId === shardId)
            assert.equal(entries.length, 1)
            return entries[0].socket
        },
        recoveryBaseline() {
            assert.ok(!invalid)
            return {
                identifies: [...sockets.values()].reduce((total, entry) => total + entry.identifies, 0),
                resumes: [...sockets.values()].reduce((total, entry) => total + entry.resumes, 0),
            }
        },
        recoverySince(baseline) {
            assert.ok(!invalid)
            const identifies = [...sockets.values()].reduce((total, entry) => total + entry.identifies, 0)
            const resumes = [...sockets.values()].reduce((total, entry) => total + entry.resumes, 0)
            return { resumed: resumes > baseline.resumes, reidentified: identifies > baseline.identifies }
        },
        verifyClosed() {
            assert.ok(!invalid)
            assert.ok([...sockets.keys()].every((socket) => socket.readyState === WebSocket.CLOSED))
        },
        restore() {
            if (descriptor) Object.defineProperty(WebSocket.prototype, "send", descriptor)
            else delete WebSocket.prototype.send
            sockets.clear()
        },
    }
}

async function selectedMemberStream() {
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

async function createDriver(sdk, options) {
    if (mode === "default") {
        const created = sdk.createClient(options)
        assert.ok(created.isOk())
        client = created.value
        return {
            connect: (signal) => client.connect(signal ? { signal } : undefined),
            close: () => value(client.shutdown()),
        }
    }

    scope = Scope.makeUnsafe()
    try {
        client = await value(sdk.createClient(options).pipe(Scope.provide(scope)))
    } catch (error) {
        const currentScope = scope
        scope = undefined
        await Effect.runPromise(Scope.close(currentScope, Exit.void))
        throw error
    }
    return {
        connect: () => client.connect(),
        async close() {
            try {
                if (client.state !== "Closed") await value(client.shutdown())
            } finally {
                if (scope) {
                    const currentScope = scope
                    scope = undefined
                    await Effect.runPromise(Scope.close(currentScope, Exit.void))
                }
            }
        },
    }
}

const watchdog = setTimeout(() => {
    report(stage, false, { category: "process_timeout", lockRetained: lock !== undefined })
    process.exit(1)
}, 120_000).unref()

let driver
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
    report(stage, true, { clientSecretUsed: false, serverMutations: false })

    probe = observeGateway()
    const sdk = await import(mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect")
    driver = await createDriver(sdk, {
        token,
        connection: { startupTimeoutMs: 45_000, maxStartupAttempts: 3 },
        sharding: { totalShards },
    })
    assert.equal(client.state, "Disconnected")

    stage = "two_shard_connection"
    await value(driver.connect())
    assert.equal(client.state, "Connected")
    assert.ok(Object.isFrozen(client.shards))
    assert.deepEqual(
        client.shards.map((shard) => shard.shardId).sort((left, right) => left - right),
        [0, 1],
    )
    assert.ok(client.shards.every((shard) => Object.isFrozen(shard) && shard.state === "Connected"))
    assert.deepEqual(probe.initialShards(), [0, 1])
    report(stage, true, { publicShardsConnected: true })

    const targetShard = shardForGuild(guildId)
    const otherShard = [0, 1].find((shard) => shard !== targetShard)
    assert.ok(otherShard !== undefined)
    assert.equal(stateForShard(targetShard), "Connected")
    assert.equal(stateForShard(otherShard), "Connected")

    stage = "selected_member_stream"
    await selectedMemberStream()
    report(stage, true, { selectedBotOnly: true })

    stage = "target_shard_interruption"
    const baseline = probe.recoveryBaseline()
    const targetSocket = probe.socketForShard(targetShard)
    assert.equal(targetSocket.readyState, WebSocket.OPEN)
    // Terminate only this process's authenticated socket for the shard that owns the verified sandbox guild
    targetSocket.terminate()
    let targetRecoveringObserved = false
    await waitFor(() => {
        targetRecoveringObserved ||= stateForShard(targetShard) === "Recovering"
        assert.equal(stateForShard(otherShard), "Connected")
        const recovery = probe.recoverySince(baseline)
        return recovery.resumed || recovery.reidentified
    }, 45_000)
    report(stage, true, { otherShardHealthy: true, targetRecoveryStateObserved: targetRecoveringObserved })

    stage = "target_shard_recovery"
    await waitFor(() => {
        assert.equal(stateForShard(otherShard), "Connected")
        return client.state === "Connected" && stateForShard(targetShard) === "Connected"
    }, 45_000)
    const recovery = probe.recoverySince(baseline)
    assert.ok(recovery.resumed || recovery.reidentified)
    report(stage, true, { resumeObserved: recovery.resumed, reidentifyObserved: recovery.reidentified })

    stage = "recovered_member_stream"
    await selectedMemberStream()
    report(stage, true, { selectedBotOnly: true })

    // The hosted multi-shard count owner fix is not deployed, so no fallback can establish provider routing
    skipped("count_request_owner", "provider_fix_not_deployed")

    stage = "first_client_cleanup"
    await driver.close()
    assert.equal(client.state, "Closed")
    probe.verifyClosed()
    report(stage, true, { clientClosed: true, socketsClosed: true })
    probe.restore()
    probe = undefined
    driver = undefined
    client = undefined

    stage = "partial_startup_cancellation"
    probe = observeGateway()
    driver = await createDriver(sdk, {
        token,
        cache: { guilds: true },
        connection: { startupTimeoutMs: 45_000, maxStartupAttempts: 3 },
        sharding: { totalShards, shardIds: [targetShard, otherShard] },
    })
    const controller = new AbortController()
    const pending =
        mode === "default"
            ? driver.connect(controller.signal)
            : Effect.runPromiseExit(driver.connect(), { signal: controller.signal })
    await waitFor(
        () => {
            const partialReady = client.shards.some((shard) => shard.state === "Connected")
            const stillStarting =
                client.state === "Connecting" && client.shards.some((shard) => shard.state === "Connecting")
            return probe.identifyCount() === 1 && partialReady && stillStarting
        },
        10_000,
        5,
    )
    const cachedBeforeCancellation = await value(client.guilds.get(guildId))
    controller.abort()
    if (mode === "default") {
        const result = await pending
        assert.ok(result.isErr())
        assert.equal(result.error._tag, "CancelledError")
    } else {
        const exit = await pending
        assert.ok(Exit.isFailure(exit))
        assert.ok(Cause.hasInterruptsOnly(exit.cause))
    }
    await waitFor(() => client.state === "Disconnected", 5_000)
    assert.ok(client.shards.every((shard) => shard.state === "Disconnected"))
    const cachedAfterCancellation = await value(client.guilds.get(guildId))
    assert.equal(cachedAfterCancellation, undefined)
    probe.verifyClosed()
    report(stage, true, {
        partialReadyObserved: true,
        aggregateConnectingObserved: true,
        reusableDisconnected: true,
        socketsClosed: true,
        cacheSnapshotObserved: cachedBeforeCancellation !== undefined,
        preGapSnapshotCleared: cachedBeforeCancellation === undefined ? null : true,
    })
} catch (error) {
    report(stage, false, safeFailure(error))
    process.exitCode = 1
} finally {
    let cleanupVerified = false
    try {
        if (driver) await driver.close()
        else if (scope) {
            const currentScope = scope
            scope = undefined
            await Effect.runPromise(Scope.close(currentScope, Exit.void))
        }
        if (client) {
            assert.equal(client.state, "Closed")
            probe?.verifyClosed()
            report("client_cleanup", true, { clientClosed: true, socketsClosed: true })
        }
        cleanupVerified = true
    } catch {
        report("client_cleanup", false)
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
                report("sandbox_lock_released", true, { lockVerified: true })
            } catch {
                report("sandbox_lock_cleanup", false, { lockVerified: false })
                process.exitCode = 1
            }
        } else if (lock !== undefined) {
            report("sandbox_lock_retained", false, { reason: "cleanup_unverified" })
        }
    }
}
