import type { OperationOptions } from "./client.js"
import type { Embed, EmbedInput } from "./embeds.js"
import type { EmbedBuilder } from "./builders.js"
import type { Attachment, AttachmentInput, AttachmentReference } from "./attachments.js"

/** Identify a message by its channel ID and message ID.
 * Pass this plain object to message operations without fetching the message first.
 * The SDK captures and validates both IDs once when an operation starts.
 * It holds no client and makes no request by itself
 *
 * @category Messages
 */
export interface MessageReference {
    /** Message ID as a decimal string. Keep it as a string to avoid losing integer precision */
    readonly id: string
    /** Channel ID as a decimal string, identifying where to send the operation */
    readonly channelId: string
}

/** A public community snapshot identifying where a published copy or follow notice originated.
 * This is not a complete Guild and never populates the client's community cache
 *
 * @category Messages
 */
export interface CrosspostSourceGuild {
    /** Decimal source community ID */
    readonly id: string
    /** Source community name */
    readonly name: string
    /** Public discovery description, with null meaning unavailable */
    readonly description: string | null
    /** Provider-supplied public badge features, currently VERIFIED, PARTNERED and DISCOVERABLE. Unknown strings are preserved */
    readonly features: readonly string[]
    /** Approximate member count, with null meaning unavailable rather than zero */
    readonly approximateMemberCount: number | null
    /** Approximate online-member count, with null meaning unavailable rather than zero */
    readonly approximatePresenceCount: number | null
    /** Whether the source community is discoverable */
    readonly discoverable: boolean
    /** Source icon hash, with null meaning no icon and omission meaning unavailable */
    readonly icon?: string | null
    /** Source banner hash, with null meaning no banner and omission meaning unavailable */
    readonly banner?: string | null
}

/** Frozen source metadata for a published message copy or a channel-follow notice.
 * It describes the source community without fetching the original message or retaining a Guild snapshot
 *
 * @category Messages
 */
export interface CrosspostSource {
    /** Frozen public source community snapshot */
    readonly guild: CrosspostSourceGuild
}

/** Message data returned by a request or delivered through messageCreate and messageUpdate.
 * This object and its nested data cannot be changed. They record what Fluxer returned at that time, not a live message with methods.
 * Later edits, deletions and reaction changes do not update it.
 * If an optional field is missing, Fluxer did not supply it. Do not read that as false or empty.
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
 *
 * @category Messages
 */
export interface Message extends MessageReference {
    /** Correlation nonce returned by Fluxer, null when explicitly reported, or absent when not supplied */
    readonly nonce?: string | null
    /** Webhook that sent this message, when Fluxer supplied its ID. A missing or null response value omits this field */
    readonly webhookId?: string
    /** Pin status at observation time. Absence means unknown, not unpinned */
    readonly pinned?: boolean
    /** Whether the message was sent as text-to-speech. Absence means unknown, not false.
     * Fluxer does not store this value, so it is meaningful only on the message returned by a send and on messageCreate events.
     * Every other read, including fetches, history pages and later message events, reports false.
     * In a community, Fluxer creates a normal message and reports false when the sender lacks the Send TTS Messages permission
     */
    readonly tts?: boolean
    /** Creation timestamp as an ISO 8601 string with a timezone, when supplied */
    readonly createdAt?: string
    /** Latest edit timestamp as an ISO 8601 string with a timezone. Null means no edit was reported, absence means unknown */
    readonly editedAt?: string | null
    /** Fluxer's integer message type, when supplied, such as MessageType.Reply. Values added by Fluxer in the future are retained */
    readonly type?: number
    /** Fluxer's integer flag set, when supplied. Unrecognized bits are retained, and absence does not mean zero */
    readonly flags?: number
    /** Community containing the message, when supplied. Absence alone does not establish that the channel is private */
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
    readonly mentions?: readonly MessageUser[]
    /** Accounts referenced by non-notifying text, embeds or forward snapshots.
     * These are separate from active mentions and never change notification behavior. Null, absence and an empty array
     * preserve the distinct values supplied by Fluxer
     */
    readonly referencedUsers?: readonly MessageUser[] | null
    /** Mentioned role IDs in received order. An empty array means none were reported, absence means unknown */
    readonly mentionRoleIds?: readonly string[]
    /** Channel mentions supplied with the message. Null and absence preserve distinct response values */
    readonly mentionChannels?: readonly MessageChannelMention[] | null
    /** Reaction counts at observation time, not a list of users or counts that update after delivery */
    readonly reactions?: readonly MessageReactionSummary[] | null
    /** Received context for a reply, forward, published copy or channel-follow notice, when supplied.
     * A channel-follow notice can identify only a source channel, without a message ID. Reading this field performs no request
     */
    readonly messageReference?: MessageContextReference | null
    /** Copies captured when Fluxer created a forward. They contain no source ID and do not follow later source edits */
    readonly messageSnapshots?: readonly MessageSnapshot[] | null
    /** Custom emoji IDs that Fluxer classified as explicit. An empty array is known empty and absence is unknown */
    readonly nsfwEmojiIds?: readonly string[]
    /** Resolved reply snapshot. Null means the target was missing and absence means no resolution was supplied.
     * Fluxer omits a second referencedMessage from this snapshot, so reply nesting is bounded to one level.
     * Reading this field performs no request
     */
    readonly referencedMessage?: ReferencedMessage | null
    /** Partial account identity supplied as the author, without profile lookup or account methods.
     * Webhook and deleted-user authors remain partial MessageUser values and must not be treated as complete User objects
     */
    readonly author: MessageUser
}

