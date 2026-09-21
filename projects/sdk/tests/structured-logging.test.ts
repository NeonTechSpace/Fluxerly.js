import { Cause, Clock, Effect, Exit, Logger, References, Scope } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { ConfigurationError } from "../src/errors.js"
import { createClient } from "../src/index.js"
import { createClient as createNativeClient } from "../src/effect.js"
import { fromStructuredLogger, type SdkLogRecord, type SdkMeasurementLogRecord } from "../src/logging.js"
import { ClientLogging, loggingConfiguration } from "../src/internal/logging.js"
import { EventBus } from "../src/internal/events.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

function configured(value: unknown, native = false) {
    const result = loggingConfiguration(value, native)
    expect(result).toBeInstanceOf(ClientLogging)
    return result as ClientLogging
}

function emitLifecycle(logging: ClientLogging) {
    return logging.provide(
        Effect.withFiber((fiber) =>
            Effect.sync(() => logging.emit(fiber, { event: "retry", phase: "recovery", attempt: 2, delayMs: 25 })),
        ),
    )
}

function emitMeasurement(logging: ClientLogging) {
    return logging.provide(
        Effect.withFiber((fiber) =>
            Effect.sync(() =>
                logging.emitMeasurement(fiber, {
                    operation: "rest.request",
                    stage: "network",
                    durationMs: 12.5,
                    outcome: "success",
                    retryCount: 1,
                }),
            ),
        ),
    )
}

test("plain structured logger receives frozen safe records and isolates sink failures", () => {
    const records: SdkLogRecord[] = []
    const logger = fromStructuredLogger((record) => {
        records.push(record)
        throw new Error("private-sink-failure")
    })
    const logging = configured({ development: true, measurements: true, logger })

    expect(() => Effect.runSync(emitLifecycle(logging))).not.toThrow()
    expect(() => Effect.runSync(emitMeasurement(logging))).not.toThrow()
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
        source: "fluxerly",
        level: "Info",
        category: "lifecycle",
        event: "retry",
        phase: "recovery",
        attempt: 2,
        delayMs: 25,
    })
    expect(records[1]).toMatchObject({
        source: "fluxerly",
        level: "Info",
        category: "measurement",
        event: "measurement",
        operation: "rest.request",
        stage: "network",
        durationMs: 12.5,
        outcome: "success",
        retryCount: 1,
    })
    expect(records.every(Object.isFrozen)).toBe(true)
    expect(records.every((record) => !Number.isNaN(Date.parse(record.timestamp)))).toBe(true)
    expect(JSON.stringify(records)).not.toContain("private-sink-failure")
})

test("structured adapter omits Effect causes, annotations and arbitrary messages", () => {
    const records: SdkLogRecord[] = []
    const logging = configured({ logger: fromStructuredLogger((record) => records.push(record)) })
    const secret = "signed=https://example.test/file?signature=private&oauth_secret=private"
    const unsafe = Effect.gen(function* () {
        yield* Effect.logError(secret)
        return yield* Effect.failCause(Cause.die(new Error("private-cause")))
    }).pipe(Effect.annotateLogs("authorization", "Bearer private"), Effect.withSpan("private-span"))

    Effect.runSyncExit(logging.provide(unsafe))
    expect(records).toEqual([
        expect.objectContaining({
            source: "fluxerly",
            level: "Error",
            category: "operation",
            event: "operationFailed",
        }),
    ])
    const serialized = JSON.stringify(records)
    for (const privateValue of [secret, "authorization", "Bearer private", "private-span", "private-cause"])
        expect(serialized).not.toContain(privateValue)
})

test("structured adapter classifies real handler failure without callback data", async () => {
    const records: SdkLogRecord[] = []
    const logging = configured({ logger: fromStructuredLogger((record) => records.push(record)) })
    const bus = new EventBus(() => logging)
    const scope = Scope.makeUnsafe()
    await Effect.runPromise(
        logging.provide(
            bus.on("typingStart", () => Effect.fail(new Error("private-handler-error")), undefined, undefined, scope),
        ),
    )

    bus.offer("typingStart", { channelId: "1", userId: "2", timestamp: 0 }, 1)
    await vi.waitFor(() => expect(records).toHaveLength(1))
    await Effect.runPromise(Scope.close(scope, Exit.void))

    expect(records).toEqual([
        expect.objectContaining({
            category: "operation",
            event: "eventSubscriptionFailed",
            subscriptionEvent: "typingStart",
            failureKind: "handler",
        }),
    ])
    expect(JSON.stringify(records)).not.toContain("private-handler-error")
})

