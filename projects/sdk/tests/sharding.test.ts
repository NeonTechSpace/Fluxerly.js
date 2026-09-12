import { once } from "node:events"
import { createServer } from "node:http"
import { Cause, Effect, Exit, Fiber, Scope, Semaphore } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import WebSocket, { WebSocketServer } from "ws"
import { createClient, type Client as DefaultClient } from "../src/index.js"
import { createClient as createNative, type Client as NativeClient } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"
import { attachIdentifyGate, type IdentifyGate } from "#sdk/internal/client"

const transport = vi.hoisted(() => ({ url: "", sockets: [] as import("ws").WebSocket[] }))
vi.mock("ws", async (original) => {
    const module = await original<typeof import("ws")>()
    return {
        ...module,
        default: class extends module.default {
            constructor(_url: string, options: import("ws").ClientOptions) {
                super(transport.url, options)
                transport.sockets.push(this)
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
    readonly receivedAt: number
}

interface RestRequest {
    readonly path: string
    readonly response: import("node:http").ServerResponse
}

type Outcome<A = unknown> =
    | { readonly kind: "success"; readonly value: A }
    | { readonly kind: "failure"; readonly error: unknown }
    | { readonly kind: "interrupted" }

interface Driver {
    readonly mode: Mode
    readonly defaultApi: DefaultClient | undefined
    readonly native: NativeClient | undefined
    readonly collectorScope: Scope.Scope
    readonly client: DefaultClient | NativeClient
    close(): Promise<void>
}

function record(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected gateway object")
    return value as Record<string, unknown>
}

function shardTuple(command: Command): readonly [number, number] {
    const shard = record(command.data).shard
    if (!Array.isArray(shard) || shard.length !== 2 || typeof shard[0] !== "number" || typeof shard[1] !== "number") {
        throw new Error("Expected sharded Identify")
    }
    return [shard[0], shard[1]]
}

function outcome<A>(exit: Exit.Exit<A, unknown>): Outcome<A> {
    if (Exit.isSuccess(exit)) return { kind: "success", value: exit.value }
    if (Cause.hasDies(exit.cause)) throw new Error("Unexpected native defect", { cause: exit.cause })
    if (Cause.hasInterruptsOnly(exit.cause)) return { kind: "interrupted" }
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    if (failure?._tag !== "Fail") throw new Error("Expected typed native failure")
    return { kind: "failure", error: failure.error }
}

async function gatewayFixture(autoReady = true, sendHelloAutomatically = true) {
    let sequence = 0
    let readyAutomatically = autoReady
    let resumeAutomatically = true
    let helloAutomatically = sendHelloAutomatically
    const connections: Connection[] = []
    const commands: Command[] = []
    const identifies: Command[] = []
    const resumes: Command[] = []
    const restRequests: RestRequest[] = []
    const sessionShards = new Map<string, number>()
    const acknowledgementDelayMs = new Map<number, number>()
    let restHandler: ((request: RestRequest) => void) | undefined
    const server = createServer((request, response) => {
        if (request.url !== "/v1/gateway/bot") {
            const rest = { path: request.url ?? "", response }
            restRequests.push(rest)
            if (restHandler) return void restHandler(rest)
            response.statusCode = 404
            response.end()
            return
        }
        response.setHeader("Content-Type", "application/json")
        response.end('{"url":"wss://gateway.fluxer.app"}')
    })
    const gateway = new WebSocketServer({ server })

    const dispatch = (connection: Connection, event: string, data: unknown) => {
        connection.socket.send(JSON.stringify({ op: 0, s: ++sequence, t: event, d: data }))
    }
    const ready = (command: Command, echoedShard = shardTuple(command)) => {
        const identifiedShard = shardTuple(command)
        command.connection.shardId = identifiedShard[0]
        sessionShards.set(`fixture-${identifiedShard[0]}`, identifiedShard[0])
        dispatch(command.connection, "READY", { session_id: `fixture-${identifiedShard[0]}`, shard: echoedShard })
    }
    const resumed = (command: Command) => dispatch(command.connection, "RESUMED", {})
    const hello = (connection: Connection) =>
        connection.socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 100 } }))

    gateway.on("connection", (socket) => {
        const connection: Connection = { socket, shardId: undefined }
        connections.push(connection)
        if (helloAutomatically) hello(connection)
        socket.on("message", (raw) => {
            const payload = record(JSON.parse(raw.toString()))
            if (typeof payload.op !== "number") throw new Error("Expected gateway opcode")
            const command: Command = {
                connection,
                op: payload.op,
                data: payload.d,
                receivedAt: performance.now(),
            }
            commands.push(command)
            if (command.op === 1) {
                const delay = acknowledgementDelayMs.get(connection.shardId ?? -1) ?? 0
                setTimeout(() => {
                    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: 11 }))
                }, delay)
            }
            if (command.op === 2) {
                identifies.push(command)
                if (readyAutomatically) ready(command)
            }
            if (command.op === 6) {
                const sessionId = record(command.data).session_id
                if (typeof sessionId !== "string") throw new Error("Expected resume session ID")
                connection.shardId = sessionShards.get(sessionId)
                resumes.push(command)
                if (resumeAutomatically) resumed(command)
            }
        })
    })

    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected owned loopback address")
    transport.url = `ws://127.0.0.1:${address.port}`
    stubFetchWithHostedDiscovery((url: string, init: RequestInit) => {
        const requested = new URL(url)
        expect(requested.origin).toBe("https://api.fluxer.app")
        return fetch(`http://127.0.0.1:${address.port}${requested.pathname}${requested.search}`, init)
    })

    return {
        connections,
        commands,
        identifies,
        resumes,
        restRequests,
        acknowledgementDelayMs,
        setRestHandler(handler: ((request: RestRequest) => void) | undefined) {
            restHandler = handler
        },
        get autoReady() {
            return readyAutomatically
        },
        set autoReady(value: boolean) {
            readyAutomatically = value
        },
        get autoResume() {
            return resumeAutomatically
        },
        set autoResume(value: boolean) {
            resumeAutomatically = value
        },
        get autoHello() {
            return helloAutomatically
        },
        set autoHello(value: boolean) {
            helloAutomatically = value
        },
        hello,
        ready,
        resumed,
        dispatch,
        byShard(shardId: number) {
            const connection = connections.find((candidate) => candidate.shardId === shardId)
            if (!connection) throw new Error(`No gateway connection for shard ${shardId}`)
            return connection
        },
        closeShard(shardId: number) {
            this.byShard(shardId).socket.close(4000)
        },
        countReply(command: Command, counts: readonly unknown[] = []) {
            const nonce = record(command.data).nonce
            if (typeof nonce !== "string") throw new Error("Expected count nonce")
            dispatch(command.connection, "GUILD_COUNTS_UPDATE", { nonce, counts })
        },
        async waitClosed() {
            await vi.waitFor(
                () => {
                    for (const socket of [...connections.map((connection) => connection.socket), ...transport.sockets])
                        expect(socket.readyState).toBe(WebSocket.CLOSED)
                },
                { interval: 5, timeout: 4_000 },
            )
        },
        async close() {
            for (const socket of [...connections.map((connection) => connection.socket), ...transport.sockets])
                socket.terminate()
            await new Promise<void>((resolve) => gateway.close(() => resolve()))
            server.closeAllConnections()
            await new Promise<void>((resolve) => server.close(() => resolve()))
        },
    }
}

