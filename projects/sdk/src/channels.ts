import type { OperationOptions } from "./client.js"
import type { ClientClosedError } from "./errors.js"
import type { GuildMember } from "./guilds.js"
import { operationErrorFields, operationErrorSettings, operationErrorText, type ApiErrorDetail } from "./api-errors.js"
import { FluxerlyError, type OperationErrorOptions, type OperationOutcome, type OperationReason } from "./errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"

/** Choose what a new community channel does: Text messages, announcements, voice calls, a category that groups channels, or a link.
 * Received channels use the same constants in GuildChannel.type, including threads, forum channels and media channels.
 * A future Fluxer type that this SDK version does not know arrives as a GuildUnknownChannel, whose type is "unknown"
 * and whose rawType keeps the number
 *
 * @category Channels
 */
export const ChannelType: Readonly<{
    /** A community text conversation */
    Text: 0
    /** A community voice-call channel */
    Voice: 2
    /** A grouping parent for community channels */
    Category: 4
    /** A community announcement channel whose published messages can reach following channels */
    Announcement: 5
    /** A thread inside an announcement channel, visible to everyone who can view that channel */
    AnnouncementThread: 10
    /** A thread inside a text, forum or media channel, visible to everyone who can view that channel.
     * Every post in a forum or media channel is a public thread
     */
    PublicThread: 11
    /** A thread inside a text channel, visible only to its members and to members who can manage threads */
    PrivateThread: 12
    /** A channel that holds posts, each a public thread with its own first message, and no messages of its own */
    Forum: 15
    /** A forum channel that can also hide media download options */
    Media: 16
    /** A channel that points to an external URL */
    Link: 998
}> = Object.freeze({
    Text: 0,
    Voice: 2,
    Category: 4,
    Announcement: 5,
    AnnouncementThread: 10,
    PublicThread: 11,
    PrivateThread: 12,
    Forum: 15,
    Media: 16,
    Link: 998,
})

/** Known bits in the flags of a thread, forum channel or media channel.
 * Test a bit with bitwise AND, such as `((channel.flags ?? 0) & ChannelFlags.RequireTag) !== 0`. Received flags keep
 * bits this SDK version does not name
 *
 * @category Channels
 */
export const ChannelFlags: Readonly<{
    /** On a forum or media post: The post is pinned at the top of its channel. A channel holds at most one pinned
     * post, and archiving the post clears this bit
     */
    Pinned: 2
    /** On a forum or media channel: A new post, or a change to a post's tags, needs at least one tag */
    RequireTag: 16
    /** On a media channel only: Clients hide the media download options */
    HideMediaDownloadOptions: 32768
}> = Object.freeze({
    Pinned: 2,
    RequireTag: 16,
    HideMediaDownloadOptions: 32768,
})

/** Inactivity periods, in minutes, after which Fluxer archives a thread.
 * The period counts from the later of the thread's last message and its archiveTimestamp. A new thread uses ThreeDays
 * unless its creation sets another value, and Fluxer does not apply a parent channel's defaultAutoArchiveMinutes to it
 *
 * @category Channels
 */
export const ThreadAutoArchiveMinutes: Readonly<{
    /** Archive after one hour without activity */
    OneHour: 60
    /** Archive after one day without activity */
    OneDay: 1440
    /** Archive after three days without activity, the default for a new thread */
    ThreeDays: 4320
    /** Archive after one week without activity */
    OneWeek: 10080
}> = Object.freeze({
    OneHour: 60,
    OneDay: 1440,
    ThreeDays: 4320,
    OneWeek: 10080,
})

/** Orders in which clients list the posts of a forum or media channel by default.
 * A received defaultSortOrder keeps a value this SDK version does not name
 *
 * @category Channels
 */
export const ForumSortOrder: Readonly<{
    /** Newest activity first */
    LatestActivity: 0
    /** Newest post first */
    CreationTime: 1
}> = Object.freeze({
    LatestActivity: 0,
    CreationTime: 1,
})

/** Layouts in which clients show the posts of a forum channel by default. Media channels have no layout setting.
 * A received defaultForumLayout keeps a value this SDK version does not name
 *
 * @category Channels
 */
export const ForumLayout: Readonly<{
    /** No layout chosen, so each client uses its own default */
    Default: 0
    /** Posts as a list */
    List: 1
    /** Posts as a grid of previews */
    Grid: 2
}> = Object.freeze({
    Default: 0,
    List: 1,
    Grid: 2,
})

/** Give or deny channel permissions to one role or member.
 * A permission absent from both allow and deny remains subject to other applicable roles and overwrites.
 * Build these bitfields with Permissions constants and bigint bitwise operators. This is one explicit overwrite,
 * not the member's final permissions. SDK writes accept values through 9_223_372_036_854_775_807n and send
 * ViewChannelMembers replacements to Fluxer. Received values can use the full unsigned 64-bit range
 *
 * @category Roles and permissions
 */
export interface PermissionOverwrite {
    /** Decimal role or member ID */
    readonly id: string
    /** Whether id identifies a role or a community member */
    readonly type: "role" | "member"
    /** Permissions explicitly granted here. Writes accept 0n through 9_223_372_036_854_775_807n, and responses can use unsigned 64-bit values. 0n grants nothing explicitly */
    readonly allow: bigint
    /** Permissions explicitly denied here. Writes accept 0n through 9_223_372_036_854_775_807n, and responses can use unsigned 64-bit values. 0n denies nothing explicitly */
    readonly deny: bigint
}

