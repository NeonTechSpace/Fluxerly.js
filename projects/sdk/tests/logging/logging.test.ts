import { Cause, Effect, Exit, Logger, References, Scope } from "effect"
import { inspect } from "node:util"
import { afterEach, expect, test, vi } from "vitest"
import { apiErrorDetail } from "../../src/api-errors.js"
import { ApplicationError, ConfigurationError } from "../../src/errors.js"
import { MessageError } from "../../src/message-errors.js"
import { createClient, describeError, type LogRecord } from "../../src/index.js"
import type { LogCode } from "../../src/internal/code-catalogue.js"
import { ClientLogger, loggingConfiguration } from "../../src/internal/logging.js"
import { maskPayload, maskText } from "../../src/internal/masking.js"
import { EventBus } from "../../src/internal/events.js"
import { driveSdkTime, sdkClock } from "../support/client-clock.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"

afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.useRealTimers()
})

function configured(value: unknown, native = false) {
    const result = loggingConfiguration(value, native)
    if (result instanceof ConfigurationError) throw result
    expect(result).toBeInstanceOf(ClientLogger)
    return result
}

function collect(settings: Record<string, unknown> = {}, native = false) {
    const records: LogRecord[] = []
    const logger = configured({ ...settings, sink: (record: LogRecord) => records.push(record) }, native)
    return { records, logger, codes: () => records.map((record) => record.code) }
}

const emit = (logger: ClientLogger, level: LogRecord["level"], category: LogRecord["category"], code = "test.record") =>
    logger.log({ level, category, code: code as LogCode, message: `${level} ${category}` })

test("levels and category overrides choose which records are emitted", () => {
    const warn = collect({ level: "warn", categories: { rest: "debug", cache: "silent" } })
    emit(warn.logger, "info", "lifecycle", "a")
    emit(warn.logger, "warn", "lifecycle", "b")
    emit(warn.logger, "debug", "rest", "c")
    emit(warn.logger, "trace", "rest", "d")
    emit(warn.logger, "error", "cache", "e")
    expect(warn.codes()).toEqual(["b", "c"])

    const silent = collect({ level: "silent" })
    emit(silent.logger, "fatal", "sdk")
    expect(silent.records).toEqual([])

    const defaults = collect()
    emit(defaults.logger, "debug", "gateway", "hidden")
    emit(defaults.logger, "info", "gateway", "shown")
    expect(defaults.codes()).toEqual(["shown"])
    expect(defaults.records[0]).toMatchObject({ level: "info", category: "gateway", message: "info gateway" })
    expect(Date.parse(defaults.records[0]!.time)).not.toBeNaN()
    expect(Object.isFrozen(defaults.records[0])).toBe(true)
})

test("debug and FLUXERLY_DEBUG enable Debug records only for the chosen categories", () => {
    const listed = collect({ debug: ["rest"] })
    emit(listed.logger, "debug", "rest", "rest")
    emit(listed.logger, "debug", "gateway", "gateway")
    emit(listed.logger, "trace", "rest", "trace")
    expect(listed.codes()).toEqual(["rest"])

    vi.stubEnv("FLUXERLY_DEBUG", "gateway, cache, nope")
    const environment = collect({ level: "error" })
    emit(environment.logger, "debug", "gateway", "gateway")
    emit(environment.logger, "debug", "cache", "cache")
    emit(environment.logger, "debug", "rest", "rest")
    environment.logger.banners()
    expect(environment.codes()).toEqual(["gateway", "cache"])

    const warned = collect()
    warned.logger.banners()
    expect(warned.records).toEqual([
        expect.objectContaining({
            level: "warn",
            code: "sdk.unknownDebugCategory",
            message: expect.stringContaining("nope"),
        }),
    ])

    vi.stubEnv("FLUXERLY_DEBUG", "1")
    const everything = collect()
    for (const category of ["lifecycle", "rest", "supervisor"] as const) emit(everything.logger, "debug", category)
    expect(everything.records).toHaveLength(3)
})