async function makeDriver(
    mode: Mode,
    sharding: { readonly totalShards: number; readonly shardIds?: readonly number[] },
    connection?: { readonly startupTimeoutMs?: number; readonly maxStartupAttempts?: number },
    cacheMessages = false,
): Promise<Driver> {
    const options = {
        token: "fixture-only-not-a-credential",
        sharding,
        ...(connection ? { connection } : {}),
        ...(cacheMessages ? { cache: { messages: true } } : {}),
    }
    const collectorScope = Scope.makeUnsafe()
    if (mode === "default") {
        const client = createClient(options)._unsafeUnwrap()
        return {
            mode,
            defaultApi: client,
            native: undefined,
            collectorScope,
            client,
            async close() {
                const result = await client.shutdown()
                if (result.isErr()) throw result.error
                await Effect.runPromise(Scope.close(collectorScope, Exit.void))
            },
        }
    }
    const scope = Scope.makeUnsafe()
    const client = await Effect.runPromise(createNative(options).pipe(Scope.provide(scope)))
    return {
        mode,
        defaultApi: undefined,
        native: client,
        collectorScope,
        client,
        async close() {
            await Effect.runPromise(client.shutdown())
            await Effect.runPromise(Scope.close(collectorScope, Exit.void))
            await Effect.runPromise(Scope.close(scope, Exit.void))
        },
    }
}