/**
 * Fields every community channel shares, whatever its type
 *
 * @category Channels
 */
export interface GuildChannelBase {
    /** Decimal channel ID */
    readonly id: string
    /** Decimal community ID */
    readonly guildId: string
    /** A ChannelType constant, or "unknown" for a type this SDK version does not know. Compare it to select the
     * matching channel shape
     */
    readonly type: (typeof ChannelType)[keyof typeof ChannelType] | "unknown"
    /** Channel name, when Fluxer supplies one */
    readonly name?: string
    /** Server ordering position, not an immutable ordering guarantee */
    readonly position?: number
    /** Parent category ID, with null meaning top-level and omission meaning unavailable */
    readonly parentId?: string | null
    /** Explicit channel overwrites, not inherited or effective permissions */
    readonly permissionOverwrites?: readonly PermissionOverwrite[]
    /** Effective adult-content setting from Fluxer's older NSFW field, when supplied */
    readonly nsfw?: boolean
    /** Channel adult-content override, with null inheriting from its category then community */
    readonly nsfwOverride?: boolean | null
    /** Channel content-warning override, when supplied */
    readonly contentWarningLevel?: number
    /** Custom content-warning text, with null inheriting */
    readonly contentWarningText?: string | null
}

/**
 * Message and topic fields shared by community text and announcement channels
 *
 * @category Channels
 */
export interface GuildTextChannelBase extends GuildChannelBase {
    /** Text or announcement channel type. Each received shape has its own literal discriminant */
    readonly type: typeof ChannelType.Text | typeof ChannelType.Announcement
    /** Topic, with null clearing it and omission meaning unavailable */
    readonly topic?: string | null
    /** Last message ID, with null meaning no known message */
    readonly lastMessageId?: string | null
    /** ISO 8601 last-pin time, with null meaning no pins */
    readonly lastPinTimestamp?: string | null
    /** Slowmode delay in seconds */
    readonly rateLimitPerUser?: number
    /** Stored default auto-archive period for threads in this channel, in minutes, such as
     * ThreadAutoArchiveMinutes.OneDay. Fluxer sends it only when one is stored, and does not apply it to a new thread
     */
    readonly defaultAutoArchiveMinutes?: number | null
    /** Slowmode delay in seconds that a new thread in this channel copies when its creation sets none.
     * Fluxer sends it only when one is stored
     */
    readonly defaultThreadRateLimitPerUser?: number
}

/**
 * A community text conversation, selected by `type === ChannelType.Text`
 *
 * @category Channels
 */
export interface GuildTextChannel extends GuildTextChannelBase {
    /** Always ChannelType.Text */
    readonly type: typeof ChannelType.Text
}

/**
 * A community announcement channel, selected by `type === ChannelType.Announcement`.
 * It has the same message and topic fields as a text channel
 *
 * @category Channels
 */
export interface GuildAnnouncementChannel extends GuildTextChannelBase {
    /** Always ChannelType.Announcement */
    readonly type: typeof ChannelType.Announcement
}

/**
 * A community voice-call channel, selected by `type === ChannelType.Voice`
 *
 * @category Channels
 */
export interface GuildVoiceChannel extends GuildChannelBase {
    /** Always ChannelType.Voice */
    readonly type: typeof ChannelType.Voice
    /** Voice bitrate in bits per second, with null meaning no voice setting */
    readonly bitrate?: number | null
    /** Voice user limit, with null meaning no voice setting */
    readonly userLimit?: number | null
    /** Voice connections permitted per user, with null meaning no voice setting */
    readonly voiceConnectionLimit?: number | null
    /** Voice region ID, with null selecting automatic routing */
    readonly rtcRegion?: string | null
    /** Last message ID in the channel's text chat, with null meaning no known message */
    readonly lastMessageId?: string | null
    /** Slowmode delay in seconds for the channel's text chat */
    readonly rateLimitPerUser?: number
}

/**
 * A grouping parent for community channels, selected by `type === ChannelType.Category`
 *
 * @category Channels
 */
export interface GuildCategoryChannel extends GuildChannelBase {
    /** Always ChannelType.Category */
    readonly type: typeof ChannelType.Category
}

/**
 * A channel that points to an external URL, selected by `type === ChannelType.Link`
 *
 * @category Channels
 */
export interface GuildLinkChannel extends GuildChannelBase {
    /** Always ChannelType.Link */
    readonly type: typeof ChannelType.Link
    /** Link URL, with null clearing it and omission meaning unavailable */
    readonly url?: string | null
}

/** The bot's own membership in a thread, as Fluxer reports it beside the thread.
 * A thread read, a thread list or an event only describes this membership at that moment
 *
 * @category Channels
 */
export interface ThreadMembership {
    /** ISO 8601 time the bot last joined the thread */
    readonly joinedAt: string
    /** Fluxer's thread member flags, such as notification preferences. Unrecognized bits are kept */
    readonly flags: number
}

/** One member of a thread. The object is frozen and does not update when the membership changes
 *
 * @category Channels
 */
