import { once } from "node:events"
import { createServer } from "node:http"
import { Cause, Effect, Exit, Scope } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import WebSocket, { WebSocketServer } from "ws"
import { SdkDefect, createClient, type Client as DefaultClient } from "../src/index.js"
import { createClient as createNative, type Client as NativeClient } from "../src/effect.js"

const transport = vi.hoisted(() => ({
    url: "",
    sockets: [] as import("ws").WebSocket[],
    closed: new Set<import("ws").WebSocket>(),
    failedSocket: undefined as import("ws").WebSocket | undefined,
    cleanup: undefined as unknown,
    terminationGate: undefined as
        | {
              readonly socket: import("ws").WebSocket
              readonly started: Promise<void>
              start(): void
              unblock(): void
              readonly released: Promise<void>
          }
        | undefined,
}))

vi.mock("ws", async (original) => {
    const module = await original<typeof import("ws")>()
    return {
        ...module,
        default: class extends module.default {
            constructor(_url: string, options: import("ws").ClientOptions) {
                super(transport.url, options)
                transport.sockets.push(this)
                this.once("close", () => transport.closed.add(this))
            }

            override close(...arguments_: Parameters<import("ws").WebSocket["close"]>) {
                if (this === transport.failedSocket) throw transport.cleanup
                return super.close(...arguments_)
            }

            override terminate() {
                const gate = transport.terminationGate
                if (gate?.socket === this) {
                    gate.start()
                    void gate.released.then(() => super.terminate())
                    return
                }
                return super.terminate()
            }
        },
    }
})

const fetch = globalThis.fetch
const modes = ["default", "native"] as const
type Mode = (typeof modes)[number]
type ServerSocket = import("ws").WebSocket

interface Connection {
    readonly socket: ServerSocket
    shardId: number | undefined
}

interface Command {
    readonly connection: Connection
    readonly op: number
    readonly data: unknown
}

interface Driver {
    readonly defaultApi: DefaultClient | undefined
    readonly native: NativeClient | undefined
    readonly client: DefaultClient | NativeClient
    close(): Promise<void>
}

function record(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected gateway object")
    return value as Record<string, unknown>
}

function shardTuple(command: Command): readonly [number, number] {
    const shard = record(command.data).shard
    if (!Array.isArray(shard) || shard.length !== 2 || typeof shard[0] !== "number" || typeof shard[1] !== "number")
        throw new Error("Expected sharded Identify")
    return [shard[0], shard[1]]
}

async function gatewayFixture() {
    let sequence = 0
    const connections: Connection[] = []
    const identifies: Command[] = []
    const server = createServer((_request, response) => {
        response.setHeader("Content-Type", "application/json")
        response.end('{"url":"wss://gateway.fluxer.app"}')
    })
    const gateway = new WebSocketServer({ server })

    const dispatch = (connection: Connection, event: string, data: unknown) => {
        connection.socket.send(JSON.stringify({ op: 0, s: ++sequence, t: event, d: data }))
    }

    gateway.on("connection", (socket) => {
        const connection: Connection = { socket, shardId: undefined }
        connections.push(connection)
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 100 } }))
        socket.on("message", (raw) => {
            const payload = record(JSON.parse(raw.toString()))
            if (typeof payload.op !== "number") throw new Error("Expected gateway opcode")
            if (payload.op === 1) {
                if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: 11 }))
                return
            }
            if (payload.op !== 2) return
            const command: Command = { connection, op: payload.op, data: payload.d }
            connection.shardId = shardTuple(command)[0]
            identifies.push(command)
        })
    })

    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected owned loopback address")
    transport.url = `ws://127.0.0.1:${address.port}`
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
        expect(url).toBe("https://api.fluxer.app/v1/gateway/bot")
        return fetch(`http://127.0.0.1:${address.port}`, init)
    })

    const byShard = (shardId: number) => {
        const connection = connections.find((candidate) => candidate.shardId === shardId)
        if (!connection) throw new Error(`No gateway connection for shard ${shardId}`)
        return connection
    }
    const clientFor = (shardId: number) => {
        const connection = byShard(shardId)
        const socket = transport.sockets[connections.indexOf(connection)]
        if (!socket) throw new Error(`No client socket for shard ${shardId}`)
        return socket
    }

    return {
        identifies,
        ready(command: Command, echoedShard = shardTuple(command)) {
            const [shardId] = shardTuple(command)
            dispatch(command.connection, "READY", { session_id: `fixture-${shardId}`, shard: echoedShard })
        },
        failClose(shardId: number, cleanup: unknown) {
            const socket = clientFor(shardId)
            let start!: () => void
            let unblock!: () => void
            const gate = {
                socket,
                started: new Promise<void>((resolve) => {
                    start = resolve
                }),
                start,
                released: new Promise<void>((resolve) => {
                    unblock = resolve
                }),
                unblock,
            }
            transport.failedSocket = socket
            transport.cleanup = cleanup
            transport.terminationGate = gate
            return gate
        },
        clientClosed(shardId: number) {
            return transport.closed.has(clientFor(shardId))
        },
        async waitClientClosed(shardId: number) {
            await vi.waitFor(() => expect(this.clientClosed(shardId)).toBe(true), { interval: 5, timeout: 2_000 })
        },
        async close() {
            transport.terminationGate?.unblock()
            transport.terminationGate = undefined
            transport.failedSocket = undefined
            transport.cleanup = undefined
            for (const socket of [...gateway.clients, ...transport.sockets]) socket.terminate()
            await new Promise<void>((resolve) => gateway.close(() => resolve()))
            server.closeAllConnections()
            await new Promise<void>((resolve) => server.close(() => resolve()))
        },
    }
}

