import type { OperationOptions } from "./client.js"
import type { InstanceOptions } from "./instance.js"
import type { ClientClosedError } from "./errors.js"
import { operationErrorMessage, type ApiErrorDetail } from "./api-errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"
import type {
    AllowedMentions,
    ForwardMessageInput,
    MessageBody,
    MessageOperationOptions,
    MessageReference,
} from "./messages.js"
import type { EmbedInput } from "./embeds.js"

/**
 * A webhook's name, avatar and destination when Fluxer last returned it.
 * Webhooks let another application post messages to a channel without signing in as a bot.
 * This read-only snapshot contains no token and does not update when someone edits the webhook
 */
export interface Webhook {
    /** Webhook identifier, kept as a decimal string to avoid JavaScript number rounding */
    readonly id: string
    /** ID of the server that owns this webhook */
    readonly guildId: string
    /** ID of the channel that receives its messages, as last reported by Fluxer */
    readonly channelId: string
    /** Default sender name shown on webhook messages */
    readonly name: string
    /** Identifier for the webhook's avatar image, not a complete URL. Null means no custom avatar */
    readonly avatar: string | null
}

/**
 * The secret returned when you create a webhook, kept separate from its public details.
 * Pass this object to createWebhookClient, or call revealToken to save the secret in your own secure storage.
 * The SDK does not save it to disk. Anyone with the ID and token can use this webhook's token-authenticated operations
 */
export interface WebhookCredentials {
    /** ID of the webhook this secret belongs to */
    readonly id: string
    /** Return the token as plain text so you can store or transfer it securely. Never log the returned string */
    revealToken(): string
}

/** Result of creating a webhook, including the secret needed to use it without a bot token */
export interface CreatedWebhook {
    /** Read-only details of the newly created webhook, without its token */
    readonly webhook: Webhook
    /** Secret-bearing object for createWebhookClient. Closing a client does not erase this separate object */
    readonly credentials: WebhookCredentials
}

/** Settings for a webhook that will post messages to the channel selected in the create call */
export interface WebhookCreate {
    /** Default sender name, with 1–80 Unicode code points and at least one non-whitespace character */
    readonly name: string
    /** Base64 image data URI, or null for the default avatar. Fluxer validates image format and size */
    readonly avatar?: string | null
}

/**
 * Changes to an existing webhook made through a bot client's webhooks.edit operation.
 * Supply at least one setting. Omitted settings stay unchanged.
 * Moving the destination channel requires bot authentication and cannot be done by a token-only webhook client
 */
export interface WebhookEdit {
    /** New default sender name, with 1–80 Unicode code points and at least one non-whitespace character */
    readonly name?: string
    /** Base64 image data URI, or null to remove the avatar */
    readonly avatar?: string | null
    /** Move future messages to this channel in the same server, subject to Fluxer's permission checks */
    readonly channelId?: string
}

/** Attach a webhook message as a reply to an existing message in the webhook's destination channel */
export interface WebhookReplyReference {
    /** Select reply behavior rather than copying a message as a forward */
    readonly type: "reply"
    /** Message ID and channel ID to reply to. Fluxer checks that the message exists, is replyable and is in the destination channel */
    readonly target: MessageReference
}

/** Ask Fluxer to copy an existing message into a forwarded webhook message in the same channel */
export interface WebhookForwardReference {
    /** Select forwarding rather than a reply with newly written content */
    readonly type: "forward"
    /** Source message and optional attachment/embed selections. Fluxer copies the message without a separate SDK fetch */
    readonly source: ForwardMessageInput
}

/** Choose a reply with your own content or a forward copied from an existing message when calling webhook.send */
export type WebhookMessageReference = WebhookReplyReference | WebhookForwardReference

