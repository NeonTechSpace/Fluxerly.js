import type { ClientOptions, ConnectionState, OperationSignal } from "./client.js"

/** One immutable local shard assignment sent from a parent supervisor to its owned child */
export interface SupervisorAssignment {
    /** Immutable total shard count used by this supervisor */
    readonly totalShards: number
    /** Immutable IDs owned by one child process. Other IDs can remain application-owned */
    readonly shardIds: readonly number[]
}

/** One fixed child identifier and its non-overlapping local shard IDs */
export interface SupervisorAssignmentOptions {
    /** Unique nonblank local identifier, at most 128 characters, shown in lifecycle failures and status snapshots */
    readonly id: string
    /** One or more unique shard IDs from zero through totalShards minus one */
    readonly shardIds: readonly number[]
}

/** Structural file-URL input. Node's URL object satisfies this without requiring DOM types in default consumers */
export interface SupervisorFileUrl {
    /** Complete file URL string */
    readonly href: string
    /** URL protocol, which must be file: */
    readonly protocol: string
}

/** Bounded replacement policy for unexpected exits of locally owned children */
export interface SupervisorRestartOptions {
    /** Replacement attempts after an unexpected child exit, an integer from 0 through 100. Omit restart to disable replacement
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

/** Conservative spacing for fresh supervised gateway Identify commands */
export interface SupervisorIdentifyOptions {
    /** Minimum interval between child-confirmed fresh Identify sends in milliseconds, an integer from 1,000 through 2,147,483,647
     * @defaultValue 1000
     */
    readonly minimumSpacingMs?: number
}

/** Options for an optional local Node process supervisor. Every launch value is copied at create before any child starts */
export interface SupervisorOptions {
    /** Absolute module path string or file-URL object passed to every Node child-process fork. A file-URL string is not accepted */
    readonly entry: string | SupervisorFileUrl
    /** Total gateway shard count used by each supervised child client, from 1 through 16,384 */
    readonly totalShards: number
    /** Nonempty fixed non-overlapping assignments for local children. They may intentionally leave shards application-owned */
    readonly assignments: readonly SupervisorAssignmentOptions[]
    /** Replacement policy for unexpected local child exits. Omitting this option disables replacement */
    readonly restart?: SupervisorRestartOptions
    /** Parent-side fresh-Identify pacing shared by these children */
    readonly identify?: SupervisorIdentifyOptions
    /** Bound for each fork, including replacements, to acknowledge assignment and configuration, not gateway READY, in milliseconds.
     * A positive safe integer no greater than 2,147,483,647. Failure still awaits owned child exit
     * @defaultValue 30000
     */
    readonly startupTimeoutMs?: number
    /** Grace period before this parent force-terminates one unresponsive owned child, in milliseconds.
     * A positive safe integer no greater than 2,147,483,647. Verified exit can take longer than this grace period
     * @defaultValue 5000
     */
    readonly shutdownTimeoutMs?: number
    /** Up to 64 explicit string environment overrides copied over the inherited environment at creation.
     * Keys use ASCII letters, digits and underscores, starting with a letter or underscore; values have at most 4,096 characters.
     * The parent retains this launch snapshot, including any credentials supplied there, until owned children exit. Status and failures exclude it
     */
    readonly childEnvironment?: Readonly<Record<string, string>>
    /** Explicit program arguments for every owned child. Defaults to empty; at most 64 strings of at most 4,096 characters each */
    readonly args?: readonly string[]
    /** Node executable arguments for every owned child. Defaults to the parent's execArgv snapshot.
     * At most 64 strings of at most 4,096 characters each. The SDK's development-only fluxerly-source condition is removed
     */
    readonly execArgv?: readonly string[]
}

/** Child-run settings shared by the default and Effect-native entry points */
export interface SupervisorChildOptions {
    /** Credential passed by child.run to its helper-owned client */
    readonly token: string
    /** Client settings copied into the child client. Runtime validation rejects token and sharding overrides */
    readonly clientOptions?: Omit<ClientOptions, "token" | "sharding">
}

/** Cancellation for one default supervisor readiness observer. It does not own or stop the supervisor */
export interface SupervisorWaitOptions {
    /** Cancels only this wait. An already-aborted signal cancels without starting, stopping or restarting any child */
    readonly signal?: OperationSignal
}

/** Current local lifetime state for one optional supervisor */
export type SupervisorState = "idle" | "starting" | "running" | "stopping" | "closed" | "failed"

/** Current local process state for one fixed child assignment */
export type SupervisorChildState = "idle" | "starting" | "running" | "restarting" | "stopping" | "closed" | "failed"

/** Immutable safe local status for one owned child */
export interface SupervisorChildStatus {
    /** Stable child identifier from the original assignment */
    readonly id: string
    /** Immutable assignment retained by this supervisor */
    readonly assignment: SupervisorAssignment
    /** Incremented for every fork attempt of this assignment */
    readonly generation: number
    /** Current owned child process ID, or null before a process starts or after verified exit */
    readonly pid: number | null
    /** Scheduled replacement attempts for this child, including one waiting for its restart delay */
    readonly restarts: number
    /** Current local lifecycle state */
    readonly state: SupervisorChildState
    /** Last current-generation aggregate gateway state received from this child, or null before its first observation or after IPC becomes unavailable. It is not a cross-process atomic health report */
    readonly connectionState: ConnectionState | null
}

/** Immutable safe local snapshot without child paths, arguments, environment or stdio */
export interface SupervisorStatus {
    /** Current supervisor lifecycle state */
    readonly state: SupervisorState
    /** Fixed status for every local assignment */
    readonly children: readonly SupervisorChildStatus[]
}

/** Safe local-supervisor failure. Child output, environment and arguments are never included */
export class SupervisorError extends Error {
    readonly _tag = "SupervisorError"

    constructor(
        /** Child whose local lifecycle failed, when one is applicable */
        readonly childId: string | null,
        /** Safe lifecycle category without an operating-system error message */
        readonly reason: "closed" | "spawn" | "protocol" | "restartLimit" | "startupTimeout",
    ) {
        super(childId === null ? `Supervisor ${reason}` : `Supervisor child ${childId} ${reason}`)
        this.name = this._tag
    }
}

/** Child IPC became unavailable before the helper could complete its owned cleanup */
export class SupervisorChildError extends Error {
    readonly _tag = "SupervisorChildError"

    constructor(
        /** Whether the parent disconnected or sent malformed internal coordination data */
        readonly reason: "disconnected" | "protocol",
    ) {
        super(`Supervisor child ${reason}`)
        this.name = this._tag
    }
}
