import { inspect } from "node:util"
import { Cause, Clock, Effect, Exit, Fiber, Scope, Stream, Logger, References } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { WebSocket } from "ws"
import {
    ConfigurationError,
    createClient,
    SdkDefect,
    type ClientOptions,
    type FailureReport,
    type LogRecord,
} from "../../src/index.js"
import { createClient as createNative } from "../../src/effect.js"
import { Opcode as GatewayOpcode } from "../../src/internal/protocol/gateway.js"
import { startGatewayServer, type ReceivedCommand } from "../support/gateway-server.js"
import { hostedDiscoveryDocument } from "../support/hosted-discovery.js"
import { startServer } from "../support/transport/server.js"
import { modes } from "../support/both-apis.js"
import { wsTarget } from "../support/ws-redirect.js"
import { sdkClock } from "../support/client-clock.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
const hostedGateway = "wss://gateway.fluxer.app/?v=1&encoding=json"
function sinkLogs(throws = false) {
    const records: LogRecord[] = []
    const sink = (record: LogRecord) => {
        records.push(record)
        if (throws) throw new Error("logger-sentinel")
    }
    return { records, sink, codes: () => records.map((record) => record.code) }
}

function capturedLogs(throws = false) {
    const entries: {
        message: unknown
        level: string
        cause: Cause.Cause<unknown>
        annotations: Record<string, unknown>
        span: unknown
    }[] = []
    const logger = Logger.make((entry) => {
        entries.push({
            message: entry.message,
            level: entry.logLevel,
            cause: entry.cause,
            annotations: { ...entry.fiber.getRef(References.CurrentLogAnnotations) },
            span: entry.fiber.cache.span?._tag === "Span" ? entry.fiber.cache.span.name : undefined,
        })
        if (throws) throw new Error("logger-sentinel")
    })
    const codes = () => entries.map((entry) => entry.annotations["fluxerly.code"]).filter((code) => code !== undefined)
    return { entries, logger, codes }
}

test("default lifecycle records are on by default, client-local and follow the configured level", async () => {
    await fixture()
    const info = sinkLogs()
    const warn = sinkLogs()
    const debug = sinkLogs()
    const clients = [
        defaultApi(undefined, { sink: info.sink }),
        defaultApi(undefined, { level: "warn", sink: warn.sink }),
        defaultApi(undefined, { categories: { lifecycle: "debug" }, sink: debug.sink }),
    ]
    for (const client of clients) {
        expect((await client.connect()).isOk()).toBe(true)
        expect((await client.shutdown()).isOk()).toBe(true)
    }
    expect(info.codes()).toEqual([
        "lifecycle.starting",
        "lifecycle.ready",
        "lifecycle.connected",
        "lifecycle.shutdown",
        "lifecycle.shutdownComplete",
    ])
    expect(warn.records).toEqual([])
    expect(debug.codes()).toEqual([
        "lifecycle.starting",
        "lifecycle.attempt",
        "lifecycle.ready",
        "lifecycle.connected",
        "lifecycle.shutdown",
        "lifecycle.shutdownComplete",
    ])
    expect(info.records.find((record) => record.code === "lifecycle.ready")).toMatchObject({
        level: "info",
        category: "lifecycle",
        shardId: 0,
        attempt: 1,
        fields: { mode: "identify" },
    })
    expect(info.records[0]!.message).toMatch(/fluxer\.app/)
    for (const record of info.records) expect(Object.isFrozen(record)).toBe(true)
})

test.each([
    { guilds: 2, level: "info", message: "Connected to Fluxer as Fixture Bot in 2 communities" },
    { guilds: 1, level: "info", message: "Connected to Fluxer as Fixture Bot in 1 community" },
    {
        guilds: 0,
        level: "warn",
        message:
            "Connected to Fluxer as Fixture Bot, but the bot is not in any community yet. Invite it by opening https://fluxer.app/oauth2/authorize?client_id=1234567890123456789&scope=bot",
    },
])("the connected record names the bot and its $guilds communities at $level", async ({ guilds, level, message }) => {
    await fixture({
        ready: () => ({
            user: { id: "1234567890123456789", username: "Fixture Bot" },
            guilds: Array.from({ length: guilds }, (_, index) => ({ id: `${100 + index}`, unavailable: true })),
        }),
    })
    const logs = sinkLogs()
    const client = defaultApi(undefined, { sink: logs.sink })
    expect((await client.connect()).isOk()).toBe(true)
    expect(logs.records.filter((record) => record.code === "lifecycle.connected")).toEqual([
        expect.objectContaining({ level, category: "lifecycle", message, fields: { communities: guilds, shards: 1 } }),
    ])
})