test("structured adapter classifies real subscription overflow", async () => {
    const records: SdkLogRecord[] = []
    const logging = configured({ logger: fromStructuredLogger((record) => records.push(record)) })
    const bus = new EventBus(() => logging)
    const scope = Scope.makeUnsafe()
    await Effect.runPromise(
        logging.provide(
            bus.on(
                "typingStart",
                () => Effect.never,
                { concurrency: 1, maxPendingMessages: 1, maxPendingBytes: 100 },
                undefined,
                scope,
            ),
        ),
    )

    const event = { channelId: "1", userId: "2", timestamp: 0 }
    bus.offer("typingStart", event, 1)
    bus.offer("typingStart", event, 1)
    bus.offer("typingStart", event, 1)
    await vi.waitFor(() => expect(records).toHaveLength(1))
    await Effect.runPromise(Scope.close(scope, Exit.void))

    expect(records).toEqual([
        expect.objectContaining({
            category: "operation",
            event: "eventSubscriptionFailed",
            subscriptionEvent: "typingStart",
            failureKind: "overflow",
        }),
    ])
})

test("measurements are independent, off by default and respect the default minimum level", () => {
    const records: SdkLogRecord[] = []
    const logger = fromStructuredLogger((record) => records.push(record))

    Effect.runSync(emitMeasurement(configured({ logger })))
    Effect.runSync(emitLifecycle(configured({ measurements: true, logger })))
    Effect.runSync(emitMeasurement(configured({ measurements: true, minimumLevel: "Error", logger })))
    expect(records).toEqual([])

    Effect.runSync(emitMeasurement(configured({ measurements: true, logger })))
    expect(records).toHaveLength(1)
    expect(records[0]?.category).toBe("measurement")
})

test("default REST measurements cover queue, network and decode without changing the operation outcome", async () => {
    const records: SdkLogRecord[] = []
    stubFetchWithHostedDiscovery(async () =>
        Response.json({
            id: "10",
            channel_id: "20",
            content: "measured",
            author: { id: "30", username: "fixture" },
        }),
    )
    const created = createClient({
        token: "fixture-only-not-a-credential",
        logging: {
            measurements: true,
            logger: fromStructuredLogger((record) => {
                records.push(record)
                throw new Error("private-sink-failure")
            }),
        },
    })
    if (created.isErr()) throw created.error
    const client = created.value

    const result = await client.messages.fetch({ id: "10", channelId: "20" })
    if (result.isErr()) throw result.error
    expect((await client.shutdown()).isOk()).toBe(true)

    const measurements = records.filter((record) => record.category === "measurement")
    expect(measurements.map((record) => record.category === "measurement" && record.stage)).toEqual([
        "queue",
        "network",
        "decode",
    ])
    expect(
        measurements.every(
            (record) =>
                record.category === "measurement" &&
                record.operation === "rest.request" &&
                record.outcome === "success" &&
                record.durationMs >= 0 &&
                record.retryCount === 0,
        ),
    ).toBe(true)
    const serialized = JSON.stringify(records)
    for (const privateValue of [
        "fixture-only-not-a-credential",
        "private-sink-failure",
        "api.fluxer.app",
        "/channels/20",
    ])
        expect(serialized).not.toContain(privateValue)
})

test("native REST measurements retain the executing caller Clock across owner deadlines", async () => {
    const records: SdkLogRecord[] = []
    stubFetchWithHostedDiscovery(async () =>
        Response.json({
            id: "10",
            channel_id: "20",
            content: "measured",
            author: { id: "30", username: "fixture" },
        }),
    )
    const logger = Logger.make((entry) => {
        const message = entry.message
        if (Array.isArray(message) && message[0] === "Fluxerly") records.push(message[1] as SdkLogRecord)
    })
    const baseClock = Effect.runSync(Clock.Clock)
    const creationClock = Object.assign(Object.create(baseClock) as Clock.Clock, {
        monotonicTimeNanosUnsafe: () => 0n,
    })
    let now = 1_000_000n
    const executingClock = Object.assign(Object.create(baseClock) as Clock.Clock, {
        monotonicTimeNanosUnsafe: () => {
            const current = now
            now += 10_000_000n
            return current
        },
    })

    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNativeClient({
                    token: "fixture-only-not-a-credential",
                    logging: { measurements: true },
                }).pipe(Effect.provideService(Clock.Clock, creationClock))
                yield* client.messages
                    .fetch({ id: "10", channelId: "20" })
                    .pipe(Effect.provideService(Clock.Clock, executingClock))
                yield* client.shutdown()
            }),
        ).pipe(Effect.withLogger(logger)),
    )

    const measurements = records.filter(
        (record): record is SdkMeasurementLogRecord =>
            record.category === "measurement" && record.operation === "rest.request",
    )
    expect(measurements.map((record) => record.stage)).toEqual(["queue", "network", "decode"])
    expect(measurements.every((record) => record.durationMs >= 10 && record.durationMs % 10 === 0)).toBe(true)
})