/** Message fields available even when messageFields is an empty array.
 * IDs, text and author remain available for message operations, commands and collectors.
 * The guildId is retained when supplied, but remains optional
 *
 * @category Messages
 */
export type MessageCore = Pick<Message, "id" | "channelId" | "content" | "author" | "guildId">

/** Name of a Message property accepted by the client's messageFields option.
 * Selecting a MessageCore property, which is always kept, does not change the result
 *
 * @category Messages
 */
export type MessageField = keyof Message

/** Message property names to retain in this client's request results, events, cache and collectors.
 * Omit messageFields to keep the full Message shape, or use [] to keep only MessageCore.
 * The client copies the list at creation, so later edits to the supplied array do not change its selection.
 * A selected property includes its complete nested value, including media metadata inside messageSnapshots.
 * Excluded data is still validated when received, so selection does not hide malformed responses
 *
 * @category Messages
 */
export type MessageFields = readonly MessageField[]

/** Type of message returned for a client's messageFields selection.
 * With no selection, this is Message. With a fixed list, it includes MessageCore and the named properties.
 * Properties optional in Message remain optional, even when selected.
 * If the list is built dynamically, TypeScript cannot know which fields it contains, so selectable fields remain optional.
 * Alternative fixed lists produce alternative message shapes, not a shape promising properties from both lists
 *
 * @category Messages
 */
export type SelectedMessage<F extends MessageFields | undefined = undefined> = F extends undefined
    ? Message
    : F extends MessageFields
      ? number extends F["length"]
          ? MessageCore & Partial<Pick<Message, F[number]>>
          : Pick<Message, keyof MessageCore | F[number]>
      : never

/** Partial account identity embedded in a message response.
 * This deeply frozen observation can describe an author, active mention or non-notifying referenced account.
 * It is not a complete User, community member or live cached object. Optional fields remain absent when Fluxer omitted
 * them, including for webhook and deleted-user placeholders. The mentionFlags value is descriptive only and never
 * enables a notification or overrides AllowedMentions
 *
 * @category Messages
 */
export interface MessageUser {
    /** Account or webhook identity as a decimal string */
    readonly id: string
    /** Username or webhook name at observation time */
    readonly username: string
    /** True when Fluxer marked the identity as a bot, otherwise false */
    readonly isBot: boolean
    /** Provider discriminator when supplied */
    readonly discriminator?: string
    /** Account-wide display name, null when explicitly unset */
    readonly displayName?: string | null
    /** Avatar asset hash, null when explicitly absent */
    readonly avatar?: string | null
    /** Dominant avatar color, null when explicitly absent */
    readonly avatarColor?: number | null
    /** Whether Fluxer marked this as an official system account */
    readonly isSystem?: boolean
    /** Public account flags when supplied. Unrecognized 32-bit values are retained */
    readonly flags?: number
    /** Account-wide reply mention preference: 0 for none, 1 to prefer a mention, or 2 to prefer no mention.
     * This is displayable context only. Sending and replying continue to use explicit AllowedMentions
     */
    readonly mentionFlags?: 0 | 1 | 2
}

/** One resolved reply supplied inline with a message.
 * This is a frozen Message snapshot without another resolved reply, keeping nesting finite and avoiding hidden fetches
 *
 * @category Messages
 */
export type ReferencedMessage = Omit<Message, "referencedMessage">

