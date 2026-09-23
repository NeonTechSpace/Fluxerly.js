import assert from "node:assert/strict"
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { parseEnv } from "node:util"
import WebSocket from "ws"

const mode = process.argv[2]
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const report = (check, details = {}) => console.log(JSON.stringify({ mode, check, ...details }))
let stage = "arguments"
let lock
let probe
let active

function observeSockets() {
    const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "emit")
    const original = WebSocket.prototype.emit
    const sockets = new Set()
    WebSocket.prototype.emit = function (event, ...args) {
        if (["open", "message", "error", "close"].includes(event)) sockets.add(this)
        return Reflect.apply(original, this, [event, ...args])
    }
    return {
        sockets,
        async interrupt(client) {
            assert.equal(client.state, "Connected")
            const open = [...sockets].filter((socket) => socket.readyState === WebSocket.OPEN)
            assert.equal(open.length, 1)
            const url = new URL(open[0].url)
            assert.equal(url.protocol, "wss:")
            assert.equal(url.host, "gateway.fluxer.app")
            // This is the SDK-owned socket created by this harness, not a host or service interruption
            open[0].terminate()
            await until(() => client.state === "Recovering", 5000)
            assert.equal(client.gatewayLatencyMs, null)
        },
        async verifyClosed() {
            const count = sockets.size
            assert.ok(count >= 1)
            await sleep(1100)
            assert.equal(sockets.size, count)
            for (const socket of sockets) {
                assert.equal(socket.readyState, WebSocket.CLOSED)
                for (const event of ["open", "message", "error", "close"]) assert.equal(socket.listenerCount(event), 0)
            }
        },
        restore() {
            if (descriptor) Object.defineProperty(WebSocket.prototype, "emit", descriptor)
            else delete WebSocket.prototype.emit
        },
    }
}

async function until(predicate, timeoutMs) {
    const deadline = performance.now() + timeoutMs
    while (!predicate()) {
        assert.ok(performance.now() < deadline)
        await sleep(10)
    }
}

async function get(path, token) {
    const response = await fetch(`https://api.fluxer.app/v1${path}`, {
        headers: { Authorization: `Bot ${token}` },
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
    })
    if (!response.ok) {
        await response.body?.cancel()
        throw new Error("Identity request failed")
    }
    return response.json()
}

function assertReleased(client, listeners) {
    assert.equal(client.state, "Closed")
    assert.equal(client.gatewayLatencyMs, null)
    for (const signal of ["SIGINT", "SIGTERM"]) assert.equal(process.listenerCount(signal), listeners[signal])
}

async function checkDefault(token, userId) {
    const { runBot } = await import("@neontechspace/fluxerly")
    const listeners = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") }
    for (const scenario of ["cancel_recovery", "critical_close"]) {
        stage = scenario
        let client
        let subscription
        const controller = new AbortController()
        const running = runBot(
            { token },
            (created) => {
                client = created
                const opened = created.on("messageCreate", () => undefined)
                if (opened.isErr()) throw opened.error
                subscription = opened.value
                return [subscription]
            },
            { signal: controller.signal, processSignals: true },
        )
        active = { controller, running }
        try {
            await until(() => client?.state === "Connected", 35_000)
            stage = `${scenario}_fresh_self_read`
            const self = await client.users.fetchSelf({ timeoutMs: 10_000 })
            assert.ok(self.isOk())
            assert.equal(self.value.id, userId)
            assert.equal(self.value.isBot, true)
            report(stage, { passed: true, remoteMutations: false })
            stage = scenario
            if (scenario === "cancel_recovery") {
                await probe.interrupt(client)
                report("recovering_before_cancellation", { passed: true })
                controller.abort()
                const result = await running
                assert.ok(result.isOk())
            } else {
                subscription.unsubscribe()
                const result = await running
                assert.ok(result.isErr())
                assert.equal(result.error._tag, "CriticalWorkerStoppedError")
                assert.equal(result.error.workerIndex, 0)
            }
            assertReleased(client, listeners)
            report(stage, { passed: true })
        } finally {
            controller.abort()
            await Promise.resolve(running).catch(() => undefined)
            active = undefined
        }
    }
}

