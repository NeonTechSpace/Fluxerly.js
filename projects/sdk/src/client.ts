import type { MessageCacheOptions, ResourceCacheSettings } from "./cache.js"
import type { GuildChannel } from "./channels.js"
import type { GuildEmoji, GuildSticker } from "./expressions.js"
import type { Guild, GuildMember, GuildRole } from "./guilds.js"
import type { DefaultLoggingOptions } from "./logging.js"
import type { Message } from "./messages.js"
import type { ShardingOptions, ShardState } from "./sharding.js"
import type { DirectMessageChannel, User } from "./users.js"
import type { InstanceOptions } from "./instance.js"

/**
 * Options accepted when creating a disconnected client.
 * The selected hosted or self-hosted instance is resolved lazily and independently for this client
 */
export interface ClientOptions {
    /**
     * Explicit hosted or self-hosted instance selection. Omit it for hosted Fluxer.
     * Creation validates this root locally without a request. The client reads its unauthenticated well-known document only when REST, gateway, or `instance.resolve` needs it, then retains that immutable endpoint map until shutdown.
     * HTTPS and WSS are required by default. Set `allowInsecure: true` only for an explicitly selected HTTP/WS local or self-hosted deployment
     */
    readonly instance?: InstanceOptions
    /** Client-local upload admission, copied and validated at creation */
    readonly uploads?: {
        /** Maximum reserved attachment transfer bytes across queued and active operations, as a positive safe integer.
         * Defaults to 104,857,600 (100 MiB), separate from the 4 MiB queued JSON budget.
         * Reservations use accepted byte-array length, file size or declared stream size and reject with busy before a new operation waits.
         * Reservations remain held across rate-limit retries and release after transport cleanup.
         * This does not measure copied heap, caller buffers, metadata or runtime overhead and is not a process-memory ceiling
         */
        readonly maxBytes?: number
    }
    /**
     * Client-local logging, copied and validated at creation without invoking a logger.
     * Development output is off by default, while operational handler/cache/observer errors remain enabled.
     * SDK messages omit credentials, private payloads and raw upstream errors.
     * Logging does not consume or replace returned operation failures, and adds no background work or stored history
     *
     * @example
     * ```ts
     * import { createClient } from "@neontechspace/fluxerly"
     * export function loggingExample(token: string) {
     *     return createClient({ token, logging: { development: true } })
     * }
     * ```
     */
    readonly logging?: DefaultLoggingOptions
    /** Bot credential, checked locally for a non-blank string but not authenticated */
    readonly token: string
    /**
     * Optional resource retention, copied and validated at creation. Omission retains no resource snapshots.
     * Every configured entry, byte and age budget belongs to this client across its locally owned shards. Sharding never multiplies a budget.
     * A gap on one shard invalidates observations with known scope on that shard. Missing guild scope invalidates conservatively because the SDK keeps no channel-to-guild index
     */
    readonly cache?: {
        /** Public account snapshots from explicit reads and complete user events, never partial message authors.
         * Concurrent reads use latest-admitted retention. Gateway gaps and shutdown release snapshots
         */
        readonly users?: boolean | ResourceCacheSettings
        /** Private conversations from explicit reads and complete channel events, without initial enumeration.
         * Mutations and recipient changes clear private-channel retention; gaps and shutdown release snapshots
         */
        readonly directMessages?: boolean | ResourceCacheSettings
        /** Guild identity snapshots from explicit reads and guild create/update events, never nested member/role preload.
         * Guild removal/unavailability clears this guild's resource entries, including channels
         */
        readonly guilds?: boolean | ResourceCacheSettings
        /** Member snapshots from explicit reads/pages and member add/update events.
         * Member removal evicts one membership. Successful or uncertain role assignment evicts its target rather than guessing a new role set
         */
        readonly members?: boolean | ResourceCacheSettings
        /** Role snapshots from explicit list/create/edit results and role events, with bigint-aware byte accounting.
         * Successful or uncertain creation/reordering evicts guild role entries. Edits evict their target, or the guild role set when changing hoistPosition.
         * Role deletion also evicts guild memberships because assignments can change without individual member events.
         * Full list reads remove absent roles only without overlapping observations. Partial bulk events replace only supplied roles
         */
        readonly roles?: boolean | ResourceCacheSettings
        /** Opt-in bounded emoji metadata retention, disabled by default. Never retains image bytes or creator accounts.
         * REST reads/writes populate observations; guild expression events invalidate rather than promise a complete list.
         * Uses ResourceCacheSettings budgets, expiry and LRU behavior. Gaps and shutdown clear observations
         */
        readonly emojis?: boolean | ResourceCacheSettings
        /** Opt-in sticker metadata retention with the same ownership, bounds and invalidation rules as emojis */
        readonly stickers?: boolean | ResourceCacheSettings
        /** Guild channel snapshots from explicit reads and channel create/update events, with no initial enumeration.
         * Dispatched channel mutations conservatively clear the entire channel cache, including pending reads.
         * Bulk ordering events evict the guild rather than retaining potentially unfinished permission copies.
         * Category updates/deletions evict the guild because child inheritance can change. Visibility loss evicts the channel.
         * Full list reads remove absent channels only without overlapping observations. This is not a complete guild replica
         */
        readonly channels?: boolean | ResourceCacheSettings
        /**
         * Omitted/false disables message caching. True or an options object enables it.
         * Memory-only snapshots populate from eligible REST results and gateway events, never automatic history requests.
         * Updates replace, deletions and uncertain mutations evict, and gateway gaps clear even after successful resume.
         * Conflicting in-flight observations may cause misses. Shutdown releases this client's retained references
         */
        readonly messages?: boolean | MessageCacheOptions
    }
    /** Client-wide startup settings shared by connect and run, not per-call overrides */
    readonly connection?: {
        /**
         * Overall startup budget in milliseconds, including discovery, every assigned shard's READY, retry waits and local Identify spacing.
         * With multiple shards, this client spaces Identify commands by one second. It does not coordinate an IP-wide or cross-process quota.
         * Must be a positive safe integer no greater than 2,147,483,647.
         * Expiry stops connection work, but returning still waits for owned-resource cleanup
         * @defaultValue 30000
         */
        readonly startupTimeoutMs?: number
        /**
         * Maximum startup attempts per assigned shard, including its first, as a positive safe integer.
         * Only transient failures are retried, and the overall deadline can end startup sooner.
         * Does not set the established-session recovery attempt limit
         * @defaultValue 3
         */
        readonly maxStartupAttempts?: number
    }
    /**
     * Optional immutable local gateway-shard assignment. Omit it to retain the default one-connection gateway wire form.
     * Omitted shardIds assigns every ID in totalShards to this client. Explicit IDs are copied in their supplied order and cannot change during this client's lifetime.
     * Use explicit, non-overlapping lists when an external process supervisor owns distribution. Shard zero owns direct-message gateway traffic, so a client that handles DMs must own ID zero.
     * The SDK copies and validates the plan at creation. It does not auto-size, coordinate processes, or reshard a running client.
     * Supplying one total shard uses the default one-connection gateway wire form, not an Identify shard tuple
     */
    readonly sharding?: ShardingOptions
}