async function connect(driver: Driver, signal?: AbortSignal): Promise<Outcome<void>> {
    if (driver.defaultApi) {
        const result = await driver.defaultApi.connect(signal ? { signal } : undefined)
        return result.isOk() ? { kind: "success", value: result.value } : { kind: "failure", error: result.error }
    }
    return outcome(await Effect.runPromiseExit(driver.native!.connect()))
}

function startConnect(driver: Driver) {
    if (driver.defaultApi) {
        const controller = new AbortController()
        return { done: connect(driver, controller.signal), cancel: () => controller.abort() }
    }
    const fiber = Effect.runFork(driver.native!.connect())
    return {
        done: Effect.runPromiseExit(Fiber.join(fiber)).then(outcome),
        cancel: () => Effect.runPromise(Fiber.interrupt(fiber)),
    }
}

async function fetchCounts(driver: Driver, guildIds: readonly string[]): Promise<Outcome<unknown>> {
    if (driver.defaultApi) {
        const result = await driver.defaultApi.guilds.fetchCounts(guildIds)
        return result.isOk() ? { kind: "success", value: result.value } : { kind: "failure", error: result.error }
    }
    return outcome(await Effect.runPromiseExit(driver.native!.guilds.fetchCounts(guildIds)))
}

const cachedTarget = { id: "10", channelId: "20" }

async function cachedMessage(driver: Driver) {
    if (driver.defaultApi) {
        const result = driver.defaultApi.messages.get(cachedTarget)
        if (result.isErr()) throw result.error
        return result.value
    }
    return Effect.runPromise(driver.native!.messages.get(cachedTarget))
}

async function fetchMessage(driver: Driver) {
    if (driver.defaultApi) {
        const result = await driver.defaultApi.messages.fetch(cachedTarget)
        if (result.isErr()) throw result.error
        return result.value
    }
    return Effect.runPromise(driver.native!.messages.fetch(cachedTarget))
}

async function openCollector(driver: Driver, channelId: string, guildId: string | undefined) {
    const options = guildId === undefined ? { maxMessages: 1 } : { guildId, maxMessages: 1 }
    if (driver.defaultApi) {
        const opened = driver.defaultApi.messages.collect(channelId, options)
        if (opened.isErr()) throw opened.error
        return {
            wait: async () =>
                opened.value
                    .waitForClose()
                    .then((result) =>
                        result.isOk()
                            ? ({ kind: "success", value: result.value } as Outcome)
                            : ({ kind: "failure", error: result.error } as Outcome),
                    ),
        }
    }
    const collector = await Effect.runPromise(
        driver.native!.messages.collect(channelId, options).pipe(Scope.provide(driver.collectorScope)),
    )
    return { wait: () => Effect.runPromiseExit(collector.waitForClose()).then(outcome) }
}

async function setup(
    mode: Mode,
    sharding: { readonly totalShards: number; readonly shardIds?: readonly number[] },
    autoReady = true,
    connection?: { readonly startupTimeoutMs?: number; readonly maxStartupAttempts?: number },
    autoHello = true,
    cacheMessages = false,
) {
    const fixture = await gatewayFixture(autoReady, autoHello)
    const driver = await makeDriver(mode, sharding, connection, cacheMessages)
    onTestFinished(async () => {
        await driver.close()
        await fixture.close()
    })
    return { fixture, driver }
}

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    transport.sockets = []
})

