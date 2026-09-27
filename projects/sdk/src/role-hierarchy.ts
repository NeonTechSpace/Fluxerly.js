import { GuildOperationError } from "./guilds.js"
import type { Guild, GuildMember, GuildRole } from "./guilds.js"
import { compareRoleHierarchy, evaluateMemberHierarchy, isRoleAboveInHierarchy } from "#sdk/internal/role-hierarchy"
import { inputValidationFailure } from "./input-validation.js"

/** Check whether one community member outranks another using guild, member and role snapshots already held by the caller.
 * Supply the actor who would perform the action and the target they would act on.
 * The hierarchy.canManage function checks rank only, without fetching resources or authorizing moderation
 *
 * @category Roles and permissions
 */
export interface RoleHierarchyInput {
    /** Community that owns the actor, target, and supplied role observations */
    readonly guild: Guild
    /** Member whose hierarchy rank is being evaluated */
    readonly actor: GuildMember
    /** Member the actor would need to outrank */
    readonly target: GuildMember
    /** Role observations for every explicit role assigned to actor or target */
    readonly roles: readonly GuildRole[]
}

type HierarchyOperation = "hierarchy.compare" | "hierarchy.isAbove" | "hierarchy.canManage"

const inputFailure = (operation: HierarchyOperation, path: string, explanation: string) =>
    new GuildOperationError({
        operation,
        reason: "input",
        outcome: "notDispatched",
        inputValidation: inputValidationFailure(path, "format", explanation).detail,
    })

/**
 * Compare roles and members by Fluxer's role hierarchy using snapshots the caller already holds.
 * Each method returns a plain value without fetching, retaining input or authorizing an action
 *
 * @category Roles and permissions
 */
export type HierarchyHelpers = Readonly<{
    /**
     * Find which of two roles ranks higher, for example when presenting or checking role order locally.
     * Returns `1` when left is higher, `-1` when right is higher, and `0` for the same role.
     * A larger position is higher. Tied positions use the smaller numeric role ID as higher.
     * Malformed or cross-community snapshots throw GuildOperationError hierarchy.compare/input without retaining the input.
     * This reports only which role ranks higher in the supplied data.
     * It does not evaluate permissions, multi-factor authentication (MFA), membership visibility or whether a provider endpoint accepts an action
     */
    compare(left: GuildRole, right: GuildRole): -1 | 0 | 1
    /**
     * Check whether a supplied role outranks another role, without fetching either one.
     * Equal positions are ordered by numeric ID, with the smaller ID higher. Comparing a role with itself returns false.
     * Malformed or cross-community snapshots throw GuildOperationError hierarchy.isAbove/input without retaining the input.
     * This compares the supplied roles only. It does not check permissions or whether Fluxer will allow an action
     */
    isAbove(left: GuildRole, right: GuildRole): boolean
    /**
     * Check the rank requirement for one member to manage another from supplied snapshots.
     * The community owner and a member targeting itself pass. A non-owner cannot manage the owner.
     * For other targets, the actor's highest explicit role must outrank the target's highest explicit role.
     * An actor with no explicit roles fails. An actor with an explicit role outranks a target with none.
     * The `roles` list must include one same-community observation for every actor and target role ID.
     * The output of `roles.fetchAll` may include the implicit everyone role, which is ignored for rank comparison.
     * Members must not list everyone as an explicit role.
     * Malformed, incomplete, duplicate, cross-community or inconsistent snapshots throw
     * GuildOperationError hierarchy.canManage/input without retaining the input.
     * A true result confirms only the rank requirement and does not authorize an action.
     * It does not check permissions, multi-factor authentication (MFA), endpoint-specific requirements, current provider
     * membership or concurrent remote changes. To fetch fresh data and check in one call, use members.fetchCanManage
     */
    canManage(input: RoleHierarchyInput): boolean
}>

/**
 * Compare roles and members by Fluxer's role hierarchy from snapshots already held, returning plain values.
 * Invalid snapshots throw GuildOperationError with reason input
 * @example
 * ```ts
 * import { hierarchy, type Client } from "@neontechspace/fluxerly"
 * export async function hierarchyExample(client: Client, guildId: string, actorUserId: string, targetUserId: string) {
 *     const [guild, actor, target, roles] = await Promise.all([
 *         client.guilds.fetch(guildId),
 *         client.members.fetch({ guildId, userId: actorUserId }),
 *         client.members.fetch({ guildId, userId: targetUserId }),
 *         client.roles.fetchAll(guildId),
 *     ])
 *     if (guild.isErr()) return guild
 *     if (actor.isErr()) return actor
 *     if (target.isErr()) return target
 *     if (roles.isErr()) return roles
 *     return hierarchy.canManage({ guild: guild.value, actor: actor.value, target: target.value, roles: roles.value })
 * }
 * ```
 *
 * @category Roles and permissions
 */
export const hierarchy: HierarchyHelpers = Object.freeze({
    compare(left: GuildRole, right: GuildRole): -1 | 0 | 1 {
        const comparison = compareRoleHierarchy(left, right)
        if (comparison === undefined)
            throw inputFailure(
                "hierarchy.compare",
                "roles",
                "Role snapshots must contain same-community decimal IDs and nonnegative 32-bit integer positions",
            )
        return comparison
    },
    isAbove(left: GuildRole, right: GuildRole): boolean {
        const above = isRoleAboveInHierarchy(left, right)
        if (above === undefined)
            throw inputFailure(
                "hierarchy.isAbove",
                "roles",
                "Role snapshots must contain same-community decimal IDs and nonnegative 32-bit integer positions",
            )
        return above
    },
    canManage(input: RoleHierarchyInput): boolean {
        const manageable = evaluateMemberHierarchy(input)
        if (manageable === undefined)
            throw inputFailure(
                "hierarchy.canManage",
                "input",
                "Hierarchy input must contain consistent guild, member, and unique role snapshots covering both members",
            )
        return manageable
    },
})
