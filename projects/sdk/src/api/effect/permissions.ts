import type { PermissionFetchOptions, PermissionInput, PermissionTarget } from "#sdk/permissions"
import type { GuildOperationFailure } from "#sdk/guilds"
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
     * A thread uses the overwrites of the parentChannel supplied with it, then grants SendMessages exactly when
     * SendMessagesInThreads is granted, as Fluxer does. A thread without its parentChannel, or with any other channel as
     * parentChannel, is rejected.
     * Missing or inconsistent input is misuse and throws GuildOperationError for permissions.calculate with reason input in both APIs.
     * A timed-out member keeps its permission bits, but Fluxer blocks sending messages, editing and publishing the member's
     * own messages, reacting, uploading, typing, changing the member's own nickname, writing in threads and joining voice,
     * so check members.timeoutState as well
     *
     * @remarks
     * Returns the value synchronously, as in the default API, because the calculation is pure
     */
    calculate(input: PermissionInput): bigint
    /**
     * Fetch guild, member, role and optional channel data, then calculate their permission flags.
     * No gateway connection is needed, and by default every observation is read fresh without consulting a cache.
     * Set `preferCache` to take each observation from an enabled cache when it is there and fetch only what is missing.
     * A cached channel without its overwrite list is fetched, and so are all roles when any needed role is not cached.
     * Cached observations reflect the last applied gateway events, which can differ from Fluxer, and they can come from
     * different moments.
     * Cached entries stay while a shard can resume and are cleared when a new session starts, after which they are fetched.
     * Use the default right before an action where a stale grant matters. With caches disabled, `preferCache` behaves as the default.
     * A thread channel adds a read of its parent channel, and the result follows Fluxer's thread rule as in calculate.
     * Underlying fetches can enter enabled caches, but the calculated result is not cached.
     * The sequential reads are separate observations, so the result does not guarantee a later action will succeed.
     * The default deadline, rest.defaultTimeoutMs (30,000 ms unless configured), covers the whole helper with shared read retries and awaited cancellation cleanup.
     * Only fetches count toward it, so reads served by a cache need no time.
     * Invalid target, deadline or a `preferCache` that is not a boolean fails with permissions.fetch reason input.
     * Resource errors keep their GuildOperationError or ChannelOperationError.
     * A channel from another community fails instead of mixing guild data, and so does a channel other than a thread that
     * Fluxer sends without its permission overwrite list, with permissions.fetch reason response, outcome unknown, details.read
     * and details.channelId.
     * Client closure fails with ClientClosedError. Its outcome is notDispatched when the client closes before a read is
     * sent or during a cache lookup, including when every observation is cached, rejected while a read waits out a 429
     * before its retry, and unknown with details.read while a read is in flight
     */
    fetch(
        target: PermissionTarget,
        options?: PermissionFetchOptions,
    ): Effect.Effect<bigint, GuildOperationFailure | ChannelOperationFailure>
}
