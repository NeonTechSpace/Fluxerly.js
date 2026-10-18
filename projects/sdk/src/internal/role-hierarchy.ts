/**
 * Pure role hierarchy comparison.
 * Invariant: Comparisons use position and then ID, and invalid or cross-guild roles compare as unknown.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import type { Guild, GuildMember, GuildRole } from "#sdk/guilds"
import type { RoleHierarchyInput, RoleManagementInput } from "#sdk/role-hierarchy"
import { identifier } from "./decode/primitives.js"

const validRole = (value: unknown): value is GuildRole =>
    typeof value === "object" &&
    value !== null &&
    identifier((value as GuildRole).guildId) &&
    identifier((value as GuildRole).id) &&
    typeof (value as GuildRole).position === "number" &&
    Number.isInteger((value as GuildRole).position) &&
    (value as GuildRole).position >= 0 &&
    (value as GuildRole).position <= 2_147_483_647

export function compareRoleHierarchy(left: GuildRole, right: GuildRole): -1 | 0 | 1 | undefined {
    if (!validRole(left) || !validRole(right) || left.guildId !== right.guildId) return undefined
    if (left.id === right.id) return 0
    if (left.position !== right.position) return left.position > right.position ? 1 : -1
    return BigInt(left.id) < BigInt(right.id) ? 1 : -1
}

export function isRoleAboveInHierarchy(left: GuildRole, right: GuildRole): boolean | undefined {
    const comparison = compareRoleHierarchy(left, right)
    return comparison === undefined ? undefined : comparison === 1
}

export function evaluateMemberHierarchy(input: RoleHierarchyInput): boolean | undefined {
    if (!validInput(input)) return undefined
    const { guild, actor, target, roles } = input
    if (actor.userId === target.userId) return true
    if (actor.userId === guild.ownerId) return true
    if (target.userId === guild.ownerId) return false

    const roleById = new Map(roles.filter((role) => role.id !== guild.id).map((role) => [role.id, role]))
    const actorRole = highestExplicitRole(actor.roleIds, roleById)
    const targetRole = highestExplicitRole(target.roleIds, roleById)
    if (!actorRole) return false
    if (!targetRole) return true
    return isRoleAboveInHierarchy(actorRole, targetRole)
}

function validMember(value: unknown, guildId: string): value is GuildMember {
    if (
        typeof value !== "object" ||
        value === null ||
        (value as GuildMember).guildId !== guildId ||
        !identifier((value as GuildMember).userId) ||
        !Array.isArray((value as GuildMember).roleIds)
    )
        return false
    const ids = new Set<string>()
    for (const roleId of (value as GuildMember).roleIds) {
        if (!identifier(roleId) || roleId === guildId || ids.has(roleId)) return false
        ids.add(roleId)
    }
    return true
}

/** The IDs of unique, valid roles of one community, or undefined when any role is malformed, foreign or repeated */
function roleIdsOf(value: unknown, guildId: string): ReadonlySet<string> | undefined {
    if (!Array.isArray(value)) return undefined
    const roleIds = new Set<string>()
    for (const role of value) {
        if (!validRole(role) || role.guildId !== guildId || roleIds.has(role.id)) return undefined
        roleIds.add(role.id)
    }
    return roleIds
}

function validGuild(value: unknown): value is Guild {
    return (
        typeof value === "object" &&
        value !== null &&
        identifier((value as Guild).id) &&
        identifier((value as Guild).ownerId)
    )
}

function validInput(value: unknown): value is RoleHierarchyInput {
    if (typeof value !== "object" || value === null) return false
    const input = value as RoleHierarchyInput
    if (
        !validGuild(input.guild) ||
        !validMember(input.actor, input.guild.id) ||
        !validMember(input.target, input.guild.id)
    )
        return false
    const roleIds = roleIdsOf(input.roles, input.guild.id)
    return (
        roleIds !== undefined &&
        [...input.actor.roleIds, ...input.target.roleIds].every((roleId) => roleIds.has(roleId))
    )
}

/**
 * The member's highest explicit role, wrapped so that a member with no explicit role is distinct from malformed input,
 * which gives undefined. The implicit everyone role is not considered
 */
export function evaluateHighestRole(
    member: unknown,
    roles: unknown,
): { readonly role: GuildRole | undefined } | undefined {
    if (typeof member !== "object" || member === null || !identifier((member as GuildMember).guildId)) return undefined
    const snapshot = member as GuildMember
    if (!validMember(snapshot, snapshot.guildId)) return undefined
    const roleIds = roleIdsOf(roles, snapshot.guildId)
    if (roleIds === undefined || !snapshot.roleIds.every((roleId) => roleIds.has(roleId))) return undefined
    const roleById = new Map((roles as readonly GuildRole[]).map((role) => [role.id, role]))
    return { role: highestExplicitRole(snapshot.roleIds, roleById) }
}

/** Whether the actor's rank allows managing the role, or undefined when the snapshots are malformed */
export function evaluateRoleManagement(input: RoleManagementInput): boolean | undefined {
    if (typeof input !== "object" || input === null || !validGuild(input.guild)) return undefined
    const { guild, actor, role, roles } = input
    // The role need not be in the list, because only the actor's own roles must be covered
    if (!validRole(role) || role.guildId !== guild.id) return undefined
    const highest = evaluateHighestRole(actor, roles)
    if (highest === undefined || actor.guildId !== guild.id) return undefined
    if (actor.userId === guild.ownerId) return true
    return highest.role !== undefined && isRoleAboveInHierarchy(highest.role, role) === true
}

function highestExplicitRole(roleIds: readonly string[], roles: ReadonlyMap<string, GuildRole>): GuildRole | undefined {
    let highest: GuildRole | undefined
    for (const roleId of roleIds) {
        const role = roles.get(roleId)
        if (!role) return undefined
        if (!highest || isRoleAboveInHierarchy(role, highest)) highest = role
    }
    return highest
}