test("pretty output prints readable lines with indented stacks and json output prints records", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const pretty = configured({ format: "pretty" })
    pretty.log({
        level: "info",
        category: "rest",
        code: "rest.request",
        message: "GET /channels/:id returned 200 in 12 ms",
        route: "/channels/:id",
        status: 200,
        fields: { method: "GET" },
    })
    const failure = new TypeError("handler broke", { cause: new RangeError("inner") })
    pretty.log({
        level: "error",
        category: "events",
        code: "events.handlerFailed",
        message: "messageCreate handler failed",
        error: failure,
        origin: "application",
    })
    // The pretty layout is only promised to be readable, so check its facts rather than its columns
    const infoLine = String(log.mock.calls[0]![0])
    expect(infoLine.split("\n")).toHaveLength(1)
    for (const fact of ["INFO", "rest", "GET /channels/:id returned 200 in 12 ms", "route=/channels/:id", "method=GET"])
        expect(infoLine).toContain(fact)
    const errorLines = String(error.mock.calls[0]![0]).split("\n")
    expect(errorLines[0]).toContain("ERROR")
    expect(errorLines[0]).toContain("messageCreate handler failed")
    // The error, its stack frames and its cause follow on indented lines
    expect(errorLines.slice(1).every((line) => /^\s+\S/.test(line))).toBe(true)
    expect(errorLines.some((line) => /^\s+TypeError: handler broke$/.test(line))).toBe(true)
    expect(errorLines.some((line) => /^\s+at /.test(line))).toBe(true)
    expect(errorLines.some((line) => /^\s+Caused by: RangeError: inner$/.test(line))).toBe(true)

    log.mockClear()
    const json = configured({ format: "json" })
    json.log({
        level: "info",
        category: "cache",
        code: "cache.test" as LogCode,
        message: "json record",
        fields: { count: 2 },
    })
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({
        level: "info",
        category: "cache",
        code: "cache.test" as LogCode,
        message: "json record",
        fields: { count: 2 },
    })
})

test("dedupe collapses repeated warnings and reports suppressed counts", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    const { logger, records } = collect({ dedupe: { windowMs: 1_000 } })
    const repeat = () =>
        logger.log({ level: "warn", category: "events", code: "events.dropped", message: "queue is full" })
    for (let index = 0; index < 5; index++) repeat()
    logger.log({
        level: "info",
        category: "events",
        code: "events.other" as LogCode,
        message: "info is never collapsed",
    })
    logger.log({
        level: "info",
        category: "events",
        code: "events.other" as LogCode,
        message: "info is never collapsed",
    })
    expect(records.map((record) => record.message)).toEqual([
        "queue is full",
        "info is never collapsed",
        "info is never collapsed",
    ])
    expect(records[0]!.fields).toBeUndefined()
    vi.setSystemTime(new Date("2026-01-01T00:00:02Z"))
    repeat()
    expect(records.at(-1)).toMatchObject({ code: "events.dropped", fields: { repeated: 4 } })
    // The documented message suffix, checked once
    expect(records.at(-1)!.message).toBe("queue is full (repeated 4× since last shown)")
    repeat()
    repeat()
    expect(records).toHaveLength(4)
    logger.flush()
    expect(records).toHaveLength(5)
    expect(records.at(-1)).toMatchObject({ code: "events.dropped", fields: { repeated: 2 } })

    const plain = collect({ dedupe: false })
    for (let index = 0; index < 3; index++)
        plain.logger.log({ level: "error", category: "sdk", code: "sdk.test" as LogCode, message: "same" })
    expect(plain.records).toHaveLength(3)
})

test("sinks receive frozen records in order, and failing sinks are counted without stopping others", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const received: LogRecord[] = []
    const logger = configured({
        sink: [
            () => {
                throw new Error("sink threw")
            },
            () => Promise.reject(new Error("sink rejected")),
            (record: LogRecord) => {
                received.push(record)
            },
        ],
    })
    emit(logger, "info", "sdk", "first")
    emit(logger, "warn", "sdk", "second")
    expect(received.map((record) => record.code)).toEqual(["first", "second"])
    await vi.waitFor(() => expect(logger.counters().sinkFailures).toBe(4))
    expect(stderr).toHaveBeenCalledTimes(1)
    expect(String(stderr.mock.calls[0]![0])).toContain("sink threw")
})