export interface ThreadMember {
    /** Decimal thread ID */
    readonly threadId: string
    /** Decimal ID of the member's account */
    readonly userId: string
    /** ISO 8601 time the user last joined the thread */
    readonly joinedAt: string
    /** Fluxer's thread member flags, such as notification preferences. Unrecognized bits are kept */
    readonly flags: number
    /** The user's community membership, present only when Fluxer supplied it with the thread member */
    readonly member?: GuildMember
}

/**
 * Fields every thread shares, whatever its type. A thread has no permission overwrites of its own, because Fluxer
 * computes its permissions from the parent channel
 *
 * @category Channels
 */
export interface GuildThreadChannelBase extends GuildChannelBase {
    /** One of the three thread types. Each received shape has its own literal discriminant */
    readonly type:
        typeof ChannelType.AnnouncementThread | typeof ChannelType.PublicThread | typeof ChannelType.PrivateThread
    /** Decimal ID of the text, announcement, forum or media channel that holds the thread, never a category */
    readonly parentId: string
    /** Decimal ID of the user or webhook that created the thread */
    readonly ownerId: string
    /** Thread name */
    readonly name: string
    /** Whether the thread is archived. An archived thread accepts no new members, reactions, pins or edits, and a
     * message sent to it unarchives it
     */
    readonly archived: boolean
    /** Whether only members who can manage threads may act in the thread */
    readonly locked: boolean
    /** Inactivity period in minutes after which Fluxer archives the thread, such as ThreadAutoArchiveMinutes.ThreeDays */
    readonly autoArchiveMinutes: number
    /** ISO 8601 time the thread was last archived, unarchived or given a new autoArchiveMinutes. It equals createdAt
     * until the first of those changes
     */
    readonly archiveTimestamp: string
    /** ISO 8601 time the thread was created */
    readonly createdAt: string
    /** Last message ID, with null meaning the thread has no message */
    readonly lastMessageId?: string | null
    /** ISO 8601 last-pin time, with null meaning nothing was ever pinned */
    readonly lastPinTimestamp?: string | null
    /** Slowmode delay in seconds */
    readonly rateLimitPerUser?: number
    /** Thread flags. Only ChannelFlags.Pinned can be set, and only on a forum or media post. Unrecognized bits are kept */
    readonly flags?: number
    /** Messages in the thread, excluding the first message of a forum post and deleted messages */
    readonly messageCount?: number
    /** Messages ever sent in the thread, excluding the first message of a forum post. Deleting a message does not lower it */
    readonly totalMessageSent?: number
    /** Approximate number of thread members, capped at 50 */
    readonly memberCount?: number
    /** The bot's own membership, present when Fluxer reports that the bot is a member. Absence does not prove that the
     * bot is not a member, because some reads leave it out
     */
    readonly membership?: ThreadMembership
}

/**
 * A thread inside an announcement channel, selected by `type === ChannelType.AnnouncementThread`
 *
 * @category Channels
 */
export interface GuildAnnouncementThreadChannel extends GuildThreadChannelBase {
    /** Always ChannelType.AnnouncementThread */
    readonly type: typeof ChannelType.AnnouncementThread
}

/**
 * A public thread inside a text channel, or a post inside a forum or media channel, selected by
 * `type === ChannelType.PublicThread`
 *
 * @category Channels
 */
export interface GuildPublicThreadChannel extends GuildThreadChannelBase {
    /** Always ChannelType.PublicThread */
    readonly type: typeof ChannelType.PublicThread
    /** IDs of the forum tags applied to a forum or media post, at most 5. Absent on a thread in a text channel */
    readonly appliedTagIds?: readonly string[]
}

/**
 * A private thread inside a text channel, selected by `type === ChannelType.PrivateThread`
 *
 * @category Channels
 */
export interface GuildPrivateThreadChannel extends GuildThreadChannelBase {
    /** Always ChannelType.PrivateThread */
    readonly type: typeof ChannelType.PrivateThread
    /** Whether members who cannot manage threads may add other such members */
    readonly invitable: boolean
}

/** A thread: A channel inside a text, announcement, forum or media channel that holds its own messages.
 * Compare type with ChannelType constants to narrow to one thread shape, or use isThreadChannel to tell threads from
 * other community channels. The object is frozen and does not update when the thread changes
 *
 * @category Channels
 */
export type GuildThreadChannel = GuildAnnouncementThreadChannel | GuildPublicThreadChannel | GuildPrivateThreadChannel

/** A tag that posts in a forum or media channel can carry
 *
 * @category Channels
 */
export interface ForumTag {
    /** Decimal tag ID */
    readonly id: string
    /** Tag name, unique within its channel */
    readonly name: string
    /** Whether only members who can manage threads may apply or remove the tag */
    readonly moderated: boolean
    /** Decimal ID of a custom emoji of this community, or null when the tag has none */
    readonly emojiId: string | null
    /** A Unicode emoji, or null when the tag has none. At most one of emojiId and emojiName is set */
    readonly emojiName: string | null
}

/** The reaction that clients show on each post of a forum or media channel
 *
 * @category Channels
 */
export interface ForumDefaultReaction {
    /** Decimal ID of a custom emoji of this community, or null for a Unicode emoji */
    readonly emojiId: string | null
    /** A Unicode emoji, or null for a custom emoji */
    readonly emojiName: string | null
}