test("native measurements preserve the caller logger, annotations, span and minimum level", () => {
    const captured: Array<{ record: SdkLogRecord; requestId: unknown; span: string | undefined }> = []
    const logger = Logger.make((entry) => {
        const message = entry.message
        if (!Array.isArray(message) || message[0] !== "Fluxerly") return
        captured.push({
            record: message[1] as SdkLogRecord,
            requestId: entry.fiber.getRef(References.CurrentLogAnnotations).requestId,
            span: entry.fiber.cache.span?._tag === "Span" ? entry.fiber.cache.span.name : undefined,
        })
    })
    const logging = configured({ measurements: true }, true)
    const emit = Effect.withFiber((fiber) =>
        Effect.sync(() =>
            logging.emitMeasurement(fiber, {
                operation: "event.handler",
                stage: "handler",
                durationMs: 3,
                outcome: "failure",
            }),
        ),
    )

    Effect.runSync(
        emit.pipe(
            Effect.withLogger(logger),
            Effect.annotateLogs("requestId", "native-context"),
            Effect.withSpan("consumer-span"),
            Effect.provideService(References.MinimumLogLevel, "Debug"),
        ),
    )
    Effect.runSync(emit.pipe(Effect.withLogger(logger), Effect.provideService(References.MinimumLogLevel, "Error")))

    expect(captured).toEqual([
        {
            record: expect.objectContaining({
                category: "measurement",
                operation: "event.handler",
                stage: "handler",
                outcome: "failure",
            }),
            requestId: "native-context",
            span: "consumer-span",
        },
    ])
})

test("event handler measurements use the caller clock and stay separate from network timings", async () => {
    const records: SdkLogRecord[] = []
    const logger = Logger.make((entry) => {
        const message = entry.message
        if (Array.isArray(message) && message[0] === "Fluxerly") records.push(message[1] as SdkLogRecord)
    })
    const logging = configured({ measurements: true }, true)
    const bus = new EventBus(() => logging)
    const scope = Scope.makeUnsafe()
    let now = 1_000_000n
    const clock = Object.assign(Object.create(Effect.runSync(Clock.Clock)) as Clock.Clock, {
        monotonicTimeNanosUnsafe: () => now,
    })
    await Effect.runPromise(
        bus
            .on<"typingStart", never, never, never, never>(
                "typingStart",
                () =>
                    Effect.sync(() => {
                        now += 25_000_000n
                    }),
                undefined,
                undefined,
                scope,
            )
            .pipe(Effect.withLogger(logger), Effect.provideService(Clock.Clock, clock)),
    )

    bus.offer("typingStart", { channelId: "1", userId: "2", timestamp: 0 }, 1)
    await vi.waitFor(() => expect(records).toHaveLength(1))
    await Effect.runPromise(Scope.close(scope, Exit.void))

    expect(records).toEqual([
        expect.objectContaining({
            category: "measurement",
            operation: "event.handler",
            stage: "handler",
            durationMs: 25,
            outcome: "success",
        }),
    ])
    expect(records.some((record) => record.category === "measurement" && record.stage === "network")).toBe(false)
})

test("measurement configuration and structured adapters reject invalid values", () => {
    for (const native of [false, true])
        expect(loggingConfiguration({ measurements: "yes" }, native)).toEqual(
            expect.objectContaining({ _tag: "ConfigurationError", field: "measurements" }),
        )
    expect(loggingConfiguration({ logger: {} }, false)).toEqual(
        expect.objectContaining({
            _tag: "ConfigurationError",
            field: "logger",
            message: "Use fromStructuredLogger or fromEffectLogger for a default logger",
        }),
    )
    expect(() => fromStructuredLogger(null as never)).toThrow(ConfigurationError)
})