type WebhookMessageOptions = {
    /** Message behavior flags from MessageFlags. Only the supported non-voice flags are writable, and omission uses Fluxer's default */
    readonly flags?: number
    /** Which mentions may notify people. By default, mention text does not enable notifications */
    readonly allowedMentions?: AllowedMentions
    /** Override the sender name for this message only, using 1–80 Unicode code points with non-whitespace content */
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
 * Fluxer rejects missing or cross-channel reply/forward targets. New messages do not require you to know the destination channel ID
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
 * Supply at least one setting. Omitted settings stay unchanged, and moving channels requires a bot client instead
 */
export interface WebhookTokenEdit {
    /** New default sender name, with 1–80 Unicode code points and at least one non-whitespace character */
    readonly name?: string
    /** Base64 image data URI, or null to remove the avatar */
    readonly avatar?: string | null
}

/**
 * Changes to a message previously sent by this webhook.
 * Supply content, embeds or flags. Omitted values stay unchanged, while empty text or an empty embed array clears that part.
 * This operation cannot upload or replace attachments
 */
export interface WebhookMessageEdit {
    /** Replace the supported non-voice MessageFlags bits. Omit to preserve them, or use zero to clear both supported bits */
    readonly flags?: number
    /** New message text, or an empty string to remove the existing text */
    readonly content?: string
    /** New rich-message cards, or an empty array to remove the existing embeds */
    readonly embeds?: readonly EmbedInput[]
    /** Which mentions in the edited message may notify people. Notifications are disabled by default for this edit */
    readonly allowedMentions?: AllowedMentions
}

/** Request settings for a bot client's webhook management, including an optional audit-log explanation */
export interface WebhookOperationOptions extends MessageOperationOptions {
    /** Explain a create, edit or delete in the server audit log. Use printable ASCII, 1–512 characters after trimming, sent without URL escaping */
    readonly auditReason?: string
}

/** Request settings for webhook management in the default API. An AbortSignal cancels this request, not the bot client */
export interface DefaultWebhookOperationOptions extends WebhookOperationOptions, OperationOptions {}

/**
 * Credentials and limits for createWebhookClient.
 * Supply an ID/token pair from secure storage or the credentials object returned by webhook creation.
 * Creating the client validates and copies these values locally. It does not send a request or prove the credentials work
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
     * Choose the Fluxer instance that hosts this webhook, not its destination guild. Omit this setting for hosted Fluxer.
     * Creating the client validates only the root URL. The first request or instance.resolve call discovers the instance's endpoints.
     * That discovery needs no credentials, and its result is kept for this client's lifetime.
     * HTTPS is required unless you explicitly set allowInsecure for an HTTP local or self-hosted server
     */
    readonly instance?: InstanceOptions
    /**
     * Limit the combined declared size of attachments waiting to upload or currently uploading, in bytes.
     * Defaults to 104,857,600 bytes (100 MiB). Supply a positive safe integer.
     * Each upload counts its byte-array length, file size or declared stream size until its connection and body are cleaned up.
     * This is separate from the 4 MiB queued JSON budget and is not a limit on the application's total memory use
     */
    readonly uploadMaxBytes?: number
}

/** Identifies the webhook action that failed, so an error can be associated with the request your application made */
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

/**
 * An expected failure while managing a webhook or one of its messages.
 * Use reason to distinguish invalid input, an unavailable service or a rejected request, and outcome before deciding whether to retry a write.
 * An unknown outcome means Fluxer may already have applied the change. Fetch the current state when possible instead of blindly repeating it.
 * Error details exclude secret-bearing URLs, raw response bodies and the values you submitted
 */
export class WebhookOperationError extends Error {
    /** Identifies this error in a switch or another tagged-error check */
    readonly _tag = "WebhookOperationError"
    /** Explains a rejected local field without repeating its value, or null when no specific input detail is available */
    readonly inputValidation: InputValidationDetail | null
    constructor(
        /** Webhook action your application attempted */
        readonly operation: WebhookOperation,
        /** Failure category. notFound means HTTP 404 and may indicate an invalid token, not just a missing webhook */
        readonly reason: "input" | "busy" | "notFound" | "rejected" | "network" | "response" | "timeout" | "rateLimit",
        /** Whether the request was never sent, rejected by Fluxer, or may have taken effect. A rejection does not promise rollback */
        readonly outcome: "notDispatched" | "rejected" | "unknown",
        /** HTTP response status when one was received, or null when it is unavailable */
        readonly status: number | null = null,
        /** Delay requested by Fluxer before retrying, in milliseconds, or null when unavailable */
        readonly retryAfterMs: number | null = null,
        /** Recognized explanation of Fluxer's rejection, without raw response data, or null when unavailable */
        readonly apiError: ApiErrorDetail | null = null,
        inputValidation: InputValidationDetail | null = null,
    ) {
        super(
            operationErrorMessage(
                "Webhook",
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

/**
 * Expected failures shared by webhook operations, including requests made after the client closes.
 * Default API methods additionally return CancelledError when their AbortSignal is aborted.
 * Effect-native cancellation interrupts the running Effect rather than adding a cancellation value to this union
 */
export type WebhookOperationFailure = WebhookOperationError | ClientClosedError
