import type { PermissionInput, PermissionTarget } from "#sdk/permissions"
import type { GuildOperationFailure, GuildOperationOptions } from "#sdk/guilds"
import type * as Effect from "effect/Effect"
import type { ChannelOperationFailure } from "#sdk/channels"

/** Calculate permission bits from supplied snapshots or freshly fetched resources.
 * These results do not account for timeouts or role hierarchy and do not prove an action will succeed
 *
 * @category Roles and permissions
 */
export interface PermissionHelpers {
    /**
     * Calculate permission flags from supplied guild, member, role and optional channel data.
     * No request or cache read is made, and connection state is irrelevant, including after client shutdown.
     * The bigint result ranges from 0n through 18_446_744_073_709_551_615n and preserves unknown flags.
     * Community owner or base Administrator gets all flags.
     * Otherwise the calculation applies everyone, combined roles, then member overwrites.
     * Only the target channel's stored overwrites are used, not its parent category's.
     * Missing or inconsistent input is misuse and throws GuildOperationError for permissions.calculate with reason input in both APIs
     *
     * @remarks
     * Returns the value synchronously, as in the default API, because the calculation is pure
     */
    calculate(input: PermissionInput): bigint
    /**
     * Fetch guild, member, role and optional channel data, then calculate their permission flags.
     * No gateway connection or cache-first lookup is needed.
     * Underlying reads can enter enabled caches, but the calculated result is not cached.
     * The sequential reads are separate observations, so the result does not guarantee a later action will succeed.
     * The default deadline, rest.defaultTimeoutMs (30,000 ms unless configured), covers the whole helper with shared read retries and awaited cancellation cleanup.
     * Invalid target or deadline fails with permissions.fetch reason input.
     * Resource errors keep their GuildOperationError or ChannelOperationError.
     * A channel from another community fails instead of mixing guild data.
     * Client closure fails with ClientClosedError
     */
    fetch(
        target: PermissionTarget,
        options?: GuildOperationOptions,
    ): Effect.Effect<bigint, GuildOperationFailure | ChannelOperationFailure>
}
