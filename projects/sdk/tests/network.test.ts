import { createServer } from "node:http"
import { once } from "node:events"
import { inspect } from "node:util"
import { Cause, Clock, Effect, Exit, Fiber, Scope, Stream, Logger, References } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { WebSocketServer, WebSocket } from "ws"
import { createClient, SdkDefect, type ClientOptions } from "../src/index.js"
import { createClient as createNative, fromEffectLogger } from "../src/effect.js"
import { hostedDiscoveryDocument } from "./hosted-discovery.js"
import { startServer } from "./transport/server.js"

const transport = vi.hoisted(() => ({ url: "", sockets: [] as import("ws").WebSocket[] }))
vi.mock("ws", async (original) => {
    const module = await original<typeof import("ws")>()
    return {
        ...module,
        default: class extends module.default {
            constructor(url: string, options: import("ws").ClientOptions) {
                expect(url).toBe("wss://gateway.fluxer.app/?v=1&encoding=json")
                super(transport.url, options)
                transport.sockets.push(this)
            }
        },
    }
})
function capturedLogs(throws = false) {
    const entries: { message: unknown; cause: unknown; annotation: unknown; span: unknown }[] = []
    const logger = Logger.make((entry) => {
        entries.push({
            message: entry.message,
            cause: entry.cause,
            annotation: entry.fiber.getRef(References.CurrentLogAnnotations).requestId,
            span: entry.fiber.cache.span?._tag === "Span" ? entry.fiber.cache.span.name : undefined,
        })
        if (throws) throw new Error("private-logger-sentinel")
    })
    const diagnostics = () =>
        entries.flatMap((entry) => {
            const message = entry.message
            return Array.isArray(message) && message[0] === "Fluxerly" ? [message[1] as Record<string, unknown>] : []
        })
    return { entries, logger, diagnostics }
}

test("default development logging is opt-in, client-local and respects its minimum level", async () => {
    await fixture()
    const enabled = capturedLogs()
    const disabled = capturedLogs()
    const filtered = capturedLogs()
    const clients = [
        defaultApi(undefined, { development: true, logger: fromEffectLogger(enabled.logger) }),
        defaultApi(undefined, { logger: fromEffectLogger(disabled.logger) }),
        defaultApi(undefined, { development: true, minimumLevel: "Error", logger: fromEffectLogger(filtered.logger) }),
    ]
    for (const client of clients) {
        expect((await client.connect()).isOk()).toBe(true)
        expect((await client.shutdown()).isOk()).toBe(true)
    }
    expect(enabled.diagnostics().map((entry) => entry.event)).toEqual([
        "connecting",
        "attempt",
        "connected",
        "closing",
        "closed",
    ])
    expect(disabled.entries).toEqual([])
    expect(filtered.entries).toEqual([])
    expect(enabled.diagnostics().find((entry) => entry.event === "connected")).toMatchObject({
        phase: "startup",
        mode: "identify",
        attempt: 1,
    })
})

test("default development output needs no custom logger", async () => {
    await fixture()
    const output = vi.spyOn(console, "log").mockImplementation(() => {})
    const client = defaultApi(undefined, { development: true })
    await client.connect()
    await client.shutdown()
    expect(output.mock.calls.some((args) => args.some((arg) => String(arg).includes("Fluxerly")))).toBe(true)
})

test.each([false, true])(
    "native diagnostics preserve execution annotations and require opt-in: %s",
    async (development) => {
        await fixture()
        const captured = capturedLogs()
        const scope = Scope.makeUnsafe()
        const client = await Effect.runPromise(
            createNative({ token: "fixture-only-not-a-credential", logging: { development } }).pipe(
                Scope.provide(scope),
            ),
        )
        await Effect.runPromise(
            Effect.gen(function* () {
                yield* client.connect()
                yield* client.shutdown()
            }).pipe(
                Effect.withLogger(captured.logger),
                Effect.annotateLogs("requestId", "execution"),
                Effect.withSpan("connection-owner"),
                Effect.provideService(References.MinimumLogLevel, "Debug"),
            ),
        )
        await Effect.runPromise(Scope.close(scope, Exit.void))
        expect(captured.entries.length > 0).toBe(development)
        expect(captured.entries.every((entry) => entry.annotation === "execution")).toBe(true)
        expect(captured.entries.every((entry) => entry.span === "connection-owner")).toBe(true)
    },
)

