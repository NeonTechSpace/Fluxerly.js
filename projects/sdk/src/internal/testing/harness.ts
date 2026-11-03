/**
 * Test client harness shared by the default and native testing entry points: Option handling, log capture and the
 * in-memory transport pair.
 * Invariant: A test client reaches no network. Its options always route HTTP and WebSocket traffic through the fake
 * transport, its log records reach logs() and any caller sinks at the caller's level, its unhandled failures reach
 * failures() and the shutdown check at any level, and closing the harness closes every fake socket and refuses later
 * requests. This module has no Effect imports, so default declarations stay free of Effect.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
// Real timers even when a test fakes the global ones, so idle can count quiet event loop turns
import { clearTimeout, setTimeout } from "node:timers"
import { ClientClosedError, ConfigurationError } from "#sdk/errors"
import type { LogCategory, LogLevel, LogRecord, LoggingOptions, LogSink } from "#sdk/logging"
import type { TransportOptions } from "#sdk/rest"
import type { ClientDiagnostics } from "#sdk/client"
import type { LogCode } from "../code-catalogue.js"
import { clientServices } from "../client-registry.js"
import { clientOptionKeys } from "../configuration.js"
import { normalizeText } from "../field-text.js"
import { errorInfo, isThenable } from "../logging.js"
import { maskText } from "../masking.js"
import { unsupportedKeyHint } from "../suggest.js"
import { createFixtures, fixtureToken, type Fixtures, type WireMessage } from "./fixtures.js"
import { TestGateway } from "./gateway.js"
import { TestHttp, type TestRecordInput } from "./http.js"
import { UnhandledTestFailuresError } from "./errors.js"
import type { TestSayOptions, TestSettings, TestWaitOptions } from "./types.js"
import { timedWait, waitTimeout } from "./wait.js"

const defaultHeartbeatIntervalMs = 41_250
/** Consecutive quiet event loop turns after which idle treats the client as settled */
const idleTurns = 3
/**
 * Consecutive quiet event loop turns after which advance treats work that is still running as waiting for the manual
 * clock, such as a request in a rate limit wait or a handler awaiting waitFor, so the clock can move on. They count
 * only while every running handler and task run awaits an SDK call, so the turns measure SDK work in memory, never the
 * application's own I/O or timers
 */
const blockedTurns = 10

/**
 * The work in progress that idle waits for: The client's diagnostics, its scheduled task runs in progress and its
 * handler invocations, including received events still waiting for a handler that has not started. Handler
 * invocations and task runs whose code is not awaiting an SDK call are counted apart, because only the application can
 * end that wait
 */
export interface TestClientWork {
    readonly diagnostics: ClientDiagnostics
    readonly runningTasks: number
    readonly pendingHandlers: number
    readonly callbacksOutsideSdk: number
}

/** The client's work in progress that idle and say wait for, including scheduled task runs and queued handler events */
export function clientWork(client: { diagnostics(): TestClientWork["diagnostics"] }): () => TestClientWork {
    return () => {
        const services = clientServices(client)
        const handlers = services?.events.drainState()
        return {
            diagnostics: client.diagnostics(),
            runningTasks: services?.tasks.running ?? 0,
            pendingHandlers: handlers === undefined ? 0 : handlers.running + handlers.waiting,
            callbacksOutsideSdk:
                (services?.events.callbackRuns.outsideSdk ?? 0) + (services?.tasks.callbackRuns.outsideSdk ?? 0),
        }
    }
}

/**
 * Codes the failure reporter logs at Error for a handler, command, callback, scheduled task or onError hook failure, or
 * a subscription stopped by overflow. The reported value can be any error, such as the Fluxer rejection of a failed
 * reply a handler returned, so these records count whatever the error's origin
 */
const reportedFailureCodes: ReadonlySet<LogCode> = new Set<LogCode>([
    "events.handlerFailed",
    "events.hookFailed",
    "events.overflow",
    "commands.failed",
    "collectors.callbackFailed",
    "collectors.filterFailed",
    "cleanup.progressFailed",
    "cache.policyFailed",
    "lifecycle.observerFailed",
    "lifecycle.taskFailed",
])

/**
 * Whether a record reports a failure no application code handled: A failure the reporter logged at Error because no
 * onError hook took it, or another application callback failure logged at Error or Fatal
 */
function unhandledFailure(record: LogRecord): boolean {
    if (record.level !== "error" && record.level !== "fatal") return false
    if (reportedFailureCodes.has(record.code as LogCode)) return true
    return record.error?.origin === "application"
}

