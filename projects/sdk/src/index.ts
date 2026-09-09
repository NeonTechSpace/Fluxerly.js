import {
    type WebhookOperationError,
    type Webhook,
    type CreatedWebhook,
    type WebhookCreate,
    type WebhookEdit,
    type WebhookMessageInput,
    type WebhookMessageEdit,
    type WebhookClientOptions,
    type WebhookOperationFailure,
    type DefaultWebhookOperationOptions,
} from "./webhooks.js"
export { WebhookOperationError } from "./webhooks.js"
export type {
    Webhook,
    WebhookCredentials,
    CreatedWebhook,
    WebhookCreate,
    WebhookEdit,
    WebhookMessageInput,
    WebhookMessageEdit,
    WebhookClientOptions,
    WebhookOperation,
    WebhookOperationOptions,
    DefaultWebhookOperationOptions,
    WebhookOperationFailure,
} from "./webhooks.js"
import {
    makeWebhookClient,
    webhookCreate,
    webhookFetch,
    webhookList,
    webhookEdit,
    webhookDelete,
    webhookSend,
    webhookMessage,
    webhookMessageDelete,
} from "#sdk/internal/webhooks"
import { Cause, Deferred, Effect, Exit, Scope } from "effect"
import {
    PaginationError,
    type HistoryIterationQuery,
    type UserIterationQuery,
    type PinIterationQuery,
    type PaginationOperation,
} from "./pagination.js"
export { PaginationError } from "./pagination.js"
export type {
    PaginationQuery,
    HistoryIterationQuery,
    UserIterationQuery,
    PinIterationQuery,
    PaginationOperation,
} from "./pagination.js"
import {
    historyPagination,
    memberPagination,
    reactionUserPagination,
    pinPagination,
    iterationOptions,
    type Pagination,
} from "#sdk/internal/pagination"
export type {
    EmbedInput,
    EmbedAuthorInput,
    EmbedFooterInput,
    EmbedMediaInput,
    EmbedFieldInput,
    Embed,
    EmbedChild,
    EmbedAuthor,
    EmbedFooter,
    EmbedMedia,
    EmbedField,
} from "./embeds.js"
export type { MessageBody } from "./messages.js"
export type { Attachment, AttachmentInput, AttachmentReference } from "./attachments.js"
import type { ReactionEmojiInput, ReactionUsersQuery, ReactionUsersPage } from "./reactions.js"
export type {
    ReactionEmojiInput,
    ReactionUsersQuery,
    ReactionUsersPage,
    ReactionUser,
    ReactionEmoji,
    ReactionTarget,
    MessageReaction,
    MessageReactionBatch,
    MessageReactionEmojiRemoval,
} from "./reactions.js"
import { err, ok, ResultAsync, type Result } from "neverthrow"
export type { LoggingOptions, DefaultLoggingOptions, DefaultLogger } from "./logging.js"
export type { CachePolicyErrorReport, MessageCacheSettings, MessageCacheOptions } from "./cache.js"
export type { ResourceCacheSettings } from "./cache.js"
import type { ClientState, ClientOptions, ConnectionState, OperationOptions } from "./client.js"
import type {
    PermissionOverwrite,
    GuildChannel,
    ChannelCreate,
    ChannelEdit,
    ChannelPosition,
    ChannelOperationError,
    ChannelOperationFailure,
    DefaultChannelOperationOptions,
} from "./channels.js"
export { ChannelOperationError, ChannelType } from "./channels.js"
export type {
    PermissionOverwrite,
    GuildChannel,
    ChannelCreateBase,
    TextChannelCreate,
    VoiceChannelCreate,
    CategoryChannelCreate,
    LinkChannelCreate,
    ChannelCreate,
    ChannelEdit,
    ChannelPosition,
    GuildChannelUpdateBulk,
    ChannelOperation,
    ChannelOperationFailure,
    ChannelOperationOptions,
    DefaultChannelOperationOptions,
} from "./channels.js"
import {
    channelFetch,
    channelList,
    channelCreate,
    channelEdit,
    channelDelete,
    channelReorder,
    permissionSet,
    permissionRemove,
} from "#sdk/internal/channels"
import {
    GuildOperationError,
    type Guild,
    type GuildRole,
    type RoleReference,
    type RolePosition,
    type RoleCreate,
    type RoleEdit,
    type GuildMember,
    type MemberReference,
    type MemberQuery,
    type GuildOperationFailure,
    type DefaultGuildOperationOptions,
} from "./guilds.js"
export { GuildOperationError, Permissions } from "./guilds.js"
export type {
    Guild,
    GuildRole,
    GuildRoleUpdateBulk,
    RoleReference,
    RolePosition,
    RoleCreate,
    RoleEdit,
    GuildMember,
    MemberReference,
    MemberQuery,
    GuildOperation,
    GuildOperationFailure,
    GuildOperationOptions,
    DefaultGuildOperationOptions,
} from "./guilds.js"
import {
    guildFetch,
    memberFetch,
    memberSelf,
    memberPage,
    memberRole,
    roleList,
    roleCreate,
    roleEdit,
    roleDelete,
    roleReorder,
} from "#sdk/internal/guilds"
import { memberTimeout, memberKick, guildBan, guildUnban, guildBans } from "#sdk/internal/moderation"
import type { BanInput, GuildBan, DefaultModerationOptions } from "./guilds.js"
export type { BanInput, GuildBan, ModerationOptions, DefaultModerationOptions } from "./guilds.js"
import {
    CancelledError,
    ConfigurationError,
    SdkDefect,
    type ConnectError,
    type ConnectionFailure,
    type DefectReason,
    type Operation,
} from "./errors.js"
import { makeClient } from "#sdk/internal/client"
import type { MessagePinsQuery, MessagePinsPage } from "./pins.js"
export type { MessagePinsQuery, MessagePinsPage, MessagePin, ChannelPinsUpdate } from "./pins.js"
import { collect, type MessageCollector } from "#sdk/internal/collector"
import { collectReactions } from "#sdk/internal/reaction-collector"
import type { DefaultReactionCollectorOptions, ReactionCollectorResult } from "./collectors.js"
export type {
    ReactionCollectorOptions,
    DefaultReactionCollectorOptions,
    ReactionCollectorResult,
} from "./collectors.js"
import {
    CollectorError,
    type CollectorFailure,
    type CollectorRegistrationError,
    type CollectorResult,
    type DefaultCollectorOptions,
} from "./collectors.js"
export { CollectorError } from "./collectors.js"
export type {
    CollectorOptions,
    DefaultCollectorOptions,
    CollectorResult,
    CollectorFailure,
    CollectorRegistrationError,
} from "./collectors.js"
import { replyInput } from "#sdk/internal/message"
import type { EventSource } from "#sdk/internal/events"
import {
    MessageError,
    MessageOperationError,
    type MessageOperationFailure,
    type EventOverflowError,
    type EventReadError,
    type RegistrationError,
    type SendError,
} from "./message-errors.js"
import type {
    EditMessageInput,
    MessageHistoryQuery,
    Message,
    MessageReference,
    MessageInput,
    ReplyInput,
    DefaultMessageOperationOptions,
    DefaultSendOptions,
} from "./messages.js"
import type { EventBufferOptions, HandlerOptions, HandlerErrorReport, EventMap, EventName } from "./events.js"

export { EventOverflowError, EventReadBusyError, MessageError, MessageOperationError } from "./message-errors.js"
export type { EventReadError, RegistrationError, SendError, MessageOperationFailure } from "./message-errors.js"
export type {
    Message,
    MessageHistoryQuery,
    MessageDeletion,
    MessageBulkDeletion,
    MessageReference,
    MessageInput,
    ReplyInput,
    AllowedMentions,
    SendOptions,
    DefaultSendOptions,
    EditMessageInput,
    MessageOperationOptions,
    DefaultMessageOperationOptions,
} from "./messages.js"
export type { EventBufferOptions, HandlerOptions, HandlerErrorReport, EventMap, EventName } from "./events.js"

/** Subscription-local controls. Closing a subscription does not close the client */
export interface Subscription {
    /** Stop new deliveries, discard pending events and signal active callbacks. Cannot forcibly stop application promises */
    unsubscribe(): void
    /**
     * Observe retained closure or overflow after SDK cleanup, not completion of arbitrary application promises.
     * Cancelling this wait affects only the wait. Late observers retain the same outcome.
     * Unexpected cleanup defects reject with SdkDefect
     */
    waitForClose(options?: OperationOptions): ResultAsync<void, EventOverflowError | CancelledError>
}

/** Live subscription for one event type without subscription history. The default type preserves existing messageCreate annotations */
export interface EventSubscription<K extends EventName = "messageCreate"> extends Subscription {
    /**
     * Read the next payload for this event name, or null after normal closure. Only one pending read is accepted.
     * Concurrent reads return EventReadBusyError. Cancellation releases only this read.
     * Overflow remains a typed failure after the queue is discarded. SDK defects reject with SdkDefect
     */
    next(options?: OperationOptions): ResultAsync<EventMap[K] | null, EventReadError | CancelledError>
}

/** Default callback scheduling and optional safe error reporting */
export interface EventHandlerOptions extends HandlerOptions {
    /**
     * Report failures without payloads. Reporter failure produces one safe fallback log, never a retry.
     * At most one custom report is outstanding per registration. Further reports use the default logger while it is busy.
     * Reporter promises remain application-owned and do not delay subscription closure
     */
    readonly onError?: (report: HandlerErrorReport) => void | Promise<void>
}

/**
 * Client-owned message operations. REST and local lookup work without a gateway connection. Collection requires Connected.
 * Remote calls share four active HTTP slots and at most 256 queued requests or 4 MiB of queued JSON bodies.
 * Each remote call defaults to a 30,000 ms total deadline, including admission, retry and rate waits, with cleanup awaited afterward
 *
 * fetch, fetchHistory, fetchReactionUsers and fetchPins retry fetch transport failures and HTTP 500/502/503/504 at most twice.
 * Retry delays are jittered 125–250 ms then 250–500 ms, or a valid longer Retry-After. Retries never reset the deadline.
 * Reads retry the same target/query through the bounded queue, without snapshot isolation. Other rejections and malformed successes never retry.
 * Confirmed 429 retries retain their existing route/global waits and do not consume the two transient-read retries.
 * Mutations retry only confirmed rate-limit rejections, never uncertain writes.
 * Expected failures use Err. SDK/cleanup defects reject remote calls with SdkDefect and throw from synchronous get.
 * Cancellation fails this operation with CancelledError. Client closure fails pending/new operations with ClientClosedError.
 * Neither failure proves that a dispatched mutation was undone
 */