test.each(["default", "native"] as const)(
    "%s diagnostics survive throwing loggers and classify recovery without private data",
    async (mode) => {
        const server = await fixture()
        const captured = capturedLogs(true)
        const scope = Scope.makeUnsafe()
        const client =
            mode === "default"
                ? defaultApi(undefined, { development: true, logger: fromEffectLogger(captured.logger) })
                : await Effect.runPromise(
                      createNative({ token: "fixture-only-not-a-credential", logging: { development: true } }).pipe(
                          Scope.provide(scope),
                      ),
                  )
        const connect = client.connect()
        if (Effect.isEffect(connect)) await Effect.runPromise(connect.pipe(Effect.withLogger(captured.logger)))
        else expect((await connect).isOk()).toBe(true)
        onTestFinished(async () => {
            const closing = client.shutdown()
            if (Effect.isEffect(closing)) await Effect.runPromise(closing)
            else await closing
            await Effect.runPromise(Scope.close(scope, Exit.void))
        })
        server.sockets[0]!.close(4000, "private-close-sentinel")
        await vi.waitFor(
            () =>
                expect(
                    captured.diagnostics().some((entry) => entry.event === "connected" && entry.mode === "resume"),
                ).toBe(true),
            { timeout: 3500 },
        )
        server.options.invalidResume = true
        server.sockets.at(-1)!.close(4000)
        await vi.waitFor(
            () => expect(captured.diagnostics().some((entry) => entry.event === "sessionReset")).toBe(true),
            { timeout: 8000 },
        )
        await vi.waitFor(
            () =>
                expect(
                    captured
                        .diagnostics()
                        .some(
                            (entry) =>
                                entry.event === "connected" && entry.phase === "recovery" && entry.mode === "identify",
                        ),
                ).toBe(true),
            { timeout: 8000 },
        )
        const retry = captured.diagnostics().find((entry) => entry.event === "retry")!
        expect(retry.delayMs).toEqual(expect.any(Number))
        expect(retry.failure).toBe("closed")
        const serialized = JSON.stringify(captured.entries)
        for (const privateValue of [
            "fixture-only-not-a-credential",
            "fixture-session",
            "private-close-sentinel",
            "private-logger-sentinel",
            "gateway.fluxer.app",
        ])
            expect(serialized).not.toContain(privateValue)
        expect(captured.entries.every((entry) => (entry.cause as Cause.Cause<unknown>).reasons.length === 0)).toBe(true)
    },
    20_000,
)

test("default observer errors use the configured logger with development disabled", async () => {
    const captured = capturedLogs(true)
    const client = defaultApi(undefined, { logger: fromEffectLogger(captured.logger) })
    const stop = client.observeState(() => {
        throw new Error("private-observer-sentinel")
    })
    await vi.waitFor(() => expect(captured.entries).toHaveLength(1))
    stop()
    await client.shutdown()
    expect(JSON.stringify(captured.entries)).toContain("Fluxerly state observer failed")
    expect(JSON.stringify(captured.entries)).not.toContain("private-observer-sentinel")
})

test.each([
    [null, "logging"],
    [{ development: "yes" }, "development"],
    [{ minimumLevel: "verbose" }, "minimumLevel"],
    [{ minimumLevel: null }, "minimumLevel"],
    [{ logger: {} }, "logger"],
    [{ unknown: true }, "logging"],
])("invalid logging configuration fails before connection: %j", (logging, field) => {
    const result = createClient({ token: "fixture-only-not-a-credential", logging } as unknown as ClientOptions)
    expect(result._unsafeUnwrapErr()).toMatchObject({ _tag: "ConfigurationError", field })
})

test("native options reject default logger controls, and the adapter rejects a non-Effect logger", async () => {
    const exit = await Effect.runPromiseExit(
        Effect.scoped(
            createNative({
                token: "fixture-only-not-a-credential",
                logging: { minimumLevel: "Info" },
            } as unknown as import("../src/effect.js").ClientOptions),
        ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit))
        expect(exit.cause.reasons).toEqual([
            expect.objectContaining({ error: expect.objectContaining({ field: "logging" }) }),
        ])
    expect(() => fromEffectLogger({ log() {} } as unknown as Logger.Logger<unknown, unknown>)).toThrow(
        "Expected an Effect logger",
    )
})
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    transport.sockets = []
})

