import type {
    MessageSearchContext,
    MessageSearchIterationLimits,
    MessageSearchPage,
    MessageSearchQuery,
    DefaultMessageSearchOptions,
} from "#sdk/message-search"
import type { PaginationError, HistoryIterationQuery, UserIterationQuery, PinIterationQuery } from "#sdk/pagination"
import type { ReactionEmojiInput, ReactionUsersQuery, ReactionUsersPage } from "#sdk/reactions"
import type { ResultAsync, Result } from "neverthrow"
import type { CancelledError, ConfigurationError } from "#sdk/errors"
import type { MessagePinsQuery, MessagePinsPage } from "#sdk/pins"
import type { DefaultReactionCollectorOptions, DefaultCollectorOptions } from "#sdk/collectors"
import type { MessageOperationFailure, SendError } from "#sdk/message-errors"
import type {
    MessageCleanupFailure,
    MessageCleanupPlan,
    MessageCleanupReport,
    MessageCleanupSelection,
    DefaultMessageCleanupOptions,
} from "#sdk/message-cleanup"
import type {
    EditMessageInput,
    ForwardMessageInput,
    MessageHistoryQuery,
    Message,
    MessageCore,
    MessageReference,
    MessageInput,
    ReplyInput,
    DefaultMessageOperationOptions,
    DefaultOwnMessageDeletionOptions,
    DefaultSendOptions,
} from "#sdk/messages"
import type { Collector, ReactionCollector } from "./collectors.js"

/**
 * Read, send and change messages with client.messages, or collect future messages and reactions.
 * HTTP operations and local get lookups do not need a gateway connection.
 * Received messages are frozen copies. They do not update when Fluxer changes.
 * Their fields follow this client's messageFields selection, which defaults to the full Message.
 * That selection also applies to nested messages, callbacks and cached snapshots
 *
 * @remarks
 * Remote calls start when called and normally return ResultAsync. Await one to get Ok or Err.
 * The default timeoutMs is the client's rest.defaultTimeoutMs, 30,000 unless configured, for the whole call, including queue, rate-limit and retry waits.
 * The SDK waits for request cleanup afterward, so the timeout is not a hard cleanup time limit.
 * By default this client runs four REST or upload requests at once and four separate attachment downloads.
 * Both pools together allow at most 256 waiting requests or 4 MiB of queued JSON bodies by default. The rest client option changes these limits.
 * These limits apply across the shards assigned to this client
 *
 * The fetch, fetchHistory, fetchReactionUsers and fetchPins methods retry transport failures and HTTP 500, 502, 503 or 504 at most twice.
 * The retry delays are 125–250 ms, then 250–500 ms, or a longer valid Retry-After.
 * Retries use the same target and query and never reset the deadline. When a retry could not start before the deadline, the received failure is returned at once.
 * Results can change between attempts.
 * Confirmed HTTP 429 rejections have separate route and global waits and do not consume those two retries.
 * Writes retry only confirmed rate-limit rejections. A write with no clear result may already have succeeded and is not retried.
 * Other rejections and malformed successes are not retried.
 * Successful JSON bodies are limited to 16 MiB before parsing, not total memory usage
 *
 * Expected failures return Err.
 * Unexpected SDK or cleanup failures reject with SdkDefect, or throw from synchronous get.
 * An aborted signal returns CancelledError.
 * Closing the client makes pending and new operations fail with ClientClosedError.
 * After a write was sent, either failure can leave the change applied.
 * Neither proves rollback.
 * Collectors need a ready gateway connection as described on collect and collectReactions
 *
 * @category Messages
 */