test("credentials stay masked in messages, errors and unsafe payloads, and unsafe mode announces itself", () => {
    const token = "Mzk0.fixture-canary-token.value"
    const { logger, records } = collect({ unsafe: { payloads: true, categories: ["gateway"] } })
    logger.addSecret(token)
    logger.banners()
    expect(records[0]).toMatchObject({ level: "warn", code: "sdk.unsafePayloads" })
    const error = new Error(`request failed with Authorization: Bot ${token} for https://x/webhooks/1/secret-webhook`)
    logger.log({
        level: "error",
        category: "rest",
        code: "rest.test" as LogCode,
        message: `token ${token} leaked into text`,
        error,
        origin: "application",
        fields: { header: `Bearer ${token}` },
    })
    logger.payload("gateway", "gateway.payloadSent", "Sent opcode 2 payload", {
        op: 2,
        d: {
            token,
            client_secret: "client-secret-canary",
            nested: { authorization: "Bot other-token-canary" },
            invite: { code: "invite-code-canary", inviter: { id: "1" }, uses: 1 },
            link: "https://fluxer.gg/invite-link-canary",
            content: "private message content is allowed in unsafe mode",
        },
    })
    logger.payload("rest", "rest.payload" as LogCode, "not a selected category", { token })
    const serialized = JSON.stringify(records)
    for (const secret of [
        token,
        "secret-webhook",
        "client-secret-canary",
        "other-token-canary",
        "invite-code-canary",
        "invite-link-canary",
    ])
        expect(serialized).not.toContain(secret)
    expect(serialized).toContain("private message content is allowed in unsafe mode")
    expect(records.filter((record) => record.code === "gateway.payloadSent")).toEqual([
        expect.objectContaining({ level: "trace", category: "gateway" }),
    ])
    expect(records.some((record) => record.code === "rest.payload")).toBe(false)
    expect(maskText(`Bot ${token}`, [])).toBe("Bot [redacted]")
    expect(maskPayload({ access_token: "a", refresh_token: "b", password: "c" })).not.toMatch(/"[abc]"/)
})

test("REST requests produce Debug records with route templates, and retries and rate-limit waits are counted", async () => {
    const clock = sdkClock()
    let calls = 0
    stubFetchWithHostedDiscovery(async () => {
        calls++
        if (calls === 1) return new Response(null, { status: 503 })
        if (calls === 2) return Response.json({ retry_after: 0.02 }, { status: 429 })
        return Response.json({ id: "10", channel_id: "20", content: "x", author: { id: "30", username: "fixture" } })
    })
    const records: LogRecord[] = []
    const token = "fixture-only-not-a-credential-token"
    const client = createClient({
        token,
        logging: { categories: { rest: "debug", ratelimit: "debug" }, sink: (record) => records.push(record) },
    })
    expect((await driveSdkTime(clock, client.messages.fetch({ id: "10", channelId: "20" }))).isOk()).toBe(true)
    expect((await client.shutdown()).isOk()).toBe(true)
    const requests = records.filter((record) => record.code === "rest.request")
    expect(requests.map((record) => [record.status, record.attempt, record.route])).toEqual([
        [503, 1, "/channels/:id/messages/:id"],
        [429, 2, "/channels/:id/messages/:id"],
        [200, 3, "/channels/:id/messages/:id"],
    ])
    expect(requests[0]).toMatchObject({ level: "debug", category: "rest", durationMs: expect.any(Number) })
    expect(records.find((record) => record.code === "rest.retry")).toMatchObject({
        status: 503,
        delayMs: expect.any(Number),
    })
    expect(records.find((record) => record.code === "ratelimit.wait")).toMatchObject({
        level: "debug",
        status: 429,
        delayMs: 20,
        route: "/channels/:id/messages/:id",
    })
    expect(client.diagnostics().counters).toMatchObject({ restRetries: 1, rateLimitWaits: 1 })
    const serialized = JSON.stringify(records)
    for (const hidden of [token, "api.fluxer.app", "/channels/20"]) expect(serialized).not.toContain(hidden)
})