async function fixture(
    options: {
        holdReady?: boolean
        holdHello?: boolean
        reject?: number
        invalidResume?: boolean
        interval?: number
        noAck?: boolean
        httpStatus?: number
        retryAfter?: number
    } = {},
) {
    let discoveryRequests = 0
    const commands: { op: number; d: Record<string, unknown> | number | null }[] = []
    const sockets: WebSocket[] = []
    const server = createServer()
    const gateway = new WebSocketServer({ server })
    gateway.on("connection", (socket) => {
        sockets.push(socket)
        if (!options.holdHello)
            socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: options.interval ?? 1000 } }))
        socket.on("message", (data) => {
            const command = JSON.parse(data.toString())
            commands.push(command)
            if (command.op === 1 && !options.noAck) socket.send(JSON.stringify({ op: 11 }))
            if (command.op === 2 || command.op === 6) {
                if (options.reject) {
                    socket.close(options.reject)
                    return
                }
                if (options.holdReady) return
                if (command.op === 6 && options.invalidResume) {
                    socket.send(JSON.stringify({ op: 9, d: false }))
                    return
                }
                socket.send(
                    JSON.stringify({
                        op: 0,
                        s: command.op === 6 ? command.d.seq : 1,
                        t: command.op === 6 ? "RESUMED" : "READY",
                        d: { session_id: "fixture-session" },
                    }),
                )
            }
        })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected loopback listener")
    transport.url = `ws://127.0.0.1:${address.port}`
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: RequestInit) => {
            expect(url).toBe("https://fluxer.app/.well-known/fluxer")
            expect(init).toMatchObject({ method: "GET", redirect: "manual" })
            discoveryRequests++
            if (options.httpStatus === 429)
                return Response.json({ retry_after: options.retryAfter ?? 0.001 }, { status: options.httpStatus })
            if (options.httpStatus) return new Response(null, { status: options.httpStatus })
            return Response.json(hostedDiscoveryDocument)
        }),
    )
    onTestFinished(async () => {
        for (const socket of sockets) socket.terminate()
        for (const socket of transport.sockets) socket.terminate()
        await new Promise<void>((resolve) => gateway.close(() => resolve()))
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return { sockets, commands, discoveryRequests: () => discoveryRequests, options }
}

function defaultApi(connection?: ClientOptions["connection"], logging?: ClientOptions["logging"]) {
    const result = createClient({
        token: "fixture-only-not-a-credential",
        ...(connection ? { connection } : {}),
        ...(logging ? { logging } : {}),
    })
    if (result.isErr()) throw result.error
    onTestFinished(async () => {
        await result.value.shutdown()
    })
    return result.value
}

test("default connect waits for READY, keeps its session after startup cancellation and awaits shared shutdown", async () => {
    const server = await fixture({ holdReady: true, interval: 60_000 })
    const client = defaultApi()
    const controller = new AbortController()
    let completed = false
    const connecting = client.connect({ signal: controller.signal }).andTee(() => {
        completed = true
    })
    await vi.waitFor(() => expect(server.commands.some((command) => command.op === 2)).toBe(true))
    expect(client.state).toBe("Connecting")
    expect(completed).toBe(false)
    expect(client.gatewayLatencyMs).toBe(null)
    const socket = server.sockets[0]!
    socket.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "fixture-session" } }))
    expect((await connecting).isOk()).toBe(true)
    controller.abort()
    expect(client.state).toBe("Connected")
    expect((await client.connect()).isOk()).toBe(true)
    // Request the measured heartbeat after READY rather than racing its scheduled timer
    socket.send(JSON.stringify({ op: 1 }))
    await vi.waitFor(() => expect(client.gatewayLatencyMs).not.toBe(null))
    expect(server.sockets).toHaveLength(1)
    expect(server.commands.find((command) => command.op === 1)?.d).toBe(1)
    const [first, second] = await Promise.all([client.shutdown(), client.shutdown()])
    expect(first.isOk() && second.isOk()).toBe(true)
    expect(client.state).toBe("Closed")
    expect(client.gatewayLatencyMs).toBe(null)
    expect((await client.waitForClose()).isOk()).toBe(true)
    expect((await client.connect())._unsafeUnwrapErr()._tag).toBe("ClientClosedError")
    for (const socket of transport.sockets) {
        expect(socket.readyState).toBe(WebSocket.CLOSED)
        for (const event of ["open", "message", "error", "close"]) expect(socket.listenerCount(event)).toBe(0)
    }
})