/** Fields shared by forum and media channels, which hold posts and no messages of their own.
 * Fluxer leaves the post settings out of some payloads, such as the guildChannelDelete event, so each of them is
 * optional and absence means unavailable rather than a default
 *
 * @category Channels
 */
export interface GuildForumChannelBase extends GuildChannelBase {
    /** Forum or media channel type. Each received shape has its own literal discriminant */
    readonly type: typeof ChannelType.Forum | typeof ChannelType.Media
    /** Posting guidelines, with null meaning none */
    readonly topic?: string | null
    /** ID of the newest post, with null meaning the channel never had one */
    readonly lastMessageId?: string | null
    /** Delay in seconds between one member's new posts */
    readonly rateLimitPerUser?: number
    /** Channel flags, such as ChannelFlags.RequireTag. Unrecognized bits are kept */
    readonly flags?: number
    /** Tags that posts can carry, at most 20 */
    readonly availableTags?: readonly ForumTag[]
    /** Reaction that clients show on each post, with null meaning none */
    readonly defaultReactionEmoji?: ForumDefaultReaction | null
    /** Default post order, such as ForumSortOrder.LatestActivity, with null meaning none is set */
    readonly defaultSortOrder?: number | null
    /** Default tag matching of a post search, "match_some" or "match_all". Another string Fluxer adds later is kept */
    readonly defaultTagSetting?: string
    /** Stored default auto-archive period for posts, in minutes, with null meaning none is set. Fluxer does not apply
     * it to a new post
     */
    readonly defaultAutoArchiveMinutes?: number | null
    /** Slowmode delay in seconds that a new post copies when its creation sets none */
    readonly defaultThreadRateLimitPerUser?: number
}

/**
 * A forum channel, selected by `type === ChannelType.Forum`
 *
 * @category Channels
 */
export interface GuildForumChannel extends GuildForumChannelBase {
    /** Always ChannelType.Forum */
    readonly type: typeof ChannelType.Forum
    /** Default post layout, such as ForumLayout.List */
    readonly defaultForumLayout?: number
}

/**
 * A media channel, a forum channel that can hide media download options, selected by `type === ChannelType.Media`
 *
 * @category Channels
 */
export interface GuildMediaChannel extends GuildForumChannelBase {
    /** Always ChannelType.Media */
    readonly type: typeof ChannelType.Media
}

/**
 * Whether a community channel is a thread of any type. Any other value, including undefined, returns false
 * @example
 * ```ts
 * import { isThreadChannel, type GuildChannel } from "@neontechspace/fluxerly"
 * export function parentOf(channel: GuildChannel) {
 *     return isThreadChannel(channel) ? channel.parentId : undefined
 * }
 * ```
 *
 * @category Channels
 */
export function isThreadChannel(channel: GuildChannel | undefined): channel is GuildThreadChannel {
    if (typeof channel !== "object" || channel === null) return false
    const type: unknown = channel.type
    return (
        type === ChannelType.AnnouncementThread ||
        type === ChannelType.PublicThread ||
        type === ChannelType.PrivateThread
    )
}

/**
 * A community channel of a type this SDK version does not know, such as a type Fluxer adds later, selected by
 * `type === "unknown"`. No ChannelType constant equals "unknown", so a ChannelType comparison always excludes this
 * shape, and rawType keeps the number Fluxer sent. The common optional fields of text, voice and link channels stay
 * readable, so the channel remains usable without a type-specific shape. A later SDK version that knows the type
 * returns the matching shape instead
 *
 * @category Channels
 */
export interface GuildUnknownChannel
    extends
        GuildChannelBase,
        Omit<GuildTextChannelBase, "type" | "defaultAutoArchiveMinutes" | "defaultThreadRateLimitPerUser">,
        Omit<GuildVoiceChannel, "type">,
        Omit<GuildLinkChannel, "type"> {
    /** Always "unknown" */
    readonly type: "unknown"
    /** Numeric channel type Fluxer sent, outside the known ChannelType constants */
    readonly rawType: number
}

/** Settings and identity of a community channel returned by a read or gateway event, as one shape per channel type.
 * Compare `type` with ChannelType constants to narrow to exactly one shape, such as `channel.type === ChannelType.Voice`
 * before reading `bitrate`. Threads, forum channels and media channels have their own shapes, and isThreadChannel
 * selects every thread type at once. A type this SDK version does not know is a GuildUnknownChannel with type
 * "unknown", its Fluxer number in rawType and the common optional text, voice and link fields, so a switch on type
 * that also handles "unknown" is exhaustive. The object is frozen and does not update when the channel changes.
 * Optional fields may be unavailable rather than set to their creation defaults. This excludes private conversations,
 * which use DirectMessageChannel
 *
 * @category Channels
 */
export type GuildChannel =
    | GuildTextChannel
    | GuildAnnouncementChannel
    | GuildVoiceChannel
    | GuildCategoryChannel
    | GuildAnnouncementThreadChannel
    | GuildPublicThreadChannel
    | GuildPrivateThreadChannel
    | GuildForumChannel
    | GuildMediaChannel
    | GuildLinkChannel
    | GuildUnknownChannel

/** Settings shared by new text, announcement, voice, category and link channels.
 * Supply the matching ChannelCreate type. Fluxer decides which settings apply to that channel type and
 * enforces permissions. Omitted permissionOverwrites inherit from the parent category, while [] requests none.
 * Unknown input keys fail locally. The encoded request body must fit within 4,194,304 bytes
 *
 * @category Channels
 */