/** The parts of a client's logger that the harness uses */
interface TestLogger {
    errorTap: ((record: LogRecord) => void) | undefined
    readonly secrets: readonly string[]
    enabled(level: LogLevel, category: LogCategory): boolean
    outputFailure(error: unknown): void
}

/** Test settings that test clients accept besides the client options */
const testSettingKeys = ["user", "heartbeatIntervalMs"]

/** The default test client's own test settings, which the native test client does not accept */
export const defaultTestSettingKeys: readonly string[] = ["clock"]

/**
 * The controls of a manual test clock that advance drives: The current time, the earliest pending deadline and a move
 * that resumes every sleep due by the new time
 */
export interface TestTime {
    now(): number
    nextDeadline(): number | undefined
    moveTo(time: number): void
}

/**
 * Reject option keys that a test client does not accept, before any client exists. Transport and instance get their
 * own explanation, because the test client owns them, and so does a clock setting on a native test client. Any other
 * unknown key gets createClient's closest-name hint, listing the client keys a test client accepts, the test settings
 * and extraKeys, such as the runBot keys of createTestBot
 */
export function checkTestOptionKeys(options: object, extraKeys: readonly string[] = []): void {
    const { transport, instance } = options as { transport?: unknown; instance?: unknown }
    if (transport !== undefined || instance !== undefined)
        throw new ConfigurationError(
            "configuration",
            "Test clients own the transport and instance options, so neither may be supplied",
            { hint: "Remove transport and instance. Test clients always use hosted Fluxer endpoints in memory" },
        )
    if (Object.hasOwn(options, "clock") && !extraKeys.includes("clock"))
        throw new ConfigurationError("configuration", "The native test client has no clock option", {
            hint: "It follows the Effect Clock it is created with. Provide TestClock from effect/testing and move it with TestClock.adjust",
        })
    const supported = [
        ...clientOptionKeys.filter((key) => key !== "transport" && key !== "instance"),
        ...testSettingKeys,
        ...extraKeys,
    ]
    const unsupported = Object.keys(options).find(
        (key) => !supported.includes(key) && key !== "transport" && key !== "instance",
    )
    if (unsupported !== undefined)
        throw new ConfigurationError("configuration", `Unsupported option ${JSON.stringify(unsupported)}`, {
            hint: unsupportedKeyHint(unsupported, supported),
        })
}

/**
 * Reject the manual clock for a client that owns more than one shard, because the SDK spaces those shards' Identify
 * commands on the clock, so ready would wait for an advance. Automatic sharding is rejected too, because its plan can
 * hold several shards. Malformed sharding settings are left to client creation
 */
function checkManualClockShards(sharding: unknown) {
    let automatic = sharding === "auto"
    let local = 1
    if (typeof sharding === "object" && sharding !== null) {
        const { totalShards, shardIds } = sharding as { totalShards?: unknown; shardIds?: unknown }
        automatic = totalShards === "auto"
        local = Array.isArray(shardIds) ? shardIds.length : typeof totalShards === "number" ? totalShards : 1
    }
    if (automatic || local > 1)
        throw new ConfigurationError(
            "sharding",
            "The manual test clock supports one local shard and no automatic sharding",
            {
                hint: 'Pass one shardId, such as sharding: { totalShards: 2, shardIds: [1] }, or use clock: "real"',
            },
        )
}

/** The in-memory transport, records and fixtures owned by one test client */
export class TestHarness {
    readonly fixtures: Fixtures = createFixtures()
    readonly http: TestHttp
    readonly gateway: TestGateway
    readonly #records: LogRecord[] = []
    /** Every Error and Fatal record of the client, captured before its logging thresholds and deduplication */
    readonly #errors: LogRecord[] = []
    /** Unhandled failure records that failures() returned or shutdown already reported */
    readonly #observed = new WeakSet<LogRecord>()
    /** Pending idle waits, failed with ClientClosedError when the harness closes */
    readonly #idleWaits = new Set<(error: unknown) => void>()
    readonly #callerSinks: readonly LogSink[]
    /** The client's logger, which masks, filters and reports sink failures for test transport records. Set when the
     * client exists, and no request can come before that
     */
    #logger: TestLogger | undefined
    #closed = false
    /** The manual clock that advance moves, or undefined for a client on real time */
    readonly #time: TestTime | undefined
    /** The advance in progress, so a later call starts once it has finished */
    #advancing: Promise<void> = Promise.resolve()

