import { createServer } from "node:http"
import { once } from "node:events"
import { setImmediate as turn } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { Effect, Fiber } from "effect"
import { expect, onTestFinished, test, vi } from "vitest"
import { supervisor } from "../../../src/index.js"
import { supervisor as nativeSupervisor } from "../../../src/effect.js"
import { Opcode as GatewayOpcode } from "../../../src/internal/protocol/gateway.js"
import { startGatewayServer } from "../../support/gateway-server.js"
import { requireBuiltSdk } from "../../support/built-sdk.js"
import { realTimeUntil } from "../../support/client-clock.js"

// These tests run the built SDK, so a stale or missing dist fails them before they start
requireBuiltSdk()

function fixture(name: string): string {
    return fileURLToPath(new URL(`./workers/${name}`, import.meta.url))
}

/** A gateway for supervised children, which connect through their environment rather than a redirected socket */
async function childGateway() {
    const identifies: number[] = []
    const gateway = await startGatewayServer({
        redirect: false,
        heartbeatIntervalMs: 1_000,
        sessionId: "fixture",
        ready: (identify) => ({ shard: identify.d?.shard }),
        onCommand: (command) => {
            if (command.op === GatewayOpcode.identify) identifies.push(performance.now())
        },
    })
    return { url: gateway.url, identifies }
}

