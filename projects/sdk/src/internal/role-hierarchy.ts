import type { GuildMember, GuildRole } from "#sdk/guilds"
import type { RoleHierarchyInput } from "#sdk/role-hierarchy"

const identifier = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]*$/.test(value)

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

function validInput(value: unknown): value is RoleHierarchyInput {
    if (typeof value !== "object" || value === null) return false
    const input = value as RoleHierarchyInput
    if (
        !input.guild ||
        !identifier(input.guild.id) ||
        !identifier(input.guild.ownerId) ||
        !validMember(input.actor, input.guild.id) ||
        !validMember(input.target, input.guild.id) ||
        !Array.isArray(input.roles)
    )
        return false

    const roleIds = new Set<string>()
    for (const role of input.roles) {
        if (!validRole(role) || role.guildId !== input.guild.id || roleIds.has(role.id)) return false
        roleIds.add(role.id)
    }
    return [...input.actor.roleIds, ...input.target.roleIds].every((roleId) => roleIds.has(roleId))
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