test("native records keep the real Cause and fluxerly annotations, and chosen Debug records pass the Effect minimum", async () => {
    const entries: {
        level: string
        message: unknown
        cause: Cause.Cause<unknown>
        annotations: Record<string, unknown>
    }[] = []
    const effectLogger = Logger.make((entry) => {
        entries.push({
            level: entry.logLevel,
            message: entry.message,
            cause: entry.cause,
            annotations: { ...entry.fiber.getRef(References.CurrentLogAnnotations) },
        })
    })
    const logger = configured({ categories: { rest: "debug" } }, true)
    const failure = new Error("native failure")
    await Effect.runPromise(
        Effect.gen(function* () {
            yield* logger.logEffect({
                level: "error",
                category: "events",
                code: "events.handlerFailed",
                message: "handler failed",
                error: failure,
                cause: Cause.fail(failure),
            })
            yield* logger.logEffect({ level: "debug", category: "rest", code: "rest.request", message: "debug" })
            yield* logger.logEffect({ level: "info", category: "rest", code: "rest.info" as LogCode, message: "info" })
        }).pipe(
            Effect.withLogger(effectLogger),
            Effect.annotateLogs("requestId", "caller"),
            Effect.provideService(References.MinimumLogLevel, "Warn"),
        ),
    )
    expect(entries.map((entry) => entry.annotations["fluxerly.code"])).toEqual(["events.handlerFailed", "rest.request"])
    expect(entries[0]).toMatchObject({
        level: "Error",
        annotations: { requestId: "caller", "fluxerly.category": "events" },
    })
    expect(entries[0]!.cause.reasons).toEqual([expect.objectContaining({ _tag: "Fail", error: failure })])
    expect(entries[1]!.level).toBe("Debug")
})

test("overflow policies drop and record events, and unmanaged sources report the stop", async () => {
    const records: LogRecord[] = []
    const logger = configured({ sink: (record: LogRecord) => records.push(record), dedupe: false })
    const bus = new EventBus(() => logger)
    const scope = Scope.makeUnsafe()
    const oldest = Effect.runSync(bus.open("typingStart", { maxPendingMessages: 2, overflow: "dropOldest" }))
    const newest = Effect.runSync(bus.open("typingStart", { maxPendingMessages: 2, overflow: "dropNewest" }))
    const stopping = Effect.runSync(bus.open("typingStart", { maxPendingMessages: 2 }))
    for (const timestamp of [1, 2, 3, 4])
        bus.offer("typingStart", { channelId: "1", userId: "2", timestamp } as never, 10)
    expect(Effect.runSync(oldest.take())).toMatchObject({ timestamp: 3 })
    expect(Effect.runSync(oldest.take())).toMatchObject({ timestamp: 4 })
    expect(Effect.runSync(newest.take())).toMatchObject({ timestamp: 1 })
    expect(Effect.runSync(newest.take())).toMatchObject({ timestamp: 2 })
    expect(stopping.active).toBe(false)
    expect(stopping.failure).toMatchObject({ _tag: "EventOverflowError", limit: "messages", capacity: 2 })
    expect(logger.counters().eventsDropped.overflow).toBe(2 + 2 + 3)
    expect(records.filter((record) => record.code === "events.dropped")).toHaveLength(4)
    expect(records.filter((record) => record.code === "events.overflow")).toEqual([
        expect.objectContaining({
            level: "warn",
            event: "typingStart",
            subscriptionId: stopping.id,
            error: expect.objectContaining({ name: "EventOverflowError", code: "events.overflow" }),
        }),
    ])
    expect(oldest.active && newest.active).toBe(true)
    await Effect.runPromise(Scope.close(scope, Exit.void))
    bus.stop()
})

test("unsafe REST payload records show bodies while the configured token stays masked", async () => {
    const token = "fixture-canary-token-value"
    stubFetchWithHostedDiscovery(async () =>
        Response.json({
            id: "10",
            channel_id: "20",
            content: `echo ${token}`,
            author: { id: "30", username: "fixture" },
        }),
    )
    const records: LogRecord[] = []
    const client = createClient({
        token,
        logging: { unsafe: { payloads: true, categories: ["rest"] }, sink: (record) => records.push(record) },
    })
    expect((await client.messages.send("20", { content: `hello ${token}` })).isOk()).toBe(true)
    await vi.waitFor(() => expect(records.some((record) => record.code === "rest.payloadReceived")).toBe(true))
    expect((await client.shutdown()).isOk()).toBe(true)
    const sent = records.find((record) => record.code === "rest.payloadSent")!
    expect(sent).toMatchObject({ level: "trace", category: "rest", route: "/channels/:id/messages" })
    expect(String(sent.fields?.payload)).toContain("hello [redacted]")
    expect(JSON.stringify(records)).not.toContain(token)
})

