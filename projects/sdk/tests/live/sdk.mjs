import assert from "node:assert/strict"
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"
import { parseEnv } from "node:util"
import WebSocket from "ws"

const mode = process.argv[2]
const cancelRecovery = process.argv[3] === "--cancel-recovery"
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const report = (check, details = {}) => console.log(JSON.stringify({ mode, check, ...details }))
let stage = "configuration"
let lock
let gatewayProbe

function observeGateway() {
    const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "emit")
    const original = WebSocket.prototype.emit
    const sockets = new Set()
    WebSocket.prototype.emit = function (event, ...args) {
        if (["open", "message", "error", "close"].includes(event)) sockets.add(this)
        return Reflect.apply(original, this, [event, ...args])
    }
    return {
        async interrupt(client) {
            stage = "interrupt_for_cancellation"
            assert.equal(client.state, "Connected")
            assert.equal(sockets.size, 1)
            const [socket] = sockets
            const url = new URL(socket.url)
            assert.equal(url.protocol, "wss:")
            assert.equal(url.host, "gateway.fluxer.app")
            // Terminate only this process's authenticated SDK connection, not the server or host network
            socket.terminate()
            const deadline = performance.now() + 5000
            while (client.state !== "Recovering") {
                assert.ok(client.state !== "Closed" && performance.now() < deadline)
                await sleep(1)
            }
            assert.equal(client.gatewayLatencyMs, null)
            report("recovering_before_cancellation", { passed: true })
        },
        async verifyClosed() {
            const count = sockets.size
            assert.ok(count >= 1)
            // Cover the initial retry ceiling, then require the process to exit naturally
            await sleep(1100)
            assert.equal(sockets.size, count)
            for (const socket of sockets) {
                assert.equal(socket.readyState, WebSocket.CLOSED)
                for (const event of ["open", "message", "error", "close"]) assert.equal(socket.listenerCount(event), 0)
            }
            report("cancelled_recovery_sockets_released", { passed: true })
        },
        restore() {
            if (descriptor) Object.defineProperty(WebSocket.prototype, "emit", descriptor)
            else delete WebSocket.prototype.emit
            sockets.clear()
        },
    }
}

async function waitForReady(client) {
    const deadline = performance.now() + 35_000
    while (client.state !== "Connected") {
        assert.ok(client.state !== "Closed" && performance.now() < deadline)
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

async function observeHeartbeat(client) {
    stage = "heartbeat"
    const deadline = performance.now() + 65_000
    while (client.gatewayLatencyMs === null) {
        assert.equal(client.state, "Connected")
        assert.ok(performance.now() < deadline)
        await sleep(100)
    }
    assert.ok(Number.isFinite(client.gatewayLatencyMs) && client.gatewayLatencyMs >= 0)
    report(stage, { passed: true, latencyMs: client.gatewayLatencyMs })
}

// A watchdog is failure containment, never evidence of successful cleanup
// Keep it unreferenced so a successful check must exit naturally
setTimeout(() => {
    report("process_timeout", { passed: false, cleanExitVerified: false })
    process.exit(1)
}, 120_000).unref()

try {
    assert.ok(mode === "default" || mode === "effect")
    assert.ok(process.argv[3] === undefined || cancelRecovery)
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
    const application = await get("/applications/@me", token)
    const user = await get("/users/@me", token)
    assert.equal(application.id, applicationId)
    assert.equal(user.bot, true)
    assert.equal(typeof user.id, "string")
    assert.equal(application.bot?.id, user.id)
    assert.equal((await get(`/guilds/${guildId}`, token)).id, guildId)
    report(stage, { passed: true, clientSecretUsed: false })
    if (cancelRecovery) gatewayProbe = observeGateway()

    let client
    if (mode === "default") {
        const { createClient } = await import("@neontechspace/fluxerly")
        stage = "creation"
        const created = createClient({ token })
        assert.ok(created.isOk())
        client = created.value
        assert.equal(client.state, "Disconnected")
        const controller = new AbortController()
        let running
        try {
            stage = "connect"
            if (cancelRecovery) {
                // Capture defects immediately without printing a credential-bearing rejection
                running = Promise.resolve(client.run({ signal: controller.signal })).then(
                    (result) => ({ result }),
                    () => ({ defect: true }),
                )
                await waitForReady(client)
            } else assert.ok((await client.connect()).isOk())
            assert.equal(client.state, "Connected")
            report("ready", { passed: true })
            await observeHeartbeat(client)
            if (cancelRecovery) {
                await gatewayProbe.interrupt(client)
                stage = "managed_recovery_cancellation"
                controller.abort()
                const outcome = await running
                assert.ok(outcome.result?.isErr())
                assert.equal(outcome.result.error._tag, "CancelledError")
                // Verify cancellation-owned closure before the fallback shutdown in finally
                assert.equal(client.state, "Closed")
                report(stage, { passed: true })
            }
        } finally {
            const previous = stage
            stage = "shutdown"
            assert.ok((await client.shutdown()).isOk())
            stage = previous
        }
        stage = "terminal_outcome"
        assert.ok((await client.waitForClose()).isOk())
    } else {
        const { Cause, Effect, Exit, Fiber } = await import("effect")
        const { createClient } = await import("@neontechspace/fluxerly/effect")
        const exit = await Effect.runPromiseExit(
            Effect.scoped(
                Effect.gen(function* () {
                    stage = "creation"
                    client = yield* createClient({ token })
                    assert.equal(client.state, "Disconnected")
                    stage = "connect"
                    const running = cancelRecovery ? yield* Effect.forkScoped(client.run()) : undefined
                    if (cancelRecovery) yield* Effect.promise(() => waitForReady(client))
                    else yield* client.connect()
                    assert.equal(client.state, "Connected")
                    report("ready", { passed: true })
                    yield* Effect.promise(() => observeHeartbeat(client))
                    if (cancelRecovery) {
                        yield* Effect.promise(() => gatewayProbe.interrupt(client))
                        stage = "managed_recovery_cancellation"
                        yield* Fiber.interrupt(running)
                        const outcome = yield* Effect.exit(Fiber.join(running))
                        assert.ok(Exit.isFailure(outcome) && Cause.hasInterruptsOnly(outcome.cause))
                        // The managed run, rather than the enclosing scope, must have finished cleanup
                        assert.equal(client.state, "Closed")
                        report(stage, { passed: true })
                    }
                    stage = "scope_shutdown"
                }),
            ),
        )
        assert.ok(Exit.isSuccess(exit))
        stage = "terminal_outcome"
        assert.ok(Exit.isSuccess(await Effect.runPromiseExit(client.waitForClose())))
    }
    assert.equal(client.state, "Closed")
    assert.equal(client.gatewayLatencyMs, null)
    if (cancelRecovery) {
        stage = "cancelled_recovery_cleanup"
        await gatewayProbe.verifyClosed()
    }
    report("closed", { passed: true, latencyReset: true })
} catch {
    // Do not print assertions, native causes, HTTP bodies or credential-bearing errors
    report(stage, { passed: false })
    process.exitCode = 1
} finally {
    gatewayProbe?.restore()
    if (lock !== undefined) {
        closeSync(lock)
        unlinkSync(lockPath)
    }
}
// No success-path process.exit: The invoking shell must observe natural exit
