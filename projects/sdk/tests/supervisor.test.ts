import { once } from "node:events"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { Effect, Fiber } from "effect"
import { expect, onTestFinished, test, vi } from "vitest"
import { WebSocketServer } from "ws"
import { supervisor } from "../src/index.js"
import { supervisor as nativeSupervisor } from "../src/effect.js"

function fixture(name: string): string {
    return fileURLToPath(new URL(`./${name}`, import.meta.url))
}

async function closeGateway(server: ReturnType<typeof createServer>, gateway: WebSocketServer) {
    for (const client of gateway.clients) client.terminate()
    await new Promise<void>((resolve) => gateway.close(() => resolve()))
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
}

function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

test("a delayed child grant cannot compress actual cross-process Identify sends", async () => {
    const identifies: number[] = []
    const server = createServer()
    const gateway = new WebSocketServer({ server })
    gateway.on("connection", (socket) => {
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1_000 } }))
        socket.on("message", (raw) => {
            const payload = JSON.parse(raw.toString()) as {
                readonly op?: unknown
                readonly d?: { readonly shard?: unknown }
            }
            if (payload.op !== 2) return
            identifies.push(performance.now())
            socket.send(
                JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "fixture", shard: payload.d?.shard } }),
            )
        })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected loopback fixture address")
    const created = supervisor.create({
        entry: fixture("supervisor-worker.js"),
        totalShards: 2,
        assignments: [
            { id: "first", shardIds: [0] },
            { id: "second", shardIds: [1] },
        ],
        childEnvironment: {
            FLUXERLY_SUPERVISOR_GATEWAY: `ws://127.0.0.1:${address.port}`,
            FLUXERLY_SUPERVISOR_MODE: "delayed",
        },
    })
    if (created.isErr()) throw created.error
    const managed = created.value
    let cleaned = false
    const cleanup = async () => {
        if (cleaned) return
        cleaned = true
        await managed.shutdown()
        await closeGateway(server, gateway)
    }
    onTestFinished(cleanup)
    try {
        expect((await managed.start()).isOk()).toBe(true)
        await vi.waitFor(() => expect(identifies).toHaveLength(2), { interval: 5, timeout: 5_000 })
        expect(identifies[1]! - identifies[0]!).toBeGreaterThanOrEqual(995)
        expect((await managed.shutdown()).isOk()).toBe(true)
        expect((await managed.waitForClose()).isOk()).toBe(true)
    } finally {
        await cleanup()
    }
}, 12_000)

test("a canceled in-flight grant is benign and releases the next child permit", async () => {
    const identifies: number[] = []
    const server = createServer()
    const gateway = new WebSocketServer({ server })
    gateway.on("connection", (socket) => {
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1_000 } }))
        socket.on("message", (raw) => {
            const payload = JSON.parse(raw.toString()) as {
                readonly op?: unknown
                readonly d?: { readonly shard?: unknown }
            }
            if (payload.op !== 2) return
            identifies.push(performance.now())
            socket.send(
                JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "fixture", shard: payload.d?.shard } }),
            )
        })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected loopback fixture address")
    const created = supervisor.create({
        entry: fixture("supervisor-cancel-race-worker.js"),
        totalShards: 2,
        assignments: [
            { id: "cancel", shardIds: [0] },
            { id: "healthy", shardIds: [1] },
        ],
        childEnvironment: { FLUXERLY_SUPERVISOR_GATEWAY: `ws://127.0.0.1:${address.port}` },
    })
    if (created.isErr()) throw created.error
    const managed = created.value
    let cleaned = false
    const cleanup = async () => {
        if (cleaned) return
        cleaned = true
        await managed.shutdown()
        await closeGateway(server, gateway)
    }
    onTestFinished(cleanup)
    try {
        expect((await managed.start()).isOk()).toBe(true)
        await vi.waitFor(() => expect(identifies).toHaveLength(1), { interval: 5, timeout: 1_500 })
        expect((await managed.shutdown()).isOk()).toBe(true)
        expect((await managed.waitForClose()).isOk()).toBe(true)
    } finally {
        await cleanup()
    }
}, 8_000)