test("standalone cancellation finishes cleanup and permits a fresh startup", async () => {
    const server = await fixture({ holdReady: true })
    const client = defaultApi()
    const controller = new AbortController()
    const connecting = client.connect({ signal: controller.signal })
    await vi.waitFor(() => expect(server.commands).toHaveLength(1))
    controller.abort()
    expect((await connecting)._unsafeUnwrapErr()._tag).toBe("CancelledError")
    expect(client.state).toBe("Disconnected")
    expect(transport.sockets[0]!.readyState).toBe(WebSocket.CLOSED)
    server.options.holdReady = false
    expect((await client.connect()).isOk()).toBe(true)
    expect(server.sockets).toHaveLength(2)
})

test("competing connect and rejected run do not take ownership; shutdown during startup reports closed", async () => {
    const server = await fixture({ holdReady: true })
    const client = defaultApi()
    const connecting = client.connect()
    await vi.waitFor(() => expect(server.commands).toHaveLength(1))
    expect((await client.connect())._unsafeUnwrapErr()._tag).toBe("ClientBusyError")
    expect((await client.run())._unsafeUnwrapErr()._tag).toBe("ClientBusyError")
    expect(client.state).toBe("Connecting")
    await client.shutdown()
    expect((await connecting)._unsafeUnwrapErr()._tag).toBe("ClientClosedError")
    expect(client.state).toBe("Closed")
})

test("managed cancellation owns the full lifetime, while rejected run leaves a connected client active", async () => {
    await fixture()
    const client = defaultApi()
    const controller = new AbortController()
    const running = client.run({ signal: controller.signal })
    await vi.waitFor(() => expect(client.state).toBe("Connected"))
    expect((await client.run())._unsafeUnwrapErr()._tag).toBe("ClientBusyError")
    controller.abort()
    expect((await running)._unsafeUnwrapErr()._tag).toBe("CancelledError")
    expect(client.state).toBe("Closed")
})

test("one cancelled lifetime waiter leaves other and late observers intact", async () => {
    await fixture()
    const client = defaultApi()
    await client.connect()
    const controller = new AbortController()
    const cancelled = client.waitForClose({ signal: controller.signal })
    const other = client.waitForClose()
    controller.abort()
    expect((await cancelled)._unsafeUnwrapErr()._tag).toBe("CancelledError")
    expect(client.state).toBe("Connected")
    await client.shutdown()
    expect((await other).isOk()).toBe(true)
    expect((await client.waitForClose()).isOk()).toBe(true)
})

test.each([
    [4004, "bot credential"],
    [4002, "invalid payload"],
    [4010, "shard assignment"],
    [4011, "additional shards"],
    [4012, "API version"],
] as const)("permanent rejection %s is explained and not retried", async (code, explanation) => {
    const server = await fixture({ reject: code })
    const client = defaultApi()
    const result = await client.connect()
    expect(result._unsafeUnwrapErr()._tag).toBe(code === 4004 ? "AuthenticationError" : "ConnectionError")
    expect(result._unsafeUnwrapErr().message).toContain(explanation)
    if (code !== 4004) expect(result._unsafeUnwrapErr().message).toContain(String(code))
    expect(client.state).toBe("Disconnected")
    expect(server.sockets).toHaveLength(1)
    expect(inspect(result)).not.toContain("fixture-only-not-a-credential")
})

test("startup deadline ends a silent handshake and run closes permanently on failure", async () => {
    await fixture({ holdHello: true })
    const client = defaultApi({ startupTimeoutMs: 80, maxStartupAttempts: 1 })
    const result = await client.run()
    expect(result._unsafeUnwrapErr()._tag).toBe("ConnectionTimeoutError")
    expect(client.state).toBe("Closed")
})