/** Channel identity supplied in message or forward-snapshot mention data.
 * It contains only an ID, name and type, not cached channel settings or a decision that the bot may access it
 *
 * @category Messages
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
 *
 * @category Messages
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
 *
 * @category Messages
 */
export interface MessageReactionSummary {
    /** Emoji to which this count belongs */
    readonly emoji: MessageReactionEmoji
    /** Nonnegative reaction count reported at observation time */
    readonly count: number
    /** Whether the observing bot had reacted, when supplied. Null and absence preserve distinct response values */
    readonly me?: boolean | null
}

/** Received source context for a reply, forward, published copy or channel-follow notice.
 * A channel-follow notice identifies the followed announcement channel without a source message ID.
 * Type 0 is a default reference and type 1 is a forward. The containing message's type and flags distinguish
 * replies, published copies and channel-follow notices. Future numeric reference types are retained
 *
 * Check that id is present before constructing a MessageReference for a fetch, reply or other message operation.
 * Reading this context performs no request and does not establish access to the source
 *
 * @category Messages
 */
export interface MessageContextReference {
    /** Source channel ID as a decimal string, required even when no source message is identified */
    readonly channelId: string
    /** Source message ID as a decimal string. A missing or null response value omits this field */
    readonly id?: string
    /** Source community ID, or null when Fluxer explicitly supplied no community. Absence means unknown */
    readonly guildId?: string | null
    /** Reference kind, when supplied. A partial gateway observation can omit it */
    readonly type?: number
}

/** Copy of source content captured by Fluxer when a message was forwarded.
 * The snapshot is deeply frozen and contains no source message or author ID.
 * Later source edits and deletions do not change this copy. Optional null and absent values remain distinct
 *
 * @category Messages
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
 * This frozen observation is not the editable community sticker resource
 *
 * @category Messages
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
 *
 * @category Events and collectors
 */
export interface MessageDeletion extends MessageReference {
    /** Community ID when Fluxer supplies it. Omission means no community context was supplied, not a confirmed private channel.
     * No channel lookup or cache inference supplies this field
     */
    readonly guildId?: string
    /** Deleted text when supplied. Absence means unavailable, null is preserved, and "" means known empty text */
    readonly content?: string | null
    /** Deleted message's author ID, only when supplied by Fluxer */
    readonly authorId?: string
}

/** Message IDs deleted together in one channel.
 * The frozen batch produces one messageDeleteBulk event, without additional messageDelete events
 *
 * @category Events and collectors
 */
export interface MessageBulkDeletion {
    /** Channel ID shared by the deleted messages */
    readonly channelId: string
    /** Community ID when Fluxer supplies it. Omission means no community context was supplied, not a confirmed private channel.
     * No channel lookup or cache inference supplies this field
     */
    readonly guildId?: string
    /** Deleted decimal message IDs in received order, not necessarily chronological or guaranteed to arrive exactly once */
    readonly ids: readonly string[]
}

/** Choose which existing mentions may notify users when sending, replying or editing.
 * All notification categories are disabled unless explicitly enabled. ID arrays are copied by index when the operation starts.
 * These settings allow notifications but do not add mention text or bypass Fluxer's permissions
 *
 * @category Messages
 */
export interface AllowedMentions {
    /** Permit notifications for textual mentions of these account IDs, at most 100. Omit to permit none */
    readonly users?: readonly string[]
    /** Permit notifications for textual mentions of these role IDs, at most 100. Fluxer's community permissions still apply */
    readonly roles?: readonly string[]
    /** Permit @everyone and @here notifications, default false */
    readonly everyone?: boolean
    /** Permit notification of the reply target's author, default false */
    readonly repliedUser?: boolean
}

/** Known bits in a received message's flags, including server-managed publishing state.
 * Test an observed bit with bitwise AND, such as `(message.flags & MessageFlags.IsCrosspost) !== 0`.
 * Only SuppressEmbeds and SuppressNotifications are writable through message or webhook send and edit operations.
 * Combine those two with bitwise OR. Server-managed bits and all other bits are rejected locally before dispatch
 *
 * @category Messages
 */
export const MessageFlags: Readonly<{
    /** Server-managed bit on an announcement message that has been published to following channels */
    readonly Crossposted: 1
    /** Server-managed bit on a published copy delivered to a following channel. Its messageReference identifies the source */
    readonly IsCrosspost: 2
    /** Writable bit that hides embeds on this message */
    readonly SuppressEmbeds: 4
    /** Server-managed bit on a published copy whose source was deleted or can no longer be delivered.
     * Fluxer replaces the copy's content with "[Original message deleted]" and clears attachments, embeds and stickers
     */
    readonly SourceMessageDeleted: 8
    /** Writable bit that suppresses push and desktop notifications */
    readonly SuppressNotifications: 4096
}> = Object.freeze({
    Crossposted: 1,
    IsCrosspost: 2,
    SuppressEmbeds: 4,
    SourceMessageDeleted: 8,
    SuppressNotifications: 4096,
} as const)

