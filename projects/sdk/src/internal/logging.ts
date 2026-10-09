/**
 * Client logger: Levels, categories, record building, formats, sinks, deduplication and counters.
 * Invariant: A configured sink or format replaces the Effect logger, and the default API writes readable lines to a terminal and
 * JSON lines otherwise, deciding separately for standard output and standard error. Effect's cause printer shows raw messages,
 * stacks and own properties, so native records carry masked copies. Deduplication keeps a bounded key set, and sink failures are
 * counted and reported once to standard error without altering outcomes or recursing. Implements [SDK contracts: Logging](/docs/SDK-CONTRACTS.md#logging)
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Logger from "effect/Logger"
import * as References from "effect/References"
import type { ClientCounters, ErrorInfo, LogCategory, LogLevel, LogRecord, LogSink, LogThreshold } from "#sdk/logging"
import { ConfigurationError, FluxerlyError } from "#sdk/errors"
import { record } from "./decode/primitives.js"
import { readCaller, suspendMarked } from "./defects.js"
import { metrics } from "./metrics.js"
import { describeValue, errorSummary, maskPayload, maskText } from "./masking.js"
import { unsupportedKeyHint } from "./suggest.js"
import type { LogCode } from "./code-catalogue.js"

const logCategories = [
    "lifecycle",
    "gateway",
    "rest",
    "ratelimit",
    "cache",
    "events",
    "commands",
    "collectors",
    "supervisor",
    "sdk",
] as const satisfies readonly LogCategory[]

const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const satisfies readonly LogLevel[]
const rank: Record<LogThreshold, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5, silent: 6 }
/** Distinct Warn-or-higher records whose repeats are tracked at once */
const dedupeCapacity = 512
const effectLevels = {
    trace: "Trace",
    debug: "Debug",
    info: "Info",
    warn: "Warn",
    error: "Error",
    fatal: "Fatal",
} as const

let cachedVersion: string | undefined
/** The installed SDK version from the package manifest next to the compiled or source directory */
export function sdkVersion(): string {
    if (cachedVersion !== undefined) return cachedVersion
    try {
        const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as unknown
        cachedVersion = record(manifest) && typeof manifest.version === "string" ? manifest.version : "unknown"
    } catch {
        // allow-silent: A missing manifest only removes the version from the startup record
        cachedVersion = "unknown"
    }
    return cachedVersion
}

/** Record fields accepted from SDK call sites. The error is converted to ErrorInfo and cause keeps native Cause detail */
export interface LogInput {
    readonly level: LogLevel
    readonly category: LogCategory
    /** A catalogued code, so every emitted code has an entry on the error and log codes page */
    readonly code: LogCode
    readonly message: string
    readonly shardId?: number | undefined
    readonly route?: string | undefined
    readonly event?: string | undefined
    readonly command?: string | undefined
    readonly subscriptionId?: string | undefined
    readonly durationMs?: number | undefined
    readonly attempt?: number | undefined
    readonly delayMs?: number | undefined
    readonly status?: number | undefined
    readonly closeCode?: number | undefined
    readonly fields?: Readonly<Record<string, string | number | boolean | null | undefined>> | undefined
    readonly error?: unknown
    readonly origin?: ErrorInfo["origin"] | undefined
    readonly cause?: Cause.Cause<unknown> | undefined
}

type Counters = {
    -readonly [K in keyof ClientCounters]: ClientCounters[K] extends number
        ? number
        : { -readonly [R in keyof ClientCounters[K]]: number }
}
export type CounterName = Exclude<keyof ClientCounters, "eventsDropped">
export type DropReason = keyof ClientCounters["eventsDropped"]

/** Guarded text for any value, used for thrown non-Error values and dedupe keys */
const valueText = describeValue

/** ErrorInfo values built from SDK errors, whose stacks only show SDK internals */
const sdkInfos = new WeakSet<ErrorInfo>()

/** Convert any thrown or failed value to masked ErrorInfo, following the cause chain a few levels.
 * Never throws: Getters, proxies and null-prototype objects that reject inspection get a guarded description
 */
export function errorInfo(
    value: unknown,
    origin: ErrorInfo["origin"],
    secrets: readonly string[] = [],
    depth = 0,
): ErrorInfo {
    try {
        if (value instanceof Error) {
            const sdk = value instanceof FluxerlyError
            const code = sdk
                ? value.code
                : typeof (value as unknown as { code?: unknown }).code === "string"
                  ? (value as unknown as { code: string }).code
                  : undefined
            const apiError = sdk && (value as { apiError?: unknown }).apiError
            const cause = (value as { cause?: unknown }).cause
            const stack: unknown = value.stack
            const info: ErrorInfo = Object.freeze({
                origin: sdk ? (apiError ? "provider" : origin === "application" ? "application" : "sdk") : origin,
                name: maskText(String(value.name), secrets),
                message: maskText(String(value.message), secrets),
                ...(code === undefined ? {} : { code: sdk ? code : maskText(code, secrets) }),
                ...(sdk && value.hint !== undefined ? { hint: value.hint } : {}),
                ...(typeof stack === "string" ? { stack: maskText(stack, secrets) } : {}),
                ...(cause === undefined || depth >= 4 ? {} : { cause: errorInfo(cause, origin, secrets, depth + 1) }),
                ...(sdk && Object.keys(value.details).length ? { details: value.details } : {}),
            })
            if (sdk) sdkInfos.add(info)
            return info
        }
    } catch {
        // allow-silent: An Error-like value whose properties throw is described below instead of failing the record
    }
    let kind: string
    try {
        kind = value === null ? "null" : typeof value
    } catch {
        // allow-silent: The typeof operator never throws, but keep the description total
        kind = "unknown"
    }
    return Object.freeze({ origin, name: `Non-Error value (${kind})`, message: maskText(valueText(value), secrets) })
}