test("a server wait exceeding the startup budget is returned rather than retried early", async () => {
    const server = await fixture({ httpStatus: 429, retryAfter: 0.75 })
    const client = defaultApi({ startupTimeoutMs: 200 })
    const error = (await client.connect())._unsafeUnwrapErr()
    expect(error._tag).toBe("RateLimitError")
    if (error._tag === "RateLimitError") {
        expect(error.retryAfterMs).toBe(750)
        expect(error.message).toContain("750 ms")
    }
    expect(server.discoveryRequests()).toBe(1)
    expect(server.sockets).toHaveLength(0)
})

test("connection recovery resumes with the processed sequence, then falls back to fresh identify", async () => {
    const server = await fixture()
    const client = defaultApi()
    await client.connect()
    server.sockets[0]!.send(JSON.stringify({ op: 0, s: 2, t: "IGNORED_EVENT", d: {} }))
    server.sockets[0]!.close(4000)
    await vi.waitFor(() => expect(server.commands.some((command) => command.op === 6)).toBe(true), { timeout: 2500 })
    await vi.waitFor(() => expect(client.state).toBe("Connected"))
    expect(server.commands.find((command) => command.op === 6)?.d).toMatchObject({
        seq: 2,
        session_id: "fixture-session",
    })
    server.options.invalidResume = true
    server.sockets.at(-1)!.close(4000)
    await vi.waitFor(() => expect(server.commands.filter((command) => command.op === 2)).toHaveLength(2), {
        timeout: 8000,
    })
    await vi.waitFor(() => expect(client.state).toBe("Connected"))
}, 12_000)

test("permanent background failure is retained after readiness", async () => {
    const server = await fixture()
    const captured = capturedLogs(true)
    const client = defaultApi(undefined, { development: true, logger: fromEffectLogger(captured.logger) })
    await client.connect()
    server.sockets[0]!.close(4004)
    expect((await client.waitForClose())._unsafeUnwrapErr()._tag).toBe("AuthenticationError")
    expect(client.state).toBe("Closed")
    expect((await client.waitForClose())._unsafeUnwrapErr()._tag).toBe("AuthenticationError")
    expect(captured.diagnostics().filter((entry) => entry.event === "retry")).toEqual([])
    expect(captured.diagnostics().find((entry) => entry.event === "connectionEnded")).toMatchObject({
        failure: "AuthenticationError",
        phase: "recovery",
    })
    expect(
        captured
            .diagnostics()
            .slice(-2)
            .map((entry) => entry.event),
    ).toEqual(["closing", "closed"])
})

test("default state observation preserves initial state and only the newest pending update", async () => {
    await fixture()
    const client = defaultApi()
    const release = Promise.withResolvers<void>()
    const states: string[] = []
    const unsubscribe = client.observeState(async (state) => {
        states.push(state)
        if (state === "Disconnected") await release.promise
    })
    await client.connect()
    await client.shutdown()
    expect(states).toEqual(["Disconnected"])
    release.resolve()
    await vi.waitFor(() => expect(states).toEqual(["Disconnected", "Closed"]))
    unsubscribe()
})

test("native operations are lazy, observe through Stream, and owning scope closes the connection", async () => {
    const server = await fixture()
    const scope = Scope.makeUnsafe()
    const client = await Effect.runPromise(
        createNative({ token: "fixture-only-not-a-credential" }).pipe(Scope.provide(scope)),
    )
    const connect = client.connect()
    expect(client.state).toBe("Disconnected")
    const states: string[] = []
    const observing = Effect.runPromise(
        Stream.runForEach(client.observeState(), (state) =>
            Effect.sync(() => {
                states.push(state)
            }),
        ),
    )
    await Effect.runPromise(connect)
    expect(client.state).toBe("Connected")
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await observing
    expect(client.state).toBe("Closed")
    expect(server.sockets).toHaveLength(1)
    expect(states[0]).toBe("Disconnected")
    expect(states.at(-1)).toBe("Closed")
})

