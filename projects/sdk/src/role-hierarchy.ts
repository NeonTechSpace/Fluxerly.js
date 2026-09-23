import { err, ok, type Result } from "neverthrow"
import { GuildOperationError } from "./guilds.js"
import type { Guild, GuildMember, GuildRole } from "./guilds.js"
import { compareRoleHierarchy, evaluateMemberHierarchy, isRoleAboveInHierarchy } from "#sdk/internal/role-hierarchy"
import { inputValidationFailure } from "./input-validation.js"

/** Check whether one guild member outranks another using guild, member and role snapshots you already have.
 * Supply the actor who would perform the action and the target they would act on.
 * canManageHierarchy checks rank only, without fetching resources or authorizing moderation
 */
export interface RoleHierarchyInput {
    /** Guild that owns the actor, target, and supplied role observations */
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
    new GuildOperationError(
        operation,
        "input",
        "notDispatched",
        null,
        null,
        null,
        inputValidationFailure(path, "format", explanation).detail,
    )

/**
 * Find which of two roles ranks higher, for example when presenting or checking role order locally
 *
 * `1` means left is higher, `-1` means right is higher, and `0` means the same role.
 * A larger position is higher. Tied positions use the smaller numeric role ID as higher.
 * Malformed or cross-guild snapshots return GuildOperationError hierarchy.compare/input without retaining the input.
 * This reports only which role ranks higher in the supplied data.
 * It does not evaluate permissions, multi-factor authentication (MFA), membership visibility or whether a provider endpoint accepts an action
 */
export function compareHierarchy(left: GuildRole, right: GuildRole): Result<-1 | 0 | 1, GuildOperationError> {
    const comparison = compareRoleHierarchy(left, right)
    return comparison === undefined
        ? err(
              inputFailure(
                  "hierarchy.compare",
                  "roles",
                  "Role snapshots must contain same-guild decimal IDs and nonnegative 32-bit integer positions",
              ),
          )
        : ok(comparison)
}

/**
 * Check whether a supplied role outranks another role, without fetching either one
 *
 * Equal positions are ordered by numeric ID, with the smaller ID higher. Comparing a role with itself returns false.
 * Malformed or cross-guild snapshots return GuildOperationError hierarchy.isAbove/input without retaining the input.
 * This compares the supplied roles only. It does not check permissions or whether Fluxer will allow an action
 */
export function isAboveInHierarchy(left: GuildRole, right: GuildRole): Result<boolean, GuildOperationError> {
    const above = isRoleAboveInHierarchy(left, right)
    return above === undefined
        ? err(
              inputFailure(
                  "hierarchy.isAbove",
                  "roles",
                  "Role snapshots must contain same-guild decimal IDs and nonnegative 32-bit integer positions",
              ),
          )
        : ok(above)
}

/**
 * Check the rank requirement for one member to manage another from snapshots you supply.
 * This synchronous helper returns a Result and performs no requests or retention
 *
 * The guild owner and a member targeting itself pass. A non-owner cannot manage the owner.
 * For other targets, the actor's highest explicit role must outrank the target's highest explicit role.
 * An actor with no explicit roles fails. An actor with an explicit role outranks a target with none
 *
 * `roles` must include one same-guild observation for every actor and target role ID.
 * `roles.fetchAll` output may include the implicit everyone role, which is ignored for rank comparison.
 * Members must not list everyone as an explicit role
 *
 * Malformed, incomplete, duplicate, cross-guild or inconsistent snapshots return
 * GuildOperationError hierarchy.canManage/input without retaining the input
 *
 * A true result confirms only the rank requirement and does not authorize an action.
 * It does not check permissions, multi-factor authentication (MFA), endpoint-specific requirements, current provider membership or concurrent remote changes
 * @example
 * ```ts
 * import { canManageHierarchy, type Client } from "@neontechspace/fluxerly"
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
 *     return canManageHierarchy({ guild: guild.value, actor: actor.value, target: target.value, roles: roles.value })
 * }
 * ```
 */
export function canManageHierarchy(input: RoleHierarchyInput): Result<boolean, GuildOperationError> {
    const manageable = evaluateMemberHierarchy(input)
    return manageable === undefined
        ? err(
              inputFailure(
                  "hierarchy.canManage",
                  "input",
                  "Hierarchy input must contain consistent guild, member, and unique role snapshots covering both members",
              ),
          )
        : ok(manageable)
}