/**
 * Current connection status, not an event history.
 * Disconnected permits startup. Connecting lasts until every locally assigned shard is ready at the same time, including initial retries and recovery.
 * Connected means every locally assigned shard is ready. After that point, Recovering means at least one established shard has a gap until every assigned shard is ready again.
 * Healthy-shard work can continue during aggregate Recovering. Closing means permanent cleanup, and Closed cannot restart
 */
export type ConnectionState = "Disconnected" | "Connecting" | "Connected" | "Recovering" | "Closing" | "Closed"

/** One local cache category. Categories identify SDK-held observation types, not remote collections or identifiers */
export type CacheKind =
    "messages" | "guilds" | "members" | "roles" | "channels" | "users" | "directMessages" | "emojis" | "stickers"

/** Frozen projection type retained by each cache category when that category is configured */
export interface CachedResources {
    readonly messages: Message
    readonly guilds: Guild
    readonly members: GuildMember
    readonly roles: GuildRole
    readonly channels: GuildChannel
    readonly users: User
    readonly directMessages: DirectMessageChannel
    readonly emojis: GuildEmoji
    readonly stickers: GuildSticker
}

/** Bounds one local cache enumeration. Omit limit for 100 snapshots. Values from 1 through 1,000 are accepted */
export interface CacheEntriesOptions {
    readonly limit?: number
}