test("native run interruption cleans up before the interrupted fiber completes", async () => {
    await fixture()
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                const fiber = yield* Effect.forkScoped(client.run())
                yield* Effect.promise(() => vi.waitFor(() => expect(client.state).toBe("Connected")))
                yield* Fiber.interrupt(fiber)
                const exit = yield* Effect.exit(Fiber.join(fiber))
                expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
                expect(client.state).toBe("Closed")
            }),
        ),
    )
})

test("unexpected SDK faults reject outside default Err without private upstream details", async () => {
    const server = await fixture({ holdHello: true })
    const client = defaultApi()
    const result = client.connect()
    const rejected = expect(Promise.resolve(result)).rejects.toBeInstanceOf(SdkDefect)
    await vi.waitFor(() => expect(server.sockets).toHaveLength(1))
    vi.spyOn(transport.sockets[0]!, "send").mockImplementation(() => {
        throw new Error("fixture-private-defect")
    })
    server.sockets[0]!.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }))
    await rejected
    expect(client.state).toBe("Closed")
    try {
        await result
    } catch (error) {
        expect(inspect(error)).not.toContain("fixture-private-defect")
    }
})

test("shutdown waits five seconds for an uncooperative peer, then terminates and awaits actual closure", async () => {
    const server = await startServer({ holdClose: true })
    onTestFinished(() => server.close())
    transport.url = server.socketUrl
    vi.stubGlobal("fetch", async () => Response.json(hostedDiscoveryDocument))
    const client = defaultApi()
    const connecting = client.connect()
    await server.upgraded
    await server.send(
        JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }),
        JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "fixture-session" } }),
    )
    expect((await connecting).isOk()).toBe(true)
    vi.useFakeTimers()
    let finished = false
    const closing = client.shutdown().andTee(() => {
        finished = true
    })
    await server.receivedClose
    await vi.advanceTimersByTimeAsync(4999)
    expect(finished).toBe(false)
    expect(client.state).toBe("Closing")
    await vi.advanceTimersByTimeAsync(1)
    expect((await closing).isOk()).toBe(true)
    await server.peerClosed
    expect(transport.sockets[0]!.readyState).toBe(WebSocket.CLOSED)
    expect(client.state).toBe("Closed")
    vi.useRealTimers()
}, 10_000)

test("startup retries transient HTTP failures only within its total attempt limit", async () => {
    const server = await fixture({ httpStatus: 503 })
    const client = defaultApi({ maxStartupAttempts: 3 })
    expect((await client.connect())._unsafeUnwrapErr()._tag).toBe("ConnectionError")
    expect(server.discoveryRequests()).toBe(3)
    expect(client.state).toBe("Disconnected")
}, 5000)

test("server-requested heartbeats are immediate, and missing ACKs trigger recovery that shutdown stops", async () => {
    const server = await fixture({ interval: 60, noAck: true })
    const client = defaultApi()
    await client.connect()
    server.sockets[0]!.send(JSON.stringify({ op: 1, d: null }))
    await vi.waitFor(() => expect(server.commands.some((command) => command.op === 1)).toBe(true), { interval: 5 })
    await vi.waitFor(() => expect(client.state).toBe("Recovering"), { interval: 5 })
    expect(client.gatewayLatencyMs).toBe(null)
    await client.shutdown()
    expect(client.state).toBe("Closed")
    expect(transport.sockets.every((socket) => socket.readyState === WebSocket.CLOSED)).toBe(true)
})

test("an already-aborted run does not acquire or close a disconnected client", async () => {
    const server = await fixture()
    const client = defaultApi()
    expect((await client.run({ signal: AbortSignal.abort() }))._unsafeUnwrapErr()._tag).toBe("CancelledError")
    expect(client.state).toBe("Disconnected")
    expect(server.discoveryRequests()).toBe(0)
    expect((await client.connect()).isOk()).toBe(true)
})

test.each([
    { startupTimeoutMs: -1 },
    { startupTimeoutMs: 0 },
    { startupTimeoutMs: NaN },
    { startupTimeoutMs: 2_147_483_648 },
    { maxStartupAttempts: 0 },
    { maxStartupAttempts: 1.5 },
])("connection configuration is validated before networking: %j", (connection) => {
    const defaultApi = createClient({ token: "fixture", connection })
    const native = Effect.runSyncExit(Effect.scoped(createNative({ token: "fixture", connection })))
    expect(defaultApi._unsafeUnwrapErr()._tag).toBe("ConfigurationError")
    expect(Exit.isFailure(native) && Cause.hasFails(native.cause)).toBe(true)
})

