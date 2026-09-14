import type { OperationOptions } from "./client.js"
import type { Embed, EmbedInput } from "./embeds.js"
import type { Attachment, AttachmentInput, AttachmentReference } from "./attachments.js"

/** Address a message using its channel ID and message ID.
 * Pass this plain object to message operations without fetching the message first.
 * It holds no client and makes no request by itself
 */
export interface MessageReference {
    /** Message ID as a decimal string. Keep it as a string to avoid losing integer precision */
    readonly id: string
    /** Channel ID as a decimal string, identifying where to send the operation */
    readonly channelId: string
}

/** Message data returned by a request or delivered through messageCreate and messageUpdate.
 * This object and its nested data are frozen snapshots, not a message with methods or a live view.
 * Later edits, deletions and reaction changes do not update an existing object.
 * An omitted optional field means Fluxer did not supply it, not that its value is false or empty.
 * A null value preserves the explicit value Fluxer returned.
 * References and mentioned accounts are included only as supplied, without extra fetches.
 * Clients configured with messageFields return SelectedMessage instead of the complete Message shape
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
    /** Correlation nonce returned by Fluxer, null when explicitly reported, or absent when not supplied */
    readonly nonce?: string | null
    /** Webhook that sent this message, when Fluxer supplied its ID. A missing or null response value omits this field */
    readonly webhookId?: string
    /** Pin status at observation time. Absence means unknown, not unpinned */
    readonly pinned?: boolean
    /** Creation timestamp as an ISO 8601 string with a timezone, when supplied */
    readonly createdAt?: string
    /** Latest edit timestamp as an ISO 8601 string with a timezone. Null means no edit was reported, absence means unknown */
    readonly editedAt?: string | null
    /** Fluxer's integer message type, when supplied. Values added by Fluxer in the future are retained */
    readonly type?: number
    /** Fluxer's integer flag set, when supplied. Unrecognized bits are retained, and absence does not mean zero */
    readonly flags?: number
    /** Server containing the message, when supplied. Absence alone does not establish that the channel is private */
    readonly guildId?: string
    /** Whether Fluxer reports an @everyone or @here mention. Absence means unknown */
    readonly mentionedEveryone?: boolean
    /** Message text without trimming, possibly empty for a message containing only media */
    readonly content: string
    /** Received embeds in display order, or an empty array when none were supplied */
    readonly embeds: readonly Embed[]
    /** Attached file metadata in received order, or an empty array. File contents are not downloaded */
    readonly attachments: readonly Attachment[]
    /** Attached sticker metadata in received order, or an empty array. Sticker images are not downloaded */
    readonly stickers: readonly MessageSticker[]
    /** Mentioned accounts in received order. An empty array means no mentions were reported, absence means unknown */
    readonly mentions?: readonly MessageMention[]
    /** Mentioned role IDs in received order. An empty array means none were reported, absence means unknown */
    readonly mentionRoleIds?: readonly string[]
    /** Channel mentions supplied with the message. Null and absence preserve distinct response values */
    readonly mentionChannels?: readonly MessageChannelMention[] | null
    /** Reaction counts at observation time, not a list of users or counts that update after delivery */
    readonly reactions?: readonly MessageReactionSummary[] | null
    /** Reply or forward source address, when supplied. Reading it does not fetch the source message */
    readonly messageReference?: MessageContextReference | null
    /** Copies captured when Fluxer created a forward. They contain no source ID and do not follow later source edits */
    readonly messageSnapshots?: readonly MessageSnapshot[] | null
    /** Only the resolved reply's message and channel IDs. Null means the target was missing, absence means no resolution was supplied */
    readonly referencedMessage?: MessageReference | null
    /** Account identity supplied as the author, without profile lookup or account methods */
    readonly author: {
        /** Author ID as a decimal string. Use webhookId, rather than this ID, to identify a webhook sender */
        readonly id: string
        /** Author's username at observation time */
        readonly username: string
        /** True when Fluxer marked the author as a bot, otherwise false */
        readonly isBot: boolean
    }
}

