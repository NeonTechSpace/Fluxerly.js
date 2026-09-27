import type { CountOperationFailure, DefaultCountOperationOptions, ChannelMemberCountsResult } from "#sdk/counts"
import type { ResultAsync } from "neverthrow"
import type {
    PermissionOverwrite,
    GuildChannel,
    ChannelCreate,
    ChannelEdit,
    ChannelPosition,
    ChannelOperationFailure,
    DefaultChannelOperationOptions,
    DefaultChannelAuditOperationOptions,
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
 * The create, edit, delete, reorder and permission-overwrite mutations accept a raw audit reason through
 * DefaultChannelAuditOperationOptions. Read operations reject auditReason instead of sending a meaningless header.
 * Expected failures return ChannelOperationError or ClientClosedError.
 * Abort returns CancelledError after cleanup.
 * Unexpected failures reject with SdkDefect
 *
 * @category Channels
 */
export interface Channels {
    /**
     * Request fresh member counts for 1–25 channels in one community over the connected gateway.
     * Use distinct positive decimal IDs without leading zeros, no greater than "18446744073709551615".
     * The IDs are copied when execution starts
     *
     * The community must have a ready shard assigned to this client, or the call fails with notConnected instead of listing omitted channels.
     * Fluxer requires ViewChannel and ViewChannelMembers.
     * The result has frozen counts and omittedChannelIds in requested order.
     * Omission means unavailable, not zero, and does not explain access or other causes
     *
     * The guilds.fetchCounts method's four shared gateway slots, default 30,000 ms deadline and failure rules apply.
     * There is no queue, implicit connection, REST fallback, cache write or retry.
     * Only a gap on this community's shard fails the request.
     * Counts are separate visibility-filtered observations, not a subscription or a cross-channel snapshot.
     * Cancellation releases local work but cannot stop the dispatched provider request
     */
    fetchMemberCounts(
        guildId: string,
        channelIds: readonly string[],
        options?: DefaultCountOperationOptions,
    ): ResultAsync<ChannelMemberCountsResult, CountOperationFailure | CancelledError | ConfigurationError>
    /**
     * Look up a community channel in the enabled cache, without an HTTP request or a connection.
     * The result is undefined when caching is disabled or the entry is absent, expired or evicted.
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
     * Use reorder to change a parent or position, and channel type cannot be edited here.
     * Omitted permissionOverwrites keeps the old list, and [] clears it.
     * Each replacement allow and deny mask must be from 0n through 9_223_372_036_854_775_807n.
     * Explicit replacement handles setting and clearing ViewChannelMembers through Fluxer's required feature opt-in
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
     * A bulk channel event can arrive before that copy finishes.
     * Failures can leave partial movement because this is not a transaction.
     * Use fetchAll afterward when final order matters.
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
     * An unknown outcome needs an explicit follow-up read
     */
    removePermissionOverwrite(
        channelId: string,
        targetId: string,
        options?: DefaultChannelAuditOperationOptions,
    ): ResultAsync<void, ChannelOperationFailure | CancelledError | ConfigurationError>
}
