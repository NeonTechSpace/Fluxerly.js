import type { GuildChannel } from "./channels.js"
import type { RequestOptions } from "./client.js"
import type { Guild, GuildMember, GuildRole, MemberReference } from "./guilds.js"

/**
 * Calculate a member's community or channel permission bits from supplied guild, member, role and channel data
 *
 * The `roles` list must include the implicit everyone role whose ID equals `guild.id` and every role in `member.roleIds`.
 * Supply `channel` with permissionOverwrites to include that channel's explicit permission overrides.
 * Omit `channel` to calculate community-level bits.
 * For a thread, supply the thread as `channel` and its parent channel, with its overwrites, as `parentChannel`
 *
 * The calculation first combines everyone and assigned-role grants.
 * It then applies channel overrides for everyone, the member's roles together, and finally the member.
 * Allows win over denies within each stage.
 * Owners and members with Administrator receive all 64 bits, including unknown bits.
 * A thread has no overwrites of its own, so Fluxer calculates in its parent channel and then grants SendMessages
 * exactly when SendMessagesInThreads is granted there. The calculation does the same
 *
 * Duplicate, incomplete or cross-community resources fail with GuildOperationError reason input
 *
 * The calculated bits do not prove that Fluxer will allow an action.
 * The calculation does not check visibility, timeouts, role hierarchy, multi-factor authentication (MFA) or age gates.
 * In a thread it also does not check whether the member can see a private thread, which Fluxer allows only to its
 * members and to members who can manage threads, or whether the thread is archived or locked.
 * The result can become stale immediately after the input was observed
 *
 * @example
 * ```ts
 * import type { Client, PermissionInput, PermissionTarget } from "@neontechspace/fluxerly"
 *
 * export function permissionsExample(client: Client, input: PermissionInput, target: PermissionTarget) {
 *     return {
 *         local: client.permissions.calculate(input),
 *         remote: client.permissions.fetch(target),
 *     }
 * }
 * ```
 *
 * @category Roles and permissions
 */
export interface PermissionInput {
    /** Community that owns the member, roles, and optional channel */
    readonly guild: Guild
    /** Membership whose raw permissions are calculated */
    readonly member: GuildMember
    /** Complete role observations needed to resolve everyone and every member role */
    readonly roles: readonly GuildRole[]
    /** Target channel's explicit overwrites, or a thread whose permissions come from `parentChannel`. Omit for a
     * community-level calculation
     */
    readonly channel?: GuildChannel
    /**
     * Parent channel of a thread supplied as `channel`, with its permission overwrites. Required when `channel` is a
     * thread, and rejected otherwise. It must be in the same community and have the ID that the thread's `parentId`
     * names
     */
    readonly parentChannel?: GuildChannel
}

/**
 * Choose whose permission bits permissions.fetch should calculate, by default from fresh REST reads
 *
 * Supply `channelId` to include a separate target-channel read, or omit it for community-level bits.
 * The client reads guild, member, roles and optional channel in that order under one total deadline, without consulting
 * caches unless `preferCache` is set.
 * When the channel is a thread, the client also reads its parent channel under the same deadline and calculates as
 * Fluxer does for the thread.
 * Resources can change between reads. The result is not one simultaneous snapshot and does not guarantee that Fluxer will allow an action
 *
 * @category Roles and permissions
 */
export interface PermissionTarget extends MemberReference {
    /** Decimal community-channel ID for a channel-scoped calculation */
    readonly channelId?: string
}

/**
 * Settings for permissions.fetch: The shared deadline of its reads, and whether enabled caches may replace them
 *
 * @category Options
 */
export interface PermissionFetchOptions extends RequestOptions {
    /**
     * Read each observation from an enabled cache before fetching it, such as to decide for every command without a
     * request. Default false, which fetches every observation fresh.
     * The guild, member and channel come from their caches when present, and the roles when the everyone role and every
     * member role are all cached, otherwise one list read replaces all of them. A cached channel without its overwrite
     * list is fetched, and a thread's parent channel is read the same way. Only fetches count toward the deadline.
     * Cached observations reflect the last applied gateway events, so they can differ from Fluxer, and their snapshots can
     * come from different moments.
     * Cached entries stay while a shard can resume and are cleared when a new session starts, after which they are fetched.
     * Use the default right before an action where a stale grant matters. With the caches disabled, the call behaves
     * as it does by default. A value that is not a boolean fails with reason input
     */
    readonly preferCache?: boolean
}

/**
 * One entry of the permissions.fetchChannels result: A member's raw permission bits in one community channel.
 * The bits come from the same calculation as permissions.calculate, with the channel's own overwrites. They do not show
 * whether the member can view the channel or whether an action will succeed
 *
 * @category Roles and permissions
 */
export interface ChannelPermissions {
    /** The listed community channel, a frozen snapshot with its permission overwrites */
    readonly channel: GuildChannel
    /** The member's permission bits in this channel, an unsigned 64-bit bigint that preserves unknown flags */
    readonly permissions: bigint
}
