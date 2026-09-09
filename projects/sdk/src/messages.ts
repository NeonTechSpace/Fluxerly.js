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

/** Frozen message projection shared by REST responses and messageCreate/messageUpdate events, not a complete wire object.
 * Each observation is independent: omitted optional fields are unknown, and explicit nulls retain Fluxer's response state.
 * The SDK neither hydrates absent references/users nor updates a snapshot's reaction totals after delivery
 * @example
 * ```ts
 * import type { Message } from "@neontechspace/fluxerly"
 * export function messageMetadataExample(message: Message) {
 *     const forwardedFrom = message.messageReference?.type === 1 ? message.messageReference.channelId : undefined
 *     const totals = message.reactions?.map(({ emoji, count }) => `${emoji.name}: ${count}`) ?? []
 *     return { createdAt: message.createdAt, forwardedFrom, totals }
 * }
 * ```
 */
export interface Message extends MessageReference {
    /** Webhook ID when supplied by Fluxer. Missing/null wire values omit this field, without inferring identity from the author */
    readonly webhookId?: string
    /** Pin status supplied by Fluxer. Omitted means unknown, not false. Snapshots do not update in place */
    readonly pinned?: boolean
    /** ISO 8601 creation time when Fluxer supplied it. Omitted means this partial observation did not include a creation time */
    readonly createdAt?: string
    /** ISO 8601 time of the latest observed edit. Null means Fluxer explicitly reported no edit; omission means unknown */
    readonly editedAt?: string | null
    /** Provider message type as an integer. Unknown future values are retained; omission means this partial observation did not include it */
    readonly type?: number
    /** Provider message flags as an integer. Unknown future bits are retained; omission does not mean no flags */
    readonly flags?: number
    /** Guild containing this message when Fluxer supplied one. Private or partial observations omit it; no guild lookup occurs */
    readonly guildId?: string
    /** Whether Fluxer reports an @everyone or @here mention. Omitted means unknown, not false */
    readonly mentionedEveryone?: boolean
    /** Text exactly as returned by Fluxer, including empty text for non-text messages */
    readonly content: string
    /** Deeply frozen embeds in received order, empty when absent. Included in cache and collector byte budgets */
    readonly embeds: readonly Embed[]
    /** Frozen file metadata in received order, empty when absent. Budgets count metadata, never remote file bytes */
    readonly attachments: readonly Attachment[]
    /** Frozen sticker metadata in received order, empty when absent. No image bytes are fetched or retained */
    readonly stickers: readonly MessageSticker[]
    /** Mentioned account projections in received order. Omitted means unknown; an empty frozen array means Fluxer reported no user mentions */
    readonly mentions?: readonly MessageMention[]
    /** Mentioned role IDs in received order. Omitted means unknown; an empty frozen array means Fluxer reported none */
    readonly mentionRoleIds?: readonly string[]
    /** Mentioned visible channel projections in received order. Omitted means Fluxer did not supply channel mentions */
    readonly mentionChannels?: readonly MessageChannelMention[] | null
    /** Reaction totals observed with this message. They are not a reactor list and may be stale immediately after this snapshot */
    readonly reactions?: readonly MessageReactionSummary[] | null
    /** Reply or forward target data when supplied. This is only a reference; it never fetches, retains, or expands snapshots */
    readonly messageReference?: MessageContextReference | null
    /** Shallow resolved reply target. Null means Fluxer reported the reply target missing; omission means it supplied no reply resolution state */
    readonly referencedMessage?: MessageReference | null
    /** Frozen author projection. No client-bound methods or cached live state */
    readonly author: {
        /** Decimal author ID supplied by Fluxer. Use webhookId to identify webhook-authored messages */
        readonly id: string
        /** Account username supplied by Fluxer */
        readonly username: string
        /** Whether Fluxer identifies the author as a bot. An omitted wire flag means false */
        readonly isBot: boolean
    }
}