test("partial assignments snapshot status without retaining launch configuration", async () => {
    const created = supervisor.create({
        entry: fixture("supervisor-never-hello-worker.js"),
        totalShards: 3,
        assignments: [{ id: "partial", shardIds: [1] }],
        args: ["selected-worker"],
        execArgv: ["--no-warnings"],
        childEnvironment: { SUPERVISOR_TEST_PRIVATE_VALUE: "not-in-status" },
    })
    if (created.isErr()) throw created.error
    const status = created.value.status()
    expect(status).toMatchObject({
        state: "idle",
        children: [
            { id: "partial", assignment: { totalShards: 3, shardIds: [1] }, generation: 0, pid: null, restarts: 0 },
        ],
    })
    expect(JSON.stringify(status)).not.toContain("not-in-status")
    expect(JSON.stringify(status)).not.toContain("selected-worker")
    expect((await created.value.shutdown()).isOk()).toBe(true)
    expect((await created.value.waitForClose()).isOk()).toBe(true)
    expect(created.value.status().state).toBe("closed")
})

test("a child that never acknowledges startup fails within the configured budget and is cleaned up", async () => {
    const created = supervisor.create({
        entry: fixture("supervisor-never-hello-worker.js"),
        totalShards: 1,
        assignments: [{ id: "silent", shardIds: [0] }],
        startupTimeoutMs: 30,
        shutdownTimeoutMs: 30,
    })
    if (created.isErr()) throw created.error
    const managed = created.value
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
    const created = supervisor.create({
        entry: fixture("supervisor-sigterm-worker.js"),
        totalShards: 1,
        assignments: [{ id: "late-exit", shardIds: [0] }],
        startupTimeoutMs: 30,
        shutdownTimeoutMs: 150,
        childEnvironment: { FLUXERLY_SUPERVISOR_MODE: "never-ready" },
    })
    if (created.isErr()) throw created.error
    const managed = created.value
    onTestFinished(async () => {
        await managed.shutdown()
    })
    let terminalSettled = false
    const terminal = managed.waitForClose()
    void terminal.then(() => {
        terminalSettled = true
    })
    const started = managed.start()
    await sleep(80)
    expect(terminalSettled).toBe(false)
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
    const created = supervisor.create({
        entry: fixture("supervisor-sigterm-worker.js"),
        totalShards: 1,
        assignments: [{ id: "resistant", shardIds: [0] }],
        shutdownTimeoutMs: 30,
    })
    if (created.isErr()) throw created.error
    const managed = created.value
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
    const created = supervisor.create({
        entry: fixture("supervisor-restart-worker.js"),
        totalShards: 1,
        assignments: [{ id: "replacement", shardIds: [0] }],
        restart: { maxAttempts: 1, minDelayMs: 10, maxDelayMs: 10 },
        startupTimeoutMs: 400,
        shutdownTimeoutMs: 30,
        childEnvironment: { FLUXERLY_SUPERVISOR_MODE: "exit-then-never-ready" },
    })
    if (created.isErr()) throw created.error
    const managed = created.value
    onTestFinished(async () => {
        await managed.shutdown()
    })
    expect((await managed.start()).isOk()).toBe(true)
    const closed = await managed.waitForClose()
    expect(closed.isErr() && closed.error).toMatchObject({ childId: "replacement", reason: "startupTimeout" })
    expect(managed.status().children[0]).toMatchObject({ generation: 2, restarts: 1, pid: null, state: "failed" })
}, 5_000)

test("replacement is opt-in and its supplied budget is bounded", async () => {
    const noReplacement = supervisor.create({
        entry: fixture("supervisor-restart-worker.js"),
        totalShards: 1,
        assignments: [{ id: "once", shardIds: [0] }],
    })
    if (noReplacement.isErr()) throw noReplacement.error
    const once = noReplacement.value
    const onceStart = once.start()
    const onceClosed = await once.waitForClose()
    expect(onceClosed.isErr() && onceClosed.error).toMatchObject({ childId: "once", reason: "closed" })
    await onceStart

    const restarting = supervisor.create({
        entry: fixture("supervisor-restart-worker.js"),
        totalShards: 1,
        assignments: [{ id: "restart", shardIds: [0] }],
        restart: { maxAttempts: 1, minDelayMs: 10, maxDelayMs: 10 },
    })
    if (restarting.isErr()) throw restarting.error
    const managed = restarting.value
    const start = managed.start()
    const closed = await managed.waitForClose()
    expect(closed.isErr() && closed.error).toMatchObject({ childId: "restart", reason: "restartLimit" })
    await start
    expect(managed.status().children[0]).toMatchObject({ restarts: 1, state: "failed" })
}, 8_000)