/** Message fields available even when messageFields is an empty array.
 * IDs, text and author remain available for message operations, commands and collectors.
 * guildId is retained when supplied, but remains optional
 */
export type MessageCore = Pick<Message, "id" | "channelId" | "content" | "author" | "guildId">

/** Name of a Message property accepted by the client's messageFields option.
 * Selecting an already-retained MessageCore property does not add or remove data
 */
export type MessageField = keyof Message

/** Message property names to retain in this client's request results, events, cache and collectors.
 * Omit messageFields to keep the full Message shape, or use [] to keep only MessageCore.
 * The client copies the list at creation, so later edits to your array do not change its selection.
 * A selected property includes its complete nested value, including media metadata inside messageSnapshots.
 * Excluded data is still validated when received, so selection does not hide malformed responses
 */
export type MessageFields = readonly MessageField[]

/** Type of message returned for a client's messageFields selection.
 * With no selection, this is Message. With a fixed list, it includes MessageCore and the named properties.
 * Properties optional in Message remain optional, even when selected.
 * Advanced typing: A dynamic array makes selectable properties optional because its contents are not known at compile time.
 * Alternative fixed lists produce alternative message shapes, not a shape promising properties from both lists
 */
export type SelectedMessage<F extends MessageFields | undefined = undefined> = F extends undefined
    ? Message
    : F extends MessageFields
      ? number extends F["length"]
          ? MessageCore & Partial<Pick<Message, F[number]>>
          : Pick<Message, keyof MessageCore | F[number]>
      : never

/** Account identity supplied in a message's mentions array.
 * This is not a full account profile, server member or live cached object
 */
export interface MessageMention {
    /** Mentioned account ID as a decimal string */
    readonly id: string
    /** Mentioned account's username at observation time */
    readonly username: string
    /** True when Fluxer marked the mentioned account as a bot, otherwise false */
    readonly isBot: boolean
}

/** Channel identity supplied in message or forward-snapshot mention data.
 * It contains only an ID, name and type, not cached channel settings or a decision that the bot may access it
 */
export interface MessageChannelMention {
    /** Mentioned channel ID as a decimal string */
    readonly id: string
    /** Channel name captured with the mention */
    readonly name: string
    /** Fluxer's numeric channel type. Unrecognized future values are retained */
    readonly type: number
}

/** Emoji information supplied beside a message's reaction count.
 * Optional values preserve both null and absence when Fluxer distinguishes them
 */
export interface MessageReactionEmoji {
    /** Literal Unicode emoji text or the custom emoji's name */
    readonly name: string
    /** Custom emoji ID, or null for an explicitly identified Unicode emoji. Absence means the ID field was not supplied */
    readonly id?: string | null
    /** Animation flag when supplied, retaining null separately from absence */
    readonly animated?: boolean | null
}

/** Count of reactions using one emoji when Fluxer supplied this message.
 * This is not a user list or a count that updates after delivery
 */
export interface MessageReactionSummary {
    /** Emoji to which this count belongs */
    readonly emoji: MessageReactionEmoji
    /** Nonnegative reaction count reported at observation time */
    readonly count: number
    /** Whether the observing bot had reacted, when supplied. Null and absence preserve distinct response values */
    readonly me?: boolean | null
}

/** Source address supplied for a reply or forward, without the source message's contents.
 * type 0 identifies a reply and type 1 identifies a forward. Future numeric types are retained
 */
export interface MessageContextReference extends MessageReference {
    /** Source server ID, or null when Fluxer explicitly supplied no server. Absence means unknown */
    readonly guildId?: string | null
    /** Reference kind, when supplied. A partial gateway observation can omit it */
    readonly type?: number
}

/** Copy of source content captured by Fluxer when a message was forwarded.
 * The snapshot is deeply frozen and contains no source message or author ID.
 * Later source edits and deletions do not change this copy. Optional null and absent values remain distinct
 */
