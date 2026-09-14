import type { ConnectionState } from "./client.js"

/**
 * Connection-attempt snapshot for one shard, a gateway connection owned by this client.
 * Recovery means reconnecting after the shard has previously established a session.
 * Endpoint, session credentials and provider failure details are excluded
 */
export interface ShardRecoveryDiagnostic {
    /** Whether this attempt belongs to initial startup or established-session recovery */
    readonly phase: "startup" | "recovery"
    /** One-based connection attempt number for this shard's managed run, counting startup and later recovery.
     * During a retry delay, identifies the attempt that ended, not the next attempt
     */
    readonly attempt: number
    /** Scheduled retry wait in milliseconds, or null while the current attempt is not waiting. This is not a remaining countdown */
    readonly retryDelayMs: number | null
}

/**
 * Divide the bot's server (guild) events among multiple gateway connections, called shards.
 * Set this when the bot needs more than one gateway connection or this client should own only part of a shared shard plan.
 * A single client can own several shards. Separate processes are optional
 *
 * Every process serving the same bot must use the same total and avoid overlapping ownership.
 * Omit shardIds to own every ID from zero through totalShards minus one
 *
 * Creation validates the plan and copies the supplied IDs in order without changing caller input.
 * Invalid plans fail creation with ConfigurationError. Ownership cannot change during the client's lifetime
 *
 * Shard zero receives direct-message gateway traffic. Include it when this client must receive direct messages.
 * The SDK does not discover a shard count or coordinate other processes
 *
 * With totalShards set to 1, session startup sends no shard tuple in the gateway Identify command.
 * Default-API and native clients accept the same plan. Native validation and copying happen when the creation Effect runs
 */
export interface ShardingOptions {
    /** Immutable total gateway shards for this bot, an integer from 1 through 16,384 shared by every process serving it */
    readonly totalShards: number
    /** Immutable non-empty local IDs, each unique integer from 0 through totalShards minus one. Omit to own every ID in ascending order */
    readonly shardIds?: readonly number[]
}

/**
 * Frozen connection-state snapshot for one gateway shard owned by this client.
 * Use client.shards to inspect local connections rather than the health of other processes or the whole bot.
 * Shard ownership remains fixed for the client's lifetime. A client without sharding options reports shard ID zero
 */
export interface ShardState {
    /** This client's immutable local shard ID, retained in the configured local order */
    readonly shardId: number
    /** Current connection status for this shard */
    readonly state: ConnectionState
    /** Latest current-connection heartbeat round trip in milliseconds, or null when no measurement is current */
    readonly gatewayLatencyMs: number | null
    /** Current safe connection attempt or retry snapshot, or null when this shard is not attempting or waiting */
    readonly recovery: ShardRecoveryDiagnostic | null
}