export interface ChannelCreateBase {
    /** Channel name. Raw input may contain at most 10,000 UTF-16 code units. For validation, Fluxer's general-name
     * rules remove U+000C and U+202E, trim surrounding whitespace, strip provider-defined invisible characters,
     * normalize whitespace and collapse its runs, then require 1–100 UTF-16 code units. The SDK sends the original
     * string without lowercasing or hyphenating it
     */
    readonly name: string
    /** Description shown for the channel, 1–1,024 UTF-16 code units after U+000C and U+202E removal and
     * surrounding-whitespace trimming, or null to clear. The original string is sent unchanged
     */
    readonly topic?: string | null
    /** Absolute URL for a link channel, or null to clear. The SDK does not open or fetch the URL */
    readonly url?: string | null
    /** Parent category, with null or omission creating a top-level channel */
    readonly parentId?: string | null
    /** Voice audio bitrate in bits per second, integer 8,000–384,000 or null, default 64,000 for voice channels.
     * Fluxer clamps the requested value to the community's enabled bitrate tier. Read the returned channel for the applied value
     */
    readonly bitrate?: number | null
    /** Maximum voice users from 0 through 99, with 0 unlimited and the voice default */
    readonly userLimit?: number | null
    /** Voice connections per user from 1 through 100, default 5 for voice channels */
    readonly voiceConnectionLimit?: number | null
    /** Explicit overrides, omitted to inherit a parent category and [] to create no overrides */
    readonly permissionOverwrites?: readonly PermissionOverwrite[]
    /** Adult-content setting using Fluxer's older NSFW field. True marks the channel adult-only, while false inherits
     * the parent category or community setting like omission. Use nsfwOverride false to mark it not adult-only.
     * When both are present, nsfwOverride wins
     */
    readonly nsfw?: boolean
    /** Explicit adult-content override, with null inheriting */
    readonly nsfwOverride?: boolean | null
    /** 0 inherits the content-warning level, 1 requests a channel content warning */
    readonly contentWarningLevel?: number
    /** Warning shown before viewing content, with 0–200 raw UTF-16 code units and null inheriting.
     * No text normalization is applied before validation
     */
    readonly contentWarningText?: string | null
    /** Delay between a user's messages in seconds, integer 0–21,600 or null. Zero disables slowmode */
    readonly rateLimitPerUser?: number | null
}

/**
 * Default settings for the threads that start inside a text, announcement, forum or media channel.
 * Where threads are not active for a community (GuildListSummary.threadsActive is false), Fluxer ignores both settings
 * on a text or announcement channel
 *
 * @category Channels
 */
export interface ThreadParentDefaults {
    /** Auto-archive period in minutes that the channel stores for its threads: One of the ThreadAutoArchiveMinutes values,
     * or null to clear it. Fluxer stores the value but does not apply it to a new thread, which uses
     * ThreadAutoArchiveMinutes.ThreeDays unless its creation sets another period
     */
    readonly defaultAutoArchiveMinutes?: number | null
    /** Slowmode delay in seconds that a new thread in this channel copies when its creation sets none, an integer
     * from 0 through 21,600, or null to clear it
     */
    readonly defaultThreadRateLimitPerUser?: number | null
}

/**
 * Creates a text channel
 *
 * @category Channels
 */
export interface TextChannelCreate extends ChannelCreateBase, ThreadParentDefaults {
    /** Text channel type */
    readonly type: typeof ChannelType.Text
}

/**
 * Creates an announcement channel with the same settings as a text channel
 *
 * @category Channels
 */
export interface AnnouncementChannelCreate extends ChannelCreateBase, ThreadParentDefaults {
    /** Announcement channel type */
    readonly type: typeof ChannelType.Announcement
}

/**
 * Creates a voice channel
 *
 * @category Channels
 */
export interface VoiceChannelCreate extends ChannelCreateBase {
    /** Voice channel type */
    readonly type: typeof ChannelType.Voice
}

/**
 * Create a category to group community channels
 *
 * @category Channels
 */
export interface CategoryChannelCreate extends ChannelCreateBase {
    /** Category channel type */
    readonly type: typeof ChannelType.Category
}

/**
 * Create a community channel that points readers to a URL
 *
 * @category Channels
 */
export interface LinkChannelCreate extends ChannelCreateBase {
    /** Link channel type */
    readonly type: typeof ChannelType.Link
}

/** Settings of one tag that posts in a forum or media channel can carry.
 * Fluxer rejects a name that another tag of the channel already uses. A received ForumTag is also valid input
 *
 * @category Channels
 */
export interface ForumTagInput {
    /** Decimal ID of an existing tag, which only an entry of a channel edit's availableTags uses: The entry keeps
     * that tag and replaces its settings, while an entry without an ID adds a tag. Fluxer rejects an ID that the
     * channel does not have, and an ID that appears twice in the list.
     * A new channel has no tags, so its availableTags fail locally with an ID. The single-tag operations never send
     * an ID, so createForumTag ignores one, and editForumTag fails locally unless it equals the tagId argument
     */
    readonly id?: string
    /** Tag name, 1–50 UTF-16 code units after U+000C and U+202E removal and surrounding-whitespace trimming.
     * The original string is sent unchanged
     */
    readonly name: string
    /** Whether only members who can manage threads may apply or remove the tag. Omission means false */
    readonly moderated?: boolean
    /** Decimal ID of a custom emoji of this community, or null for none. Fluxer rejects an emoji that the community
     * does not have. Set at most one of emojiId and emojiName
     */
    readonly emojiId?: string | null
    /** A single Unicode emoji, or null for none, up to 64 UTF-16 code units. Fluxer rejects other text.
     * Set at most one of emojiId and emojiName
     */
    readonly emojiName?: string | null
}

