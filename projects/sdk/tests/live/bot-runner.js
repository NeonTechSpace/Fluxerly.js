// Public bot runner lifecycle: synchronous misuse rejection, cancellation during recovery of its own interrupted
// gateway connection, setup failure and the simple event path, each with client, socket and signal-listener release.
// Read-only. Creates no journal and no remote resources
import assert from "node:assert/strict"
import { setTimeout as sleep } from "node:timers/promises"
import WebSocket from "ws"
import { acquireLock, loadSandboxEnvironment, verifySandboxIdentity } from "./support/harness.js"
import { createReporter } from "./support/reporting.js"
import { readSandbox } from "./support/sandbox-api.js"

const mode = process.argv[2]
const report = createReporter({ mode })
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

const get = (path, token) => readSandbox(path, token, { timeout: 10_000 })

function assertReleased(client, listeners) {
    assert.equal(client.state, "Closed")
    assert.equal(client.gatewayLatencyMs, null)
    for (const signal of ["SIGINT", "SIGTERM"]) assert.equal(process.listenerCount(signal), listeners[signal])
}

function assertSignalListeners(listeners) {
    for (const signal of ["SIGINT", "SIGTERM"]) assert.equal(process.listenerCount(signal), listeners[signal])
}

async function checkDefault(token, userId) {
    const { ApplicationError, ConfigurationError, runBot } = await import("@neontechspace/fluxerly")
    const listeners = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") }

    stage = "configuration_misuse"
    // A missing token is reported as the run's failure, and other misuse throws synchronously, both before any socket
    // or process signal listener exists
    const socketsBeforeMisuse = probe.sockets.size
    const missingToken = await runBot({ token: "", processSignals: true })
    assert.ok(missingToken.isErr() && missingToken.error instanceof ConfigurationError)
    // runBot reports the failed run through the exit code. The failure is test-owned, so the check clears it
    assert.equal(process.exitCode, 1)
    process.exitCode = undefined
    assert.throws(
        () => runBot({ token, processSignals: true, events: { notAnEvent: () => undefined } }),
        (error) => error instanceof ConfigurationError,
    )
    assert.equal(probe.sockets.size, socketsBeforeMisuse)
    assertSignalListeners(listeners)
    report(stage, { passed: true, remoteMutations: false })

    stage = "cancel_recovery"
    let client
    let stateAtSetup
    const controller = new AbortController()
    const running = runBot({
        token,
        signal: controller.signal,
        processSignals: true,
        events: { messageCreate: () => undefined },
        commands: { prefix: "!", commands: { ping: { execute: ({ reply }) => reply("Pong") } } },
        setup: (created) => {
            client = created
            stateAtSetup = created.state
        },
    })
    active = { controller, running }
    try {
        await until(() => client?.state === "Connected", 35_000)
        // Setup runs after registration and before the gateway connects
        assert.equal(stateAtSetup, "Disconnected")
        stage = "cancel_recovery_fresh_self_read"
        const self = await client.users.fetchSelf({ timeoutMs: 10_000 })
        assert.ok(self.isOk())
        assert.equal(self.value.id, userId)
        assert.equal(self.value.isBot, true)
        report(stage, { passed: true, remoteMutations: false })
        stage = "cancel_recovery"
        await probe.interrupt(client)
        report("recovering_before_cancellation", { passed: true })
        controller.abort()
        const result = await running
        assert.ok(result.isOk())
        assertReleased(client, listeners)
        report(stage, { passed: true })
    } finally {
        controller.abort()
        await Promise.resolve(running).catch(() => undefined)
        active = undefined
    }

    stage = "setup_failure"
    // The earlier runs stopped cleanly, so no failing exit code may be set before the deliberate failure
    assert.equal(process.exitCode, undefined)
    let failed
    const failure = new Error("Test-owned setup failure")
    const socketsBeforeSetup = probe.sockets.size
    const setupController = new AbortController()
    const failing = runBot({
        token,
        signal: setupController.signal,
        processSignals: true,
        events: { messageCreate: () => undefined },
        setup: (created) => {
            failed = created
            throw failure
        },
    })
    active = { controller: setupController, running: failing }
    try {
        // A failed setup is an application failure returned as Err, not an SDK defect
        const outcome = await failing
        assert.ok(outcome.isErr())
        assert.ok(outcome.error instanceof ApplicationError)
        assert.equal(outcome.error.source, "runBot setup")
        assert.equal(outcome.error.cause, failure)
        // runBot reports the failed run through the exit code. The failure is test-owned, so the check clears it
        assert.equal(process.exitCode, 1)
        process.exitCode = undefined
        // A failed setup stops the bot before it connects and still releases the client and signal listeners
        assertReleased(failed, listeners)
        assert.equal(probe.sockets.size, socketsBeforeSetup)
        report(stage, { passed: true, remoteMutations: false })
    } finally {
        setupController.abort()
        await Promise.resolve(failing).catch(() => undefined)
        active = undefined
    }
}

