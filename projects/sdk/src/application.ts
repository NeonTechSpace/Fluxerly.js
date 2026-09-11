import type { OperationOptions } from "./client.js"
import type { ClientClosedError } from "./errors.js"
import type { ApiErrorDetail } from "./api-errors.js"
import type { MessageOperationOptions } from "./messages.js"

/**
 * Frozen allowlisted observation of the application authenticated by this bot token.
 * It deliberately omits owner identity, redirect URIs, verification keys, client secrets, and nested bot fields
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

/** Default cancellation affects this read only and never changes the application */
export interface DefaultBotApplicationOperationOptions extends BotApplicationOperationOptions, OperationOptions {}

/** Current-application operation identified by safe failure metadata */
export type BotApplicationOperation = "application.fetchCurrent"

/** Expected current-application failure without credentials, private fields, or upstream response bodies */
export class BotApplicationOperationError extends Error {
    /** Stable expected-failure discriminator */
    readonly _tag = "BotApplicationOperationError"

    constructor(
        /** Requested operation */
        readonly operation: BotApplicationOperation,
        /** HTTP failures retain status, never a provider response body */
        readonly reason: "input" | "busy" | "notFound" | "rejected" | "network" | "response" | "timeout" | "rateLimit",
        /** GET failures are never an uncertain mutation */
        readonly outcome: "notDispatched" | "rejected" | "unknown",
        /** HTTP status when received */
        readonly status: number | null = null,
        /** Provider retry delay in milliseconds when available */
        readonly retryAfterMs: number | null = null,
        /** Reviewed provider rejection detail, or null when no safe classification is available */
        readonly apiError: ApiErrorDetail | null = null,
    ) {
        super(`Bot application operation ${operation} failed (${reason}, outcome ${outcome})`)
        this.name = this._tag
    }
}

/** Native interruption remains in the Effect cause; default calls additionally return CancelledError */
export type BotApplicationOperationFailure = BotApplicationOperationError | ClientClosedError