test("standalone scheme words mask only token-shaped values, while authorization contexts mask any value", () => {
    for (const prose of [
        "Bot processSignals must be a boolean",
        "Basic validation failed for the request",
        "Bearer tokens expire after one hour",
        "Bot someVeryLongIdentifierNameWithoutDigits",
    ])
        expect(maskText(prose)).toBe(prose)
    expect(maskText("Bot Mzk0NTQ2.fixture-canary.token-value")).toBe("Bot [redacted]")
    expect(maskText("Bearer 7f3c9a1e2b4d6f8a0c1e3b5d7f9a")).toBe("Bearer [redacted]")
    expect(maskText("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: [redacted]")
    expect(maskText('{"authorization":"Bot short"}')).not.toContain("short")
})

test("unsafe payloads print nothing at silent and announce themselves before the first payload at any other level", () => {
    const silent = collect({ level: "silent", unsafe: { payloads: true } })
    silent.logger.banners()
    silent.logger.payload("rest", "rest.payloadSent", "request body", { content: "private" })
    expect(silent.records).toEqual([])

    // A REST-only client never starts, so the first payload record brings the banner, even at level error
    const quiet = collect({ level: "error", unsafe: { payloads: true, categories: ["rest"] } })
    quiet.logger.payload("rest", "rest.payloadSent", "request body", { content: "private" })
    quiet.logger.payload("rest", "rest.payloadReceived", "response body", { content: "private" })
    quiet.logger.banners()
    expect(quiet.codes()).toEqual(["sdk.unsafePayloads", "rest.payloadSent", "rest.payloadReceived"])

    // A silent payload category prints no payload and needs no banner, while another category still does
    const mixed = collect({
        unsafe: { payloads: true, categories: ["rest", "gateway"] },
        categories: { rest: "silent" },
    })
    mixed.logger.payload("rest", "rest.payloadSent", "request body", {})
    expect(mixed.records).toEqual([])
    mixed.logger.payload("gateway", "gateway.payloadSent", "command", {})
    expect(mixed.codes()).toEqual(["sdk.unsafePayloads", "gateway.payloadSent"])
})

test("dedupe eviction reports the evicted record's suppressed repeats instead of losing them", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    const { logger, records } = collect({ dedupe: { windowMs: 60_000 } })
    const warn = (message: string) =>
        logger.log({ level: "warn", category: "events", code: "events.test" as LogCode, message })
    warn("first")
    warn("first")
    warn("first")
    for (let index = 0; index < 512; index++) warn(`other ${index}`)
    const first = records.filter((record) => record.message.startsWith("first"))
    expect(first.map((record) => record.fields?.repeated)).toEqual([undefined, 2])
})

test("deferred repeat summaries follow thresholds that configure lowered after the repeats", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
    const { logger, records } = collect({ dedupe: { windowMs: 60_000 } })
    const warn = (category: LogRecord["category"], message: string) =>
        logger.log({ level: "warn", category, code: "sdk.test" as LogCode, message })
    for (let index = 0; index < 3; index++) {
        warn("events", "evicted")
        warn("rest", "flushed")
    }
    expect(logger.configure({ categories: { events: "silent", rest: "error" } })).toBeUndefined()
    records.length = 0
    // One record past the dedupe capacity evicts the oldest key, events, and shutdown flushes the rest key
    for (let index = 0; index < 511; index++) warn("sdk", `other ${index}`)
    logger.flush()
    expect(records.filter((record) => record.category !== "sdk")).toEqual([])
    expect(records).toHaveLength(511)
})

