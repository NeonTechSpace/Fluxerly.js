import type { ChannelType, GuildPublicThreadChannel, GuildThreadChannel } from "./channels.js"
import type { Message, MessageBody, MessageCore, MessageInput } from "./messages.js"
import type { UserIterationQuery } from "./pagination.js"

/** Settings for a new thread in a text or announcement channel, created with threads.create.
 * Use threads.createFromMessage to start a thread on an existing message, and threads.createPost in a forum or media
 * channel. Unknown keys fail locally
 *
 * @category Channels
 */
export interface ThreadCreate {
    /** Thread name, 1–100 UTF-16 code units after U+000C and U+202E removal and surrounding-whitespace trimming.
     * The original string is sent unchanged
     */
    readonly name: string
    /** Thread type, default ChannelType.PublicThread. A private thread is possible only in a text channel. In an
     * announcement channel Fluxer creates an announcement thread for PublicThread or AnnouncementThread, and rejects
     * AnnouncementThread in a text channel
     */
    readonly type?:
        typeof ChannelType.PublicThread | typeof ChannelType.PrivateThread | typeof ChannelType.AnnouncementThread
    /** Inactivity period in minutes after which Fluxer archives the thread, one of the ThreadAutoArchiveMinutes values,
     * default ThreadAutoArchiveMinutes.ThreeDays
     */
    readonly autoArchiveMinutes?: number
    /** Slowmode delay in seconds, an integer from 0 through 21,600. Omission copies the parent channel's
     * defaultThreadRateLimitPerUser
     */
    readonly rateLimitPerUser?: number
    /** Whether members who cannot manage threads may add other such members, default true. Accepted only with type
     * ChannelType.PrivateThread
     */
    readonly invitable?: boolean
}

/** Settings for a public thread started on an existing message with threads.createFromMessage.
 * The thread takes the message's ID, and a message can start only one thread. Unknown keys fail locally
 *
 * @category Channels
 */
export interface ThreadFromMessageCreate {
    /** Thread name, 1–100 UTF-16 code units after U+000C and U+202E removal and surrounding-whitespace trimming.
     * The original string is sent unchanged
     */
    readonly name: string
    /** Inactivity period in minutes after which Fluxer archives the thread, one of the ThreadAutoArchiveMinutes values,
     * default ThreadAutoArchiveMinutes.ThreeDays
     */
    readonly autoArchiveMinutes?: number
    /** Slowmode delay in seconds, an integer from 0 through 21,600. Omission copies the parent channel's
     * defaultThreadRateLimitPerUser
     */
    readonly rateLimitPerUser?: number
}

/** The first message of a forum or media post: The content, embeds, files and stickers of messages.send, with
 * allowedMentions and flags. A post's first message cannot reply to another message, and has no nonce or
 * text-to-speech setting
 *
 * @category Channels
 */
export type ForumPostMessage = MessageBody & Pick<MessageInput, "allowedMentions" | "flags">

/** A new post in a forum or media channel, created with threads.createPost. Each post is a public thread with its own
 * first message. Unknown keys fail locally
 *
 * @category Channels
 */
export interface ForumPostCreate {
    /** Post name, 1–100 UTF-16 code units after U+000C and U+202E removal and surrounding-whitespace trimming.
     * The original string is sent unchanged
     */
    readonly name: string
    /** The post's first message. Its files are uploaded in the same request as multipart form data */
    readonly message: ForumPostMessage
    /** IDs of the channel's forum tags to apply, at most 5 decimal strings. A channel with ChannelFlags.RequireTag
     * needs at least one, and a moderated tag needs Manage Threads
     */
    readonly appliedTagIds?: readonly string[]
    /** Inactivity period in minutes after which Fluxer archives the post, one of the ThreadAutoArchiveMinutes values,
     * default ThreadAutoArchiveMinutes.ThreeDays
     */
    readonly autoArchiveMinutes?: number
    /** Slowmode delay in seconds, an integer from 0 through 21,600. Omission copies the channel's
     * defaultThreadRateLimitPerUser
     */
    readonly rateLimitPerUser?: number
}