/** A copy of an error with its masked name, message, stack and cause chain, and only its code as another own property.
 * Effect's cause printer shows own enumerable properties, so native log records never receive the original value, and
 * the code appears next to the error name
 */
function maskedError(info: ErrorInfo): Error {
    const error = new Error(info.message, info.cause ? { cause: maskedError(info.cause) } : undefined)
    Object.defineProperty(error, "name", { value: info.name, configurable: true, writable: true, enumerable: false })
    if (info.code !== undefined) Object.defineProperty(error, "code", { value: info.code, enumerable: true })
    error.stack = info.stack ?? `${info.name}: ${info.message}`
    return error
}

/** The value a native log record shows in place of a failure or defect: Masked text or a masked Error copy */
function maskedValue(value: unknown, secrets: readonly string[]): unknown {
    if (typeof value === "string") return maskText(value, secrets)
    return maskedError(errorInfo(value, "sdk", secrets))
}

/** A Cause with every failure and defect replaced by its masked copy, keeping interruptions and annotations */
function maskedCause(cause: Cause.Cause<unknown>, secrets: readonly string[]): Cause.Cause<unknown> {
    return Cause.fromReasons(
        cause.reasons.map((reason) => {
            if (reason._tag === "Interrupt") return reason
            const copy =
                reason._tag === "Fail"
                    ? Cause.makeFailReason(maskedValue(reason.error, secrets))
                    : Cause.makeDieReason(maskedValue(reason.defect, secrets))
            return copy.annotate(Cause.reasonAnnotations(reason))
        }),
    )
}

/** Source and compiled directories of this SDK package, compared with forward slashes and, on Windows, lowercase */
const sdkDirectories = (() => {
    const root = fileURLToPath(new URL("../../", import.meta.url)).replaceAll("\\", "/")
    return [`${root}src/`, `${root}dist/`].map((directory) =>
        process.platform === "win32" ? directory.toLowerCase() : directory,
    )
})()

/** A stack frame with percent escapes decoded, or the frame unchanged when it has none or a malformed one */
function decodedFrame(frame: string): string {
    if (!frame.includes("%")) return frame
    try {
        return decodeURIComponent(frame)
    } catch {
        // allow-silent: A literal % in a plain file path is not an escape, so the frame is compared as written
        return frame
    }
}

/** Whether a stack frame runs inside this SDK or the Effect runtime rather than application code.
 * ESM frames print file URLs, which percent-encode spaces and non-ASCII characters in the install path, so both the
 * written and the decoded frame are compared with the decoded SDK directories
 */
function internalFrame(frame: string): boolean {
    return [frame, decodedFrame(frame)].some((form) => {
        let path = form.replaceAll("\\", "/")
        if (process.platform === "win32") path = path.toLowerCase()
        return (
            sdkDirectories.some((directory) => path.includes(directory)) ||
            /\/node_modules\/(?:\.pnpm\/)?effect[@/]/.test(path)
        )
    })
}

/** Whether a stack shows only where the SDK created an expected error. SdkDefect and ConfigurationError keep theirs,
 * since a defect needs its origin and a thrown configuration error points at the caller's line
 */
function internalStack(info: ErrorInfo): boolean {
    return sdkInfos.has(info) && info.name !== "SdkDefect" && info.name !== "ConfigurationError"
}

function detailText(value: unknown): string {
    if (typeof value === "string") return value
    try {
        return JSON.stringify(value) ?? String(value)
    } catch {
        // allow-silent: Details are frozen SDK facts, but a guarded description keeps the text total
        return describeValue(value)
    }
}

/** Readable multi-line text for an ErrorInfo, indented for console output: Title, hint, safe details and stack frames
 * for each error in the cause chain. Consecutive frames inside the SDK and Effect collapse into one line, and SDK
 * errors other than SdkDefect and ConfigurationError print no frames. JSON output keeps the full stack
 */
export function errorText(info: ErrorInfo, indent = "    ", stack = true): string {
    const lines: string[] = []
    let current: ErrorInfo | undefined = info
    let first = true
    while (current) {
        const title = `${current.name}${current.code === undefined ? "" : ` [${current.code}]`}: ${current.message}`
        lines.push(`${indent}${first ? "" : "Caused by: "}${title}`)
        if (current.hint) lines.push(`${indent}  Hint: ${current.hint}`)
        const details = Object.entries(current.details ?? {})
        if (details.length)
            lines.push(`${indent}  Details: ${details.map(([key, value]) => `${key}=${detailText(value)}`).join(" ")}`)
        if (stack && current.stack && !internalStack(current)) {
            let hidden = 0
            const flush = () => {
                if (hidden > 0)
                    lines.push(`${indent}  ... ${hidden} SDK and Effect frame${hidden === 1 ? "" : "s"} hidden`)
                hidden = 0
            }
            for (const frame of current.stack.split("\n").filter((line) => /^\s+at /.test(line))) {
                if (internalFrame(frame)) {
                    hidden++
                    continue
                }
                flush()
                lines.push(`${indent}  ${frame.trim()}`)
            }
            flush()
        }
        first = false
        current = current.cause
    }
    return lines.join("\n")
}

