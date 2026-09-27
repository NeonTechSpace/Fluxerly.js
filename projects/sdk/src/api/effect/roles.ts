import type {
    GuildRole,
    RoleReference,
    RolePosition,
    RoleHoistPosition,
    RoleCreate,
    RoleEdit,
    GuildOperationFailure,
    GuildOperationOptions,
    GuildAuditOperationOptions,
} from "#sdk/guilds"
import type * as Effect from "effect/Effect"

/** Read or change community roles, their permission bits and their ordering.
 * Methods return Effects and share Guilds' HTTP concurrency limits, deadlines and read retries.
 * Writes retry only confirmed 429 rejections. Server permissions/hierarchy apply. No local permission prediction.
 * Interruption waits for owned cleanup but cannot undo write requests already sent. Success is not a gateway acknowledgement.
 * Expected failures use GuildOperationError or ClientClosedError. Defects and interruption retain Cause.
 * Inputs are copied on execution, not Effect construction. Returned roles contain bigint permissions and require explicit JSON conversion.
 * Every remote role mutation accepts GuildAuditOperationOptions. The fetchAll method rejects auditReason
 *
 * @category Roles and permissions
 */
export interface Roles {
    /**
     * Look up a role by decimal guildId and id in the enabled cache, including the everyone role.
     * No request is made.
     * The cache misses, stale-snapshot warnings, misuse and recency rules of guilds.get apply
     */
    get(role: RoleReference): Effect.Effect<GuildRole | undefined>
    /**
     * Fetch the community's current role list, including everyone, in server order.
     * This always reads remotely, without pagination or background refresh
     */
    fetchAll(
        guildId: string,
        options?: GuildOperationOptions,
    ): Effect.Effect<readonly GuildRole[], GuildOperationFailure>
    /**
     * Create a role with a name, optional color and permission flags.
     * The permissions input defaults to 0n, rather than copying the everyone role's grants.
     * Supplied permissions must be from 0n through 9_223_372_036_854_775_807n.
     * Explicit permissions use Fluxer's feature opt-in for ViewChannelMembers.
     * The result reports the actual server grants, which can differ from the request.
     * Use a separate edit to change hoist or mentionable settings.
     * The application manages the created role afterward.
     * After an unknown outcome, use fetchAll before deciding whether to create again
     *
     * @example
     * ```ts
     * import { Permissions, type Client } from "@neontechspace/fluxerly/effect"
     * export const createRoleExample = (client: Client, guildId: string) =>
     *     client.roles.create(guildId, {
     *         name: "Readers",
     *         permissions: Permissions.ViewChannel | Permissions.ReadMessageHistory,
     *     })
     * ```
     */
    create(
        guildId: string,
        input: RoleCreate,
        options?: GuildAuditOperationOptions,
    ): Effect.Effect<GuildRole, GuildOperationFailure>
    /**
     * Change only supplied role fields and return the server's snapshot.
     * Empty inputs and unknown fields fail locally.
     * The permissions input replaces all raw grants rather than adding flags, and can set or clear ViewChannelMembers.
     * The replacement must be from 0n through 9_223_372_036_854_775_807n, and larger received masks cannot be written unchanged.
     * The everyone role accepts only color and permissions.
     * Other supplied fields fail, even in a mixed input
     */
    edit(
        role: RoleReference,
        input: RoleEdit,
        options?: GuildAuditOperationOptions,
    ): Effect.Effect<GuildRole, GuildOperationFailure>
    /**
     * Delete a role and remove its member assignments in Fluxer.
     * The everyone role cannot be deleted.
     * HTTP 204 succeeds with no value, without proving member-event delivery.
     * Snapshots already returned to the caller remain unchanged
     */
    delete(role: RoleReference, options?: GuildAuditOperationOptions): Effect.Effect<void, GuildOperationFailure>
    /**
     * Change role hierarchy positions using distinct role IDs and nonnegative safe-integer positions.
     * The everyone role cannot move.
     * HTTP 204 succeeds with no value and no new role list.
     * Fluxer normalizes manageable positions, so use fetchAll if final order matters.
     * This is not a transaction.
     * A failure can leave partial changes, requiring a fresh read before recovery
     */
    reorder(
        guildId: string,
        positions: readonly RolePosition[],
        options?: GuildAuditOperationOptions,
    ): Effect.Effect<void, GuildOperationFailure>
    /**
     * Set roles' display positions without changing their permission hierarchy or enabling hoist.
     * Pass a nonempty list of distinct role IDs with integer hoistPosition values from -2,147,483,648 through 2,147,483,647.
     * The everyone role is excluded.
     * Fluxer checks ManageRoles and hierarchy.
     * HTTP 204 succeeds with no value, not a role list.
     * Successful writes and writes with unknown outcomes invalidate cached guild roles and conflicting pending reads.
     * Failure or cancellation can leave partial changes.
     * Refetch before deciding to replay
     *
     * @example
     * ```ts
     * import { type Client } from "@neontechspace/fluxerly/effect"
     * export function orderRoleDisplay(client: Client, guildId: string, roleId: string) {
     *     return client.roles.setHoistPositions(guildId, [{ id: roleId, hoistPosition: 0 }])
     * }
     * ```
     */
    setHoistPositions(
        guildId: string,
        positions: readonly RoleHoistPosition[],
        options?: GuildAuditOperationOptions,
    ): Effect.Effect<void, GuildOperationFailure>
    /**
     * Clear display-position assignments across the community, including roles above the bot.
     * Fluxer requires ManageRoles.
     * Permission hierarchy and hoist flags remain unchanged.
     * HTTP 204 succeeds with no value, not a role list.
     * Changes are not transactional and a failure can be partial.
     * Successful writes and writes with unknown outcomes invalidate cached guild roles.
     * Refetch to resolve an unknown outcome
     */
    resetHoistPositions(
        guildId: string,
        options?: GuildAuditOperationOptions,
    ): Effect.Effect<void, GuildOperationFailure>
}
