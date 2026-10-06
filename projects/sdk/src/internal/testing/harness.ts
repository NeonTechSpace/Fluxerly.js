/**
 * Test client harness shared by the default and native testing entry points: Option handling, log capture and the
 * in-memory transport pair.
 * Invariant: A test client reaches no network. Its options always route HTTP and WebSocket traffic through the fake
 * transport, its log records reach logs() and any caller sinks at the caller's level, and closing the harness closes
 * every fake socket and refuses later requests. This module has no Effect imports, so default declarations stay free of Effect.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
// Real timers even when a test fakes the global ones, so idle can count quiet event loop turns
import { clearTimeout, setTimeout } from "node:timers"
import { ClientClosedError, ConfigurationError } from "#sdk/errors"
import type { LogCategory, LogRecord, LoggingOptions, LogSink, LogThreshold } from "#sdk/logging"
import type { TransportOptions } from "#sdk/rest"
import type { ClientDiagnostics } from "#sdk/client"
import type { LogCode } from "../code-catalogue.js"
import { clientOptionKeys } from "../configuration.js"
import { unsupportedKeyHint } from "../suggest.js"
import { createFixtures, fixtureToken, type Fixtures, type WireMessage } from "./fixtures.js"
import { TestGateway } from "./gateway.js"
import { TestHttp } from "./http.js"
import { UnhandledTestFailuresError } from "./errors.js"
import type { TestSayOptions, TestSettings, TestWaitOptions } from "./types.js"
import { timedWait, waitTimeout } from "./wait.js"

const defaultHeartbeatIntervalMs = 41_250
const levels: readonly LogThreshold[] = ["trace", "debug", "info", "warn", "error", "fatal", "silent"]
/** Consecutive quiet event loop turns after which idle treats the client as settled */
const idleTurns = 3

/**
 * Codes the failure reporter logs at Error for a handler, command, callback or onError hook failure, or a subscription
 * stopped by overflow. The reported value can be any error, such as the Fluxer rejection of a failed reply a handler
 * returned, so these records count whatever the error's origin
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
])

/**
 * Whether a record reports a failure no application code handled: A failure the reporter logged at Error because no
 * onError hook took it, or another application callback failure logged at Error or Fatal. Failures of the test's own
 * response handlers are excluded, because they deliberately simulate network errors
 */
function unhandledFailure(record: LogRecord): boolean {
    if (record.level !== "error" && record.level !== "fatal") return false
    if (reportedFailureCodes.has(record.code as LogCode)) return true
    return record.error?.origin === "application" && !record.code.startsWith("testing.")
}

/** Whether a record at this level and category passes the caller's thresholds, as the SDK logger decides */
function passes(logging: LoggingOptions | undefined, level: LogRecord["level"], category: LogCategory): boolean {
    const threshold = logging?.categories?.[category] ?? logging?.level ?? "info"
    return levels.indexOf(level) >= levels.indexOf(threshold)
}

/** Test settings that test clients accept besides the client options */
const testSettingKeys = ["user", "heartbeatIntervalMs"]

/**
 * Reject option keys that a test client does not accept, before any client exists. Transport and instance get their
 * own explanation, because the test client owns them. Any other unknown key gets createClient's closest-name hint,
 * listing the client keys a test client accepts, the test settings and extraKeys, such as the runBot keys of createTestBot
 */
