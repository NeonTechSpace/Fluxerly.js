/**
 * Pure role hierarchy comparison.
 * Invariant: Comparisons use position and then ID, and invalid or cross-guild roles compare as unknown.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import type { Guild, GuildMember, GuildRole } from "#sdk/guilds"
import type { RoleHierarchyInput, RoleManagementInput } from "#sdk/role-hierarchy"
import { inputId } from "./decode/primitives.js"

/** A role read with trimmed IDs, as every caller ID is read, keeping the caller's object for results */
type RoleView = { readonly id: string; readonly guildId: string; readonly position: number; readonly role: GuildRole }
type MemberView = { readonly userId: string; readonly roleIds: readonly string[] }
type GuildView = { readonly id: string; readonly ownerId: string }

function roleView(value: unknown): RoleView | undefined {
    if (typeof value !== "object" || value === null) return undefined
    const role = value as GuildRole
    const guildId = inputId(role.guildId)
    const id = inputId(role.id)
    const position = role.position
    if (
        guildId === undefined ||
        id === undefined ||
        typeof position !== "number" ||
        !Number.isInteger(position) ||
        position < 0 ||
        position > 2_147_483_647
    )
        return undefined
    return { id, guildId, position, role }
}

function compareViews(left: RoleView, right: RoleView): -1 | 0 | 1 | undefined {
    if (left.guildId !== right.guildId) return undefined
    if (left.id === right.id) return 0
    if (left.position !== right.position) return left.position > right.position ? 1 : -1
    return BigInt(left.id) < BigInt(right.id) ? 1 : -1
}

export function compareRoleHierarchy(left: GuildRole, right: GuildRole): -1 | 0 | 1 | undefined {
    const leftView = roleView(left)
    const rightView = roleView(right)
    return leftView === undefined || rightView === undefined ? undefined : compareViews(leftView, rightView)
}

export function isRoleAboveInHierarchy(left: GuildRole, right: GuildRole): boolean | undefined {
    const comparison = compareRoleHierarchy(left, right)
    return comparison === undefined ? undefined : comparison === 1
}

export function evaluateMemberHierarchy(input: RoleHierarchyInput): boolean | undefined {
    if (typeof input !== "object" || input === null) return undefined
    const guild = guildView(input.guild)
    if (guild === undefined) return undefined
    const actor = memberView(input.actor, guild.id)
    const target = memberView(input.target, guild.id)
    const roles = rolesOf(input.roles, guild.id)
    if (
        actor === undefined ||
        target === undefined ||
        roles === undefined ||
        ![...actor.roleIds, ...target.roleIds].every((roleId) => roles.has(roleId))
    )
        return undefined
    if (actor.userId === target.userId) return true
    if (actor.userId === guild.ownerId) return true
    if (target.userId === guild.ownerId) return false

    const actorRole = highestExplicitRole(actor.roleIds, roles)
    const targetRole = highestExplicitRole(target.roleIds, roles)
    if (!actorRole) return false
    if (!targetRole) return true
    return compareViews(actorRole, targetRole) === 1
}

/** A member of the community guildId with unique explicit role IDs, never the everyone role, or undefined */
function memberView(value: unknown, guildId: string): MemberView | undefined {
    if (typeof value !== "object" || value === null) return undefined
    const member = value as GuildMember
    const userId = inputId(member.userId)
    if (inputId(member.guildId) !== guildId || userId === undefined || !Array.isArray(member.roleIds)) return undefined
    const ids = new Set<string>()
    for (const rawRoleId of member.roleIds) {
        const roleId = inputId(rawRoleId)
        if (roleId === undefined || roleId === guildId || ids.has(roleId)) return undefined
        ids.add(roleId)
    }
    return { userId, roleIds: [...ids] }
}

/** The unique, valid roles of one community by ID, or undefined when any role is malformed, foreign or repeated */
function rolesOf(value: unknown, guildId: string): ReadonlyMap<string, RoleView> | undefined {
    if (!Array.isArray(value)) return undefined
    const roles = new Map<string, RoleView>()
    for (const item of value) {
        const role = roleView(item)
        if (role === undefined || role.guildId !== guildId || roles.has(role.id)) return undefined
        roles.set(role.id, role)
    }
    return roles
}

function guildView(value: unknown): GuildView | undefined {
    if (typeof value !== "object" || value === null) return undefined
    const id = inputId((value as Guild).id)
    const ownerId = inputId((value as Guild).ownerId)
    return id === undefined || ownerId === undefined ? undefined : { id, ownerId }
}

/**
 * The member's highest explicit role, wrapped so that a member with no explicit role is distinct from malformed input,
 * which gives undefined. The implicit everyone role is not considered
 */
export function evaluateHighestRole(
    member: unknown,
    roles: unknown,
): { readonly role: GuildRole | undefined } | undefined {
    if (typeof member !== "object" || member === null) return undefined
    const guildId = inputId((member as GuildMember).guildId)
    if (guildId === undefined) return undefined
    const view = memberView(member, guildId)
    const roleById = rolesOf(roles, guildId)
    if (view === undefined || roleById === undefined || !view.roleIds.every((roleId) => roleById.has(roleId)))
        return undefined
    return { role: highestExplicitRole(view.roleIds, roleById)?.role }
}

/** Whether the actor's rank allows managing the role, or undefined when the snapshots are malformed */
export function evaluateRoleManagement(input: RoleManagementInput): boolean | undefined {
    if (typeof input !== "object" || input === null) return undefined
    const guild = guildView(input.guild)
    if (guild === undefined) return undefined
    const { actor, role, roles } = input
    // The role need not be in the list, because only the actor's own roles must be covered
    const managed = roleView(role)
    if (managed === undefined || managed.guildId !== guild.id) return undefined
    const highest = evaluateHighestRole(actor, roles)
    if (highest === undefined || inputId(actor.guildId) !== guild.id) return undefined
    if (inputId(actor.userId) === guild.ownerId) return true
    return highest.role !== undefined && isRoleAboveInHierarchy(highest.role, role) === true
}

function highestExplicitRole(roleIds: readonly string[], roles: ReadonlyMap<string, RoleView>): RoleView | undefined {
    let highest: RoleView | undefined
    for (const roleId of roleIds) {
        const role = roles.get(roleId)
        if (!role) return undefined
        if (!highest || compareViews(role, highest) === 1) highest = role
    }
    return highest
}