/** One mentioned account as supplied with a message, not a complete profile, guild member or client-cached object */
export interface MessageMention {
    /** Decimal account ID */
    readonly id: string
    /** Account username supplied by Fluxer */
    readonly username: string
    /** Whether Fluxer identifies this account as a bot. An omitted wire flag means false */
    readonly isBot: boolean
}

/** One channel mention visible to everyone, not a channel cache entry or permission decision */
export interface MessageChannelMention {
    /** Decimal channel ID */
    readonly id: string
    /** Channel name observed with this message */
    readonly name: string
    /** Provider channel type. Unknown future values are retained */
    readonly type: number
}

/** Emoji identity nested in a received reaction summary. Null and omission remain distinct when Fluxer supplied them */
export interface MessageReactionEmoji {
    /** Unicode emoji or custom emoji name supplied by Fluxer */
    readonly name: string
    /** Custom emoji ID. Null means an explicit Unicode-emoji identity; omission means the field was not supplied */
    readonly id?: string | null
    /** Animation state. Null and omission retain Fluxer's distinct response states */
    readonly animated?: boolean | null
}

/** One reaction total observed in a received message. It is not a complete reactor list and never updates an existing snapshot */
export interface MessageReactionSummary {
    /** Frozen emoji identity */
    readonly emoji: MessageReactionEmoji
    /** Total reactions Fluxer reported for this emoji at snapshot time */
    readonly count: number
    /** Whether the current bot had reacted when Fluxer supplied that viewer-specific value. Null and omission remain distinct */
    readonly me?: boolean | null
}

/** Shallow reply/forward reference supplied by Fluxer. Its type is 0 for a reply and 1 for a forward in the inspected protocol */
export interface MessageContextReference extends MessageReference {
    /** Guild containing the referenced message. Null means Fluxer explicitly reported no guild; omission means unknown */
    readonly guildId?: string | null
    /** Provider reference type. Omitted by partial gateway payloads; unknown future values are retained */
    readonly type?: number
}

/** Sticker observation attached to a message, not the editable guild resource */
export interface MessageSticker {
    /** Decimal sticker ID */
    readonly id: string
    /** Name observed when Fluxer projected this message */
    readonly name: string
    /** Whether the sticker is animated */
    readonly animated: boolean
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

/** Text, embeds, file uploads or stickers. TypeScript does not establish nonempty content.
 * Stickers can be sent by bots and webhooks but cannot be replaced through message edits
 * @example
 * ```ts
 * import type { Client } from "@neontechspace/fluxerly"
 * export function stickerExample(client: Client, channelId: string, stickerId: string) {
 *     return client.messages.send(channelId, { stickerIds: [stickerId] })
 * }
 * ```
 */
export type MessageBody = (
    | Body<AttachmentInput>
    | {
          /** Optional text alongside stickers */
          readonly content?: string
          /** Optional rich embeds alongside stickers */
          readonly embeds?: readonly EmbedInput[]
          /** Optional new uploads alongside stickers */
          readonly attachments?: readonly AttachmentInput[]
          /** Required sticker list when no other body field supplies message content */
          readonly stickerIds: readonly string[]
      }
) & {
    /** Up to three decimal sticker IDs in send order. Fluxer checks availability and external-sticker permissions.
     * Omitted/empty means no stickers. Inputs are copied before dispatch; no image upload or lookup is performed
     */
    readonly stickerIds?: readonly string[]
}

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

/** Send text, rich embeds, files and/or stickers. A send needs nonempty text, embeds, uploads or sticker IDs.
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

/** Per-call remote message/reaction/pin deadline, separate from the client's gateway startup budget */
export interface MessageOperationOptions {
    /** Total admission, retry/rate-limit wait and HTTP budget in milliseconds, from 1 to 2,147,483,647 as an integer. Defaults to 30,000, with cleanup awaited afterward */
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