test.each(modes)("%s waits for both sharded READY frames and exposes immutable aggregate state", async (mode) => {
    const { fixture, driver } = await setup(mode, { totalShards: 2 }, false, undefined, false)
    fixture.acknowledgementDelayMs.set(0, 45)
    fixture.acknowledgementDelayMs.set(1, 1)
    let settled = false
    const startup = connect(driver).then((value) => {
        settled = true
        return value
    })

    await vi.waitFor(() => expect(fixture.connections).toHaveLength(2), { interval: 5, timeout: 2_000 })
    // Socket creation races do not select a shard. Holding one Hello exercises pacing at actual Identify send time
    fixture.hello(fixture.connections[1]!)
    await new Promise((resolve) => setTimeout(resolve, 900))
    fixture.hello(fixture.connections[0]!)
    await vi.waitFor(() => expect(fixture.identifies).toHaveLength(2), { interval: 5, timeout: 4_000 })
    const identifies = [...fixture.identifies]
    expect(identifies.map(shardTuple).sort((left, right) => left[0] - right[0])).toEqual([
        [0, 2],
        [1, 2],
    ])
    expect(identifies[1]!.receivedAt - identifies[0]!.receivedAt).toBeGreaterThanOrEqual(995)
    expect(driver.client.state).toBe("Connecting")
    expect(driver.client.gatewayLatencyMs).toBe(null)
    const connectingSnapshot = driver.client.shards
    expect(connectingSnapshot.map((shard) => ({ shardId: shard.shardId, state: shard.state }))).toEqual([
        { shardId: 0, state: "Connecting" },
        { shardId: 1, state: "Connecting" },
    ])
    expect(Object.isFrozen(connectingSnapshot)).toBe(true)
    expect(connectingSnapshot.every(Object.isFrozen)).toBe(true)
    expect(() => (connectingSnapshot as unknown as unknown[]).push({})).toThrow(TypeError)

    fixture.ready(identifies[0]!)
    await vi.waitFor(() =>
        expect(driver.client.shards.find((shard) => shard.shardId === shardTuple(identifies[0]!)[0])?.state).toBe(
            "Connected",
        ),
    )
    expect(driver.client.state).toBe("Connecting")
    expect(settled).toBe(false)
    fixture.ready(identifies[1]!)
    expect(await startup).toEqual({ kind: "success", value: undefined })
    expect(driver.client.state).toBe("Connected")

    await vi.waitFor(() => expect(driver.client.shards.every((shard) => shard.gatewayLatencyMs !== null)).toBe(true), {
        interval: 5,
        timeout: 2_000,
    })
    const readySnapshot = driver.client.shards
    const latencies = readySnapshot.map((shard) => shard.gatewayLatencyMs!)
    expect(driver.client.gatewayLatencyMs).toBe(Math.max(...latencies))

    await driver.close()
    await fixture.waitClosed()
    expect(driver.client.state).toBe("Closed")
    expect(driver.client.shards.map((shard) => shard.state)).toEqual(["Closed", "Closed"])
})

test.each(modes)("%s resumes only a failed shard while its healthy sibling remains usable", async (mode) => {
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const { fixture, driver } = await setup(mode, { totalShards: 2 })
    expect(await connect(driver)).toEqual({ kind: "success", value: undefined })
    await vi.waitFor(() => expect(fixture.identifies).toHaveLength(2), { interval: 5, timeout: 4_000 })
    fixture.autoResume = false
    fixture.closeShard(0)

    await vi.waitFor(() => expect(driver.client.state).toBe("Recovering"), { interval: 5, timeout: 2_000 })
    expect(driver.client.gatewayLatencyMs).toBe(null)
    expect(driver.client.shards).toEqual([
        {
            shardId: 0,
            state: "Recovering",
            gatewayLatencyMs: null,
            recovery: { phase: "recovery", attempt: 1, retryDelayMs: 500 },
        },
        expect.objectContaining({ shardId: 1, state: "Connected", recovery: null }),
    ])

    const pending = fetchCounts(driver, ["4194304"])
    await vi.waitFor(() => expect(fixture.commands.filter((command) => command.op === 15)).toHaveLength(1), {
        interval: 5,
        timeout: 2_000,
    })
    const count = fixture.commands.find((command) => command.op === 15)!
    expect(count.connection.shardId).toBe(1)
    fixture.countReply(count)
    expect(await pending).toEqual({ kind: "success", value: { counts: [], omittedGuildIds: ["4194304"] } })

    await vi.waitFor(() => expect(fixture.resumes).toHaveLength(1), { interval: 5, timeout: 2_000 })
    expect(fixture.identifies).toHaveLength(2)
    expect(fixture.resumes[0]!.connection.shardId).toBe(0)
    fixture.resumed(fixture.resumes[0]!)
    await vi.waitFor(() => expect(driver.client.state).toBe("Connected"), { interval: 5, timeout: 2_000 })
    expect(driver.client.shards).toEqual([
        expect.objectContaining({ shardId: 0, state: "Connected", recovery: null }),
        expect.objectContaining({ shardId: 1, state: "Connected", recovery: null }),
    ])
})