export interface Messages {
    /** Traverse remote history newest-to-oldest, without connecting or prefetching another page.
     * Returns a reusable AsyncIterable, not a started request. Each consumption copies inputs and owns independent progress
     *
     * maxItems is required. pageSize/maxPages follow PaginationQuery. timeoutMs applies separately to each remote page
     *
     * Yields frozen snapshots as Ok values. One expected failure or cancellation is yielded as Err, then iteration ends.
     * PaginationError identifies invalid traversal input, cursorStalled or pageLimit. Remote errors keep fetchHistory's operation.
     * SDK defects reject with SdkDefect, including combined failure/cleanup defects. Already-emitted items are not rolled back
     *
     * break/return releases buffered items. To interrupt an in-flight next call, abort the supplied signal and await it.
     * Closing/Closed fail on the next pull and release buffered snapshots. No listener is retained after completion or early exit
     *
     * Retains one bounded page, not the full result. Enabled message caching follows fetchHistory's normal admission.
     * Stops on an empty remote page or maxItems, not on a short page. Separate pages are not a consistent snapshot
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
    ): AsyncIterable<Result<Message, MessageOperationFailure | PaginationError | CancelledError>>
    /** Traverse ascending remote user IDs for one message and the selected literal Unicode or custom emoji.
     * Uses iterateHistory's lazy Result, cancellation, deadline, failure and release rules, with fetchReactionUsers remote errors.
     * Stops at maxItems or the server's hasMore=false. No reactor cache or automatic member lookup is added.
     * These observations are not a stable voter list. A later removal can invalidate an earlier observation
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
     * An undefined result means not found within the bounded scan, not proof that the user has never reacted
     */
    iterateReactionUsers(
        message: MessageReference,
        emoji: ReactionEmojiInput,
        query: UserIterationQuery,
        options?: DefaultMessageOperationOptions,
    ): AsyncIterable<
        Result<import("./reactions.js").ReactionUser, MessageOperationFailure | PaginationError | CancelledError>
    >
    /** Traverse remote pins in descending timestamp order, without populating the message cache.
     * Uses iterateHistory's lazy Result, cancellation, deadline, failure and release rules, with fetchPins remote errors.
     * PinIterationQuery defines per-run deduplication and completeness limits. Retains at most maxItems deduplication IDs.
     * Valid items from a stalled page can be emitted before cursorStalled appears on the next pull.
     * Stop at maxItems or hasMore=false. Timestamp ties can prevent enumerating every pin, even without concurrent edits
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
    ): AsyncIterable<Result<import("./pins.js").MessagePin, MessageOperationFailure | PaginationError | CancelledError>>
    /**
     * Pin one message identified by decimal id and channelId, without requiring gateway readiness.
     * Starts immediately. AbortSignal cancellation returns CancelledError and unexpected defects reject with SdkDefect.
     * Complete on HTTP 204, not event delivery. Fluxer enforces channel access and PIN_MESSAGES for guild pins.
     * A new pin creates a system message and gateway notifications. Already-pinned targets are unchanged.
     * Share bounded REST admission and the per-channel pins rate bucket with unpin/fetchPins.
     * Default deadline is 30,000 ms. Only confirmed 429 rejection permits automatic retry within that deadline
     *
     * Expected failures use MessageOperationError operation pin, or ClientClosedError after shutdown.
     * Local invalid input is notDispatched. Lost responses/cancellation cannot prove whether the server applied the pin
     *
     * Confirmed or uncertain mutations evict the cached target, without guessing pinned status or fetching it.
     * No automatic unpin or rollback. No locally synthesized events
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
     * The caller owns error recovery and client lifetime. These calls are not an atomic transaction
     */
    pin(
        message: MessageReference,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError>
    /**
     * Unpin one explicit message using pin's admission, deadline, retry, cancellation and cache-invalidation rules.
     * Starts immediately. AbortSignal cancellation returns CancelledError and unexpected defects reject with SdkDefect.
     * Complete on HTTP 204, including an already-unpinned message. Expected failures identify operation unpin.
     * Fluxer enforces the same permissions as pin. Closing/Closed clients fail with ClientClosedError.
     * Unpinning does not delete the message or the system message created by pinning, and does not reset the last-pin timestamp.
     * No gateway readiness, automatic rollback, event synthesis or confirmation fetch
     */
    unpin(
        message: MessageReference,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError>
    /**
     * Fetch one frozen pin page for a decimal channel ID, without gateway readiness, cache reads or cache population.
     * Starts immediately. AbortSignal cancellation returns CancelledError and unexpected defects reject with SdkDefect
     *
     * Query defaults to limit 50 and the server's current time. Limit is 1 through 50 and before is an ISO timestamp
     *
     * Results use descending pin-time order with preserved pinnedAt values and an explicit nextBefore cursor.
     * Timestamp ties may repeat messages across pages. Deduplicate IDs and stop on a non-advancing cursor.
     * No automatic traversal, complete-list guarantee, pin acknowledgement or snapshot isolation.
     * Share pin's admission, 30,000 ms default deadline and per-channel rate bucket, using Messages' bounded read-retry policy
     *
     * Invalid input and malformed responses use MessageOperationError operation fetchPins without partial pages.
     * Visibility/history permissions can limit results. An empty page does not prove the channel has no pins.
     * Closing/Closed uses ClientClosedError. Returned messages are observations, not live state
     */
    fetchPins(
        channelId: string,
        query?: MessagePinsQuery,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<MessagePinsPage, MessageOperationFailure | CancelledError>
    /**
     * Remove one named user's reaction, leaving other users and emoji groups untouched.
     * userId is a required decimal ID; naming the bot removes its own reaction.
     * Uses addReaction's emoji inputs, REST admission, 30,000 ms default deadline, retry and cancellation rules.
     * No gateway readiness is required. Complete on HTTP 204, without waiting for or synthesizing events.
     * Fluxer enforces visibility and history access; for another user, the bot must author the message or have MANAGE_MESSAGES in its guild
     *
     * Expected failures use MessageOperationError with operation removeUserReaction, or ClientClosedError.
     * Calls start immediately; AbortSignal cancellation returns CancelledError and defects reject with SdkDefect.
     * Cleanup is awaited, but cannot undo a dispatched deletion. Only confirmed 429 rejections retry.
     * Success means absent or removed, not proof the reaction existed. Unknown outcomes are not replayed.
     * No cache mutation, automatic restoration or per-user state is retained; the bot cannot restore another user's reaction as them
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
    ): ResultAsync<void, MessageOperationFailure | CancelledError>
    /**
     * Delete every user's reaction for one emoji, preserving other emoji groups.
     * Uses removeUserReaction's execution, permission, deadline, failure and cleanup rules, with operation clearReaction.
     * Complete on HTTP 204. Success does not prove reactions existed or that this call removed them.
     * Fluxer emits a clear-emoji event, not individual removal events; the SDK does not synthesize or await it.
     * Destructive: Other users' reactions cannot be restored by the bot as those users
     */
    clearReaction(
        message: MessageReference,
        emoji: ReactionEmojiInput,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError>
    /**
     * Delete every user's reactions for every emoji on this message, without deleting the message.
     * Uses clearReaction's execution, permission, deadline, failure and cleanup rules, with operation clearReactions.
     * Takes no emoji selector. Complete on HTTP 204, whether reactions were present or absent.
     * Fluxer emits one clear-all event, not per-emoji or per-user events; the SDK does not synthesize or await it.
     * Destructive: Other users' reactions cannot be restored by the bot as those users
     */
    clearReactions(
        message: MessageReference,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError>
    /**
     * Fetch one frozen page of users who currently hold the specified reaction, without requiring gateway readiness.
     * Accept the same literal Unicode or custom emoji input as addReaction.
     * limit defaults to 25 (1–100); after is an exclusive user-ID cursor in ascending order, not reaction time.
     * Empty reactions return an empty terminal page. No automatic pagination, user cache or message-cache changes.
     * Pages are separate observations: Reactions may change between requests; no complete or atomic snapshot is promised
     *
     * Use the shared 30,000 ms deadline by default, overridden by options.timeoutMs.
     * Share bounded REST admission, global limits and the channel bucket used by reaction mutations.
     * Uses Messages' bounded read-retry policy within the original deadline, including separate confirmed-429 waits
     *
     * Invalid inputs, malformed pages, HTTP rejections, transport and deadlines use MessageOperationError with operation fetchReactionUsers.
     * HTTP 404 means notFound; permission/history visibility is enforced by Fluxer. Closed clients use ClientClosedError.
     * Calls start immediately; AbortSignal cancellation awaits owned request cleanup and returns CancelledError. Unexpected defects reject with SdkDefect
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
    ): ResultAsync<ReactionUsersPage, MessageOperationFailure | CancelledError>
    /**
     * Add the bot's own reaction and complete after HTTP 204, without waiting for or synthesizing a gateway event.
     * Accept literal Unicode or a custom { name, id }; Fluxer owns emoji availability and permission checks
     *
     * No gateway readiness is required. Use the shared 30,000 ms deadline by default; timeoutMs overrides it.
     * Share bounded REST admission and global rate limits, with a channel reaction bucket separate from message operations.
     * Only confirmed rate-limit rejections retry within the original deadline; uncertain outcomes are never retried
     *
     * Input, admission, rejection, transport and timeout failures use MessageOperationError; closed clients use ClientClosedError.
     * Calls start immediately. Cancellation awaits owned cleanup but cannot undo a dispatched reaction.
     * Unexpected defects reject with SdkDefect
     *
     * Existing own reactions are idempotent server-side. No local reaction state, counts or reactor lists are retained
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
    ): ResultAsync<void, MessageOperationFailure | CancelledError>
    /**
     * Remove only the bot's own reaction and complete after HTTP 204.
     * Uses addReaction's input, admission, timeout, retry, failure and cancellation rules.
     * Success does not prove the reaction previously existed or that this call removed it.
     * Other users' reactions are untouched. Neither this operation nor gateway reaction events alter the message cache
     */
    removeReaction(
        message: MessageReference,
        emoji: ReactionEmojiInput,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError>
    /**
     * Start a bounded collection of future messageCreate observations in one decimal channel ID.
     * Returns a ready handle synchronously. Register before sending a prompt. No history, cache reads or implicit connection
     *
     * Defaults: One accepted message, 30,000 ms total lifetime, 4 MiB retained Message JSON.
     * Pending intake is separately bounded to 256 payloads or 4 MiB source JSON, after channel selection and before filtering.
     * Options are copied at registration. Positive safe integer budgets are required. The timeoutMs maximum is 2,147,483,647.
     * Timeout starts at registration, never resets, and excludes messages processed at or after the deadline
     *
     * Selection is synchronous and counts each accepted ID once. Edits/deletions leave received snapshots unchanged.
     * Filter failure or either byte/queue overflow ends only this collector, without partial messages in the error.
     * Recovery fails collection with CollectorError connectionLost even if the client later resumes. No automatic restart or resend
     *
     * Non-connected registration fails with CollectorError notConnected. Closing/Closed use ClientClosedError.
     * Invalid settings use ConfigurationError. The optional signal controls collection and abort returns CancelledError.
     * An already-aborted signal starts no collection. Unexpected registration defects throw SdkDefect
     *
     * Optional onMessage runs sequentially after filtering, ID deduplication and retained-byte admission.
     * Limit completion waits for the final callback. Timeout/stop may retain a message whose callback was cancelled.
     * Once the accepted count is reached, later messages are ignored while the final callback finishes.
     * Handler failure ends this collector with CollectorError handler. Closure waits for returned callback work.
     * Pending budgets exclude the active message. Callbacks are never retried and their effects are not rolled back
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     *
     * export async function askName(client: Client, channelId: string, userId: string) {
     *     const opened = client.messages.collect(channelId, { filter: message => message.author.id === userId })
     *     if (opened.isErr()) throw opened.error
     *     const collector = opened.value
     *     try {
     *         const sent = await client.messages.send(channelId, { content: "What should I call you?" })
     *         if (sent.isErr()) throw sent.error
     *         const result = await collector.waitForClose()
     *         if (result.isErr()) throw result.error
     *         return result.value
     *     } finally {
     *         collector.stop()
     *     }
     * }
     * ```
     * The caller supplies a connected client and handles empty timeout results and client lifetime separately
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     *
     * export async function messageCollectorProgressExample(client: Client, channelId: string, userId: string) {
     *     const opened = client.messages.collect(channelId, {
     *         filter: message => message.author.id === userId,
     *         maxMessages: 3,
     *         onMessage: async (message, signal) => {
     *             const reply = await client.messages.reply(message, { content: "Received your reply" }, { signal })
     *             if (reply.isErr()) throw reply.error
     *         },
     *     })
     *     if (opened.isErr()) throw opened.error
     *     return await opened.value.waitForClose()
     * }
     * ```
     * The author filter must exclude the bot itself to avoid collecting its acknowledgements
     */
    collect(
        channelId: string,
        options?: DefaultCollectorOptions,
    ): Result<Collector, CollectorRegistrationError | CancelledError>
    /**
     * Synchronously register future reaction additions on one message with decimal id and channelId.
     * Register before the expected reaction. No REST request, existing-reactor lookup, implicit connect or cache reads
     *
     * Defaults: One accepted addition, 30,000 ms total lifetime and 4 MiB retained MessageReaction JSON.
     * Copy target IDs and options at registration. Pending intake allows 256 payloads or 4 MiB full source JSON.
     * Message selection precedes buffering; synchronous user/emoji filtering follows it
     *
     * Optional emoji uses addReaction's input shape and matches before filter, after queue admission.
     * Unicode requires exact text and no custom ID; custom emoji match by ID, ignoring renames. Invalid selectors use ConfigurationError emoji
     *
     * Single additions and received batches share receive order; batch entries retain their order and count individually.
     * A batch occupies one pending slot. Repeated user/emoji pairs count again. No batching flag is enabled.
     * Removals, clears and message deletion neither undo observations nor stop collection. This is not a vote tally
     *
     * The total deadline never resets and excludes observations processed at or after it, including slow filter returns
     *
     * Filter/overflow failures use CollectorError without partial results. Recovery fails with connectionLost, without restart.
     * Require Connected or return CollectorError notConnected. Closing/Closed use ClientClosedError.
     * Invalid target/options use ConfigurationError. Signal abort returns CancelledError; pre-abort starts no collection.
     * Unexpected registration defects throw SdkDefect. Registration does not verify remote message existence or access.
     * Optional onReaction runs after acceptance and byte admission, sequentially, before the next addition is processed.
     * The final accepted callback must finish before limit completion. Timeout/stop can retain an addition whose callback was cancelled.
     * Pending budgets exclude the active payload, including its unprocessed batch entries. No callback retries or vote reconstruction.
     * Callback failure ends this collector with CollectorError handler. Terminal completion waits for returned callback work
     *
     * @example
     * ```ts
     * import type { Client, MessageReference } from "@neontechspace/fluxerly"
     *
     * export async function reactionCollectorExample(client: Client, message: MessageReference, userId: string) {
     *     let count = 0
     *     const opened = client.messages.collectReactions(message, {
     *         maxReactions: 3,
     *         emoji: "✅",
     *         filter: reaction => reaction.userId === userId,
     *         onReaction: async (_reaction, signal) => {
     *             const edited = await client.messages.edit(message, { content: `Accepted additions: ${++count}` }, { signal })
     *             if (edited.isErr()) throw edited.error
     *         },
     *     })
     *     if (opened.isErr()) throw opened.error
     *     try {
     *         const result = await opened.value.waitForClose()
     *         if (result.isErr()) throw result.error
     *         return result.value
     *     } finally {
     *         opened.value.stop()
     *     }
     * }
     * ```
     * The caller supplies a connected client and an existing message; timeout may return no reactions
     */
    collectReactions(
        message: MessageReference,
        options?: DefaultReactionCollectorOptions,
    ): Result<ReactionCollector, CollectorRegistrationError | CancelledError>
    /**
     * Read this client's local retained snapshot synchronously, never making a request.
     * Disabled caching, absent/evicted/expired entries and a mismatched channel return Ok(undefined), not server absence.
     * Hits return frozen observations, not guaranteed current server state, and update LRU recency without renewing age.
     * Invalid references return MessageOperationError with operation get, reason input and outcome notDispatched.
     * Closing/Closed return ClientClosedError. Unexpected synchronous defects throw SdkDefect
     */
    get(message: MessageReference): Result<Message | undefined, MessageOperationFailure>
    /**
     * Send text, embeds and/or files and return the decoded message after HTTP, not gateway delivery or recipient acknowledgement
     *
     * File bytes are snapshotted on invocation, up to 50 MiB per file and the separate uploads.maxBytes client budget.
     * Full upload admission fails with busy before copying. No path access or downloads; servers may impose lower limits.
     * Cleanup releases owned bytes; failed uploads may leave temporary server data, with no physical-erasure guarantee
     *
     * Mentions are disabled by default. Total budget defaults to 30,000 ms including admission and rate waits.
     * Enabled caching retains eligible created snapshots without changing send completion or delivery
     *
     * One client admits four active HTTP requests and at most 256 pending bodies or 4 MiB of pending JSON.
     * Confirmed rate-limit rejections may retry within that budget. Uncertain sends never retry automatically
     *
     * Cancellation after dispatch may leave a created message. There is no rollback or exactly-once guarantee.
     * Expected failures use Err. SDK/cleanup defects reject with SdkDefect
     */
    send(
        channelId: string,
        input: MessageInput,
        options?: DefaultSendOptions,
    ): ResultAsync<Message, SendError | CancelledError>
    /**
     * Reference an existing message through send. Missing targets fail rather than falling back to an unreferenced send.
     * The returned reply is eligible for the same cache intake as send.
     * File inputs use send's snapshot, size, budget and cleanup rules
     */
    reply(
        message: MessageReference,
        input: ReplyInput,
        options?: DefaultSendOptions,
    ): ResultAsync<Message, SendError | CancelledError>
    /**
     * Fetch a frozen message snapshot from Fluxer, never from a cache. Accepts a reference or an existing Message.
     * Returns after the API response is decoded and its message/channel IDs match the requested target.
     * Missing targets fail with MessageOperationError reason notFound rather than returning an empty value.
     * Enabled caching retains eligible responses, but the returned result does not depend on cache admission.
     * Cancellation releases only this request and awaits its cleanup.
     * Uses Messages' bounded read-retry policy; callers need no retry loop for its eligible transient failures
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
    ): ResultAsync<Message, MessageOperationFailure | CancelledError>
    /**
     * Fetch one remote history page for a decimal channel ID, without requiring a gateway connection or consulting a cache.
     * Defaults to the latest 50 messages. Query limit is 1 through 100 with at most one before, after or around cursor
     *
     * Returns after HTTP 200 and validation of the entire page as a frozen array of frozen Message snapshots, newest first.
     * Empty and short arrays describe currently accessible results, not complete history. Pages are not a shared point-in-time snapshot.
     * No prefetch, automatic traversal or gateway notifications. Use the oldest returned ID as before for an older page
     *
     * Enabled caching admits eligible page members oldest first, so tight limits retain the newest members
     *
     * Invalid input, malformed pages and HTTP rejections use MessageOperationError with operation fetchHistory. HTTP 404 remains notFound.
     * Shares REST admission and the 30,000 ms default total deadline, using Messages' bounded read-retry policy.
     * Cancellation affects only this call and awaits cleanup. Closing/Closed fail with ClientClosedError and defects reject with SdkDefect
     */
    fetchHistory(
        channelId: string,
        query?: MessageHistoryQuery,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<readonly Message[], MessageOperationFailure | CancelledError>
    /**
     * Replace text/embeds/files and return the frozen updated snapshot after the API response, without waiting for a gateway event.
     * Supplied values replace those fields; omitted values are not sent. No hidden fetch or cache merge
     *
     * List retained attachment IDs alongside new uploads; unknown IDs may be ignored by Fluxer
     *
     * Clear files with attachments: [] and nonempty text or embeds. Uploads use send's snapshot, budget and cleanup rules
     *
     * To remove embeds, send nonempty content alongside embeds: []; an empty edit alone is rejected by Fluxer.
     * Empty content requests clearing text, subject to Fluxer validation. Mentions default off.
     * Omitted rich embeds are preserved, but Fluxer may regenerate text-derived link previews
     *
     * Enabled caching retains eligible responses. An uncertain dispatched edit evicts the old local copy.
     * A lost response or timeout after dispatch may leave the edit applied. Uncertain edits never retry automatically.
     * Missing targets remain typed notFound failures. Cancellation/closure cannot undo a dispatched edit
     */
    edit(
        message: MessageReference,
        input: EditMessageInput,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<Message, MessageOperationFailure | CancelledError>
    /**
     * Delete the target and complete without a value after HTTP 204, without waiting for a gateway event.
     * Missing targets fail with MessageOperationError reason notFound, including a repeated delete.
     * Confirmed deletion and uncertain dispatched deletion evict the local cached copy.
     * A lost response or timeout after dispatch may leave the target deleted. Uncertain deletes never retry automatically.
     * Cancellation/closure awaits owned cleanup but cannot undo a dispatched deletion
     */
    delete(
        message: MessageReference,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError>
    /**
     * Delete 1–100 distinct decimal message IDs from one guild channel, requiring ManageMessages permission.
     * Starts immediately without a gateway connection. No hidden selection, chunking, age filter or audit reason.
     * HTTP 204 completes with no value, not a deletion count or proof that each ID existed. Missing messages are ignored.
     * Dispatched requests evict selected cached messages even on rejection, since partial deletion is possible.
     * Only confirmed rate-limit rejections retry. A timeout, lost response, cancellation or closure cannot undo deletion.
     * Input/admission/HTTP failures use MessageOperationError. Cancellation returns CancelledError after owned cleanup.
     * Unexpected defects reject with SdkDefect. The IDs are copied when execution starts
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
    ): ResultAsync<void, MessageOperationFailure | CancelledError>
}

/** One default collection, independent of observers and the client's connection lifetime */
export interface Collector {
    /** Request stop synchronously with accepted partial replies. Use waitForClose to await callback cleanup. Repeated calls preserve the first outcome */
    stop(): void
    /**
     * Observe the retained frozen result after timer, queue, filter, listener and callback cleanup.
     * Multiple and late observers share the same result/error. Cancelling this wait affects only this observer.
     * Timeout/stop may return empty results. Collection cancellation, filter/handler/overflow/gap failure or client closure returns Err without partial replies.
     * Unexpected SDK defects reject with SdkDefect. Keeping the handle/result retains successful message snapshots in memory
     */
    waitForClose(options?: OperationOptions): ResultAsync<CollectorResult, CollectorFailure | CancelledError>
}

/** One default reaction collection, independent of each result observer */
export interface ReactionCollector {
    /** Stop synchronously with accepted partial observations. Repeated calls preserve the first outcome */
    stop(): void
    /**
     * Observe the frozen result after queue, timer, filter, listener and callback cleanup; late/multiple observers share the outcome.
     * Cancelling this wait stops only this observer. Timeout/stop may succeed with empty or partial observations.
     * Collection abort, filter/handler/overflow/gap failure and client shutdown return Err without partial observations.
     * Unexpected defects reject with SdkDefect. Keeping the handle/result retains successful snapshots in memory
     */
    waitForClose(options?: OperationOptions): ResultAsync<ReactionCollectorResult, CollectorFailure | CancelledError>
}

export type { ClientOptions, ConnectionState, OperationOptions } from "./client.js"
export {
    AuthenticationError,
    CancelledError,
    ClientBusyError,
    ClientClosedError,
    ConfigurationError,
    ConnectionError,
    ConnectionTimeoutError,
    RateLimitError,
    SdkDefect,
} from "./errors.js"
export type { ConnectError, ConnectionFailure, DefectReason } from "./errors.js"

/** Explicit guild reads, bans and optional local lookup, independent of gateway readiness.
 * Shares the client's four HTTP slots, 256 pending requests and 4 MiB pending JSON budget with message/member/role operations.
 * Total deadline defaults to 30,000 ms, including waits. Reads retry transport failures and HTTP 500/502/503/504 at most twice.
 * Backoff is 125–250 ms then 250–500 ms, honoring longer Retry-After. Confirmed 429 waits are separate and never reset the deadline
 *
 * Input, 404, permission failures and malformed successes do not retry. Expected failures use GuildOperationError.
 * Abort returns CancelledError after cleanup; closing clients use ClientClosedError and unexpected defects reject with SdkDefect
 */
export interface Guilds {
    /** Ban a decimal guild/user target, including a user who is not currently a member.
     * Requires BanMembers and provider hierarchy/MFA rules. Defaults to permanent with no message deletion
     *
     * HTTP 204 returns no value, not event acknowledgement. Writes retry only confirmed 429 rejections.
     * Failure after dispatch may leave a ban and separately queued message deletion applied
     *
     * Dispatched actions invalidate this member's retained snapshot even on rejection.
     * Requested message cleanup evicts this author's cached messages across guilds, since messages lack guild IDs.
     * The cleanup job can finish later. A later cache hit does not establish that its message survived the job
     *
     * Bans may also block rejoining through provider-side IP/email checks. Unban restores neither messages nor membership.
     * Starts immediately. Cancellation awaits cleanup and returns CancelledError. Defects reject with SdkDefect.
     * Invalid input and HTTP failures use GuildOperationError, while a closed client uses ClientClosedError
     */
    ban(
        target: MemberReference,
        input?: BanInput,
        options?: DefaultModerationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError>
    /** Remove a ban after HTTP 204, without rejoining the user or cancelling queued message deletion.
     * Requires BanMembers. A user who is not banned is an API failure, not a successful no-op.
     * Uses ban's execution, failure, cleanup and member-cache invalidation rules
     */
    unban(
        target: MemberReference,
        options?: DefaultModerationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError>
    /** Fetch the provider's full ban list as frozen observations, requiring BanMembers.
     * Always remote, without a ban cache, pagination or guaranteed order. Separate reads are not a consistent snapshot.
     * Starts immediately. Uses shared guild read deadline/retry rules, rejecting malformed responses as a whole
     */
    fetchBans(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly GuildBan[], GuildOperationFailure | CancelledError>
    /** Synchronously read the enabled guild cache without HTTP or requiring a connection.
     * Returns undefined when disabled, absent, expired or evicted. Snapshots may be stale. Use fetch for a remote observation.
     * Invalid decimal IDs fail with GuildOperationError(input). Closing/closed clients fail with ClientClosedError.
     * Unexpected defects throw SdkDefect. Lookup updates LRU order but never extends expiry
     */
    get(guildId: string): Result<Guild | undefined, GuildOperationFailure>
    /** Fetch a frozen identity/configuration projection for a decimal guild ID. Fluxer requires guild membership.
     * No embedded member/role/channel state is retained and no counts or completeness guarantee are inferred
     */
    fetch(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<Guild, GuildOperationFailure | CancelledError>
}

/** Immediate guild-channel reads and mutations, independent of gateway readiness
 *
 * DM operations are outside this API contract. Supply decimal guild-channel IDs. ID-targeted writes do not prefetch or verify their guild type.
 * Shares the client's four HTTP slots, 256 pending requests and 4 MiB pending JSON budget with guild/member/role/message operations.
 * Total deadline defaults to 30,000 ms, including admission, retry and rate waits. Reads retry transport failures and HTTP 500/502/503/504 at most twice.
 * Writes retry only confirmed 429 responses. Permission, input, 404 and malformed-response failures do not retry
 *
 * All dispatched channel mutations invalidate the whole enabled channel cache. Pre-dispatch input failures preserve it, and this API never follows a write with an implicit fetch.
 * Operation inputs are copied when the call starts and later caller mutations are not observed. Permission bits are bigint values encoded as decimal JSON strings.
 * Fluxer enforces channel permissions and grant restrictions. Targeted overwrite operations require ManageRoles for role and member targets.
 * Expected failures use ChannelOperationError or ClientClosedError. Abort returns CancelledError after cleanup. Unexpected defects reject with SdkDefect
 */
export interface Channels {
    /** Synchronously read the enabled channel cache without HTTP or requiring a connection.
     * Returns undefined when disabled, absent, expired or evicted. Snapshots may be stale. Use fetch for a remote observation.
     * Invalid decimal IDs fail with ChannelOperationError(input). Closing/closed clients fail with ClientClosedError.
     * Unexpected defects throw SdkDefect. Lookup updates LRU order but never extends expiry
     */
    get(channelId: string): Result<GuildChannel | undefined, ChannelOperationFailure>
    /** Fetch one frozen guild-channel observation by decimal ID, without connecting or populating a complete guild list.
     * A non-guild response is a typed response failure. The result has explicit overwrites only, not inherited or effective permissions
     */
    fetch(
        channelId: string,
        options?: DefaultChannelOperationOptions,
    ): ResultAsync<GuildChannel, ChannelOperationFailure | CancelledError>
    /** Fetch Fluxer's visible guild-channel list for one decimal guild ID, without pagination or a completeness guarantee.
     * The response is a point-in-time observation, not a subscription. It does not fetch members, roles, DMs or missing permission-overwrite targets
     */
    fetchAll(
        guildId: string,
        options?: DefaultChannelOperationOptions,
    ): ResultAsync<readonly GuildChannel[], ChannelOperationFailure | CancelledError>
    /** Create one supported guild channel and return Fluxer's frozen observation. Fluxer chooses its initial position.
     * Omitted permissionOverwrites inherits the selected parent category's overrides. [] creates no explicit overrides, not private visibility
     * @example
     * ```ts
     * import { ChannelType, Permissions, type Client } from "@neontechspace/fluxerly"
     * export async function channelExample(client: Client, guildId: string, botId: string) {
     *     const result = await client.channels.create(guildId, {
     *         type: ChannelType.Text,
     *         name: "private-support",
     *         permissionOverwrites: [
     *             { id: guildId, type: "role", allow: 0n, deny: Permissions.ViewChannel },
     *             { id: botId, type: "member", allow: Permissions.ViewChannel | Permissions.SendMessages, deny: 0n },
     *         ],
     *     })
     *     if (result.isErr()) throw result.error
     *     return result.value
     * }
     * ```
     * The caller owns the created channel. The returned snapshot is not gateway confirmation. Reconcile an unknown outcome with fetchAll before deciding whether to create again
     */
    create(
        guildId: string,
        input: ChannelCreate,
        options?: DefaultChannelOperationOptions,
    ): ResultAsync<GuildChannel, ChannelOperationFailure | CancelledError>
    /** Patch only supplied channel settings and return Fluxer's frozen observation. Empty/unknown-field patches are input errors.
     * Channel type and parent are intentionally not editable here. Move a channel with reorder. Omitted permissionOverwrites preserves them, while [] clears them
     */
    edit(
        channelId: string,
        input: ChannelEdit,
        options?: DefaultChannelOperationOptions,
    ): ResultAsync<GuildChannel, ChannelOperationFailure | CancelledError>
    /** Delete a guild channel and complete after HTTP 204, without waiting for a gateway event or proving a prior channel existed.
     * The SDK does not prefetch to verify the ID. A lost response or timeout after dispatch can leave deletion applied
     */
    delete(
        channelId: string,
        options?: DefaultChannelOperationOptions,
    ): ResultAsync<void, ChannelOperationFailure | CancelledError>
    /** Apply submitted guild-channel moves sequentially and complete after HTTP 204, without fabricating a reordered snapshot.
     * syncPermissionsOnMove copies the target category's overwrites. A bulk channel event can arrive before that permission copy completes.
     * Fluxer may normalize positions. This bulk mutation is not a transaction, so failures can leave partial movement. Refetch when final order matters
     */
    reorder(
        guildId: string,
        positions: readonly ChannelPosition[],
        options?: DefaultChannelOperationOptions,
    ): ResultAsync<void, ChannelOperationFailure | CancelledError>
    /** Replace one explicit role/member overwrite with its supplied raw bigint allow and deny bits, then complete after HTTP 204.
     * Fluxer enforces ManageRoles. This does not calculate inherited/effective permissions or prefetch the target
     */
    setPermissionOverwrite(
        channelId: string,
        input: PermissionOverwrite,
        options?: DefaultChannelOperationOptions,
    ): ResultAsync<void, ChannelOperationFailure | CancelledError>
    /** Remove one explicit role/member overwrite by decimal target ID and complete after HTTP 204.
     * Fluxer enforces ManageChannels and ManageRoles. Other overwrites remain unchanged, and an unknown outcome requires an explicit follow-up read
     */
    removePermissionOverwrite(
        channelId: string,
        targetId: string,
        options?: DefaultChannelOperationOptions,
    ): ResultAsync<void, ChannelOperationFailure | CancelledError>
}

/** Guild membership reads, moderation and targeted role writes, sharing Guilds' admission, deadlines and failure rules.
 * Returned members are frozen observations. Optional retention follows ClientOptions.cache.members, without permission prediction or automatic guild download.
 * Writes retry only confirmed 429 rejections, never uncertain outcomes. Cancellation cannot undo a dispatched write
 */
export interface Members {
    /** Set a timeout for integer durationMs in 1–31,536,000,000 milliseconds, calculated when execution starts
     *
     * Requires ModerateMembers and provider hierarchy rules. The provider rejects self and administrator targets.
     * Queue/network time consumes this duration. An expiry already past at processing time can clear the timeout
     *
     * Returns the frozen HTTP 200 member with communicationDisabledUntil, without waiting for an event.
     * Uses shared guild deadlines and failures. Writes retry only confirmed 429 rejections.
     * Starts immediately, with expected GuildOperationError results and SdkDefect rejections.
     * Cancellation and closure await owned cleanup but cannot undo a dispatched timeout
     *
     * Eligible responses update enabled member caching. Dispatched failures evict the member even on rejection
     * @example
     * ```ts
     * import type { Client, MemberReference } from "@neontechspace/fluxerly"
     * async function moderationExample(client: Client, target: MemberReference) {
     *     return await client.members.timeout(target, 5 * 60_000)
     * }
     * ```
     */
    timeout(
        target: MemberReference,
        durationMs: number,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError>
    /** Clear a timeout with timeout's permissions, execution, cache and failure rules.
     * Sends null, not a negative duration. Returns the HTTP 200 member without waiting for an event
     */
    clearTimeout(
        target: MemberReference,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError>
    /** Kick the selected guild member after HTTP 204, without waiting for a removal event.
     * Requires KickMembers and provider hierarchy rules. Does not ban the user or automatically restore membership.
     * Missing membership is a typed API failure. Dispatched actions invalidate the member cache even on rejection.
     * Uses timeout's execution/deadline/failure rules, with no automatic retry after an uncertain result
     */
    kick(
        target: MemberReference,
        options?: DefaultModerationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError>
    /** Traverse ascending remote user IDs without connecting or downloading the whole guild eagerly.
     * Reusable lazy AsyncIterable of frozen Ok members and at most one terminal Err, with independent state per consumption
     *
     * Copies inputs on consumption. maxItems is required, pageSize defaults to 100 and maxPages to 100.
     * Stop at maxItems or an empty page, not a short page. Pages are not a consistent membership snapshot
     *
     * timeoutMs applies per page. Remote failures keep members.fetchPage's GuildOperationError and shared retry policy.
     * PaginationError covers input, cursorStalled and pageLimit. Aborting the signal yields CancelledError after request cleanup
     *
     * break/return releases the page. Abort the signal to interrupt a pending next. SDK defects reject with SdkDefect.
     * Closing/Closed releases the page and fails the next pull with ClientClosedError. Delivered items remain caller-owned
     *
     * Enabled member caching follows fetchPage admission. Traversal keeps one page and does not fetch roles or predict permissions
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export async function paginationMembersExample(client: Client, guildId: string) {
     *     for await (const result of client.members.iterate(guildId, { maxItems: 1000 })) {
     *         if (result.isErr()) return result
     *         if (!result.value.isBot) return result
     *     }
     *     return undefined
     * }
     * ```
     */
    iterate(
        guildId: string,
        query: UserIterationQuery,
        options?: DefaultGuildOperationOptions,
    ): AsyncIterable<Result<GuildMember, GuildOperationFailure | PaginationError | CancelledError>>
    /** Local-only lookup by decimal guild/user IDs, with Guilds.get's miss, freshness, failure and LRU rules.
     * Enable cache.members and cache.roles when creating the client. Explicit fetches or subsequent events populate them
     * @example
     * ```ts
     * import type { Client, MemberReference } from "@neontechspace/fluxerly"
     * export function cachedRoleNamesExample(client: Client, target: MemberReference) {
     *     const member = client.members.get(target)
     *     if (member.isErr()) throw member.error
     *     return member.value?.roleIds.map(id => {
     *         const role = client.roles.get({ guildId: target.guildId, id })
     *         if (role.isErr()) throw role.error
     *         return role.value?.name ?? id
     *     })
     * }
     * ```
     * Repeated rendering makes no requests. A missing member returns undefined and missing role names fall back to IDs.
     * This displays observed names, not effective permissions or a completeness guarantee
     */
    get(member: MemberReference): Result<GuildMember | undefined, GuildOperationFailure>
    /** Fetch one member by decimal guild/user IDs; HTTP 404 uses notFound rather than an empty result */
    fetch(
        member: MemberReference,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError>
    /** Fetch the authenticated bot's membership directly, without requiring READY or a known bot ID */
    fetchSelf(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError>
    /** Fetch an ascending user-ID page; default limit 100, range 1–1000.
     * Use the last userId as after. An empty page ends traversal; separate pages are not a consistent snapshot.
     * No hasMore guarantee, automatic traversal or partial malformed page. Input is copied when this call starts
     */
    fetchPage(
        guildId: string,
        query?: MemberQuery,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly GuildMember[], GuildOperationFailure | CancelledError>
    /** Grant one decimal role ID without replacing other roles. Reject the implicit everyone role locally.
     * Fluxer enforces MANAGE_ROLES and hierarchy. HTTP 204 is completion, not event acknowledgement or proof the role was previously absent
     * @example
     * ```ts
     * import type { Client, MessageReference } from "@neontechspace/fluxerly"
     * export async function assignRoleExample(client: Client, message: MessageReference, guildId: string, roleId: string) {
     *     const opened = client.messages.collectReactions(message, {
     *         emoji: "✅",
     *         onReaction: async (reaction, signal) => {
     *             const assigned = await client.members.addRole({ guildId, userId: reaction.userId }, roleId, { signal })
     *             if (assigned.isErr()) throw assigned.error
     *         },
     *     })
     *     if (opened.isErr()) throw opened.error
     *     try {
     *         const result = await opened.value.waitForClose()
     *         if (result.isErr()) throw result.error
     *         return result.value
     *     } finally { opened.value.stop() }
     * }
     * ```
     * Supply a connected client, a message in this guild and a role the bot may assign. Timeout may collect nothing.
     * This bounded one-addition example is not a persistent reaction-role system and does not revoke on reaction removal
     */
    addRole(
        member: MemberReference,
        roleId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError>
    /** Revoke one role with addRole's permission/completion rules. Other roles remain untouched.
     * No local snapshot suppresses the request; success does not prove a previously assigned role was removed
     */
    removeRole(
        member: MemberReference,
        roleId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError>
}

/** Immediate role operations sharing Guilds' admission, deadlines and read retries.
 * Writes retry only confirmed 429 rejections. Server permissions/hierarchy apply; no local permission prediction.
 * Abort waits for owned cleanup but cannot undo dispatched writes. Success is not a gateway acknowledgement.
 * Expected failures use GuildOperationError or ClientClosedError; abort uses CancelledError and defects reject with SdkDefect.
 * Inputs are copied when the call starts; returned roles contain bigint permissions and require explicit JSON conversion
 */
export interface Roles {
    /** Local-only lookup by decimal guild/role IDs, including everyone, with Guilds.get's miss, freshness, failure and LRU rules */
    get(role: RoleReference): Result<GuildRole | undefined, GuildOperationFailure>
    /** Fetch the current role list, including everyone, in server order. Always remote, without pagination or automatic refresh */
    fetchAll(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly GuildRole[], GuildOperationFailure | CancelledError>
    /** Create a role with name, color and permissions. Permissions default to 0n, not Fluxer's inherited everyone grants.
     * Returns the server's actual grants, which can differ from the request. Hoist/mentionable changes require a separate edit
     * @example
     * ```ts
     * import { Permissions, type Client } from "@neontechspace/fluxerly"
     * export async function createRoleExample(client: Client, guildId: string) {
     *     const result = await client.roles.create(guildId, {
     *         name: "Readers",
     *         permissions: Permissions.ViewChannel | Permissions.ReadMessageHistory,
     *     })
     *     if (result.isErr()) throw result.error
     *     return result.value
     * }
     * ```
     * The caller owns the created role. On an unknown outcome, reconcile with fetchAll before deciding whether to create again
     */
    create(
        guildId: string,
        input: RoleCreate,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<GuildRole, GuildOperationFailure | CancelledError>
    /** Patch only defined fields and return the server's observation. Empty/unknown-field patches are input errors.
     * permissions replaces the raw grants; it is not an additive grant. Everyone edits remain subject to server rules */
    edit(
        role: RoleReference,
        input: RoleEdit,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<GuildRole, GuildOperationFailure | CancelledError>
    /** Delete a role, also removing its assignments upstream. Everyone cannot be deleted.
     * HTTP 204 is completion, not proof of member-event delivery; old member/role observations remain unchanged */
    delete(
        role: RoleReference,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError>
    /** Reorder distinct role IDs using nonnegative safe-integer positions; everyone cannot move.
     * Fluxer normalizes manageable positions, so fetchAll afterward when final order matters. HTTP 204 carries no list.
     * This operation and multi-step workflows are not transactions: Failures can leave partial state; refetch before reconciliation */
    reorder(
        guildId: string,
        positions: readonly RolePosition[],
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError>
}

/** Bot-authenticated remote webhook management, available before connect.
 * No webhook cache, hidden credential persistence or synthesized events.
 * JSON responses are bounded to 1 MiB and malformed or larger responses fail with reason response.
 * Calls start immediately, with cancellation returning CancelledError and unexpected defects rejecting with SdkDefect.
 * Requests default to a 30-second total deadline, allow bounded read retries and retry writes only after confirmed rate-limit rejection.
 * Shutdown rejects new work and awaits admitted request cleanup. Separate clients do not coordinate rate limits
 */
export interface Webhooks {
    /** Create one webhook using bot permissions. Returns redacted credentials separately from metadata. An uncertain result may have created it */
    create(
        channelId: string,
        input: WebhookCreate,
        options?: DefaultWebhookOperationOptions,
    ): ResultAsync<CreatedWebhook, WebhookOperationFailure | CancelledError>
    /** Fetch metadata remotely by decimal ID, discarding the returned token. HTTP 404 reports notFound */
    fetch(
        id: string,
        options?: DefaultWebhookOperationOptions,
    ): ResultAsync<Webhook, WebhookOperationFailure | CancelledError>
    /** Read the channel's complete accessible webhook list remotely, without caching, token retention or pagination */
    fetchChannel(
        channelId: string,
        options?: DefaultWebhookOperationOptions,
    ): ResultAsync<readonly Webhook[], WebhookOperationFailure | CancelledError>
    /** Read the guild's accessible webhook list remotely. Server permissions determine visibility, and concurrent changes prevent snapshot guarantees */
    fetchGuild(
        guildId: string,
        options?: DefaultWebhookOperationOptions,
    ): ResultAsync<readonly Webhook[], WebhookOperationFailure | CancelledError>
    /** Update explicit settings, including destination moves. Returned metadata omits credentials. Failure does not guarantee rollback */
    edit(
        id: string,
        input: WebhookEdit,
        options?: DefaultWebhookOperationOptions,
    ): ResultAsync<Webhook, WebhookOperationFailure | CancelledError>
    /** Delete the webhook and revoke its credential. Does not delete its old messages or restore the credential after a failure */
    delete(
        id: string,
        options?: DefaultWebhookOperationOptions,
    ): ResultAsync<void, WebhookOperationFailure | CancelledError>
}

/** Token-only HTTP client, without a bot token, gateway, caches or persistent storage.
 * Operations start immediately and return expected failures, while unexpected defects reject with SdkDefect.
 * Requests default to a 30-second total deadline across admission, rate waits, retries and HTTP.
 * Cancellation interrupts only that operation and awaits request/body cleanup, without rolling back remote effects
 *
 * Errors contain only safe categories and status, never credential-bearing paths or upstream bodies.
 * JSON responses exceeding 1 MiB fail with reason response. Other client caches are not updated by this token-only client
 */
export interface WebhookClient {
    /** Credential identity, never a token-bearing URL */
    readonly id: string
    /** Send with wait=true and return the created message. Mentions default off. Files use bounded multipart streaming, with 50 MiB maximum per file.
     * Snapshot inputs at execution, including admitted file bytes. Never retry an uncertain send, which may already have posted */
    send(
        input: WebhookMessageInput,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<Message, WebhookOperationFailure | CancelledError>
    /** Fetch a decimal message ID authored by this webhook in its current channel, with bounded transient read retries */
    fetchMessage(
        messageId: string,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<Message, WebhookOperationFailure | CancelledError>
    /** Edit this webhook's message and return its snapshot. Omitted fields remain unchanged, mentions default off, and attachments cannot be replaced */
    editMessage(
        messageId: string,
        input: WebhookMessageEdit,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<Message, WebhookOperationFailure | CancelledError>
    /** Delete this webhook's message. 204 is success without proving earlier existence, and uncertain failures may follow deletion */
    deleteMessage(
        messageId: string,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, WebhookOperationFailure | CancelledError>
    /** Permanently reject new work, cancel admitted work, await transport cleanup and release the owned token reference.
     * Does not delete the remote webhook or invalidate caller-held credentials. Concurrent calls share the same pending cleanup
     */
    shutdown(): Promise<void>
}

/**
 * Default client with SDK-owned execution of asynchronous operations.
 * Expected failures use ResultAsync Err values, while SDK defects reject with SdkDefect.
 * Use run for a managed lifetime, or pair connect with waitForClose and shutdown
 */
export interface Client extends ClientState {
    /** Bot-authenticated webhook management with token-free metadata */
    readonly webhooks: Webhooks
    /** Remote role management and explicitly enabled local role lookup */
    readonly roles: Roles
    /** Remote guild reads and ban management, with explicitly enabled local guild lookup */
    readonly guilds: Guilds
    /** Remote guild-channel reads, mutations and explicitly enabled local lookup */
    readonly channels: Channels
    /** Remote member reads, moderation and targeted role assignment */
    readonly members: Members
    /** REST, local lookup and live collection owned by this client */
    readonly messages: Messages
    /**
     * Register a callback for one EventMap event before or after connect. No cached history or REST-generated events.
     * Enabled cache changes happen before user dispatch, independently of subscriptions and their overflow.
     * Each subscription receives only its event type. Bulk deletions do not also invoke messageDelete handlers
     *
     * Default concurrency is 1. Receive-order starts do not imply completion order when concurrency is increased.
     * Buffer defaults are 256 pending event payloads and 4 MiB of source JSON, not a process heap cap.
     * A bulk payload counts once, including its full bytes. Ordering is per subscription, not across event types
     *
     * Overflow stops only this subscription. Handler failure is reported without retrying the invocation.
     * Return/await callback work and inspect send Err values. Unawaited application work is not owned by the SDK
     *
     * The second argument requests cooperative cancellation on unsubscribe or shutdown.
     * Observe the returned subscription's terminal outcome as well as the client's run/waitForClose outcome.
     * Local registration failures use Result. Unexpected synchronous defects throw SdkDefect
     */
    on<K extends EventName>(
        event: K,
        handler: (message: EventMap[K], signal: NonNullable<OperationOptions["signal"]>) => void | Promise<void>,
        options?: EventHandlerOptions,
    ): Result<Subscription, RegistrationError>
    /**
     * Open one event type's bounded pull subscription in receive order without subscription history or bulk fan-out.
     * Enabled cache changes happen before delivery, independently of this subscription and its overflow.
     * Local errors use Result and defects throw SdkDefect
     */
    events<K extends EventName>(event: K, options?: EventBufferOptions): Result<EventSubscription<K>, RegistrationError>
    /**
     * Connect and complete after authentication and the required READY event.
     * Readiness does not mean every guild or resource has loaded
     *
     * Owns startup only, using the client's connection settings.
     * Cancelling startup waits for cleanup and leaves the client Disconnected for reuse.
     * The signal becomes inert after success, while automatic recovery continues independently.
     * Use waitForClose to observe later terminal failures
     *
     * @returns Success if ready, or a connection, busy, closed or cancellation Err.
     * An already connected unmanaged client succeeds without opening another socket.
     * A competing call returns ClientBusyError without affecting the active operation
     * @throws SdkDefect as a rejection for an unexpected SDK or cleanup defect
     */
    connect(options?: OperationOptions): ResultAsync<void, ConnectError | CancelledError>
    /**
     * Own startup, connection, recovery and permanent cleanup as one operation.
     * Remains pending while the client is connected or recovering.
     * An accepted run leaves the client Closed on shutdown, failure or cancellation
     *
     * Accepts only a Disconnected client without competing work.
     * Rejection before admission does not acquire or close the client.
     * The signal controls the accepted run's full lifetime, with cleanup awaited before completion
     *
     * @returns Success after normal shutdown, or a connection, busy, closed or cancellation Err
     * @throws SdkDefect as a rejection, including when cancellation or failure also encounters a cleanup defect
     *
     * @example
     * ```ts
     * import { createClient } from "@neontechspace/fluxerly"
     *
     * export async function runBot(token: string, signal: AbortSignal): Promise<void> {
     *     const created = createClient({ token })
     *     if (created.isErr()) throw created.error
     *     try {
     *         const result = await created.value.run({ signal })
     *         if (result.isErr() && result.error._tag !== "CancelledError") {
     *             console.error(result.error.message)
     *         }
     *     } catch {
     *         console.error("Unexpected SDK failure")
     *     }
     * }
     * ```
     */
    run(options?: OperationOptions): ResultAsync<void, ConnectError | CancelledError>
    /**
     * Observe the retained terminal outcome without starting or owning a connection.
     * Recovery keeps this wait pending, and late observers receive the same terminal outcome.
     * Cancelling this wait releases only this caller, not the client or other waiters
     *
     * @returns Success after normal shutdown, a permanent connection failure, or CancelledError for this wait
     * @throws SdkDefect as a rejection for a retained unexpected background or cleanup defect
     */
    waitForClose(options?: OperationOptions): ResultAsync<void, ConnectionFailure | CancelledError>
    /**
     * Permanently stop startup and recovery, release credentials and await owned-resource cleanup.
     * Release cached message references and expiry timers, without waiting for application-owned reporter promises.
     * Abort active message/reaction collector callbacks and await their returned promises. Non-cooperative callbacks can delay shutdown.
     * Repeated and concurrent calls wait for the same shutdown outcome.
     * A pending connection call reports ClientClosedError rather than caller cancellation
     *
     * Established sockets get up to 5,000 ms for graceful closure, then forced termination and an awaited close event.
     * Pending handshakes terminate immediately, and forced termination may discard unsent data.
     * Accepts no cancellation signal that could abandon cleanup and never exits the application.
     * Create a new client to connect again
     *
     * @returns Success after cleanup, without an expected-error channel
     * @throws SdkDefect as a rejection if shutdown encounters an SDK or cleanup defect
     */
    shutdown(): ResultAsync<void, never>
    /**
     * Subscribe to the current state first, then only the newest pending update.
     * Callbacks run asynchronously and sequentially per subscriber, awaiting a returned promise.
     * Slow subscribers may miss intermediate states without delaying connection recovery.
     * Callback failures are reported without private error details and do not close the client
     *
     * @returns An unsubscribe function that drops pending delivery without stopping the client.
     * Unsubscription cannot cancel callback code that is already running.
     * Use waitForClose rather than state changes to observe terminal failure
     */
    observeState(listener: (state: ConnectionState) => void | Promise<void>): () => void
}

const executeOperation = <
    A,
    E extends
        | ConnectError
        | EventReadError
        | MessageError
        | MessageOperationError
        | CollectorError
        | GuildOperationError
        | ChannelOperationError
        | WebhookOperationError
        | PaginationError,
>(
    effect: Effect.Effect<A, E>,
    operation: Operation,
    options?: OperationOptions,
) => {
    let signal: OperationOptions["signal"]
    let abort: (() => void) | undefined
    let registered = false
    try {
        signal = options?.signal
        if (signal?.aborted) return new ResultAsync<A, E | CancelledError>(Promise.resolve(err(new CancelledError())))
        const controller = signal ? new AbortController() : undefined
        abort = () => controller?.abort()
        if (signal?.aborted) abort()
        else if (signal) {
            // Treat registration as owned before calling it: A custom signal can attach then throw
            registered = true
            signal.addEventListener("abort", abort, { once: true })
        }
        // Interrupt the operation itself rather than discarding a losing race's cleanup cause
        return new ResultAsync(
            (async () => {
                let exit: Exit.Exit<A, E>
                try {
                    exit = await Effect.runPromiseExit(effect, controller ? { signal: controller.signal } : undefined)
                } catch (error) {
                    exit = Exit.failCause(Cause.die(error))
                }
                if (registered) {
                    registered = false
                    try {
                        signal!.removeEventListener("abort", abort!)
                    } catch (error) {
                        exit = Exit.failCause(
                            Cause.combine(Exit.isFailure(exit) ? exit.cause : Cause.empty, Cause.die(error)),
                        )
                    }
                }
                return fromExit(exit, operation)
            })(),
        )
    } catch {
        let cleanupDefect = false
        if (registered) {
            registered = false
            try {
                signal!.removeEventListener("abort", abort!)
            } catch {
                cleanupDefect = true
            }
        }
        return new ResultAsync<A, E | CancelledError>(
            Promise.reject(
                new SdkDefect(
                    operation,
                    cleanupDefect ? [{ kind: "Defect" }, { kind: "Defect" }] : [{ kind: "Defect" }],
                ),
            ),
        )
    }
}

function defaultCollector(source: MessageCollector): Collector {
    return Object.freeze({
        stop: () => source.stop(),
        waitForClose: (options?: OperationOptions) =>
            executeOperation(Deferred.await(source.closed), "collector.waitForClose", options),
    })
}

function collectorHandler<A>(
    handler: (item: A, signal: NonNullable<OperationOptions["signal"]>) => void | Promise<void>,
) {
    return (item: A) =>
        Effect.suspend(() => {
            const controller = new AbortController()
            let settled: Promise<void> = Promise.resolve()
            return Effect.callback<void, CollectorError>((resume) => {
                settled = Promise.resolve()
                    .then(() => handler(item, controller.signal))
                    .then(
                        () => {
                            resume(Effect.void)
                        },
                        () => {
                            resume(Effect.fail(new CollectorError("handler")))
                        },
                    )
            }).pipe(
                Effect.ensuring(
                    Effect.promise(async () => {
                        controller.abort()
                        await settled
                    }),
                ),
            )
        })
}

function fromExit<
    A,
    E extends
        | ConnectError
        | ConfigurationError
        | EventReadError
        | MessageError
        | MessageOperationError
        | CollectorError
        | GuildOperationError
        | ChannelOperationError
        | WebhookOperationError
        | PaginationError,
>(exit: Exit.Exit<A, E>, operation: Operation): Result<A, E | CancelledError> {
    if (Exit.isSuccess(exit)) return ok(exit.value)
    if (Cause.hasDies(exit.cause)) {
        const reasons: DefectReason[] = exit.cause.reasons.map((reason) =>
            reason._tag === "Fail"
                ? { kind: "Failure", failure: reason.error }
                : { kind: reason._tag === "Die" ? "Defect" : "Interruption" },
        )
        throw new SdkDefect(operation, reasons)
    }
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    return failure?._tag === "Fail" ? err(failure.error) : err(new CancelledError())
}

/**
 * Create a webhook-only client for hosted Fluxer, from { id, token } or redacted creation credentials.
 * Validate locally without requests, copying the credential into an independently owned redacted reference.
 * Creation is synchronous and callers must await shutdown in finally.
 * No token storage, gateway or bot authentication. Keep one client per credential for shared admission and rate waits.
 * Returns ConfigurationError for invalid configuration, while unexpected creation defects throw SdkDefect
 * @example
 * ```ts
 * import { createWebhookClient } from "@neontechspace/fluxerly"
 * export async function webhookExample(id: string, token: string) {
 *     const created = createWebhookClient({ id, token })
 *     if (created.isErr()) return created
 *     const webhook = created.value
 *     try {
 *         const message = await webhook.send({ content: "Deploying…" })
 *         return message.isErr() ? message : await webhook.editMessage(message.value.id, { content: "Deployed" })
 *     } finally { await webhook.shutdown() }
 * }
 * ```
 */
export function createWebhookClient(options: WebhookClientOptions): Result<WebhookClient, ConfigurationError> {
    const result = fromExit(Effect.runSyncExit(makeWebhookClient(options)), "createWebhookClient")
    if (result.isErr()) {
        if (result.error instanceof ConfigurationError) return err(result.error)
        throw new SdkDefect("createWebhookClient")
    }
    const owner = result.value
    const execute = executeOperation
    return ok(
        Object.freeze({
            id: owner.id,
            send: (input: WebhookMessageInput, options?: DefaultMessageOperationOptions) =>
                execute(
                    owner.run("webhooks.send", () => webhookSend(owner.id, input), options),
                    "webhooks.send",
                    options,
                ),
            fetchMessage: (id: string, options?: DefaultMessageOperationOptions) =>
                execute(
                    owner.run("webhooks.fetchMessage", () => webhookMessage(owner.id, id, "GET"), options),
                    "webhooks.fetchMessage",
                    options,
                ),
            editMessage: (id: string, input: WebhookMessageEdit, options?: DefaultMessageOperationOptions) =>
                execute(
                    owner.run("webhooks.editMessage", () => webhookMessage(owner.id, id, "PATCH", input), options),
                    "webhooks.editMessage",
                    options,
                ),
            deleteMessage: (id: string, options?: DefaultMessageOperationOptions) =>
                execute(
                    owner.run("webhooks.deleteMessage", () => webhookMessageDelete(owner.id, id), options),
                    "webhooks.deleteMessage",
                    options,
                ),
            shutdown: async () => {
                const result = fromExit(await Effect.runPromiseExit(owner.shutdown()), "shutdown")
                if (result.isErr()) throw new SdkDefect("shutdown")
            },
        }),
    )
}

/**
 * Create a Disconnected client without sockets, timers or process-signal handlers
 *
 * Hosted Fluxer only; self-hosted instances and custom REST or gateway endpoints are not supported
 *
 * Validate configuration locally without authenticating the token
 *
 * Cache settings are copied and validated here without invoking retention policies or reporters.
 * Unknown cache or message-cache option keys fail validation. Caching is disabled by default.
 * Connection settings default to a 30,000 ms overall startup budget and three total attempts
 *
 * @returns The client, or ConfigurationError without the rejected input value
 * @throws SdkDefect synchronously for an unexpected creation defect
 */
export function createClient(options: ClientOptions): Result<Client, ConfigurationError> {
    const scope = Scope.makeUnsafe()
    const exit = Effect.runSyncExit(makeClient(options, scope))
    if (Exit.isFailure(exit)) {
        if (Cause.hasDies(exit.cause)) throw new SdkDefect()
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
        if (failure?._tag === "Fail") return err(failure.error)
        throw new SdkDefect()
    }
    const owner = exit.value
    const execute = <
        A,
        E extends
            | ConnectError
            | EventReadError
            | MessageError
            | MessageOperationError
            | CollectorError
            | GuildOperationError
            | ChannelOperationError
            | WebhookOperationError
            | PaginationError,
    >(
        effect: Effect.Effect<A, E>,
        operation: Operation,
        options?: OperationOptions,
    ) => executeOperation(owner.logging.provide(effect), operation, options)
    const iterate = <A, E extends MessageOperationFailure | GuildOperationFailure>(
        create: (
            options: import("./messages.js").MessageOperationOptions,
        ) => Effect.Effect<Pagination<A, E>, PaginationError>,
        operation: PaginationOperation,
        options?: DefaultMessageOperationOptions,
    ): AsyncIterable<Result<A, E | PaginationError | CancelledError | import("./errors.js").ClientClosedError>> =>
        Object.freeze({
            async *[Symbol.asyncIterator]() {
                const opened = await execute(
                    Effect.gen(function* () {
                        const copied = iterationOptions(options)
                        if (!copied) return yield* Effect.fail(new PaginationError(operation, "input"))
                        const source = yield* create(copied.request)
                        return { source, signal: copied.signal }
                    }),
                    operation,
                )
                if (opened.isErr()) {
                    yield err(opened.error)
                    return
                }
                const { source, signal } = opened.value
                try {
                    while (!source.done) {
                        const result = await execute(
                            source.next,
                            operation,
                            signal === undefined ? undefined : { signal },
                        )
                        if (result.isErr()) {
                            source.close()
                            yield err(result.error)
                            return
                        }
                        if (result.value === undefined) return
                        yield ok(result.value)
                    }
                } finally {
                    source.close()
                }
            },
        })
    const subscription = (source: Pick<EventSource, "stop" | "closed">): Subscription =>
        Object.freeze({
            unsubscribe: () => source.stop(),
            waitForClose: (options?: OperationOptions) =>
                execute(Deferred.await(source.closed), "subscription.waitForClose", options),
        })
    const lookup = <A, E extends GuildOperationFailure | ChannelOperationFailure>(
        effect: Effect.Effect<A, E>,
        operation: Operation,
    ): Result<A, E> => {
        const result = Effect.runSyncExit(effect)
        if (Exit.isSuccess(result)) return ok(result.value)
        if (Cause.hasDies(result.cause) || Cause.hasInterrupts(result.cause)) throw new SdkDefect(operation)
        const failure = result.cause.reasons.find((reason) => reason._tag === "Fail")
        if (failure?._tag === "Fail") return err(failure.error)
        throw new SdkDefect(operation)
    }
    const register = <A>(
        effect: Effect.Effect<A, RegistrationError>,
        operation: "on" | "events",
    ): Result<A, RegistrationError> => {
        const exit = Effect.runSyncExit(owner.logging.provide(effect))
        if (Exit.isSuccess(exit)) return ok(exit.value)
        if (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause)) throw new SdkDefect(operation)
        const reason = exit.cause.reasons.find((reason) => reason._tag === "Fail")
        if (reason?._tag === "Fail") return err(reason.error)
        throw new SdkDefect(operation)
    }
    return ok(
        Object.freeze({
            webhooks: Object.freeze({
                create: (id: string, input: WebhookCreate, options?: DefaultWebhookOperationOptions) =>
                    execute(
                        owner.webhook("webhooks.create", () => webhookCreate(id, input, options), options),
                        "webhooks.create",
                        options,
                    ),
                fetch: (id: string, options?: DefaultWebhookOperationOptions) =>
                    execute(
                        owner.webhook("webhooks.fetch", () => webhookFetch(id), options),
                        "webhooks.fetch",
                        options,
                    ),
                fetchChannel: (id: string, options?: DefaultWebhookOperationOptions) =>
                    execute(
                        owner.webhook("webhooks.fetchChannel", () => webhookList(id, "channels"), options),
                        "webhooks.fetchChannel",
                        options,
                    ),
                fetchGuild: (id: string, options?: DefaultWebhookOperationOptions) =>
                    execute(
                        owner.webhook("webhooks.fetchGuild", () => webhookList(id, "guilds"), options),
                        "webhooks.fetchGuild",
                        options,
                    ),
                edit: (id: string, input: WebhookEdit, options?: DefaultWebhookOperationOptions) =>
                    execute(
                        owner.webhook("webhooks.edit", () => webhookEdit(id, input, options), options),
                        "webhooks.edit",
                        options,
                    ),
                delete: (id: string, options?: DefaultWebhookOperationOptions) =>
                    execute(
                        owner.webhook("webhooks.delete", () => webhookDelete(id, options), options),
                        "webhooks.delete",
                        options,
                    ),
            }),
            guilds: Object.freeze({
                ban: (target: MemberReference, input?: BanInput, options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild("guilds.ban", () => guildBan(target, input, options), options),
                        "guilds.ban",
                        options,
                    ),
                unban: (target: MemberReference, options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild("guilds.unban", () => guildUnban(target, options), options),
                        "guilds.unban",
                        options,
                    ),
                fetchBans: (id: string, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("guilds.fetchBans", () => guildBans(id), options),
                        "guilds.fetchBans",
                        options,
                    ),
                get: (id: string) => lookup(owner.getResource("guilds", id), "guilds.get"),
                fetch: (id: string, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("guilds.fetch", () => guildFetch(id), options),
                        "guilds.fetch",
                        options,
                    ),
            }),
            channels: Object.freeze({
                get: (id: string) => lookup(owner.getChannel(id), "channels.get"),
                fetch: (id: string, options?: DefaultChannelOperationOptions) =>
                    execute(
                        owner.channel("channels.fetch", () => channelFetch(id), options),
                        "channels.fetch",
                        options,
                    ),
                fetchAll: (id: string, options?: DefaultChannelOperationOptions) =>
                    execute(
                        owner.channel("channels.fetchAll", () => channelList(id), options),
                        "channels.fetchAll",
                        options,
                    ),
                create: (id: string, input: ChannelCreate, options?: DefaultChannelOperationOptions) =>
                    execute(
                        owner.channel("channels.create", () => channelCreate(id, input), options),
                        "channels.create",
                        options,
                    ),
                edit: (id: string, input: ChannelEdit, options?: DefaultChannelOperationOptions) =>
                    execute(
                        owner.channel("channels.edit", () => channelEdit(id, input), options),
                        "channels.edit",
                        options,
                    ),
                delete: (id: string, options?: DefaultChannelOperationOptions) =>
                    execute(
                        owner.channel("channels.delete", () => channelDelete(id), options),
                        "channels.delete",
                        options,
                    ),
                reorder: (
                    id: string,
                    positions: readonly ChannelPosition[],
                    options?: DefaultChannelOperationOptions,
                ) =>
                    execute(
                        owner.channel("channels.reorder", () => channelReorder(id, positions), options),
                        "channels.reorder",
                        options,
                    ),
                setPermissionOverwrite: (
                    id: string,
                    input: PermissionOverwrite,
                    options?: DefaultChannelOperationOptions,
                ) =>
                    execute(
                        owner.channel("channels.setPermissionOverwrite", () => permissionSet(id, input), options),
                        "channels.setPermissionOverwrite",
                        options,
                    ),
                removePermissionOverwrite: (id: string, targetId: string, options?: DefaultChannelOperationOptions) =>
                    execute(
                        owner.channel(
                            "channels.removePermissionOverwrite",
                            () => permissionRemove(id, targetId),
                            options,
                        ),
                        "channels.removePermissionOverwrite",
                        options,
                    ),
            }),
            members: Object.freeze({
                timeout: (target: MemberReference, durationMs: number, options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild("members.timeout", () => memberTimeout(target, durationMs, options), options),
                        "members.timeout",
                        options,
                    ),
                clearTimeout: (target: MemberReference, options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild("members.clearTimeout", () => memberTimeout(target, null, options, true), options),
                        "members.clearTimeout",
                        options,
                    ),
                kick: (target: MemberReference, options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild("members.kick", () => memberKick(target, options), options),
                        "members.kick",
                        options,
                    ),
                iterate: (id: string, query: UserIterationQuery, options?: DefaultGuildOperationOptions) =>
                    iterate((request) => memberPagination(owner, id, query, request), "members.iterate", options),
                get: (target: MemberReference) => lookup(owner.getResource("members", target), "members.get"),
                fetch: (target: MemberReference, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("members.fetch", () => memberFetch(target), options),
                        "members.fetch",
                        options,
                    ),
                fetchSelf: (id: string, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("members.fetchSelf", () => memberSelf(id), options),
                        "members.fetchSelf",
                        options,
                    ),
                fetchPage: (id: string, query?: MemberQuery, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("members.fetchPage", () => memberPage(id, query), options),
                        "members.fetchPage",
                        options,
                    ),
                addRole: (target: MemberReference, id: string, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("members.addRole", () => memberRole(target, id, true), options),
                        "members.addRole",
                        options,
                    ),
                removeRole: (target: MemberReference, id: string, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("members.removeRole", () => memberRole(target, id, false), options),
                        "members.removeRole",
                        options,
                    ),
            }),
            roles: Object.freeze({
                get: (target: RoleReference) => lookup(owner.getResource("roles", target), "roles.get"),
                fetchAll: (id: string, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("roles.fetchAll", () => roleList(id), options),
                        "roles.fetchAll",
                        options,
                    ),
                create: (id: string, input: RoleCreate, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("roles.create", () => roleCreate(id, input), options),
                        "roles.create",
                        options,
                    ),
                edit: (target: RoleReference, input: RoleEdit, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("roles.edit", () => roleEdit(target, input), options),
                        "roles.edit",
                        options,
                    ),
                delete: (target: RoleReference, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("roles.delete", () => roleDelete(target), options),
                        "roles.delete",
                        options,
                    ),
                reorder: (id: string, positions: readonly RolePosition[], options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("roles.reorder", () => roleReorder(id, positions), options),
                        "roles.reorder",
                        options,
                    ),
            }),
            messages: Object.freeze({
                iterateHistory: (id: string, query: HistoryIterationQuery, options?: DefaultMessageOperationOptions) =>
                    iterate((request) => historyPagination(owner, id, query, request), "iterateHistory", options),
                iterateReactionUsers: (
                    target: MessageReference,
                    emoji: ReactionEmojiInput,
                    query: UserIterationQuery,
                    options?: DefaultMessageOperationOptions,
                ) =>
                    iterate(
                        (request) => reactionUserPagination(owner, target, emoji, query, request),
                        "iterateReactionUsers",
                        options,
                    ),
                iteratePins: (id: string, query: PinIterationQuery, options?: DefaultMessageOperationOptions) =>
                    iterate((request) => pinPagination(owner, id, query, request), "iteratePins", options),
                removeUserReaction: (
                    target: MessageReference,
                    emoji: ReactionEmojiInput,
                    userId: string,
                    options?: DefaultMessageOperationOptions,
                ) =>
                    execute(
                        owner.reaction("removeUserReaction", target, emoji, options, userId),
                        "removeUserReaction",
                        options,
                    ),
                clearReaction: (
                    target: MessageReference,
                    emoji: ReactionEmojiInput,
                    options?: DefaultMessageOperationOptions,
                ) => execute(owner.reaction("clearReaction", target, emoji, options), "clearReaction", options),
                clearReactions: (target: MessageReference, options?: DefaultMessageOperationOptions) =>
                    execute(owner.reaction("clearReactions", target, undefined, options), "clearReactions", options),
                pin: (target: MessageReference, options?: DefaultMessageOperationOptions) =>
                    execute(owner.pin("pin", target, options), "pin", options),
                unpin: (target: MessageReference, options?: DefaultMessageOperationOptions) =>
                    execute(owner.pin("unpin", target, options), "unpin", options),
                fetchPins: (channel: string, query?: MessagePinsQuery, options?: DefaultMessageOperationOptions) =>
                    execute(owner.fetchPins(channel, query, options), "fetchPins", options),
                fetchReactionUsers: (
                    target: MessageReference,
                    emoji: ReactionEmojiInput,
                    query?: ReactionUsersQuery,
                    options?: DefaultMessageOperationOptions,
                ) => execute(owner.fetchReactionUsers(target, emoji, query, options), "fetchReactionUsers", options),
                addReaction: (
                    target: MessageReference,
                    emoji: ReactionEmojiInput,
                    options?: DefaultMessageOperationOptions,
                ) => execute(owner.reaction("addReaction", target, emoji, options), "addReaction", options),
                removeReaction: (
                    target: MessageReference,
                    emoji: ReactionEmojiInput,
                    options?: DefaultMessageOperationOptions,
                ) => execute(owner.reaction("removeReaction", target, emoji, options), "removeReaction", options),
                collect: (
                    channelId: string,
                    options?: DefaultCollectorOptions,
                ): Result<Collector, CollectorRegistrationError | CancelledError> => {
                    const opened = fromExit(
                        Effect.runSyncExit(
                            Effect.suspend(() =>
                                collect(
                                    owner,
                                    channelId,
                                    options,
                                    true,
                                    typeof options?.onMessage === "function"
                                        ? collectorHandler(options.onMessage)
                                        : undefined,
                                ),
                            ),
                        ),
                        "collect",
                    )
                    return opened.map(defaultCollector)
                },
                collectReactions: (
                    target: MessageReference,
                    options?: DefaultReactionCollectorOptions,
                ): Result<ReactionCollector, CollectorRegistrationError | CancelledError> => {
                    let callback: DefaultReactionCollectorOptions["onReaction"]
                    try {
                        callback = options?.onReaction
                    } catch {
                        throw new SdkDefect("collectReactions", [{ kind: "Defect" }])
                    }
                    const opened = fromExit(
                        Effect.runSyncExit(
                            collectReactions(
                                owner,
                                target,
                                options,
                                true,
                                typeof callback === "function" ? collectorHandler(callback) : undefined,
                            ),
                        ),
                        "collectReactions",
                    )
                    return opened.map((source) =>
                        Object.freeze({
                            stop: () => source.stop(),
                            waitForClose: (options?: OperationOptions) =>
                                executeOperation(
                                    Deferred.await(source.closed),
                                    "reactionCollector.waitForClose",
                                    options,
                                ),
                        }),
                    )
                },
                get: (target: MessageReference): Result<Message | undefined, MessageOperationFailure> => {
                    const exit = Effect.runSyncExit(owner.get(target))
                    if (Exit.isSuccess(exit)) return ok(exit.value)
                    if (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause)) throw new SdkDefect("get")
                    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
                    if (failure?._tag === "Fail") return err(failure.error)
                    throw new SdkDefect("get")
                },
                send: (channelId: string, input: MessageInput, options?: DefaultSendOptions) =>
                    execute(owner.send(channelId, input, options), "send", options),
                reply: (target: MessageReference, input: ReplyInput, options?: DefaultSendOptions) =>
                    execute(
                        Effect.suspend(() => {
                            const data = replyInput(target, input)
                            return data instanceof MessageError
                                ? Effect.fail(data)
                                : owner.send(target.channelId, data, options)
                        }),
                        "reply",
                        options,
                    ),
                fetch: (target: MessageReference, options?: DefaultMessageOperationOptions) =>
                    execute(owner.fetch(target, options), "fetch", options),
                fetchHistory: (
                    channelId: string,
                    query?: MessageHistoryQuery,
                    options?: DefaultMessageOperationOptions,
                ) => execute(owner.fetchHistory(channelId, query, options), "fetchHistory", options),
                edit: (target: MessageReference, input: EditMessageInput, options?: DefaultMessageOperationOptions) =>
                    execute(owner.edit(target, input, options), "edit", options),
                delete: (target: MessageReference, options?: DefaultMessageOperationOptions) =>
                    execute(owner.delete(target, options), "delete", options),
                deleteMany: (channelId: string, ids: readonly string[], options?: DefaultMessageOperationOptions) =>
                    execute(owner.deleteMany(channelId, ids, options), "deleteMany", options),
            }),
            on: <K extends EventName>(
                event: K,
                handler: (
                    message: EventMap[K],
                    signal: NonNullable<OperationOptions["signal"]>,
                ) => void | Promise<void>,
                options?: EventHandlerOptions,
            ) => {
                return register(
                    Effect.suspend(() => {
                        if (typeof handler !== "function")
                            return Effect.fail(new ConfigurationError("handler", "Handler must be a function"))
                        const reporter = options?.onError
                        if (reporter !== undefined && typeof reporter !== "function")
                            return Effect.fail(new ConfigurationError("onError", "Error reporter must be a function"))
                        let reporting = false
                        const reportFailure = (kind: string) => {
                            Effect.runSyncExit(
                                owner.logging.provide(Effect.logError(`Fluxerly message subscription ${kind} failure`)),
                            )
                        }
                        return owner.events
                            .on(
                                event,
                                (message) =>
                                    Effect.tryPromise({
                                        try: (signal) => Promise.resolve(handler(message, signal)),
                                        catch: () => new Error("Event handler failed"),
                                    }),
                                options,
                                reporter
                                    ? (report) =>
                                          Effect.sync(() => {
                                              if (reporting) {
                                                  reportFailure(report.kind)
                                                  return
                                              }
                                              reporting = true
                                              void Promise.resolve()
                                                  .then(() => reporter(report))
                                                  .catch(() => reportFailure(`${report.kind}; reporter`))
                                                  .finally(() => {
                                                      reporting = false
                                                  })
                                          })
                                    : undefined,
                                scope,
                            )
                            .pipe(Effect.map(subscription))
                    }),
                    "on",
                )
            },
            events: <K extends EventName>(event: K, options?: EventBufferOptions) =>
                register(
                    owner.events.open(event, options).pipe(
                        Effect.map((source): EventSubscription<K> =>
                            Object.freeze({
                                ...subscription(source),
                                next: (options?: OperationOptions) => execute(source.next(), "next", options),
                            }),
                        ),
                    ),
                    "events",
                ),
            get state() {
                return owner.state
            },
            get gatewayLatencyMs() {
                return owner.gatewayLatencyMs
            },
            connect: (options?: OperationOptions) => execute(owner.connect(), "connect", options),
            run: (options?: OperationOptions) => execute(owner.run(), "run", options),
            waitForClose: (options?: OperationOptions) => execute(owner.waitForClose(), "waitForClose", options),
            shutdown: () =>
                new ResultAsync<void, never>(
                    Effect.runPromiseExit(
                        owner.logging.provide(owner.shutdown().pipe(Effect.ensuring(Scope.close(scope, Exit.void)))),
                    ).then((exit) => {
                        const result = fromExit(exit, "shutdown")
                        if (result.isErr()) throw new SdkDefect("shutdown")
                        return ok(undefined)
                    }),
                ),
            observeState: (listener: (state: ConnectionState) => void | Promise<void>) => {
                let active = true
                let busy = false
                let pending: ConnectionState | undefined
                const deliver = (state: ConnectionState) => {
                    if (!active) return
                    if (busy) {
                        pending = state
                        return
                    }
                    busy = true
                    Promise.resolve()
                        .then(() => (active ? listener(state) : undefined))
                        .catch(() => {
                            // Diagnostic delivery can fail too; never recurse into the user callback
                            Effect.runSyncExit(owner.logging.provide(Effect.logError("Fluxerly state observer failed")))
                        })
                        .finally(() => {
                            busy = false
                            if (pending !== undefined) {
                                const next = pending
                                pending = undefined
                                deliver(next)
                            }
                        })
                }
                const unsubscribe = owner.subscribe(deliver)
                return () => {
                    active = false
                    pending = undefined
                    unsubscribe()
                }
            },
        }),
    )
}
