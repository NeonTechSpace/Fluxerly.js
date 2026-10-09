import type { OperationOptions } from "./client.js"
import type { InstanceOptions } from "./instance.js"
import type { ClientClosedError } from "./errors.js"
import type { LoggingOptions } from "./logging.js"
import {
    operationErrorFields,
    operationErrorSettings,
    operationErrorText,
    type ApiErrorDetail,
    type RequestCredential,
} from "./api-errors.js"
import { FluxerlyError, type OperationErrorOptions, type OperationOutcome, type OperationReason } from "./errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"
import type {
    AllowedMentions,
    ForwardMessageInput,
    MessageBody,
    MessageNonce,
    MessageOperationOptions,
    MessageReference,
} from "./messages.js"
import type { EmbedInput } from "./embeds.js"
import type { EmbedBuilder } from "./builders.js"

/**
 * Select a received webhook's shape by comparing its type with these constants.
 * A future Fluxer kind arrives as UnknownWebhook with type "unknown" and its number in rawType
 *
 * @category Invites and webhooks
 */
export const WebhookType: Readonly<{
    /** A webhook that accepts messages through its own secret token */
    Incoming: 1
    /** A webhook created when a text channel follows an announcement channel */
    ChannelFollower: 2
}> = Object.freeze({
    Incoming: 1,
    ChannelFollower: 2,
})

/**
 * Identity, appearance and destination shared by every received webhook kind, without credentials
 *
 * @category Invites and webhooks
 */
export interface WebhookBase {
    /** Webhook identifier, kept as a decimal string to avoid JavaScript number rounding */
    readonly id: string
    /** ID of the community that owns this webhook */
    readonly guildId: string
    /** ID of the channel that receives its messages, as last reported by Fluxer */
    readonly channelId: string
    /** A WebhookType constant, or "unknown" for a kind this SDK version does not know. Compare it to select the matching shape */
    readonly type: (typeof WebhookType)[keyof typeof WebhookType] | "unknown"
    /** Default sender name shown on webhook messages */
    readonly name: string
    /** Identifier for the webhook's avatar image, not a complete URL. Null means no custom avatar */
    readonly avatar: string | null
}

/**
 * A webhook that accepts token-authenticated operations, selected by type === WebhookType.Incoming.
 * Its metadata contains no token. Creation returns separate WebhookCredentials for createWebhookClient
 *
 * @category Invites and webhooks
 */
export interface IncomingWebhook extends WebhookBase {
    /** Always WebhookType.Incoming */
    readonly type: typeof WebhookType.Incoming
}

/**
 * A frozen snapshot of the community that owns a followed announcement channel.
 * Fluxer supplies it only while the source exists and the webhook's original creator can view it.
 * Missing source metadata does not prove the source was deleted
 *
 * @category Invites and webhooks
 */
export interface WebhookSourceGuild {
    /** Decimal ID of the source community */
    readonly id: string
    /** Source community name when Fluxer returned this snapshot */
    readonly name: string
    /** Community icon hash, not a complete URL. Null means no icon, and omission means unavailable */
    readonly icon?: string | null
}

/**
 * A frozen snapshot of a followed announcement channel.
 * Fluxer supplies it only while the source exists and the webhook's original creator can view it.
 * Missing source metadata does not prove the source was deleted
 *
 * @category Invites and webhooks
 */
export interface WebhookSourceChannel {
    /** Decimal ID of the followed announcement channel */
    readonly id: string
    /** Source channel name when Fluxer returned this snapshot */
    readonly name: string
}

/**
 * A webhook that delivers published messages from a followed announcement channel, selected by
 * type === WebhookType.ChannelFollower. Manage it with a bot client's webhooks.edit and webhooks.delete.
 * It can be renamed or moved to a text channel in the same community, but its avatar cannot be changed.
 * Deleting it unfollows the source. It has no exposed token and cannot be used with createWebhookClient
 *
 * @category Invites and webhooks
 */
export interface ChannelFollowerWebhook extends WebhookBase {
    /** Always WebhookType.ChannelFollower */
    readonly type: typeof WebhookType.ChannelFollower
    /** Source community while it exists and the original creator can view it. Absence does not prove deletion */
    readonly sourceGuild?: WebhookSourceGuild
    /** Followed channel while it exists and the original creator can view it. Absence does not prove deletion */
    readonly sourceChannel?: WebhookSourceChannel
}

