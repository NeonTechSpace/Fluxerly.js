import type { MemberChunk, MemberChunkQuery, MemberChunkFailure, DefaultMemberChunkOptions } from "#sdk/member-chunks"
import type {
    MemberSearchQuery,
    MemberSearchPage,
    MemberSearchHit,
    MemberSearchIterationLimits,
} from "#sdk/member-search"
import type {
    MemberProfileEdit,
    GuildMember,
    MemberReference,
    VoiceConnectionReference,
    VoiceDeafenInput,
    VoiceMuteInput,
    BanInput,
    GuildBan,
    MemberQuery,
    GuildOperationFailure,
    DefaultGuildOperationOptions,
    DefaultCanManageOptions,
    DefaultGuildAuditOperationOptions,
    DefaultModerationOptions,
    DefaultTimeoutOptions,
} from "#sdk/guilds"
import type { PaginationError, UserIterationQuery } from "#sdk/pagination"
import type { ResultAsync, Result } from "neverthrow"
import type { CancelledError, ConfigurationError } from "#sdk/errors"

/**
 * Read community members, search indexed members, moderate or ban them and change role assignments.
 * HTTP methods use Guilds' shared request limits, deadlines and failure rules.
 * The iterateChunks method uses the connected gateway instead
 *
 * Returned members are frozen snapshots, not live objects.
 * The cache.members setting can retain observations, without downloading the community automatically or predicting permissions
 *
 * Writes retry only confirmed HTTP 429 rejection.
 * Cancellation cannot undo a dispatched change.
 * The setRoles, editSelf, setNickname, addRole and removeRole methods accept DefaultGuildAuditOperationOptions.
 * Member reads and searches reject auditReason. Moderation methods keep their more specific audited option types
 *
 * @category Guilds and members
 */