export function checkTestOptionKeys(options: object, extraKeys: readonly string[] = []): void {
    const { transport, instance } = options as { transport?: unknown; instance?: unknown }
    if (transport !== undefined || instance !== undefined)
        throw new ConfigurationError(
            "configuration",
            "Test clients own the transport and instance options, so neither may be supplied",
            { hint: "Remove transport and instance. Test clients always use hosted Fluxer endpoints in memory" },
        )
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

/** The in-memory transport, records and fixtures owned by one test client */
export class TestHarness {
    readonly fixtures: Fixtures = createFixtures()
    readonly http: TestHttp
    readonly gateway: TestGateway
    readonly #records: LogRecord[] = []
    /** Unhandled failure records that failures() returned or shutdown already reported */
    readonly #observed = new WeakSet<LogRecord>()
    /** Pending idle waits, failed with ClientClosedError when the harness closes */
    readonly #idleWaits = new Set<(error: unknown) => void>()
    readonly #callerSinks: readonly LogSink[]
    readonly #logging: LoggingOptions | undefined
    #closed = false

    constructor(options: object) {
        if (typeof options !== "object" || options === null)
            throw new ConfigurationError("configuration", "Test client options must be an object")
        checkTestOptionKeys(options)
        const { user, heartbeatIntervalMs = defaultHeartbeatIntervalMs } = options as TestSettings
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
        this.#logging = typeof logging === "object" && logging !== null ? (logging as LoggingOptions) : undefined
        const sink = this.#logging?.sink
        this.#callerSinks = typeof sink === "function" ? [sink] : Array.isArray(sink) ? (sink as LogSink[]) : []
        const bot = user ?? this.fixtures.botUser()
        this.http = new TestHttp((record) => this.#record(record), { fixtures: this.fixtures, author: bot })
        this.gateway = new TestGateway({ user: bot, heartbeatIntervalMs })
    }

    /** Client options with the fake transport, a default token and log capture added to the caller's settings */
    clientOptions<O extends object>(options: O): O & { readonly token: string; readonly transport: TransportOptions } {
        const { user: _, heartbeatIntervalMs: __, ...client } = options as O & TestSettings
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
                    : typeof logging !== "object" || logging === null
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

    /** Unhandled failure records so far, in order. Returning them marks them as observed by the test */
    failures(): readonly LogRecord[] {
        const failures = this.#records.filter(unhandledFailure)
        for (const record of failures) this.#observed.add(record)
        return Object.freeze(failures)
    }

    /** Throw UnhandledTestFailuresError for unhandled failures the test has not observed, then mark them observed */
    checkFailures() {
        const unobserved = this.#records.filter((record) => unhandledFailure(record) && !this.#observed.has(record))
        if (unobserved.length === 0) return
        for (const record of unobserved) this.#observed.add(record)
        throw new UnhandledTestFailuresError(unobserved)
    }

    /**
     * Resolve once the client has no running handler, REST request or unanswered test request and produced no new log
     * record, request or gateway command for several event loop turns
     */
    idle(
        diagnostics: () => ClientDiagnostics,
        options: TestWaitOptions | undefined,
        signal?: AbortSignal,
    ): Promise<void> {
        const timeoutMs = waitTimeout(options)
        if (this.#closed) return Promise.reject(new ClientClosedError())
        const busy = () => {
            const { events, rest, gatewayRequests } = diagnostics()
            return (
                events.activeHandlers + rest.activeRequests + rest.queuedRequests + gatewayRequests.activeRequests > 0
            )
        }
        const activity = () =>
            `${this.#records.length}:${this.http.requests().length}:${this.gateway.commands().length}`
        return timedWait<void>("idle", timeoutMs, signal, (settle) => {
            let quiet = 0
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
                quiet = turned && now === last && this.http.inFlight === 0 && !busy() ? quiet + 1 : 0
                stalled = turned ? 0 : stalled + 1
                last = now
                if (quiet >= idleTurns) return settle({ value: undefined })
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

    /**
     * Deliver a MESSAGE_CREATE from a human author, wait until the client settles as idle does, then return the
     * messages the client sent meanwhile. Misuse and emitting before ready throw synchronously, as idle and emit do
     */
    say(
        diagnostics: () => ClientDiagnostics,
        content: string,
        options: TestSayOptions | undefined,
        signal?: AbortSignal,
    ): Promise<readonly WireMessage[]> {
        if (typeof content !== "string")
            throw new ConfigurationError("configuration", "Test say content must be a string")
        waitTimeout(options)
        const overrides = options?.message
        if (
            overrides !== undefined &&
            (typeof overrides !== "object" || overrides === null || Array.isArray(overrides))
        )
            throw new ConfigurationError("configuration", "Test say message overrides must be an object of wire fields")
        if (this.#closed) return Promise.reject(new ClientClosedError())
        const before = this.http.requests().length
        this.gateway.emit("MESSAGE_CREATE", this.fixtures.message({ ...overrides, content }), undefined)
        return this.idle(diagnostics, options, signal).then(() =>
            this.http.sentMessages(this.http.requests().slice(before)),
        )
    }

    /** Record a test transport event in logs() and in caller sinks, at the caller's thresholds */
    #record(input: Omit<LogRecord, "time">) {
        if (!passes(this.#logging, input.level, input.category)) return
        const record: LogRecord = Object.freeze({ time: new Date().toISOString(), ...input })
        this.#records.push(record)
        for (const sink of this.#callerSinks) {
            try {
                sink(record)
            } catch (error) {
                // A failing caller sink stays visible in the test's own output, as it would for SDK records
                console.error("Fluxerly test log sink failed:", error)
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
