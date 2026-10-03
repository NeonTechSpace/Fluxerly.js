import type { CountOperationFailure, DefaultCountOperationOptions, GuildCountsResult } from "#sdk/counts"
import type {
    GuildListQuery,
    GuildListSummary,
    GuildEdit,
    GuildVanityUrl,
    GuildVanityUrlUsage,
    Guild,
    GuildOperationFailure,
    DefaultGuildOperationOptions,
    DefaultModerationOptions,
} from "#sdk/guilds"
import type { GuildIterationQuery, PaginationError } from "#sdk/pagination"
import type { DefaultOwnMessageDeletionOptions } from "#sdk/messages"
import type { ResultAsync, Result } from "neverthrow"
import type { CancelledError, ConfigurationError } from "#sdk/errors"

/**
 * Read community settings and bot memberships, or use the optional guild cache.
 * Most operations use HTTP and do not need a gateway connection.
 * The fetchCounts method differs because it requires a ready gateway, as described on that method
 *
 * @remarks
 * Requests share the client's REST or upload slots across all assigned shards, four per local shard by default (rest.concurrency).
 * Attachment-download slots are separate, four by default (rest.mediaConcurrency).
 * Both pools together allow 256 waiting requests or 4 MiB of queued JSON by default (rest.maxQueued and rest.queuedJsonMaxBytes)
 *
 * The timeoutMs option defaults to the client's rest.defaultTimeoutMs, 30,000 unless configured, for the whole request, including waits.
 * Reads retry transport failures and HTTP 500, 502, 503 or 504 at most twice.
 * Delays are 125–250 ms, then 250–500 ms, or a longer Retry-After.
 * Confirmed HTTP 429 waits are separate and never reset the deadline.
 * Input, not-found, permission and malformed-success failures are not retried
 *
 * Successful JSON is limited to 16 MiB before parsing, not total memory.
 * A write's malformed or lost response can leave the write applied, without rollback
 *
 * Expected failures return GuildOperationError or ClientClosedError.
 * Abort returns CancelledError after cleanup.
 * Unexpected SDK or cleanup failures reject with SdkDefect
 *
 * @category Guilds and members
 */