/** The reaction that clients show on each post of a forum or media channel.
 * Set at most one of emojiId and emojiName. A received ForumDefaultReaction is also valid input
 *
 * @category Channels
 */
export interface ForumDefaultReactionInput {
    /** Decimal ID of a custom emoji of this community, or null. Fluxer rejects an emoji that the community does not have */
    readonly emojiId?: string | null
    /** A single Unicode emoji, or null, up to 64 UTF-16 code units. Fluxer rejects other text */
    readonly emojiName?: string | null
}

/**
 * Settings shared by new forum and media channels. Supply ForumChannelCreate or MediaChannelCreate.
 * The tags, default reaction, sort order, tag setting and flags are the same as the matching ChannelEdit fields.
 * Fluxer rejects creating a forum or media channel in a community where threads are not active
 * (GuildListSummary.threadsActive is false)
 *
 * @category Channels
 */
export interface ForumChannelCreateBase extends ChannelCreateBase, ThreadParentDefaults {
    /** Posting guidelines, 1–4,096 UTF-16 code units after U+000C and U+202E removal and surrounding-whitespace
     * trimming, or null for none. The original string is sent unchanged
     */
    readonly topic?: string | null
    /** Tags that posts can carry, at most 20. Fluxer rejects two tags with the same name. Omission creates none */
    readonly availableTags?: readonly ForumTagInput[]
    /** Reaction that clients show on each post, or null for none */
    readonly defaultReactionEmoji?: ForumDefaultReactionInput | null
    /** Default post order, a ForumSortOrder value, or null for none */
    readonly defaultSortOrder?: number | null
    /** How a post search matches several tags by default: "match_some" finds posts with any of them and
     * "match_all" only posts with all of them. Null and omission leave "match_some"
     */
    readonly defaultTagSetting?: "match_some" | "match_all" | null
    /** Channel flags. Supply ChannelFlags.RequireTag to make every new post carry a tag, which needs at least one tag
     * that is not moderated. On a media channel, add ChannelFlags.HideMediaDownloadOptions to hide the download options.
     * Any other bit fails locally
     */
    readonly flags?: number
}

/**
 * Creates a forum channel, which holds posts instead of messages
 *
 * @category Channels
 */
export interface ForumChannelCreate extends ForumChannelCreateBase {
    /** Forum channel type */
    readonly type: typeof ChannelType.Forum
    /** Default post layout, a ForumLayout value. Null sets ForumLayout.Default */
    readonly defaultForumLayout?: number | null
}

/**
 * Creates a media channel, a forum channel that can hide media download options. It has no layout setting
 *
 * @category Channels
 */
export interface MediaChannelCreate extends ForumChannelCreateBase {
    /** Media channel type */
    readonly type: typeof ChannelType.Media
}

/**
 * One supported community-channel creation request, with Fluxer positioning a new channel itself
 *
 * @category Channels
 */
export type ChannelCreate =
    | TextChannelCreate
    | AnnouncementChannelCreate
    | VoiceChannelCreate
    | CategoryChannelCreate
    | LinkChannelCreate
    | ForumChannelCreate
    | MediaChannelCreate

/** Change an existing community channel's settings without replacing the channel.
 * Omitted fields stay unchanged. The permissionOverwrites list replaces the whole explicit list, so include entries that
 * must stay. Use channels.reorder to move a channel between categories or change its order. Unknown keys and an empty patch fail locally.
 * Fluxer checks channel-type compatibility and permissions after local validation
 *
 * @category Channels
 */