test.each(modes)("%s keeps a guild-scoped collector alive across another shard's gateway gap", async (mode) => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    const { fixture, driver } = await setup(mode, { totalShards: 2 })
    expect(await connect(driver)).toEqual({ kind: "success", value: undefined })
    const scoped = await openCollector(driver, "20", "4194304")
    const legacy = await openCollector(driver, "21", undefined)
    fixture.autoResume = false
    fixture.closeShard(0)

    await vi.waitFor(() => expect(driver.client.state).toBe("Recovering"), { interval: 5, timeout: 2_000 })
    expect(await legacy.wait()).toMatchObject({
        kind: "failure",
        error: { _tag: "CollectorError", reason: "connectionLost" },
    })
    fixture.dispatch(fixture.byShard(1), "MESSAGE_CREATE", {
        id: "900",
        channel_id: "20",
        guild_id: "4194304",
        content: "healthy shard",
        author: { id: "30", username: "fixture", bot: true },
    })
    await expect(scoped.wait()).resolves.toEqual({
        kind: "success",
        value: expect.objectContaining({ reason: "limit", messages: [expect.objectContaining({ id: "900" })] }),
    })
})

test.each(modes)("%s distinguishes an unassigned route from a provider count omission", async (mode) => {
    const { fixture, driver } = await setup(mode, { totalShards: 2, shardIds: [0] })
    expect(await connect(driver)).toEqual({ kind: "success", value: undefined })
    expect(fixture.identifies.map(shardTuple)).toEqual([[0, 2]])

    await expect(fetchCounts(driver, ["4194304"])).resolves.toMatchObject({
        kind: "failure",
        error: { _tag: "CountOperationError", reason: "notConnected" },
    })
    expect(fixture.commands.filter((command) => command.op === 15)).toEqual([])

    const pending = fetchCounts(driver, ["1"])
    await vi.waitFor(() => expect(fixture.commands.filter((command) => command.op === 15)).toHaveLength(1), {
        interval: 5,
        timeout: 2_000,
    })
    fixture.countReply(fixture.commands.find((command) => command.op === 15)!)
    await expect(pending).resolves.toEqual({ kind: "success", value: { counts: [], omittedGuildIds: ["1"] } })
})

test.each(modes)("%s reports invalid shard READY with context after closing waiting siblings", async (mode) => {
    const { fixture, driver } = await setup(mode, { totalShards: 2 }, false)
    const startup = connect(driver)
    await vi.waitFor(() => expect(fixture.identifies).toHaveLength(2), { interval: 5, timeout: 4_000 })
    const failing = fixture.identifies[1]!
    const [shardId, totalShards] = shardTuple(failing)
    fixture.ready(failing, [(shardId + 1) % totalShards, totalShards])

    await expect(startup).resolves.toMatchObject({
        kind: "failure",
        error: {
            _tag: "ShardConnectionError",
            shardId,
            failure: { _tag: "ConnectionError", phase: "gateway", reason: "protocol" },
        },
    })
    expect(driver.client.state).toBe("Disconnected")
    await fixture.waitClosed()
})

