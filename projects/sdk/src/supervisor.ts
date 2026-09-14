import type { ClientOptions, ConnectionState, OperationSignal } from "./client.js"

/**
 * Gateway connections assigned to one child process by its parent supervisor.
 * A shard is one gateway connection responsible for a portion of the bot's server events.
 * The helper copies and freezes this assignment before creating the child client
 */
export interface SupervisorAssignment {
    /** Immutable total shard count used by this supervisor */
    readonly totalShards: number
    /** Fixed shard IDs owned by this child, in configured order. Shards outside this list are not owned by this child */
    readonly shardIds: readonly number[]
}

/** Name and shard IDs for one Node process that the supervisor starts and stops */
export interface SupervisorAssignmentOptions {
    /** Unique nonblank local identifier, at most 128 characters, shown in lifecycle failures and status snapshots */
    readonly id: string
    /** One or more unique shard IDs from zero through totalShards minus one */
    readonly shardIds: readonly number[]
}

/**
 * File URL identifying the JavaScript module to run in each child process.
 * A Node URL object satisfies this interface without requiring DOM types in default-API TypeScript consumers
 */
export interface SupervisorFileUrl {
    /** Complete file URL string */
    readonly href: string
    /** URL protocol, which must be `file:` */
    readonly protocol: string
}

/**
 * Restart a child process after it exits, unless the supervisor has begun shutdown or failed.
 * Each child has its own lifetime attempt budget, which does not reset after successful startup.
 * Delays double after each replacement, up to maxDelayMs. Replacement starts only after the previous process exits.
 * This replaces a process, not a client's gateway reconnection or session recovery
 */
export interface SupervisorRestartOptions {
    /** Maximum replacement attempts per child, an integer from 0 through 100. Zero permits no replacement
     * @defaultValue 3 when restart is supplied
     */
    readonly maxAttempts?: number
    /** First replacement delay in milliseconds, a positive safe integer no greater than maxDelayMs
     * @defaultValue 1000 when restart is supplied
     */
    readonly minDelayMs?: number
    /** Maximum exponential replacement delay in milliseconds, a positive safe integer no greater than 2,147,483,647
     * @defaultValue 30000 when restart is supplied
     */
    readonly maxDelayMs?: number
}

/**
 * Space out new gateway session starts across the children owned by one supervisor.
 * A fresh Identify command starts a session. Resuming an existing session does not use this spacing.
 * The parent waits for a child to confirm its send before granting the next permit.
 * This does not coordinate another supervisor or an application-owned client
 */
export interface SupervisorIdentifyOptions {
    /** Minimum interval between child-confirmed fresh Identify sends in milliseconds, an integer from 1,000 through 2,147,483,647
     * @defaultValue 1000
     */
    readonly minimumSpacingMs?: number
}

/**
 * Plan for running bot gateway connections in separate local Node processes.
 * A supervisor is the parent that starts, monitors and stops its own child processes.
 * Use it when you need separate processes. A client can own multiple shards without a supervisor.
 * Each child module must call supervisor.child.run from its chosen public entry point.
 * Creation validates and copies the launch settings without starting a process.
 * Default-API creation runs immediately. Native creation copies settings when its Effect runs.
 * Assignments stay fixed across replacements. This supervisor neither discovers the shard count nor coordinates other parents
 */
export interface SupervisorOptions {
    /** Absolute module path string or file-URL object passed to every Node child-process fork. A file-URL string is not accepted */
    readonly entry: string | SupervisorFileUrl
    /** Total gateway shard count for this bot, an integer from 1 through 16,384. Other processes serving it must use the same total */
    readonly totalShards: number
    /** One to totalShards fixed child assignments, with unique IDs and no overlapping shard IDs. Unassigned shards remain application-owned */
    readonly assignments: readonly SupervisorAssignmentOptions[]
    /** Replacement policy for unexpected local child exits. Omitting this option disables replacement */
    readonly restart?: SupervisorRestartOptions
    /** Parent-side fresh-Identify pacing shared by these children */
    readonly identify?: SupervisorIdentifyOptions
    /** Time allowed for each child to receive its assignment and finish configure, in milliseconds, including replacement children.
     * This does not wait for the gateway READY event that establishes a connected session.
     * A positive safe integer no greater than 2,147,483,647. Timeout fails the supervisor, which stops its children and awaits their exit
     * @defaultValue 30000
     */
    readonly startupTimeoutMs?: number
    /** Time allowed for an owned child to exit after a stop request, in milliseconds, before the parent force-terminates it.
     * A positive safe integer no greater than 2,147,483,647. Shutdown still awaits the process exit, which can take longer.
     * IPC is Node's parent-child message channel. If a current child loses IPC, it has this long to exit naturally.
     * If that window expires, the supervisor fails with closed and force-terminates that child without a second grace period.
     * Other owned children receive their normal stop request and grace period
     * @defaultValue 5000
     */
    readonly shutdownTimeoutMs?: number
    /** Up to 64 explicit string environment overrides copied over the inherited environment at creation.
     * Keys use ASCII letters, digits and underscores, starting with a letter or underscore.
     * Values have at most 4,096 characters.
     * The parent retains this launch snapshot, including any credentials supplied there, until owned children exit. Status and failures exclude it
     */
    readonly childEnvironment?: Readonly<Record<string, string>>
    /** Program arguments for every owned child, at most 64 strings of at most 4,096 characters each
     * @defaultValue []
     */
    readonly args?: readonly string[]
    /** Node executable arguments for every owned child. Omit to copy the parent's process.execArgv.
     * At most 64 strings of at most 4,096 characters each. The SDK's development-only fluxerly-source condition is removed
     */
    readonly execArgv?: readonly string[]
}