test("default output needs no custom logger", async () => {
    await fixture()
    const output = vi.spyOn(console, "log").mockImplementation(() => {})
    const client = defaultApi(undefined, { format: "json" })
    await client.connect()
    await client.shutdown()
    const printed = output.mock.calls.map((args) => JSON.parse(String(args[0])) as LogRecord)
    expect(printed.map((record) => record.code)).toEqual(
        expect.arrayContaining(["lifecycle.ready", "lifecycle.shutdownComplete"]),
    )
    expect(printed.find((record) => record.code === "lifecycle.ready")).toMatchObject({ level: "info", shardId: 0 })
})

test.each([undefined, "silent"] as const)(
    "native records use the caller's logger, annotations and span, with level %s",
    async (level) => {
        await fixture()
        const captured = capturedLogs()
        const scope = Scope.makeUnsafe()
        const client = await Effect.runPromise(
            createNative({
                token: "fixture-only-not-a-credential",
                ...(level === undefined ? {} : { logging: { level } }),
            }).pipe(Scope.provide(scope)),
        )
        await Effect.runPromise(
            Effect.gen(function* () {
                yield* client.connect()
                yield* client.shutdown()
            }).pipe(
                Effect.withLogger(captured.logger),
                Effect.annotateLogs("requestId", "execution"),
                Effect.withSpan("connection-owner"),
            ),
        )
        await Effect.runPromise(Scope.close(scope, Exit.void))
        if (level === "silent") {
            expect(captured.codes()).toEqual([])
            return
        }
        expect(captured.codes()).toEqual([
            "lifecycle.starting",
            "lifecycle.ready",
            "lifecycle.connected",
            "lifecycle.shutdown",
            "lifecycle.shutdownComplete",
        ])
        const fluxerly = captured.entries.filter((entry) => entry.annotations["fluxerly.code"] !== undefined)
        expect(fluxerly.every((entry) => entry.annotations.requestId === "execution")).toBe(true)
        expect(fluxerly.every((entry) => entry.span === "connection-owner")).toBe(true)
        expect(fluxerly.find((entry) => entry.annotations["fluxerly.code"] === "lifecycle.ready")).toMatchObject({
            level: "Info",
            annotations: { "fluxerly.category": "lifecycle", "fluxerly.shardId": 0 },
        })
    },
)

