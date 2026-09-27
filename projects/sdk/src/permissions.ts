import type { GuildChannel } from "./channels.js"
import type { Guild, GuildMember, GuildRole, MemberReference } from "./guilds.js"

/**
 * Calculate a member's community or channel permission bits from supplied guild, member, role and channel data
 *
 * The `roles` list must include the implicit everyone role whose ID equals `guild.id` and every role in `member.roleIds`.
 * Supply `channel` with permissionOverwrites to include that channel's explicit permission overrides.
 * Omit `channel` to calculate community-level bits
 *
 * The calculation first combines everyone and assigned-role grants.
 * It then applies channel overrides for everyone, the member's roles together, and finally the member.
 * Allows win over denies within each stage.
 * Owners and members with Administrator receive all 64 bits, including unknown bits
 *
 * Duplicate, incomplete or cross-community resources fail with GuildOperationError reason input
 *
 * The calculated bits do not prove that Fluxer will allow an action.
 * The calculation does not check visibility, timeouts, role hierarchy, multi-factor authentication (MFA) or age gates.
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
    /** Target channel's explicit overwrites. Omit for a community-level calculation */
    readonly channel?: GuildChannel
}

/**
 * Choose whose permission bits permissions.fetch should calculate from fresh REST reads
 *
 * Supply `channelId` to include a separate target-channel read, or omit it for community-level bits.
 * The client reads guild, member, roles and optional channel in that order under one total deadline, without consulting caches.
 * Resources can change between reads. The result is not one simultaneous snapshot and does not guarantee that Fluxer will allow an action
 *
 * @category Roles and permissions
 */
export interface PermissionTarget extends MemberReference {
    /** Decimal community-channel ID for a channel-scoped calculation */
    readonly channelId?: string
}
