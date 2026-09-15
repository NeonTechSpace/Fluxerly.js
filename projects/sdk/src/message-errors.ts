import type { ClientClosedError, ConfigurationError } from "./errors.js"
import { operationErrorMessage, type ApiErrorDetail } from "./api-errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"

/** An event subscription stopped because its unread queue exceeded its count or byte budget.
 * The subscription does not restart or recover the missed events
 */
export class EventOverflowError extends Error {
    /** Discriminator for identifying queue overflow in an expected failure result */
    readonly _tag = "EventOverflowError"
    constructor(
        /** Budget exceeded by the incoming event */
        readonly limit: "messages" | "bytes",
        /** Configured event-payload count when limit is messages, or source-JSON bytes when limit is bytes.
         * A bulk deletion or reaction batch counts as one payload
         */
        readonly capacity: number,
    ) {
        super(`Event subscription exceeded its pending ${limit} budget`)
        this.name = this._tag
    }
}

/** A second next call tried to read while the same default API pull subscription already had a pending read.
 * Await that read before requesting another event
 */
export class EventReadBusyError extends Error {
    /** Discriminator for identifying an overlapping pending read */
    readonly _tag = "EventReadBusyError"
    constructor() {
        super("An event read is already pending for this subscription")
        this.name = this._tag
    }
}

/** A filtered event wait ended without a match or could not use its synchronous filter.
 * A filter throw or non-boolean return is isolated without exposing the callback's thrown or returned value
 */
export class EventWaitError extends Error {
    /** Stable discriminator for a local timeout or synchronous filter failure */
    readonly _tag = "EventWaitError"
    constructor(
        /** timeout means no matching event was observed before the local deadline.
         * filter means the callback threw or failed to return a boolean synchronously, without retaining its thrown or returned value
         */
        readonly reason: "timeout" | "filter",
    ) {
        super(
            reason === "timeout"
                ? "No matching event was observed before the local deadline"
                : "Event wait filter threw or did not synchronously return a boolean. Inspect inside the callback before SDK isolation",
        )
        this.name = this._tag
    }
}

/** A send, reply or forward did not return a confirmed message.
 * Inspect delivery before retrying, since unknown means message creation may already have occurred.
 * Even notSent can follow preparatory file uploads and does not prove rollback.
 * Metadata contains no provider response body or message content
 */
export class MessageError extends Error {
    /** Discriminator for identifying expected message-creation failures */
    readonly _tag = "MessageError"
    /** Safe local validation facts when the SDK can identify a failed input rule, otherwise null */
    readonly inputValidation: InputValidationDetail | null
    constructor(
        /** input means invalid local input, and busy means local request or upload capacity is full.
         * rejected means HTTP rejection, network means transport failure, and response means an invalid success response.
         * timeout means the operation deadline expired, and rateLimit means provider rate-limit handling could not complete
         */
        readonly reason: "input" | "busy" | "rejected" | "network" | "response" | "timeout" | "rateLimit",
        /** notSent means no message creation attempt or an observed API rejection, not proof of rollback.
         * Preparatory file uploads may already have occurred.
         * unknown means the message may already have been created, so another send can duplicate it
         */
        readonly delivery: "notSent" | "unknown",
        /** HTTP status when received, or null for local failures and missing responses */
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
 * A message lookup, read or management call failed.
 * Read operation to identify the call and reason to distinguish invalid input, full local capacity and provider failures.
 * A local get cache miss is successful undefined, not this error.
 * Reads do not change messages, but a mutation with outcome unknown may already have taken effect.
 * Metadata contains no response body, credential or message content.
 * Cancellation in the default API and client closure have separate error tags and can also occur after mutation dispatch
 */
export class MessageOperationError extends Error {
    /** Stable discriminator for expected message-management failures */
    readonly _tag = "MessageOperationError"
    /** Safe local validation facts when the SDK can identify a failed input rule, otherwise null */
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
        /** input means invalid local input, and busy means local request or upload capacity is full.
         * notFound means HTTP 404 for the target or its containing resource, not proof that someone deleted it.
         * rejected means another HTTP rejection, network means transport failure, and response means an invalid response.
         * timeout means the deadline expired, and rateLimit means provider rate-limit handling could not complete
         */
        readonly reason: "input" | "busy" | "notFound" | "rejected" | "network" | "response" | "timeout" | "rateLimit",
        /** notDispatched means no message or reaction HTTP attempt, although preparatory file uploads may already have occurred.
         * rejected means an observed API rejection, not proof of rollback.
         * unknown means a dispatched mutation may have taken effect, including server errors or missing or invalid success responses.
         * Read calls do not mutate messages even when their request outcome is unknown
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

/** Expected subscription-registration failures from invalid options or permanent client closure */
export type RegistrationError = ConfigurationError | ClientClosedError
/** Expected subscription-read failures from queue overflow or a competing pending read.
 * Default API calls add CancelledError, while native interruption remains in the Effect cause
 */
export type EventReadError = EventOverflowError | EventReadBusyError
/** Expected filtered event-wait failures, including invalid options, client closure, queue overflow, deadline expiry or a failed filter.
 * Default API calls add CancelledError, while native interruption remains in the Effect cause
 */
export type EventWaitFailure = ConfigurationError | ClientClosedError | EventOverflowError | EventWaitError
/** Expected message-creation failures shared by both entry points, including permanent client closure.
 * Default API calls add CancelledError, while native interruption remains in the Effect cause
 */
export type SendError = MessageError | ClientClosedError
/** Message lookup, management and reaction failures shared by both entry points. Native interruption remains outside this union */
export type MessageOperationFailure = MessageOperationError | ClientClosedError
