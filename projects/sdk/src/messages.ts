import type { OperationOptions } from "./client.js"
import type { Embed, EmbedInput } from "./embeds.js"
import type { Attachment, AttachmentInput, AttachmentReference } from "./attachments.js"

/** Identifies a message without retaining a client or requiring a fetched snapshot */
export interface MessageReference {
    /** Decimal string ID of the message. Never convert snowflakes to JavaScript numbers */
    readonly id: string
    /** Decimal string ID of the channel containing this message */
    readonly channelId: string
}

/** Frozen message projection shared by REST responses and messageCreate/messageUpdate events, not a complete wire object */
export interface Message extends MessageReference {
    /** Text exactly as returned by Fluxer, including empty text for non-text messages */
    readonly content: string
    /** Deeply frozen embeds in received order, empty when absent. Included in cache and collector byte budgets */
    readonly embeds: readonly Embed[]
    /** Frozen file metadata in received order, empty when absent. Budgets count metadata, never remote file bytes */
    readonly attachments: readonly Attachment[]
    /** Frozen author projection. No client-bound methods or cached live state */
    readonly author: {
        /** Decimal string user ID */
        readonly id: string
        /** Account username supplied by Fluxer */
        readonly username: string
        /** Whether Fluxer identifies the author as a bot. An omitted wire flag means false */
        readonly isBot: boolean
    }
}

/** Frozen deletion notice, not a full Message or a recoverable copy of the deleted resource */
export interface MessageDeletion extends MessageReference {
    /** Text supplied by Fluxer before deletion. Omitted means unavailable, null is preserved, and an empty string is known empty text */
    readonly content?: string | null
    /** Author ID only when supplied by Fluxer. Never inferred from a cache or fetched after deletion */
    readonly authorId?: string
}

/** One frozen channel deletion batch. Does not produce additional messageDelete notifications */
export interface MessageBulkDeletion {
    /** Decimal string ID of the channel containing the deleted messages */
    readonly channelId: string
    /** Frozen decimal message IDs in received order, not a chronological ordering or exactly-once guarantee */
    readonly ids: readonly string[]
}

/** Explicit notification permissions. Omitted fields disable their notification category */
export interface AllowedMentions {
    /** Up to 100 user IDs whose textual mentions may notify. Does not insert mentions */
    readonly users?: readonly string[]
    /** Up to 100 role IDs whose textual mentions may notify. Server permissions still apply */
    readonly roles?: readonly string[]
    /** Allow @everyone and @here notifications. Defaults to false */
    readonly everyone?: boolean
    /** Allow notification of the referenced message's author. Defaults to false */
    readonly repliedUser?: boolean
}

/** Text, embeds or file uploads. TypeScript does not establish that strings or arrays are nonempty */
export type MessageBody = Body<AttachmentInput>

type Body<A> =
    | {
          /** Text sent without trimming. Fluxer validates its applicable content limit */
          readonly content: string
          /** Rich embeds in display order. Fluxer owns the applicable embed-count limit */
          readonly embeds?: readonly EmbedInput[]
          /** New uploads for send/reply; an explicit replacement list for edits */
          readonly attachments?: readonly A[]
      }
    | {
          /** Omit for an embed-only send or to preserve text during an edit */
          readonly content?: string
          /** Rich embeds in display order, or an empty replacement array during an edit */
          readonly embeds: readonly EmbedInput[]
          /** New uploads for send/reply; an explicit replacement list for edits */
          readonly attachments?: readonly A[]
      }
    | {
          /** Omit to send only files or preserve text during an edit */
          readonly content?: string
          /** Omit to preserve embeds during an edit */
          readonly embeds?: readonly EmbedInput[]
          /** New uploads for send/reply; edits must list retained IDs alongside new files */
          readonly attachments: readonly A[]
      }

/** Send text, rich embeds and/or files. A send needs nonempty text, embeds or uploads.
 * Unknown input keys are rejected. Forwards and attachment:// embed linking are not supported
 */
export type MessageInput = MessageBody & {
    /** Notifications are disabled by default, including the replied-to author */
    readonly allowedMentions?: AllowedMentions
    /** Optional reply reference. Its channelId must match the send destination */
    readonly messageReference?: MessageReference
}

/** Reply helper input. The reference comes from reply's first argument */
export type ReplyInput = MessageBody & Pick<MessageInput, "allowedMentions">

/** Replace supplied text/embeds/attachments without fetching or merging old data. Omitted properties are not sent.
 * Omitted attachments preserve files; a supplied list replaces them, so list existing IDs to retain alongside new uploads.
 * Clearing attachments requires nonempty content or embeds alongside attachments: [].
 * Omitted embeds preserve rich embeds, though Fluxer may regenerate link previews when text changes.
 * Clearing embeds requires nonempty content alongside embeds: []; an empty edit alone is rejected by Fluxer.
 * Empty content requests clearing text, subject to Fluxer validation. Unknown input keys are rejected
 */
export type EditMessageInput = Body<AttachmentInput | AttachmentReference> & {
    /** Notifications default off for this edit, including the reply author. Explicit entries permit notifications */
    readonly allowedMentions?: AllowedMentions
}

/** One remote history page. Omit cursor fields for the latest messages. Combined cursor modes and unknown fields are rejected */
export type MessageHistoryQuery = {
    /** Maximum returned messages, an integer from 1 through Fluxer's per-request limit of 100. Defaults to 50, not a total-history limit */
    readonly limit?: number
} & (
    | {
          /** Decimal message ID, excluded from the result. Select the nearest older messages and return them newest first */
          readonly before?: string
          readonly after?: never
          readonly around?: never
      }
    | {
          readonly before?: never
          /** Decimal message ID, excluded from the result. Select the nearest newer messages but return them newest first */
          readonly after?: string
          readonly around?: never
      }
    | {
          readonly before?: never
          readonly after?: never
          /** Decimal message ID to center on, included only when present and visible. A full or balanced window is not guaranteed */
          readonly around?: string
      }
)

/** Per-call fetch, history, edit and delete deadline, separate from the client's gateway startup budget */
export interface MessageOperationOptions {
    /** Total admission, rate-limit wait and HTTP budget in milliseconds, from 1 to 2,147,483,647 as an integer. Defaults to 30,000, with cleanup awaited afterward */
    readonly timeoutMs?: number
}

/** Default cancellation affects this request only. After dispatch, cancelling an edit/delete cannot undo it */
export interface DefaultMessageOperationOptions extends MessageOperationOptions, OperationOptions {}

/** Send deadline shared by both entry points */
export interface SendOptions {
    /** Total admission, rate-limit wait and HTTP budget in milliseconds. Defaults to 30,000 */
    readonly timeoutMs?: number
}

/** Default cancellation affects this send only. After dispatch it cannot establish whether a message was created */
export interface DefaultSendOptions extends SendOptions, OperationOptions {}