async function makeDriver(mode: Mode, startupTimeoutMs?: number): Promise<Driver> {
    const options = {
        token: "fixture-only-not-a-credential",
        sharding: { totalShards: 2 },
        ...(startupTimeoutMs === undefined ? {} : { connection: { startupTimeoutMs } }),
    }
    if (mode === "default") {
        const client = createClient(options)._unsafeUnwrap()
        return {
            defaultApi: client,
            native: undefined,
            client,
            async close() {
                await client.shutdown()
            },
        }
    }
    const scope = Scope.makeUnsafe()
    const client = await Effect.runPromise(createNative(options).pipe(Scope.provide(scope)))
    return {
        defaultApi: undefined,
        native: client,
        client,
        async close() {
            await Effect.runPromise(client.shutdown())
            await Effect.runPromise(Scope.close(scope, Exit.void))
        },
    }
}

async function waitForIdentifies(fixture: Awaited<ReturnType<typeof gatewayFixture>>) {
    await vi.waitFor(() => expect(fixture.identifies).toHaveLength(2), { interval: 5, timeout: 4_000 })
    const first = fixture.identifies.find((command) => shardTuple(command)[0] === 0)
    const second = fixture.identifies.find((command) => shardTuple(command)[0] === 1)
    if (!first || !second) throw new Error("Expected both assigned shards")
    return { first, second }
}

function expectDefaultDefect(error: unknown, expected: object) {
    expect(error).toBeInstanceOf(SdkDefect)
    expect(error).toMatchObject({
        operation: "connect",
        reasons: expect.arrayContaining([expected, { kind: "Defect" }]),
    })
    expect(JSON.stringify(error)).not.toContain("private socket cleanup detail")
}

function expectNativeDefect(exit: Exit.Exit<unknown, unknown>, cleanup: unknown, expected: object) {
    expect(Exit.isFailure(exit)).toBe(true)
    if (!Exit.isFailure(exit)) return
    const failure = exit.cause.reasons.find((reason) => reason._tag === (expected as { _tag: string })._tag)
    expect(failure).toMatchObject(expected)
    const defect = exit.cause.reasons.find((reason) => reason._tag === "Die")
    expect(defect).toMatchObject({ _tag: "Die" })
    if (defect?._tag === "Die") expect(defect.defect).toBe(cleanup)
}

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    transport.sockets = []
    transport.closed.clear()
    transport.failedSocket = undefined
    transport.cleanup = undefined
    transport.terminationGate = undefined
})