test.each(modes)(
    "%s records survive failing output and describe recovery with close codes, next handshakes and no credentials",
    async (mode) => {
        const clock = sdkClock()
        const server = await fixture({ interval: 600_000 })
        const failing = sinkLogs(true)
        const kept = sinkLogs()
        const captured = capturedLogs(true)
        const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
        const scope = Scope.makeUnsafe()
        const client =
            mode === "default"
                ? defaultApi(undefined, { sink: [failing.sink, kept.sink] })
                : await Effect.runPromise(
                      createNative({ token: "fixture-only-not-a-credential" }).pipe(Scope.provide(scope)),
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
        const messages = () =>
            mode === "default"
                ? kept.records.map((record) => ({ code: record.code, record }))
                : captured.entries.map((entry) => ({
                      code: entry.annotations["fluxerly.code"],
                      record: {
                          closeCode: entry.annotations["fluxerly.closeCode"],
                          delayMs: entry.annotations["fluxerly.delayMs"],
                          fields: {
                              mode: entry.annotations["fluxerly.mode"],
                              reason: entry.annotations["fluxerly.reason"],
                              classification: entry.annotations["fluxerly.classification"],
                              next: entry.annotations["fluxerly.next"],
                          },
                      },
                  }))
        const recorded = (code: string, count = 1) =>
            vi.waitFor(
                () => {
                    const matching = messages().filter((entry) => entry.code === code)
                    expect(matching.length).toBeGreaterThanOrEqual(count)
                    return matching[count - 1]!.record
                },
                { interval: 5 },
            )
        const ready = (mode: string, count: number) =>
            vi.waitFor(
                () =>
                    expect(
                        messages().filter(
                            (entry) => entry.code === "lifecycle.ready" && entry.record.fields?.mode === mode,
                        ),
                    ).toHaveLength(count),
                { interval: 5 },
            )
        server.sockets[0]!.close(4000, "private-close-sentinel")
        const lost = await recorded("lifecycle.connectionLost")
        expect(lost).toMatchObject({
            closeCode: 4000,
            delayMs: expect.any(Number),
            fields: { reason: "closed", classification: "closed", next: "resume" },
        })
        await clock.advance(Number(lost.delayMs))
        await ready("resume", 1)
        server.options.invalidResume = true
        server.sockets.at(-1)!.close(4000)
        const second = await recorded("lifecycle.connectionLost", 2)
        expect(second).toMatchObject({ closeCode: 4000, fields: { next: "resume" } })
        await clock.advance(Number(second.delayMs))
        // The server rejects the Resume, so the SDK resets the session and its next attempt identifies
        await recorded("lifecycle.sessionReset")
        const retry = await recorded("lifecycle.retry")
        expect(retry).toMatchObject({ fields: { next: "identify" } })
        await clock.advance(Number(retry.delayMs))
        await ready("identify", 2)
        const serialized = JSON.stringify(mode === "default" ? kept.records : captured.entries)
        for (const privateValue of [
            "fixture-only-not-a-credential",
            "fixture-session",
            "private-close-sentinel",
            "gateway.fluxer.app",
        ])
            expect(serialized).not.toContain(privateValue)
        expect(client.diagnostics().counters).toMatchObject({ reconnects: 3, resumes: 1 })
        // Every failing output is counted, but only the first is reported on standard error
        expect(client.diagnostics().counters.sinkFailures).toBeGreaterThan(1)
        expect(stderr).toHaveBeenCalledTimes(1)
        expect(String(stderr.mock.calls[0]![0])).not.toContain("fixture-only-not-a-credential")
    },
)

test("default observer errors are reported with the thrown error", async () => {
    const logs = sinkLogs()
    const client = defaultApi(undefined, { sink: logs.sink })
    const stop = client.observeState(() => {
        throw new Error("observer-sentinel")
    })
    await vi.waitFor(() => expect(logs.records).toHaveLength(1))
    stop.close()
    await client.shutdown()
    expect(logs.records[0]).toMatchObject({
        level: "error",
        code: "lifecycle.observerFailed",
        error: { origin: "application", name: "Error", message: "observer-sentinel", stack: expect.any(String) },
    })
})

test.each(modes)(
    "%s handler failures log the full error once, and a failing hook is logged with the original",
    async (mode) => {
        const server = await fixture()
        const logs = sinkLogs()
        const reports: FailureReport[] = []
        const handlerError = new Error("handler-marker")
        if (mode === "default") {
            const client = defaultApi(undefined, { sink: logs.sink, dedupe: false })
            client.on("typingStart", () => {
                throw handlerError
            })
            client.on(
                "typingStart",
                () => {
                    throw handlerError
                },
                {
                    onError: (report) => {
                        reports.push({ ...report })
                        throw new Error("reporter-marker")
                    },
                },
            )
            expect((await client.connect()).isOk()).toBe(true)
        } else {
            const scope = Scope.makeUnsafe()
            const client = await Effect.runPromise(
                createNative({
                    token: "fixture-only-not-a-credential",
                    logging: { sink: logs.sink, dedupe: false },
                }).pipe(Scope.provide(scope)),
            )
            onTestFinished(async () => {
                await Effect.runPromise(client.shutdown())
                await Effect.runPromise(Scope.close(scope, Exit.void))
            })
            await Effect.runPromise(
                client.on("typingStart", () => Effect.fail(handlerError)).pipe(Scope.provide(scope)),
            )
            await Effect.runPromise(
                client
                    .on("typingStart", () => Effect.fail(handlerError), {
                        onError: (report) =>
                            Effect.sync(() => {
                                reports.push({ ...report })
                                throw new Error("reporter-marker")
                            }),
                    })
                    .pipe(Scope.provide(scope)),
            )
            await Effect.runPromise(client.connect())
        }
        server.dispatch("TYPING_START", { channel_id: "924151", user_id: "924152", timestamp: 1 })
        await vi.waitFor(() =>
            expect(logs.records.filter((record) => record.code.startsWith("events."))).toHaveLength(3),
        )
        expect(reports).toEqual([
            expect.objectContaining({ event: "typingStart", kind: "handler", error: handlerError }),
        ])
        expect(reports[0]!.subscriptionId).toMatch(/^typingStart#\d+$/)
        const failures = logs.records.filter((record) => record.code === "events.handlerFailed")
        expect(failures).toHaveLength(2)
        for (const failure of failures)
            expect(failure).toMatchObject({
                level: "error",
                event: "typingStart",
                error: { origin: "application", message: "handler-marker", stack: expect.stringContaining("at ") },
            })
        expect(logs.records.find((record) => record.code === "events.hookFailed")).toMatchObject({
            level: "error",
            error: { message: "reporter-marker" },
        })
    },
)

test("a non-message pull subscription rejects an overlapping read and keeps the pending one cancellable", async () => {
    const client = defaultApi()
    const busySource = client.subscribe("typingStart")
    const controller = new AbortController()
    const reading = busySource.next({ signal: controller.signal })
    expect((await busySource.next())._unsafeUnwrapErr()).toMatchObject({
        _tag: "EventReadBusyError",
        code: "events.readBusy",
    })
    controller.abort()
    expect((await reading)._unsafeUnwrapErr()._tag).toBe("CancelledError")
    busySource.close()
})

test.each([
    [null, "logging"],
    [{ level: "verbose" }, "level"],
    [{ categories: { nope: "info" } }, "categories"],
    [{ categories: { rest: "loud" } }, "categories"],
    [{ debug: "yes" }, "debug"],
    [{ debug: ["nope"] }, "debug"],
    [{ format: "xml" }, "format"],
    [{ sink: [] }, "sink"],
    [{ sink: "console" }, "sink"],
    [{ dedupe: { windowMs: -1 } }, "dedupe"],
    [{ unsafe: { payloads: false } }, "unsafe"],
    [{ development: true }, "logging"],
    [{ unknown: true }, "logging"],
])("invalid logging configuration fails before connection: %j", (logging, field) => {
    expect(() => createClient({ token: "fixture-only-not-a-credential", logging } as unknown as ClientOptions)).toThrow(
        expect.objectContaining({ _tag: "ConfigurationError", field }),
    )
})

test("replaced logging settings fail with the same field and hint in both entry points", async () => {
    const options = { token: "fixture-only-not-a-credential", logging: { development: true } }
    const hint = configurationError(() => createClient(options as unknown as ClientOptions)).hint
    expect(hint).toEqual(expect.any(String))
    const exit = await Effect.runPromiseExit(
        Effect.scoped(createNative(options as unknown as import("../../src/effect.js").ClientOptions)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit))
        expect(exit.cause.reasons).toEqual([
            expect.objectContaining({
                _tag: "Die",
                defect: expect.objectContaining({ _tag: "ConfigurationError", field: "logging", hint }),
            }),
        ])
})
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    const requested = wsTarget.requested
    wsTarget.url = ""
    wsTarget.sockets = []
    wsTarget.requested = []
    // Every SDK socket targets the discovered hosted gateway before redirection to the loopback fixture
    expect(requested.filter((url) => url !== hostedGateway)).toEqual([])
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
        ready?: (identify: ReceivedCommand) => Record<string, unknown>
    } = {},
) {
    let discoveryRequests = 0
    const invalidResume = (command: ReceivedCommand) => command.op === GatewayOpcode.resume && options.invalidResume
    const gateway = await startGatewayServer({
        heartbeatIntervalMs: options.interval ?? 1000,
        hello: !options.holdHello,
        heartbeatAck: !options.noAck,
        autoReady: (command) => !options.reject && !options.holdReady && !invalidResume(command),
        ...(options.ready ? { ready: options.ready } : {}),
        onCommand: (command, socket) => {
            if (command.op !== GatewayOpcode.identify && command.op !== GatewayOpcode.resume) return
            if (options.reject) socket.close(options.reject)
            else if (!options.holdReady && invalidResume(command))
                gateway.send({ op: GatewayOpcode.invalidSession, d: false }, socket)
        },
    })
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
    return {
        sockets: gateway.sockets,
        commands: gateway.commands,
        dispatch: gateway.dispatch,
        send: gateway.send,
        discoveryRequests: () => discoveryRequests,
        options,
    }
}