export interface MessageSnapshot {
    /** Source text at capture time, including null when explicitly supplied */
    readonly content?: string | null
    /** Source message creation time as an ISO 8601 string with a timezone */
    readonly createdAt: string
    /** Source edit time at capture, as an ISO 8601 string, or null when explicitly supplied */
    readonly editedAt?: string | null
    /** Account IDs mentioned in the source, not account objects. No account lookup is performed */
    readonly mentionUserIds?: readonly string[] | null
    /** Role IDs mentioned in the source at capture time */
    readonly mentionRoleIds?: readonly string[] | null
    /** Source channel mentions in captured display order */
    readonly mentionChannels?: readonly MessageChannelMention[] | null
    /** Source embed copies in captured display order */
    readonly embeds?: readonly Embed[] | null
    /** Copied attachment metadata in display order, without downloading file contents */
    readonly attachments?: readonly Attachment[] | null
    /** Source sticker metadata in captured display order, without downloading images */
    readonly stickers?: readonly MessageSticker[] | null
    /** Fluxer's integer source message type at capture, retaining unrecognized future values */
    readonly type: number
    /** Source flag set at capture, retaining unrecognized bits */
    readonly flags: number
}

/** Sticker metadata supplied with a message or forward snapshot.
 * This frozen observation is not the editable server sticker resource
 */
export interface MessageSticker {
    /** Sticker ID as a decimal string */
    readonly id: string
    /** Sticker name at observation time */
    readonly name: string
    /** Whether Fluxer identifies this sticker as animated */
    readonly animated: boolean
}

/** Notice identifying one deleted message, not its full contents or a recoverable copy.
 * The SDK does not fetch or reconstruct missing details from its cache
 */
export interface MessageDeletion extends MessageReference {
    /** Deleted text when supplied. Absence means unavailable, null is preserved, and "" means known empty text */
    readonly content?: string | null
    /** Deleted message's author ID, only when supplied by Fluxer */
    readonly authorId?: string
}

/** Message IDs deleted together in one channel.
 * The frozen batch produces one messageDeleteBulk event, without additional messageDelete events
 */
export interface MessageBulkDeletion {
    /** Channel ID shared by the deleted messages */
    readonly channelId: string
    /** Deleted decimal message IDs in received order, not necessarily chronological or guaranteed to arrive exactly once */
    readonly ids: readonly string[]
}

/** Choose which existing mentions may notify users when sending, replying or editing.
 * All notification categories are disabled unless explicitly enabled.
 * These settings permit notifications but do not insert mention text or bypass Fluxer's permissions
 */
export interface AllowedMentions {
    /** Permit notifications for textual mentions of these account IDs, at most 100. Omit to permit none */
    readonly users?: readonly string[]
    /** Permit notifications for textual mentions of these role IDs, at most 100. Fluxer's server permissions still apply */
    readonly roles?: readonly string[]
    /** Permit @everyone and @here notifications, default false */
    readonly everyone?: boolean
    /** Permit notification of the reply target's author, default false */
    readonly repliedUser?: boolean
}

/** Flags accepted when sending or editing a non-voice message.
 * Combine flags with bitwise OR, for example MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications.
 * Other flag bits are rejected locally
 */
export const MessageFlags: Readonly<{
    /** Hide embeds on this message */
    readonly SuppressEmbeds: 4
    /** Suppress message notifications */
    readonly SuppressNotifications: 4096
}> = Object.freeze({
    SuppressEmbeds: 4,
    SuppressNotifications: 4096,
} as const)

/** One value from MessageFlags. To set multiple flags, combine the values with bitwise OR */
export type MessageFlag = (typeof MessageFlags)[keyof typeof MessageFlags]

/** Correlation identifier attached to a send, reply or forward.
 * Use a string of 1 through 32 UTF-16 code units, or a nonnegative safe integer encoded as a decimal string.
 * This is not the message ID returned after creation
 */
export type MessageNonce = string | number

