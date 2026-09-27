import type { ConnectionState } from "./client.js"

/**
 * Connection-attempt snapshot for one shard, a gateway connection owned by this client.
 * Recovery means reconnecting after the shard has previously established a session.
 * Endpoint, session credentials and provider failure details are excluded
 *
 * @category Sharding and supervision
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
 * Divide the bot's community events among gateway connections called shards.
 * Set this when the bot needs more than one gateway connection or this client should own only part of a shared shard plan.
 * One client can own several shards within one process. Separate processes use separate clients
 *
 * Every process serving the same bot must use the same total and avoid overlapping ownership.
 * Omit shardIds to own every ID from zero through totalShards minus one
 *
 * Creation validates the plan and copies the supplied IDs in order without changing caller input.
 * Invalid plans fail creation with ConfigurationError. An explicit plan cannot change during the client's lifetime.
 * An automatic plan moves to a larger one while the client runs when Fluxer closes a shard with 4011 (sharding required)
 *
 * Shard zero receives direct-message gateway traffic. Include it when this client must receive direct messages.
 * The SDK does not coordinate other processes unless identify supplies a coordinator
 *
 * With totalShards set to 1, session startup sends no shard tuple in the gateway Identify command.
 * Default-API and native clients accept the same plan. Native validation and copying happen when the creation Effect runs
 *
 * @category Sharding and supervision
 */
export interface ShardingOptions {
    /**
     * Immutable total gateway shards for this bot, an integer from 1 through 16,384 shared by every process serving it.
     * Fluxer closes a shard with 4011 (sharding required) when it serves more than 2,500 communities, and with an explicit
     * total that closure ends the client with a ConnectionError.
     * The value "auto" lets this client size the plan itself and own every shard, as the sharding value "auto" does, while
     * keeping identify and sessions available
     */
    readonly totalShards: number | "auto"
    /** Immutable non-empty local IDs, each unique integer from 0 through totalShards minus one.
     * Omit to own every ID in ascending order. Automatic sizing requires omission
     */
    readonly shardIds?: readonly number[]
    /**
     * Coordinate new-session Identify commands with other processes, for example through a shared lock service.
     * The coordinator then owns pacing: The SDK waits for permit before each Identify and adds no spacing of its own.
     * Resume never waits for it. See IdentifyCoordinator
     */
    readonly identify?: IdentifyCoordinator
    /**
     * Keep resumable sessions across process restarts, so a restart within Fluxer's 60-second resume window can Resume
     * instead of starting new sessions. See SessionStore
     */
    readonly sessions?: SessionStore
    /**
     * Whether a shard that resumes a session loaded from sessions refills the enabled community, role and channel
     * caches through REST, default true. Fluxer calls a community a guild. A resumed session receives no community
     * data, so without the refill those caches start empty and fill only as events and requests arrive.
     * Once every shard is ready, the SDK lists the bot's communities and fetches each one on a resumed shard, one
     * request at a time, so application requests keep the other REST slots and every request respects rate limits.
     * It logs lifecycle.cacheRefill when done. Set false to skip the refill, for example for a bot that reads no cache
     * @defaultValue true
     */
    readonly refillCaches?: boolean
}

/**
 * Coordinates Identify commands for shards that start new sessions, so several processes serving one bot can respect
 * Fluxer's shared Identify budget.
 * Creation copies the permit function, bound to its object, and later changes to the object have no effect.
 * Clients that a local supervisor starts cannot set one, because the supervisor paces their Identify commands. Pass the
 * coordinator to the supervisor option identify.coordinator instead, and the supervisor consults it for every child
 *
 * @category Sharding and supervision
 */
export interface IdentifyCoordinator {
    /**
     * Resolve when the shard may send Identify now. The SDK calls this once per new-session attempt and sends Identify as
     * soon as the promise resolves, without spacing of its own, so pace permits within Fluxer's budget of 300 Identify
     * commands per source IP address in each 60-second window.
     * Only one permit per client is outstanding at a time, so a slow permit delays this client's other shards.
     * The wait counts against the startup deadline during startup and against the recovery attempt timeout during recovery.
     * The signal aborts when the attempt ends first, for example on timeout or shutdown, so resolve or reject promptly then.
     * A rejection or thrown error fails that connection attempt: The SDK logs the error in full at Error with code
     * lifecycle.identifyPermitFailed and retries like a transient connection failure, so repeated rejection can end
     * startup with a ConnectionError whose cause is the rejection
     *
     * @param shardId The local shard about to Identify
     * @param totalShards The plan's total shard count, useful for a bucket key such as shardId modulo a concurrency
     * @param signal Aborted when the SDK no longer needs this permit
     */
    permit(shardId: number, totalShards: number, signal: AbortSignal): Promise<void>
}

