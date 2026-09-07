/** Locally invalid client configuration, without the rejected input value */
export class ConfigurationError extends Error {
    readonly _tag = "ConfigurationError"

    constructor(
        readonly field: "configuration" | "token" | "connection" | "startupTimeoutMs" | "maxStartupAttempts",
        message: string,
    ) {
        super(message)
        this.name = "ConfigurationError"
    }
}

export type Operation = "createClient" | "connect" | "run" | "waitForClose" | "shutdown"

/** Fluxer rejected the credential, so the connection owner does not retry it unchanged */
export class AuthenticationError extends Error {
    readonly _tag = "AuthenticationError"
    constructor() {
        super("Fluxer rejected the bot credential")
        this.name = this._tag
    }
}

/** Connection failure with safe phase and status metadata, without an upstream body or close-reason string */
export class ConnectionError extends Error {
    readonly _tag = "ConnectionError"
    constructor(
        /** The transport stage that failed */
        readonly phase: "discovery" | "gateway",
        /** Network failure, invalid protocol data, or a closed gateway connection */
        readonly reason: "network" | "protocol" | "closed",
        /** HTTP status during discovery or WebSocket close code at the gateway, or null when unavailable */
        readonly status: number | null = null,
    ) {
        super(`Fluxer ${phase} connection failed (${reason})`)
        this.name = this._tag
    }
}

/** Readiness did not complete within the connection budget, with owned-resource cleanup still awaited */
export class ConnectionTimeoutError extends Error {
    readonly _tag = "ConnectionTimeoutError"
    constructor(
        /** Connection budget in milliseconds, not a guarantee of completion before cleanup finishes */
        readonly timeoutMs: number,
    ) {
        super("Fluxer connection did not become ready within its time budget")
        this.name = this._tag
    }
}

/** A connection rate limit, distinct from authentication rejection or an SDK defect */
export class RateLimitError extends Error {
    readonly _tag = "RateLimitError"
    constructor(
        /** Whether discovery HTTP or the gateway imposed the limit */
        readonly source: "http" | "gateway",
        /** Server-required wait in milliseconds, or null when no usable duration was supplied */
        readonly retryAfterMs: number | null,
    ) {
        super("Fluxer rate limited the connection")
        this.name = this._tag
    }
}

/** The operation was not admitted because existing connection work already owns the client */
export class ClientBusyError extends Error {
    readonly _tag = "ClientBusyError"
    constructor() {
        super("The client already has an active connection or connection operation")
        this.name = this._tag
    }
}

/** The client is permanently closing or closed, so reconnecting requires a new client */
export class ClientClosedError extends Error {
    readonly _tag = "ClientClosedError"
    constructor() {
        super("The client is permanently closing or closed")
        this.name = this._tag
    }
}

/** Default operation cancellation, returned only after cleanup required by that operation finishes */
export class CancelledError extends Error {
    readonly _tag = "CancelledError"
    constructor() {
        super("The operation was cancelled")
        this.name = this._tag
    }
}

/** Expected startup or terminal connection failures, excluding cancellation and SDK defects */
export type ConnectionFailure = AuthenticationError | ConnectionError | ConnectionTimeoutError | RateLimitError
/** Expected connect and run failures, with default methods adding CancelledError to their result union */
export type ConnectError = ConnectionFailure | ClientBusyError | ClientClosedError

/** Safe cause categories retain combined failure information without raw upstream defects */
export type DefectReason =
    | { readonly kind: "Failure"; readonly failure: ConnectError | ConfigurationError }
    | { readonly kind: "Defect" }
    | { readonly kind: "Interruption" }

/**
 * Unexpected default SDK failure, kept outside typed Result and ResultAsync errors.
 * Creation throws synchronously, while asynchronous operations reject.
 * Reasons retain safe failure categories without copying raw upstream defects or private payloads.
 * Native consumers receive Effect causes instead of this default-boundary exception
 */
export class SdkDefect extends Error {
    constructor(
        readonly operation: Operation = "createClient",
        readonly reasons: readonly DefectReason[] = [],
    ) {
        super(`Unexpected SDK failure during ${operation}`)
        this.name = "SdkDefect"
    }
}
