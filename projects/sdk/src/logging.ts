/**
 * Severity of an SDK log record, from most to least verbose
 *
 * @category Logging and diagnostics
 */
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal"

/**
 * A minimum severity for SDK log output, or silent to emit nothing
 *
 * @category Logging and diagnostics
 */
export type LogThreshold = LogLevel | "silent"

/** The SDK area that produced a log record. Use it with categories and debug to adjust output for one area.
 * The lifecycle category covers startup, readiness, connection loss and shutdown, gateway covers protocol traffic,
 * rest covers HTTP requests and retries, ratelimit covers rate-limit waits, and cache covers cache policy and expiry.
 * The events category covers subscriptions, handlers and dropped events, commands covers prefix commands,
 * collectors covers message and reaction collectors, supervisor covers child processes, and sdk covers the logger itself
 *
 * @category Logging and diagnostics
 */
export type LogCategory =
    | "lifecycle"
    | "gateway"
    | "rest"
    | "ratelimit"
    | "cache"
    | "events"
    | "commands"
    | "collectors"
    | "supervisor"
    | "sdk"

/** Readable facts about an error attached to a log record or failure report.
 * Application errors keep their name, string code, message, stack and cause chain with credentials masked.
 * SDK errors add their fixed code and hint
 *
 * @category Logging and diagnostics
 */
export interface ErrorInfo {
    /** Where the failure came from. The value application marks values thrown by application callbacks, provider marks Fluxer rejections and sdk marks SDK failures */
    readonly origin: "application" | "sdk" | "provider"
    /** Error name, such as TypeError or GuildOperationError, or Non-Error value (string) for a thrown value that is not an Error */
    readonly name: string
    /** Error message, or a text form of a thrown non-Error value */
    readonly message: string
    /** Fixed SDK error code, or a string code property of an application error with credentials masked */
    readonly code?: string
    /** Suggested next step from an SDK error */
    readonly hint?: string
    /** Stack trace, when the value had one */
    readonly stack?: string
    /** The next error in the cause chain, limited to a few levels */
    readonly cause?: ErrorInfo
    /** Safe structured facts from an SDK error */
    readonly details?: Readonly<Record<string, unknown>>
}

/** One structured SDK log record, delivered frozen to sinks and printed by the built-in console output.
 * Records never contain tokens, Authorization headers, client secrets or invite codes.
 * Message payload bodies appear only in explicit unsafe payload mode
 *
 * @category Logging and diagnostics
 */
export interface LogRecord {
    /** ISO 8601 wall-clock time when the SDK created the record */
    readonly time: string
    /** Record severity */
    readonly level: LogLevel
    /** SDK area that produced the record */
    readonly category: LogCategory
    /** Stable dotted identifier, such as lifecycle.ready, ratelimit.wait or events.dropped. Match on this rather than message */
    readonly code: string
    /** Readable sentence describing what happened, which can change between releases */
    readonly message: string
    /** Local shard that the record concerns */
    readonly shardId?: number
    /** REST route template with IDs replaced by placeholders, such as /channels/:id/messages */
    readonly route?: string
    /** Event name that the record concerns, such as messageCreate */
    readonly event?: string
    /** Prefix command name that the record concerns */
    readonly command?: string
    /** Identifier of the event subscription that the record concerns */
    readonly subscriptionId?: string
    /** Elapsed milliseconds for the described work */
    readonly durationMs?: number
    /** One-based attempt number for retried work */
    readonly attempt?: number
    /** Milliseconds until the next attempt or the end of a wait */
    readonly delayMs?: number
    /** HTTP status */
    readonly status?: number
    /** WebSocket close code */
    readonly closeCode?: number
    /** Other safe facts, such as counts, opcodes and dispatch types */
    readonly fields?: Readonly<Record<string, string | number | boolean | null>>
    /** The error that the record describes */
    readonly error?: ErrorInfo
}

/** A synchronous callback that receives each emitted SDK record.
 * Return values are ignored and promises are not awaited. A thrown error or rejected promise is counted in
 * diagnostics().counters.sinkFailures and reported once on standard error, without stopping SDK work or other sinks
 *
 * @category Logging and diagnostics
 */
export type LogSink = (record: LogRecord) => void

/**
 * Configure what the SDK logs and where the output goes. Both entry points accept the same settings.
 * With no settings, the SDK prints Info and higher records, including startup, readiness, connection loss,
 * rate-limit waits of at least one second, shutdown and full application errors.
 * The FLUXERLY_DEBUG environment variable, read when the client is created, enables Debug records:
 * 1, true or * for every category, or a comma-separated list such as gateway,rest.
 * HTTP 401 and 403 rejections log a rest.rejected Warn even when handled. An unhandled handler failure with that same
 * rejection, directly or in its cause chain, replaces its Warn if it happens within one second. A later handler failure
 * also logs its own record, because the Warn has already been emitted.
 * Logging never changes operation results, and records never contain credentials
 *
 * @category Logging and diagnostics
 */
