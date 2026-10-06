import type { ClientClosedError, ConfigurationError } from "./errors.js"
import { operationErrorFields, operationErrorSettings, operationErrorText, type ApiErrorDetail } from "./api-errors.js"
import { FluxerlyError, type OperationErrorOptions, type OperationOutcome, type OperationReason } from "./errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"

/** An event subscription stopped because unread events exceeded its count or byte limit.
 * The subscription does not restart or replay missed events
 *
 * @category Errors
 */
export class EventOverflowError extends FluxerlyError {
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
        super(
            limit === "messages"
                ? `The event subscription stopped because more than ${capacity} ${capacity === 1 ? "event was" : "events were"} waiting (maxPendingMessages)`
                : `The event subscription stopped because waiting events exceeded ${capacity} bytes (maxPendingBytes)`,
            {
                code: "events.overflow",
                hint: 'Handle events faster, raise maxPendingMessages or maxPendingBytes, or give a subscription overflow "dropOldest" or "dropNewest" so it drops events instead of stopping',
                details: { limit, capacity },
            },
        )
        this.name = this._tag
    }
}

/** A second next call tried to read while the same default API pull subscription already had a pending read.
 * Await that read before requesting another event
 *
 * @category Errors
 */
export class EventReadBusyError extends FluxerlyError {
    /** Discriminator for identifying an overlapping pending read */
    readonly _tag = "EventReadBusyError"
    constructor() {
        super("An event read is already pending for this subscription", {
            code: "events.readBusy",
            hint: "Await the pending next call before calling next again",
        })
        this.name = this._tag
    }
}

/** A filtered event wait ended without a match or could not use its synchronous filter.
 * A filter throw keeps the thrown value as cause. A non-boolean return is not retained
 *
 * @category Errors
 */
export class EventWaitError extends FluxerlyError {
    /** Stable discriminator for a local timeout or synchronous filter failure */
    readonly _tag = "EventWaitError"
    constructor(
        /** The reason timeout means no matching event was observed before the local deadline.
         * The reason filter means the callback threw or failed to return a boolean synchronously, and a thrown value is the error's cause
         */
        readonly reason: "timeout" | "filter",
        /** Optional underlying failure, such as the value thrown by the filter */
        options?: { readonly cause?: unknown },
    ) {
        super(
            reason === "timeout"
                ? "No matching event arrived before the wait timed out"
                : options?.cause === undefined
                  ? "The event wait filter did not return true or false synchronously"
                  : "The event wait filter threw. The thrown value is this error's cause",
            {
                code: `events.wait.${reason}`,
                hint:
                    reason === "timeout"
                        ? "Raise timeoutMs or check that the awaited event is delivered to this bot"
                        : "Make the filter return true or false synchronously without throwing",
                cause: options?.cause,
                details: { reason },
            },
        )
        this.name = this._tag
    }
}

/** A send, reply or forward ended without confirming that Fluxer created the message.
 * Inspect outcome before retrying, since unknown means message creation may already have occurred.
 * Even notDispatched or rejected can follow preparatory file uploads and does not prove rollback.
 * Metadata contains no Fluxer response body or message content.
 * A missing-permission rejection lists the permissions that sending needs in details.requiredPermissions, as
 * ApiErrorDetail describes
 *
 * @category Errors
 */
export class MessageError extends FluxerlyError {
    /** Discriminator for identifying expected message-creation failures */
    readonly _tag = "MessageError"
    /** Failure category, described by {@link OperationReason}.
     * Busy also covers full local upload capacity, and a send never reports notFound
     */
    readonly reason: Exclude<OperationReason, "notFound">
    /** Whether the message may have been created, using the same vocabulary as other operation errors.
     * The outcome notDispatched means no message creation request was sent, and rejected means Fluxer answered with a
     * rejection. Neither is proof of rollback, and preparatory file uploads may already have occurred.
     * The outcome unknown means the message may already have been created, so another send can duplicate it
     */
    readonly outcome: OperationOutcome
    /** HTTP status when received, or null for local failures and missing responses */
    readonly status: number | null
    /** Server-required wait in milliseconds when usable, otherwise null */
    readonly retryAfterMs: number | null
    /** Reviewed Fluxer rejection detail, or null when no safe classification is available */
    readonly apiError: ApiErrorDetail | null
    /** Safe local validation facts when the SDK can identify a failed input rule, otherwise null */
    readonly inputValidation: InputValidationDetail | null
    /** Create a send failure from its reason and outcome, with optional status, retry wait, API detail, input detail and cause */
    constructor(options: {
        readonly reason: Exclude<OperationReason, "notFound">
        readonly outcome: OperationOutcome
        readonly status?: number | null | undefined
        readonly retryAfterMs?: number | null | undefined
        readonly apiError?: ApiErrorDetail | null | undefined
        readonly inputValidation?: InputValidationDetail | null | undefined
        /** Unrecognized Fluxer error code, as in OperationErrorOptions */
        readonly providerCode?: string | null | undefined
        /** Failed response field or check, as in OperationErrorOptions */
        readonly responseField?: string | null | undefined
        readonly cause?: unknown
    }) {
        const fields = operationErrorFields({ ...options, operation: "send" })
        super(operationErrorText("Message", fields), operationErrorSettings("message.send", fields, options.cause))
        this.reason = fields.reason
        this.outcome = options.outcome
        this.status = fields.status
        this.retryAfterMs = fields.retryAfterMs
        this.apiError = fields.apiError
        this.inputValidation = freezeInputValidationDetail(fields.inputValidation)
        this.name = this._tag
    }
}