/** A loopback barrier that holds the first request until release and answers later ones at once */
async function firstRequestBarrier() {
    let held: import("node:http").ServerResponse | undefined
    let released = false
    const entered = Promise.withResolvers<void>()
    const server = createServer((_request, response) => {
        if (released || held) {
            response.writeHead(204).end()
            return
        }
        held = response
        entered.resolve()
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    onTestFinished(async () => {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing grant barrier address")
    return {
        url: `http://127.0.0.1:${address.port}/`,
        entered: entered.promise,
        release() {
            released = true
            held?.writeHead(204).end()
            held = undefined
        },
    }
}

test("a delayed child grant cannot compress actual cross-process Identify sends", async () => {
    // Catches: The supervisor spaced Identify grants from the grant rather than from the child's report that it sent
    // the Identify, so a child that sent late moved the next child's Identify closer to its own
    const minimumSpacingMs = 1_000
    const { url, identifies } = await childGateway()
    const barrier = await firstRequestBarrier()
    // Only the parent's timers are faked, so its spacing moves only when the test advances it. The children keep real
    // time, and the gateway records the parent's time of each Identify it receives
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    const fakeSetTimeout = globalThis.setTimeout
    const armed: number[] = []
    let watching = false
    const scheduled = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number) => {
        if (watching) armed.push(delay ?? 0)
        return fakeSetTimeout(callback, delay)
    }) as typeof setTimeout)
    const realTimers = () => {
        scheduled.mockRestore()
        vi.useRealTimers()
    }
    const managed = supervisor.create({
        entry: fixture("supervisor-worker.js"),
        totalShards: 2,
        assignments: [
            { id: "first", shardIds: [0] },
            { id: "second", shardIds: [1] },
        ],
        identify: { minimumSpacingMs },
        childEnvironment: { FLUXERLY_SUPERVISOR_GATEWAY: url, FLUXERLY_SUPERVISOR_GRANT_BARRIER: barrier.url },
    })
    let cleaned = false
    const cleanup = async () => {
        if (cleaned) return
        cleaned = true
        if (vi.isFakeTimers()) realTimers()
        barrier.release()
        await managed.shutdown()
    }
    onTestFinished(cleanup)
    try {
        expect((await managed.start()).isOk()).toBe(true)
        // The first child to ask was granted at once and holds the grant, so its Identify is not sent yet
        await barrier.entered
        expect(identifies).toEqual([])
        await vi.advanceTimersByTimeAsync(400)
        watching = true
        barrier.release()
        // After the held child reports its send, the next grant waits on the parent's only new timer
        await realTimeUntil(() => armed.length > 0)
        await vi.advanceTimersByTimeAsync(armed[0]!)
        await realTimeUntil(() => identifies.length === 2)
        // The second Identify follows the first actual send, not its grant, by the full spacing
        expect(identifies).toEqual([400, 400 + minimumSpacingMs])
        realTimers()
        expect((await managed.shutdown()).isOk()).toBe(true)
        expect((await managed.waitForClose()).isOk()).toBe(true)
    } finally {
        await cleanup()
    }
}, 12_000)

test("a canceled in-flight grant is benign and releases the next child permit", async () => {
    const { url, identifies } = await childGateway()
    const managed = supervisor.create({
        entry: fixture("supervisor-cancel-race-worker.js"),
        totalShards: 2,
        assignments: [
            { id: "cancel", shardIds: [0] },
            { id: "healthy", shardIds: [1] },
        ],
        childEnvironment: { FLUXERLY_SUPERVISOR_GATEWAY: url },
    })
    let cleaned = false
    const cleanup = async () => {
        if (cleaned) return
        cleaned = true
        await managed.shutdown()
    }
    onTestFinished(cleanup)
    try {
        expect((await managed.start()).isOk()).toBe(true)
        await vi.waitFor(() => expect(identifies).toHaveLength(1), { interval: 5 })
        // A cancelled grant that kept the permit would only free it through the acknowledgement deadline, which stops
        // the cancelling child before the healthy child can identify
        const cancelling = managed.status().children.find((child) => child.id === "cancel")
        expect(cancelling).toMatchObject({ generation: 1, restarts: 0 })
        expect(["starting", "running"]).toContain(cancelling?.state)
        expect((await managed.shutdown()).isOk()).toBe(true)
        expect((await managed.waitForClose()).isOk()).toBe(true)
    } finally {
        await cleanup()
    }
}, 20_000)

test.each(["default", "native"] as const)(
    "%s child receives a coordinator refusal as a retryable failure and the next grant",
    async (mode) => {
        const permits: number[] = []
        const options = {
            entry: fixture("supervisor-coordinator-worker.js"),
            totalShards: 1,
            processes: 1,
            restart: false as const,
            logging: { level: "silent" as const },
            identify: {
                coordinator: {
                    async permit(shardId: number) {
                        permits.push(shardId)
                        if (permits.length === 1) throw new Error("fixture coordinator refusal")
                    },
                },
            },
        }
        if (mode === "default") {
            const managed = supervisor.create(options)
            onTestFinished(async () => {
                await managed.shutdown()
            })
            expect((await managed.start()).isOk()).toBe(true)
            expect((await managed.waitForReady()).isOk()).toBe(true)
            expect((await managed.shutdown()).isOk()).toBe(true)
            expect((await managed.waitForClose()).isOk()).toBe(true)
        } else {
            const managed = await Effect.runPromise(nativeSupervisor.create(options))
            onTestFinished(() => Effect.runPromise(managed.shutdown()))
            await Effect.runPromise(managed.start())
            await Effect.runPromise(managed.waitForReady())
            await Effect.runPromise(managed.shutdown())
            await Effect.runPromise(managed.waitForClose())
        }
        expect(permits).toEqual([0, 0])
    },
    10_000,
)

test.each(["default", "native"] as const)(
    "%s children share the account's member request window and global pause through their parent",
    async (mode) => {
        // Catches: The child bridge and the parent disagreed on the account-limit messages, so a child's request or
        // report never reached the shared window, or a pause never reached the other child
        const options = {
            entry: fixture("supervisor-account-limits-worker.js"),
            totalShards: 2,
            processes: 2,
            restart: false as const,
            logging: { level: "silent" as const },
        }
        if (mode === "default") {
            const managed = supervisor.create(options)
            onTestFinished(async () => {
                await managed.shutdown()
            })
            expect((await managed.start()).isOk()).toBe(true)
            expect((await managed.waitForReady()).isOk()).toBe(true)
            expect((await managed.shutdown()).isOk()).toBe(true)
        } else {
            const managed = await Effect.runPromise(nativeSupervisor.create(options))
            onTestFinished(() => Effect.runPromise(managed.shutdown()))
            await Effect.runPromise(managed.start())
            await Effect.runPromise(managed.waitForReady())
            await Effect.runPromise(managed.shutdown())
        }
    },
    10_000,
)

test("a child that loses the parent's answer to a member request falls back and frees the slot", async () => {
    // Catches: A child waited without end for an answer the IPC channel lost, or kept the parent counting a grant it
    // never used, so later requests were refused
    const managed = supervisor.create({
        entry: fixture("supervisor-unanswered-worker.js"),
        totalShards: 1,
        processes: 1,
        restart: false,
        logging: { level: "silent" },
    })
    onTestFinished(async () => {
        await managed.shutdown()
    })
    expect((await managed.start()).isOk()).toBe(true)
    expect((await managed.waitForReady()).isOk()).toBe(true)
    expect((await managed.shutdown()).isOk()).toBe(true)
}, 10_000)

test("partial assignments snapshot status without retaining launch configuration", async () => {
    const created = supervisor.create({
        entry: fixture("supervisor-never-hello-worker.js"),
        totalShards: 3,
        assignments: [{ id: "partial", shardIds: [1] }],
        args: ["selected-worker"],
        execArgv: ["--no-warnings"],
        childEnvironment: { SUPERVISOR_TEST_PRIVATE_VALUE: "not-in-status" },
    })
    const status = created.status()
    expect(status).toMatchObject({
        state: "idle",
        children: [
            { id: "partial", assignment: { totalShards: 3, shardIds: [1] }, generation: 0, pid: null, restarts: 0 },
        ],
    })
    expect(JSON.stringify(status)).not.toContain("not-in-status")
    expect(JSON.stringify(status)).not.toContain("selected-worker")
    expect((await created.shutdown()).isOk()).toBe(true)
    expect((await created.waitForClose()).isOk()).toBe(true)
    expect(created.status().state).toBe("closed")
})

test("a child that never acknowledges startup fails within the configured budget and is cleaned up", async () => {
    const managed = supervisor.create({
        entry: fixture("supervisor-never-hello-worker.js"),
        totalShards: 1,
        assignments: [{ id: "silent", shardIds: [0] }],
        startupTimeoutMs: 30,
        shutdownTimeoutMs: 30,
    })
    onTestFinished(async () => {
        await managed.shutdown()
    })
    const started = await managed.start()
    expect(started.isErr() && started.error).toMatchObject({ _tag: "SupervisorError", reason: "startupTimeout" })
    const closed = await managed.waitForClose()
    expect(closed.isErr() && closed.error).toMatchObject({ _tag: "SupervisorError", reason: "startupTimeout" })
    expect((await managed.shutdown()).isOk()).toBe(true)
    expect(managed.status().children[0]).toMatchObject({ pid: null, state: "failed" })
}, 5_000)

test("a startup failure keeps terminal observers pending until the owned child exits", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const managed = supervisor.create({
        entry: fixture("supervisor-sigterm-worker.js"),
        totalShards: 1,
        assignments: [{ id: "late-exit", shardIds: [0] }],
        startupTimeoutMs: 30,
        shutdownTimeoutMs: 150,
        childEnvironment: { FLUXERLY_SUPERVISOR_MODE: "never-ready" },
    })
    onTestFinished(async () => {
        // Also release any held cleanup deadline when an assertion fails
        await vi.runAllTimersAsync()
        vi.useRealTimers()
        await managed.shutdown()
    })
    let terminalSettled = false
    const terminal = managed.waitForClose()
    void terminal.then(() => {
        terminalSettled = true
    })
    const started = managed.start()
    // The startup deadline expires and the child ignores shutdown, so it stays owned until the forced-stop deadline
    await vi.advanceTimersByTimeAsync(30)
    expect(managed.status().children[0]).toMatchObject({ state: "stopping", pid: expect.any(Number) })
    expect(terminalSettled).toBe(false)
    await vi.advanceTimersByTimeAsync(150)
    const startResult = await started
    expect(startResult.isErr() && startResult.error).toMatchObject({ childId: "late-exit", reason: "startupTimeout" })
    const terminalResult = await terminal
    expect(terminalResult.isErr() && terminalResult.error).toMatchObject({
        childId: "late-exit",
        reason: "startupTimeout",
    })
    expect(managed.status().children[0]).toMatchObject({ pid: null, state: "failed" })
}, 5_000)

