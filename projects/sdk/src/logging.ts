declare const loggerBrand: unique symbol

/** Opaque default logger integration, created by fromEffectLogger from the SDK's /effect entry point */
export interface DefaultLogger {
    readonly [loggerBrand]: true
}

/** SDK development output control, separate from operational handler and cache error reporting */
export interface LoggingOptions {
    /**
     * Enable Info-level connection attempts, readiness, loss, retry waits, session resets and termination/shutdown diagnostics.
     * Default false, independent of consumer Effect Debug settings. Minimum-level filtering still applies.
     * Records use SDK-owned event/phase names, attempt counts, delayMs, identify/resume modes and safe failure classifications.
     * These are best-effort diagnostics, not a lossless event stream or an acknowledgement of log persistence
     */
    readonly development?: boolean
}

/** Default runtime logging settings, copied at creation without configuring any other client */
export interface DefaultLoggingOptions extends LoggingOptions {
    /** Minimum SDK log level, including operational errors. Default Info. None explicitly suppresses output */
    readonly minimumLevel?: "All" | "Trace" | "Debug" | "Info" | "Warn" | "Error" | "Fatal" | "None"
    /**
     * Optional fromEffectLogger integration. Omission uses Effect's readable default logger, without extra setup.
     * Explicitly replaces this client's default logger, without inheriting an unrelated consumer Effect runtime.
     * Delivery is synchronous. Throwing sinks do not change SDK outcomes, but blocking sinks can delay execution.
     * Sink flushing, asynchronous delivery and caller-owned context remain outside SDK ownership
     */
    readonly logger?: DefaultLogger
}