export interface Guilds {
    /**
     * Request fresh, visibility-filtered counts for 1–100 communities over the connected gateway.
     * Use distinct positive decimal IDs without leading zeros, no greater than "9223372036854775807".
     * The IDs are copied when execution starts.
     * Every community must belong to a ready shard assigned to this client.
     * An unassigned or unready shard fails with notConnected, not an omitted result.
     * The result contains frozen counts and omittedGuildIds in requested order.
     * An omitted entry is unavailable, not zero, and does not explain why it is missing.
     * Community counts are separate observations, not one consistent snapshot.
     * A missing whole reply fails with timeout
     *
     * One call uses one of four client-wide gateway request slots until all shard commands and replies finish.
     * The channels.fetchMemberCounts and members.iterateChunks methods share those slots.
     * There is no waiting queue for request slots, so excess calls fail with busy.
     * Commands may wait for gateway pacing, and a full internal command queue also fails with busy.
     * The default 30,000 ms deadline includes registration, commands and all reply fragments.
     * Cancellation or deadline expiry withdraws unsent commands and immediately releases local request capacity.
     * Fluxer also limits member and presence work, so a local slot does not guarantee a reply.
     * Only a gateway gap on a participating shard fails with connectionLost, and late replies are ignored.
     * No REST fallback, connection, caching, polling or retries are performed.
     * Expected failures use CountOperationError or ClientClosedError
     *
     * @remarks
     * Abort returns CancelledError after local cleanup but cannot cancel Fluxer's dispatched work.
     * Unexpected failures reject with SdkDefect
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export async function countsExample(client: Client, guildId: string, channelId: string) {
     *     const guilds = await client.guilds.fetchCounts([guildId])
     *     const channels = await client.channels.fetchMemberCounts(guildId, [channelId])
     *     return { guilds, channels }
     * }
     * ```
     */
    fetchCounts(
        guildIds: readonly string[],
        options?: DefaultCountOperationOptions,
    ): ResultAsync<GuildCountsResult, CountOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch one page of communities this bot belongs to, ordered by ascending guild ID.
     * The limit option defaults to 200 and accepts 1–200.
     * Choose either before or after, not both.
     * Those cursors refer to existing memberships, and if a cursor community was removed, Fluxer may restart the page.
     * The withCounts option defaults to false.
     * Permission bits or requested approximate counts may be omitted, and an omitted value means unavailable, not zero.
     * The frozen summaries do not read or populate the guild cache.
     * No gateway connection or further page traversal is performed.
     * Shared guild deadlines, retries and failures apply.
     * This page is not a complete membership inventory or proof of matching gateway state
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export async function guildListExample(client: Client) {
     *     const page = await client.guilds.fetchPage({ withCounts: true })
     *     if (page.isErr()) return page
     *     return page.value.map(({ id, permissions, approximateMemberCount }) => ({ id, permissions, approximateMemberCount }))
     * }
     * ```
     */
    fetchPage(
        query?: GuildListQuery,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly GuildListSummary[], GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Read the bot's community memberships in ascending ID order, retaining one page and never prefetching.
     * The maxItems option is required.
     * The pageSize option defaults to 200, maxPages defaults to 100, and timeoutMs applies to each page.
     * Iteration ends at maxItems or an empty page, not a short page.
     * A repeated or backward ID after a removed cursor fails with PaginationError cursorStalled before delivering that page.
     * Other traversal failures are input and pageLimit, and remote failures keep fetchPage's error.
     * Each consumption copies inputs independently.
     * Client closure releases the page and fails the next pull.
     * The withCounts option applies to every page, but missing permission bits or counts remain unavailable, not zero.
     * No gateway connection or cache fill is needed.
     * Already delivered communities remain with the caller, and separate pages do not guarantee a consistent inventory
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
     * export function guildMembershipsExample(client: Client) {
     *     return client.guilds.iterate({ maxItems: 1000 })
     * }
     * ```
     */
    iterate(
        query: GuildIterationQuery,
        options?: DefaultGuildOperationOptions,
    ): AsyncIterable<
        Result<GuildListSummary, GuildOperationFailure | PaginationError | CancelledError | ConfigurationError>
    >
    /**
     * Remove this bot from one community while preserving its authored messages.
     * HTTP 204 completes the removal, without waiting for a gateway event.
     * The client remains usable for other communities
     *
     * Fluxer rejects owners or restricted memberships.
     * Only confirmed HTTP 429 rejection retries.
     * A lost response or cancellation can leave membership removed.
     * Check fetch or the membership list to resolve an unknown outcome.
     * Rejoining needs separate authorization
     *
     * Successful writes and writes with unknown outcomes invalidate cached guild resources and conflicting pending reads.
     * A confirmed leave also forgets this client's selected member presences, while an unknown outcome keeps that selection.
     * Any dispatched attempt clears channel and message caches, because messages need not identify their community.
     * Objects already returned to the caller stay unchanged.
     * This neither deletes the community nor shuts down the client
     */
    leave(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Irreversibly delete this bot's entire authored message history across one community.
     * Use a decimal guild ID.
     * Other authors' messages are preserved, and the bot stays in the community with the same roles
     *
     * Success follows Fluxer's empty HTTP 202 response, not a completed-job report, deletion count or gateway event.
     * The community may still contain new or concurrent messages.
     * Deletion can be partial and is not atomic.
     * There is no recovery token or automatic reconciliation
     *
     * Bot credentials satisfy Fluxer's extra authentication checks, called sudo checks.
     * No extra sudo fields or audit reason are accepted.
     * Fluxer handles attachment removal without guaranteeing physical provider-storage or CDN erasure.
     * The default deadline, rest.defaultTimeoutMs (30,000 ms unless configured), includes capacity and rate-limit waits.
     * Only confirmed HTTP 429 rejection retries, and a 5xx or lost response never causes a replay.
     * After dispatch, the entire enabled message cache is cleared and older pending reads cannot restore it.
     * No gateway events are created locally.
     * Cancellation or closure waits for request cleanup but cannot undo deletion.
     * Options must include confirm: true. Without it, the call fails before any request with reason input and path options.confirm.
     * Input, capacity and HTTP failures use GuildOperationError for guilds.deleteOwnMessages
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export function deleteOwnMessagesExample(client: Client, channelId: string) {
     *     return client.messages.deleteOwnMessages(channelId, { confirm: true })
     * }
     * export function deleteOwnGuildMessagesExample(client: Client, guildId: string) {
     *     return client.guilds.deleteOwnMessages(guildId, { confirm: true })
     * }
     * ```
     */
    deleteOwnMessages(
        guildId: string,
        options: DefaultOwnMessageDeletionOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch a community's custom invite code, URL and use count with ManageGuild permission.
     * A null code and URL means the community has no custom invite.
     * The read is remote, without a vanity cache or gateway connection.
     * Shared guild read retries, deadline, cancellation and failure rules apply
     */
    fetchVanityUrl(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<GuildVanityUrlUsage, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Set a community's custom invite code, replace it, or pass null to remove it.
     * The code must already be lowercase, 2–32 ASCII letters or digits with single internal hyphens.
     * No automatic normalization is performed
     *
     * ManageGuild is required.
     * Setting a code also requires the community's VANITY_URL feature.
     * Reserved or taken codes fail remotely.
     * Changing a code releases the old code and starts a new use count, and reclaiming the old code is not guaranteed.
     * Success returns the code and URL without a hidden use-count read, access check or gateway acknowledgement
     *
     * Shared guild deadlines and cleanup apply.
     * Only confirmed HTTP 429 rejection retries, and dispatched writes invalidate guild snapshots.
     * After an unknown outcome, call fetchVanityUrl before deciding how to recover.
     * Provider-side partial changes may need operator recovery and are not rolled back automatically
     */
    editVanityUrl(
        guildId: string,
        code: string | null,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildVanityUrl, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Change only supplied community settings that a bot may edit.
     * Omitted fields remain unchanged, and no old settings are fetched or merged automatically
     *
     * ManageGuild is required.
     * Fluxer checks feature restrictions and constraints beyond local GuildEdit validation.
     * Success returns the server's observed configuration, not gateway acknowledgement.
     * Shared guild write deadlines and cancellation cleanup apply.
     * Dispatched writes invalidate cached guild data even when the outcome is unknown.
     * After a lost response, fetch before deciding to retry.
     * No rollback is guaranteed
     */
    edit(
        guildId: string,
        input: GuildEdit,
        options?: DefaultModerationOptions,
    ): ResultAsync<Guild, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Look up a community in the enabled guild cache, without a request or gateway connection.
     * The result is undefined when caching is disabled or the entry is absent, expired or evicted.
     * Cached data may be stale, so use fetch for a remote read.
     * A hit becomes more recently used without extending expiry.
     * An invalid ID is misuse: The default API throws GuildOperationError with reason input and the native API dies with it.
     * A closing or closed client has no cache, so the result is undefined
     *
     * @remarks
     * Returns the value synchronously.
     * Unexpected failures throw SdkDefect
     */
    get(guildId: string): Guild | undefined
    /**
     * Fetch a community's identity and settings by decimal ID.
     * Fluxer requires membership.
     * The result is a frozen snapshot.
     * This does not fetch or keep nested members, roles or channels, or infer counts or completeness
     */
    fetch(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<Guild, GuildOperationFailure | CancelledError | ConfigurationError>
}
