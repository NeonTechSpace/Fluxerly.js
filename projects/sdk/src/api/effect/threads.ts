import type * as Effect from "effect/Effect"
import type * as Stream from "effect/Stream"
import type {
    GuildThreadChannel,
    ThreadMember,
    ChannelOperationFailure,
    ChannelOperationOptions,
    ChannelAuditOperationOptions,
} from "#sdk/channels"
import type { Message, MessageCore, MessageReference } from "#sdk/messages"
import type { PaginationError } from "#sdk/pagination"
import type {
    ArchivedThreadPage,
    ArchivedThreadQuery,
    ForumPost,
    ForumPostCreate,
    ThreadCreate,
    ThreadEdit,
    ThreadFromMessageCreate,
    ThreadMemberIterationQuery,
    ThreadMemberPageQuery,
    ThreadMemberQuery,
    ThreadSearchPage,
    ThreadSearchQuery,
} from "#sdk/threads"

/** Create threads and forum posts, change, list and search threads, and manage thread members.
 * HTTP methods return Effects and do not connect the gateway.
 * Bots can use threads in every community where Fluxer enables them, without a capability setting.
 * Read a thread with channels.fetch, delete it with channels.delete and send to it with messages.send and its ID
 *
 * Supply decimal IDs. Thread requests share this client's REST slots and queue limits with the other HTTP methods.
 * Total deadline defaults to the client's rest.defaultTimeoutMs, 30,000 ms unless configured, including queue waits,
 * retries and rate-limit waits. Reads retry transport failures and HTTP 500/502/503/504 at most twice.
 * Writes retry only confirmed 429 responses, and no write is followed by an automatic confirmation fetch
 *
 * Manage Threads is an elevated permission, so in a community that requires two-factor authentication for moderation
 * Fluxer rejects the bot's moderator actions with TWO_FACTOR_REQUIRED.
 * The create, createFromMessage, createPost and edit methods accept ChannelAuditOperationOptions, and the other methods
 * reject auditReason. The fetchActive list enters the enabled channel cache, while archived pages, search results,
 * forum posts and member reads do not. The edit, join, leave, addMember and removeMember methods remove their thread
 * from the enabled channel cache
 *
 * Operation inputs are copied when the Effect executes. Expected failures use ChannelOperationError, whose operation
 * names the threads method, or ClientClosedError. Interruption and defects retain Cause after owned cleanup
 *
 * @category Channels
 */