/** Fluxer's message types, the values of Message.type, such as `message.type === MessageType.UserJoin`.
 * Every type shares the one Message shape. A value missing here, added by Fluxer later, is still kept in Message.type
 *
 * @category Messages
 */
export const MessageType: Readonly<{
    /** A regular message */
    readonly Default: 0
    /** A notice that a user was added to a group conversation */
    readonly RecipientAdd: 1
    /** A notice that a user was removed from a group conversation */
    readonly RecipientRemove: 2
    /** A call in a private conversation */
    readonly Call: 3
    /** A notice that the conversation's name changed */
    readonly ChannelNameChange: 4
    /** A notice that the conversation's icon changed */
    readonly ChannelIconChange: 5
    /** A notice that a message was pinned */
    readonly ChannelPinnedMessage: 6
    /** A notice that a user joined the community */
    readonly UserJoin: 7
    /** A notice that this channel began following an announcement channel.
     * Its messageReference identifies the followed channel without a source message ID
     */
    readonly ChannelFollowAdd: 12
    /** A reply to another message, whose messageReference names the target */
    readonly Reply: 19
}> = Object.freeze({
    Default: 0,
    RecipientAdd: 1,
    RecipientRemove: 2,
    Call: 3,
    ChannelNameChange: 4,
    ChannelIconChange: 5,
    ChannelPinnedMessage: 6,
    UserJoin: 7,
    ChannelFollowAdd: 12,
    Reply: 19,
} as const)

/**
 * One known bit from MessageFlags, including server-managed bits observed in received messages.
 * Only SuppressEmbeds and SuppressNotifications can be combined for send or edit input
 *
 * @category Messages
 */
export type MessageFlag = (typeof MessageFlags)[keyof typeof MessageFlags]

/** Correlation identifier attached to a send, reply or forward.
 * Use a string of 1 through 32 UTF-16 code units, or a nonnegative safe integer encoded as a decimal string.
 * This is not the message ID returned after creation
 *
 * @category Messages
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
 *
 * @category Messages
 */
export type MessageBody = (
    | MessageContent<AttachmentInput>
    | {
          /** Text to send alongside stickers, without trimming */
          readonly content?: string
          /** Embeds to display alongside stickers, as plain objects or EmbedBuilder instances */
          readonly embeds?: readonly (EmbedInput | EmbedBuilder)[]
          /** New files to upload alongside stickers */
          readonly attachments?: readonly AttachmentInput[]
          /** Stickers that supply the message body when text, embeds and files are absent */
          readonly stickerIds: readonly string[]
      }
) & {
    /** Sticker IDs to send, at most three decimal strings in display order.
     * Omit or use [] for no stickers. The SDK copies IDs by index before dispatch without uploading or looking up images.
     * Fluxer checks sticker availability and external-sticker permissions
     */
    readonly stickerIds?: readonly string[]
}

/** Text, embeds and files of a message body, where at least one of content, embeds or attachments is required.
 * A is the accepted attachment type: New uploads when sending, or uploads and references to kept files when editing
 *
 * @category Messages
 */
export type MessageContent<A> =
    | {
          /** Message text without trimming. Fluxer checks its applicable content-length limit */
          readonly content: string
          /** Embeds in display order, subject to Fluxer's applicable count limit. An EmbedBuilder is built when the operation reads its input */
          readonly embeds?: readonly (EmbedInput | EmbedBuilder)[]
          /** New uploads when sending or replying, or the complete replacement file list when editing */
          readonly attachments?: readonly A[]
      }
    | {
          /** Optional text. Omit for an embed-only send or to leave existing text unchanged in an edit */
          readonly content?: string
          /** Embeds to send in display order, or the replacement embed collection in an edit. An EmbedBuilder is built when the operation reads its input */
          readonly embeds: readonly (EmbedInput | EmbedBuilder)[]
          /** New uploads when sending or replying, or the complete replacement file list when editing */
          readonly attachments?: readonly A[]
      }
    | {
          /** Optional text. Omit for a file-only send or to leave existing text unchanged in an edit */
          readonly content?: string
          /** Optional embeds, as plain objects or EmbedBuilder instances. Omit to leave existing embeds unchanged in an edit */
          readonly embeds?: readonly (EmbedInput | EmbedBuilder)[]
          /** Files to send, or the complete replacement file list in an edit, including IDs of existing files to keep */
          readonly attachments: readonly A[]
      }