    /**
     * Check the test options and build the fake transport. createTime makes the manual clock when the options select
     * clock "manual", and only the default test client passes it
     */
    constructor(options: object, createTime?: () => TestTime) {
        if (typeof options !== "object" || options === null)
            throw new ConfigurationError("configuration", "Test client options must be an object")
        checkTestOptionKeys(options, createTime === undefined ? [] : defaultTestSettingKeys)
        const { user, heartbeatIntervalMs = defaultHeartbeatIntervalMs } = options as TestSettings
        const clock = (options as { clock?: unknown }).clock
        if (clock !== undefined && clock !== "real" && clock !== "manual")
            throw new ConfigurationError("configuration", 'Test clock must be "real" or "manual"')
        if (clock === "manual") checkManualClockShards((options as { sharding?: unknown }).sharding)
        this.#time = clock === "manual" ? createTime?.() : undefined
        if (
            !Number.isSafeInteger(heartbeatIntervalMs) ||
            heartbeatIntervalMs < 1 ||
            heartbeatIntervalMs > 2_147_483_647
        )
            throw new ConfigurationError(
                "configuration",
                "Test heartbeatIntervalMs must be an integer from 1 through 2,147,483,647",
            )
        if (user !== undefined && (typeof user !== "object" || user === null || typeof user.id !== "string"))
            throw new ConfigurationError("configuration", "Test user must be a wire user object with a string id")
        const logging = (options as { logging?: unknown }).logging
        const sink = typeof logging === "object" && logging !== null ? (logging as LoggingOptions).sink : undefined
        this.#callerSinks = typeof sink === "function" ? [sink] : Array.isArray(sink) ? (sink as LogSink[]) : []
        const bot = user ?? this.fixtures.botUser()
        this.http = new TestHttp((record) => this.#record(record), { fixtures: this.fixtures, author: bot })
        this.gateway = new TestGateway({ user: bot, heartbeatIntervalMs })
    }

    /** Client options with the fake transport, a default token and log capture added to the caller's settings */
    clientOptions<O extends object>(options: O): O & { readonly token: string; readonly transport: TransportOptions } {
        const {
            user: _,
            heartbeatIntervalMs: __,
            clock: ___,
            ...client
        } = options as O & TestSettings & { readonly clock?: unknown }
        const logging = (client as { logging?: unknown }).logging
        const capture: LogSink = (record) => {
            this.#records.push(record)
        }
        const sink = (logging as { sink?: unknown } | undefined)?.sink
        return {
            ...client,
            token: (options as TestSettings).token ?? fixtureToken,
            transport: { fetch: this.http.fetch, webSocket: this.gateway.webSocket },
            // Malformed logging settings pass through unchanged, so client creation reports them as usual
            logging:
                logging === undefined
                    ? { sink: capture }
                    : typeof logging !== "object" || logging === null || Array.isArray(logging)
                      ? logging
                      : {
                            ...logging,
                            sink:
                                sink === undefined
                                    ? capture
                                    : typeof sink === "function"
                                      ? [sink, capture]
                                      : Array.isArray(sink) && sink.length > 0
                                        ? [...(sink as unknown[]), capture]
                                        : sink,
                        },
        } as O & { readonly token: string; readonly transport: TransportOptions }
    }

    /** Log records captured so far, in order */
    logs(): readonly LogRecord[] {
        return Object.freeze([...this.#records])
    }

    /**
     * Record an Error or Fatal record of the client before its thresholds and deduplication. Each entry point sets
     * this as the client logger's errorTap, so a quiet logging level cannot hide a failure from failures() or shutdown
     */
    readonly captureError = (record: LogRecord) => {
        this.#errors.push(record)
    }

    /** Unhandled failure records so far, in order. Returning them marks them as observed by the test */
    failures(): readonly LogRecord[] {
        const failures = this.#errors.filter(unhandledFailure)
        for (const record of failures) this.#observed.add(record)
        return Object.freeze(failures)
    }

    /** Throw UnhandledTestFailuresError for unhandled failures the test has not observed, then mark them observed */
    checkFailures() {
        const unobserved = this.#errors.filter((record) => unhandledFailure(record) && !this.#observed.has(record))
        if (unobserved.length === 0) return
        for (const record of unobserved) this.#observed.add(record)
        throw new UnhandledTestFailuresError(unobserved)
    }

    /**
     * Resolve once the client has no running handler, scheduled task run, REST request or unanswered test request and
     * produced no new log record, request or gateway command for several event loop turns. A scheduled task waiting for
     * its time does not count, so a test advances the manual clock or waits for its delay before checking its work
     */
    idle(work: () => TestClientWork, options: TestWaitOptions | undefined, signal?: AbortSignal): Promise<void> {
        const timeoutMs = waitTimeout(options)
        if (this.#closed) return Promise.reject(new ClientClosedError())
        return this.#settled(work, timeoutMs, signal, false)
    }

    /**
     * Wait as idle does. With waiting set, running work that stays quiet for blockedTurns turns, with no test request
     * awaiting its response and every running handler and task run awaiting an SDK call, also counts as settled,
     * because only moving the manual clock or the test can let it continue. A run awaiting anything else, such as the
     * application's own I/O, keeps the wait going as idle's does
     */
    #settled(
        work: () => TestClientWork,
        timeoutMs: number | undefined,
        signal: AbortSignal | undefined,
        waiting: boolean,
    ): Promise<void> {
        const state = () => {
            const {
                diagnostics: { events, rest, gatewayRequests },
                runningTasks,
                pendingHandlers,
                callbacksOutsideSdk,
            } = work()
            return {
                busy:
                    events.activeHandlers +
                        pendingHandlers +
                        rest.activeRequests +
                        rest.queuedRequests +
                        gatewayRequests.activeRequests +
                        runningTasks >
                    0,
                inSdk: callbacksOutsideSdk === 0,
            }
        }
        const activity = () =>
            `${this.#records.length}:${this.http.requests().length}:${this.gateway.commands().length}`
        return timedWait<void>("idle", timeoutMs, signal, (settle) => {
            let quiet = 0
            // Quiet turns in which work was still running, counted only by advance
            let blocked = 0
            let stalled = 0
            let last = activity()
            let timer: ReturnType<typeof setTimeout> | undefined
            // Set by a global setImmediate callback, which Effect fibers also run on. A turn in which it did not run
            // proves nothing, because fake timers that replace setImmediate stop every fiber, so it is never counted as quiet
            let turned = false
            const turn = () => {
                turned = true
            }
            const fail = (error: unknown) => settle({ error })
            // A zero-delay timer passes a whole event loop turn, including the immediate callbacks Effect fibers run on
            const check = () => {
                const now = activity()
                const still = turned && now === last && this.http.inFlight === 0
                const { busy, inSdk } = still ? state() : { busy: true, inSdk: false }
                quiet = still && !busy ? quiet + 1 : 0
                blocked = waiting && still && inSdk ? blocked + 1 : 0
                stalled = turned ? 0 : stalled + 1
                last = now
                if (quiet >= idleTurns || blocked >= blockedTurns) return settle({ value: undefined })
                if (stalled >= idleTurns)
                    return fail(
                        new ConfigurationError("configuration", "Test idle cannot settle while setImmediate is faked", {
                            hint: 'The SDK runs on setImmediate. Leave it real, for example vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })',
                        }),
                    )
                turned = false
                globalThis.setImmediate(turn)
                timer = setTimeout(check, 0)
            }
            globalThis.setImmediate(turn)
            timer = setTimeout(check, 0)
            this.#idleWaits.add(fail)
            return () => {
                clearTimeout(timer)
                this.#idleWaits.delete(fail)
            }
        })
    }

    /** The manual clock of this client, or undefined when it runs on real time */
    get time(): TestTime | undefined {
        return this.#time
    }

    /**
     * Move the manual clock forward by ms. The clock stops at each pending deadline up to the target in order, and
     * waits there until the client settles as idle does, so work a woken timer starts runs before the next deadline,
     * including timers it sets on the way. It then moves to the target and settles once more. Work that keeps running
     * but stays quiet for blockedTurns turns, with no test request awaiting its response and every running handler and
     * task run awaiting an SDK call, counts as waiting for the clock, so a request in a rate limit wait or a handler
     * awaiting waitFor cannot hold the clock still, while a handler awaiting its own I/O keeps the clock where it is.
     * Calls run one after another. Misuse throws synchronously, and a closed harness rejects with ClientClosedError
     */
    advance(work: () => TestClientWork, ms: number): Promise<void> {
        const time = this.#time
        if (time === undefined)
            throw new ConfigurationError("configuration", "Test advance needs the manual test clock", {
                hint: 'Pass clock: "manual" to createTestBot or createTestClient',
            })
        if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0)
            throw new ConfigurationError(
                "configuration",
                "Test advance ms must be a finite number of milliseconds, 0 or more",
            )
        if (this.#closed) return Promise.reject(new ClientClosedError())
        const settled = () =>
            this.#closed ? Promise.reject(new ClientClosedError()) : this.#settled(work, undefined, undefined, true)
        const run = async () => {
            const target = time.now() + ms
            await settled()
            for (let next = time.nextDeadline(); next !== undefined && next <= target; next = time.nextDeadline()) {
                time.moveTo(next)
                await settled()
            }
            time.moveTo(target)
            await settled()
        }
        const advanced = this.#advancing.then(run, run)
        // allow-silent: The caller receives this advance's outcome, and the next advance only waits for it to finish
        this.#advancing = advanced.then(undefined, () => undefined)
        return advanced
    }

    /**
     * Deliver a MESSAGE_CREATE from a human author, wait until the client settles as idle does, then return the
     * messages the client sent meanwhile. With the manual clock it settles as advance does at each stop, so work that
     * can continue only once the clock moves, such as a command awaiting waitFor, does not hold it forever.
     * Misuse and emitting before ready throw synchronously, as idle and emit do
     */
    say(
        work: () => TestClientWork,
        content: string,
        options: TestSayOptions | undefined,
        signal?: AbortSignal,
    ): Promise<readonly WireMessage[]> {
        if (typeof content !== "string")
            throw new ConfigurationError("configuration", "Test say content must be a string")
        const timeoutMs = waitTimeout(options, ["timeoutMs", "message"])
        const overrides = options?.message
        if (
            overrides !== undefined &&
            (typeof overrides !== "object" || overrides === null || Array.isArray(overrides))
        )
            throw new ConfigurationError("configuration", "Test say message overrides must be an object of wire fields")
        if (this.#closed) return Promise.reject(new ClientClosedError())
        const before = this.http.requests().length
        // Fluxer normalizes typed content before delivery, so "!ping " arrives as "!ping"
        const message = this.fixtures.message({ ...overrides, content: normalizeText(content) })
        this.gateway.emit("MESSAGE_CREATE", message, undefined)
        return this.#settled(work, timeoutMs, signal, this.#time !== undefined).then(() =>
            this.http.sentMessages(this.http.requests().slice(before)),
        )
    }

    /**
     * Watch this client logger's Error and Fatal records, and route test transport records through its current
     * thresholds, credential masking and sink failure handling
     */
    attachLogger(logger: TestLogger) {
        logger.errorTap = this.captureError
        this.#logger = logger
    }

    /** Record a test transport event in logs() and in caller sinks, at the client's current thresholds, masked and with
     * sink failures handled as SDK records are
     */
    #record(input: TestRecordInput) {
        const logger = this.#logger
        if (logger !== undefined && !logger.enabled(input.level, input.category)) return
        const secrets = logger?.secrets ?? []
        const mask = (text: string) => maskText(text, secrets)
        const { error, ...rest } = input
        const record: LogRecord = Object.freeze({
            time: new Date().toISOString(),
            ...rest,
            message: mask(input.message),
            ...(input.fields === undefined
                ? {}
                : {
                      fields: Object.fromEntries(
                          Object.entries(input.fields).map(([name, value]) => [
                              name,
                              typeof value === "string" ? mask(value) : value,
                          ]),
                      ),
                  }),
            ...(error === undefined ? {} : { error: errorInfo(error, "application", secrets) }),
        })
        this.#records.push(record)
        const failed = (error: unknown) => logger?.outputFailure(error)
        for (const sink of this.#callerSinks) {
            try {
                const result: unknown = sink(record)
                if (isThenable(result)) void Promise.resolve(result).then(undefined, failed)
            } catch (error) {
                failed(error)
            }
        }
    }

    /** Close the fake transport after the client shut down. Reports sockets the client left open */
    close() {
        if (this.#closed) return
        this.#closed = true
        this.http.close()
        for (const fail of this.#idleWaits) fail(new ClientClosedError())
        const open = this.gateway.close()
        if (open > 0)
            this.#record({
                level: "warn",
                category: "lifecycle",
                code: "testing.socketsLeftOpen",
                message: `The test client left ${open} gateway ${open === 1 ? "socket" : "sockets"} open after shutdown, so the test transport closed ${open === 1 ? "it" : "them"}`,
                fields: { sockets: open },
            })
    }
}