export interface Members {
    /**
     * Request one community's members over the gateway and deliver frozen batches without accumulating a roster.
     * Choose explicit userIds, a case-insensitive nickname, global-name or username prefix, or `all: true`.
     * The community and explicit user IDs must be positive decimal strings without leading zeros, no greater than 9223372036854775807.
     * This gateway prefix query is separate from REST member search.
     * Each consumption copies the input and sends one request.
     * The community must have a ready shard assigned to this client, otherwise the request fails with notConnected.
     * Full-list mode is capped by Fluxer at 100,000 members, and Fluxer's server-enforced 30-second limit per bot and community also applies.
     * Only one member stream runs per client, and it uses one of four client-wide gateway slots shared with counts until consumed or released.
     * A full request-slot budget or internal command queue fails with MemberChunkError reason busy.
     * Only a gap on this community's shard ends the stream, while work on healthy shards continues.
     * No connection, REST fallback, cache fill, presence subscription, raw-event forwarding or retries are added
     *
     * Fluxer accepts 12 member requests per account in 10 seconds and drops the rest without an answer.
     * The SDK therefore sends at most 12 from one client in any 11 seconds and fails a further request at once with reason rateLimit and retryAfterMs, without sending it.
     * A member request sent with gateway.send counts as well, but gateway.send never refuses one.
     * The children of one supervisor share one count through their parent. A child that gets no answer from the parent within one second counts only its own requests and logs supervisor.memberRequestsLocal once.
     * The count leaves out requests from other processes with the same token, and the SDK does not track Fluxer's limit of 40 requests per community in 10 seconds across all accounts.
     * A request Fluxer drops in either case ends with reason timeout
     *
     * Batches are frozen and follow provider chunk order.
     * The SDK checks batch indices, advertised batch count, unique members and matching presence data.
     * Successful completion means all advertised batches arrived, not a complete or atomic guild snapshot.
     * Missing selected user IDs are listed on the final batch.
     * Optional presence data can omit unavailable, offline or invisible users, so omission does not prove offline status
     *
     * The timeoutMs option defaults to 30,000 for the whole reply, including waits for gateway pacing.
     * Cancellation, deadline expiry or ending consumption withdraws an unsent request and releases its local slot.
     * A request already sent to Fluxer cannot be withdrawn.
     * The maxPendingBytes option defaults to 4 MiB of source-JSON bytes counted for unread gateway batches.
     * This bounds the SDK's byte accounting, not total memory use.
     * Fluxer sends batches without waiting for the reader, so slow readers can overflow.
     * Pausing consumption does not pause intake or the deadline
     *
     * Gateway loss, timeout, malformed replies or overflow drop unread batches and end with one MemberChunkError, never a silent partial success.
     * Already delivered batches remain with the caller.
     * Client closure releases buffers and fails with ClientClosedError.
     * Local cleanup cannot cancel Fluxer's dispatched work.
     * Late replies are ignored and Resume does not replay batches
     *
     * @remarks
     * Consume the iterable with a for await loop.
     * A terminal failure yields one Err.
     * Abort releases intake even while paused, returning CancelledError on the next pull, and interrupts a pending next.
     * Breaking the loop releases intake between pulls.
     * Unexpected failures reject with SdkDefect, retaining safe combined-failure details
     *
     * @example
     * ```ts
     * import type { Client, MemberChunk } from "@neontechspace/fluxerly"
     * export async function memberChunksExample(client: Client, guildId: string, handleBatch: (chunk: MemberChunk) => Promise<void>) {
     *     for await (const result of client.members.iterateChunks(guildId, { all: true, presences: true })) {
     *         if (result.isErr()) return result
     *         await handleBatch(result.value)
     *     }
     * }
     * ```
     */
    iterateChunks(
        guildId: string,
        query: MemberChunkQuery,
        options?: DefaultMemberChunkOptions,
    ): AsyncIterable<Result<MemberChunk, MemberChunkFailure | CancelledError | ConfigurationError>>
    /**
     * Replace one member's entire assigned role list in a single PATCH request.
     * Use 0–250 distinct positive decimal role IDs no greater than 9,223,372,036,854,775,807.
     * [] clears assigned roles, and the implicit everyone role is rejected as input.
     * IDs are copied by index when execution starts, without fetching or merging the old roles.
     * Fluxer requires ManageRoles and checks hierarchy.
     * This can overwrite concurrent role changes
     *
     * Nonexistent or foreign role IDs may be silently omitted.
     * The returned frozen member reports the actual role set, not a guarantee that every requested role was accepted.
     * Shared guild write deadlines and confirmed HTTP 429 retries apply, without a gateway connection or event wait.
     * Eligible results can update the member cache.
     * Writes with unknown outcomes remove the old entry and need explicit fetch reconciliation.
     * Cancellation waits for cleanup but cannot undo the replacement
     *
     * @example
     * ```ts
     * import type { Client, MemberReference } from "@neontechspace/fluxerly"
     * export function roleSetExample(client: Client, member: MemberReference, desiredRoles: readonly string[]) {
     *     return client.members.setRoles(member, desiredRoles)
     * }
     * ```
     */
    setRoles(
        member: MemberReference,
        roleIds: readonly string[],
        options?: DefaultGuildAuditOperationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Search Fluxer's member index for a community, without using or populating the member cache.
     * Without filters, this reads 25 members from offset 0, ordered by newest join time first.
     * Recognized fields, including inherited and nonenumerable fields, are read and filter arrays copied when execution starts.
     * Results can lag membership changes.
     * An indexing true result means the search is not complete, not that it found no members.
     * Even an empty indexing false result can mean Fluxer's search service is unavailable.
     * Counts do not guarantee completeness, and hits do not trigger full-member fetches
     *
     * Fluxer requires at least one of ManageGuild, ManageRoles, ManageNicknames, BanMembers, ModerateMembers or KickMembers.
     * While Guild.mfaLevel is GuildMfaLevels.Elevated, holding any of these except ManageNicknames can make Fluxer reject
     * every search, including one without filters, with HTTP 400 and apiError.code twoFactorRequired, as described on Guild.mfaLevel
     *
     * Join-source and invite filters first fetch the bot's community permissions and require ManageGuild.
     * The three independent precheck reads run concurrently under the same total deadline, and a failure cancels sibling reads.
     * Known permission denial fails with members.search reason rejected, outcome notDispatched and no HTTP status.
     * The precheck prevents knowingly sending ignored filters, but permissions can still change before search.
     * Other queries have no hidden reads.
     * The default deadline, rest.defaultTimeoutMs (30,000 ms unless configured), covers the whole call, including that precheck.
     * Precheck GETs use eligible read retries.
     * Search POST retries only confirmed HTTP 429 rejection because it may queue indexing.
     * Expected failures use GuildOperationError or ClientClosedError
     */
    search(
        guildId: string,
        filters?: MemberSearchQuery,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<MemberSearchPage, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Read unique indexed member-search hits with a bounded scan.
     * The maxItems option is required.
     * The pageSize option defaults to 100 and accepts 1–100, and maxPages defaults to 100.
     * Each consumption copies filters and their arrays, including recognized inherited and nonenumerable fields, and keeps independent state.
     * Pages are requested only as needed, without prefetch or full-member fetches
     *
     * Offset advances by the number of hits received.
     * Each user is emitted at most once, keeping at most maxItems IDs to skip duplicates.
     * Index changes can still skip users, so the result is not a complete or consistent membership snapshot.
     * An indexing response fails with PaginationError indexing instead of pretending the scan ended.
     * An empty page before the observed total fails with cursorStalled.
     * Reaching maxItems is normal completion, not exhaustion.
     * Input, pageLimit and cursorStalled are other PaginationError reasons.
     * Each page uses search's timeout, permission precheck, retry and cache rules.
     * Client closure releases retained state, and delivered hits remain with the caller
     *
     * @remarks
     * Consume the iterable with a for await loop, which starts the first request.
     * An expected failure yields one Err and ends iteration.
     * Breaking the loop releases the buffered page.
     * Abort interrupts pending request work and waits for cleanup
     */
    iterateSearch(
        guildId: string,
        filters: Omit<MemberSearchQuery, "limit">,
        limits: MemberSearchIterationLimits,
        options?: DefaultGuildOperationOptions,
    ): AsyncIterable<
        Result<MemberSearchHit, GuildOperationFailure | PaginationError | CancelledError | ConfigurationError>
    >
    /**
     * Change this bot's community profile, not its global account or another member.
     * Omitted fields stay unchanged, and null clears an override.
     * An empty input or unknown key fails locally.
     * Fluxer checks permissions and field-specific rate limits.
     * Avatar, banner, bio and accentColor can be silently ignored without the community-profile entitlement.
     * The returned member excludes bio and pronouns, so success does not prove those fields were stored.
     * Writes with unknown outcomes or cancellation remove the affected cache entry.
     * A definite rejection preserves the old snapshot
     */
    editSelf(
        guildId: string,
        input: MemberProfileEdit,
        options?: DefaultGuildAuditOperationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Set one member's nickname, or pass null to clear it.
     * A raw empty string fails, while a nonempty string containing only trim whitespace is accepted as Fluxer's clear value.
     * Otherwise, validation removes U+000C and U+202E, trims surrounding whitespace, and requires 1–32 UTF-16 code units.
     * The original string is sent unchanged.
     * Other profile fields and roles stay unchanged.
     * Fluxer checks ManageNicknames, role hierarchy and self-target rules.
     * The frozen result follows HTTP, not a gateway event.
     * Shared guild write deadlines and retries apply.
     * Cancellation waits for request cleanup but cannot undo a dispatched change.
     * An unknown outcome removes the target's cache entry, while a definite rejection preserves it
     *
     * @example
     * ```ts
     * import type { Client, MemberReference } from "@neontechspace/fluxerly"
     * export async function nicknameExample(client: Client, target: MemberReference) {
     *     const set = await client.members.setNickname(target, "Renamed")
     *     if (set.isErr()) return set
     *     return await client.members.setNickname(target, null)
     * }
     * ```
     */
    setNickname(
        member: MemberReference,
        nickname: string | null,
        options?: DefaultGuildAuditOperationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Move a member who is already in voice to a positive decimal voice-channel ID.
     * The target.connectionId value selects one observed connection.
     * Omit it to move every active connection for that member.
     * Fluxer requires MoveMembers and checks hierarchy, destination visibility and permission to connect.
     * The frozen HTTP member result means Fluxer accepted the move, not that the participant has reconnected.
     * A voiceStateUpdate event can first show channelId null, then a new connection ID in the destination.
     * Shared moderation deadlines, auditReason validation, confirmed HTTP 429 retries and member-cache invalidation apply.
     * A lost response or cancellation can leave the move applied.
     * Inspect later observations rather than retrying blindly
     *
     * @example
     * ```ts
     * import type { Client, VoiceConnectionReference } from "@neontechspace/fluxerly"
     * export function moveVoiceConnection(client: Client, target: VoiceConnectionReference, channelId: string) {
     *     return client.members.move(target, channelId, { auditReason: "Moved to support" })
     * }
     * ```
     */
    move(
        target: VoiceConnectionReference,
        channelId: string,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Disconnect one observed voice connection, or all active connections if target.connectionId is omitted.
     * MoveMembers is required.
     * The returned member follows HTTP, without waiting for voiceStateUpdate.
     * A repeated call can fail because the member is no longer connected.
     * The move method's deadline, audit, permission and cache rules apply.
     * An unknown outcome needs later observations rather than blind replay
     */
    disconnect(
        target: VoiceConnectionReference,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Set or clear the community mute flag for a member currently connected to voice.
     * Pass { muted: true } to mute or { muted: false } to unmute.
     * Fluxer requires MuteMembers and checks hierarchy.
     * The returned member contains isMuted, without waiting for a voice event.
     * This does not control self-mute or connect the bot to voice.
     * The move method's deadline, audit, retry, cancellation and member-cache rules apply
     */
    setMute(
        target: MemberReference,
        input: VoiceMuteInput,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Set or clear the community deafen flag for a member currently connected to voice.
     * Pass { deafened: true } to deafen or { deafened: false } to undeafen.
     * Fluxer requires DeafenMembers and checks hierarchy.
     * The returned member contains isDeafened, without waiting for a voice event.
     * This does not control self-deafen or connect the bot to voice.
     * The move method's deadline, audit, retry, cancellation and member-cache rules apply
     */
    setDeaf(
        target: MemberReference,
        input: VoiceDeafenInput,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Temporarily restrict a community member for durationMs milliseconds.
     * The duration must be an integer from 1 through 31,536,000,000 ms.
     * Expiry is calculated when execution starts, so queue and network time consume part of the duration.
     * If expiry is past when Fluxer processes it, the request can clear the timeout.
     * ModerateMembers and Fluxer's hierarchy rules apply, and self and administrator targets are rejected.
     * Fluxer rejects it with HTTP 400 and apiError.code twoFactorRequired in a community whose mfaLevel is GuildMfaLevels.Elevated, unless the bot owns the community or its application owner has two-factor authentication enabled.
     * The returned frozen member contains communicationDisabledUntil after HTTP 200, without waiting for an event
     *
     * Optional timeoutReason is provider audit metadata, separate from auditReason.
     * It is not a member field or a guarantee that an audit entry is retained.
     * Shared guild deadlines and failures apply, and only confirmed HTTP 429 rejection retries.
     * Cancellation or closure waits for cleanup but cannot undo a dispatched timeout.
     * Eligible results update an enabled member cache, and dispatched failures remove the member even on rejection
     *
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
        options?: DefaultTimeoutOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Clear a member's timeout and return the HTTP member snapshot.
     * This sends null rather than a negative duration.
     * The timeout method's permissions, deadline, execution, cache and failure rules apply.
     * No gateway event is awaited
     */
    clearTimeout(
        target: MemberReference,
        options?: DefaultTimeoutOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Remove a member from the community, succeeding with no value after HTTP 204.
     * Fluxer requires KickMembers and checks hierarchy.
     * Fluxer rejects it with HTTP 400 and apiError.code twoFactorRequired in a community whose mfaLevel is GuildMfaLevels.Elevated, unless the bot owns the community or its application owner has two-factor authentication enabled.
     * This does not ban the user, restore membership automatically or wait for a removal event.
     * Missing membership is an API error.
     * Dispatched actions invalidate the member cache even on rejection.
     * The timeout method's execution, deadline and failure rules apply.
     * Writes with unknown outcomes are not replayed
     */
    kick(
        target: MemberReference,
        options?: DefaultModerationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Ban a user from a community, including a user who is not currently a member.
     * Pass decimal guildId and userId.
     * The default ban is permanent and deletes no messages.
     * Fluxer requires BanMembers and checks role hierarchy.
     * Fluxer rejects it with HTTP 400 and apiError.code twoFactorRequired in a community whose mfaLevel is GuildMfaLevels.Elevated, unless the bot owns the community or its application owner has two-factor authentication enabled.
     * HTTP 204 succeeds with no value, without waiting for an event
     *
     * Only confirmed HTTP 429 rejection retries.
     * A dispatched failure can leave the ban or queued message deletion applied.
     * Dispatched actions invalidate the cached member even on rejection.
     * If message cleanup was requested, this author's cached messages are removed across all communities.
     * That broad removal includes unrelated communities because message data need not contain guild IDs.
     * The deletion job can finish later, so a later cache hit does not prove a message survived
     *
     * Fluxer bans can also block rejoining through IP or email checks.
     * Unbanning restores neither deleted messages nor membership.
     * Shared guild deadlines, failures and cleanup apply, and cancellation cannot undo a dispatched ban
     */
    ban(
        target: MemberReference,
        input?: BanInput,
        options?: DefaultModerationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Remove a user's community ban, succeeding with no value after HTTP 204.
     * BanMembers is required.
     * A user who is not banned is an API error, not a successful no-op.
     * The user is not rejoined and queued message deletion is not cancelled.
     * The ban method's execution, failures, cleanup and cached-member invalidation apply
     */
    unban(
        target: MemberReference,
        options?: DefaultModerationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch a community's current full ban list with BanMembers permission.
     * Results are frozen.
     * There is no ban cache, pagination or guaranteed order.
     * Separate reads are not one consistent snapshot.
     * Shared guild deadlines and read retries apply.
     * A malformed response fails rather than producing a partial list
     */
    fetchBans(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly GuildBan[], GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Read community members by ascending user ID, without connecting the gateway or downloading the community eagerly.
     * The maxItems option is required, and pageSize and maxPages both default to 100.
     * Each consumption copies inputs and keeps one page, requested only when needed.
     * An empty page or maxItems ends the scan, not a short page.
     * The timeoutMs option applies to each fetchPage call.
     * Remote failures keep that method's error and read retry policy.
     * PaginationError covers input, cursorStalled and pageLimit.
     * Client closure releases the page and fails the next pull with ClientClosedError.
     * Delivered members remain with the caller, and an enabled cache can receive page members.
     * No roles or permission decisions are fetched.
     * Separate pages are not a consistent membership snapshot
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
    ): AsyncIterable<Result<GuildMember, GuildOperationFailure | PaginationError | CancelledError | ConfigurationError>>
    /**
     * Look up a community member by decimal guildId and userId in the enabled cache, without a request.
     * Enable cache.members to retain members, and cache.roles for local role-name lookup.
     * Explicit fetches or later gateway events can fill those caches.
     * The cache misses, stale-snapshot warnings, misuse and recency rules of guilds.get apply.
     * The example makes no requests when rendering observed role names.
     * A missing member gives undefined, and missing role names fall back to IDs.
     * Observed names are not effective permissions or proof of a complete role list
     *
     * @remarks
     * Returns the value synchronously.
     * Unexpected failures throw SdkDefect
     *
     * @example
     * ```ts
     * import type { Client, MemberReference } from "@neontechspace/fluxerly"
     * export function cachedRoleNamesExample(client: Client, target: MemberReference) {
     *     const member = client.members.get(target)
     *     return member?.roleIds.map(id => client.roles.get({ guildId: target.guildId, id })?.name ?? id)
     * }
     * ```
     */
    get(member: MemberReference): GuildMember | undefined
    /**
     * Fetch one community member by decimal guildId and userId.
     * A missing member fails with reason notFound rather than an empty result
     */
    fetch(
        member: MemberReference,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch this bot's membership in a community without knowing its user ID.
     * No gateway READY event or connection is required
     */
    fetchSelf(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Check whether the bot, or the member named by options.actorUserId, is above a target member in the community's role hierarchy.
     * Pass actorUserId to check a moderator who ran a command, such as `{ actorUserId: message.author.id }`.
     * The helper fetches fresh guild, actor member, target member and role data in parallel, then applies hierarchy.canManage.
     * One default deadline, rest.defaultTimeoutMs (30,000 ms unless configured), covers those reads.
     * Failure or cancellation waits for sibling request cleanup.
     * No cache is read first and no helper result is retained, but underlying reads can still populate enabled resource caches.
     * A true result covers only hierarchy using four separate observations that may change before an action.
     * It does not check permission bits or MFA, authorize an action or perform it
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export const canManageExample = (client: Client, guildId: string, userId: string) =>
     *     client.members.fetchCanManage({ guildId, userId })
     * ```
     */
    fetchCanManage(
        target: MemberReference,
        options?: DefaultCanManageOptions,
    ): ResultAsync<boolean, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch one page of members ordered by ascending user ID.
     * The limit option defaults to 100 and accepts 1–1,000.
     * Use the last returned userId as after for another page.
     * Inputs are copied when execution starts.
     * A malformed page fails as a whole.
     * An empty page ends a scan, but no hasMore guarantee or automatic traversal is provided.
     * Separate pages are not one consistent membership snapshot
     */
    fetchPage(
        guildId: string,
        query?: MemberQuery,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly GuildMember[], GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Grant one role to a member without replacing their other roles.
     * Use a decimal role ID, excluding the implicit everyone role.
     * Fluxer requires MANAGE_ROLES and checks hierarchy.
     * HTTP 204 succeeds with no value, not an event acknowledgement or proof the role was previously absent.
     * Fluxer currently accepts auditReason on member-role add and remove routes without retaining it in an audit entry.
     * The example collects one future reaction addition before assigning the role.
     * It needs a connected client, an existing message in this community and a role the bot can assign, and a timeout can collect nothing.
     * It is not a persistent reaction-role system and does not revoke roles on removal
     *
     * @example
     * ```ts
     * import { orThrow, type Client, type MessageReference } from "@neontechspace/fluxerly"
     * export async function assignRoleExample(client: Client, message: MessageReference, guildId: string, roleId: string) {
     *     await using collector = client.messages.collectReactions(message, {
     *         emoji: "✅",
     *         // A failed assignment is returned as an Err, which ends collection like a throw
     *         onReaction: (reaction, signal) =>
     *             client.members.addRole({ guildId, userId: reaction.userId }, roleId, { signal }),
     *     })
     *     return orThrow(await collector.result())
     * }
     * ```
     */
    addRole(
        member: MemberReference,
        roleId: string,
        options?: DefaultGuildAuditOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Remove one role from a member while leaving other roles unchanged.
     * The addRole method's permissions and completion rules apply.
     * The SDK sends the request even if a local snapshot lacks the role.
     * Success does not prove the role was previously assigned
     */
    removeRole(
        member: MemberReference,
        roleId: string,
        options?: DefaultGuildAuditOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
}
