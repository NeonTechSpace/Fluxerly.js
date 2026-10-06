import { randomUUID } from "node:crypto"
import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ConnectionState } from "./client.js"
import { ConfigurationError } from "./errors.js"

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
     * instead of starting new sessions. A fallback to a new session clears any partial restored replay from that shard's
     * community caches and dependent resources. A successful Resume retains it. See SessionStore
     */
    readonly sessions?: SessionStore
    /**
     * Whether a shard that resumes a session loaded from sessions refills the enabled community, role and channel
     * caches through REST, default true. Fluxer calls a community a guild. Resume replays missed dispatches but sends no
     * fresh community snapshot, so without the refill those caches contain only observations from replay, later events
     * and requests.
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
 * not after a permanent connection failure, so a crash leaves no fresh snapshot. A saved session closes with private-use
 * code 4000 to preserve Resume. Without persistence, intentional final closure uses 1000, which destroys the session
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
     * If Fluxer no longer holds the session, Resume fails and the shard starts a new session as in any recovery.
     * Partial replay can update caches before RESUMED. A fallback to Identify clears that shard's cached communities and
     * dependent resources, then clears reads cached during the wait again at READY. A successful Resume retains the replay
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
 * Create a SessionStore that keeps each shard's snapshot in its own file, shard-ID.json, inside one directory.
 * Pass it as sharding.sessions so a restart within Fluxer's 60-second window resumes instead of starting new sessions.
 * Use a directory that only the bot's account can read, outside version control, because each file holds a session ID
 * that lets the bot's token resume that session. The store never logs snapshot contents
 *
 * @remarks
 * A relative path resolves against the current working directory when the store is created, and a URL must use the
 * file: scheme. An empty path or another URL scheme throws ConfigurationError.
 * The store creates nothing until the first save. Each save creates the directory when missing, with mode 0700, writes
 * the snapshot to a new temporary file with mode 0600 in that directory, flushes it to disk and renames it over the
 * shard's file, so a crash never leaves a partly written snapshot and the previous file stays until the rename. A failed
 * save removes its temporary file. Windows ignores these modes, so there the directory's access control list decides
 * who can read the files.
 * Load returns undefined when the shard has no file. It returns the parsed file without checking its fields, so the SDK
 * ignores a malformed or outdated snapshot with a lifecycle.sessionSnapshotIgnored Warn. A file that is not valid JSON
 * rejects with an Error that names the file but not its contents, and other file system failures reject with their
 * Node.js error. The SDK logs those rejections as lifecycle.sessionLoadFailed or lifecycle.sessionSaveFailed and
 * continues, as SessionStore describes.
 * Separate processes must use separate directories unless their shard IDs never overlap
 *
 * @example
 * ```ts
 * import { createClient, fileSessionStore } from "@neontechspace/fluxerly"
 *
 * export function resumableClient(token: string) {
 *     return createClient({ token, sharding: { totalShards: "auto", sessions: fileSessionStore("sessions") } })
 * }
 * ```
 *
 * @category Sharding and supervision
 */
export function fileSessionStore(directory: string | URL): SessionStore {
    if (directory instanceof URL ? directory.protocol !== "file:" : typeof directory !== "string" || directory === "")
        throw new ConfigurationError("sessions", "The session directory must be a non-empty path or a file: URL")
    const root = resolve(directory instanceof URL ? fileURLToPath(directory) : directory)
    const file = (shardId: number) => join(root, `shard-${shardId}.json`)
    return Object.freeze({
        async load(shardId: number): Promise<SessionSnapshot | undefined> {
            let text: string
            try {
                text = await readFile(file(shardId), "utf8")
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
                throw error
            }
            try {
                return JSON.parse(text) as SessionSnapshot
            } catch {
                // allow-silent: The SyntaxError quotes file text, which can hold the session ID, so only the file is named
                throw new Error(`The saved session file ${file(shardId)} is not valid JSON`)
            }
        },
        async save(shardId: number, snapshot: SessionSnapshot): Promise<void> {
            await mkdir(root, { recursive: true, mode: 0o700 })
            const target = file(shardId)
            const temporary = `${target}.${randomUUID()}.tmp`
            try {
                const handle = await open(temporary, "wx", 0o600)
                try {
                    await handle.writeFile(JSON.stringify(snapshot))
                    await handle.sync()
                } finally {
                    await handle.close()
                }
                await rename(temporary, target)
            } catch (error) {
                await rm(temporary, { force: true }).catch(() => {
                    // allow-silent: The save failure below is the outcome the SDK logs, and a leftover temporary file is harmless
                })
                throw error
            }
        },
    })
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