export interface Messages<M extends MessageCore = Message> {
    /**
     * Read older messages newest first, without connecting the gateway.
     * The maxItems option is required, and pageSize and maxPages use the limits in PaginationQuery.
     * Creating the result makes no request.
     * Each consumption copies the inputs and has independent progress.
     * The SDK keeps one page at a time and fetches the next only when needed.
     * Items are frozen message snapshots.
     * The timeoutMs option applies to each page, not to the whole scan.
     * Remote errors identify fetchHistory, and PaginationError reports invalid input, cursorStalled or pageLimit.
     * An empty page or maxItems ends the scan, while a short page does not, and pages are not a consistent snapshot.
     * If message caching is enabled, page reads can populate it as fetchHistory does.
     * Client closure releases the buffer and fails the next pull.
     * Messages already delivered to the caller are not rolled back, and caller processing is not retried
     *
     * @remarks
     * Consume the iterable with a for await loop, which starts the first request.
     * An expected failure yields one Err and ends iteration.
     * Breaking the loop releases the buffered page.
     * Abort interrupts pending request work and waits for cleanup.
     * Completion and early exit leave no listener registered.
     * Unexpected SDK failures, or an operation failure combined with a cleanup failure, reject with SdkDefect
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export async function paginationHistoryExample(client: Client, channelId: string) {
     *     for await (const result of client.messages.iterateHistory(channelId, { maxItems: 500 })) {
     *         if (result.isErr()) return result
     *         if (result.value.content === "stop") break
     *     }
     * }
     * ```
     */
    iterateHistory(
        channelId: string,
        query: HistoryIterationQuery,
        options?: DefaultMessageOperationOptions,
    ): AsyncIterable<Result<M, MessageOperationFailure | PaginationError | CancelledError | ConfigurationError>>
    /**
     * Search messages in one explicit community or channel and return one page from Fluxer's search index.
     * The SDK always sends the current search scope (`scope: "current"`).
     * It neither connects the gateway nor reads or fills a cache
     *
     * The result is a frozen page or an indexing state.
     * The indexing result means Fluxer accepted the search but is not ready, and the SDK never polls.
     * The caller decides whether and when to search again.
     * Use page numbers from 1 through 400 for later requests, keeping limit unchanged.
     * Fluxer does not honor returned cursors, so the SDK exposes no cursor continuation
     *
     * Recognized query fields, including inherited and nonenumerable fields, are read and their arrays copied when execution starts.
     * The results and their channel context can change and are not a stable snapshot.
     * Invalid input, POST failure or malformed success fails with MessageOperationError operation search.
     * Search does not use the transient read retries described for this namespace, but confirmed rate-limit handling still applies within the deadline.
     * Cancellation releases only this request
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export async function messageSearchPageExample(client: Client, channelId: string) {
     *     const page = await client.messages.search({ channelId }, { content: "release notes" })
     *     return page.isOk() && !page.value.indexing ? page.value.messages : page
     * }
     * ```
     */
    search(
        context: MessageSearchContext,
        query?: MessageSearchQuery,
        options?: DefaultMessageSearchOptions,
    ): ResultAsync<MessageSearchPage<M>, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Read indexed search hits from the supplied community or channel context, following numbered pages without polling, prefetching or cache population.
     * The maxItems option is required, pageSize accepts 1–25, and maxPages defaults to 100.
     * Each consumption copies the filters, including recognized inherited and nonenumerable fields and their arrays, and holds one page at a time.
     * Request capacity stays at the smaller of pageSize and maxItems throughout the scan, and at most maxItems hits are delivered.
     * Reaching maxPages or Fluxer's 400-page ceiling with more matches fails with PaginationError pageLimit.
     * An unexpected echoed page number or capacity fails with cursorStalled, and index changes can still skip or repeat observations.
     * An indexing response fails with PaginationError indexing rather than polling or claiming an empty result.
     * Search hits do not trigger full-message fetches.
     * Delivered hits remain with the caller after a later failure
     *
     * @remarks
     * Consume the iterable with a for await loop, which starts the first request.
     * An expected failure yields one Err and ends iteration.
     * Breaking the loop releases the buffered page.
     * Abort interrupts pending request work and waits for cleanup
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export async function messageSearchTraversalExample(client: Client, guildId: string) {
     *     for await (const hit of client.messages.iterateSearch({ guildId }, { content: "todo" }, { maxItems: 100 })) {
     *         if (hit.isErr()) return hit
     *     }
     * }
     * ```
     */
    iterateSearch(
        context: MessageSearchContext,
        filters: Omit<MessageSearchQuery, "limit" | "page">,
        limits: MessageSearchIterationLimits,
        options?: DefaultMessageSearchOptions,
    ): AsyncIterable<Result<M, MessageOperationFailure | PaginationError | CancelledError | ConfigurationError>>
    /**
     * Read users who reacted with one selected emoji, in ascending user-ID order.
     * Pass a literal Unicode emoji or custom emoji input, plus maxItems to bound the scan.
     * Like iterateHistory, this is lazy and keeps bounded results.
     * The timeoutMs option applies to each fetchReactionUsers page, and remote errors keep that operation.
     * The scan ends at maxItems or hasMore false, without caching reactors or fetching members.
     * Reactions may change during the scan.
     * Not finding a user within the bound does not prove the user never reacted
     *
     * @remarks
     * Consume the iterable with a for await loop, which starts the first request.
     * An expected failure yields one Err and ends iteration.
     * Breaking the loop releases the buffered page.
     * Abort interrupts pending request work and waits for cleanup
     *
     * @example
     * ```ts
     * import type { Client, MessageReference } from "@neontechspace/fluxerly"
     * export async function paginationReactionExample(client: Client, message: MessageReference, userId: string) {
     *     for await (const result of client.messages.iterateReactionUsers(message, "👍", { maxItems: 500 })) {
     *         if (result.isErr()) return result
     *         if (result.value.id === userId) return result
     *     }
     *     return undefined
     * }
     * ```
     */
    iterateReactionUsers(
        message: MessageReference,
        emoji: ReactionEmojiInput,
        query: UserIterationQuery,
        options?: DefaultMessageOperationOptions,
    ): AsyncIterable<
        Result<
            import("#sdk/reactions").ReactionUser,
            MessageOperationFailure | PaginationError | CancelledError | ConfigurationError
        >
    >
    /**
     * Read pinned messages newest pin first, without adding message cache entries.
     * Pass maxItems to bound the scan, and PinIterationQuery defines the remaining limits.
     * Like iterateHistory, this is lazy, with timeoutMs applying to each fetchPins page, and remote errors keep that operation.
     * At most maxItems IDs are kept to skip duplicates.
     * Valid items on a stalled page can be delivered before cursorStalled on the next pull.
     * The scan stops at maxItems or hasMore false.
     * Cursor progress uses the full fractional timestamp precision and compares equivalent timezone offsets as the same instant.
     * Pins with equal timestamps can prevent a complete scan even without concurrent edits
     *
     * @remarks
     * Consume the iterable with a for await loop, which starts the first request.
     * An expected failure yields one Err and ends iteration.
     * Breaking the loop releases the buffered page.
     * Abort interrupts pending request work and waits for cleanup
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export async function paginationPinsExample(client: Client, channelId: string) {
     *     const ids: string[] = []
     *     for await (const result of client.messages.iteratePins(channelId, { maxItems: 20 })) {
     *         if (result.isErr()) return result
     *         ids.push(result.value.message.id)
     *     }
     *     return ids
     * }
     * ```
     */
    iteratePins(
        channelId: string,
        query: PinIterationQuery,
        options?: DefaultMessageOperationOptions,
    ): AsyncIterable<
        Result<
            import("#sdk/pins").MessagePin<M>,
            MessageOperationFailure | PaginationError | CancelledError | ConfigurationError
        >
    >
    /**
     * Pin a message using its decimal id and channelId.
     * Success follows HTTP 204, not gateway notification.
     * No gateway connection is required
     *
     * Fluxer checks channel access and PIN_MESSAGES for community pins.
     * A new pin creates a system message and notifications.
     * An already-pinned message stays unchanged.
     * The pin, unpin and fetchPins methods share the per-channel pins rate limit and the client's request limits.
     * The default deadline is the client's rest.defaultTimeoutMs, 30,000 ms unless configured, and only confirmed HTTP 429 rejections are retried
     *
     * Expected failures use MessageOperationError operation pin, or ClientClosedError after shutdown.
     * Invalid local input fails with outcome notDispatched.
     * Cancellation or a lost response after sending the request can leave the pin applied.
     * Successful writes and writes with unknown outcomes remove the cached target without guessing its new pinned status.
     * The SDK does not fetch to confirm, create events itself, unpin automatically or roll back the change.
     * The example's steps are separate operations, not a transaction
     *
     * @example
     * ```ts
     * import type { Client, MessageReference } from "@neontechspace/fluxerly"
     *
     * export async function pinsExample(client: Client, message: MessageReference) {
     *     const pinned = await client.messages.pin(message)
     *     if (pinned.isErr()) throw pinned.error
     *     const page = await client.messages.fetchPins(message.channelId, { limit: 25 })
     *     if (page.isErr()) throw page.error
     *     const unpinned = await client.messages.unpin(message)
     *     if (unpinned.isErr()) throw unpinned.error
     *     return page.value
     * }
     * ```
     */
    pin(
        message: MessageReference,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Remove a pin without deleting the message or its pin-created system message.
     * Supply a decimal message id and channelId.
     * Fluxer checks the same permissions as pin.
     * Success follows HTTP 204, including when the message is already unpinned.
     * The last-pin timestamp is not reset.
     * The pin method's request limits, deadline, rate-limit retries, cancellation and cache removal also apply.
     * Expected failures identify operation unpin, and client closure fails with ClientClosedError.
     * No gateway connection, confirmation fetch, event synthesis or automatic rollback is performed
     */
    unpin(
        message: MessageReference,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch one frozen page of pinned messages in descending pin-time order.
     * Use a decimal channel ID.
     * The limit option defaults to 50 and accepts 1–50.
     * The before option is an ISO timestamp and defaults to the server's current time
     *
     * Use nextBefore for the next page and pinnedAt for each pin's time.
     * Page ordering and the before bound use every fractional digit and normalize timezone offsets, while equal instants remain valid.
     * Equal timestamps can repeat messages, so skip duplicate IDs and stop if the cursor does not advance.
     * This call neither traverses further pages nor reads or populates the message cache.
     * Visibility and history permissions can limit the page, so an empty page does not prove there are no pins.
     * Returned messages are snapshots, not live state
     *
     * The call uses the pins rate limit, the client's default deadline (rest.defaultTimeoutMs, 30,000 ms unless configured) and the namespace's bounded read retries.
     * Invalid input or malformed responses fail with MessageOperationError operation fetchPins, not a partial page.
     * Client closure fails with ClientClosedError, and cancellation affects this request only
     */
    fetchPins(
        channelId: string,
        query?: MessagePinsQuery,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<MessagePinsPage<M>, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Remove one user's reaction for one emoji, leaving other users and emoji groups unchanged.
     * The userId input is required as a decimal string, and the bot's own ID removes its reaction.
     * Accepts the same ReactionEmojiInput forms as addReaction
     *
     * Fluxer checks visibility and history access.
     * For another user, the bot must have authored the message or have MANAGE_MESSAGES in its community.
     * Success follows HTTP 204, whether the reaction was present or already absent, without waiting for or synthesizing events.
     * The call uses addReaction's request limits, deadline, confirmed rate-limit retries and cancellation rules.
     * Expected failures identify removeUserReaction.
     * No reaction cache is changed or retained
     *
     * After dispatch, cancellation or a lost response can leave the reaction removed, and an unknown outcome is not replayed.
     * The bot cannot restore another user's reaction as that user, and no restoration is attempted
     *
     * @example
     * ```ts
     * import type { Client, MessageReference } from "@neontechspace/fluxerly"
     * export async function reactionModerationExample(client: Client, message: MessageReference, userId: string) {
     *     const removed = await client.messages.removeUserReaction(message, "👍", userId)
     *     if (removed.isErr()) return removed
     *     const cleared = await client.messages.clearReaction(message, "👍")
     *     if (cleared.isErr()) return cleared
     *     return client.messages.clearReactions(message)
     * }
     * ```
     */
    removeUserReaction(
        message: MessageReference,
        emoji: ReactionEmojiInput,
        userId: string,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Remove all users' reactions for one emoji on the message.
     * Other emoji groups remain.
     * Success follows HTTP 204, even if no matching reactions existed.
     * The removeUserReaction method's permissions, request limits, deadline, failure and cleanup rules apply.
     * Expected failures identify clearReaction.
     * Fluxer emits a clear-emoji event, not individual removals, and the SDK does not create or wait for that event.
     * Other users' reactions cannot be restored by the bot as those users
     */
    clearReaction(
        message: MessageReference,
        emoji: ReactionEmojiInput,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Remove all users' reactions for all emoji on the message, without deleting the message.
     * No emoji selector is needed.
     * Success follows HTTP 204, whether reactions existed or not.
     * The clearReaction method's permissions, request limits, deadline, failure and cleanup rules apply.
     * Expected failures identify clearReactions.
     * Fluxer emits one clear-all event, and the SDK does not create per-emoji or per-user events or wait for notification.
     * Other users' reactions cannot be restored by the bot as those users
     */
    clearReactions(
        message: MessageReference,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch one page of users who currently have a selected reaction on the message.
     * Accepts the same ReactionEmojiInput forms as addReaction.
     * The limit option defaults to 25 and accepts 1–100.
     * The after option is an exclusive user-ID cursor.
     * Users are ordered by ascending ID, not reaction time.
     * Use nextAfter for another page
     *
     * An empty reaction produces an empty terminal page.
     * No automatic page traversal, user cache or message cache update is performed.
     * Pages can change between requests, so they are not a stable voter list.
     * This call shares the channel reaction rate limit and the client's default deadline (rest.defaultTimeoutMs, 30,000 ms unless configured), which timeoutMs overrides.
     * The namespace's bounded read retries apply within the original deadline
     *
     * Invalid input, malformed pages, HTTP failures and timeout fail with MessageOperationError for fetchReactionUsers.
     * HTTP 404 is notFound.
     * Fluxer decides visibility and history access.
     * No gateway connection is needed, and cancellation waits for request cleanup
     *
     * @example
     * ```ts
     * import type { Client, MessageReference } from "@neontechspace/fluxerly"
     * export async function reactionUsersExample(client: Client, message: MessageReference) {
     *     const result = await client.messages.fetchReactionUsers(message, "👍", { limit: 25 })
     *     if (result.isErr() || result.value.nextAfter === null) return result
     *     return client.messages.fetchReactionUsers(message, "👍", { after: result.value.nextAfter })
     * }
     * ```
     */
    fetchReactionUsers(
        message: MessageReference,
        emoji: ReactionEmojiInput,
        query?: ReactionUsersQuery,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<ReactionUsersPage, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Add the bot's own reaction to a message.
     * Pass Unicode such as "👍", custom markup such as "<a:party:123>", a parsed custom emoji, or a received emoji snapshot.
     * ReactionEmojiInput defines accepted identities and local validation, and custom emoji are encoded as name:id.
     * Fluxer decides emoji availability and permissions.
     * Adding the same own reaction again leaves it present.
     * Success follows HTTP 204, without waiting for or synthesizing a gateway event, and no gateway connection is required.
     * The request uses a per-channel reaction rate limit separate from message operations, the client's request limits and the client's default deadline (rest.defaultTimeoutMs, 30,000 ms unless configured).
     * Only confirmed rate-limit rejections retry, and unknown outcomes are never retried.
     * Cancellation after dispatch cannot undo the reaction.
     * Expected failures use MessageOperationError, or ClientClosedError after closure.
     * The SDK does not retain reaction state, counts or reactor lists
     *
     * @example
     * ```ts
     * import type { Client, MessageReference } from "@neontechspace/fluxerly"
     * export async function reactionExample(client: Client, message: MessageReference) {
     *     const added = await client.messages.addReaction(message, "👍")
     *     if (added.isErr()) return added
     *     return client.messages.removeReaction(message, "👍")
     * }
     * ```
     */
    addReaction(
        message: MessageReference,
        emoji: ReactionEmojiInput,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Remove only the bot's own reaction for the selected emoji.
     * Other users' reactions stay unchanged.
     * Success follows HTTP 204, even if the bot had not reacted, so it does not prove the reaction existed.
     * The addReaction method's emoji inputs, request limits, deadline, retry, failure and cancellation rules apply.
     * Neither this operation nor gateway reaction events change the message cache
     */
    removeReaction(
        message: MessageReference,
        emoji: ReactionEmojiInput,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Collect a bounded set of future messageCreate events from one channel.
     * Register before sending a prompt.
     * It does not fetch history, read the cache, connect the client or match replies to a prompt automatically.
     * With guildId, only that community's ready shard assigned to this client can feed the collector, and events with a known conflicting community are discarded without a channel lookup.
     * Without guildId, the client must be Connected, and any gateway gap ends collection because the community is unknown.
     * A gap fails with CollectorError connectionLost, even if the client later resumes, and collection is not restarted
     *
     * Defaults are one accepted message, a 30,000 ms lifetime and 4 MiB of retained selected-message JSON.
     * After channel selection and before filtering, the pending queue allows 256 payloads or 4 MiB of source JSON.
     * Options are copied at registration.
     * Budgets must be positive safe integers, and timeoutMs and optional idleMs must be at most 2,147,483,647 ms
     *
     * The total timeout starts at registration and never resets.
     * The idleMs timer also starts at registration, then resets after each newly accepted message ID, before its callback.
     * Rejected, queued or duplicate messages do not reset idleMs.
     * Callback time counts toward both deadlines.
     * The earlier deadline wins, with timeout winning ties.
     * Messages processed at or after the deadline are excluded, including slow filter returns.
     * Each accepted ID counts once, and later edits and deletions do not change collected snapshots
     *
     * The synchronous filter decides acceptance.
     * Filter failure or queue or retained-byte overflow ends this collector with a failure, without partial messages.
     * A slow synchronous filter blocks JavaScript and cannot be preempted.
     * Optional onMessage runs sequentially after filtering, duplicate removal and the retained-byte check.
     * Reaching maxMessages waits for the final callback, and later messages are ignored while it completes.
     * Idle, timeout or stop can retain a message whose callback was cancelled.
     * Pending budgets exclude the active message.
     * Callback failure ends collection with CollectorError reason handler.
     * Callbacks are not retried and their effects are not undone.
     * Filter the bot out when callbacks send acknowledgements, to avoid collecting those acknowledgements
     *
     * Invalid options are misuse: The default API throws ConfigurationError and the native API dies with it.
     * A client that is not ready returns a collector whose result is CollectorError notConnected, and a client that began
     * shutting down, such as when a handler still running during shutdown registers, returns one whose result is
     * ClientClosedError.
     * A timeout can succeed with no messages.
     * The application still manages the client's lifetime
     *
     * @remarks
     * Returns a ready Collector handle synchronously.
     * Return or await callback work, and closure waits for the callback promise. A callback that returns or resolves an Err result fails like a throw.
     * The options.signal value controls the collection itself: Aborting it makes result return CancelledError, and a pre-aborted signal starts no collection.
     * Use `await using` to close the collector when the block ends.
     * Unexpected registration failures throw SdkDefect
     *
     * @example
     * ```ts
     * import { orThrow, type Client } from "@neontechspace/fluxerly"
     *
     * export async function askName(client: Client, channelId: string, userId: string) {
     *     await using collector = client.messages.collect(channelId, { filter: message => message.author.id === userId })
     *     orThrow(await client.messages.send(channelId, { content: "What name should the bot use?" }))
     *     return orThrow(await collector.result())
     * }
     * ```
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     *
     * export async function messageCollectorProgressExample(client: Client, channelId: string, userId: string) {
     *     const collector = client.messages.collect(channelId, {
     *         filter: message => message.author.id === userId,
     *         maxMessages: 3,
     *         idleMs: 5_000,
     *         // A failed reply is returned as an Err, which ends collection like a throw
     *         onMessage: (message, signal) => client.messages.reply(message, { content: "Reply received" }, { signal }),
     *     })
     *     return await collector.result()
     * }
     * ```
     */
    collect(channelId: string, options?: DefaultCollectorOptions<M>): Collector<M>
    /**
     * Collect future reaction additions for one message.
     * Use decimal id and channelId, and register before the expected reaction.
     * This does not fetch existing reactors, verify the message remotely, read the cache or connect the client.
     * With guildId, only that community's ready shard assigned to this client feeds the collector, and known conflicting event communities are discarded without a membership lookup.
     * Without guildId, the client must be Connected and any gateway gap ends collection with connectionLost, without restarting it
     *
     * Defaults are one accepted addition, a 30,000 ms lifetime and 4 MiB of retained reaction JSON.
     * The target and options are copied at registration.
     * After message selection, the pending queue allows 256 payloads or 4 MiB of full source JSON.
     * Optional emoji uses addReaction's input shape and is checked after queueing, before the synchronous filter.
     * Unicode emoji match exact text without a custom ID, and custom emoji match by ID, ignoring name changes.
     * An invalid emoji selector fails with ConfigurationError for emoji
     *
     * Single events and batch entries follow receive order.
     * A batch uses one pending slot and its entries count individually.
     * Repeated user and emoji pairs count again, and no batching flag is enabled.
     * Removals, clears and message deletion neither undo additions nor stop collection, so this is not a vote tally
     *
     * The total timeout starts at registration and never resets, and excludes additions processed at or after it, including slow filter returns.
     * Optional idleMs starts then too and resets after each accepted addition, before its callback.
     * Rejected, queued and unprocessed batch entries do not reset it.
     * Callback time counts, and the earlier deadline wins, with timeout winning ties.
     * The timeoutMs and idleMs values must be integers from 1 through 2,147,483,647 ms
     *
     * Optional onReaction runs sequentially after acceptance and the retained-byte check.
     * Limit completion waits for the final callback.
     * Idle, timeout or stop can retain an addition whose callback was cancelled.
     * Pending budgets exclude the active payload and its unprocessed batch entries.
     * Callback failure ends collection with CollectorError reason handler, and no callback is retried or earlier effect undone.
     * Filter or overflow failure ends with CollectorError without partial results.
     * An invalid target or options are misuse: The default API throws ConfigurationError and the native API dies with it.
     * A client that is not ready returns a collector whose result is CollectorError notConnected, and a client that began
     * shutting down, such as when a handler still running during shutdown registers, returns one whose result is
     * ClientClosedError.
     * The example needs a connected client and an existing message, and idle or timeout may succeed with no reactions
     *
     * @remarks
     * Returns a ready ReactionCollector synchronously.
     * Closure waits for the callback's returned promise. A callback that returns or resolves an Err result fails like a throw.
     * The options.signal value controls collection: Aborting it makes result return CancelledError, and a pre-aborted signal starts nothing.
     * Use `await using` to close the collector when the block ends.
     * Unexpected registration failures throw SdkDefect
     *
     * @example
     * ```ts
     * import { orThrow, type Client, type MessageReference } from "@neontechspace/fluxerly"
     *
     * export async function reactionCollectorExample(client: Client, message: MessageReference, userId: string) {
     *     let count = 0
     *     await using collector = client.messages.collectReactions(message, {
     *         maxReactions: 3,
     *         idleMs: 5_000,
     *         emoji: "✅",
     *         filter: reaction => reaction.userId === userId,
     *         onReaction: (_reaction, signal) =>
     *             client.messages.edit(message, { content: `Accepted additions: ${++count}` }, { signal }),
     *     })
     *     return orThrow(await collector.result())
     * }
     * ```
     */
    collectReactions(message: MessageReference, options?: DefaultReactionCollectorOptions): ReactionCollector
    /**
     * Look up a message in this client's cache, without an HTTP request.
     * Pass decimal id and channelId, or an existing message with those fields.
     * The result is undefined when caching is disabled or the entry is absent, expired, evicted or in a different channel.
     * It does not mean Fluxer has no such message, so use fetch for a remote read.
     * A hit is a frozen snapshot that can be stale.
     * Lookup makes it more recently used without extending its age.
     * An invalid reference is misuse: The default API throws MessageOperationError with operation messages.get and reason input, and the native API dies with it.
     * A closing or closed client has no cache, so the result is undefined
     *
     * @remarks
     * Returns the value synchronously.
     * Unexpected failures throw SdkDefect
     */
    get(message: MessageReference): M | undefined
    /**
     * Send text, embeds, files or stickers to a channel and return the created message.
     * A plain string sends only that text, as shorthand for `{ content }`, and embeds accept plain objects or EmbedBuilder instances.
     * Success follows the decoded HTTP response, not gateway notification or recipient acknowledgement, and no gateway connection is needed.
     * Mentions are disabled by default, and allowedMentions opts in.
     * Embed image and thumbnail URLs can use attachment://filename for a matching new image upload.
     * The flags input accepts only MessageFlags' non-voice bits.
     * Suppressing previews is different from omitting embeds
     *
     * Each attachment uses exactly one source: Bytes in data, a sized Blob or File source, or a finite stream with its exact byte count.
     * Data bytes are copied when execution starts, before any wait.
     * File and stream bytes are read when uploading starts, after upload planning, without copying or spooling.
     * Keep a file source stable while it is read.
     * A finite stream is consumed at most once and must match its declared size.
     * A path string or URL alone is not accepted, and the SDK owns only the readers it acquires
     *
     * All sources have a 50 MiB per-file maximum and share the client uploads.maxBytes reservation budget.
     * A full upload or request queue fails with busy before copying or reading.
     * Fluxer can impose lower limits.
     * Uploads use presigned planning or an inline multipart fallback.
     * Cleanup releases copied bytes and cancels and releases acquired readers on failure.
     * Failed uploads can leave temporary server data, without a guarantee of physical erasure.
     * Eligible created messages can enter an enabled cache, independently of send completion
     *
     * The default total deadline, rest.defaultTimeoutMs (30,000 ms unless configured), includes waiting for request capacity and rate limits.
     * The request uses the shared limits and failure rules of this namespace.
     * By default one client admits four REST and upload requests plus four independent attachment downloads, and both pools share at most 256 pending requests or 4 MiB of pending JSON. The rest client option changes these limits.
     * Only confirmed rate-limit rejections can retry automatically, and sends with unknown outcomes never retry.
     * With inline multipart uploads, a confirmed HTTP 429 can replay copied data bytes only, while file and stream inputs fail with rateLimit instead of being read again
     *
     * The nonce input can be a 1–32 character string or a nonnegative safe integer.
     * If omitted, the SDK creates one nonce per send execution, and the same nonce is reused for confirmed rate-limit retries.
     * Fluxer tries to suppress duplicate sends for five minutes after saving a message.
     * This does not guarantee that a repeated or concurrent send posts only one message.
     * A lost response or cancellation after dispatch can leave a message posted, and the SDK neither retries nor rolls it back
     */
    send(
        channelId: string,
        input: MessageInput | string,
        options?: DefaultSendOptions,
    ): ResultAsync<M, SendError | CancelledError | ConfigurationError>
    /**
     * Copy an accessible source message into the destination channel and return the new message.
     * Pass the source reference in input.source.
     * No source fetch or cache lookup is performed, and no gateway connection is required.
     * Optional media selections must belong to the source.
     * Extra content, files, mentions and flags are rejected.
     * The result's messageSnapshots are frozen copies, not live views of later source edits
     *
     * Fluxer checks source access and destination permissions.
     * This uses send's shared request limits, the client's default deadline (rest.defaultTimeoutMs, 30,000 ms unless configured) and optional destination-message caching.
     * The nonce input follows send's accepted values, generated default and reuse on confirmed rate-limit retries.
     * Fluxer's five-minute duplicate suppression is best effort, not exactly-once delivery.
     * Success follows HTTP, not recipient acknowledgement.
     * A lost response or cancellation can leave the forward posted.
     * Only confirmed rate-limit rejection retries, and no write with an unknown outcome is replayed or rolled back.
     * Expected failures are MessageError or ClientClosedError
     *
     * @example
     * ```ts
     * import type { Client, MessageReference } from "@neontechspace/fluxerly"
     * export function forwardExample(client: Client, destinationId: string, source: MessageReference) {
     *     return client.messages.forward(destinationId, { source })
     * }
     * ```
     */
    forward(
        channelId: string,
        input: ForwardMessageInput,
        options?: DefaultSendOptions,
    ): ResultAsync<M, SendError | CancelledError | ConfigurationError>
    /**
     * Show this bot's temporary typing indicator in a channel.
     * Pass a decimal channel ID.
     * Success follows HTTP 204, without waiting for another client to see it.
     * No gateway connection, cache entry, local typing state or presence change is made.
     * Fluxer decides delivery and when the indicator expires.
     * This uses the client's request limits, a dedicated per-channel typing rate limit and the client's default deadline (rest.defaultTimeoutMs, 30,000 ms unless configured).
     * Only confirmed rate-limit rejection retries.
     * A lost response, timeout or cancellation can leave the notice shown.
     * Input, capacity and HTTP failures use MessageOperationError operation typing, and client closure fails with ClientClosedError.
     * Cancellation waits for request cleanup
     */
    typing(
        channelId: string,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Keep the bot's typing indicator active while a task runs, returning the task's value.
     * The first typing request must succeed before the task starts, and an initial failure prevents the task from running.
     * Refreshes run no sooner than every 8,000 ms until the task settles, below Fluxer's documented limit of 20 requests per 10 seconds per channel.
     * A later typing or client-close failure stops refreshes without interrupting the task, and is reported after the task settles.
     * Client shutdown stops and waits for the helper's refresh work, not arbitrary application work.
     * No detached refresh loop, cache entry, presence change or gateway state change is created
     *
     * @remarks
     * The task is an async function that receives a signal aborted on caller cancellation or helper cleanup.
     * The task must cooperate with that signal, because a promise that ignores it can delay cancellation.
     * A thrown or rejected task rejects with SdkDefect rather than returning an expected Err.
     * If task failure and refresh cleanup both fail, SdkDefect retains safe details for both
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export async function typingExample(client: Client, channelId: string) {
     *     return await client.messages.keepTyping(channelId, async signal => {
     *         if (signal.aborted) throw new Error("work cancelled")
     *         return "prepared"
     *     })
     * }
     * ```
     */
    keepTyping<A>(
        channelId: string,
        task: (signal: AbortSignal) => PromiseLike<A>,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<A, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Send a reply that references an existing message and return the new reply.
     * A plain string replies with only that text, as shorthand for `{ content }`.
     * Pass the target's id and channelId, plus the reply content or files.
     * A missing target fails instead of silently sending an unreferenced message.
     * Target and explicit reference checks run first, and after client-closure checks, body validation follows send.
     * Author notifications are off by default.
     * The send method's mention defaults, attachment source handling, size limits, deadline, nonce and retry rules apply, and inline multipart 429 responses do not replay file or stream sources.
     * Eligible replies can enter the message cache.
     * A lost response can leave the reply posted, and the SDK does not replay a send with an unknown outcome
     */
    reply(
        message: MessageReference,
        input: ReplyInput | string,
        options?: DefaultSendOptions,
    ): ResultAsync<M, SendError | CancelledError | ConfigurationError>
    /**
     * Fetch one message from Fluxer, rather than reading the cache.
     * Pass a reference with id and channelId, or an existing Message.
     * The result is a frozen snapshot after response decoding and target-ID checks.
     * A missing target fails with MessageOperationError reason notFound, not an empty value.
     * An enabled cache can retain eligible results, but a full cache does not prevent the read from succeeding.
     * The namespace's bounded read retries apply, so no caller retry loop is needed for eligible transient failures.
     * Cancellation stops this request only and waits for cleanup
     *
     * @example
     * ```ts
     * import type { Client, MessageReference } from "@neontechspace/fluxerly"
     * export async function readExample(client: Client, message: MessageReference) {
     *     const result = await client.messages.fetch(message, { timeoutMs: 2_000 })
     *     if (result.isErr()) throw result.error
     *     return result.value.content
     * }
     * ```
     */
    fetch(
        message: MessageReference,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<M, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch one page of channel messages from Fluxer, newest first.
     * Pass a decimal channel ID.
     * With no query, this reads the latest 50 messages.
     * The limit option accepts 1–100.
     * Choose at most one before, after or around message-ID cursor.
     * Use the oldest returned ID as before to request an older page
     *
     * The entire page is validated before returning a frozen array of frozen snapshots.
     * No gateway connection, cache read, automatic traversal or prefetch is required.
     * An empty or short page describes currently accessible results, not necessarily complete history.
     * Pages are separate observations, not a consistent point-in-time snapshot.
     * An enabled cache receives eligible messages oldest first, so tight limits keep the newest
     *
     * Invalid input, malformed pages or HTTP failures fail with MessageOperationError for fetchHistory, and HTTP 404 remains notFound.
     * The namespace's shared limits, default deadline and bounded read retries apply.
     * Cancellation affects only this request and waits for cleanup, and client closure fails with ClientClosedError
     */
    fetchHistory(
        channelId: string,
        query?: MessageHistoryQuery,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<readonly M[], MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Preview a bounded message-deletion selection without deleting anything.
     * Pass authorId, a synchronous filter, or both.
     * When both are supplied, a message must match both.
     * The maxScanned and maxSelected values are required integers from 1 through 10,000.
     * History is scanned newest first until an empty page or either bound, without prefetch, and a short page does not end the scan.
     * History reads can populate an enabled message cache
     *
     * The result is an in-memory plan with frozen selected messages, usable once by this client only.
     * It cannot be reconstructed from JSON or given to another client.
     * A thrown filter, non-boolean return or promise-like return fails with MessageCleanupError before deletion.
     * A blocking synchronous filter cannot be interrupted.
     * One default deadline, rest.defaultTimeoutMs (30,000 ms unless configured), covers the history scan.
     * Cancellation submits no deletion.
     * No gateway connection or cache reread is needed
     */
    previewCleanup(
        channelId: string,
        selection: MessageCleanupSelection<M>,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<MessageCleanupPlan<M>, MessageCleanupFailure | CancelledError | ConfigurationError>
    /**
     * Delete the exact IDs in a plan returned by previewCleanup, in sequential batches of at most 100.
     * No history reread or filter rerun is performed.
     * Each batch has the ManageMessages and two-factor authentication requirements of deleteMany.
     * A plan is single-use even when cleanup fails or is cancelled, preventing accidental replay.
     * To resolve an unknown outcome, preview again or call deleteMany with separately recorded IDs
     *
     * One default deadline, rest.defaultTimeoutMs (30,000 ms unless configured), covers all batch submissions.
     * The submittedBatches field records only earlier HTTP-success submissions, in the report or MessageCleanupError.
     * The rejected or unknown terminal batch is reported separately.
     * These records do not prove each deletion, a deletion count, atomicity or that retrying is safe
     *
     * The onProgress callback runs synchronously and cleanup continues after it fails.
     * A throw, a rejected promise or a returned or resolved Err result goes to the client-level onError as a progress
     * FailureReport, or is logged at Error.
     * A returned Effect is not run and is reported the same way as a TypeError, so run Effect work explicitly inside the callback.
     * Cancellation can leave the batch being submitted with an unknown outcome.
     * Batches retry only confirmed rate-limit rejections as deleteMany does, never an unknown outcome
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export async function cleanupWorkflowExample(client: Client, channelId: string, authorId: string) {
     *     const preview = await client.messages.previewCleanup(channelId, {
     *         authorId,
     *         filter: message => message.attachments.length > 0,
     *         maxScanned: 500,
     *         maxSelected: 200,
     *     })
     *     return preview.isErr() ? preview : client.messages.cleanup(preview.value)
     * }
     * ```
     */
    cleanup(
        plan: MessageCleanupPlan<M>,
        options?: DefaultMessageCleanupOptions,
    ): ResultAsync<MessageCleanupReport, MessageCleanupFailure | CancelledError | ConfigurationError>
    /**
     * Change a message's supplied fields and return its frozen updated snapshot after HTTP, without waiting for a gateway event.
     * A plain string replaces only the text, as shorthand for `{ content }`.
     * Omitted fields remain unchanged.
     * No hidden fetch or cache merge is performed.
     * Mentions default off.
     * Existing stickers are preserved and cannot be replaced here.
     * An empty content string requests removal of text, subject to Fluxer's validation.
     * To remove embeds, send nonempty content with embeds: [].
     * An otherwise empty edit is rejected by Fluxer.
     * Omitted rich embeds remain, but link previews may be regenerated
     *
     * To keep existing files while adding new uploads, include their IDs in attachments.
     * The supplied list replaces the old one.
     * [] clears files when nonempty text or embeds remain.
     * Retained file title or description can be replaced or cleared with null.
     * Unknown IDs may be ignored, and a stale list can remove concurrent additions.
     * An attachment:// image or thumbnail URL must match a new image upload, not a retained attachment.
     * New uploads use send's copying, attachment source, size, budget and cleanup rules, and inline multipart 429 responses do not replay file or stream sources.
     * Failed edits may leave temporary server data, without physical-erasure guarantees.
     * A flags-only edit is allowed.
     * Omission preserves flags, supplied flags replace writable bits, and 0 clears both non-voice bits
     *
     * Eligible responses can enter the cache.
     * A dispatched edit with an unknown outcome removes the old cached copy.
     * A missing message fails with notFound.
     * A lost response, timeout, cancellation or closure can leave the edit applied.
     * The SDK does not automatically retry edits with unknown outcomes
     */
    edit(
        message: MessageReference,
        input: EditMessageInput | string,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<M, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Delete one message, succeeding with no value after HTTP 204.
     * Deleting another author's message requires ManageMessages, and Fluxer rejects that deletion with HTTP 400 and apiError.code twoFactorRequired in a community whose mfaLevel is GuildMfaLevels.Elevated, unless the bot owns the community or its application owner has two-factor authentication enabled.
     * No gateway notification is awaited.
     * A missing message fails with MessageOperationError reason notFound, including a repeated delete.
     * Successful deletions and deletions with unknown outcomes remove the cached message.
     * A lost response, timeout, cancellation or closure can leave the deletion applied.
     * Request cleanup is awaited, but the deletion cannot be undone.
     * Deletes with unknown outcomes are never retried automatically
     */
    delete(
        message: MessageReference,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Delete one attachment by its decimal ID from a message authored by this bot.
     * The target is copied when execution starts, and the attachment list is neither fetched nor replaced.
     * No gateway connection is needed.
     * Success follows HTTP 204, without waiting for an event.
     * If the last attachment is removed, Fluxer can also delete a message it considers otherwise empty.
     * Successful deletions and deletions with unknown outcomes remove this message's cached copy, and no events are created locally.
     * A notFound failure can mean the attachment is missing without proving the message is absent.
     * Message request limits and deadlines apply, and only confirmed HTTP 429 rejection retries.
     * Storage removal and message updates are separate changes, so a lost response can leave either applied.
     * Cancellation waits for cleanup but cannot undo deletion or guarantee physical erasure
     *
     * @example
     * ```ts
     * import type { Client, MessageReference } from "@neontechspace/fluxerly"
     * export function attachmentDeleteExample(client: Client, message: MessageReference, attachmentId: string) {
     *     return client.messages.deleteAttachment(message, attachmentId)
     * }
     * ```
     */
    deleteAttachment(
        message: MessageReference,
        attachmentId: string,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Delete 1–100 distinct decimal message IDs from one community channel.
     * Fluxer requires ManageMessages, even for the bot's own messages.
     * Fluxer rejects the request with HTTP 400 and apiError.code twoFactorRequired in a community whose mfaLevel is GuildMfaLevels.Elevated, unless the bot owns the community or its application owner has two-factor authentication enabled.
     * IDs are copied once when execution starts, and that copy is validated and sent, so an entry that changes between reads
     * cannot pass validation with one value and be sent with another.
     * Success follows HTTP 204, not a deletion count or proof that each ID existed, and missing messages are ignored.
     * No gateway connection, automatic selection, chunking, age filter or audit reason is added.
     * Dispatched requests remove selected cache entries even on rejection, because partial deletion is possible.
     * Only confirmed rate-limit rejection retries.
     * A lost response, timeout, cancellation or closure can leave deletions applied.
     * Input, capacity and HTTP failures use MessageOperationError, and cancellation waits for request cleanup
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * async function cleanupExample(client: Client, channelId: string, selectedIds: readonly string[]) {
     *     return await client.messages.deleteMany(channelId, selectedIds)
     * }
     * ```
     */
    deleteMany(
        channelId: string,
        messageIds: readonly string[],
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Irreversibly delete this bot's entire authored message history in one channel.
     * Use a decimal channel ID.
     * Other authors' messages are preserved, and no gateway connection, community leave or role change is performed
     *
     * Success follows Fluxer's empty HTTP 202 response.
     * It is not a completed-job report, deletion count, gateway event or proof the channel is empty.
     * Deletion can be partial and can leave new or concurrent messages.
     * There is no recovery token, automatic reconciliation or atomicity guarantee
     *
     * Bot credentials satisfy Fluxer's extra authentication checks, called sudo checks, and no extra sudo input is accepted.
     * Fluxer handles attachment removal without guaranteeing physical provider-storage or CDN erasure.
     * The default deadline, rest.defaultTimeoutMs (30,000 ms unless configured), includes capacity and rate-limit waits.
     * Only confirmed HTTP 429 rejection retries, and a 5xx or lost response never causes a replay.
     * After dispatch, the entire enabled message cache is cleared and older pending reads cannot restore it.
     * No gateway events are created locally.
     * Cancellation or closure waits for request cleanup but cannot undo deletion.
     * Options must include confirm: true. Without it, the call fails before any request with reason input and path options.confirm.
     * Input, capacity and HTTP failures use MessageOperationError for deleteOwnMessages
     */
    deleteOwnMessages(
        channelId: string,
        options: DefaultOwnMessageDeletionOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
}