/**
 * A webhook kind this SDK version does not know, selected by type === "unknown".
 * Its rawType preserves Fluxer's number and any supplied source snapshots remain readable.
 * No known WebhookType constant matches this shape, and no token credentials are inferred
 *
 * @category Invites and webhooks
 */
export interface UnknownWebhook extends WebhookBase, Omit<ChannelFollowerWebhook, "type"> {
    /** Always "unknown" */
    readonly type: "unknown"
    /** Numeric webhook kind Fluxer sent, outside the known WebhookType constants */
    readonly rawType: number
}

/**
 * A frozen snapshot of a webhook's kind, appearance and destination when Fluxer last returned it.
 * Compare type with WebhookType to select the incoming or channel follower shape, and handle "unknown"
 * for future kinds. Metadata contains no token and does not update after remote changes
 *
 * @category Invites and webhooks
 */
export type Webhook = IncomingWebhook | ChannelFollowerWebhook | UnknownWebhook

/**
 * The secret returned when an incoming webhook is created, kept separate from its public details.
 * Pass this object to createWebhookClient, or call revealToken to save the secret in the application's own secure storage.
 * The SDK does not save the token to disk. Anyone with the ID and token can use this webhook's token-authenticated operations
 *
 * @category Invites and webhooks
 */
export interface WebhookCredentials {
    /** ID of the webhook this secret belongs to */
    readonly id: string
    /** Return the token as plain text for secure storage or transfer. Never log the returned string */
    revealToken(): string
}

/**
 * Result of creating a webhook, including the secret needed to use it without a bot token
 *
 * @category Invites and webhooks
 */
export interface CreatedWebhook {
    /** Frozen incoming webhook details, without the required token held separately in credentials */
    readonly webhook: IncomingWebhook
    /** Secret-bearing object for createWebhookClient. Closing a client does not erase this separate object */
    readonly credentials: WebhookCredentials
}

/** Settings for a webhook that will post messages to the channel selected in the create call.
 * Fields are sampled once when create starts, then validated and encoded from that snapshot
 *
 * @category Invites and webhooks
 */
export interface WebhookCreate {
    /** Default sender name, 1–80 UTF-16 code units after U+000C and U+202E removal and surrounding-whitespace
     * trimming. The original string is sent unchanged
     */
    readonly name: string
    /** Base64 image data URI, or null for the default avatar. Fluxer validates image format and size */
    readonly avatar?: string | null
}

/**
 * Changes to an existing webhook made through a bot client's webhooks.edit operation.
 * Supply at least one setting. Omitted settings stay unchanged.
 * Moving the destination channel requires bot authentication and cannot be done by a token-only webhook client.
 * Follower webhooks can be renamed or moved, but Fluxer rejects an avatar change with field avatar and code INVALID_FORMAT.
 * A move emits Webhooks Update for the old and new channel. The SDK does not synthesize those events.
 * Fields are sampled once when edit starts, then validated and encoded from that snapshot
 *
 * @category Invites and webhooks
 */
export interface WebhookEdit {
    /** New default sender name, 1–80 UTF-16 code units after U+000C and U+202E removal and surrounding-whitespace
     * trimming. The original string is sent unchanged
     */
    readonly name?: string
    /** Base64 image data URI, or null to remove the avatar. Follower webhooks reject any supplied avatar change */
    readonly avatar?: string | null
    /** Move future messages within the same community, subject to Fluxer's permissions. Followers require a text channel, while incoming webhooks allow text, voice or announcement channels */
    readonly channelId?: string
}

/**
 * Attach a webhook message as a reply to an existing message in the webhook's destination channel
 *
 * @category Invites and webhooks
 */
export interface WebhookReplyReference {
    /** Select reply behavior rather than copying a message as a forward */
    readonly type: "reply"
    /** Message ID and channel ID to reply to. Fluxer checks that the message exists, is replyable and is in the destination channel */
    readonly target: MessageReference
}

/**
 * Ask Fluxer to copy an existing message into a forwarded webhook message in the same channel
 *
 * @category Invites and webhooks
 */