/** Content for a new message: Text, embeds, file uploads, stickers, or a combination.
 * At least one of these must be nonempty when the operation runs, even if TypeScript accepts an empty value.
 * Stickers can be sent by bots and webhooks, but cannot be replaced in message edits
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
          /** Text to send alongside stickers, without trimming */
          readonly content?: string
          /** Embeds to display alongside stickers */
          readonly embeds?: readonly EmbedInput[]
          /** New files to upload alongside stickers */
          readonly attachments?: readonly AttachmentInput[]
          /** Stickers that supply the message body when text, embeds and files are absent */
          readonly stickerIds: readonly string[]
      }
) & {
    /** Sticker IDs to send, at most three decimal strings in display order.
     * Omit or use [] for no stickers. The SDK copies IDs before dispatch without uploading or looking up images.
     * Fluxer checks sticker availability and external-sticker permissions
     */
    readonly stickerIds?: readonly string[]
}

type Body<A> =
    | {
          /** Message text without trimming. Fluxer checks its applicable content-length limit */
          readonly content: string
          /** Embeds in display order, subject to Fluxer's applicable count limit */
          readonly embeds?: readonly EmbedInput[]
          /** New uploads when sending or replying, or the complete replacement file list when editing */
          readonly attachments?: readonly A[]
      }
    | {
          /** Optional text. Omit for an embed-only send or to leave existing text unchanged in an edit */
          readonly content?: string
          /** Embeds to send in display order, or the replacement embed collection in an edit */
          readonly embeds: readonly EmbedInput[]
          /** New uploads when sending or replying, or the complete replacement file list when editing */
          readonly attachments?: readonly A[]
      }
    | {
          /** Optional text. Omit for a file-only send or to leave existing text unchanged in an edit */
          readonly content?: string
          /** Optional embeds. Omit to leave existing embeds unchanged in an edit */
          readonly embeds?: readonly EmbedInput[]
          /** Files to send, or the complete replacement file list in an edit, including IDs of existing files to keep */
          readonly attachments: readonly A[]
      }

/** Input for messages.send, including content and optional delivery settings.
 * Supply nonempty text, embeds, new files or sticker IDs. Unknown properties are rejected locally.
 * Notifications are off by default. Use allowedMentions to permit specific existing mentions to notify.
 * An attachment:// embed image or thumbnail must name one matching new image upload in this request.
 * Use messages.forward, rather than this input, to copy a source message into an immutable forward
 */
export type MessageInput = MessageBody & {
    /** Correlation nonce chosen by your application, or omit for one SDK-generated nonce per send execution.
     * Fluxer makes a best-effort attempt to suppress a matching nonce for five minutes after persistence, not a durable exactly-once guarantee
     */
    readonly nonce?: MessageNonce
    /** Existing mentions permitted to notify. Defaults to no mention notifications, including the reply author's */
    readonly allowedMentions?: AllowedMentions
    /** Reply target address, whose channelId must equal the send destination */
    readonly messageReference?: MessageReference
    /** Flag set containing only MessageFlags bits. Omit to use Fluxer's default for a new message */
    readonly flags?: number
}

/** Content and delivery settings for messages.reply.
 * The target argument supplies the reply reference, so do not add messageReference here
 */
export type ReplyInput = MessageBody & Pick<MessageInput, "allowedMentions" | "flags" | "nonce">

/** Input for copying a source message into a new forward.
 * Fluxer captures the source. The SDK does not fetch it, check access beforehand or upload new content.
 * Omit both media selectors to copy source text and media.
 * A nonempty selector copies only selected media and omits source text.
 * Empty selectors behave like omitted selectors, not a request for text-only forwarding
 */
export interface ForwardMessageInput {
    /** Application-chosen correlation nonce, or omit for one SDK-generated nonce per forward execution.
     * Fluxer's matching-nonce suppression is best-effort for five minutes after persistence, not guaranteed exactly-once creation
     */
    readonly nonce?: MessageNonce
    /** Source address Fluxer should capture. It may be in another channel, and the SDK does not fetch it beforehand */
    readonly source: MessageReference
    /** Source attachment IDs to copy, at most ten. A nonempty list makes the forward media-only */
    readonly attachmentIds?: readonly string[]
    /** Source embed positions to copy, at most ten, with 0 identifying the first embed. A nonempty list makes the forward media-only */
    readonly embedIndices?: readonly number[]
}

