import type { ClientClosedError, ConfigurationError } from "./errors.js"
import { operationErrorMessage, type ApiErrorDetail } from "./api-errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"

/** A subscription exceeded a pending queue budget and permanently stopped delivery. It does not recover missed events */
export class EventOverflowError extends Error {
    readonly _tag = "EventOverflowError"
    constructor(
        /** Budget exceeded by the incoming event */
        readonly limit: "messages" | "bytes",
        /** Configured budget in event payloads or source-JSON bytes, according to limit. A bulk deletion or reaction batch counts as one payload */
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
    /** SDK-owned local input detail, or null for non-input and unattributable failures */
    readonly inputValidation: InputValidationDetail | null
    constructor(
        /** Local admission/validation, HTTP rejection, uncertain transport, response decoding, deadline or rate limit */
        readonly reason: "input" | "busy" | "rejected" | "network" | "response" | "timeout" | "rateLimit",
        /** notSent means no message creation attempt or an API rejection, not rollback proof. File uploads may already have occurred.
         * The unknown value means message creation may have occurred
         */
        readonly delivery: "notSent" | "unknown",
        /** HTTP status when available. Null for local failures or missing responses */
        readonly status: number | null = null,
        /** Server-required wait in milliseconds when usable. Null otherwise */
        readonly retryAfterMs: number | null = null,
        /** Reviewed provider rejection detail, or null when no safe classification is available */
        readonly apiError: ApiErrorDetail | null = null,
        inputValidation: InputValidationDetail | null = null,
    ) {
        super(
            operationErrorMessage(
                "Message",
                "send",
                reason,
                delivery,
                status,
                apiError,
                inputValidation?.explanation ?? null,
                retryAfterMs,
            ),
        )
        this.name = this._tag
        this.inputValidation = freezeInputValidationDetail(inputValidation)
    }
}

/**
 * Expected message read or mutation failure with safe metadata, never a response body, credential or message content.
 * Local get failures use input and notDispatched. A cache miss succeeds with undefined.
 * Remote reads do not mutate messages. For mutations, unknown means the server may have applied the change.
 * Default cancellation and client closure have separate error tags and can also follow a dispatched mutation
 */
export class MessageOperationError extends Error {
    /** Stable discriminator for expected message-management failures */
    readonly _tag = "MessageOperationError"
    /** SDK-owned local input detail, or null for non-input and unattributable failures */
    readonly inputValidation: InputValidationDetail | null
    constructor(
        /** The requested operation, independent of the gateway connection state */
        readonly operation:
            | "get"
            | "typing"
            | "fetch"
            | "fetchHistory"
            | "search"
            | "fetchReactionUsers"
            | "pin"
            | "unpin"
            | "fetchPins"
            | "edit"
            | "delete"
            | "deleteAttachment"
            | "deleteMany"
            | "deleteMine"
            | "addReaction"
            | "removeReaction"
            | "removeUserReaction"
            | "clearReaction"
            | "clearReactions",
        /** Local validation/admission, HTTP rejection, transport, response decoding, deadline or rate limit. notFound means HTTP 404 for the target or its containing resource, not proof of a prior deletion */
        readonly reason: "input" | "busy" | "notFound" | "rejected" | "network" | "response" | "timeout" | "rateLimit",
        /** notDispatched means no message or reaction HTTP attempt; preparatory file uploads may already have occurred.
         * rejected means an API rejection, not proof of rollback. Message server errors and missing/invalid success responses remain unknown
         */
        readonly outcome: "notDispatched" | "rejected" | "unknown",
        /** HTTP status when available to this failure, otherwise null */
        readonly status: number | null = null,
        /** Server-required wait in milliseconds when usable, otherwise null */
        readonly retryAfterMs: number | null = null,
        /** Reviewed provider rejection detail, or null when no safe classification is available */
        readonly apiError: ApiErrorDetail | null = null,
        inputValidation: InputValidationDetail | null = null,
    ) {
        super(
            operationErrorMessage(
                "Message",
                operation,
                reason,
                outcome,
                status,
                apiError,
                inputValidation?.explanation ?? null,
                retryAfterMs,
            ),
        )
        this.name = this._tag
        this.inputValidation = freezeInputValidationDetail(inputValidation)
    }
}

/** Local subscription validation or a permanently closed client */
export type RegistrationError = ConfigurationError | ClientClosedError
/** Expected lower-level event-read failures. Default cancellation is added at the entry boundary */
export type EventReadError = EventOverflowError | EventReadBusyError
/** Send failures use the same definitions in both entry points */
export type SendError = MessageError | ClientClosedError
/** Message lookup, management and reaction failures shared by both entry points. Native interruption remains outside this union */
export type MessageOperationFailure = MessageOperationError | ClientClosedError