/** A post created with threads.createPost: Its thread and its first message, both frozen
 *
 * @category Channels
 */
export interface ForumPost<M extends MessageCore = Message> {
    /** The post, a public thread whose parentId is the forum or media channel */
    readonly thread: GuildPublicThreadChannel
    /** The post's first message, in the thread, using the client's messageFields selection */
    readonly message: M
}

/** Change an existing thread or post with threads.edit. Omitted fields stay unchanged, and an empty input or an
 * unknown key fails locally. Fluxer lets the thread's creator rename it, archive it, lock it and change
 * autoArchiveMinutes, invitable and appliedTagIds, while unlocking, rateLimitPerUser, pinned and moderated tags need
 * Manage Threads. In a locked thread every change needs Manage Threads, and an archived thread accepts only a change
 * that also sets archived to false
 *
 * @category Channels
 */
export interface ThreadEdit {
    /** Thread name, 1–100 UTF-16 code units after U+000C and U+202E removal and surrounding-whitespace trimming.
     * The original string is sent unchanged
     */
    readonly name?: string
    /** Archive the thread with true, or unarchive it with false */
    readonly archived?: boolean
    /** Whether only members who can manage threads may act in the thread */
    readonly locked?: boolean
    /** Inactivity period in minutes after which Fluxer archives the thread, one of the ThreadAutoArchiveMinutes values.
     * A change restarts the period at archiveTimestamp
     */
    readonly autoArchiveMinutes?: number
    /** Slowmode delay in seconds, an integer from 0 through 21,600. Zero disables slowmode */
    readonly rateLimitPerUser?: number
    /** Whether members who cannot manage threads may add other such members. Fluxer ignores it on threads that are not
     * private
     */
    readonly invitable?: boolean
    /** Pin a forum or media post with true, or unpin it with false, by setting ChannelFlags.Pinned. A channel holds at
     * most one pinned post. Fluxer rejects true on any other thread
     */
    readonly pinned?: boolean
    /** Replace the tags of a forum or media post with these tag IDs, at most 5 decimal strings, with [] removing every
     * tag. Fluxer rejects it on a public thread in a text channel and ignores it on private and announcement threads
     */
    readonly appliedTagIds?: readonly string[]
}

/** Which archived threads threads.fetchArchived lists: Public threads, private threads, or only the private threads
 * the bot joined
 *
 * @category Channels
 */
export type ArchivedThreadScope = "public" | "private" | "joinedPrivate"

/** Select one page of archived threads of a channel. Unknown keys fail locally
 *
 * @category Channels
 */
export interface ArchivedThreadQuery {
    /** Threads to list, default "public". The scopes "private" and "joinedPrivate" work only in a text channel, and
     * "private" needs Manage Threads
     */
    readonly scope?: ArchivedThreadScope
    /** Start before this cursor, excluding it. For "public" and "private" it is an ISO 8601 timestamp with a timezone,
     * compared with the archive time. For "joinedPrivate" it is a decimal thread ID. Omit it for the first page
     */
    readonly before?: string
    /** Maximum threads in the page, an integer from 2 through 100, default 50 */
    readonly limit?: number
}

/** One frozen page of archived threads. Each thread the bot joined has membership set
 *
 * @category Channels
 */
export interface ArchivedThreadPage {
    /** Archived threads in the order Fluxer listed them */
    readonly threads: readonly GuildThreadChannel[]
    /** Whether Fluxer may have more threads after this page. Pass the last thread's archiveTimestamp, or its ID for
     * "joinedPrivate", as before to read the next page
     */
    readonly hasMore: boolean
}

/** Filters and paging for one threads.search request in a text, announcement, forum or media channel.
 * Fluxer searches an index that can lag behind recent changes. The bot sees public threads, private threads it joined
 * and, with Manage Threads, every private thread. Unknown keys and invalid values fail locally
 *
 * @category Channels
 */