/**
 * A message lookup, read or change failed.
 * Read operation to identify the call and reason to distinguish invalid input, full local capacity and Fluxer failures.
 * A local get cache miss is successful undefined, not this error.
 * Reads do not change messages, but a mutation with outcome unknown may already have taken effect.
 * Error details contain no response body, credential or message content.
 * A missing-permission rejection lists the permissions that the operation needs in details.requiredPermissions when
 * the SDK knows them, as ApiErrorDetail describes.
 * Cancellation in the default API and client closure have separate error tags and can also occur after mutation dispatch
 *
 * @category Errors
 */
export class MessageOperationError extends FluxerlyError {
    /** Stable discriminator for expected message-management failures */
    readonly _tag = "MessageOperationError"
    /** The requested operation, independent of the gateway connection state */
    readonly operation:
        | "messages.get"
        | "typing"
        | "fetch"
        | "publish"
        | "fetchCrosspostSource"
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
        | "deleteOwnMessages"
        | "addReaction"
        | "removeReaction"
        | "removeUserReaction"
        | "clearReaction"
        | "clearReactions"
    /** Failure category, described by {@link OperationReason}.
     * Busy also covers full local upload capacity, and notFound applies to the target or its containing resource
     */
    readonly reason: OperationReason
    /** Whether the request may have reached Fluxer, described by {@link OperationOutcome}.
     * Preparatory file uploads may already have occurred even when no message or reaction request was dispatched.
     * An unknown outcome includes server errors and missing or invalid success responses.
     * Read calls do not mutate messages even when their request outcome is unknown
     */
    readonly outcome: OperationOutcome
    /** HTTP status when available to this failure, otherwise null */
    readonly status: number | null
    /** Server-required wait in milliseconds when usable, otherwise null */
    readonly retryAfterMs: number | null
    /** Reviewed Fluxer rejection detail, or null when no safe classification is available */
    readonly apiError: ApiErrorDetail | null
    /** Safe explanation of the locally invalid property, or null when no input problem could be identified */
    readonly inputValidation: InputValidationDetail | null
    /** Create the failure from its operation, reason and outcome, with optional status, retry wait, API detail, input detail and cause */
    constructor(options: OperationErrorOptions<MessageOperationError["operation"]>) {
        const fields = operationErrorFields(options)
        super(operationErrorText("Message", fields), operationErrorSettings("message", fields, options.cause))
        this.operation = fields.operation
        this.reason = fields.reason
        this.outcome = fields.outcome
        this.status = fields.status
        this.retryAfterMs = fields.retryAfterMs
        this.apiError = fields.apiError
        this.inputValidation = freezeInputValidationDetail(fields.inputValidation)
        this.name = this._tag
    }
}

/**
 * Expected subscription-registration failures from invalid options or permanent client closure
 *
 * @category Errors
 */
export type RegistrationError = ConfigurationError | ClientClosedError
/** Expected subscription-read failures from queue overflow or a competing pending read.
 * Default API calls add CancelledError, while native interruption remains in the Effect cause
 *
 * @category Errors
 */
export type EventReadError = EventOverflowError | EventReadBusyError
/** Expected filtered event-wait failures, including invalid options, client closure, queue overflow, deadline expiry or a failed filter.
 * Default API calls add CancelledError, while native interruption remains in the Effect cause
 *
 * @category Errors
 */
export type EventWaitFailure = ConfigurationError | ClientClosedError | EventOverflowError | EventWaitError
/** Expected message-creation failures shared by both entry points, including permanent client closure.
 * Default API calls add CancelledError, while native interruption remains in the Effect cause
 *
 * @category Errors
 */
export type SendError = MessageError | ClientClosedError
/**
 * Message lookup, management and reaction failures shared by both entry points. Native interruption remains outside this union
 *
 * @category Errors
 */
export type MessageOperationFailure = MessageOperationError | ClientClosedError