test("shutdown force-terminates only an unresponsive owned child and waits for verified exit", async () => {
    const managed = supervisor.create({
        entry: fixture("supervisor-sigterm-worker.js"),
        totalShards: 1,
        assignments: [{ id: "resistant", shardIds: [0] }],
        shutdownTimeoutMs: 30,
    })
    onTestFinished(async () => {
        await managed.shutdown()
    })
    expect((await managed.start()).isOk()).toBe(true)
    const before = managed.status().children[0]
    expect(typeof before?.pid).toBe("number")
    expect((await managed.shutdown()).isOk()).toBe(true)
    expect((await managed.waitForClose()).isOk()).toBe(true)
    expect(managed.status().children[0]).toMatchObject({ pid: null, state: "closed" })
    const restarted = await managed.start()
    expect(restarted.isErr() && restarted.error).toMatchObject({ childId: null, reason: "closed" })
}, 5_000)

test("a canceled native terminal observer detaches without stopping its supervisor", async () => {
    const managed = await Effect.runPromise(
        nativeSupervisor.create({
            entry: fixture("supervisor-sigterm-worker.js"),
            totalShards: 1,
            assignments: [{ id: "native-observer", shardIds: [0] }],
            shutdownTimeoutMs: 30,
        }),
    )
    onTestFinished(() => Effect.runPromise(managed.shutdown()))
    await Effect.runPromise(managed.start())
    const observer = Effect.runFork(managed.waitForClose())
    await Effect.runPromise(Fiber.interrupt(observer))
    expect(managed.status().state).toBe("running")
    await Effect.runPromise(managed.shutdown())
    await Effect.runPromise(managed.waitForClose())
    const stopped = await Effect.runPromiseExit(managed.start())
    expect(stopped._tag).toBe("Failure")
}, 5_000)

