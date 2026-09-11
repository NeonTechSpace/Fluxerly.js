import type { ConnectionState } from "./client.js"

/** Current safe retry bookkeeping for one local shard, without endpoint, session or provider failure details */
export interface ShardRecoveryDiagnostic {
    /** Whether this attempt belongs to initial startup or established-session recovery */
    readonly phase: "startup" | "recovery"
    /** One-based attempt number within this client lifetime */
    readonly attempt: number
    /** Scheduled retry wait in milliseconds, or null while the current attempt is not waiting. This is not a remaining countdown */
    readonly retryDelayMs: number | null
}

/**
 * Immutable local gateway-shard assignment supplied when a client is created.
 * Every process serving the same bot must use the same total, while each process can own a distinct subset.
 * Omit shardIds to own every ID from zero through totalShards minus one. The SDK copies the supplied IDs in order and never moves ownership after creation.
 * Shard zero owns direct-message gateway traffic. Include it when this client must receive direct messages.
 * The SDK does not discover a shard count or coordinate processes.
 * totalShards: 1 uses the default gateway form, not an Identify shard tuple.
 * Default and native clients accept the same plan. Native creation validates and copies it when its Effect runs
 */
export interface ShardingOptions {
    /** Immutable total gateway shards for this bot, an integer from 1 through 16,384 shared by every process serving it */
    readonly totalShards: number
    /** Immutable non-empty local IDs, each unique integer from 0 through totalShards minus one. Omit to own every ID in ascending order */
    readonly shardIds?: readonly number[]
}

/**
 * Current state of one gateway shard owned by this client, not a cross-process or whole-bot health report.
 * Its latency is the heartbeat round trip in milliseconds for its current connection, or null when unavailable.
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