test.each(modes)(
    "%s retains a permanent required-shard failure after full readiness and closes its sibling",
    async (mode) => {
        const { fixture, driver } = await setup(mode, { totalShards: 2 })
        expect(await connect(driver)).toEqual({ kind: "success", value: undefined })
        const observe = async (): Promise<Outcome<void>> => {
            if (driver.defaultApi) {
                const result = await driver.defaultApi.waitForClose()
                return result.isOk()
                    ? { kind: "success", value: result.value }
                    : { kind: "failure", error: result.error }
            }
            return outcome(await Effect.runPromiseExit(driver.native!.waitForClose()))
        }
        const waiting = observe()
        fixture.byShard(1).socket.close(4011)
        const failure = await waiting
        expect(failure).toMatchObject({
            kind: "failure",
            error: {
                _tag: "ShardConnectionError",
                shardId: 1,
                message: expect.stringContaining("requires additional shards"),
                failure: { _tag: "ConnectionError", reason: "protocol", status: 4011 },
            },
        })
        await fixture.waitClosed()
        expect(driver.client.state).toBe("Closed")
        expect(driver.client.shards.every((shard) => shard.state === "Closed" && shard.gatewayLatencyMs === null)).toBe(
            true,
        )
        expect(await observe()).toEqual(failure)
    },
)

test.each(modes)(
    "%s clears ready-shard cache and collectors when startup fails before group readiness",
    async (mode) => {
        const { fixture, driver } = await setup(mode, { totalShards: 2 }, false, undefined, true, true)
        const startup = connect(driver)
        await vi.waitFor(() => expect(fixture.identifies).toHaveLength(2), { interval: 5, timeout: 4_000 })
        const ready = fixture.identifies[0]!
        const readyShardId = shardTuple(ready)[0]
        const guildId = readyShardId === 0 ? "1" : "4194304"
        fixture.ready(ready)
        await vi.waitFor(
            () => expect(driver.client.shards.find((shard) => shard.shardId === readyShardId)?.state).toBe("Connected"),
            { interval: 5, timeout: 2_000 },
        )
        fixture.dispatch(ready.connection, "MESSAGE_CREATE", {
            id: cachedTarget.id,
            channel_id: cachedTarget.channelId,
            guild_id: guildId,
            content: "gateway seed",
            author: { id: "30", username: "fixture", bot: true },
        })
        await vi.waitFor(() => cachedMessage(driver).then((message) => expect(message?.content).toBe("gateway seed")), {
            interval: 5,
            timeout: 2_000,
        })
        const collector = await openCollector(driver, "20", guildId)

        let reply!: () => void
        fixture.setRestHandler((request) => {
            expect(request.path).toBe("/v1/channels/20/messages/10")
            reply = () =>
                request.response.end(
                    JSON.stringify({
                        id: cachedTarget.id,
                        channel_id: cachedTarget.channelId,
                        guild_id: guildId,
                        content: "late REST",
                        author: { id: "30", username: "fixture", bot: true },
                    }),
                )
        })
        const stale = fetchMessage(driver)
        await vi.waitFor(() => expect(fixture.restRequests).toHaveLength(1), { interval: 5, timeout: 2_000 })

        const failing = fixture.identifies[1]!
        const [failingShardId, totalShards] = shardTuple(failing)
        fixture.ready(failing, [(failingShardId + 1) % totalShards, totalShards])
        await expect(startup).resolves.toMatchObject({
            kind: "failure",
            error: { _tag: "ShardConnectionError", shardId: failingShardId },
        })
        expect(driver.client.state).toBe("Disconnected")
        await expect(collector.wait()).resolves.toMatchObject({
            kind: "failure",
            error: { _tag: "CollectorError", reason: "connectionLost" },
        })
        expect(await cachedMessage(driver)).toBeUndefined()

        reply()
        await expect(stale).resolves.toMatchObject({ content: "late REST" })
        expect(await cachedMessage(driver)).toBeUndefined()

        fixture.autoReady = true
        expect(await connect(driver)).toEqual({ kind: "success", value: undefined })
        expect(await cachedMessage(driver)).toBeUndefined()
    },
)

