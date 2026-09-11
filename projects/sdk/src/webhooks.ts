import type { OperationOptions } from "./client.js"
import type { InstanceOptions } from "./instance.js"
import type { ClientClosedError } from "./errors.js"
import type { ApiErrorDetail } from "./api-errors.js"
import type {
    AllowedMentions,
    ForwardMessageInput,
    MessageBody,
    MessageOperationOptions,
    MessageReference,
} from "./messages.js"
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

/** Explicit same-channel reply target for one webhook send */
export interface WebhookReplyReference {
    /** Distinguishes this reply from a forward without structural inference */
    readonly type: "reply"
    /** Existing message in this webhook's current channel. Fluxer validates identity and replyable message type */
    readonly target: MessageReference
}

/** Immutable same-channel source snapshot for one webhook forward */
export interface WebhookForwardReference {
    /** Distinguishes this forward from a reply without structural inference */
    readonly type: "forward"
    /** Existing forward source and optional source-media selectors. Fluxer captures a snapshot without fetching it through the SDK */
    readonly source: ForwardMessageInput
}

/** Tagged webhook reference passed to send. A reply carries message content; a forward copies only the source snapshot */
export type WebhookMessageReference = WebhookReplyReference | WebhookForwardReference

type WebhookMessageOptions = {
    /** Writable non-voice MessageFlags bits. Omit for Fluxer's default; voice flags and unknown bits are rejected */
    readonly flags?: number
    /** Explicit notification permissions, default none */
    readonly allowedMentions?: AllowedMentions
    /** Per-message display name, 1–80 nonblank Unicode code points */
    readonly username?: string
    /** Per-message HTTP(S) avatar URL fetched by Fluxer, not by the SDK */
    readonly avatarUrl?: string
}

/** Webhook delivery without requiring a known channel or bot token.
 * A reply can include default message content and uploads. A forward accepts no content, embeds, stickers or uploads, but can override
 * the webhook identity, flags or mention policy while Fluxer creates the source snapshot. Fluxer rejects a missing or cross-channel target
 */
export type WebhookMessageInput =
    | (MessageBody & WebhookMessageOptions & { readonly messageReference?: WebhookReplyReference })
    | (WebhookMessageOptions & { readonly messageReference: WebhookForwardReference })

/** Token-authenticated webhook settings. Channel moves remain bot-management only */
export interface WebhookTokenEdit {
    /** New nonblank name, 1–80 Unicode code points */
    readonly name?: string
    /** Image data URI, or null to remove the avatar */
    readonly avatar?: string | null
}

/** Supply content, embeds or flags. Fluxer's webhook edit route cannot replace or upload attachments */
export interface WebhookMessageEdit {
    /** Replace writable non-voice MessageFlags bits. Omit to preserve them; zero clears both supported bits */
    readonly flags?: number
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
    /**
     * Explicit hosted or self-hosted instance selection. Omit it for hosted Fluxer.
     * Creation validates the root only. Requests and `instance.resolve` read the unauthenticated well-known document lazily and retain one immutable result for this webhook client's lifetime.
     * HTTPS is required by default. `allowInsecure: true` is an explicit HTTP local/self-hosted opt-in
     */
    readonly instance?: InstanceOptions
    /** Maximum reserved attachment transfer bytes across queued and active operations, positive safe integer, default 104,857,600.
     * Reservations use byte-array length, file size or declared stream size and release after transport cleanup.
     * Separate from the 4 MiB queued JSON budget, not a measure of retained heap or a process-memory ceiling
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
    | "webhooks.fetchToken"
    | "webhooks.editToken"
    | "webhooks.deleteToken"
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
        /** Reviewed provider rejection detail, or null when no safe classification is available */
        readonly apiError: ApiErrorDetail | null = null,
    ) {
        super(`Webhook operation ${operation} failed (${reason}, outcome ${outcome})`)
        this.name = this._tag
    }
}

/** Native interruption stays in the Effect cause, while default operations also return CancelledError */
export type WebhookOperationFailure = WebhookOperationError | ClientClosedError
