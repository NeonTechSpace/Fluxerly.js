import type { OperationOptions } from "./client.js"
import type { ClientClosedError } from "./errors.js"
import { operationErrorMessage, type ApiErrorDetail } from "./api-errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"
import type { MessageOperationOptions } from "./messages.js"

/**
 * Basic application details returned by application.fetchCurrent for this client's bot token.
 * Use id to build an installation link and the bot flags to inspect current installation settings.
 * This frozen result is not cached and includes no owner identity, redirect URIs, verification keys, client secrets or nested bot account
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

/** Per-call deadline for a current-application read, separate from gateway startup */
export interface BotApplicationOperationOptions extends MessageOperationOptions {}

/** Cancellation in the default API affects this read only and never changes the application */
export interface DefaultBotApplicationOperationOptions extends BotApplicationOperationOptions, OperationOptions {}

/** Current-application operation identified by safe failure metadata */
export type BotApplicationOperation = "application.fetchCurrent"

/** The SDK could not read the current bot application.
 * The read failed local checks, transport, its deadline or provider response handling.
 * Metadata includes no credentials, private application fields or upstream response bodies.
 * This read cannot modify the application, even when its request outcome is unknown
 */
export class BotApplicationOperationError extends Error {
    /** Stable expected-failure discriminator */
    readonly _tag = "BotApplicationOperationError"
    /** Safe local validation facts when the SDK can identify a failed input rule, otherwise null */
    readonly inputValidation: InputValidationDetail | null

    constructor(
        /** Requested operation */
        readonly operation: BotApplicationOperation,
        /** Input validation, full local capacity, HTTP 404 or another rejection, network failure, invalid response, deadline expiry or rate limit */
        readonly reason: "input" | "busy" | "notFound" | "rejected" | "network" | "response" | "timeout" | "rateLimit",
        /** notDispatched means no service request started, rejected means an observed rejection, and unknown means the request outcome is uncertain.
         * This is a read, so unknown does not mean the application may have changed
         */
        readonly outcome: "notDispatched" | "rejected" | "unknown",
        /** HTTP status when received, otherwise null */
        readonly status: number | null = null,
        /** Provider retry delay in milliseconds when usable, otherwise null */
        readonly retryAfterMs: number | null = null,
        /** Reviewed provider rejection detail, or null when no safe classification is available */
        readonly apiError: ApiErrorDetail | null = null,
        inputValidation: InputValidationDetail | null = null,
    ) {
        super(
            operationErrorMessage(
                "Bot application",
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

/** Expected current-application failures shared by both entry points.
 * Native interruption remains in the Effect cause, while default API calls additionally return CancelledError
 */
export type BotApplicationOperationFailure = BotApplicationOperationError | ClientClosedError
