import { adaptStructuredLogger } from "#sdk/internal/logging"

declare const loggerBrand: unique symbol

/** A logger adapted for a default-API client's logging.logger setting.
 * Create one with fromStructuredLogger from the default entry point or fromEffectLogger from the Effect entry point
 */
export interface DefaultLogger {
    /** Type-only marker that prevents constructing an integration without the SDK adapter */
    readonly [loggerBrand]: true
}

/** The severity attached to a structured SDK log record */
export type SdkLogLevel = "All" | "Trace" | "Debug" | "Info" | "Warn" | "Error" | "Fatal" | "None"

/** Stable connection events emitted when development logging is enabled */
export type SdkLifecycleEvent =
    | "connecting"
    | "attempt"
    | "connected"
    | "connectionLost"
    | "retry"
    | "sessionReset"
    | "connectionEnded"
    | "closing"
    | "closed"

/** Fields shared by every structured SDK log record */
export interface SdkLogRecordBase {
    /** Identifies records created by this SDK */
    readonly source: "fluxerly"
    /** ISO 8601 wall-clock time at which the SDK emitted the record */
    readonly timestamp: string
    /** Severity selected by the SDK before the configured minimum-level filter */
    readonly level: SdkLogLevel
}

/** A safe, low-cardinality connection record emitted when development logging is enabled */
export interface SdkLifecycleLogRecord extends SdkLogRecordBase {
    readonly category: "lifecycle"
    readonly event: SdkLifecycleEvent
    readonly phase?: "startup" | "recovery"
    readonly attempt?: number
    readonly delayMs?: number
    readonly mode?: "identify" | "resume"
    readonly failure?: string
    /** This client's local shard identifier, not whole-bot or cross-process state */
    readonly shardId?: number
}

/** Stable measurement operations available to SDK instrumentation */
export type SdkMeasurementOperation = "gateway.connection" | "rest.request" | "event.handler"

/** Stable stages that divide an operation without exposing a URL, payload or resource identifier */
export type SdkMeasurementStage = "queue" | "network" | "decode" | "handler"

/** A safe, low-cardinality timing record emitted when measurements are enabled */
export interface SdkMeasurementLogRecord extends SdkLogRecordBase {
    readonly category: "measurement"
    readonly event: "measurement"
    readonly operation: SdkMeasurementOperation
    readonly stage: SdkMeasurementStage
    /** Elapsed monotonic time in milliseconds */
    readonly durationMs: number
    readonly outcome: "success" | "failure" | "cancelled"
    readonly retryCount?: number
}

/** A safe operational-error record. Failure objects, causes and application data are not included */
export interface SdkOperationalLogRecord extends SdkLogRecordBase {
    readonly category: "operation"
    readonly event: "stateObserverFailed" | "eventSubscriptionFailed" | "operationFailed"
    readonly subscriptionEvent?: string
    readonly failureKind?: "handler" | "overflow"
    readonly reporterFailed?: boolean
}

/** A structured SDK record containing only SDK-owned, bounded diagnostic fields */
export type SdkLogRecord = SdkLifecycleLogRecord | SdkMeasurementLogRecord | SdkOperationalLogRecord

/** A synchronous callback for one structured SDK log record */
export type StructuredLogger = (record: SdkLogRecord) => void

/**
 * Adapt a plain JavaScript callback for logging.logger on a default-API client.
 * The callback receives frozen records without credentials, private payloads, URLs, Effect causes or application annotations.
 * Delivery is synchronous and the callback's return value is ignored. Thrown callback errors are swallowed without retry.
 * A promise or thenable returned by mistake is not awaited, and its rejection is discarded. Blocking work can delay SDK work.
 * The application owns any intentional asynchronous delivery, buffering, flushing and persistence.
 * Settings and records remain local to the client that receives the returned adapter
 * @throws ConfigurationError with field logger when logger is not a function
 * @example
 * ```ts
 * import { createClient, fromStructuredLogger } from "@neontechspace/fluxerly"
 *
 * const records = []
 * const client = createClient({
 *     token: "YOUR_BOT_TOKEN",
 *     logging: { development: true, logger: fromStructuredLogger((record) => records.push(record)) },
 * })
 * ```
 */
export function fromStructuredLogger(logger: StructuredLogger): DefaultLogger {
    return adaptStructuredLogger(logger)
}

/** Opt into SDK diagnostics without enabling or disabling operational error reports.
 * Native clients use the executing Effect context's logger, minimum level, annotations and spans, not default-API logger settings
 */
export interface LoggingOptions {
    /**
     * Log connection attempts, readiness, loss, retry waits, session resets and shutdown at Info level.
     * Defaults to false, even when the Effect runtime enables Debug output.
     * The configured minimum log level can still suppress these records.
     * Records contain SDK event and phase names, attempt counts, millisecond delays and safe failure categories, not credentials or private payloads.
     * Multi-shard records identify this client's local shard, not other processes or whole-bot state.
     * Output is best-effort, not a lossless history or confirmation that a sink stored the record
     */
    readonly development?: boolean
    /**
     * Emit low-cardinality queue, network, decode and handler timing records at Info level.
     * Defaults to false. Records use stable SDK operation and outcome names without URLs, payloads, credentials or resource identifiers.
     * Durations use the executing Effect runtime's monotonic clock, including a caller-provided Clock service for native clients.
     * Measurements use the existing logger synchronously and add no telemetry service, exporter, queue or persistence.
     * The configured logger and minimum level can still suppress or redirect them
     */
    readonly measurements?: boolean
}

/** Choose the default-API client's minimum log level and optional custom logger.
 * Settings are copied when this client is created and do not configure any other client or Effect runtime
 */
export interface DefaultLoggingOptions extends LoggingOptions {
    /** Lowest SDK log level to emit, including operational error reports.
     * Defaults to Info, while None explicitly suppresses output
     */
    readonly minimumLevel?: SdkLogLevel
    /**
     * Send this client's SDK records to a logger adapted with fromStructuredLogger or fromEffectLogger.
     * Omission uses Effect's readable default logger without extra setup.
     * A supplied integration replaces only this client's logger and does not inherit an unrelated application's Effect runtime.
     * The SDK invokes the sink synchronously and isolates thrown sink errors from SDK outcomes.
     * Returned promises or thenables are not awaited, and their rejections are discarded.
     * A blocking sink can still delay execution, and flushing or asynchronous delivery remains the application's responsibility
     */
    readonly logger?: DefaultLogger
}