export interface ThreadSearchQuery {
    /** Text to look for in thread names, at most 100 UTF-16 code units. Omit it to match every name */
    readonly name?: string
    /** Forum tag IDs to filter by, at most 20 decimal strings. A tag the channel no longer has matches no thread */
    readonly tagIds?: readonly string[]
    /** How tagIds match: "match_some" for any tag, "match_all" for every tag. Defaults to the channel's
     * defaultTagSetting, otherwise "match_some"
     */
    readonly tagSetting?: "match_some" | "match_all"
    /** True for only archived threads, false for only active threads. Omit it for both */
    readonly archived?: boolean
    /** Result order, default "last_message_time" */
    readonly sortBy?: "last_message_time" | "archive_time" | "relevance" | "creation_time"
    /** Ascending or descending result order, default "desc" */
    readonly sortOrder?: "asc" | "desc"
    /** Maximum threads in the page, an integer from 1 through 25, default 25 */
    readonly limit?: number
    /** Matching threads to skip, an integer from 0 through 9,975, default 0 */
    readonly offset?: number
    /** Include only thread IDs smaller than this decimal ID */
    readonly maxId?: string
    /** Include only thread IDs greater than this decimal ID */
    readonly minId?: string
}

/** Successful search response while Fluxer still builds the community's search index. Fluxer answers HTTP 202 and starts
 * building it. Retry later with another explicit search, which the SDK never sends by itself
 *
 * @category Channels
 */
export interface ThreadSearchIndexingPage {
    /** True distinguishes this response from a ThreadSearchResultsPage */
    readonly indexing: true
}

/** Search results once Fluxer's index can answer. The page and its threads and messages are frozen
 *
 * @category Channels
 */
export interface ThreadSearchResultsPage<M extends MessageCore = Message> {
    /** False distinguishes this response from an indexing response */
    readonly indexing: false
    /** Matching threads in result order. Each thread the bot joined has membership set */
    readonly threads: readonly GuildThreadChannel[]
    /** The first message of each returned post in a forum or media channel, using the client's messageFields selection.
     * Its channelId is the post's ID, and a post whose first message is gone has none. Empty in other channels
     */
    readonly firstMessages: readonly M[]
    /** Number of matching threads Fluxer reported with this response, which can change between requests */
    readonly total: number
    /** Whether more matching threads follow this page, read by raising offset */
    readonly hasMore: boolean
}

/** Successful outcome of one threads.search request. Check indexing before reading results
 *
 * @category Channels
 */
export type ThreadSearchPage<M extends MessageCore = Message> = ThreadSearchIndexingPage | ThreadSearchResultsPage<M>

/** Options for reading one thread member with threads.fetchMember. Unknown keys fail locally
 *
 * @category Channels
 */
export interface ThreadMemberQuery {
    /** Also read the user's community membership into ThreadMember.member, default false. The member is decoded with the
     * thread's community, which the SDK takes from the channel cache when the thread is cached there and otherwise reads
     * with one extra channel request inside the same deadline
     */
    readonly withMember?: boolean
}

/** Select one page of thread members, in ascending user ID order. Unknown keys fail locally
 *
 * @category Channels
 */
export interface ThreadMemberPageQuery extends ThreadMemberQuery {
    /** Start with decimal user IDs greater than this ID, excluding it. Omit it for the first page */
    readonly after?: string
    /** Maximum members in the page, an integer from 1 through 100, default 100 */
    readonly limit?: number
}

/** Limits and starting point for threads.iterateMembers, reading thread members in ascending user ID order.
 * The pageSize option defaults to 100 with a range of 1 through 100
 *
 * @category Channels
 */
export interface ThreadMemberIterationQuery extends UserIterationQuery {
    /** Also read each user's community membership into ThreadMember.member, default false. The thread's community is
     * resolved once per consumption, from the channel cache or with one extra channel request on the first page
     */
    readonly withMember?: boolean
}
