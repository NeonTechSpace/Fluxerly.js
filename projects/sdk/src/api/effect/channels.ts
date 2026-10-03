import type { CountOperationFailure, CountOperationOptions, ChannelMemberCountsResult } from "#sdk/counts"
import type * as Effect from "effect/Effect"
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
    ChannelOperationOptions,
    ChannelAuditOperationOptions,
} from "#sdk/channels"

/** Read or change community channels and permission overrides, or request gateway member counts.
 * HTTP methods return Effects and do not connect the gateway.
 * The REST rules below exclude fetchMemberCounts, which requires gateway readiness and has its own documented contract
 *
 * DM operations are outside this API contract. Supply decimal community-channel IDs. ID-targeted writes do not prefetch or verify their community-channel type
 *
 * Channel requests share this client's REST or upload slots with community, member, role and message requests, regardless of shard. Attachment downloads have separate slots. By default there are four of each, and the shared queue holds at most 256 requests or 4 MiB of JSON bodies. The rest client option changes these limits
 *
 * Total deadline defaults to the client's rest.defaultTimeoutMs, 30,000 ms unless configured, including queue waits, retries and rate-limit waits. Reads retry transport failures and HTTP 500/502/503/504 at most twice.
 * Writes retry only confirmed 429 responses. Permission, input, 404 and malformed-response failures do not retry
 *
 * Sending any channel write clears the enabled channel cache. Input failures before dispatch leave it unchanged. The SDK does not fetch channels automatically after a write.
 * The follow, create, edit, delete, reorder and permission-overwrite mutations accept ChannelAuditOperationOptions. Read operations reject auditReason
 *
 * Operation inputs are copied when the Effect executes and later caller mutations are not observed. Permission bits are bigint values encoded as decimal JSON strings.
 * Fluxer enforces channel permissions and grant restrictions. Targeted overwrite operations require ManageRoles for role and member targets
 *
 * Expected failures use ChannelOperationError or ClientClosedError. Interruption and defects retain Cause after owned cleanup
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
        options?: ChannelAuditOperationOptions,
    ): Effect.Effect<FollowedChannel, ChannelOperationFailure>
    /**
     * Fetch frozen channel and distinct community follower counts for a viewable announcement channel.
     * Fluxer can cache these counts for up to 60 seconds, so they need not include the latest follow changes.
     * This does not populate channel caches or subscribe to changes. The auditReason option is not supported
     */
    fetchFollowerStats(
        channelId: string,
        options?: ChannelOperationOptions,
    ): Effect.Effect<ChannelFollowerStats, ChannelOperationFailure>
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
        options?: CountOperationOptions,
    ): Effect.Effect<ChannelMemberCountsResult, CountOperationFailure>
    /**
     * Look up a community channel in the enabled cache, without an HTTP request or a connection.
     * The result is undefined when caching is disabled or the entry is absent, expired or evicted.
     * A hit may be stale and becomes more recently used without extending expiry.
     * Use fetch for a remote read.
     * An invalid ID is misuse: The default API throws ChannelOperationError with reason input and the native API dies with it.
     * A closing or closed client has no cache, so the result is undefined
     */
    get(channelId: string): Effect.Effect<GuildChannel | undefined>
    /**
     * Fetch a community channel by decimal ID and return a frozen snapshot.
     * A private-channel response fails with a typed response error.
     * Permission overwrites describe explicit settings, not inherited or effective permissions.
     * This neither connects the gateway nor populates a complete community-channel list
     */
    fetch(channelId: string, options?: ChannelOperationOptions): Effect.Effect<GuildChannel, ChannelOperationFailure>
    /**
     * Fetch the community channels currently visible to the bot, without pagination.
     * The returned list is a point-in-time snapshot, not a subscription or completeness guarantee.
     * No members, roles, private channels or missing overwrite targets are fetched
     */
    fetchAll(
        guildId: string,
        options?: ChannelOperationOptions,
    ): Effect.Effect<readonly GuildChannel[], ChannelOperationFailure>
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
     * @example
     * ```ts
     * import { ChannelType, Permissions, type Client } from "@neontechspace/fluxerly/effect"
     * export const channelExample = (client: Client, guildId: string, botId: string) =>
     *     client.channels.create(guildId, {
     *         type: ChannelType.Text,
     *         name: "private-support",
     *         permissionOverwrites: [
     *             { id: guildId, type: "role", allow: 0n, deny: Permissions.ViewChannel },
     *             { id: botId, type: "member", allow: Permissions.ViewChannel | Permissions.SendMessages, deny: 0n },
     *         ],
     *     })
     * ```
     */
    create(
        guildId: string,
        input: ChannelCreate,
        options?: ChannelAuditOperationOptions,
    ): Effect.Effect<GuildChannel, ChannelOperationFailure>
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
     * Explicit replacement handles setting and clearing ViewChannelMembers through Fluxer's required feature opt-in
     */
    edit(
        channelId: string,
        input: ChannelEdit,
        options?: ChannelAuditOperationOptions,
    ): Effect.Effect<GuildChannel, ChannelOperationFailure>
    /**
     * Delete a community channel, succeeding with no value after HTTP 204.
     * No gateway event is awaited and no prior channel existence is proven.
     * The SDK does not fetch the ID first.
     * A lost response or timeout after dispatch can leave it deleted
     */
    delete(channelId: string, options?: ChannelAuditOperationOptions): Effect.Effect<void, ChannelOperationFailure>
    /**
     * Submit community-channel moves, succeeding with no value after HTTP 204.
     * Fluxer applies moves sequentially and may normalize positions.
     * The syncPermissionsOnMove option copies the destination category's overwrites.
     * A bulk channel event can arrive before that copy finishes.
     * Failures can leave partial movement because this is not a transaction.
     * Use fetchAll afterward when final order matters.
     * Fluxer currently accepts auditReason on this route without retaining it in an audit entry.
     * No reordered list is invented locally
     */
    reorder(
        guildId: string,
        positions: readonly ChannelPosition[],
        options?: ChannelAuditOperationOptions,
    ): Effect.Effect<void, ChannelOperationFailure>
    /**
     * Replace one explicit role or member permission overwrite.
     * Supply the target ID and raw bigint allow and deny flags.
     * Each mask must be from 0n through 9_223_372_036_854_775_807n, and larger received masks cannot be written unchanged.
     * HTTP 204 succeeds with no value.
     * Fluxer requires ManageRoles and uses a feature opt-in to set or clear ViewChannelMembers.
     * No target fetch or inherited-permission calculation is performed
     */
    setPermissionOverwrite(
        channelId: string,
        input: PermissionOverwrite,
        options?: ChannelAuditOperationOptions,
    ): Effect.Effect<void, ChannelOperationFailure>
    /**
     * Remove one explicit permission overwrite by decimal role or member target ID.
     * Other overwrites remain unchanged.
     * HTTP 204 succeeds with no value.
     * Fluxer requires ManageChannels and ManageRoles.
     * An unknown outcome needs an explicit follow-up read
     */
    removePermissionOverwrite(
        channelId: string,
        targetId: string,
        options?: ChannelAuditOperationOptions,
    ): Effect.Effect<void, ChannelOperationFailure>
}
