import type { OperationOptions } from "./client.js"
import type { ClientClosedError } from "./errors.js"
import { operationErrorFields, operationErrorSettings, operationErrorText, type ApiErrorDetail } from "./api-errors.js"
import { FluxerlyError, type OperationErrorOptions, type OperationOutcome, type OperationReason } from "./errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"
import type { MessageOperationOptions } from "./messages.js"

/**
 * Application details returned by application.fetch for this client's bot token.
 * Use id to build an installation link. The bot flags show the current installation settings.
 * The SDK freezes this result but does not cache it. It contains no owner identity, redirect URIs, verification keys, client secrets or nested bot account
 *
 * @category Client and lifecycle
 */
export interface BotApplication {
    /** Decimal application ID, suitable for links.installation */
    readonly id: string
    /** Provider application name */
    readonly name: string
    /** Provider's application icon hash, null when the bot has no avatar */
    readonly icon: string | null
    /** Provider's application description, sourced from the bot bio and null when absent */
    readonly description: string | null
    /** Whether Fluxer currently permits non-owners to install this bot */
    readonly botPublic: boolean
    /** Whether Fluxer currently requires its OAuth2 code-grant flow for this bot */
    readonly botRequireCodeGrant: boolean
}

/**
 * Set the deadline for this application read without changing the gateway startup deadline
 *
 * @category Options
 */
export interface BotApplicationOperationOptions extends MessageOperationOptions {}

/**
 * Cancellation in the default API affects this read only and never changes the application
 *
 * @category Options
 */
export interface DefaultBotApplicationOperationOptions extends BotApplicationOperationOptions, OperationOptions {}

/**
 * Operation name included in application-read failures
 *
 * @category Errors
 */
export type BotApplicationOperation = "application.fetch"

/** The SDK could not read the current bot application.
 * Local input checks, the connection, the deadline or an unusable Fluxer response stopped the read.
 * Metadata includes no credentials, private application fields or upstream response bodies.
 * This read cannot modify the application, even when its request outcome is unknown
 *
 * @category Errors
 */
export class BotApplicationOperationError extends FluxerlyError {
    /** Stable expected-failure discriminator */
    readonly _tag = "BotApplicationOperationError"
    /** Requested operation */
    readonly operation: BotApplicationOperation
    /** Input validation, full local capacity, HTTP 404 or another rejection, network failure, invalid response, deadline expiry or rate limit */
    readonly reason: OperationReason
    /** Whether the request may have reached Fluxer, described by {@link OperationOutcome}.
     * This is a read, so an unknown outcome does not mean the application may have changed
     */
    readonly outcome: OperationOutcome
    /** HTTP status when received, otherwise null */
    readonly status: number | null
    /** Fluxer's retry delay in milliseconds when usable, otherwise null */
    readonly retryAfterMs: number | null
    /** Reviewed Fluxer rejection detail, or null when no safe classification is available */
    readonly apiError: ApiErrorDetail | null
    /** Safe explanation of the locally invalid property, or null when no input problem could be identified */
    readonly inputValidation: InputValidationDetail | null

    /** Create the failure from its operation, reason and outcome, with optional status, retry wait, API detail, input detail and cause */
    constructor(options: OperationErrorOptions<BotApplicationOperation>) {
        const fields = operationErrorFields(options)
        super(
            operationErrorText("Bot application", fields),
            operationErrorSettings("application", fields, options.cause),
        )
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

/** Expected application-read failures in both APIs.
 * The Effect API reports interruption in its Cause. The default API can also return CancelledError
 *
 * @category Errors
 */
export type BotApplicationOperationFailure = BotApplicationOperationError | ClientClosedError