test("console format and color are chosen per stream, and FLUXERLY_LOG_FORMAT sets the unconfigured format", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const stdoutTerminal = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
    const stderrTerminal = Object.getOwnPropertyDescriptor(process.stderr, "isTTY")
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true })
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true })
    vi.stubEnv("NO_COLOR", undefined)
    vi.stubEnv("FLUXERLY_LOG_FORMAT", undefined)
    vi.stubEnv("FLUXERLY_LOG_COLOR", undefined)
    try {
        const logger = configured({})
        logger.log({ level: "info", category: "sdk", code: "sdk.info" as LogCode, message: "to stdout" })
        logger.log({ level: "warn", category: "sdk", code: "sdk.warn" as LogCode, message: "to stderr" })
        expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ code: "sdk.info" as LogCode })
        const warned = String(error.mock.calls[0]![0])
        expect(warned).toMatch(/WARN.*to stderr/)
        expect(warned).toContain("\u001b[")

        vi.stubEnv("FLUXERLY_LOG_FORMAT", "pretty")
        vi.stubEnv("FLUXERLY_LOG_COLOR", "0")
        const child = configured({})
        child.log({ level: "info", category: "sdk", code: "sdk.info" as LogCode, message: "child line" })
        const line = String(log.mock.calls.at(-1)![0])
        expect(line).toMatch(/INFO +sdk +\[sdk\.info\] child line/)
        expect(line).not.toContain("\u001b[")
        // An explicit format still wins over the environment
        const explicit = configured({ format: "json" })
        explicit.log({ level: "info", category: "sdk", code: "sdk.info" as LogCode, message: "json line" })
        expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({ message: "json line" })
    } finally {
        if (stdoutTerminal) Object.defineProperty(process.stdout, "isTTY", stdoutTerminal)
        else delete (process.stdout as { isTTY?: boolean }).isTTY
        if (stderrTerminal) Object.defineProperty(process.stderr, "isTTY", stderrTerminal)
        else delete (process.stderr as { isTTY?: boolean }).isTTY
    }
})

test.each(["default", "native"] as const)(
    "%s console and Effect log output never shows a thrown error's credentials or extra properties",
    async (mode) => {
        const webhookToken = "webhook-canary-secret-value"
        const authorization = "Bot Mzk0NTQ2.header-canary.token-value"
        const failure = Object.assign(new Error(`POST https://api.fluxer.app/v1/webhooks/123/${webhookToken} failed`), {
            config: { headers: { Authorization: authorization } },
        })
        const printed: string[] = []
        const capture = (...args: unknown[]) =>
            void printed.push(args.map((arg) => inspect(arg, { depth: 8 })).join(" "))
        vi.spyOn(console, "log").mockImplementation(capture)
        vi.spyOn(console, "error").mockImplementation(capture)
        const logger = configured({}, mode === "native")
        const cause = Cause.die(failure)
        await Effect.runPromise(
            Effect.gen(function* () {
                yield* logger.logEffect({
                    level: "error",
                    category: "events",
                    code: "events.handlerFailed",
                    message: "handler failed",
                    error: failure,
                    cause,
                    origin: "application",
                })
                yield* logger.logEffect({
                    level: "error",
                    category: "events",
                    code: "events.other" as LogCode,
                    message: "x",
                    error: failure,
                })
            }).pipe(
                // The native path must hold up under Effect's own pretty printer, not only a custom logger
                Effect.provideService(Logger.CurrentLoggers, new Set([Logger.consolePretty()])),
            ),
        )
        const output = printed.join("\n")
        expect(output).toContain("handler failed")
        expect(output).not.toContain(webhookToken)
        expect(output).not.toContain("header-canary")
        expect(output).not.toContain("config")
    },
)

test("bare Fluxer bot tokens and token or secret values are masked, while snowflake pairs and prose stay readable", () => {
    // A fixture shaped like <application_id>.<secret>, whose secret is 32 random bytes in base64url
    const secret = "fixtureOnlyNotACredential0123456789abcdefgh"
    const token = `1456074443980800001.${secret}`
    for (const text of [
        `login failed for ${token}`,
        `FLUXER_BOT_TOKEN=${secret}`,
        `{"botToken":"${secret}"}`,
        `{"token": "${secret}"}`,
        `clientSecret: ${secret}`,
        `FLUXER_BOT_TOKEN: ${secret}`,
        `https://example.com/callback?access_token=${secret}&state=1`,
    ])
        expect(maskText(text), text).not.toContain(secret)
    // Any value after an assignment or a quoted key is a credential, even one without digits
    expect(maskText("client_secret=plain-value")).toBe("client_secret=[redacted]")
    expect(maskText('{"secret":"plain-value"}')).toBe('{"secret":"[redacted]"}')
    // An unquoted key and a colon in prose keep the following word
    for (const prose of ["Missing token: check config", "Rotate the secret: see the settings page", "token: none"])
        expect(maskText(prose)).toBe(prose)
    // The application ID part of a token is not secret and stays readable
    expect(maskText(`login failed for ${token}`)).toContain("1456074443980800001.")
    for (const prose of ["message 1456074443980800001.1456074443980800002 was deleted", "version 1.2.3", "tokens: 5"])
        expect(maskText(prose)).toBe(prose)
    // Payload keys ending in token or secret are masked too
    expect(maskPayload({ bot_token: secret, clientSecret: secret })).not.toContain(secret)
    // Error text built outside any client, such as describeError, masks the same shapes
    expect(describeError(new ApplicationError("setup", new Error(`cannot use ${token}`)))).not.toContain(secret)
})