function formatTime(date: Date) {
    const pad = (value: number, width = 2) => String(value).padStart(width, "0")
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

const colors: Record<LogLevel, string> = {
    trace: "\u001b[90m",
    debug: "\u001b[36m",
    info: "\u001b[32m",
    warn: "\u001b[33m",
    error: "\u001b[31m",
    fatal: "\u001b[35m",
}

const recordKeys = [
    "shardId",
    "route",
    "event",
    "command",
    "subscriptionId",
    "status",
    "closeCode",
    "attempt",
    "delayMs",
    "durationMs",
] as const

/** One readable line per record, with key facts and an indented error */
function prettyLine(entry: LogRecord, color: boolean): string {
    const facts: string[] = []
    for (const key of recordKeys) {
        const value = entry[key]
        if (value === undefined) continue
        facts.push(`${key}=${typeof value === "number" && !Number.isInteger(value) ? value.toFixed(1) : value}`)
    }
    for (const [key, value] of Object.entries(entry.fields ?? {}))
        facts.push(`${key}=${typeof value === "string" && /\s/.test(value) ? JSON.stringify(value) : value}`)
    const level = entry.level.toUpperCase().padEnd(5)
    const code = color ? `\u001b[90m[${entry.code}]\u001b[0m` : `[${entry.code}]`
    const head = `${formatTime(new Date(entry.time))} ${color ? `${colors[entry.level]}${level}\u001b[0m` : level} ${entry.category.padEnd(10)} ${code} ${entry.message}`
    const line = facts.length
        ? `${head} ${color ? "\u001b[90m" : ""}${facts.join(" ")}${color ? "\u001b[0m" : ""}`
        : head
    return entry.error ? `${line}\n${errorText(entry.error)}` : line
}

function jsonLine(entry: LogRecord): string {
    return JSON.stringify(entry, (_, value) => (typeof value === "bigint" ? value.toString() : value))
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return (
        (typeof value === "object" || typeof value === "function") &&
        value !== null &&
        typeof (value as { then?: unknown }).then === "function"
    )
}

type Settings = {
    readonly thresholds: Readonly<Record<LogCategory, number>>
    readonly sinks: readonly LogSink[] | undefined
    readonly format: "pretty" | "json" | undefined
    /** FLUXERLY_LOG_FORMAT read at creation, used by the built-in console output when format is not set */
    readonly environmentFormat: "pretty" | "json" | undefined
    /** FLUXERLY_LOG_COLOR read at creation: `true` forces color, `false` disables it, `undefined` follows the terminal */
    readonly environmentColor: boolean | undefined
    readonly dedupeMs: number | undefined
    readonly unsafe: ReadonlySet<LogCategory> | undefined
    readonly debugCategories: ReadonlySet<LogCategory>
    readonly unknownDebug: readonly string[]
    /** Logging environment variables whose values were not recognized and are ignored */
    readonly unknownEnvironment: readonly { readonly variable: string; readonly accepted: string }[]
}

type Dedupe = { shownAt: number; suppressed: number; last: LogInput | undefined }

/** One client's logging configuration, counters and output. Emission is synchronous and never fails its caller */
export class ClientLogger {
    readonly #settings: Settings
    /** Category thresholds, replaced by configure while the client runs */
    #thresholds: Readonly<Record<LogCategory, number>>
    /** Categories lowered to Debug: The debug setting and FLUXERLY_DEBUG at creation, until configure replaces them */
    #debugCategories: ReadonlySet<LogCategory>
    #secrets: string[] = []
    readonly #counters: Counters = {
        handlerFailures: 0,
        hookFailures: 0,
        reportsDropped: 0,
        eventsDropped: { overflow: 0, malformed: 0, collector: 0, closed: 0 },
        cacheChangesDropped: 0,
        protocolFailures: 0,
        unknownDispatches: 0,
        unknownOpcodes: 0,
        restRetries: 0,
        rateLimitWaits: 0,
        restBusy: 0,
        reconnects: 0,
        resumes: 0,
        sinkFailures: 0,
        cleanupFailures: 0,
        commandRejections: 0,
        unmatchedCommands: 0,
    }
    readonly #dedupe = new Map<string, Dedupe>()
    /** Error values already shown in an Error or Fatal record, so the bot runner does not print a final failure twice */
    readonly #loggedErrors = new WeakSet<object>()
    #sinkFailureReported = false
    #bannerShown = false
    #unsafeBannerShown = false
    /** Native context used when a record is emitted outside a fiber, normally the client's creation context */
    context: Context.Context<never> | undefined
    /** Receives every Error and Fatal record before level thresholds and deduplication. The test kit sets it, so its
     * failure checks see unhandled failures however quiet the test client's logging is
     */
    errorTap: ((record: LogRecord) => void) | undefined

    constructor(
        settings: Settings,
        readonly native: boolean,
    ) {
        this.#settings = settings
        this.#thresholds = settings.thresholds
        this.#debugCategories = settings.debugCategories
    }

    /**
     * Replace the level and category thresholds from caller settings. A debug setting replaces the Debug categories,
     * including those from FLUXERLY_DEBUG, and an omitted one keeps the current categories. Invalid settings return
     * ConfigurationError and change nothing. Caller reads are marked, so the caller must run this under a defect boundary
     */
    configure(value: unknown): ConfigurationError | undefined {
        const settings = readCaller(() => {
            if (!record(value)) return new ConfigurationError("logging", "Logging level settings must be an object")
            const keys = ["level", "categories", "debug"]
            const unsupported = Object.keys(value).find((key) => !keys.includes(key))
            if (unsupported !== undefined)
                return new ConfigurationError(
                    "logging",
                    `Unsupported logging level setting ${JSON.stringify(unsupported)}`,
                    {
                        hint: `${unsupportedKeyHint(unsupported, keys, "settings")}. Other logging settings are fixed at creation`,
                    },
                )
            const thresholds = levelThresholds(value)
            if (thresholds instanceof ConfigurationError) return thresholds
            const debug = value.debug
            const debugCategories = debug === undefined ? undefined : debugSetting(debug)
            if (debugCategories instanceof ConfigurationError) return debugCategories
            return { thresholds, debugCategories }
        })
        if (settings instanceof ConfigurationError) return settings
        const { thresholds, debugCategories } = settings
        if (debugCategories !== undefined) this.#debugCategories = new Set(debugCategories)
        for (const category of this.#debugCategories) thresholds[category] = Math.min(thresholds[category], rank.debug)
        this.#thresholds = Object.freeze(thresholds)
        return undefined
    }

    /** Mask this credential in every later record */
    addSecret(secret: string) {
        if (secret.length >= 6 && !this.#secrets.includes(secret)) this.#secrets.push(secret)
    }

    get secrets(): readonly string[] {
        return this.#secrets
    }

    enabled(level: LogLevel, category: LogCategory): boolean {
        return rank[level] >= this.#thresholds[category]
    }

    unsafePayloads(category: LogCategory): boolean {
        return this.#settings.unsafe?.has(category) === true
    }

    count(name: CounterName, amount = 1) {
        this.#counters[name] += amount
        try {
            if (name === "reconnects") metrics.reconnect(this.context)
        } catch (error) {
            this.#sinkFailure(error)
        }
    }

    countDrop(reason: DropReason, amount = 1) {
        this.#counters.eventsDropped[reason] += amount
        try {
            metrics.dropped(reason, amount, this.context)
        } catch (error) {
            this.#sinkFailure(error)
        }
    }

    counters(): ClientCounters {
        return Object.freeze({ ...this.#counters, eventsDropped: Object.freeze({ ...this.#counters.eventsDropped }) })
    }

    /** Record an intentionally discarded item: Count it, then log at Debug for expected drops or Warn for anomalies */
    drop(
        counter: CounterName | { readonly event: DropReason; readonly amount?: number } | undefined,
        input: LogInput & { readonly level: "debug" | "warn" | "error" },
        context?: Context.Context<never>,
    ) {
        if (typeof counter === "string") this.count(counter)
        else if (counter) this.countDrop(counter.event, counter.amount)
        this.log(input, context)
    }

    /** Emit the startup banners once per client, including the unsafe payload warning and unknown debug categories */
    banners(context?: Context.Context<never>) {
        if (this.#bannerShown) return
        this.#bannerShown = true
        this.#unsafeBanner(context)
        if (this.#settings.unknownDebug.length)
            this.log(
                {
                    level: "warn",
                    category: "sdk",
                    code: "sdk.unknownDebugCategory",
                    message: `FLUXERLY_DEBUG names unknown categories, which are ignored: ${this.#settings.unknownDebug.join(", ")}. Known categories are ${logCategories.join(", ")}`,
                    fields: { known: logCategories.join(",") },
                },
                context,
            )
        for (const { variable, accepted } of this.#settings.unknownEnvironment)
            this.log(
                {
                    level: "warn",
                    category: "sdk",
                    code: "sdk.unknownEnvironmentValue",
                    message: `${variable} has an unrecognized value and is ignored. Accepted values are ${accepted}`,
                    fields: { variable, accepted },
                },
                context,
            )
    }

    /** Whether any unsafe payload category can print, so the unsafe banner is due */
    #unsafeVisible(): boolean {
        const unsafe = this.#settings.unsafe
        if (!unsafe) return false
        for (const category of unsafe) if (this.#thresholds[category] < rank.silent) return true
        return false
    }

    /** Warn once that payload printing is on, at startup or before the first payload record, whichever comes first.
     * It bypasses level thresholds so a Warn-or-higher level cannot hide it, while silent payload categories print nothing
     */
    #unsafeBanner(context: Context.Context<never> | undefined) {
        if (this.#unsafeBannerShown || !this.#unsafeVisible()) return
        this.#unsafeBannerShown = true
        this.#emit(
            {
                level: "warn",
                category: "sdk",
                code: "sdk.unsafePayloads",
                message:
                    "Unsafe payload logging is enabled. Trace records include gateway and REST payloads, which can contain private message content. Bot tokens and other secrets stay masked",
                fields: { categories: [...this.#settings.unsafe!].join(",") },
            },
            context,
        )
    }

    /** Print a masked payload body at Trace when unsafe payload logging covers this category.
     * A silent category prints nothing. Otherwise the unsafe banner precedes the first payload record
     */
    payload(category: LogCategory, code: LogCode, message: string, value: unknown, extra?: Partial<LogInput>) {
        if (!this.unsafePayloads(category) || this.#thresholds[category] >= rank.silent) return
        this.#unsafeBanner(undefined)
        this.#emit(
            {
                ...extra,
                level: "trace",
                category,
                code,
                message,
                fields: { ...extra?.fields, payload: maskPayload(value, this.#secrets) },
            },
            undefined,
        )
    }

    /** Emit a record synchronously when its category threshold allows it. Output failures never reach the caller */
    log(input: LogInput, context?: Context.Context<never>) {
        if (this.errorTap !== undefined && rank[input.level] >= rank.error)
            try {
                this.errorTap(this.#record(input))
            } catch (error) {
                this.#sinkFailure(error)
            }
        if (!this.enabled(input.level, input.category)) return
        if (rank[input.level] >= rank.error && typeof input.error === "object" && input.error !== null)
            this.#loggedErrors.add(input.error)
        if (rank[input.level] >= rank.warn && this.#settings.dedupeMs !== undefined) {
            // The shard and subscription keep the same fault on different shards or subscriptions apart
            const key = `${input.level}|${input.code}|${input.shardId ?? ""}|${input.subscriptionId ?? ""}|${input.message}|${this.#errorKey(input.error)}`
            const now = Date.now()
            const entry = this.#dedupe.get(key)
            if (entry && now - entry.shownAt < this.#settings.dedupeMs) {
                entry.suppressed++
                entry.last = input
                return
            }
            const suppressed = entry?.suppressed ?? 0
            this.#dedupe.delete(key)
            this.#dedupe.set(key, { shownAt: now, suppressed: 0, last: undefined })
            if (this.#dedupe.size > dedupeCapacity) {
                const [evicted, oldest] = this.#dedupe.entries().next().value!
                this.#dedupe.delete(evicted)
                // Eviction ends that key's window early, so announce what it suppressed instead of losing the count,
                // unless configure has since silenced that level
                if (oldest.suppressed > 0 && oldest.last && this.enabled(oldest.last.level, oldest.last.category))
                    this.#emit(this.#repeated(oldest.last, oldest.suppressed), context)
            }
            if (suppressed > 0) input = this.#repeated(input, suppressed)
        }
        this.#emit(input, context)
    }

    /** Whether this error value already appeared in an Error or Fatal record of this logger */
    loggedError(error: unknown): boolean {
        return typeof error === "object" && error !== null && this.#loggedErrors.has(error)
    }

    /** Emit through the current fiber's context, so native records keep the caller's logger, annotations and spans */
    logEffect(input: LogInput): Effect.Effect<void> {
        return Effect.withFiber((fiber) => {
            this.log(input, fiber.context)
            return Effect.void
        })
    }

    /** Report suppressed duplicates that no later record announced and the current thresholds allow, normally during shutdown */
    flush(context?: Context.Context<never>) {
        for (const [key, entry] of this.#dedupe) {
            if (entry.suppressed > 0 && entry.last && this.enabled(entry.last.level, entry.last.category))
                this.#emit(this.#repeated(entry.last, entry.suppressed), context)
            this.#dedupe.delete(key)
        }
    }

    #repeated(input: LogInput, suppressed: number): LogInput {
        return {
            ...input,
            message: `${input.message} (repeated ${suppressed}× since last shown)`,
            fields: { ...input.fields, repeated: suppressed },
        }
    }

    #errorKey(error: unknown) {
        return error === undefined ? "" : errorSummary(error)
    }

    #record(input: LogInput): LogRecord {
        const fields: Record<string, string | number | boolean | null> = {}
        for (const [key, value] of Object.entries(input.fields ?? {}))
            if (value !== undefined) fields[key] = typeof value === "string" ? maskText(value, this.#secrets) : value
        const entry: Record<string, unknown> = {
            time: new Date().toISOString(),
            level: input.level,
            category: input.category,
            code: input.code,
            message: maskText(input.message, this.#secrets),
        }
        for (const key of recordKeys) if (input[key] !== undefined) entry[key] = input[key]
        if (Object.keys(fields).length) entry.fields = Object.freeze(fields)
        if (input.error !== undefined) entry.error = errorInfo(input.error, input.origin ?? "sdk", this.#secrets)
        return Object.freeze(entry) as unknown as LogRecord
    }

    #emit(input: LogInput, context: Context.Context<never> | undefined) {
        let entry: LogRecord
        try {
            entry = this.#record(input)
        } catch (error) {
            this.#sinkFailure(error)
            return
        }
        const sinks = this.#settings.sinks
        if (sinks) {
            for (const sink of sinks) {
                try {
                    const result: unknown = sink(entry)
                    if (isThenable(result))
                        void Promise.resolve(result).then(undefined, (error: unknown) => this.#sinkFailure(error))
                } catch (error) {
                    this.#sinkFailure(error)
                }
            }
            return
        }
        if (this.native && this.#settings.format === undefined) {
            this.#effectLog(entry, input, context ?? this.context)
            return
        }
        this.#console(entry)
    }

    /** The built-in console format and color for one output stream, which decides from its own terminal state.
     * Warn and higher records go to standard error. Supervisors pass the parent's choice to their children
     */
    consoleFormat(stream: "stdout" | "stderr"): { readonly format: "pretty" | "json"; readonly color: boolean } {
        const terminal = (stream === "stderr" ? process.stderr : process.stdout).isTTY === true
        const format = this.#settings.format ?? this.#settings.environmentFormat ?? (terminal ? "pretty" : "json")
        const color =
            format === "pretty" && process.env.NO_COLOR === undefined && (this.#settings.environmentColor ?? terminal)
        return { format, color }
    }

    #console(entry: LogRecord) {
        try {
            const error = rank[entry.level] >= rank.warn
            const { format, color } = this.consoleFormat(error ? "stderr" : "stdout")
            const text = format === "pretty" ? prettyLine(entry, color) : jsonLine(entry)
            if (error) console.error(text)
            else console.log(text)
        } catch (error) {
            this.#sinkFailure(error)
        }
    }

    #effectLog(entry: LogRecord, input: LogInput, context: Context.Context<never> | undefined) {
        const annotations: Record<string, unknown> = {
            "fluxerly.category": entry.category,
            "fluxerly.code": entry.code,
        }
        for (const key of recordKeys) if (entry[key] !== undefined) annotations[`fluxerly.${key}`] = entry[key]
        for (const [key, value] of Object.entries(entry.fields ?? {})) annotations[`fluxerly.${key}`] = value
        // The code, hint and safe details of each error in the cause chain, which the default console output prints too.
        // The first cause uses the prefix fluxerly.error.cause., its cause fluxerly.error.cause.cause., and so on
        for (let error = entry.error, prefix = "fluxerly.error."; error; error = error.cause, prefix += "cause.") {
            if (error.code !== undefined) annotations[`${prefix}code`] = error.code
            if (error.hint !== undefined) annotations[`${prefix}hint`] = error.hint
            for (const [key, value] of Object.entries(error.details ?? {}))
                annotations[`${prefix}${key}`] = typeof value === "object" && value !== null ? detailText(value) : value
        }
        let cause: Cause.Cause<unknown> | undefined
        try {
            const original =
                input.cause ??
                (input.error === undefined
                    ? undefined
                    : input.error instanceof FluxerlyError
                      ? Cause.fail(input.error)
                      : Cause.die(input.error))
            // Effect's cause printer shows raw messages, stacks and own properties, so it only receives masked copies
            cause = original && maskedCause(original, this.#secrets)
        } catch (error) {
            this.#sinkFailure(error)
            cause = undefined
        }
        let log: Effect.Effect<void> = Effect.logWithLevel(effectLevels[entry.level])(
            entry.message,
            ...(cause ? [cause] : []),
        ).pipe(Effect.annotateLogs(annotations))
        // SDK settings already chose this Debug or Trace record, so the Effect minimum level must not hide it again
        if (rank[entry.level] < rank.info)
            log = log.pipe(Effect.provideService(References.MinimumLogLevel, effectLevels[entry.level]))
        try {
            const exit = context ? Effect.runSyncExitWith(context)(log) : Effect.runSyncExit(log)
            if (exit._tag === "Failure") this.#sinkFailure(Cause.squash(exit.cause))
        } catch (error) {
            this.#sinkFailure(error)
        }
    }

    /** Count a log output or failure-reporting fault and describe the first one on standard error. Never throws */
    outputFailure(error: unknown) {
        this.#sinkFailure(error)
    }

    #sinkFailure(error: unknown) {
        this.#counters.sinkFailures++
        if (this.#sinkFailureReported) return
        this.#sinkFailureReported = true
        try {
            process.stderr.write(
                `Fluxerly log output failed: ${maskText(errorSummary(error), this.#secrets)}. Later failures are counted in diagnostics().counters.sinkFailures\n`,
            )
        } catch {
            // allow-silent: Standard error itself failed, and the counter still records the sink failure
        }
    }

    /** A default-runtime Effect logger that turns stray Effect log calls from SDK internals into SDK records */
    bridge(): Logger.Logger<unknown, void> {
        return Logger.make((options) => {
            const level = (Object.entries(effectLevels).find(([, value]) => value === options.logLevel)?.[0] ??
                "info") as LogLevel
            const message = Array.isArray(options.message)
                ? options.message.map((part) => valueText(part)).join(" ")
                : valueText(options.message)
            const failure =
                Cause.isCause(options.cause) && options.cause.reasons.length ? Cause.squash(options.cause) : undefined
            this.log({
                level,
                category: "sdk",
                code: "sdk.effectLog",
                message,
                ...(failure === undefined ? {} : { error: failure }),
            })
        })
    }

    /** Run default-API work with SDK-internal Effect logs routed into this client's records */
    provide<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
        return this.native
            ? effect
            : effect.pipe(
                  Effect.provideService(Logger.CurrentLoggers, new Set([this.bridge()])),
                  Effect.provideService(References.MinimumLogLevel, "Trace"),
              )
    }
}

/** A validated threshold. The option names the setting as typed, such as logging.level or logging.categories.rest */
function threshold(value: unknown, field: "level" | "categories", option: string): LogThreshold | ConfigurationError {
    if (typeof value === "string" && (value === "silent" || (levels as readonly string[]).includes(value)))
        return value as LogThreshold
    return new ConfigurationError(
        field,
        `The option ${JSON.stringify(option)} must be trace, debug, info, warn, error, fatal or silent`,
    )
}

/** FLUXERLY_LOG_COLOR values, compared after trimming and lowercasing */
const colorValues = { 1: true, true: true, yes: true, on: true, 0: false, false: false, no: false, off: false } as const

/** Parse FLUXERLY_DEBUG: 1, true or * enable every category, otherwise a comma-separated category list */
function debugEnvironment(value: string | undefined): { categories: LogCategory[]; unknown: string[] } {
    if (value === undefined || value.trim() === "" || value.trim() === "0" || value.trim().toLowerCase() === "false")
        return { categories: [], unknown: [] }
    const parts = value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    if (parts.some((part) => part === "1" || part === "*" || part.toLowerCase() === "true"))
        return { categories: [...logCategories], unknown: [] }
    return {
        categories: parts.filter((part): part is LogCategory => (logCategories as readonly string[]).includes(part)),
        unknown: parts.filter((part) => !(logCategories as readonly string[]).includes(part)),
    }
}

/** Caller logging settings after validation, before the logger combines them with the environment */
interface LoggingInput {
    readonly thresholds: Record<LogCategory, number>
    readonly debugCategories: readonly LogCategory[]
    readonly format: "pretty" | "json" | undefined
    readonly sinks: LogSink[] | undefined
    readonly dedupeMs: number | undefined
    readonly unsafe: Set<LogCategory> | undefined
}

/** Validate the level and categories settings into category thresholds, reading each setting once */
function levelThresholds(settings: Record<string, unknown>): Record<LogCategory, number> | ConfigurationError {
    const level = settings.level
    const base = level === undefined ? "info" : threshold(level, "level", "logging.level")
    if (base instanceof ConfigurationError) return base
    const thresholds = Object.fromEntries(logCategories.map((category) => [category, rank[base]])) as Record<
        LogCategory,
        number
    >
    const categories = settings.categories
    if (categories !== undefined) {
        if (!record(categories))
            return new ConfigurationError(
                "categories",
                'The option "logging.categories" must be an object of category levels',
            )
        for (const [category, level] of Object.entries(categories)) {
            if (!(logCategories as readonly string[]).includes(category))
                return new ConfigurationError("categories", `Unknown log category ${JSON.stringify(category)}`, {
                    hint: unsupportedKeyHint(category, logCategories, "categories"),
                })
            if (level === undefined) continue
            const parsed = threshold(level, "categories", `logging.categories.${category}`)
            if (parsed instanceof ConfigurationError) return parsed
            thresholds[category as LogCategory] = rank[parsed]
        }
    }
    return thresholds
}

/** Validate a debug setting into its categories: True for every category, false for none or a list of categories */
function debugSetting(debug: unknown): LogCategory[] | ConfigurationError {
    if (debug === true) return [...logCategories]
    if (debug === false) return []
    if (!Array.isArray(debug))
        return new ConfigurationError(
            "debug",
            'The option "logging.debug" must be true, false or an array of categories',
        )
    const categories: LogCategory[] = []
    for (const category of debug) {
        if (!(logCategories as readonly unknown[]).includes(category))
            return new ConfigurationError(
                "debug",
                typeof category === "string"
                    ? `Unknown log category ${JSON.stringify(category)} in logging.debug`
                    : 'The option "logging.debug" must list log category names',
                {
                    hint:
                        typeof category === "string"
                            ? unsupportedKeyHint(category, logCategories, "categories")
                            : `Known categories are ${logCategories.join(", ")}`,
                },
            )
        categories.push(category as LogCategory)
    }
    return categories
}

/** Validate caller logging settings, reading each setting once so the validated value is the one used */
function loggingInput(value: unknown): LoggingInput | ConfigurationError {
    if (value !== undefined && !record(value))
        return new ConfigurationError("logging", "Logging settings must be an object")
    const settings = (value ?? {}) as Record<string, unknown>
    const keys = ["level", "categories", "debug", "format", "sink", "dedupe", "unsafe"]
    const unsupported = Object.keys(settings).filter((key) => !keys.includes(key))
    if (unsupported.length)
        return new ConfigurationError("logging", `Unsupported logging setting ${JSON.stringify(unsupported[0])}`, {
            hint: unsupported.some((key) => ["development", "measurements", "minimumLevel", "logger"].includes(key))
                ? "The settings development, measurements, minimumLevel and logger no longer exist. Use level, categories, debug, format and sink instead"
                : unsupportedKeyHint(unsupported[0]!, keys, "settings"),
        })
    const thresholds = levelThresholds(settings)
    if (thresholds instanceof ConfigurationError) return thresholds
    const debug = settings.debug
    const debugCategories = debug === undefined ? [] : debugSetting(debug)
    if (debugCategories instanceof ConfigurationError) return debugCategories
    const format = settings.format
    if (format !== undefined && format !== "pretty" && format !== "json")
        return new ConfigurationError("format", 'The option "logging.format" must be "pretty" or "json"')
    let sinks: LogSink[] | undefined
    const sink = settings.sink
    if (sink !== undefined) {
        const list = Array.isArray(sink) ? [...(sink as unknown[])] : [sink]
        if (list.length === 0 || list.some((entry) => typeof entry !== "function"))
            return new ConfigurationError(
                "sink",
                'The option "logging.sink" must be a function or a non-empty array of functions',
            )
        sinks = list as LogSink[]
    }
    let dedupeMs: number | undefined = 60_000
    const dedupe = settings.dedupe
    if (dedupe === false) dedupeMs = undefined
    else if (dedupe !== undefined) {
        if (!record(dedupe) || Object.keys(dedupe).some((key) => key !== "windowMs"))
            return new ConfigurationError(
                "dedupe",
                'The option "logging.dedupe" must be false or an object with windowMs',
            )
        const windowMs = dedupe.windowMs
        if (windowMs !== undefined && (typeof windowMs !== "number" || !Number.isSafeInteger(windowMs) || windowMs < 0))
            return new ConfigurationError(
                "dedupe",
                'The option "logging.dedupe.windowMs" must be a nonnegative safe integer of milliseconds',
            )
        dedupeMs = windowMs === 0 ? undefined : (windowMs ?? 60_000)
    }
    let unsafe: Set<LogCategory> | undefined
    const option = settings.unsafe
    if (option !== undefined) {
        if (
            !record(option) ||
            option.payloads !== true ||
            Object.keys(option).some((key) => key !== "payloads" && key !== "categories")
        )
            return new ConfigurationError(
                "unsafe",
                'The option "logging.unsafe" must be { payloads: true }, with optional categories',
            )
        const unsafeCategories = option.categories
        if (unsafeCategories === undefined) unsafe = new Set(logCategories)
        else if (
            !Array.isArray(unsafeCategories) ||
            unsafeCategories.some((category) => !(logCategories as readonly unknown[]).includes(category))
        )
            return new ConfigurationError(
                "unsafe",
                'The option "logging.unsafe.categories" must be an array of log category names',
                { hint: `Known categories are ${logCategories.join(", ")}` },
            )
        else unsafe = new Set(unsafeCategories as LogCategory[])
    }
    return { thresholds, debugCategories, format, sinks, dedupeMs, unsafe }
}

/** Run client.logging.configure: Replace the logger's thresholds and, when given, its Debug categories, failing with ConfigurationError for invalid settings */
export const configureLogging = (logger: ClientLogger, settings: unknown): Effect.Effect<void, ConfigurationError> =>
    suspendMarked(() => {
        const failure = logger.configure(settings)
        return failure === undefined ? Effect.void : Effect.fail(failure)
    })

/**
 * Validate and copy logging settings, then create the logger. Both entry points accept the same keys.
 * Only reading the caller settings is marked as application input, so the caller must run this under a defect boundary
 */
export function loggingConfiguration(value: unknown, native: boolean): ClientLogger | ConfigurationError {
    const input = readCaller(() => loggingInput(value))
    if (input instanceof ConfigurationError) return input
    const { thresholds, format, sinks, dedupeMs, unsafe } = input
    const debugCategories = new Set<LogCategory>(input.debugCategories)
    const environment = debugEnvironment(process.env.FLUXERLY_DEBUG)
    const formatVariable = process.env.FLUXERLY_LOG_FORMAT?.trim().toLowerCase()
    const colorVariable = process.env.FLUXERLY_LOG_COLOR?.trim().toLowerCase()
    const environmentFormat = formatVariable === "pretty" || formatVariable === "json" ? formatVariable : undefined
    const environmentColor =
        colorVariable === undefined ? undefined : colorValues[colorVariable as keyof typeof colorValues]
    // An empty variable counts as unset, and any other value that is not recognized gets one startup Warn
    const unknownEnvironment = [
        ...(formatVariable && environmentFormat === undefined
            ? [{ variable: "FLUXERLY_LOG_FORMAT", accepted: "pretty, json" }]
            : []),
        ...(colorVariable && environmentColor === undefined
            ? [{ variable: "FLUXERLY_LOG_COLOR", accepted: Object.keys(colorValues).join(", ") }]
            : []),
    ]
    for (const category of environment.categories) debugCategories.add(category)
    for (const category of debugCategories) thresholds[category] = Math.min(thresholds[category], rank.debug)
    return new ClientLogger(
        {
            thresholds: Object.freeze(thresholds),
            sinks: sinks && Object.freeze(sinks),
            format,
            environmentFormat,
            environmentColor,
            dedupeMs,
            unsafe,
            debugCategories,
            unknownDebug: environment.unknown,
            unknownEnvironment,
        },
        native,
    )
}