/** Point-in-time local retention accounting for one cache category */
export interface CacheDiagnostic {
    /** Whether this category was configured when the client was created. A Closing/Closed client accepts no further snapshots */
    readonly configured: boolean
    /** SDK-held observations after expiry pruning, never a remote-resource count or completeness guarantee */
    readonly retainedEntries: number
    /** UTF-8 JSON bytes accounted by this cache, not JavaScript heap, process memory or caller-held projections */
    readonly accountedBytes: number
    /** Configured client-wide entry bound, or null when this category was disabled */
    readonly maxEntries: number | null
    /** Configured client-wide accounted-byte bound, or null when this category was disabled */
    readonly maxBytes: number | null
}

/** Point-in-time local client occupancy with no token, remote route, resource ID or cached payload */
export interface ClientDiagnostics {
    /** Current aggregate client lifecycle state, not an event history or a readiness promise */
    readonly state: ConnectionState
    /** Current aggregate heartbeat latency with the same availability rules as ClientState.gatewayLatencyMs */
    readonly gatewayLatencyMs: number | null
    /** Current locally owned shard state only, in configured local order */
    readonly shards: readonly ShardState[]
    /** Shared local HTTP scheduler occupancy. Queued JSON bytes exclude uploads and do not bound heap or process memory */
    readonly rest: {
        readonly activeRequests: number
        readonly activeCapacity: number
        readonly queuedRequests: number
        readonly queuedCapacity: number
        readonly queuedJsonBytes: number
        readonly queuedJsonByteCapacity: number
    }
    /** SDK-reserved transfer bytes across queued and active work, currently including copied upload inputs but not caller buffers or remote temporary storage */
    readonly uploads: { readonly reservedBytes: number; readonly byteCapacity: number }
    /** Shared local gateway count/member-request occupancy, not Fluxer's worker or a distributed quota */
    readonly gatewayRequests: { readonly activeRequests: number; readonly activeCapacity: number }
    /** Local cache accounting. Configured bounds survive closure, while released observations disappear from retained counts */
    readonly caches: Readonly<Record<CacheKind, CacheDiagnostic>>
}

/** Properties shared by default and native clients */
export interface ClientState {
    /** Current connection state, controlled by the SDK rather than the consumer */
    readonly state: ConnectionState
    /**
     * Maximum current heartbeat round-trip time in milliseconds across every locally owned shard.
     * Null while the aggregate state is not Connected.
     * Null until every locally owned shard has an acknowledgement and whenever any shard has no current measurement.
     * Connection loss, recovery and shutdown clear the affected shard's measurement until its new connection acknowledges.
     * Zero is a valid measurement, not a marker for unavailable data
     */
    readonly gatewayLatencyMs: number | null
    /**
     * Frozen snapshot for every gateway shard owned by this client, in configured local ID order. An unsharded client contains only shard ID zero.
     * It excludes shards owned by other processes and has no whole-bot or cross-process ordering. Read it to distinguish per-shard recovery and latency from aggregate client values
     */
    readonly shards: readonly ShardState[]
}

/** Cancellation belongs to this operation, not the client's connection policy */
export interface OperationOptions {
    /**
     * A standard AbortSignal, expressed structurally to avoid requiring DOM declarations in consumer projects.
     * An already-aborted signal cancels without acquiring ownership.
     * Controls startup for connect, the full accepted lifetime for run, and only the observation for waitForClose.
     * No signal is accepted by shutdown, and completion is never undone by a later abort
     */
    readonly signal?: OperationSignal
}

/** Dependency-free structural cancellation signal accepted by default operations */
export interface OperationSignal {
    readonly aborted: boolean
    addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void
    removeEventListener(type: "abort", listener: () => void): void
}