test("unrecognized FLUXERLY_LOG_FORMAT and FLUXERLY_LOG_COLOR values are ignored with one startup Warn each", () => {
    vi.stubEnv("FLUXERLY_LOG_FORMAT", "jsonl")
    vi.stubEnv("FLUXERLY_LOG_COLOR", "maybe")
    const unknown = collect()
    unknown.logger.banners()
    unknown.logger.banners()
    expect(unknown.records.map((record) => [record.level, record.code, record.fields?.variable])).toEqual([
        ["warn", "sdk.unknownEnvironmentValue", "FLUXERLY_LOG_FORMAT"],
        ["warn", "sdk.unknownEnvironmentValue", "FLUXERLY_LOG_COLOR"],
    ])

    // Words people commonly use for a flag are accepted for color
    vi.stubEnv("FLUXERLY_LOG_FORMAT", "pretty")
    vi.stubEnv("NO_COLOR", undefined)
    for (const [value, color] of [
        ["yes", true],
        ["on", true],
        ["no", false],
        ["off", false],
    ] as const) {
        vi.stubEnv("FLUXERLY_LOG_COLOR", value)
        const accepted = collect()
        accepted.logger.banners()
        expect(accepted.records).toEqual([])
        expect(configured({}).consoleFormat("stdout")).toEqual({ format: "pretty", color })
    }
})

test("native records carry the error code, hint and safe details that default records carry", async () => {
    const annotations: Record<string, unknown>[] = []
    const printed: unknown[] = []
    const effectLogger = Logger.make((entry) => {
        annotations.push({ ...entry.fiber.getRef(References.CurrentLogAnnotations) })
        printed.push(...entry.cause.reasons.map((reason) => (reason._tag === "Fail" ? reason.error : undefined)))
    })
    const failure = new MessageError({
        reason: "rejected",
        outcome: "rejected",
        status: 403,
        apiError: apiErrorDetail({ code: "MISSING_PERMISSIONS" }),
    })
    const input = {
        level: "error",
        category: "events",
        code: "events.handlerFailed",
        message: "messageCreate handler failed",
        error: failure,
    } as const
    const nativeLogger = configured({}, true)
    await Effect.runPromise(nativeLogger.logEffect(input).pipe(Effect.withLogger(effectLogger)))
    const records: LogRecord[] = []
    configured({ sink: (record: LogRecord) => records.push(record) }).log(input)

    expect(records[0]!.error).toMatchObject({
        code: failure.code,
        hint: failure.hint,
        details: { apiError: "MISSING_PERMISSIONS" },
    })
    expect(annotations[0]).toMatchObject({
        "fluxerly.error.code": failure.code,
        "fluxerly.error.hint": failure.hint,
        "fluxerly.error.apiError": "MISSING_PERMISSIONS",
    })
    // The masked copy that Effect's printer shows names the code next to the error name
    expect(printed[0]).toMatchObject({ name: "MessageError", code: failure.code })
})

test("native records carry the code, hint and details of every error in the cause chain", async () => {
    const annotations: Record<string, unknown>[] = []
    const effectLogger = Logger.make((entry) => {
        annotations.push({ ...entry.fiber.getRef(References.CurrentLogAnnotations) })
    })
    const step = new MessageError({
        reason: "rejected",
        outcome: "rejected",
        status: 400,
        providerCode: "SOMETHING_NEW",
    })
    const failure = new MessageError({ reason: "network", outcome: "unknown", cause: step })
    const nativeLogger = configured({}, true)
    await Effect.runPromise(
        nativeLogger
            .logEffect({
                level: "error",
                category: "events",
                code: "events.handlerFailed",
                message: "messageCreate handler failed",
                error: failure,
            })
            .pipe(Effect.withLogger(effectLogger)),
    )
    expect(annotations[0]).toMatchObject({
        "fluxerly.error.code": failure.code,
        "fluxerly.error.reason": "network",
        "fluxerly.error.cause.code": step.code,
        "fluxerly.error.cause.status": 400,
        "fluxerly.error.cause.providerCode": "SOMETHING_NEW",
    })
})
