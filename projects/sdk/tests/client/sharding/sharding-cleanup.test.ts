import { Cause, Effect, Exit, Scope } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { SdkDefect, createClient, type Client as DefaultClient } from "../../../src/index.js"
import { createClient as createNative, type Client as NativeClient } from "../../../src/effect.js"
import { Opcode as GatewayOpcode } from "../../../src/internal/protocol/gateway.js"
import { startGatewayServer } from "../../support/gateway-server.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { sdkClock } from "../../support/client-clock.js"

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

interface Command {
    /** Index of the fixture connection that sent the command */
    readonly connection: number
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
    // Shard identified on each fixture connection, by connection index
    const shards: (number | undefined)[] = []
    const identifies: Command[] = []
    // This file's own ws mock routes client sockets through transport.url, so the fixture does not redirect
    const gateway = await startGatewayServer({
        redirect: false,
        autoReady: false,
        heartbeatIntervalMs: 100,
        onCommand: ({ connection, op, d }) => {
            if (op !== GatewayOpcode.identify) return
            const command: Command = { connection, op, data: d }
            shards[connection] = shardTuple(command)[0]
            identifies.push(command)
        },
    })
    transport.url = gateway.url
    stubFetchWithHostedDiscovery((url: string) => {
        throw new Error(`Unexpected fixture fetch: ${url}`)
    })

    const clientFor = (shardId: number) => {
        const connection = shards.indexOf(shardId)
        if (connection === -1) throw new Error(`No gateway connection for shard ${shardId}`)
        const socket = transport.sockets[connection]
        if (!socket) throw new Error(`No client socket for shard ${shardId}`)
        return socket
    }

    return {
        identifies,
        ready(command: Command, echoedShard = shardTuple(command)) {
            const [shardId] = shardTuple(command)
            gateway.dispatch(
                "READY",
                { session_id: `fixture-${shardId}`, shard: echoedShard },
                gateway.sockets[command.connection],
            )
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
            await vi.waitFor(() => expect(this.clientClosed(shardId)).toBe(true), { interval: 5 })
        },
        async close() {
            transport.terminationGate?.unblock()
            transport.terminationGate = undefined
            transport.failedSocket = undefined
            transport.cleanup = undefined
            for (const socket of [...gateway.sockets, ...transport.sockets]) socket.terminate()
        },
    }
}

async function makeDriver(mode: Mode, startupTimeoutMs?: number, maxStartupAttempts?: number): Promise<Driver> {
    const options = {
        token: "fixture-only-not-a-credential",
        sharding: { totalShards: 2 },
        connection: {
            ...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }),
            ...(maxStartupAttempts === undefined ? {} : { maxStartupAttempts }),
        },
    }
    if (mode === "default") {
        const client = createClient(options)
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
    await vi.waitFor(() => expect(fixture.identifies).toHaveLength(2), { interval: 5 })
    const first = fixture.identifies.find((command) => shardTuple(command)[0] === 0)
    const second = fixture.identifies.find((command) => shardTuple(command)[0] === 1)
    if (!first || !second) throw new Error("Expected both assigned shards")
    return { first, second }
}

function expectDefaultDefect(error: unknown, expected: object) {
    expect(error).toBeInstanceOf(SdkDefect)
    expect(error).toMatchObject({
        operation: "connect",
        reasons: expect.arrayContaining([expected, expect.objectContaining({ kind: "Defect" })]),
    })
    expect(JSON.stringify(error)).toContain("private socket cleanup detail")
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
    // One startup attempt, so the invalid READY below ends startup instead of retrying with a new session
    const driver = await makeDriver(mode, undefined, 1)
    try {
        const pending = driver.defaultApi
            ? Promise.resolve(driver.defaultApi.connect())
            : Effect.runPromiseExit(driver.native!.connect())
        const { first, second } = await waitForIdentifies(fixture)
        fixture.ready(first)
        await vi.waitFor(
            () => expect(driver.client.shards.find((shard) => shard.shardId === 0)?.state).toBe("Connected"),
            { interval: 5 },
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
    const clock = sdkClock()
    const cleanup = new Error("private socket cleanup detail")
    const timeoutMs = 750
    // Two spaced shards get one extra second of startup budget for the sibling's Identify spacing
    const budgetMs = timeoutMs + 1_000
    const fixture = await gatewayFixture()
    const driver = await makeDriver(mode, timeoutMs)
    try {
        const pending = driver.defaultApi
            ? Promise.resolve(driver.defaultApi.connect())
            : Effect.runPromiseExit(driver.native!.connect())
        await vi.waitFor(() => expect(fixture.identifies).toHaveLength(1), { interval: 5 })
        const [startedShard] = shardTuple(fixture.identifies[0]!)
        const cleanupGate = fixture.failClose(startedShard, cleanup)
        await clock.advance(budgetMs)
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
                failure: expect.objectContaining({ _tag: "ConnectionTimeoutError", timeoutMs: budgetMs }),
            })
        } else {
            const exit = await (pending as Promise<Exit.Exit<void, unknown>>)
            await fixture.waitClientClosed(startedShard)
            expectNativeDefect(exit, cleanup, {
                _tag: "Fail",
                error: expect.objectContaining({ _tag: "ConnectionTimeoutError", timeoutMs: budgetMs }),
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
        await vi.waitFor(() => expect(fixture.identifies).toHaveLength(1), { interval: 5 })
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