test.each(modes)("%s preserves the aggregate startup deadline when a ready shard starts recovering", async (mode) => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    const { fixture, driver } = await setup(mode, { totalShards: 2 }, false, { startupTimeoutMs: 2_500 })
    const startup = connect(driver)
    await vi.waitFor(() => expect(fixture.identifies).toHaveLength(2), { interval: 5, timeout: 4_000 })
    const ready = fixture.identifies[0]!
    fixture.ready(ready)
    await vi.waitFor(
        () =>
            expect(driver.client.shards.find((shard) => shard.shardId === shardTuple(ready)[0])?.state).toBe(
                "Connected",
            ),
        { interval: 5, timeout: 2_000 },
    )
    fixture.autoResume = false
    fixture.closeShard(shardTuple(ready)[0])

    await vi.waitFor(
        () =>
            expect(driver.client.shards.find((shard) => shard.shardId === shardTuple(ready)[0])?.state).toBe(
                "Recovering",
            ),
        { interval: 5, timeout: 2_000 },
    )
    expect(driver.client.state).toBe("Connecting")
    await vi.waitFor(() => expect(fixture.resumes).toHaveLength(1), { interval: 5, timeout: 2_000 })
    await expect(startup).resolves.toMatchObject({
        kind: "failure",
        error: { _tag: "ConnectionTimeoutError", timeoutMs: 2_500 },
    })
    await fixture.waitClosed()
})

test.each(modes)("%s cancels sharded startup before a scheduled sibling Identify", async (mode) => {
    const { fixture, driver } = await setup(mode, { totalShards: 2 }, false)
    const startup = startConnect(driver)
    await vi.waitFor(() => expect(fixture.identifies).toHaveLength(1), { interval: 5, timeout: 2_000 })
    await startup.cancel()
    const result = await startup.done
    expect(result.kind).toBe(mode === "default" ? "failure" : "interrupted")
    if (result.kind === "failure") expect(result.error).toMatchObject({ _tag: "CancelledError" })
    expect(driver.client.state).toBe("Disconnected")
    await fixture.waitClosed()
    fixture.autoReady = true
    expect(await connect(driver)).toEqual({ kind: "success", value: undefined })
    expect(fixture.identifies).toHaveLength(3)
    expect(fixture.identifies[1]!.receivedAt - fixture.identifies[0]!.receivedAt).toBeGreaterThanOrEqual(995)
})

test("an attached parent permit spaces fresh Identifies and bypasses Resume", async () => {
    const fixture = await gatewayFixture()
    const scope = Scope.makeUnsafe()
    const permits: number[] = []
    const serial = Semaphore.makeUnsafe(1)
    let next = 0
    const gate: IdentifyGate = {
        permit: (_shardId, send) =>
            serial.withPermit(
                Effect.gen(function* () {
                    const wait = next - performance.now()
                    if (wait > 0) yield* Effect.sleep(wait)
                    permits.push(performance.now())
                    send()
                    next = performance.now() + 45
                }),
            ),
    }
    const first = await Effect.runPromise(
        createNative(
            attachIdentifyGate(
                { token: "fixture-only-not-a-credential", sharding: { totalShards: 2, shardIds: [0] } },
                gate,
            ),
        ).pipe(Scope.provide(scope)),
    )
    const second = await Effect.runPromise(
        createNative(
            attachIdentifyGate(
                { token: "fixture-only-not-a-credential", sharding: { totalShards: 2, shardIds: [1] } },
                gate,
            ),
        ).pipe(Scope.provide(scope)),
    )
    onTestFinished(async () => {
        await Effect.runPromise(first.shutdown())
        await Effect.runPromise(second.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
        await fixture.close()
    })
    try {
        await Promise.all([Effect.runPromise(first.connect()), Effect.runPromise(second.connect())])
        await vi.waitFor(() => expect(fixture.identifies).toHaveLength(2), { interval: 5, timeout: 2_000 })
        expect(permits).toHaveLength(2)
        expect(fixture.identifies[1]!.receivedAt - fixture.identifies[0]!.receivedAt).toBeGreaterThanOrEqual(40)
        fixture.closeShard(0)
        await vi.waitFor(() => expect(fixture.resumes).toHaveLength(1), { interval: 5, timeout: 2_000 })
        expect(permits).toHaveLength(2)
    } finally {
        await Effect.runPromise(first.shutdown())
        await Effect.runPromise(second.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
        await fixture.close()
    }
})
