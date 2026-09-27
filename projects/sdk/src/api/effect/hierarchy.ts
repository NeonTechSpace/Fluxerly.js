import { hierarchy as sharedHierarchy, type HierarchyHelpers } from "#sdk/role-hierarchy"

/**
 * Compare roles and members by Fluxer's role hierarchy from snapshots already held, returning plain values rather than Effects.
 * Invalid snapshots throw GuildOperationError with reason input, and such a throw inside Effect code becomes a defect,
 * because inconsistent snapshots are a programming mistake
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { hierarchy, type Client } from "@neontechspace/fluxerly/effect"
 * export function hierarchyExample(client: Client, guildId: string, actorUserId: string, targetUserId: string) {
 *     return Effect.gen(function* () {
 *         const [guild, actor, target, roles] = yield* Effect.all([
 *             client.guilds.fetch(guildId),
 *             client.members.fetch({ guildId, userId: actorUserId }),
 *             client.members.fetch({ guildId, userId: targetUserId }),
 *             client.roles.fetchAll(guildId),
 *         ])
 *         return hierarchy.canManage({ guild, actor, target, roles })
 *     })
 * }
 * ```
 *
 * @category Roles and permissions
 */
export const hierarchy: HierarchyHelpers = sharedHierarchy