export interface LoggingOptions {
    /** Minimum severity to emit, default info. The value silent emits nothing, including application error reports without
     * a hook and unsafe payload records
     */
    readonly level?: LogThreshold
    /** Per-category minimum severity that replaces level for that category, such as { rest: "debug", cache: "warn" } */
    readonly categories?: Readonly<Partial<Record<LogCategory, LogThreshold>>>
    /** Enable Debug records for every category with true, or for the listed categories.
     * Adds to FLUXERLY_DEBUG and lowers, never raises, the configured threshold
     */
    readonly debug?: boolean | readonly LogCategory[]
    /** Built-in console output format. The value pretty prints readable single lines with indented stacks, and json prints one LogRecord per line.
     * Info and lower records go to standard output and Warn and higher to standard error, and each stream decides its own default.
     * The default is pretty when that stream is a terminal and json otherwise.
     * Without this setting, the FLUXERLY_LOG_FORMAT environment variable, pretty or json, read when the client is created,
     * chooses the format for both streams, and FLUXERLY_LOG_COLOR forces color on with 1, true, yes or on, and off with
     * 0, false, no or off, for pretty output. Another nonempty value of either variable is ignored with one
     * sdk.unknownEnvironmentValue Warn at startup. NO_COLOR still disables color. A supervisor sets both variables for children whose output it forwards.
     * Native clients without sink or format send records to the Effect logger instead, and the environment variables do not change that
     */
    readonly format?: "pretty" | "json"
    /** Receive records instead of the built-in console output. Pass one function or an array of them.
     * Each sink is called synchronously in order for every emitted record
     */
    readonly sink?: LogSink | readonly LogSink[]
    /** Collapse repeated identical Warn, Error and Fatal records within a window.
     * The next identical record after the window reports how many were suppressed in fields.repeated and as "(repeated N× since last shown)" in its message,
     * and shutdown reports any remainder the same way. When more than 512 distinct records are tracked, the oldest one's window ends early and its count is reported then.
     * Default { windowMs: 60000 }. A false value or a windowMs of 0 disables collapsing
     */
    readonly dedupe?:
        | {
              /** Milliseconds during which identical records are collapsed, default 60,000. 0 disables collapsing */
              readonly windowMs?: number
          }
        | false
    /** Print received and sent payload bodies at Trace level for debugging, for all categories or the listed ones.
     * Payload records bypass the level setting, except that a category set to silent prints no payloads.
     * Payloads can contain private message content, so the SDK prints a Warn banner once, at startup or before the first
     * payload record, whichever comes first, even when the level would hide Warn records.
     * Received REST bodies show at most their first 65,536 bytes.
     * Tokens, Authorization headers, client secrets, passwords, cookies and invite codes stay masked even in this mode,
     * including credential-key values in a truncated JSON response
     */
    readonly unsafe?: {
        /** Must be true to acknowledge that payload bodies can contain private content */
        readonly payloads: true
        /** Print payloads only for these categories, such as gateway or rest. Omit for every category */
        readonly categories?: readonly LogCategory[]
    }
}

/**
 * The level and categories settings of LoggingOptions, which client.logging.configure replaces while a client runs
 *
 * @category Logging and diagnostics
 */
export type LogLevelSettings = Pick<LoggingOptions, "level" | "categories">

/**
 * Running totals for one client since creation, returned by diagnostics().counters. Values only increase
 *
 * @category Logging and diagnostics
 */
export interface ClientCounters {
    /** Event handler and command callbacks that threw or rejected */
    readonly handlerFailures: number
    /** Failed onError hooks, which threw or rejected while reporting a failure */
    readonly hookFailures: number
    /** Failure reports that could not be queued for a busy hook and were logged instead */
    readonly reportsDropped: number
    /** Events not delivered to a subscription, by reason. The reason overflow is a full queue, malformed is a rejected dispatch,
     * and collector is a full collector buffer
     */
    readonly eventsDropped: {
        /** Events dropped because a subscription queue was full */
        readonly overflow: number
        /** Gateway dispatches skipped because they failed validation */
        readonly malformed: number
        /** Messages or reactions dropped because a collector buffer was full */
        readonly collector: number
    }
    /** Gateway messages rejected as invalid protocol data, including skipped malformed dispatches */
    readonly protocolFailures: number
    /** Dispatch types the SDK does not handle */
    readonly unknownDispatches: number
    /** Gateway opcodes the SDK does not handle */
    readonly unknownOpcodes: number
    /** Automatic REST request retries */
    readonly restRetries: number
    /** REST rate-limit waits that took place. A limit whose wait would pass the request deadline fails the request
     * without waiting, logs ratelimit.deadline and is not counted here
     */
    readonly rateLimitWaits: number
    /** REST requests that failed with reason busy before sending, because the REST queue or the upload byte budget was
     * full. The first such failure in a minute also logs rest.busy at Warn
     */
    readonly restBusy: number
    /** Gateway reconnection attempts after an established connection was lost */
    readonly reconnects: number
    /** Successful session resumes */
    readonly resumes: number
    /** Log output failures: Sink and observe calls that threw or rejected, console or Effect logger output that failed,
     * and failure reports that could not be formatted. The first one is described on standard error
     */
    readonly sinkFailures: number
    /** Shutdown or subscription cleanup steps that failed */
    readonly cleanupFailures: number
    /** Prefix commands rejected by a guard, cooldown or argument parser */
    readonly commandRejections: number
    /** Messages with the command prefix that matched no command */
    readonly unmatchedCommands: number
}
