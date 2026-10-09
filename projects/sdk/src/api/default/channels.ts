import type { CountOperationFailure, DefaultCountOperationOptions, ChannelMemberCountsResult } from "#sdk/counts"
import type { ResultAsync } from "neverthrow"
import type {
    PermissionOverwrite,
    GuildChannel,
    ChannelCreate,
    ChannelEdit,
    ChannelPosition,
    ChannelFollowInput,
    FollowedChannel,
    ChannelFollowerStats,
    ChannelOperationFailure,
    DefaultChannelOperationOptions,
    DefaultChannelAuditOperationOptions,
    ForumTagInput,
    GuildForumChannel,
    GuildMediaChannel,
} from "#sdk/channels"
import type { CancelledError, ConfigurationError } from "#sdk/errors"

/**
 * Read, create and change community channels, with optional local cache lookup.
 * Use directMessages for private conversations instead.
 * Most methods use HTTP without a gateway connection.
 * The fetchMemberCounts method requires a ready gateway
 *
 * @remarks
 * Supply decimal community-channel IDs.
 * ID-based writes do not fetch first to verify channel type.
 * Requests share the client's REST or upload slots across assigned shards, four per local shard by default (rest.concurrency).
 * Attachment-download slots are separate, four by default (rest.mediaConcurrency).
 * Both pools together allow 256 waiting requests or 4 MiB of queued JSON by default (rest.maxQueued and rest.queuedJsonMaxBytes).
 * The default deadline, rest.defaultTimeoutMs (30,000 ms unless configured), includes capacity, rate-limit and retry waits.
 * Eligible reads retry transport and HTTP 500, 502, 503 or 504 failures at most twice
 *
 * Writes retry only confirmed HTTP 429 rejection.
 * Input, permission, not-found and malformed responses do not retry
 *
 * Inputs are copied when called.
 * Permission values use bigint and are sent as decimal JSON strings.
 * Fluxer enforces permissions and restrictions on granting flags.
 * Targeted role and member overwrites require ManageRoles.
 * Any dispatched channel change clears the enabled channel cache.
 * Local input failure before dispatch preserves it.
 * No write is followed by an automatic confirmation fetch.
 * The follow, create, edit, delete, reorder, permission-overwrite and forum-tag mutations accept a raw audit reason through
 * DefaultChannelAuditOperationOptions. Read operations reject auditReason instead of sending a meaningless header.
 * Expected failures return ChannelOperationError or ClientClosedError.
 * Abort returns CancelledError after cleanup.
 * Unexpected failures reject with SdkDefect
 *
 * @category Channels
 */
