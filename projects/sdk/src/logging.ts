declare const loggerBrand: unique symbol

/** An Effect logger adapted for a default-API client's logging.logger setting.
 * Create it with fromEffectLogger from @neontechspace/fluxerly/effect rather than constructing it yourself
 */
export interface DefaultLogger {
    /** Type-only marker that prevents constructing an integration without the SDK adapter */
    readonly [loggerBrand]: true
}

/** Opt into connection diagnostics without enabling or disabling operational error reports.
 * Native clients use the executing Effect context's logger and minimum level, not default-API logger settings
 */
export interface LoggingOptions {
    /**
     * Log connection attempts, readiness, loss, retry waits, session resets and shutdown at Info level.
     * Defaults to false, even when your Effect runtime enables Debug output.
     * The configured minimum log level can still suppress these records.
     * Records contain SDK event and phase names, attempt counts, millisecond delays and safe failure categories, not credentials or private payloads.
     * Multi-shard records identify this client's local shard, not other processes or whole-bot state.
     * Output is best-effort, not a lossless history or confirmation that a sink stored the record
     */
    readonly development?: boolean
}

/** Choose the default-API client's minimum log level and optional custom Effect logger.
 * Settings are copied when this client is created and do not configure any other client or Effect runtime
 */
export interface DefaultLoggingOptions extends LoggingOptions {
    /** Lowest SDK log level to emit, including operational error reports.
     * Defaults to Info, while None explicitly suppresses output
     */
    readonly minimumLevel?: "All" | "Trace" | "Debug" | "Info" | "Warn" | "Error" | "Fatal" | "None"
    /**
     * Send this client's SDK records to an Effect logger adapted with fromEffectLogger.
     * Omission uses Effect's readable default logger without extra setup.
     * A supplied integration replaces only this client's logger and does not inherit an unrelated application's Effect runtime.
     * The SDK invokes the sink synchronously and isolates thrown sink errors from SDK outcomes.
     * A blocking sink can still delay execution, and flushing or asynchronous delivery remains your responsibility
     */
    readonly logger?: DefaultLogger
}