/** Credentials and client settings for the default API's child helper. Native child options use native client settings */
export interface SupervisorChildOptions {
    /** Bot token for the client created by child.run. The parent assignment does not supply this credential */
    readonly token: string
    /** Client settings copied into the child client. Runtime validation rejects token and sharding overrides */
    readonly clientOptions?: Omit<ClientOptions, "token" | "sharding">
}

/** Cancel one default-API waitForReady call without stopping or restarting the supervisor */
export interface SupervisorWaitOptions {
    /** Cancels only this wait. An already-aborted signal cancels without starting, stopping or restarting any child */
    readonly signal?: OperationSignal
}

/**
 * Local parent-process lifetime state, not the bot's gateway readiness.
 * Running means the children acknowledged their assignment and configuration.
 * Failed can still include live children while cleanup waits for their exit
 */
export type SupervisorState = "idle" | "starting" | "running" | "stopping" | "closed" | "failed"

/**
 * Local process state for a fixed child assignment, not its gateway connection state.
 * Running means the child finished configuration. Restarting means a replacement delay is pending
 */
export type SupervisorChildState = "idle" | "starting" | "running" | "restarting" | "stopping" | "closed" | "failed"

/** Frozen snapshot of one child assignment and its current process, without launch settings or child output */
export interface SupervisorChildStatus {
    /** Stable child identifier from the original assignment */
    readonly id: string
    /** Immutable assignment retained by this supervisor */
    readonly assignment: SupervisorAssignment
    /** Fork attempts for this assignment, starting at zero before startup and incrementing even if a fork fails */
    readonly generation: number
    /** Current owned child process ID, or null before a process starts or after verified exit */
    readonly pid: number | null
    /** Replacement attempts used from this child's lifetime budget, including a replacement waiting for its delay */
    readonly restarts: number
    /** Current local lifecycle state */
    readonly state: SupervisorChildState
    /** Last aggregate gateway connection state reported by the current child process after configuration.
     * Null before its first accepted report, after exit or when IPC is unavailable. Reports from different children are not simultaneous
     */
    readonly connectionState: ConnectionState | null
}

/** Immutable safe local snapshot without child paths, arguments, environment or stdio */
export interface SupervisorStatus {
    /** Current supervisor lifecycle state */
    readonly state: SupervisorState
    /** One snapshot per configured child assignment, in configured order, including children with no current process */
    readonly children: readonly SupervisorChildStatus[]
}

/**
 * Parent-process lifecycle failure, not the child's original client or configuration error.
 * Child output, environment, arguments and operating-system error messages are excluded.
 * A failing start or waitForClose settles only after owned child processes exit
 */
export class SupervisorError extends Error {
    /** Discriminator for this SDK failure */
    readonly _tag = "SupervisorError"

    /** Construct a lifecycle failure from a safe child identifier and category */
    constructor(
        /** Child whose local lifecycle failed, when one is applicable */
        readonly childId: string | null,
        /** `closed` means the lifetime ended or coordination was lost. `spawn` means a launch or IPC-send failure.
         * `protocol` means invalid coordination data. `restartLimit` means the child exhausted its replacement budget.
         * `startupTimeout` means a child did not acknowledge assignment and configuration within its startup budget
         */
        readonly reason: "closed" | "spawn" | "protocol" | "restartLimit" | "startupTimeout",
    ) {
        super(childId === null ? `Supervisor ${reason}` : `Supervisor child ${childId} ${reason}`)
        this.name = this._tag
    }
}

/** Child-helper failure because the parent's message channel is unavailable or carries invalid coordination data */
export class SupervisorChildError extends Error {
    /** Discriminator for this SDK failure */
    readonly _tag = "SupervisorChildError"

    /** Construct a child coordination failure without retaining message contents */
    constructor(
        /** Whether the parent disconnected or sent malformed internal coordination data */
        readonly reason: "disconnected" | "protocol",
    ) {
        super(`Supervisor child ${reason}`)
        this.name = this._tag
    }
}