/** Input for messages.send, including content and optional delivery settings.
 * Supply nonempty text, embeds, new files or sticker IDs. Unknown properties are rejected locally.
 * Notifications are off by default. Use allowedMentions to permit specific existing mentions to notify.
 * An attachment:// embed image or thumbnail must name one matching new image or video upload in this request.
 * Each field, including an attachment or allowedMentions field, is read at most once, so the value validated is the value sent.
 * Use messages.forward to copy a source message into an immutable forward
 *
 * @category Messages
 */
export type MessageInput = MessageBody & {
    /** Correlation nonce chosen by the application, or omit for one SDK-generated nonce per send execution.
     * For five minutes after saving a message, Fluxer tries to suppress another send with the same nonce. This does not guarantee exactly-once delivery
     */
    readonly nonce?: MessageNonce
    /** Existing mentions permitted to notify. Defaults to no mention notifications, including the reply author's */
    readonly allowedMentions?: AllowedMentions
    /** Reply target address, whose channelId must equal the send destination */
    readonly messageReference?: MessageReference
    /** Writable flag set containing only MessageFlags.SuppressEmbeds and MessageFlags.SuppressNotifications.
     * Omit to use Fluxer's default. Server-managed and unsupported bits fail locally before dispatch
     */
    readonly flags?: number
    /** Ask Fluxer to send the message as text-to-speech. Omit or use false for a normal message.
     * The SDK sends the value unchanged. In a community, a bot without the Send TTS Messages permission gets a normal message and no error, and the returned message's tts field reports false.
     * Fluxer does not store the value: Only the returned message and the messageCreate event report it, and every later read reports false.
     * A non-boolean value fails with reason input before dispatch
     */
    readonly tts?: boolean
}

/** Content and delivery settings for messages.reply.
 * The target argument supplies the reply reference, so do not add messageReference here
 *
 * @category Messages
 */
export type ReplyInput = MessageBody & Pick<MessageInput, "allowedMentions" | "flags" | "nonce" | "tts">

/** Input for copying a source message into a new forward.
 * Fluxer captures the source. The SDK does not fetch it, check access beforehand or upload new content.
 * Omit both media selectors to copy source text and media.
 * A nonempty selector copies only selected media and omits source text.
 * Empty selectors behave like omitted selectors. Selector arrays are copied by index when the operation starts
 *
 * @category Messages
 */