function defaultApi(
    connection?: ClientOptions["connection"],
    logging?: ClientOptions["logging"],
    sharding?: ClientOptions["sharding"],
) {
    const client = createClient({
        token: "fixture-only-not-a-credential",
        ...(connection ? { connection } : {}),
        ...(logging ? { logging } : {}),
        ...(sharding ? { sharding } : {}),
    })
    onTestFinished(async () => {
        await client.shutdown()
    })
    return client
}

function configurationError(create: () => unknown): ConfigurationError {
    try {
        create()
    } catch (error) {
        if (error instanceof ConfigurationError) return error
        throw error
    }
    return expect.fail("Expected a ConfigurationError")
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
    server.dispatch("READY", { session_id: "fixture-session" })
    expect((await connecting).isOk()).toBe(true)
    controller.abort()
    expect(client.state).toBe("Connected")
    expect((await client.connect()).isOk()).toBe(true)
    // Request the measured heartbeat after READY rather than racing its scheduled timer
    server.send({ op: GatewayOpcode.heartbeat })
    await vi.waitFor(() => expect(client.gatewayLatencyMs).not.toBe(null))
    expect(server.sockets).toHaveLength(1)
    expect(server.commands.find((command) => command.op === 1)?.d).toBe(1)
    const [first, second] = await Promise.all([client.shutdown(), client.shutdown()])
    expect(first.isOk() && second.isOk()).toBe(true)
    expect(client.state).toBe("Closed")
    expect(client.gatewayLatencyMs).toBe(null)
    expect((await client.waitForClose()).isOk()).toBe(true)
    expect((await client.connect())._unsafeUnwrapErr()._tag).toBe("ClientClosedError")
    for (const socket of wsTarget.sockets) {
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
    expect(wsTarget.sockets[0]!.readyState).toBe(WebSocket.CLOSED)
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

test.each([4004, 4002, 4010, 4011, 4012] as const)("permanent rejection %s is typed and not retried", async (code) => {
    const server = await fixture({ reject: code })
    // Without sharding settings, 4011 moves the client to automatic sharding instead of ending it
    const client = defaultApi(undefined, undefined, { totalShards: 1 })
    const result = await client.connect()
    expect(result._unsafeUnwrapErr()).toMatchObject(
        code === 4004
            ? { _tag: "AuthenticationError", code: "auth.rejected" }
            : { _tag: "ConnectionError", phase: "gateway", reason: "protocol", status: code },
    )
    expect(client.state).toBe("Disconnected")
    expect(server.sockets).toHaveLength(1)
    expect(inspect(result)).not.toContain("fixture-only-not-a-credential")
})

test("startup deadline ends a silent handshake and run closes permanently on failure", async () => {
    const clock = sdkClock()
    await fixture({ holdHello: true })
    const client = defaultApi({ startupTimeoutMs: 80, maxStartupAttempts: 1 })
    const running = client.run()
    await clock.waiting(80)
    await clock.advance(80)
    const result = await running
    expect(result._unsafeUnwrapErr()._tag).toBe("ConnectionTimeoutError")
    expect(client.state).toBe("Closed")
})

test("permanent background failure is retained after readiness", async () => {
    const server = await fixture()
    const logs = sinkLogs(true)
    const client = defaultApi(undefined, { sink: logs.sink })
    await client.connect()
    server.sockets[0]!.close(4004)
    expect((await client.waitForClose())._unsafeUnwrapErr()._tag).toBe("AuthenticationError")
    expect(client.state).toBe("Closed")
    expect((await client.waitForClose())._unsafeUnwrapErr()._tag).toBe("AuthenticationError")
    expect(logs.codes().filter((code) => code === "lifecycle.connectionLost")).toEqual([])
    expect(logs.records.find((record) => record.code === "lifecycle.connectionEnded")).toMatchObject({
        level: "error",
        closeCode: 4004,
        error: { name: "AuthenticationError", code: "auth.rejected" },
    })
    expect(logs.codes().slice(-2)).toEqual(["lifecycle.shutdown", "lifecycle.shutdownComplete"])
})

test("default state observation preserves initial state and only the newest pending update", async () => {
    await fixture()
    const client = defaultApi()
    const release = Promise.withResolvers<void>()
    const states: string[] = []
    const observer = client.observeState(async (state) => {
        states.push(state)
        if (state === "Disconnected") await release.promise
    })
    await client.connect()
    await client.shutdown()
    expect(states).toEqual(["Disconnected"])
    release.resolve()
    await vi.waitFor(() => expect(states).toEqual(["Disconnected", "Closed"]))
    observer.close()
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

test("unexpected SDK faults reject outside default Err with an SdkDefect carrying the defect", async () => {
    const server = await fixture({ holdHello: true })
    const client = defaultApi()
    const result = client.connect()
    const rejected = expect(Promise.resolve(result)).rejects.toBeInstanceOf(SdkDefect)
    await vi.waitFor(() => expect(server.sockets).toHaveLength(1))
    vi.spyOn(wsTarget.sockets[0]!, "send").mockImplementation(() => {
        throw new Error("fixture-private-defect")
    })
    server.send({ op: GatewayOpcode.hello, d: { heartbeat_interval: 1000 } })
    await rejected
    expect(client.state).toBe("Closed")
    try {
        await result
    } catch (error) {
        expect(inspect(error)).toContain("fixture-private-defect")
    }
})

test("shutdown waits five seconds for an uncooperative peer, then terminates and awaits actual closure", async () => {
    const server = await startServer({ holdClose: true })
    onTestFinished(() => server.close())
    wsTarget.url = server.socketUrl
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
    expect(wsTarget.sockets[0]!.readyState).toBe(WebSocket.CLOSED)
    expect(client.state).toBe("Closed")
    vi.useRealTimers()
}, 10_000)

test("server-requested heartbeats are immediate, and missing ACKs trigger recovery that shutdown stops", async () => {
    const clock = sdkClock()
    const server = await fixture({ interval: 60, noAck: true })
    const logs = sinkLogs()
    const client = defaultApi(undefined, { sink: logs.sink })
    await client.connect()
    await clock.waiting(60)
    server.send({ op: GatewayOpcode.heartbeat, d: null })
    // SDK time stands still, so only the server request can produce this heartbeat
    await vi.waitFor(() => expect(server.commands.some((command) => command.op === 1)).toBe(true), { interval: 5 })
    await clock.advance(60)
    await vi.waitFor(() => expect(client.state).toBe("Recovering"), { interval: 5 })
    expect(client.gatewayLatencyMs).toBe(null)
    await vi.waitFor(() =>
        expect(logs.records.find((record) => record.code === "lifecycle.connectionLost")).toMatchObject({
            level: "warn",
            fields: { reason: "heartbeatTimeout" },
        }),
    )
    await client.shutdown()
    expect(client.state).toBe("Closed")
    expect(wsTarget.sockets.every((socket) => socket.readyState === WebSocket.CLOSED)).toBe(true)
})

test.each([4999, 4100])("an unlisted close code %i enters recovery and is logged with its code", async (code) => {
    const clock = sdkClock()
    const server = await fixture({ interval: 600_000 })
    const logs = sinkLogs()
    const client = defaultApi(undefined, { sink: logs.sink })
    await client.connect()
    server.sockets[0]!.close(code)
    await clock.waiting(500)
    expect(logs.records.find((record) => record.code === "lifecycle.connectionLost")).toMatchObject({
        level: "warn",
        closeCode: code,
        delayMs: 500,
        fields: { next: "resume" },
    })
    await clock.advance(500)
    await vi.waitFor(() => expect(client.state).toBe("Connected"), { interval: 5 })
    expect(server.sockets).toHaveLength(2)
    expect(server.commands.filter((command) => command.op === 6)).toHaveLength(1)
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
    expect(() => createClient({ token: "fixture", connection })).toThrow(ConfigurationError)
    const native = Effect.runSyncExit(Effect.scoped(createNative({ token: "fixture", connection })))
    expect(Exit.isFailure(native) && native.cause.reasons.find((reason) => reason._tag === "Die")).toMatchObject({
        defect: expect.any(ConfigurationError),
    })
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
        vi.spyOn(wsTarget.sockets[0]!, "close").mockImplementation(() => {
            throw new Error("private-close-detail")
        })
        server.sockets[0]!.send("not JSON")
        const result = await outcome
        expect(wsTarget.sockets[0]!.readyState).toBe(WebSocket.CLOSED)
        if (mode === "default") {
            expect(result).toHaveProperty("error")
            if (!("error" in result) || !(result.error instanceof SdkDefect)) throw new Error("Expected an SDK defect")
            expect(result.error.reasons).toEqual(
                expect.arrayContaining([
                    { kind: "Failure", failure: expect.objectContaining({ _tag: "ConnectionError" }) },
                    expect.objectContaining({ kind: "Defect" }),
                ]),
            )
            expect(inspect(result.error)).toContain("private-close-detail")
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
    vi.spyOn(wsTarget.sockets[0]!, "close").mockImplementation(() => {
        throw new Error("private-close-detail")
    })
    controller.abort()
    await rejected
    expect(client.state).toBe("Closed")
    expect(wsTarget.sockets[0]!.readyState).toBe(WebSocket.CLOSED)
})

test("native heartbeat measurement uses the client creation Clock across the background connection", async () => {
    // Sleeps, including the heartbeat interval, wait on logical time, and the default Clock reads zero throughout
    sdkClock()
    const server = await fixture({ noAck: true })
    const scope = Scope.makeUnsafe()
    onTestFinished(async () => {
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    const clock = Effect.runSync(Clock.Clock)
    let time = 1_000_000_000n
    const measurementClock = {
        currentTimeMillis: clock.currentTimeMillis,
        currentTimeNanos: clock.currentTimeNanos,
        currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
        currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
        monotonicTimeNanos: Effect.sync(() => time),
        monotonicTimeNanosUnsafe: () => time,
        sleep: (duration: Parameters<typeof clock.sleep>[0]) => clock.sleep(duration),
    }
    const client = await Effect.runPromise(
        createNative({ token: "fixture" }).pipe(
            Scope.provide(scope),
            Effect.provideService(Clock.Clock, measurementClock),
        ),
    )
    await Effect.runPromise(client.connect())
    server.send({ op: GatewayOpcode.heartbeat, d: null })
    await vi.waitFor(() => expect(server.commands.some((command) => command.op === 1)).toBe(true))
    time += 25_000_000n
    server.send({ op: GatewayOpcode.heartbeatAck })
    await vi.waitFor(() => expect(client.gatewayLatencyMs).toBe(25))
    await Effect.runPromise(client.shutdown())
    expect(client.gatewayLatencyMs).toBe(null)
})

test.each(modes)("%s a retry without a resumable session reports Identify as its next handshake", async (mode) => {
    // Every Identify is closed with 4000, a code whose action is to resume, but no session ever existed
    const clock = sdkClock()
    await fixture({ reject: 4000, interval: 600_000 })
    const logs = sinkLogs()
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const client =
        mode === "default"
            ? defaultApi({ maxStartupAttempts: 2 }, { sink: logs.sink })
            : await Effect.runPromise(
                  createNative({
                      token: "fixture-only-not-a-credential",
                      connection: { maxStartupAttempts: 2 },
                      logging: { sink: logs.sink },
                  }).pipe(Scope.provide(scope)),
              )
    const connect = client.connect()
    const settled = Effect.isEffect(connect) ? Effect.runPromise(Effect.exit(connect)) : Promise.resolve(connect)
    await clock.waiting(500)
    expect(logs.records.find((record) => record.code === "lifecycle.retry")).toMatchObject({
        closeCode: 4000,
        fields: { reason: "closed", next: "identify" },
    })
    await clock.advance(500)
    const outcome = await settled
    expect(Exit.isExit(outcome) ? Exit.isFailure(outcome) : outcome.isErr()).toBe(true)
})