/**
 * The resumable state of one shard's gateway session, saved at shutdown and offered again at the next startup.
 * It holds the session ID, which lets the bot's token resume the session, so store it as carefully as other secrets
 *
 * @category Sharding and supervision
 */
export interface SessionSnapshot {
    /** Session ID from Fluxer's READY */
    readonly sessionId: string
    /** Last dispatch sequence this client received on the session, a non-negative integer */
    readonly sequence: number
    /**
     * Gateway URL the session connected to. Fluxer publishes no separate resume URL, so this is the discovered gateway
     * endpoint. A loaded snapshot is used only when it matches the endpoint the new client discovers
     */
    readonly resumeUrl: string
    /** Wall-clock time the snapshot was taken, in Unix epoch milliseconds, after the session's socket closed */
    readonly savedAt: number
    /**
     * Total shard count of the plan the session identified with. A session belongs to that plan, so a loaded snapshot is
     * used only when the new client's plan has the same total
     */
    readonly totalShards: number
}

/**
 * Persist resumable gateway sessions across restarts. Fluxer retains a disconnected session for 60,000 ms, so a
 * process that restarts within that window can Resume and receive the dispatches it missed, subject to Fluxer's replay
 * limits. Creation copies both functions, bound to their object.
 * Snapshots are saved only during shutdown, after each shard's socket has closed, never while a session is live and
 * not after a permanent connection failure, so a crash leaves no fresh snapshot. The closure uses the normal WebSocket
 * code, which Fluxer documents as leaving the session resumable
 *
 * @category Sharding and supervision
 */
export interface SessionStore {
    /**
     * Return the snapshot saved for this shard, or undefined when none exists. The SDK calls this once per shard at the
     * first connection attempt after discovery, and allows 5,000 ms, within the startup deadline.
     * A snapshot older than 60,000 ms, saved more than 5,000 ms in the future, malformed, for a different gateway
     * endpoint or for a plan with a different totalShards is ignored and logged at Warn with code
     * lifecycle.sessionSnapshotIgnored.
     * A rejection, thrown error or timeout is logged in full at Error with code lifecycle.sessionLoadFailed.
     * Either way the shard starts a new session, so load problems never fail startup.
     * If Fluxer no longer holds the session, Resume fails and the shard starts a new session as in any recovery
     *
     * @param shardId The local shard starting up
     */
    load(shardId: number): Promise<SessionSnapshot | undefined>
    /**
     * Store a snapshot for this shard. The SDK calls this during shutdown for each shard that holds a resumable
     * session, after its socket has closed and before shutdown completes, and allows each call 5,000 ms.
     * Shutdown waits for these calls, then continues regardless of the outcome.
     * A rejection, thrown error or timeout is logged in full at Error with code lifecycle.sessionSaveFailed
     *
     * @param shardId The local shard the snapshot belongs to
     * @param snapshot The frozen resumable state
     */
    save(shardId: number, snapshot: SessionSnapshot): Promise<void>
}

/**
 * Frozen connection-state snapshot for one gateway shard owned by this client.
 * Use client.shards to inspect local connections rather than the health of other processes or the whole bot.
 * An explicit plan keeps its shards for the client's lifetime. A client without sharding options reports shard ID zero.
 * An automatically sized client reports no shards until its first connect has chosen the plan, and reports the new
 * plan's shards after it moves to a larger plan
 *
 * @category Sharding and supervision
 */
export interface ShardState {
    /** This client's local shard ID, retained in the configured local order */
    readonly shardId: number
    /** Current connection status for this shard */
    readonly state: ConnectionState
    /** Latest current-connection heartbeat round trip in milliseconds, or null when no measurement is current */
    readonly gatewayLatencyMs: number | null
    /** Current safe connection attempt or retry snapshot, or null when this shard is not attempting or waiting */
    readonly recovery: ShardRecoveryDiagnostic | null
}
