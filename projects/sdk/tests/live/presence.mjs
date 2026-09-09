import assert from "node:assert/strict"
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { parseEnv } from "node:util"

const mode = process.argv[2]
// A stored participant is not current authorization for an interactive check
const targetId = process.env.FLUXER_TEST_PRESENCE_USER_ID
const restoreStatus = process.env.FLUXER_TEST_PRESENCE_RESTORE_STATUS
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
let stage = "configuration"
let lock
let driver
let probe
let selectedGuildId
let handlerFailed = false
const report = (check, details = {}) => console.log(JSON.stringify({ mode, check, passed: true, ...details }))

async function api(path, token) {
    const response = await fetch(`https://api.fluxer.app/v1${path}`, {
        headers: { Authorization: `Bot ${token}` },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
        await response.body?.cancel()
        throw new Error("Sandbox identity request failed")
    }
    return response.json()
}

async function waitFor(read, timeoutMs, recovering = false) {
    const deadline = performance.now() + timeoutMs
    while (!read()) {
        assert.ok(!handlerFailed && !probe.invalid)
        assert.ok(driver.client.state !== "Closed" && performance.now() < deadline)
        if (!recovering) assert.equal(driver.client.state, "Connected")
        await sleep(25)
    }
    assert.ok(!handlerFailed && !probe.invalid)
}

async function createDriver(token) {
    const options = { maxPendingMessages: 16, maxPendingBytes: 65_536 }
    if (mode === "default") {
        const { createClient } = await import("@neontechspace/fluxerly")
        const value = (result) => {
            if (result.isErr()) throw result.error
            return result.value
        }
        const client = value(createClient({ token }))
        return {
            client,
            on: (event, receive) =>
                value(
                    client.on(event, receive, {
                        ...options,
                        onError: () => {
                            handlerFailed = true
                        },
                    }),
                ),
            set: (guildId, ids) => value(client.presence.setMembers(guildId, ids)),
            connect: async () => value(await client.connect()),
            close: async () => value(await client.shutdown()),
        }
    }
    const { Effect, Exit, Scope } = await import("effect")
    const { createClient } = await import("@neontechspace/fluxerly/effect")
    const scope = Scope.makeUnsafe()
    const value = async (operation) => {
        const result = await Effect.runPromise(Effect.result(operation))
        if (result._tag === "Failure") throw result.failure
        return result.success
    }
    let client
    try {
        client = await value(createClient({ token }).pipe(Scope.provide(scope)))
    } catch (error) {
        await Effect.runPromise(Scope.close(scope, Exit.void))
        throw error
    }
    return {
        client,
        on: (event, receive) =>
            value(
                client
                    .on(event, (item) => Effect.sync(() => receive(item)), {
                        ...options,
                        onError: () =>
                            Effect.sync(() => {
                                handlerFailed = true
                            }),
                    })
                    .pipe(Scope.provide(scope)),
            ),
        set: (guildId, ids) => value(client.presence.setMembers(guildId, ids)),
        connect: () => value(client.connect()),
        close: async () => {
            try {
                await value(client.shutdown())
            } finally {
                await Effect.runPromise(Scope.close(scope, Exit.void))
            }
        },
    }
}

async function observeGateway(guildId) {
    const { default: WebSocket } = await import("ws")
    const emitDescriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "emit")
    const sendDescriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "send")
    const originalEmit = WebSocket.prototype.emit
    const originalSend = WebSocket.prototype.send
    const sockets = new Map()
    let invalid = false
    const state = (socket) => {
        let entry = sockets.get(socket)
        if (!entry) {
            assert.ok(sockets.size < 2)
            const url = new URL(socket.url)
            assert.equal(url.protocol, "wss:")
            assert.equal(url.host, "gateway.fluxer.app")
            entry = { ready: 0, resumed: 0, selected: 0, cleared: 0 }
            sockets.set(socket, entry)
        }
        return entry
    }
    WebSocket.prototype.emit = function (event, ...args) {
        try {
            if (["open", "message", "close", "error"].includes(event)) {
                const entry = state(this)
                if (event === "message") {
                    const packet = JSON.parse(args[0].toString())
                    if (packet.t === "READY") entry.ready++
                    if (packet.t === "RESUMED") entry.resumed++
                }
            }
        } catch {
            invalid = true
        }
        return Reflect.apply(originalEmit, this, [event, ...args])
    }
    WebSocket.prototype.send = function (data, ...args) {
        try {
            const packet = JSON.parse(data.toString())
            if (packet.op === 14) {
                assert.ok(Buffer.byteLength(data.toString()) <= 4096)
                const selections = packet.d.subscriptions
                assert.deepEqual(Object.keys(selections), [guildId])
                const ids = selections[guildId].members
                assert.ok(Array.isArray(ids))
                const entry = state(this)
                if (ids.length === 0) entry.cleared++
                else {
                    assert.deepEqual(ids, [targetId])
                    entry.selected++
                }
                assert.ok(entry.selected + entry.cleared <= 20)
            }
        } catch {
            invalid = true
        }
        return Reflect.apply(originalSend, this, [data, ...args])
    }
    return {
        get invalid() {
            return invalid
        },
        get entries() {
            return [...sockets.values()]
        },
        interrupt() {
            assert.equal(sockets.size, 1)
            const [socket, entry] = [...sockets][0]
            assert.equal(entry.ready, 1)
            assert.equal(entry.resumed, 0)
            assert.ok(entry.selected > 0 && !invalid)
            // Terminate only this process's observed SDK socket, not the host network or another client
            socket.terminate()
        },
        verifyClosed() {
            for (const socket of sockets.keys()) {
                assert.equal(socket.readyState, WebSocket.CLOSED)
                for (const event of ["open", "message", "error", "close"]) assert.equal(socket.listenerCount(event), 0)
            }
            assert.ok(!invalid)
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

// Containment for a missing human transition, not proof of cleanup
const watchdog = setTimeout(() => {
    console.error(JSON.stringify({ mode, check: stage, passed: false, reason: "deadline", cleanExitVerified: false }))
    process.exit(1)
}, 480_000).unref()

try {
    assert.ok(mode === "default" || mode === "effect")
    assert.equal(process.argv.length, 3)
    assert.match(targetId ?? "", /^[1-9][0-9]{0,19}$/)
    assert.ok(restoreStatus === undefined || ["online", "idle", "dnd", "offline"].includes(restoreStatus))
    const env = parseEnv(readFileSync(new URL("../../.env.test.local", import.meta.url), "utf8"))
    const token = env.FLUXER_TEST_BOT_TOKEN
    const guildId = env.FLUXER_TEST_GUILD_ID
    assert.ok(token && token === token.trim())
    assert.match(guildId ?? "", /^[1-9][0-9]{0,19}$/)
    assert.match(env.FLUXER_TEST_APPLICATION_ID ?? "", /^[1-9][0-9]{0,19}$/)
    stage = "sandbox_lock"
    lock = openSync(lockPath, "wx")
    writeSync(lock, String(process.pid))
    stage = "sandbox_identity"
    const [application, bot, guild, member] = await Promise.all([
        api("/oauth2/applications/@me", token),
        api("/users/@me", token),
        api(`/guilds/${guildId}`, token),
        api(`/guilds/${guildId}/members/${targetId}`, token),
    ])
    assert.equal(application.id, env.FLUXER_TEST_APPLICATION_ID)
    assert.equal(application.bot?.id, bot.id)
    assert.equal(bot.bot, true)
    assert.equal(guild.id, guildId)
    assert.equal(member.user.id, targetId)
    assert.notEqual(member.user.id, bot.id)
    assert.notEqual(member.user.bot, true)
    report(stage, { guildId, targetId })
    probe = await observeGateway(guildId)
    driver = await createDriver(token)
    let available = false
    let latest
    let initialStatusReported = false
    await driver.on("guildCreate", (value) => {
        if (value.id === guildId) available = true
    })
    await driver.on("presenceUpdate", (value) => {
        if (value.guildId !== guildId || value.userId !== targetId) return
        assert.ok(Object.isFrozen(value))
        assert.deepEqual(Object.keys(value).sort(), ["afk", "guildId", "mobile", "status", "userId"])
        assert.equal(typeof value.mobile, "boolean")
        assert.equal(typeof value.afk, "boolean")
        latest = value.status
        if (!initialStatusReported) {
            initialStatusReported = true
            report("initial_presence_observed", {
                status: ["online", "idle", "dnd", "offline"].includes(value.status) ? value.status : "unrecognized",
            })
        }
    })
    stage = "connect_and_target_availability"
    await driver.connect()
    await waitFor(() => available, 15_000)
    selectedGuildId = guildId
    await driver.set(guildId, [targetId])
    await waitFor(() => probe.entries[0]?.selected > 0, 5_000)
    stage = "await_online_baseline"
    report(stage, { requestedStatus: "online" })
    await waitFor(() => latest === "online", 90_000)
    stage = "await_dnd_transition"
    report(stage, { requestedStatus: "dnd" })
    await waitFor(() => latest === "dnd", 90_000)
    report("selected_member_transition", { status: "dnd", frozen: true })
    stage = "socket_resume_and_selection_restore"
    probe.interrupt()
    await waitFor(
        () => {
            const next = probe.entries[1]
            assert.ok(next === undefined || next.ready === 0)
            return next?.resumed === 1 && next.selected > 0 && driver.client.state === "Connected"
        },
        45_000,
        true,
    )
    assert.equal(probe.entries.length, 2)
    report(stage, { freshIdentify: false })
    latest = undefined
    stage = "await_post_resume_online_transition"
    report(stage, { requestedStatus: "online" })
    await waitFor(() => latest === "online", 90_000)
    report("post_resume_selected_member_transition", { status: "online", frozen: true })
    if (restoreStatus !== undefined) {
        stage = "await_original_status_restoration"
        report(stage, { requestedStatus: restoreStatus })
        await waitFor(() => latest === restoreStatus, 90_000)
        report("original_status_restored", { status: restoreStatus })
    }
} catch {
    // Do not print assertions, native causes, private payloads or credential-bearing errors
    console.error(JSON.stringify({ mode, check: stage, passed: false }))
    process.exitCode = 1
} finally {
    try {
        if (driver) {
            if (driver.client.state === "Connected" && selectedGuildId) {
                await driver.set(selectedGuildId, [])
                await waitFor(() => probe.entries.at(-1)?.cleared > 0, 5_000)
                report("clear_selection_sent", { acknowledged: false })
            }
        }
    } catch {
        console.error(JSON.stringify({ mode, check: "clear_selection", passed: false }))
        process.exitCode = 1
    } finally {
        try {
            if (driver) {
                await driver.close()
                assert.equal(driver.client.state, "Closed")
                probe.verifyClosed()
                report("sdk_and_sockets_closed")
            }
        } catch {
            console.error(JSON.stringify({ mode, check: "sdk_cleanup", passed: false }))
            process.exitCode = 1
        } finally {
            probe?.restore()
            clearTimeout(watchdog)
            if (lock !== undefined) {
                closeSync(lock)
                unlinkSync(lockPath)
            }
        }
    }
}