export interface ChannelEdit {
    /** Convert between Text (0) and Announcement (5), alone or with other settings. Omission preserves the type.
     * Other values fail locally. Fluxer requires ManageChannels and rejects converting a text channel that receives
     * follows with CHANNEL_HAS_FOLLOWED_CHANNELS. Converting Announcement to Text queues asynchronous follower removal.
     * Fluxer emits a complete Channel Update with the new type, replacing any cached observation before handlers run.
     * The edit does not await that event or follower removal
     * @see https://github.com/fluxerapp/fluxer/blob/597116a0b4bf3a212789bdebe7f284babc33b445/fluxer_api/src/api/channel/services/channel_data/ChannelOperationsService.ts
     */
    readonly type?: typeof ChannelType.Text | typeof ChannelType.Announcement
    /** Channel name. Raw input may contain at most 10,000 UTF-16 code units. For validation, Fluxer's general-name
     * rules remove U+000C and U+202E, trim surrounding whitespace, strip provider-defined invisible characters,
     * normalize whitespace and collapse its runs, then require 1–100 UTF-16 code units. The SDK sends the original
     * string without lowercasing or hyphenating it
     */
    readonly name?: string
    /** Channel description, 1–1,024 UTF-16 code units after U+000C and U+202E removal and
     * surrounding-whitespace trimming, or null to clear. A forum or media channel allows up to 4,096 code units,
     * which Fluxer checks against the channel's type. The original string is sent unchanged
     */
    readonly topic?: string | null
    /** Absolute link-channel URL, or null to clear. No URL is fetched by this request */
    readonly url?: string | null
    /** Voice bitrate in bits per second, integer 8,000–384,000, or null.
     * Fluxer clamps the requested value to the community's enabled bitrate tier. Read the returned channel for the applied value
     */
    readonly bitrate?: number | null
    /** Maximum voice users, integer 0–99, or null. Zero requests unlimited users */
    readonly userLimit?: number | null
    /** Maximum simultaneous voice connections per user, integer 1–100, or null */
    readonly voiceConnectionLimit?: number | null
    /** Adult-content setting using Fluxer's older NSFW field. True marks the channel adult-only, while false and null
     * restore inheritance from the parent category or community. Use nsfwOverride false to mark it not adult-only.
     * When both are present, nsfwOverride wins
     */
    readonly nsfw?: boolean | null
    /** Explicit adult-content override, with null inheriting */
    readonly nsfwOverride?: boolean | null
    /** 0 inherits the content-warning level, 1 requests a channel content warning */
    readonly contentWarningLevel?: number
    /** Warning text with 0–200 raw UTF-16 code units, with null inheriting.
     * No text normalization is applied before validation
     */
    readonly contentWarningText?: string | null
    /** Delay between a user's messages in seconds, integer 0–21,600, or null. Zero disables slowmode */
    readonly rateLimitPerUser?: number | null
    /** Replace all explicit overwrites, with [] clearing them and omission preserving them */
    readonly permissionOverwrites?: readonly PermissionOverwrite[]
    /** Voice region ID of 1–64 UTF-16 code units after U+000C and U+202E removal and surrounding-whitespace
     * trimming, with null selecting automatic routing. The original string is sent unchanged
     */
    readonly rtcRegion?: string | null
    /** Auto-archive period in minutes that a text, announcement, forum or media channel stores for its threads: One of
     * the ThreadAutoArchiveMinutes values, or null to clear it. Fluxer stores the value but does not apply it to a
     * new thread. Fluxer ignores it for another channel type, and on a text or announcement channel in a community
     * where threads are not active
     */
    readonly defaultAutoArchiveMinutes?: number | null
    /** Slowmode delay in seconds that a new thread in a text, announcement, forum or media channel copies when its
     * creation sets none, an integer from 0 through 21,600, or null to clear it. Fluxer ignores it for another channel
     * type, and on a text or announcement channel in a community where threads are not active
     */
    readonly defaultThreadRateLimitPerUser?: number | null
    /** Replace the complete tag list of a forum or media channel, at most 20 tags. Fluxer rejects two tags with the
     * same name. Entries with an id keep that tag, entries without one add a tag, and a tag left out is deleted.
     * Use channels.createForumTag, editForumTag and deleteForumTag to change one tag without sending the list.
     * Fluxer ignores this setting for another channel type
     */
    readonly availableTags?: readonly ForumTagInput[]
    /** Reaction that clients show on each post of a forum or media channel, or null for none. Fluxer ignores it for
     * another channel type
     */
    readonly defaultReactionEmoji?: ForumDefaultReactionInput | null
    /** Default post order of a forum or media channel, a ForumSortOrder value, or null for none. Fluxer ignores it for
     * another channel type
     */
    readonly defaultSortOrder?: number | null
    /** Default post layout of a forum channel, a ForumLayout value. Null sets ForumLayout.Default. Fluxer ignores it
     * for a media channel and for another channel type
     */
    readonly defaultForumLayout?: number | null
    /** How a post search of a forum or media channel matches several tags by default: "match_some" finds posts with any
     * of them and "match_all" only posts with all of them. Null sets "match_some". Fluxer ignores it for another
     * channel type
     */
    readonly defaultTagSetting?: "match_some" | "match_all" | null
    /** Flags of a forum or media channel, replacing all of them: Include ChannelFlags.RequireTag to keep it required.
     * RequireTag needs at least one tag that is not moderated, and ChannelFlags.HideMediaDownloadOptions is valid on a
     * media channel only. Fluxer checks both against the channel, and any other bit fails locally.
     * Fluxer ignores this setting for another channel type
     */
    readonly flags?: number
}

/** Move or reorder one community channel with channels.reorder.
 * Channels left out of the request are not explicit targets. Fluxer applies entries in order, so the requested position
 * may not be the final position if another change happens at the same time
 *
 * @category Channels
 */
export interface ChannelPosition {
    /** Decimal channel ID */
    readonly id: string
    /** Nonnegative requested sibling position */
    readonly position?: number
    /** New parent category, with null moving to the top level and omission preserving the parent */
    readonly parentId?: string | null
    /** Sibling directly preceding this channel, with null placing it first */
    readonly precedingSiblingId?: string | null
    /** Copy destination overwrites only when moving into a new category, default false and no sync for the same parent */
    readonly syncPermissionsOnMove?: boolean
}

/**
 * Visible channel updates delivered together, not a complete community channel list
 *
 * @category Events and collectors
 */
export interface GuildChannelUpdateBulk {
    /** Decimal community ID */
    readonly guildId: string
    /** Frozen channel snapshots delivered in this dispatch */
    readonly channels: readonly GuildChannel[]
}