test.each(modes)("%s retains a permanent shard failure and a sibling socket cleanup defect", async (mode) => {
    const cleanup = new Error("private socket cleanup detail")
    const fixture = await gatewayFixture()
    const driver = await makeDriver(mode)
    try {
        const pending = driver.defaultApi
            ? Promise.resolve(driver.defaultApi.connect())
            : Effect.runPromiseExit(driver.native!.connect())
        const { first, second } = await waitForIdentifies(fixture)
        fixture.ready(first)
        await vi.waitFor(
            () => expect(driver.client.shards.find((shard) => shard.shardId === 0)?.state).toBe("Connected"),
            { interval: 5, timeout: 2_000 },
        )
        const cleanupGate = fixture.failClose(0, cleanup)
        const [shardId, totalShards] = shardTuple(second)
        fixture.ready(second, [(shardId + 1) % totalShards, totalShards])
        let settled = false
        void pending.then(
            () => {
                settled = true
            },
            () => {
                settled = true
            },
        )
        await cleanupGate.started
        await Promise.resolve()
        expect(settled).toBe(false)
        cleanupGate.unblock()

        if (driver.defaultApi) {
            const error = await pending.catch((reason) => reason)
            await fixture.waitClientClosed(0)
            expectDefaultDefect(error, {
                kind: "Failure",
                failure: expect.objectContaining({
                    _tag: "ShardConnectionError",
                    shardId,
                    failure: expect.objectContaining({ _tag: "ConnectionError", phase: "gateway", reason: "protocol" }),
                }),
            })
        } else {
            const exit = await (pending as Promise<Exit.Exit<void, unknown>>)
            await fixture.waitClientClosed(0)
            expectNativeDefect(exit, cleanup, {
                _tag: "Fail",
                error: expect.objectContaining({
                    _tag: "ShardConnectionError",
                    shardId,
                    failure: expect.objectContaining({ _tag: "ConnectionError", phase: "gateway", reason: "protocol" }),
                }),
            })
        }
        expect(fixture.clientClosed(0)).toBe(true)
        expect(driver.client.state).toBe("Closed")
    } finally {
        await driver.close()
        await fixture.close()
    }
})

test.each(modes)("%s retains a startup timeout and a socket cleanup defect", async (mode) => {
    const cleanup = new Error("private socket cleanup detail")
    const timeoutMs = 750
    const fixture = await gatewayFixture()
    const driver = await makeDriver(mode, timeoutMs)
    try {
        const pending = driver.defaultApi
            ? Promise.resolve(driver.defaultApi.connect())
            : Effect.runPromiseExit(driver.native!.connect())
        await vi.waitFor(() => expect(fixture.identifies).toHaveLength(1), { interval: 5, timeout: 2_000 })
        const [startedShard] = shardTuple(fixture.identifies[0]!)
        const cleanupGate = fixture.failClose(startedShard, cleanup)
        let settled = false
        void pending.then(
            () => {
                settled = true
            },
            () => {
                settled = true
            },
        )
        await cleanupGate.started
        await Promise.resolve()
        expect(settled).toBe(false)
        cleanupGate.unblock()

        if (driver.defaultApi) {
            const error = await pending.catch((reason) => reason)
            await fixture.waitClientClosed(startedShard)
            expectDefaultDefect(error, {
                kind: "Failure",
                failure: expect.objectContaining({ _tag: "ConnectionTimeoutError", timeoutMs }),
            })
        } else {
            const exit = await (pending as Promise<Exit.Exit<void, unknown>>)
            await fixture.waitClientClosed(startedShard)
            expectNativeDefect(exit, cleanup, {
                _tag: "Fail",
                error: expect.objectContaining({ _tag: "ConnectionTimeoutError", timeoutMs }),
            })
        }
        expect(fixture.clientClosed(startedShard)).toBe(true)
        expect(driver.client.state).toBe("Closed")
    } finally {
        await driver.close()
        await fixture.close()
    }
})

test.each(modes)("%s retains caller interruption and a socket cleanup defect", async (mode) => {
    const cleanup = new Error("private socket cleanup detail")
    const fixture = await gatewayFixture()
    const driver = await makeDriver(mode)
    const controller = new AbortController()
    try {
        const pending = driver.defaultApi
            ? Promise.resolve(driver.defaultApi.connect({ signal: controller.signal }))
            : Effect.runPromiseExit(driver.native!.connect(), { signal: controller.signal })
        await vi.waitFor(() => expect(fixture.identifies).toHaveLength(1), { interval: 5, timeout: 2_000 })
        const [startedShard] = shardTuple(fixture.identifies[0]!)
        const cleanupGate = fixture.failClose(startedShard, cleanup)
        controller.abort()
        let settled = false
        void pending.then(
            () => {
                settled = true
            },
            () => {
                settled = true
            },
        )
        await cleanupGate.started
        await Promise.resolve()
        expect(settled).toBe(false)
        cleanupGate.unblock()

        if (driver.defaultApi) {
            const error = await pending.catch((reason) => reason)
            await fixture.waitClientClosed(startedShard)
            expectDefaultDefect(error, { kind: "Interruption" })
        } else {
            const exit = await (pending as Promise<Exit.Exit<void, unknown>>)
            await fixture.waitClientClosed(startedShard)
            expectNativeDefect(exit, cleanup, { _tag: "Interrupt" })
            if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true)
        }
        expect(fixture.clientClosed(startedShard)).toBe(true)
        expect(driver.client.state).toBe("Closed")
    } finally {
        await driver.close()
        await fixture.close()
    }
})