export interface Channels {
    /**
     * Follow an announcement channel into the supplied community text channel and return frozen source and webhook IDs.
     * The source must be viewable, have type Announcement and belong to a community with announcements enabled.
     * The target must have type Text, with ViewChannel and ManageWebhooks on that channel plus community-level ManageWebhooks.
     * Fluxer enforces webhook capacity and rejects duplicate source-to-target follows
     *
     * An adult source requires an adult target. A content-warning source requires an adult or content-warning target.
     * These settings include inherited category and community restrictions, checked by Fluxer without an SDK prefetch.
     * Success creates a channel-follower webhook and emits Webhooks Update for the target.
     * Fluxer also attempts a ChannelFollowAdd notice in the target, but a notice failure does not fail the follow.
     * Neither gateway delivery nor notice creation is confirmed by this result.
     * Use client.webhooks.delete with the returned webhookId to stop following
     *
     * The auditReason option is consumed by the created webhook's audit entry.
     * A lost or malformed response can leave the follow created and is never resent automatically.
     * Inspect the target's webhooks before retrying an unknown outcome
     */
    follow(
        channelId: string,
        input: ChannelFollowInput,
        options?: DefaultChannelAuditOperationOptions,
    ): ResultAsync<FollowedChannel, ChannelOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch frozen channel and distinct community follower counts for a viewable announcement channel.
     * Fluxer can cache these counts for up to 60 seconds, so they need not include the latest follow changes.
     * This does not populate channel caches or subscribe to changes. The auditReason option is not supported
     */
    fetchFollowerStats(
        channelId: string,
        options?: DefaultChannelOperationOptions,
    ): ResultAsync<ChannelFollowerStats, ChannelOperationFailure | CancelledError | ConfigurationError>
    /**
     * Request fresh member counts for 1–25 channels in one community over the connected gateway.
     * Use distinct positive decimal channel IDs without leading zeros, no greater than "9223372036854775807".
     * The community ID must satisfy the same bound.
     * The IDs are copied when execution starts
     *
     * The community must have a ready shard assigned to this client, or the call fails with notConnected instead of listing omitted channels.
     * Fluxer requires ViewChannel and ViewChannelMembers.
     * The result has frozen counts and omittedChannelIds in requested order.
     * Omission means unavailable, not zero, and does not explain access or other causes
     *
     * The guilds.fetchCounts method's four shared gateway slots, default 30,000 ms deadline and failure rules apply.
     * There is no waiting queue for request slots, implicit connection, REST fallback, cache write or retry.
     * Commands may wait for gateway pacing, and a full internal command queue fails with busy.
     * Only a gap on this community's shard fails the request.
     * Counts are separate visibility-filtered observations, not a subscription or a cross-channel snapshot.
     * Cancellation or deadline expiry withdraws an unsent command and releases local request capacity.
     * Work already sent to Fluxer cannot be withdrawn
     */
    fetchMemberCounts(
        guildId: string,
        channelIds: readonly string[],
        options?: DefaultCountOperationOptions,
    ): ResultAsync<ChannelMemberCountsResult, CountOperationFailure | CancelledError | ConfigurationError>
    /**
     * Look up a community channel in the enabled cache, without an HTTP request or a connection.
     * The result is undefined when caching is disabled or the entry is absent, expired or evicted.
     * The result can be a thread, forum channel or media channel, so compare type or use isThreadChannel before reading
     * fields that only some shapes have.
     * A hit may be stale and becomes more recently used without extending expiry.
     * Use fetch for a remote read.
     * An invalid ID is misuse: The default API throws ChannelOperationError with reason input and the native API dies with it.
     * A closing or closed client has no cache, so the result is undefined
     *
     * @remarks
     * Returns the value synchronously.
     * Unexpected failures throw SdkDefect
     */
    get(channelId: string): GuildChannel | undefined
    /**
     * Fetch a community channel by decimal ID and return a frozen snapshot.
     * The ID can name a thread or a forum post, which returns a thread shape, so compare type or use isThreadChannel
     * before reading fields that only some shapes have. A thread has no permission overwrites of its own.
     * A private-channel response fails with a typed response error.
     * Permission overwrites describe explicit settings, not inherited or effective permissions.
     * This neither connects the gateway nor populates a complete community-channel list
     */
    fetch(
        channelId: string,
        options?: DefaultChannelOperationOptions,
    ): ResultAsync<GuildChannel, ChannelOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch the community channels currently visible to the bot, without pagination.
     * The returned list is a point-in-time snapshot, not a subscription or completeness guarantee.
     * It never includes threads, which Fluxer lists separately: Use threads.fetchActive for the active ones.
     * No members, roles, private channels or missing overwrite targets are fetched
     */
    fetchAll(
        guildId: string,
        options?: DefaultChannelOperationOptions,
    ): ResultAsync<readonly GuildChannel[], ChannelOperationFailure | CancelledError | ConfigurationError>
    /**
     * Create a supported community channel and return its frozen server snapshot.
     * Fluxer chooses the initial position.
     * Omitting permissionOverwrites inherits the selected parent category's overwrites.
     * An empty [] creates no explicit overwrites, which does not make a channel private.
     * Explicit overwrites use Fluxer's required feature opt-in for ViewChannelMembers.
     * Each allow and deny mask must be from 0n through 9_223_372_036_854_775_807n, and invalid masks fail before dispatch.
     * The example denies ViewChannel to everyone and grants access to the named bot.
     * The application manages the created channel afterward.
     * After an unknown outcome, use fetchAll before deciding whether to create again.
     * The result does not confirm gateway delivery
     *
     * ChannelType.Forum and ChannelType.Media create a channel that holds posts instead of messages. Besides the shared
     * settings, they accept availableTags, defaultReactionEmoji, defaultSortOrder, defaultTagSetting, flags and the two
     * thread defaults, and a forum channel also accepts defaultForumLayout. Text and announcement channels accept only
     * the thread defaults defaultAutoArchiveMinutes and defaultThreadRateLimitPerUser. A setting that the channel type
     * does not accept fails locally.
     * Fluxer rejects forum and media channels in a community where threads are not active, and ignores the two thread
     * defaults on text and announcement channels there. The result of a forum or media creation lists the stored tags,
     * whose IDs Fluxer assigns
     *
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
     */
    create(
        guildId: string,
        input: ChannelCreate,
        options?: DefaultChannelAuditOperationOptions,
    ): ResultAsync<GuildChannel, ChannelOperationFailure | CancelledError | ConfigurationError>
    /**
     * Change only the supplied channel settings and return the frozen server snapshot.
     * An empty input or unknown field fails locally.
     * Use reorder to change a parent or position. Supply type to convert between Text and Announcement, alone or with other settings.
     * Fluxer requires ManageChannels and rejects converting a text channel that receives follows with CHANNEL_HAS_FOLLOWED_CHANNELS.
     * Converting Announcement to Text queues asynchronous follower removal.
     * Fluxer emits a complete Channel Update with the new type, which replaces the cached observation before handlers run.
     * This call does not await gateway delivery or follower removal.
     * Omitted permissionOverwrites keeps the old list, and [] clears it.
     * Each replacement allow and deny mask must be from 0n through 9_223_372_036_854_775_807n.
     * Explicit replacement handles setting and clearing ViewChannelMembers through Fluxer's required feature opt-in.
     * On a category, a permissionOverwrites change also writes each child whose overwrites matched the category's old ones, in separate writes.
     * A failure can leave some children with the old overwrites, and a retry may not reach them because Fluxer picks the children by comparing with the category's overwrites from before the call, so fetch the children again to check.
     * The thread defaults and the forum settings apply to the channel types named on each field. The SDK cannot see the
     * channel's type, so Fluxer ignores a setting that does not belong to it. The availableTags list replaces every tag
     * of a forum or media channel, so channels.createForumTag, editForumTag and deleteForumTag are the safer way to
     * change one tag. Pass a received channel's availableTags back to keep all its tags
     */
    edit(
        channelId: string,
        input: ChannelEdit,
        options?: DefaultChannelAuditOperationOptions,
    ): ResultAsync<GuildChannel, ChannelOperationFailure | CancelledError | ConfigurationError>
    /**
     * Delete a community channel, succeeding with no value after HTTP 204.
     * No gateway event is awaited and no prior channel existence is proven.
     * The SDK does not fetch the ID first.
     * Fluxer deletes the channel's invites, webhooks, attachments and messages, and detaches a category's children, before it deletes the channel itself.
     * A channel that still exists after a failure may already have lost any of these.
     * A lost response or timeout after dispatch can leave it deleted
     */
    delete(
        channelId: string,
        options?: DefaultChannelAuditOperationOptions,
    ): ResultAsync<void, ChannelOperationFailure | CancelledError | ConfigurationError>
    /**
     * Submit community-channel moves, succeeding with no value after HTTP 204.
     * Fluxer applies moves sequentially and may normalize positions.
     * The syncPermissionsOnMove option copies the destination category's overwrites.
     * Fluxer copies them after each move, so a failed copy leaves that channel moved without them.
     * A bulk channel event can arrive before that copy finishes.
     * Failures can leave partial movement because this is not a transaction, and the error does not list the moves that finished.
     * Use fetchAll afterward when final order matters, and after a failure to read the actual order and parents before sending moves again.
     * The Communities & permissions guide shows how to keep the failure while reading them.
     * Fluxer currently accepts auditReason on this route without retaining it in an audit entry.
     * No reordered list is invented locally
     */
    reorder(
        guildId: string,
        positions: readonly ChannelPosition[],
        options?: DefaultChannelAuditOperationOptions,
    ): ResultAsync<void, ChannelOperationFailure | CancelledError | ConfigurationError>
    /**
     * Replace one explicit role or member permission overwrite.
     * Supply the target ID and raw bigint allow and deny flags.
     * Each mask must be from 0n through 9_223_372_036_854_775_807n, and larger received masks cannot be written unchanged.
     * HTTP 204 succeeds with no value.
     * Fluxer requires ManageRoles and uses a feature opt-in to set or clear ViewChannelMembers.
     * On a category, Fluxer writes the category first and then each child whose overwrites matched the category's old ones, in separate writes.
     * A failure can leave some children with the old overwrites, and a retry may not reach them because Fluxer picks the children by comparing with the category's overwrites from before the call, so fetch the children again to check.
     * No target fetch or inherited-permission calculation is performed
     */
    setPermissionOverwrite(
        channelId: string,
        input: PermissionOverwrite,
        options?: DefaultChannelAuditOperationOptions,
    ): ResultAsync<void, ChannelOperationFailure | CancelledError | ConfigurationError>
    /**
     * Remove one explicit permission overwrite by decimal role or member target ID.
     * Other overwrites remain unchanged.
     * HTTP 204 succeeds with no value.
     * Fluxer requires ManageChannels and ManageRoles.
     * On a category, Fluxer writes the category first and then each child whose overwrites matched the category's old ones, in separate writes.
     * A failure can leave some children with the old overwrites, and a retry may not reach them because Fluxer picks the children by comparing with the category's overwrites from before the call, so fetch the children again to check.
     * An unknown outcome needs an explicit follow-up read
     */
    removePermissionOverwrite(
        channelId: string,
        targetId: string,
        options?: DefaultChannelAuditOperationOptions,
    ): ResultAsync<void, ChannelOperationFailure | CancelledError | ConfigurationError>
    /**
     * Add one tag to a forum or media channel and return the frozen updated channel.
     * Fluxer requires ManageChannels, assigns the tag's ID, and rejects a tag whose name another tag of the channel
     * already uses, a custom emoji that the community does not have, and a channel that already has 20 tags. Find the new
     * tag by name in the result's availableTags.
     * Fluxer applies the tag like a channel edit, so it emits a Channel Update and an audit-log entry.
     * The SDK reads nothing first, so a channel that is not a forum or media channel fails with Fluxer's rejection.
     * After an unknown outcome, fetch the channel before adding the tag again, because the name is already taken when
     * the first attempt applied
     */
    createForumTag(
        channelId: string,
        input: ForumTagInput,
        options?: DefaultChannelAuditOperationOptions,
    ): ResultAsync<GuildForumChannel | GuildMediaChannel, ChannelOperationFailure | CancelledError | ConfigurationError>
    /**
     * Replace one tag of a forum or media channel and return the frozen updated channel.
     * This is a full replacement: A moderated value or emoji that the input leaves out becomes false or none instead of
     * keeping its old value, so read the tag first to change only one of its settings.
     * The tag keeps its ID and the posts that carry it.
     * Fluxer requires ManageChannels and rejects a tag ID that the channel does not have, a name that another tag
     * already uses, and a change that would leave a channel with ChannelFlags.RequireTag without a tag that is not moderated.
     * The call is otherwise an availableTags edit, as createForumTag describes
     */
    editForumTag(
        channelId: string,
        tagId: string,
        input: ForumTagInput,
        options?: DefaultChannelAuditOperationOptions,
    ): ResultAsync<GuildForumChannel | GuildMediaChannel, ChannelOperationFailure | CancelledError | ConfigurationError>
    /**
     * Delete one tag from a forum or media channel and return the frozen updated channel.
     * Posts that carried the tag stop showing it.
     * Fluxer requires ManageChannels and rejects a tag ID that the channel does not have, which includes a tag that an
     * earlier call already deleted, and the deletion of the last tag that is not moderated while the channel has
     * ChannelFlags.RequireTag.
     * The call is otherwise an availableTags edit, as createForumTag describes
     */
    deleteForumTag(
        channelId: string,
        tagId: string,
        options?: DefaultChannelAuditOperationOptions,
    ): ResultAsync<GuildForumChannel | GuildMediaChannel, ChannelOperationFailure | CancelledError | ConfigurationError>
}
