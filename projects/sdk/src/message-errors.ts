import type { ClientClosedError, ConfigurationError } from "./errors.js"

/** A subscription exceeded a pending queue budget and permanently stopped delivery. It does not recover missed events */
export class EventOverflowError extends Error {
    readonly _tag = "EventOverflowError"
    constructor(
        /** Budget exceeded by the incoming event */
        readonly limit: "messages" | "bytes",
        /** Configured budget in event payloads or source-JSON bytes, according to limit. A bulk deletion counts as one payload */
        readonly capacity: number,
    ) {
        super(`Message subscription exceeded its pending ${limit} budget`)
        this.name = this._tag
    }
}

/** Another next call owns this default pull subscription's pending read */
export class EventReadBusyError extends Error {
    readonly _tag = "EventReadBusyError"
    constructor() {
        super("A message read is already pending for this subscription")
        this.name = this._tag
    }
}

/** Expected send failure with safe metadata, never an upstream response body */
export class MessageError extends Error {
    readonly _tag = "MessageError"
    constructor(
        /** Local admission/validation, HTTP rejection, uncertain transport, response decoding, deadline or rate limit */
        readonly reason: "input" | "busy" | "rejected" | "network" | "response" | "timeout" | "rateLimit",
        /** notSent means local non-dispatch or an API rejection, not rollback proof. The unknown value means creation may have occurred */
        readonly delivery: "notSent" | "unknown",
        /** HTTP status when available. Null for local failures or missing responses */
        readonly status: number | null = null,
        /** Server-required wait in milliseconds when usable. Null otherwise */
        readonly retryAfterMs: number | null = null,
    ) {
        super(`Message send failed (${reason}; delivery ${delivery})`)
        this.name = this._tag
    }
}

/**
 * Expected get, fetch, history, edit or delete failure with safe metadata, never a response body, credential or message content.
 * Local get failures use input and notDispatched. A cache miss succeeds with undefined.
 * Fetch and fetchHistory do not mutate messages. For edit/delete, unknown means the server may have applied the change.
 * Default cancellation and client closure have separate error tags and can also follow a dispatched mutation
 */
export class MessageOperationError extends Error {
    /** Stable discriminator for expected message-management failures */
    readonly _tag = "MessageOperationError"
    constructor(
        /** The requested operation, independent of the gateway connection state */
        readonly operation: "get" | "fetch" | "fetchHistory" | "edit" | "delete",
        /** Local validation/admission, HTTP rejection, transport, response decoding, deadline or rate limit. notFound means HTTP 404 for the target or its containing resource, not proof of a prior deletion */
        readonly reason: "input" | "busy" | "notFound" | "rejected" | "network" | "response" | "timeout" | "rateLimit",
        /** notDispatched means no HTTP attempt. rejected means an API rejection, not proof of rollback. Server errors and missing/invalid success responses remain unknown */
        readonly outcome: "notDispatched" | "rejected" | "unknown",
        /** HTTP status when available to this failure, otherwise null */
        readonly status: number | null = null,
        /** Server-required wait in milliseconds when usable, otherwise null */
        readonly retryAfterMs: number | null = null,
    ) {
        super(`Message ${operation} failed (${reason}; outcome ${outcome})`)
        this.name = this._tag
    }
}

/** Local subscription validation or a permanently closed client */
export type RegistrationError = ConfigurationError | ClientClosedError
/** Expected lower-level event-read failures. Default cancellation is added at the entry boundary */
export type EventReadError = EventOverflowError | EventReadBusyError
/** Send failures use the same definitions in both entry points */
export type SendError = MessageError | ClientClosedError
/** Get, fetch, history, edit and delete failures shared by both entry points. Native interruption remains outside this union */
export type MessageOperationFailure = MessageOperationError | ClientClosedError
