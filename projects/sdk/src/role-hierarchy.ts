import { err, ok, type Result } from "neverthrow"
import { GuildOperationError } from "./guilds.js"
import type { Guild, GuildMember, GuildRole } from "./guilds.js"
import { compareRoleHierarchy, evaluateMemberHierarchy, isRoleAboveInHierarchy } from "#sdk/internal/role-hierarchy"
import { inputValidationFailure } from "./input-validation.js"

/** One local snapshot for evaluating Fluxer's member-target hierarchy without an SDK request */
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
 * Compares two role snapshots in Fluxer's local hierarchy order
 *
 * `1` means left is higher, `-1` means right is higher, and `0` means the same role. A larger position is higher;
 * tied positions use the smaller numeric role ID as higher. Malformed or cross-guild snapshots return
 * GuildOperationError hierarchy.compare/input without retaining the input. This reports local ordering only; it does
 * not evaluate permissions, MFA, membership visibility, or whether a provider endpoint accepts an action
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
 * Reports whether left is strictly higher than right in supplied role snapshots
 *
 * Malformed or cross-guild snapshots return GuildOperationError hierarchy.isAbove/input without retaining the input.
 * This is a local ordering helper, not a permission or endpoint-authorization check
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
 * Evaluates Fluxer's local member-target hierarchy rule from explicit snapshots without fetching or retaining anything
 *
 * The guild owner and a member targeting itself pass. A non-owner cannot manage the owner. Other members need a
 * strictly higher explicit role; no explicit roles rank below any supplied explicit role. `roles` must include one
 * same-guild observation for every actor and target role ID. `roles.fetchAll` output may include the implicit everyone
 * role; it is ignored for rank comparison. Members must not list everyone as an explicit role. Malformed, incomplete,
 * duplicate, cross-guild, or inconsistent snapshots return GuildOperationError hierarchy.canManage/input without retaining the input. This
 * deliberately excludes permissions, MFA, endpoint-specific checks, provider membership state, and concurrent remote
 * changes, so a successful true result is not action authorization
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