async function checkEffect(token, userId) {
    const { Effect, Exit } = await import("effect")
    const { ApplicationError, ConfigurationError, runBot } = await import("@neontechspace/fluxerly/effect")
    const listeners = { SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") }
    const defects = (exit) =>
        Exit.isFailure(exit)
            ? exit.cause.reasons.filter((reason) => reason._tag === "Die").map(({ defect }) => defect)
            : []
    const failures = (exit) =>
        Exit.isFailure(exit)
            ? exit.cause.reasons.filter((reason) => reason._tag === "Fail").map(({ error }) => error)
            : []

    stage = "configuration_misuse"
    // A missing token is a typed failure and other native misuse is a defect, both carrying the ConfigurationError, and
    // no socket or signal listener is left behind
    const socketsBeforeMisuse = probe.sockets.size
    for (const [options, reasons] of [
        [{ token: "", processSignals: true }, failures],
        [{ token, processSignals: true, events: { notAnEvent: () => Effect.void } }, defects],
    ]) {
        const exit = await Effect.runPromiseExit(runBot(options))
        assert.ok(reasons(exit).some((reason) => reason instanceof ConfigurationError))
        // The Effect runner reports a failure before the client exists and sets a failing exit code
        assert.equal(process.exitCode, 1)
        process.exitCode = undefined
    }
    assert.equal(probe.sockets.size, socketsBeforeMisuse)
    assertSignalListeners(listeners)
    report(stage, { passed: true, remoteMutations: false })

    stage = "cancel_recovery"
    let client
    let stateAtSetup
    const controller = new AbortController()
    const running = Effect.runPromiseExit(
        runBot({
            token,
            signal: controller.signal,
            processSignals: true,
            events: { messageCreate: () => Effect.void },
            commands: { prefix: "!", commands: { ping: { execute: ({ reply }) => reply("Pong") } } },
            setup: (created) =>
                Effect.sync(() => {
                    client = created
                    stateAtSetup = created.state
                }),
        }),
    )
    active = { controller, running }
    try {
        await until(() => client?.state === "Connected", 35_000)
        // Setup runs after registration and before the gateway connects
        assert.equal(stateAtSetup, "Disconnected")
        stage = "cancel_recovery_fresh_self_read"
        const self = await Effect.runPromise(client.users.fetchSelf({ timeoutMs: 10_000 }))
        assert.equal(self.id, userId)
        assert.equal(self.isBot, true)
        report(stage, { passed: true, remoteMutations: false })
        stage = "cancel_recovery"
        await probe.interrupt(client)
        report("recovering_before_cancellation", { passed: true })
        controller.abort()
        assert.ok(Exit.isSuccess(await running))
        assertReleased(client, listeners)
        report(stage, { passed: true })
    } finally {
        controller.abort()
        await running
        active = undefined
    }

    stage = "setup_failure"
    // The earlier runs stopped cleanly, so no failing exit code may be set before the deliberate failure
    assert.equal(process.exitCode, undefined)
    let failed
    const failure = new Error("Test-owned setup failure")
    const socketsBeforeSetup = probe.sockets.size
    const setupController = new AbortController()
    const failing = Effect.runPromiseExit(
        runBot({
            token,
            signal: setupController.signal,
            processSignals: true,
            events: { messageCreate: () => Effect.void },
            setup: (created) =>
                Effect.suspend(() => {
                    failed = created
                    return Effect.fail(failure)
                }),
        }),
    )
    active = { controller: setupController, running: failing }
    try {
        // A failed setup Effect fails the bot with ApplicationError, not a defect
        const exit = await failing
        assert.ok(Exit.isFailure(exit))
        assert.deepEqual(defects(exit), [])
        const failures = exit.cause.reasons.filter((reason) => reason._tag === "Fail").map(({ error }) => error)
        assert.equal(failures.length, 1)
        assert.ok(failures[0] instanceof ApplicationError)
        assert.equal(failures[0].source, "runBot setup")
        assert.equal(failures[0].cause, failure)
        // runBot reports the failed run through the exit code. The failure is test-owned, so the check clears it
        assert.equal(process.exitCode, 1)
        process.exitCode = undefined
        // A failed setup stops the bot before it connects and still releases the client and signal listeners
        assertReleased(failed, listeners)
        assert.equal(probe.sockets.size, socketsBeforeSetup)
        report(stage, { passed: true, remoteMutations: false })
    } finally {
        setupController.abort()
        await failing
        active = undefined
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
    lock = acquireLock()
    stage = "configuration"
    const { token, applicationId, guildId } = loadSandboxEnvironment()
    stage = "sandbox_identity"
    const { user } = await verifySandboxIdentity((path) => get(path, token), {
        applicationId,
        guildId,
        applicationPath: "/oauth2/applications/@me",
    })
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
    if (lock !== undefined && !lock.release()) {
        report("sandbox_lock_cleanup", { passed: false, lockRetained: true })
        process.exitCode = 1
    }
}