/** Subscribe a text channel to messages published from an announcement channel.
 * Fluxer validates the source, target and permissions without an SDK prefetch
 *
 * @category Channels
 */
export interface ChannelFollowInput {
    /** Decimal ID of the receiving community text channel, whose type must be ChannelType.Text */
    readonly targetChannelId: string
}

/** A confirmed announcement-channel follow, returned as a frozen value.
 * Delete webhookId through client.webhooks.delete to stop following
 *
 * @category Channels
 */
export interface FollowedChannel {
    /** Decimal ID of the followed announcement channel, not the receiving channel */
    readonly channelId: string
    /** Decimal ID of the channel-follower webhook created in the receiving channel */
    readonly webhookId: string
}

/** A frozen count of channels and communities following one announcement channel.
 * Fluxer can cache these counts for up to 60 seconds. They are not live subscriptions
 *
 * @category Channels
 */
export interface ChannelFollowerStats {
    /** Number of following channels */
    readonly channelCount: number
    /** Number of distinct communities containing following channels */
    readonly guildCount: number
}

/**
 * Settings shared by remote community-channel operations
 *
 * @category Options
 */
export interface ChannelOperationOptions {
    /** Total milliseconds across local queueing, rate waits, retries and HTTP, integer 1–2,147,483,647, default the client's rest.defaultTimeoutMs, 30,000 unless configured.
     * Owned cleanup is awaited afterward, so the call can finish later than this deadline
     */
    readonly timeoutMs?: number
}

/**
 * Default API calls start immediately, with abort cancelling only this call and awaiting owned cleanup
 *
 * @category Options
 */
export interface DefaultChannelOperationOptions extends ChannelOperationOptions, OperationOptions {}

/**
 * Settings for a channel mutation whose provider handler consumes an audit-log reason
 *
 * @category Options
 */
export interface ChannelAuditOperationOptions extends ChannelOperationOptions {
    /** Optional audit-log reason, 1–512 printable ASCII characters after trimming.
     * Sent as a raw header because Fluxer does not decode URL escapes. Non-ASCII and control characters fail before dispatch.
     * Omission sends no header. Never included in SDK errors or diagnostics.
     * Header delivery does not guarantee provider retention. Fluxer's channel-reorder path currently does not persist it in an audit entry
     */
    readonly auditReason?: string
}

/**
 * Default API audited channel mutations start immediately. Abort cannot roll back a dispatched mutation
 *
 * @category Options
 */
export interface DefaultChannelAuditOperationOptions extends ChannelAuditOperationOptions, OperationOptions {}

/**
 * The channel or thread action named in an expected failure or SdkDefect
 *
 * @category Errors
 */
export type ChannelOperation =
    | "channels.get"
    | "channels.fetch"
    | "channels.fetchAll"
    | "channels.follow"
    | "channels.fetchFollowerStats"
    | "channels.create"
    | "channels.edit"
    | "channels.delete"
    | "channels.reorder"
    | "channels.setPermissionOverwrite"
    | "channels.removePermissionOverwrite"
    | "channels.createForumTag"
    | "channels.editForumTag"
    | "channels.deleteForumTag"
    | "threads.create"
    | "threads.createFromMessage"
    | "threads.createPost"
    | "threads.edit"
    | "threads.fetchActive"
    | "threads.fetchArchived"
    | "threads.search"
    | "threads.join"
    | "threads.leave"
    | "threads.addMember"
    | "threads.removeMember"
    | "threads.fetchMember"
    | "threads.fetchMembers"

/** Expected failure when reading or changing community channels, threads and forum tags.
 * Check reason to identify the failure. Check outcome before retrying a change because an uncertain write may have happened.
 * The error contains no token, private input value or server response body. The default API returns it in an Err.
 * The Effect API fails with it in its typed error channel.
 * A missing-permission rejection lists the permissions that the operation needs in details.requiredPermissions when
 * the SDK knows them, as ApiErrorDetail describes
 *
 * @category Errors
 */
export class ChannelOperationError extends FluxerlyError {
    /** Stable expected-failure discriminator */
    readonly _tag = "ChannelOperationError"
    /** Requested operation */
    readonly operation: ChannelOperation
    /** Failure category, described by {@link OperationReason} */
    readonly reason: OperationReason
    /** Whether the request may have reached Fluxer, described by {@link OperationOutcome} */
    readonly outcome: OperationOutcome
    /** HTTP status when available, otherwise null */
    readonly status: number | null
    /** Usable server-required retry wait in milliseconds, otherwise null */
    readonly retryAfterMs: number | null
    /** Safe classification of why Fluxer rejected the request, or null when the response could not be classified */
    readonly apiError: ApiErrorDetail | null
    /** Safe explanation of the locally invalid property, or null when no input problem could be identified */
    readonly inputValidation: InputValidationDetail | null
    /** Create the failure from its operation, reason and outcome, with optional status, retry wait, API detail, input detail and cause */
    constructor(options: OperationErrorOptions<ChannelOperation>) {
        const fields = operationErrorFields(options)
        super(operationErrorText("Channel", fields), operationErrorSettings("channel", fields, options.cause))
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
 * Native interruption is outside this union, with default API methods additionally returning CancelledError
 *
 * @category Errors
 */
export type ChannelOperationFailure = ChannelOperationError | ClientClosedError