export interface WebhookForwardReference {
    /** Select forwarding rather than a reply with newly written content */
    readonly type: "forward"
    /** Source message and optional attachment/embed selections. Fluxer copies the message without a separate SDK fetch.
     * A source nonce is used only when the message has no top-level nonce. Supplying both fails locally, even if equal
     */
    readonly source: ForwardMessageInput
}

/**
 * Choose a reply with new content or a forward copied from an existing message when calling webhook.send
 *
 * @category Invites and webhooks
 */
export type WebhookMessageReference = WebhookReplyReference | WebhookForwardReference

/**
 * Delivery settings shared by new, reply and forward webhook messages
 *
 * @category Invites and webhooks
 */
export type WebhookMessageOptions = {
    /** Application-chosen correlation nonce, a string of 1–32 UTF-16 code units or a nonnegative safe integer encoded as a decimal string.
     * Omission sends no nonce, unless the forward source supplies one. Supplying both locations fails locally.
     * For five minutes after saving a message, Fluxer tries to suppress another send through this webhook with the same nonce. This does not guarantee exactly-once delivery
     */
    readonly nonce?: MessageNonce
    /** Message behavior flags from MessageFlags. Only SuppressEmbeds and SuppressNotifications are writable, and omission uses Fluxer's default. Crossposted, IsCrosspost and SourceMessageDeleted are server-managed. Those bits and VoiceMessage fail locally before dispatch */
    readonly flags?: number
    /** Which mentions may notify people. By default, mention text does not enable notifications */
    readonly allowedMentions?: AllowedMentions
    /** Override the sender name for this message only, using 1–80 UTF-16 code units after U+000C and U+202E removal
     * and surrounding-whitespace trimming. The original string is sent unchanged
     */
    readonly username?: string
    /** Override the avatar for this message only. Use an HTTP(S) URL without credentials, at most 8,192 characters, fetched by Fluxer */
    readonly avatarUrl?: string
    /** Decimal ID of a thread in the webhook's channel, sent as the thread_id query parameter so the message goes to
     * that thread instead of the channel. Fluxer rejects a thread that belongs to another channel, and a forum or media
     * channel needs either this or threadName. It cannot be combined with threadName
     */
    readonly threadId?: string
}

/**
 * Settings for starting a new post in a forum or media channel through a webhook.
 * The webhook must belong to that forum or media channel, and Fluxer rejects threadName for any other channel.
 * Set them only on a new message, not on a reply or forward
 *
 * @category Invites and webhooks
 */
export interface WebhookForumPostOptions {
    /** Name of the new post, 1–100 UTF-16 code units after U+000C and U+202E removal and surrounding-whitespace
     * trimming. The original string is sent unchanged. The message becomes the first message of the new post, and the
     * result is that message, whose channelId is the new post's ID. Fluxer needs this or threadId to place a message in
     * a forum or media channel, and it cannot be combined with threadId
     */
    readonly threadName?: string
    /** IDs of the tags to apply to the new post, at most 5. This needs threadName. Fluxer rejects an ID that the channel
     * does not have, a moderated tag because a webhook cannot manage threads, and a post with no tag when the channel
     * has ChannelFlags.RequireTag
     */
    readonly appliedTagIds?: readonly string[]
}

/**
 * A message to send through a webhook client, using the webhook's token rather than a bot token.
 * For a new message, supply text, embeds, uploads or stickers and omit messageReference.
 * For a reply, add a reply reference and write the content or attachments normally.
 * For a forward, supply only a forward reference and optional nonce, sender, flags or mention overrides.
 * Forwards cannot also contain new text, embeds, stickers or uploads.
 * Fluxer rejects missing or cross-channel reply/forward targets. New messages do not require the destination channel ID.
 * Fluxer never sends a webhook message as text-to-speech, so a tts property fails with reason input before dispatch, like any other unknown property
 *
 * To post into a thread, set threadId. To start a new post in a forum or media channel, set threadName and optionally
 * appliedTagIds on a new message. A webhook in a forum or media channel needs one of threadId and threadName, and the
 * SDK rejects a message that sets both. A reply or forward cannot start a post, because the new post holds no message
 * to refer to, so threadName with a messageReference fails before dispatch
 *
 * @category Invites and webhooks
 */
