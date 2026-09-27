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
    MessageOperationOptions,
    MessageReference,
} from "./messages.js"
import type { EmbedInput } from "./embeds.js"
import type { EmbedBuilder } from "./builders.js"

/**
 * A webhook's name, avatar and destination when Fluxer last returned it.
 * Webhooks let another application post messages to a channel without signing in as a bot.
 * These read-only details contain no token and do not update when someone edits the webhook
 *
 * @category Invites and webhooks
 */
export interface Webhook {
    /** Webhook identifier, kept as a decimal string to avoid JavaScript number rounding */
    readonly id: string
    /** ID of the community that owns this webhook */
    readonly guildId: string
    /** ID of the channel that receives its messages, as last reported by Fluxer */
    readonly channelId: string
    /** Default sender name shown on webhook messages */
    readonly name: string
    /** Identifier for the webhook's avatar image, not a complete URL. Null means no custom avatar */
    readonly avatar: string | null
}

/**
 * The secret returned when a webhook is created, kept separate from its public details.
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
    /** Read-only details of the newly created webhook, without its token */
    readonly webhook: Webhook
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
 * Fields are sampled once when edit starts, then validated and encoded from that snapshot
 *
 * @category Invites and webhooks
 */
export interface WebhookEdit {
    /** New default sender name, 1–80 UTF-16 code units after U+000C and U+202E removal and surrounding-whitespace
     * trimming. The original string is sent unchanged
     */
    readonly name?: string
    /** Base64 image data URI, or null to remove the avatar */
    readonly avatar?: string | null
    /** Move future messages to this channel in the same community, subject to Fluxer's permission checks */
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
    /** Source message and optional attachment/embed selections. Fluxer copies the message without a separate SDK fetch */
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
    /** Message behavior flags from MessageFlags. Only the supported non-voice flags are writable, and omission uses Fluxer's default */
    readonly flags?: number
    /** Which mentions may notify people. By default, mention text does not enable notifications */
    readonly allowedMentions?: AllowedMentions
    /** Override the sender name for this message only, using 1–80 UTF-16 code units after U+000C and U+202E removal
     * and surrounding-whitespace trimming. The original string is sent unchanged
     */
    readonly username?: string
    /** Override the avatar for this message only. Use an HTTP(S) URL without credentials, at most 8,192 characters, fetched by Fluxer */
    readonly avatarUrl?: string
}

/**
 * A message to send through a webhook client, using the webhook's token rather than a bot token.
 * For a new message, supply text, embeds, uploads or stickers and omit messageReference.
 * For a reply, add a reply reference and write the content or attachments normally.
 * For a forward, supply only a forward reference and optional sender, flags or mention overrides.
 * Forwards cannot also contain new text, embeds, stickers or uploads.
 * Fluxer rejects missing or cross-channel reply/forward targets. New messages do not require the destination channel ID.
 * Fluxer never sends a webhook message as text-to-speech, so a tts property fails with reason input before dispatch, like any other unknown property
 *
 * @category Invites and webhooks
 */
export type WebhookMessageInput =
    | (MessageBody &
          WebhookMessageOptions & {
              /** Reply to this existing message, or omit the reference to send an independent message */
              readonly messageReference?: WebhookReplyReference
          })
    | (WebhookMessageOptions & {
          /** Copy this source message as a forward instead of supplying new message content */
          readonly messageReference: WebhookForwardReference
      })

/**
 * Change a webhook's default name or avatar through its token-only client.
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
    /** Replace the supported non-voice MessageFlags bits. Omit to preserve them, or use zero to clear both supported bits */
    readonly flags?: number
    /** New message text, or an empty string to remove the existing text */
    readonly content?: string
    /** New rich-message cards as plain objects or EmbedBuilder instances, or an empty array to remove the existing embeds */
    readonly embeds?: readonly (EmbedInput | EmbedBuilder)[]
    /** Which mentions in the edited message may notify people. Notifications are disabled by default for this edit */
    readonly allowedMentions?: AllowedMentions
}

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
 * Supply an ID/token pair from secure storage or the credentials object returned by webhook creation.
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
 * Error details exclude secret-bearing URLs, raw response bodies and the submitted values
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