async function checkEffect(token, userId) {
    const { Effect, Exit } = await import("effect")
    const { runBot } = await import("@neontechspace/fluxerly/effect")
    const listeners = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") }
    for (const scenario of ["cancel_recovery", "critical_close"]) {
        stage = scenario
        let client
        let subscription
        const controller = new AbortController()
        const running = Effect.runPromiseExit(
            runBot(
                { token },
                (created) =>
                    Effect.gen(function* () {
                        client = created
                        subscription = yield* created.on("messageCreate", () => Effect.void)
                        return [subscription]
                    }),
                { signal: controller.signal, processSignals: true },
            ),
        )
        active = { controller, running }
        try {
            await until(() => client?.state === "Connected", 35_000)
            stage = `${scenario}_fresh_self_read`
            const self = await Effect.runPromise(client.users.fetchSelf({ timeoutMs: 10_000 }))
            assert.equal(self.id, userId)
            assert.equal(self.isBot, true)
            report(stage, { passed: true, remoteMutations: false })
            stage = scenario
            if (scenario === "cancel_recovery") {
                await probe.interrupt(client)
                report("recovering_before_cancellation", { passed: true })
                controller.abort()
                assert.ok(Exit.isSuccess(await running))
            } else {
                await Effect.runPromise(subscription.unsubscribe())
                const exit = await running
                assert.ok(Exit.isFailure(exit))
                assert.ok(
                    exit.cause.reasons.some(
                        (reason) =>
                            reason._tag === "Fail" &&
                            reason.error?._tag === "CriticalWorkerStoppedError" &&
                            reason.error.workerIndex === 0,
                    ),
                )
            }
            assertReleased(client, listeners)
            report(stage, { passed: true })
        } finally {
            controller.abort()
            await running
            active = undefined
        }
    }
}

async function checkSimple(token, userId, guildId) {
    const { Effect, Exit } = await import("effect")
    const { runBot } = await import(mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect")
    const listeners = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") }
    const controller = new AbortController()
    let client
    const capture = (context) => {
        if (context.event.id === guildId) client = context.client
    }
    const run = runBot({
        token,
        signal: controller.signal,
        processSignals: true,
        events: {
            guildCreate: mode === "default" ? capture : (context) => Effect.sync(() => capture(context)),
        },
    })
    const running = mode === "default" ? Promise.resolve(run) : Effect.runPromiseExit(run)
    active = { controller, running }
    try {
        stage = "simple_sandbox_event"
        await until(() => client?.state === "Connected", 35_000)
        report(stage, { passed: true, remoteMutations: false })
        stage = "simple_fresh_self_read"
        const fetched =
            mode === "default"
                ? await client.users.fetchSelf({ timeoutMs: 10_000 })
                : await Effect.runPromise(client.users.fetchSelf({ timeoutMs: 10_000 }))
        if (mode === "default") assert.ok(fetched.isOk())
        assert.equal((mode === "default" ? fetched.value : fetched).id, userId)
        report(stage, { passed: true, remoteMutations: false })
        stage = "simple_cancel_recovery"
        await probe.interrupt(client)
        controller.abort()
        const result = await running
        assert.ok(mode === "default" ? result.isOk() : Exit.isSuccess(result))
        assertReleased(client, listeners)
        report(stage, { passed: true })
    } finally {
        controller.abort()
        await running.catch(() => undefined)
        active = undefined
    }
}

// Failure containment only. Natural process exit, not the watchdog, proves cleanup
setTimeout(() => {
    report("process_timeout", { passed: false, cleanExitVerified: false })
    process.exit(1)
}, 120_000).unref()

try {
    assert.ok(mode === "default" || mode === "effect")
    assert.equal(process.argv[3], undefined)
    stage = "sandbox_lock"
    lock = openSync(lockPath, "wx")
    writeSync(lock, String(process.pid))
    stage = "configuration"
    const env = parseEnv(readFileSync(new URL("../../.env.test.local", import.meta.url), "utf8"))
    const token = env.FLUXER_TEST_BOT_TOKEN
    const applicationId = env.FLUXER_TEST_APPLICATION_ID
    const guildId = env.FLUXER_TEST_GUILD_ID
    assert.ok(token && token === token.trim())
    assert.match(applicationId ?? "", /^\d+$/)
    assert.match(guildId ?? "", /^\d+$/)
    stage = "sandbox_identity"
    const application = await get("/oauth2/applications/@me", token)
    const user = await get("/users/@me", token)
    assert.equal(application.id, applicationId)
    assert.equal(user.bot, true)
    assert.equal(typeof user.id, "string")
    assert.equal(application.bot?.id, user.id)
    assert.equal((await get(`/guilds/${guildId}`, token)).id, guildId)
    report(stage, { passed: true, remoteMutations: false })
    probe = observeSockets()
    if (mode === "default") await checkDefault(token, user.id)
    else await checkEffect(token, user.id)
    await checkSimple(token, user.id, guildId)
    stage = "socket_cleanup"
    await probe.verifyClosed()
    report(stage, { passed: true })
} catch {
    // Assertions, native causes, HTTP bodies and credentials must not reach logs
    report(stage, { passed: false })
    process.exitCode = 1
} finally {
    active?.controller.abort()
    if (active) await Promise.resolve(active.running).catch(() => undefined)
    probe?.restore()
    if (lock !== undefined) {
        closeSync(lock)
        unlinkSync(lockPath)
    }
}