export type WebhookMessageInput =
    | (MessageBody &
          WebhookMessageOptions &
          WebhookForumPostOptions & {
              /** Reply to this existing message, or omit the reference to send an independent message */
              readonly messageReference?: WebhookReplyReference
          })
    | (WebhookMessageOptions & {
          /** Copy this source message as a forward instead of supplying new message content */
          readonly messageReference: WebhookForwardReference
      })

/**
 * Change an incoming webhook's default name or avatar through its token-only client.
 * Supply at least one setting. Omitted settings stay unchanged, and moving channels requires a bot client instead.
 * Fields are sampled once when edit starts, then validated and encoded from that snapshot
 *
 * @category Invites and webhooks
 */
export interface WebhookTokenEdit {
    /** New default sender name, 1–80 UTF-16 code units after U+000C and U+202E removal and surrounding-whitespace
     * trimming. The original string is sent unchanged
     */
    readonly name?: string
    /** Base64 image data URI, or null to remove the avatar */
    readonly avatar?: string | null
}

/**
 * Changes to a message previously sent by this webhook.
 * Supply content, embeds or flags. Omitted values stay unchanged, while empty text or an empty embed array clears that part.
 * This operation cannot upload or replace attachments
 *
 * @category Invites and webhooks
 */
export interface WebhookMessageEdit {
    /** Replace only MessageFlags.SuppressEmbeds and MessageFlags.SuppressNotifications. Omit to preserve them, or use zero to clear both. Crossposted, IsCrosspost and SourceMessageDeleted are server-managed. Those bits and VoiceMessage fail locally before dispatch */
    readonly flags?: number
    /** New message text, or an empty string to remove the existing text */
    readonly content?: string
    /** New rich-message cards as plain objects or EmbedBuilder instances, or an empty array to remove the existing embeds */
    readonly embeds?: readonly (EmbedInput | EmbedBuilder)[]
    /** Which mentions in the edited message may notify people. Notifications are disabled by default for this edit */
    readonly allowedMentions?: AllowedMentions
}

/**
 * Request settings for fetching, editing or deleting a message that a webhook client sent
 *
 * @category Options
 */
export interface WebhookMessageOperationOptions extends MessageOperationOptions {
    /** Decimal ID of the thread that holds the message, sent as the thread_id query parameter. Set it for a message in
     * a thread, because Fluxer looks in the webhook's channel otherwise and answers that the message is unknown.
     * Fluxer rejects a thread that belongs to another channel
     */
    readonly threadId?: string
}

/**
 * Request settings for fetching, editing or deleting a webhook message in the default API. An AbortSignal cancels this
 * request, not the webhook client
 *
 * @category Options
 */
export interface DefaultWebhookMessageOperationOptions extends WebhookMessageOperationOptions, OperationOptions {}

/**
 * Request settings for a bot client's webhook management, including an optional audit-log explanation
 *
 * @category Options
 */
export interface WebhookOperationOptions extends MessageOperationOptions {
    /** Explain a create, edit or delete in the community audit log. Use printable ASCII, 1–512 characters after trimming, sent without URL escaping */
    readonly auditReason?: string
}

/**
 * Request settings for webhook management in the default API. An AbortSignal cancels this request, not the bot client
 *
 * @category Options
 */
export interface DefaultWebhookOperationOptions extends WebhookOperationOptions, OperationOptions {}

/**
 * Credentials and limits for createWebhookClient.
 * Supply an incoming webhook's ID/token pair from secure storage or the credentials object returned by webhook creation.
 * Follower webhooks expose no token and cannot be executed by a webhook client.
 * Creating the client validates and copies these values locally. It does not send a request or prove the credentials work
 *
 * @category Invites and webhooks
 */