type EditMessageOptions = {
    /** Mentions permitted to notify during this edit, defaulting to none, including the reply author */
    readonly allowedMentions?: AllowedMentions
    /** Replacement flag set using only MessageFlags bits. Omit to leave flags unchanged, or use 0 to clear both writable flags */
    readonly flags?: number
}

/** Input for changing an existing message without fetching or merging its old data.
 * Omitted body properties are left unchanged. Each supplied array replaces its corresponding collection.
 * To keep existing files alongside new uploads, include their attachment IDs in attachments.
 * To clear files, supply attachments: [] together with nonempty text or embeds.
 * To clear embeds, supply embeds: [] together with nonempty text.
 * Empty content asks Fluxer to clear text. Fluxer may regenerate link previews when text changes.
 * A flags-only edit is accepted. An empty edit and unknown properties are rejected.
 * Mention notifications default off for this edit, including notification of the reply author
 */
export type EditMessageInput =
    | (Body<AttachmentInput | AttachmentReference> & EditMessageOptions)
    | (EditMessageOptions & {
          /** Replacement flags when editing flags alone, without any content, embeds or attachments property */
          readonly flags: number
          readonly content?: never
          readonly embeds?: never
          readonly attachments?: never
      })

/** Choose one page for messages.fetchHistory.
 * Omit cursors for the latest visible messages, or choose exactly one of before, after and around.
 * Results are returned newest first, including pages selected with after.
 * Combined cursor modes and unknown properties are rejected locally
 */
export type MessageHistoryQuery = {
    /** Maximum messages requested in this page, an integer from 1 through 100, default 50, not a total-history cap */
    readonly limit?: number
} & (
    | {
          /** Fetch the nearest messages older than this decimal ID, excluding the cursor message */
          readonly before?: string
          readonly after?: never
          readonly around?: never
      }
    | {
          readonly before?: never
          /** Fetch the nearest messages newer than this decimal ID, excluding it. Results still arrive newest first */
          readonly after?: string
          readonly around?: never
      }
    | {
          readonly before?: never
          readonly after?: never
          /** Center the page on this decimal message ID, including it only when present and visible.
           * Fluxer does not guarantee a full page or equal numbers of messages on either side
           */
          readonly around?: string
      }
)

/** Deadline settings for a remote message, reaction or pin operation.
 * The budget includes local queueing, retry delays, rate-limit waits and HTTP work.
 * Cleanup is awaited after the deadline, so completion can take longer than timeoutMs.
 * It does not control gateway connection startup
 */
export interface MessageOperationOptions {
    /** Total request budget in milliseconds, an integer from 1 through 2,147,483,647, default 30,000 */
    readonly timeoutMs?: number
}

/** Remote operation settings for the Promise and Result API.
 * signal cancels this operation only. Cancelling after dispatch cannot undo an edit or deletion.
 * The Effect entry point uses interruption instead of an AbortSignal option
 */
export interface DefaultMessageOperationOptions extends MessageOperationOptions, OperationOptions {}

/** Deadline settings for sending, replying or forwarding.
 * timeoutMs covers local queueing, rate-limit waits and HTTP work. Cleanup is awaited after that budget.
 * If message creation was dispatched, failure can leave delivery unknown even when no message result was returned.
 * The SDK does not automatically retry an uncertain send. Check MessageError.delivery before deciding what to do.
 * Advanced response limits: Created-message JSON is limited to 16 MiB of body bytes before parsing.
 * Upload-plan and completion responses use a separate 1 MiB limit. Neither limit caps total memory use.
 * An oversized or malformed successful response fails with reason response
 */
export interface SendOptions {
    /** Total send budget in milliseconds, an integer from 1 through 2,147,483,647, default 30,000 */
    readonly timeoutMs?: number
}

/** Send settings for the Promise and Result API.
 * signal cancels this send only, without proving whether a dispatched request created a message.
 * The Effect entry point uses interruption instead of an AbortSignal option
 */
export interface DefaultSendOptions extends SendOptions, OperationOptions {}
