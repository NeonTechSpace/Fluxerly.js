import type { ResultAsync } from "neverthrow"
import type {
    GuildRole,
    RoleReference,
    RolePosition,
    RoleHoistPosition,
    RoleCreate,
    RoleEdit,
    GuildOperationFailure,
    DefaultGuildOperationOptions,
    DefaultGuildAuditOperationOptions,
} from "#sdk/guilds"
import type { CancelledError, ConfigurationError } from "#sdk/errors"

/**
 * Create, edit, order and delete community roles, or read their current or cached data.
 * Shared Guilds request limits, deadlines and read retries apply.
 * Fluxer enforces permissions and hierarchy.
 * No local permission prediction is performed
 *
 * Writes retry only confirmed HTTP 429 rejection.
 * Abort waits for request cleanup but cannot undo a dispatched write
 *
 * Expected failures return GuildOperationError or ClientClosedError.
 * Unexpected failures reject with SdkDefect.
 * Inputs are copied when called.
 * Results are snapshots, not gateway acknowledgement.
 * Role permissions use bigint, which requires explicit conversion before JSON serialization.
 * Every remote role mutation accepts DefaultGuildAuditOperationOptions. The fetchAll method rejects auditReason
 *
 * @category Roles and permissions
 */
export interface Roles {
    /**
     * Look up a role by decimal guildId and id in the enabled cache, including the everyone role.
     * No request is made.
     * The cache misses, stale-snapshot warnings, misuse and recency rules of guilds.get apply
     *
     * @remarks
     * Returns the value synchronously.
     * Unexpected failures throw SdkDefect
     */
    get(role: RoleReference): GuildRole | undefined
    /**
     * Fetch the community's current role list, including everyone, in server order.
     * This always reads remotely, without pagination or background refresh
     */
    fetchAll(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly GuildRole[], GuildOperationFailure | CancelledError | ConfigurationError>
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
     * import { Permissions, type Client } from "@neontechspace/fluxerly"
     * export async function createRoleExample(client: Client, guildId: string) {
     *     const result = await client.roles.create(guildId, {
     *         name: "Readers",
     *         permissions: Permissions.ViewChannel | Permissions.ReadMessageHistory,
     *     })
     *     if (result.isErr()) throw result.error
     *     return result.value
     * }
     * ```
     */
    create(
        guildId: string,
        input: RoleCreate,
        options?: DefaultGuildAuditOperationOptions,
    ): ResultAsync<GuildRole, GuildOperationFailure | CancelledError | ConfigurationError>
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
        options?: DefaultGuildAuditOperationOptions,
    ): ResultAsync<GuildRole, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Delete a role and remove its member assignments in Fluxer.
     * The everyone role cannot be deleted.
     * HTTP 204 succeeds with no value, without proving member-event delivery.
     * Snapshots already returned to the caller remain unchanged
     */
    delete(
        role: RoleReference,
        options?: DefaultGuildAuditOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
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
        options?: DefaultGuildAuditOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
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
     * import { type Client } from "@neontechspace/fluxerly"
     * export function orderRoleDisplay(client: Client, guildId: string, roleId: string) {
     *     return client.roles.setHoistPositions(guildId, [{ id: roleId, hoistPosition: 0 }])
     * }
     * ```
     */
    setHoistPositions(
        guildId: string,
        positions: readonly RoleHoistPosition[],
        options?: DefaultGuildAuditOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
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
        options?: DefaultGuildAuditOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
}