export interface ForwardMessageInput {
    /** Application-chosen correlation nonce, or omit for one SDK-generated nonce per messages.forward execution.
     * Webhook forwards send no nonce unless supplied on the message or this source.
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

/**
 * Delivery settings that an edit can change alongside or instead of its body
 *
 * @category Messages
 */
export type EditMessageOptions = {
    /** Mentions permitted to notify during this edit, defaulting to none, including the reply author */
    readonly allowedMentions?: AllowedMentions
    /** Replacement writable flags containing only MessageFlags.SuppressEmbeds and MessageFlags.SuppressNotifications.
     * Omit to preserve flags, or use 0 to clear both writable bits. Server-managed and unsupported bits fail locally before dispatch
     */
    readonly flags?: number
}

/** Input for changing an existing message without fetching or merging its old data.
 * Omitted body properties are left unchanged. Each supplied array replaces its corresponding collection.
 * To keep existing files alongside new uploads, include their attachment IDs in attachments.
 * To clear files, supply attachments: [] together with nonempty text or embeds.
 * To clear embeds, supply embeds: [] together with nonempty text.
 * Empty content asks Fluxer to clear text. Fluxer may regenerate link previews when text changes.
 * A flags-only edit is accepted. An empty edit and unknown properties are rejected.
 * Each field is read at most once, so the value validated is the value sent.
 * Mention notifications default off for this edit, including notification of the reply author
 *
 * @category Messages
 */
export type EditMessageInput =
    | (MessageContent<AttachmentInput | AttachmentReference> & EditMessageOptions)
    | (EditMessageOptions & {
          /** Replacement flags when editing flags alone, without any content, embeds or attachments property */
          readonly flags: number
          /** Omitted in a flags-only edit, which leaves the text unchanged */
          readonly content?: never
          /** Omitted in a flags-only edit, which leaves the embeds unchanged */
          readonly embeds?: never
          /** Omitted in a flags-only edit, which leaves the files unchanged */
          readonly attachments?: never
      })

/** Choose one page for messages.fetchHistory.
 * Omit cursors for the latest visible messages, or choose exactly one of before, after and around.
 * Results are returned newest first, including pages selected with after.
 * Combined cursor modes and unknown properties are rejected locally
 *
 * @category Messages
 */
export type MessageHistoryQuery = {
    /** Maximum messages requested in this page, an integer from 1 through 100, default 50, not a total-history cap */
    readonly limit?: number
} & (
    | {
          /** Fetch the nearest messages older than this decimal ID, excluding the cursor message */
          readonly before?: string
          /** Not accepted with before. Choose one cursor */
          readonly after?: never
          /** Not accepted with before. Choose one cursor */
          readonly around?: never
      }
    | {
          /** Not accepted with after. Choose one cursor */
          readonly before?: never
          /** Fetch the nearest messages newer than this decimal ID, excluding it. Results still arrive newest first */
          readonly after?: string
          /** Not accepted with after. Choose one cursor */
          readonly around?: never
      }
    | {
          /** Not accepted with around. Choose one cursor */
          readonly before?: never
          /** Not accepted with around. Choose one cursor */
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
 *
 * @category Options
 */
export interface MessageOperationOptions {
    /** Total request budget in milliseconds, an integer from 1 through 2,147,483,647, default the bot client's rest.defaultTimeoutMs (30,000 unless configured) or 30,000 for standalone webhook clients */
    readonly timeoutMs?: number
}

/** Remote operation settings for the Promise and Result API.
 * The signal cancels this operation only. Cancelling after dispatch cannot undo an edit or deletion.
 * The Effect entry point uses interruption instead of an AbortSignal option
 *
 * @category Options
 */
export interface DefaultMessageOperationOptions extends MessageOperationOptions, OperationOptions {}

/** Settings for message deletion, bulk deletion, pinning and unpinning, with an optional audit-log explanation
 *
 * @category Options
 */
export interface MessageAuditOperationOptions extends MessageOperationOptions {
    /** Optional audit-log reason, 1–512 printable ASCII characters after trimming.
     * Sent only as the raw X-Audit-Log-Reason header, without URL escaping. Omission sends no header.
     * Non-ASCII and control characters fail before dispatch. Never included in SDK errors or diagnostics
     */
    readonly auditReason?: string
}

/** Default API settings for audited message mutations. Abort cancels only this call and cannot undo a dispatched change
 *
 * @category Options
 */
export interface DefaultMessageAuditOperationOptions extends MessageAuditOperationOptions, OperationOptions {}

/** Required confirmation and deadline for deleting this bot's entire authored history in a channel or community.
 * The confirm field must be the literal true, so an accidental call without it fails before any request with reason input
 * and inputValidation path options.confirm
 *
 * @category Options
 */
export interface OwnMessageDeletionOptions extends MessageOperationOptions {
    /** Must be true to acknowledge that the deletion is irreversible and cannot be rolled back */
    readonly confirm: true
}

/** Default API settings for own-history deletion. Aborting the signal cannot undo a dispatched deletion
 *
 * @category Options
 */
export interface DefaultOwnMessageDeletionOptions extends OwnMessageDeletionOptions, OperationOptions {}

/** Deadline settings for sending, replying or forwarding.
 * The timeoutMs option covers local queueing, rate-limit waits and HTTP work. Cleanup is awaited after that budget.
 * If message creation was dispatched, failure can leave delivery unknown even when no message result was returned.
 * The SDK does not automatically retry an uncertain send. Check MessageError.outcome before deciding what to do.
 * Advanced response limits: Created-message JSON is limited to 16 MiB of body bytes before parsing.
 * Upload-plan and completion responses use a separate 1 MiB limit. Neither limit caps total memory use.
 * An oversized or malformed successful response fails with reason response
 *
 * @category Options
 */
export interface SendOptions {
    /** Total send budget in milliseconds, an integer from 1 through 2,147,483,647, default the client's rest.defaultTimeoutMs, 30,000 unless configured */
    readonly timeoutMs?: number
}

/** Send settings for the Promise and Result API.
 * The signal cancels this send only, without proving whether a dispatched request created a message.
 * The Effect entry point uses interruption instead of an AbortSignal option
 *
 * @category Options
 */
export interface DefaultSendOptions extends SendOptions, OperationOptions {}
