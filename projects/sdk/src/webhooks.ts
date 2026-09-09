import type { OperationOptions } from "./client.js"
import type { ClientClosedError } from "./errors.js"
import type { AllowedMentions, MessageBody, MessageOperationOptions } from "./messages.js"
import type { EmbedInput } from "./embeds.js"

/** Frozen remote webhook metadata, deliberately excluding the credential and creator's private fields */
export interface Webhook {
    /** Decimal webhook ID */
    readonly id: string
    /** Decimal owning guild ID */
    readonly guildId: string
    /** Decimal destination channel ID at the time of this observation */
    readonly channelId: string
    /** Display name returned by Fluxer */
    readonly name: string
    /** Avatar hash, or null when absent */
    readonly avatar: string | null
}

/** Redacted creation credential, separate from metadata and never persisted by the SDK */
export interface WebhookCredentials {
    /** Decimal webhook ID */
    readonly id: string
    /** Explicitly expose the secret for caller-owned secure storage. Never log the returned string */
    revealToken(): string
}

/** Creation returns metadata plus a credential handle usable by createWebhookClient */
export interface CreatedWebhook {
    /** Frozen remote snapshot */
    readonly webhook: Webhook
    /** Redacted handle, retained until the caller releases it independently of any client */
    readonly credentials: WebhookCredentials
}

/** Name and optional avatar for one incoming webhook */
export interface WebhookCreate {
    /** Nonblank name, 1–80 Unicode code points */
    readonly name: string
    /** Image data URI, or null for the default avatar. Fluxer validates image format and size */
    readonly avatar?: string | null
}

/** Omitted settings stay unchanged. Only bot-authenticated management can move the destination */
export interface WebhookEdit {
    /** New nonblank name, 1–80 Unicode code points */
    readonly name?: string
    /** Image data URI, or null to remove the avatar */
    readonly avatar?: string | null
    /** Decimal destination channel ID in the same guild, subject to server permissions */
    readonly channelId?: string
}

/** Webhook delivery reuses message body/mention inputs without requiring a known channel or bot token */
export type WebhookMessageInput = MessageBody & {
    /** Explicit notification permissions, default none */
    readonly allowedMentions?: AllowedMentions
    /** Per-message display name, 1–80 nonblank Unicode code points */
    readonly username?: string
    /** Per-message HTTP(S) avatar URL fetched by Fluxer, not by the SDK */
    readonly avatarUrl?: string
}

/** Supply content or embeds. Fluxer's webhook edit route cannot replace or upload attachments */
export interface WebhookMessageEdit {
    /** Replacement text, including empty text to clear */
    readonly content?: string
    /** Replacement embeds, including [] to clear */
    readonly embeds?: readonly EmbedInput[]
    /** Notifications default off for this edit */
    readonly allowedMentions?: AllowedMentions
}

/** Bot-authenticated webhook management settings */
export interface WebhookOperationOptions extends MessageOperationOptions {
    /** Optional trimmed printable-ASCII audit header for create/edit/delete only, 1–512 characters after trimming, sent without URL escaping */
    readonly auditReason?: string
}

/** Default management starts immediately and supports cancellation of this operation only */
export interface DefaultWebhookOperationOptions extends WebhookOperationOptions, OperationOptions {}

/** Stored raw credentials are validated and copied locally without authenticating or sending requests */
export type WebhookClientOptions = ({ readonly id: string; readonly token: string } | WebhookCredentials) & {
    /** Maximum retained SDK-owned file bytes, positive safe integer, default 104,857,600.
     * Separate from the 4 MiB queued JSON budget, not a process-memory ceiling
     */
    readonly uploadMaxBytes?: number
}

/** Webhook operation named by expected failures and default defects */
export type WebhookOperation =
    | "webhooks.create"
    | "webhooks.fetch"
    | "webhooks.fetchChannel"
    | "webhooks.fetchGuild"
    | "webhooks.edit"
    | "webhooks.delete"
    | "webhooks.send"
    | "webhooks.fetchMessage"
    | "webhooks.editMessage"
    | "webhooks.deleteMessage"

/** Safe failure metadata, never credential-bearing URLs, response bodies or caller inputs */
export class WebhookOperationError extends Error {
    /** Stable expected-failure discriminator */
    readonly _tag = "WebhookOperationError"
    constructor(
        /** Requested operation */
        readonly operation: WebhookOperation,
        /** notFound means HTTP 404, which can also mean an invalid webhook credential */
        readonly reason: "input" | "busy" | "notFound" | "rejected" | "network" | "response" | "timeout" | "rateLimit",
        /** unknown writes may have applied. Rejection is not a rollback guarantee */
        readonly outcome: "notDispatched" | "rejected" | "unknown",
        /** Received HTTP status, or null */
        readonly status: number | null = null,
        /** Server-required delay in milliseconds when available */
        readonly retryAfterMs: number | null = null,
    ) {
        super(`Webhook operation ${operation} failed (${reason}, outcome ${outcome})`)
        this.name = this._tag
    }
}

/** Native interruption stays in the Effect cause, while default operations also return CancelledError */
export type WebhookOperationFailure = WebhookOperationError | ClientClosedError