test.each(["default", "native"])(
    "%s retains a protocol failure alongside a cleanup defect and still releases the socket",
    async (mode) => {
        const server = await fixture({ holdReady: true })
        const scope = Scope.makeUnsafe()
        onTestFinished(async () => {
            await Effect.runPromiseExit(Scope.close(scope, Exit.void))
        })
        const native =
            mode === "native"
                ? await Effect.runPromise(createNative({ token: "fixture" }).pipe(Scope.provide(scope)))
                : undefined
        const client = native ?? defaultApi()
        const running = native
            ? Effect.runPromiseExit(native.connect())
            : Promise.resolve((client as ReturnType<typeof defaultApi>).connect())
        // Attach a rejection boundary before provoking the defect
        const outcome = running.then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
        )
        await vi.waitFor(() => expect(server.commands).toHaveLength(1))
        vi.spyOn(transport.sockets[0]!, "close").mockImplementation(() => {
            throw new Error("private-close-detail")
        })
        server.sockets[0]!.send("not JSON")
        const result = await outcome
        expect(transport.sockets[0]!.readyState).toBe(WebSocket.CLOSED)
        if (mode === "default") {
            expect(result).toHaveProperty("error")
            if (!("error" in result) || !(result.error instanceof SdkDefect)) throw new Error("Expected an SDK defect")
            expect(result.error.reasons).toEqual(
                expect.arrayContaining([
                    { kind: "Failure", failure: expect.objectContaining({ _tag: "ConnectionError" }) },
                    { kind: "Defect" },
                ]),
            )
            expect(inspect(result.error)).not.toContain("private-close-detail")
        } else {
            if (!("value" in result) || !("_tag" in result.value) || result.value._tag !== "Failure")
                throw new Error("Expected native failure")
            expect(Cause.hasFails(result.value.cause)).toBe(true)
            expect(Cause.hasDies(result.value.cause)).toBe(true)
        }
    },
)

test("cancellation plus a cleanup defect rejects rather than returning CancelledError", async () => {
    const server = await fixture({ holdReady: true })
    const client = defaultApi()
    const controller = new AbortController()
    const running = Promise.resolve(client.connect({ signal: controller.signal }))
    const rejected = expect(running).rejects.toBeInstanceOf(SdkDefect)
    await vi.waitFor(() => expect(server.commands).toHaveLength(1))
    vi.spyOn(transport.sockets[0]!, "close").mockImplementation(() => {
        throw new Error("private-close-detail")
    })
    controller.abort()
    await rejected
    expect(client.state).toBe("Closed")
    expect(transport.sockets[0]!.readyState).toBe(WebSocket.CLOSED)
})

test("native heartbeat measurement uses the caller's clock across the background connection", async () => {
    const server = await fixture({ noAck: true })
    const scope = Scope.makeUnsafe()
    onTestFinished(async () => {
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    const client = await Effect.runPromise(createNative({ token: "fixture" }).pipe(Scope.provide(scope)))
    const clock = Effect.runSync(Clock.Clock)
    let time = 1_000_000_000n
    await Effect.runPromise(
        client.connect().pipe(
            Effect.provideService(Clock.Clock, {
                currentTimeMillis: clock.currentTimeMillis,
                currentTimeNanos: clock.currentTimeNanos,
                currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
                currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
                monotonicTimeNanos: Effect.sync(() => time),
                monotonicTimeNanosUnsafe: () => time,
                sleep: (duration) => clock.sleep(duration),
            }),
        ),
    )
    server.sockets[0]!.send(JSON.stringify({ op: 1, d: null }))
    await vi.waitFor(() => expect(server.commands.some((command) => command.op === 1)).toBe(true))
    time += 25_000_000n
    server.sockets[0]!.send(JSON.stringify({ op: 11 }))
    await vi.waitFor(() => expect(client.gatewayLatencyMs).toBe(25))
    await Effect.runPromise(client.shutdown())
    expect(client.gatewayLatencyMs).toBe(null)
})