export type WebhookClientOptions = (
    | {
          /** Decimal ID of the webhook to use */
          readonly id: string
          /** Webhook secret, not a bot token. Keep it out of logs and public source code */
          readonly token: string
      }
    | WebhookCredentials
) & {
    /**
     * Choose the Fluxer instance that hosts this webhook, not its destination community. Omit this setting for hosted Fluxer.
     * Creating the client validates only the root URL. The first request or instance.resolve call discovers the instance's endpoints.
     * That discovery needs no credentials, and its result is kept for this client's lifetime.
     * HTTPS is required unless allowInsecure is explicitly set for an HTTP local or self-hosted server
     */
    readonly instance?: InstanceOptions
    /**
     * Limit the combined declared size of attachments waiting to upload or currently uploading, in bytes.
     * Defaults to 104,857,600 bytes (100 MiB). Supply a positive safe integer.
     * Each upload counts its byte-array length, file size or declared stream size until its connection and body are cleaned up.
     * This is separate from the 4 MiB queued JSON budget and is not a limit on the application's total memory use
     */
    readonly uploadMaxBytes?: number
    /**
     * Log records for this webhook client, with the same settings as the client option logging. Omit it for the default
     * console output of Info and above. A rejected webhook token logs one rest.rejected Warn record per route and
     * Fluxer code, even when the application handles the failure
     */
    readonly logging?: LoggingOptions
}

/**
 * Identifies the webhook action that failed, so an error can be associated with the request the application made
 *
 * @category Errors
 */
export type WebhookOperation =
    | "webhooks.create"
    | "webhooks.fetch"
    | "webhooks.fetchForChannel"
    | "webhooks.fetchForGuild"
    | "webhooks.edit"
    | "webhooks.delete"
    | "webhooks.fetchToken"
    | "webhooks.editToken"
    | "webhooks.deleteToken"
    | "webhooks.send"
    | "webhooks.fetchMessage"
    | "webhooks.editMessage"
    | "webhooks.deleteMessage"

/** Webhook operations that only a webhook client performs, authenticated by the webhook token instead of the bot token */
const webhookTokenOperations: ReadonlySet<WebhookOperation> = new Set<WebhookOperation>([
    "webhooks.fetchToken",
    "webhooks.editToken",
    "webhooks.deleteToken",
    "webhooks.send",
    "webhooks.fetchMessage",
    "webhooks.editMessage",
    "webhooks.deleteMessage",
])

const webhookCredential = (operation: WebhookOperation): RequestCredential =>
    webhookTokenOperations.has(operation) ? "webhook" : "bot"

/**
 * An expected failure while managing a webhook or one of its messages.
 * Use reason to distinguish invalid input, an unavailable service or a rejected request, and outcome before deciding whether to retry a write.
 * If the outcome is unknown, Fluxer may already have made the change. When possible, fetch the current state before trying again.
 * Error details exclude secret-bearing URLs, raw response bodies and the submitted values.
 * A missing-permission rejection lists the permissions that the operation needs in details.requiredPermissions when
 * the SDK knows them, as ApiErrorDetail describes
 *
 * @category Errors
 */
export class WebhookOperationError extends FluxerlyError {
    /** Identifies this error in a switch or another tagged-error check */
    readonly _tag = "WebhookOperationError"
    /** Webhook action the application attempted */
    readonly operation: WebhookOperation
    /** Failure category, described by {@link OperationReason}.
     * The reason notFound may indicate an invalid token, not just a missing webhook
     */
    readonly reason: OperationReason
    /** Whether the request may have reached Fluxer, described by {@link OperationOutcome} */
    readonly outcome: OperationOutcome
    /** HTTP response status when one was received, or null when it is unavailable */
    readonly status: number | null
    /** Delay requested by Fluxer before retrying, in milliseconds, or null when unavailable */
    readonly retryAfterMs: number | null
    /** Recognized explanation of Fluxer's rejection, without raw response data, or null when unavailable */
    readonly apiError: ApiErrorDetail | null
    /** Safe explanation of the locally invalid property, or null when no input problem could be identified */
    readonly inputValidation: InputValidationDetail | null
    /** Create the failure from its operation, reason and outcome, with optional status, retry wait, API detail, input detail and cause */
    constructor(options: OperationErrorOptions<WebhookOperation>) {
        const fields = operationErrorFields(options)
        super(
            operationErrorText("Webhook", fields),
            operationErrorSettings("webhook", fields, options.cause, webhookCredential(fields.operation)),
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

/**
 * Expected failures shared by webhook operations, including requests made after the client closes.
 * Default API methods additionally return CancelledError when their AbortSignal is aborted.
 * Effect cancellation interrupts the running Effect rather than adding a cancellation value to this union
 *
 * @category Errors
 */
export type WebhookOperationFailure = WebhookOperationError | ClientClosedError
