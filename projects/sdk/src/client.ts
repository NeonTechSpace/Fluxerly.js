import type { MessageCacheOptions, ResourceCacheSettings } from "./cache.js"
import type { DefaultLoggingOptions } from "./logging.js"

/**
 * Options accepted when creating a disconnected client
 *
 * Hosted Fluxer only; self-hosted instances and custom REST or gateway endpoints are not supported
 */
export interface ClientOptions {
    /** Client-local upload admission, copied and validated at creation */
    readonly uploads?: {
        /** Maximum SDK-owned file bytes across queued and active operations, as a positive safe integer.
         * Defaults to 104,857,600 (100 MiB), separate from the 4 MiB queued JSON budget.
         * A full budget rejects with busy before copying, rather than waiting while retaining unbounded inputs.
         * Reservations remain held across rate-limit retries and release after transport cleanup.
         * Caller buffers, metadata and runtime overhead are excluded; this is not a process-memory ceiling
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
    /** Optional resource retention, copied and validated at creation. Omission retains no resource snapshots */
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
         * Overall startup budget in milliseconds, including discovery, readiness and retry waits.
         * Must be a positive safe integer no greater than 2,147,483,647.
         * Expiry stops connection work, but returning still waits for owned-resource cleanup
         * @defaultValue 30000
         */
        readonly startupTimeoutMs?: number
        /**
         * Maximum total startup attempts, including the first, as a positive safe integer.
         * Only transient failures are retried, and the overall deadline can end startup sooner.
         * Does not set the established-session recovery attempt limit
         * @defaultValue 3
         */
        readonly maxStartupAttempts?: number
    }
}

/**
 * Current connection status, not an event history.
 * Disconnected permits startup, Connecting includes startup retries, and Connected means readiness completed.
 * Recovering means an established session is reconnecting, Closing means permanent cleanup, and Closed cannot restart
 */
export type ConnectionState = "Disconnected" | "Connecting" | "Connected" | "Recovering" | "Closing" | "Closed"

/** Properties shared by default and native clients */
export interface ClientState {
    /** Current connection state, controlled by the SDK rather than the consumer */
    readonly state: ConnectionState
    /**
     * Latest heartbeat round-trip time in milliseconds for the current connection.
     * Null before an acknowledgement and after connection loss or shutdown, including during recovery.
     * A new connection must receive its own acknowledgement before reporting a measurement.
     * Zero is a valid measurement, not a marker for unavailable data
     */
    readonly gatewayLatencyMs: number | null
}

/** Cancellation belongs to this operation, not the client's connection policy */
export interface OperationOptions {
    /**
     * A standard AbortSignal, expressed structurally to avoid requiring DOM declarations in consumer projects.
     * An already-aborted signal cancels without acquiring ownership.
     * Controls startup for connect, the full accepted lifetime for run, and only the observation for waitForClose.
     * No signal is accepted by shutdown, and completion is never undone by a later abort
     */
    readonly signal?: {
        readonly aborted: boolean
        addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void
        removeEventListener(type: "abort", listener: () => void): void
    }
}