export interface Threads<M extends MessageCore = Message> {
    /**
     * Create a thread that is not attached to a message in a text or announcement channel, and return its frozen
     * snapshot. The bot becomes the thread's first member, and Fluxer posts a ThreadCreated notice in the parent channel
     * for a public or announcement thread.
     * Fluxer requires Create Public Threads, or Create Private Threads for a private thread.
     * Use createPost in a forum or media channel.
     * A lost response can leave the thread created, and the SDK never resends it
     *
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import { ChannelType, ThreadAutoArchiveMinutes, type Client } from "@neontechspace/fluxerly/effect"
     * export const threadExample = (client: Client, channelId: string) =>
     *     client.threads
     *         .create(channelId, {
     *             name: "Release planning",
     *             type: ChannelType.PrivateThread,
     *             autoArchiveMinutes: ThreadAutoArchiveMinutes.OneDay,
     *         })
     *         .pipe(Effect.flatMap((thread) => client.messages.send(thread.id, "Planning starts here")))
     * ```
     */
    create(
        channelId: string,
        input: ThreadCreate,
        options?: ChannelAuditOperationOptions,
    ): Effect.Effect<GuildThreadChannel, ChannelOperationFailure>
    /**
     * Start a public thread on an existing message and return its frozen snapshot.
     * The thread takes the message's ID, and the message gains MessageFlags.HasThread.
     * Only a default message or a reply in a text or announcement channel can start a thread, and only one.
     * In an announcement channel the thread is an announcement thread.
     * Fluxer posts a ThreadCreated notice in the parent channel unless the message is among its five newest messages.
     * Fluxer requires Create Public Threads and Read Message History.
     * A lost response can leave the thread created, and the SDK never resends it.
     * After an unknown outcome, channels.fetch(message.id) shows whether the thread exists
     */
    createFromMessage(
        message: MessageReference,
        input: ThreadFromMessageCreate,
        options?: ChannelAuditOperationOptions,
    ): Effect.Effect<GuildThreadChannel, ChannelOperationFailure>
    /**
     * Create a post in a forum or media channel, a public thread with its first message, and return both frozen.
     * Files in the message are sent inline as multipart form data in the same request, never through presigned uploads,
     * under messages.send's attachment rules and the client's upload budget.
     * Fluxer requires Send Messages in the channel plus the permissions the message content needs, and applies the
     * channel's tag rules. When the first message fails, Fluxer removes the new post again.
     * A lost response can leave the post created, and the SDK never resends it
     */
    createPost(
        channelId: string,
        input: ForumPostCreate,
        options?: ChannelAuditOperationOptions,
    ): Effect.Effect<ForumPost<M>, ChannelOperationFailure>
    /**
     * Change only the supplied thread settings and return the frozen thread.
     * It uses the route and rate limit of channels.edit. ThreadEdit describes which changes the thread's creator may
     * make and which need Manage Threads
     */
    edit(
        threadId: string,
        input: ThreadEdit,
        options?: ChannelAuditOperationOptions,
    ): Effect.Effect<GuildThreadChannel, ChannelOperationFailure>
    /**
     * Fetch every active thread the bot can view in a community, newest first, as one frozen list.
     * A private thread appears when the bot joined it or can manage threads in its parent channel.
     * Each thread the bot joined has membership set
     */
    fetchActive(
        guildId: string,
        options?: ChannelOperationOptions,
    ): Effect.Effect<readonly GuildThreadChannel[], ChannelOperationFailure>
    /**
     * Fetch one frozen page of archived threads of a text, announcement, forum or media channel, as ArchivedThreadQuery
     * selects. Scopes "public" and "private" list the most recently archived first, and "joinedPrivate" lists the newest
     * threads first. Each thread the bot joined has membership set.
     * Fluxer requires Read Message History, plus Manage Threads for scope "private"
     */
    fetchArchived(
        channelId: string,
        query?: ArchivedThreadQuery,
        options?: ChannelOperationOptions,
    ): Effect.Effect<ArchivedThreadPage, ChannelOperationFailure>
    /**
     * Search the threads of a text, announcement, forum or media channel by name, tags and state, and return one frozen
     * page. Fluxer requires Read Message History.
     * While Fluxer builds the community's search index it answers HTTP 202 with code SEARCH_INDEX_NOT_READY, which this
     * method returns as an indexing page without retrying. Any other HTTP 202 answer fails with reason response.
     * A turned-off search service fails with reason rejected and apiError.providerCode
     * FEATURE_TEMPORARILY_DISABLED
     */
    search(
        channelId: string,
        query?: ThreadSearchQuery,
        options?: ChannelOperationOptions,
    ): Effect.Effect<ThreadSearchPage<M>, ChannelOperationFailure>
    /**
     * Add the bot to a thread, succeeding with no value after HTTP 204. Joining a thread the bot already belongs to also
     * succeeds. An archived thread cannot be joined, and a locked one needs Manage Threads
     */
    join(threadId: string, options?: ChannelOperationOptions): Effect.Effect<void, ChannelOperationFailure>
    /**
     * Remove the bot from a thread, succeeding with no value after HTTP 204.
     * An archived thread cannot be left, and Fluxer rejects a bot that is not a member with UNKNOWN_THREAD_MEMBER
     */
    leave(threadId: string, options?: ChannelOperationOptions): Effect.Effect<void, ChannelOperationFailure>
    /**
     * Add a community member who can view the parent channel to a thread, succeeding with no value after HTTP 204.
     * Adding a current member also succeeds, and otherwise Fluxer posts a RecipientAdd notice in the thread.
     * Fluxer requires Send Messages In Threads, plus Manage Threads in a locked thread and in a private thread that is
     * not invitable, unless the added member can manage threads. An archived thread accepts no new members
     */
    addMember(
        threadId: string,
        userId: string,
        options?: ChannelOperationOptions,
    ): Effect.Effect<void, ChannelOperationFailure>
    /**
     * Remove a member from a thread, succeeding with no value after HTTP 204, and Fluxer posts a RecipientRemove notice
     * in the thread. Removing the bot's own ID works like leave.
     * Fluxer requires Manage Threads unless the bot created the private thread. A user who is not a member fails with
     * UNKNOWN_THREAD_MEMBER, and an archived thread cannot change
     */
    removeMember(
        threadId: string,
        userId: string,
        options?: ChannelOperationOptions,
    ): Effect.Effect<void, ChannelOperationFailure>
    /**
     * Fetch one thread member as a frozen ThreadMember. A user who is not a member fails with UNKNOWN_THREAD_MEMBER.
     * With withMember, member holds the user's community membership while the user has one. Its community comes from
     * the channel cache when the thread is cached there, otherwise from one extra channel read that shares the deadline
     * and whose failure fails this call
     */
    fetchMember(
        threadId: string,
        userId: string,
        query?: ThreadMemberQuery,
        options?: ChannelOperationOptions,
    ): Effect.Effect<ThreadMember, ChannelOperationFailure>
    /**
     * Fetch one page of thread members in ascending user ID order, as frozen ThreadMember values.
     * With withMember, each member holds the user's community membership while the user has one, with the community
     * resolved as fetchMember describes
     */
    fetchMembers(
        threadId: string,
        query?: ThreadMemberPageQuery,
        options?: ChannelOperationOptions,
    ): Effect.Effect<readonly ThreadMember[], ChannelOperationFailure>
    /**
     * Read thread members in ascending user ID order, buffering one page and never prefetching.
     * The maxItems option is required. The pageSize option defaults to 100 and accepts 1–100, maxPages defaults to 100,
     * and timeoutMs applies to each page. An empty page or maxItems ends the scan.
     * Invalid traversal input, a stalled cursor or reaching the page budget fails with PaginationError, and remote
     * failures keep threads.fetchMembers's errors.
     * With withMember, one consumption resolves the thread's community once, as fetchMember describes.
     * Each consumption is independent, and client closure releases the page and fails the next pull
     *
     * @remarks
     * The returned Stream reads pages only while it is consumed.
     * Failures end the Stream in its error channel.
     * Interruption waits for request cleanup, and ending consumption releases the buffered page
     */
    iterateMembers(
        threadId: string,
        query: ThreadMemberIterationQuery,
        options?: ChannelOperationOptions,
    ): Stream.Stream<ThreadMember, ChannelOperationFailure | PaginationError>
}