test("a replacement that misses its own startup budget fails after a successful initial start", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const managed = supervisor.create({
        entry: fixture("supervisor-restart-worker.js"),
        totalShards: 1,
        assignments: [{ id: "replacement", shardIds: [0] }],
        restart: { maxAttempts: 1, minDelayMs: 10, maxDelayMs: 10 },
        startupTimeoutMs: 400,
        shutdownTimeoutMs: 30,
        childEnvironment: { FLUXERLY_SUPERVISOR_MODE: "exit-then-never-ready" },
    })
    onTestFinished(async () => {
        // Also release any held cleanup deadline when an assertion fails.
        await vi.runAllTimersAsync()
        vi.useRealTimers()
        await managed.shutdown()
    })
    // Child startup uses real IPC, but its deadline cannot expire before initial readiness.
    expect((await managed.start()).isOk()).toBe(true)
    while (managed.status().children[0]?.state !== "restarting") await turn()
    await vi.advanceTimersByTimeAsync(10)
    expect(managed.status().children[0]).toMatchObject({ generation: 2, restarts: 1 })
    // Only the replacement's startup budget and forced-stop grace are advanced.
    await vi.advanceTimersByTimeAsync(400)
    await vi.advanceTimersByTimeAsync(30)
    const closed = await managed.waitForClose()
    expect(closed.isErr() && closed.error).toMatchObject({ childId: "replacement", reason: "startupTimeout" })
    expect(managed.status().children[0]).toMatchObject({ generation: 2, restarts: 1, pid: null, state: "failed" })
}, 5_000)

test.each(["default", "native"] as const)(
    "%s supervisor restarts a crashed child by default, and restart false stops at the first crash",
    async (mode) => {
        const options = (restart?: false) => ({
            entry: fixture("supervisor-restart-worker.js"),
            totalShards: 1,
            assignments: [{ id: "crash", shardIds: [0] }],
            ...(restart === undefined ? {} : { restart }),
        })
        const run = async (restart?: false) => {
            if (mode === "default") {
                const created = supervisor.create(options(restart))
                return {
                    status: () => created.status(),
                    start: () => created.start().then(() => undefined),
                    waitForClose: () =>
                        created.waitForClose().then((result) => (result.isErr() ? result.error : undefined)),
                    shutdown: () => created.shutdown().then(() => undefined),
                }
            }
            const created = await Effect.runPromise(nativeSupervisor.create(options(restart)))
            return {
                status: () => created.status(),
                start: () => Effect.runPromise(Effect.ignore(created.start())),
                waitForClose: () =>
                    Effect.runPromise(
                        created.waitForClose().pipe(
                            Effect.flip,
                            Effect.orElseSucceed(() => undefined),
                        ),
                    ),
                shutdown: () => Effect.runPromise(created.shutdown()),
            }
        }

        const restarting = await run()
        // Only the parent's timers are faked, so the restart delay passes when the test advances it, not with the time
        // the real worker needs to start and exit
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
        onTestFinished(async () => {
            vi.useRealTimers()
            await restarting.shutdown()
        })
        await restarting.start()
        // The worker exits right after readiness, and the default policy replaces it after 1,000 ms
        await realTimeUntil(() => restarting.status().children[0]?.state === "restarting")
        await vi.advanceTimersByTimeAsync(999)
        expect(restarting.status().children[0]).toMatchObject({ generation: 1, restarts: 1, state: "restarting" })
        await vi.advanceTimersByTimeAsync(1)
        expect(restarting.status().children[0]).toMatchObject({ generation: 2, restarts: 1 })
        expect(restarting.status().state).not.toBe("failed")
        // The replacement answers a stop request only after its startup handshake, so let that finish first
        await realTimeUntil(() => restarting.status().children[0]?.state !== "starting")
        vi.useRealTimers()
        await restarting.shutdown()
        expect(await restarting.waitForClose()).toBeUndefined()

        const stopping = await run(false)
        onTestFinished(async () => {
            await stopping.shutdown()
        })
        const started = stopping.start()
        expect(await stopping.waitForClose()).toMatchObject({ childId: "crash", reason: "closed" })
        await started
        expect(stopping.status().children[0]).toMatchObject({ generation: 1, restarts: 0, state: "failed" })
    },
    10_000,
)

test("a supplied restart budget is bounded", async () => {
    const managed = supervisor.create({
        entry: fixture("supervisor-restart-worker.js"),
        totalShards: 1,
        assignments: [{ id: "restart", shardIds: [0] }],
        restart: { maxAttempts: 1, minDelayMs: 10, maxDelayMs: 10 },
    })
    const start = managed.start()
    const closed = await managed.waitForClose()
    expect(closed.isErr() && closed.error).toMatchObject({ childId: "restart", reason: "restartLimit" })
    await start
    expect(managed.status().children[0]).toMatchObject({ restarts: 1, state: "failed" })
}, 8_000)
