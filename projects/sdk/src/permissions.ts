import type { GuildChannel } from "./channels.js"
import type { Guild, GuildMember, GuildRole, MemberReference } from "./guilds.js"

/**
 * One complete local snapshot for Fluxer's raw permission-bit calculation
 *
 * `roles` must include the implicit everyone role whose ID equals `guild.id` and every role in `member.roleIds`.
 * Supplying `channel` selects that channel's explicit overwrite snapshot; omitting it calculates guild-level bits.
 * This is a local observation, not a visibility, timeout, role-hierarchy, MFA, age-gate, or action-authorisation
 * decision. The result can become stale immediately after the input was observed
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
 */
export interface PermissionInput {
    /** Guild that owns the member, roles, and optional channel */
    readonly guild: Guild
    /** Membership whose raw permissions are calculated */
    readonly member: GuildMember
    /** Complete role observations needed to resolve everyone and every member role */
    readonly roles: readonly GuildRole[]
    /** Target channel's explicit overwrites. Omit for a guild-level calculation */
    readonly channel?: GuildChannel
}

/**
 * Remote snapshot target for a permission calculation
 *
 * `channelId` requests a separate target-channel read; omission calculates the guild-level bitfield. The client does
 * not read its optional caches first, and the independent remote reads are not a transaction or action guarantee
 */
export interface PermissionTarget extends MemberReference {
    /** Decimal guild-channel ID for a channel-scoped calculation */
    readonly channelId?: string
}
