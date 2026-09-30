import { FluxerlyError, operationDetails } from "./errors.js"
import type { ClientDiagnostics, ClientOptions, ConnectionState, OperationSignal } from "./client.js"
import type { InstanceOptions } from "./instance.js"
import type { TransportOptions } from "./rest.js"
import type { IdentifyCoordinator, SessionStore } from "./sharding.js"

/**
 * Gateway connections assigned to one child process by its parent supervisor.
 * A shard is one gateway connection responsible for a portion of the bot's community events.
 * The helper copies and freezes this assignment before creating the child client
 *
 * @category Sharding and supervision
 */
export interface SupervisorAssignment {
    /** Immutable total shard count used by this supervisor */
    readonly totalShards: number
    /** Fixed shard IDs owned by this child, in configured order. Shards outside this list are not owned by this child */
    readonly shardIds: readonly number[]
}

/**
 * Name and shard IDs for one Node process that the supervisor starts and stops.
 * Unknown option keys fail with ConfigurationError, with a suggested name when one is close
 *
 * @category Sharding and supervision
 */
export interface SupervisorAssignmentOptions {
    /** Unique nonblank local identifier, at most 128 characters, shown in lifecycle failures and status snapshots */
    readonly id: string
    /** One or more unique shard IDs from zero through totalShards minus one */
    readonly shardIds: readonly number[]
}

/**
 * File URL identifying the JavaScript module to run in each child process.
 * A Node URL object satisfies this interface without requiring DOM types in default-API TypeScript consumers
 *
 * @category Sharding and supervision
 */
export interface SupervisorFileUrl {
    /** Complete file URL string */
    readonly href: string
    /** URL protocol, which must be `file:` */
    readonly protocol: string
}

/**
 * Restart a child process after it exits, unless the supervisor has begun shutdown or failed.
 * Restart is on by default with the defaults below. The supervisor option restart set to false turns it off.
 * Each child has its own budget of consecutive restarts. A child that ran for healthyResetMs after finishing
 * configuration gets its full budget and the first delay back at its next exit, so only a crash loop exhausts the budget.
 * Delays double after each replacement, up to maxDelayMs. Replacement starts only after the previous process exits.
 * This starts a new process. It does not reconnect the client's gateway or recover its session
 *
 * @category Sharding and supervision
 */
export interface SupervisorRestartOptions {
    /** Maximum replacement attempts per child, an integer from 0 through 100. Zero permits no replacement
     * @defaultValue 3
     */
    readonly maxAttempts?: number
    /** First replacement delay in milliseconds, a positive safe integer no greater than maxDelayMs
     * @defaultValue 1000
     */
    readonly minDelayMs?: number
    /** Maximum exponential replacement delay in milliseconds, a positive safe integer no greater than 2,147,483,647
     * @defaultValue 30000
     */
    readonly maxDelayMs?: number
    /** Milliseconds a child must run after finishing configuration for its next exit to start a fresh restart budget,
     * a positive safe integer no greater than 2,147,483,647. The supervisor.restart record then has fields.budgetReset true
     * @defaultValue 60000
     */
    readonly healthyResetMs?: number
}

/**
 * Space out new gateway session starts across the children owned by one supervisor.
 * A new gateway Identify command starts a session. Resuming an existing session does not use this spacing.
 * The parent waits for a child to confirm its send before granting the next permit.
 * Without a coordinator this does not coordinate another supervisor or an application-owned client.
 * Unknown option keys fail with ConfigurationError, with a suggested name when one is close
 *
 * @category Sharding and supervision
 */
export interface SupervisorIdentifyOptions {
    /** Minimum interval between child-confirmed fresh Identify sends in milliseconds, an integer from 1,000 through 2,147,483,647.
     * Cannot be combined with coordinator
     * @defaultValue 1000
     */
    readonly minimumSpacingMs?: number
    /**
     * Share Fluxer's Identify budget with other supervisors and clients, for example across several hosts, through the
     * same IdentifyCoordinator a client accepts in sharding.identify.
     * Before each grant the parent calls permit with the child's shard ID, the supervisor's total shard count and a
     * signal, and grants the child only after the promise resolves. The coordinator then owns pacing, so the parent adds
     * no spacing of its own. The signal aborts when the child no longer needs the permit, for example when its connection
     * attempt times out, it exits or the supervisor stops.
     * A rejection or thrown error is logged in full at Error with code supervisor.identifyPermitFailed, and the child
     * retries its connection attempt as after a network failure.
     * Creation copies the permit function, bound to its object
     */
    readonly coordinator?: IdentifyCoordinator
}

/**
 * Plan for running bot gateway connections in separate local Node processes.
 * The supervisor is a parent process that starts, monitors and stops its child processes.
 * Use it when separate processes are needed. A client can own multiple shards without a supervisor.
 * Each child module must call supervisor.child.run from its chosen public entry point.
 * Creation validates and copies the launch settings without starting a process.
 * Default-API creation runs immediately. Native creation copies settings when its Effect runs.
 *
 * Choose the child processes with exactly one of assignments, processes or shardsPerProcess.
 * With processes or shardsPerProcess the supervisor splits the shards into contiguous blocks of almost equal size, one
 * block per child, and names the children process-0, process-1 and so on.
 * With totalShards set to "auto" the supervisor sizes the plan at start as a client with sharding "auto" does, from the
 * number of communities the bot is in. Communities are what the API calls guilds.
 * Assignments stay fixed across replacements. Without an identify coordinator, this supervisor does not coordinate other parents
 *
 * @category Sharding and supervision
 */
export interface SupervisorOptions {
    /** Absolute module path string or file-URL object passed to every Node child-process fork. A file-URL string is not accepted */
    readonly entry: string | SupervisorFileUrl
    /**
     * Total gateway shard count for this bot, an integer from 1 through 16,384. Other processes serving it must use the same total.
     * The value "auto" counts the bot's communities once, at start, by paging GET /users/@me/guilds within
     * startupTimeoutMs, and uses one shard per 2,000 communities, from 1 through 16,384 shards. The count needs the
     * token option, and it works only with processes or shardsPerProcess, because fixed assignments need a known total.
     * A failed count fails start with SupervisorError reason shardCount, whose cause is the AuthenticationError,
     * RateLimitError, ConnectionTimeoutError or ConnectionError of the count. Until the count completes, status lists no children.
     * Restarts keep the plan. When Fluxer closes a child's shard with 4011 (sharding required) because the bot outgrew
     * the plan, the supervisor stops every child, counts again and starts children for a larger plan, as a client with
     * sharding "auto" does, logging a supervisor.resharded Warn record. Events sent during the move are missed.
     * After 3 moves within an hour, or at 16,384 shards, a further 4011 fails the supervisor with reason closed instead
     */
    readonly totalShards: number | "auto"
    /** One to totalShards fixed child assignments, with unique IDs and no overlapping shard IDs. Unassigned shards remain application-owned.
     * Cannot be combined with processes or shardsPerProcess
     */
    readonly assignments?: readonly SupervisorAssignmentOptions[]
    /** Number of child processes that share every shard, an integer from 1 through 16,384.
     * With a numeric totalShards it can be at most totalShards. With "auto", a plan with fewer shards than processes
     * starts one process per shard
     */
    readonly processes?: number
    /** Shards per child process, an integer from 1 through 16,384. The last process owns the remainder when the total
     * does not divide evenly
     */
    readonly shardsPerProcess?: number
    /** Bot token used only to count the bot's communities when totalShards is "auto", such as `process.env.FLUXER_BOT_TOKEN`.
     * Children still receive their own token through supervisor.child.run. Required with "auto" and rejected otherwise
     */
    readonly token?: string | undefined
    /** Fluxer instance for the community count when totalShards is "auto", as the client option instance. Rejected otherwise */
    readonly instance?: InstanceOptions
    /** HTTP implementation and User-Agent for the community count when totalShards is "auto", as the client option transport.
     * Rejected otherwise
     */
    readonly transport?: TransportOptions
    /** Replacement policy for unexpected local child exits. Omit it to restart with the defaults of
     * SupervisorRestartOptions, or set false so that one unexpected exit stops the whole supervisor
     */
    readonly restart?: SupervisorRestartOptions | false
    /** Parent-side fresh-Identify pacing shared by these children, or a coordinator shared with other processes */
    readonly identify?: SupervisorIdentifyOptions
    /** How often each running child sends its client diagnostics to the parent, in milliseconds, an integer from 1,000
     * through 2,147,483,647. A child also sends one snapshot as soon as it finishes configuration. See SupervisorChildStatus
     * @defaultValue 5000
     */
    readonly diagnosticsIntervalMs?: number
    /** Time allowed for each child to receive its assignment and finish configure, in milliseconds, including replacement children.
     * This does not wait for the gateway READY event that establishes a connected session.
     * With totalShards "auto" the community count before the first child starts has its own deadline of the same length.
     * A positive safe integer no greater than 2,147,483,647. Timeout fails the supervisor, which stops its children and awaits their exit
     * @defaultValue 30000
     */
    readonly startupTimeoutMs?: number
    /** Time allowed for an owned child to exit after a stop request, in milliseconds, before the parent force-terminates it.
     * A positive safe integer no greater than 2,147,483,647. Shutdown still awaits the process exit, which can take longer.
     * A stopping child first lets running handlers and REST requests finish for up to this time minus one second, as
     * the client shutdown option drainMs does, and keeps that second to close its connections.
     * IPC is Node's parent-child message channel. If a current child loses IPC, it has this long to exit naturally.
     * If that window expires, the supervisor fails with closed and force-terminates that child without a second grace period.
     * Other owned children receive their normal stop request and grace period
     * @defaultValue 5000
     */
    readonly shutdownTimeoutMs?: number
    /** Up to 64 explicit string environment overrides copied over the inherited environment at creation.
     * Keys use ASCII letters, digits and underscores, starting with a letter or underscore.
     * Values have at most 4,096 characters.
     * The parent retains this launch snapshot, including any credentials supplied there, until owned children exit. Status and errors do not contain these settings
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
    /** How child standard output and error reach this process
     *
     * The default, prefix, forwards each child line through this process in the supervisor's console format.
     * In pretty format each line gets a label: [shard N] for a child owning one shard, otherwise [child id].
     * In json format the output stays valid JSON Lines: A child's SDK record gains a fields.child entry, another JSON
     * object passes through unchanged, and other text becomes a supervisor.childOutput record.
     * Children receive the supervisor's resolved format and color through FLUXERLY_LOG_FORMAT and FLUXERLY_LOG_COLOR,
     * unless those variables are already set, so a default-API child prints readable lines when this process writes to a terminal.
     * Lines longer than 262,144 characters are truncated with a marker, and child output pauses while this process's
     * output applies backpressure. Exit handling waits up to one second after a child exits for its output to drain
     *
     * The value inherit shares this process's streams without labels, and ignore discards child output
     * @defaultValue "prefix"
     */
    readonly childOutput?: "prefix" | "inherit" | "ignore"
    /** Records for the automatic plan, child spawn, exit with code and signal, crash, restart and refused Identify permits, in the supervisor log category.
     * Accepts the same settings as client logging. Default output prints these records at Info and higher.
     * The native supervisor sends them to the Effect logger of the context that creates it unless a sink or format is set
     */
    readonly logging?: import("./logging.js").LoggingOptions
}

/**
 * Credentials and client settings for the default API's child helper. Native child options use native client settings.
 * Unknown child option keys fail with ConfigurationError before waiting for the parent, with a suggested name when one is close
 *
 * @category Sharding and supervision
 */
export interface SupervisorChildOptions {
    /** Bot token for the client created by child.run, such as `process.env.FLUXER_BOT_TOKEN`. The parent assignment does
     * not supply this credential. A missing or blank value fails child.run with ConfigurationError once the assignment arrives,
     * as createClient does, and the parent sees the child fail during configuration
     */
    readonly token: string | undefined
    /** Every client setting except token is read by property name and copied before configure, including inherited and
     * non-enumerable properties. The supervisor assigns the shards, so sharding accepts only sessions.
     * Runtime validation rejects a token, a shard plan or identify coordinator in sharding, and any other own key that
     * is not a client option, with ConfigurationError
     */
    readonly clientOptions?: Omit<ClientOptions, "token" | "sharding"> & {
        /** Session storage for the assigned shards. The parent assigns the shards and paces Identify, so only sessions is accepted */
        readonly sharding?: SupervisorChildSharding
    }
}

/**
 * Sharding settings a supervised child may add to the shards its parent assigns
 *
 * @category Sharding and supervision
 */
export interface SupervisorChildSharding {
    /**
     * Keep this child's resumable sessions across process restarts, as the client option sharding.sessions does.
     * A deploy that stops the supervisor and starts it again within Fluxer's 60-second resume window then resumes each
     * shard instead of starting a new session. Snapshots are saved only when the child shuts down normally, so a
     * restart after a crash starts new sessions. The child saves while it shuts down, so saves must finish within the
     * supervisor option shutdownTimeoutMs, after which the parent force-terminates the child. See SessionStore
     */
    readonly sessions?: SessionStore
}

/**
 * Cancel one default-API waitForReady call without stopping or restarting the supervisor.
 * Unknown option keys return ConfigurationError before observation, with a suggested name when one is close
 *
 * @category Sharding and supervision
 */
export interface SupervisorWaitOptions {
    /** Cancels only this wait. An already-aborted signal cancels without starting, stopping or restarting any child */
    readonly signal?: OperationSignal
}

/**
 * Local parent-process lifetime state, not the bot's gateway readiness.
 * Running means the children acknowledged their assignment and configuration.
 * Failed can still include live children while cleanup waits for their exit
 *
 * @category Sharding and supervision
 */
export type SupervisorState = "idle" | "starting" | "running" | "stopping" | "closed" | "failed"

/**
 * Local process state for a fixed child assignment, not its gateway connection state.
 * Running means the child finished configuration. Restarting means a replacement delay is pending
 *
 * @category Sharding and supervision
 */
export type SupervisorChildState = "idle" | "starting" | "running" | "restarting" | "stopping" | "closed" | "failed"

/**
 * Frozen snapshot of one child assignment and its current process, without launch settings or child output
 *
 * @category Sharding and supervision
 */
export interface SupervisorChildStatus {
    /** Stable child identifier from the original assignment */
    readonly id: string
    /** Immutable assignment retained by this supervisor */
    readonly assignment: SupervisorAssignment
    /** Fork attempts for this assignment, starting at zero before startup and incrementing even if a fork fails */
    readonly generation: number
    /** Current owned child process ID, or null before a process starts or after verified exit */
    readonly pid: number | null
    /** Replacement attempts used from this child's current budget, including a replacement waiting for its delay.
     * A restart that follows a healthy run of healthyResetMs counts from one again
     */
    readonly restarts: number
    /** Current local lifecycle state */
    readonly state: SupervisorChildState
    /** Last aggregate gateway connection state reported by the current child process after configuration.
     * Null before its first accepted report, after exit or when IPC is unavailable. Reports from different children are not simultaneous
     */
    readonly connectionState: ConnectionState | null
    /** Latest client diagnostics the current child process sent, or null before its first snapshot, after exit or when IPC is
     * unavailable. A running child sends one when it finishes configuration and then every diagnosticsIntervalMs
     */
    readonly diagnostics: SupervisorChildDiagnostics | null
}

/**
 * One diagnostics snapshot a child sent to its parent: Gateway latency and shard states, REST queue use, cache use and
 * running counters, as its client's diagnostics method returns them
 *
 * @category Sharding and supervision
 */
export interface SupervisorChildDiagnostics {
    /** Parent wall-clock time the snapshot arrived, in Unix epoch milliseconds. An old value means the child stopped reporting */
    readonly receivedAt: number
    /** The child client's diagnostics at the time it sent them. See ClientDiagnostics */
    readonly client: ClientDiagnostics
}

/**
 * Immutable safe local snapshot without child paths, arguments, environment or stdio
 *
 * @category Sharding and supervision
 */
export interface SupervisorStatus {
    /** Current supervisor lifecycle state */
    readonly state: SupervisorState
    /** One snapshot per child assignment, in assignment order, including children with no current process.
     * Empty with totalShards "auto" until start has counted the plan
     */
    readonly children: readonly SupervisorChildStatus[]
}

/**
 * Parent-process lifecycle failure, not the child's original client or configuration error.
 * The message and details exclude child output, environment, arguments and operating-system error text.
 * A spawn failure keeps the original operating-system error as cause, which can name the entry path.
 * A failing start or waitForClose settles only after owned child processes exit
 *
 * @category Errors
 */
export class SupervisorError extends FluxerlyError {
    /** Discriminator for this SDK failure */
    readonly _tag = "SupervisorError"

    /** Construct a lifecycle failure from a safe child identifier and category */
    constructor(
        /** Child whose local lifecycle failed, when one is applicable */
        readonly childId: string | null,
        /** The reason `closed` means the lifetime ended or coordination was lost. The reason `spawn` means a launch or IPC-send failure.
         * The reason `protocol` means invalid coordination data. The reason `restartLimit` means the child exhausted its replacement budget.
         * The reason `startupTimeout` means a child did not acknowledge assignment and configuration within its startup budget.
         * The reason `shardCount` means the community count for totalShards "auto" failed, with that failure as the cause
         */
        readonly reason: "closed" | "spawn" | "protocol" | "restartLimit" | "startupTimeout" | "shardCount",
        /** Optional underlying failure retained as the error's cause */
        options?: { readonly cause?: unknown },
    ) {
        const child = childId === null ? "A supervisor child" : `Supervisor child ${JSON.stringify(childId)}`
        super(
            childId === null && reason === "closed"
                ? "The supervisor is closed"
                : reason === "shardCount"
                  ? `The supervisor ${supervisorFailures.shardCount.text}`
                  : `${child} ${supervisorFailures[reason].text}`,
            {
                code: `supervisor.${reason}`,
                hint:
                    childId === null && reason === "closed"
                        ? "Create a new supervisor to start again"
                        : supervisorFailures[reason].hint,
                cause: options?.cause,
                details: operationDetails({ childId, reason }),
            },
        )
        this.name = this._tag
    }
}

/** Readable text and next step for each SupervisorError reason about one child */
const supervisorFailures: Record<SupervisorError["reason"], { readonly text: string; readonly hint: string }> = {
    closed: {
        text: "stopped or lost contact with the supervisor",
        hint: "Check the child's own output and log records for the reason. Omit the restart option, or set it to an object, to restart stopped children",
    },
    spawn: {
        text: "could not be started, or the supervisor could not send it a message",
        hint: "Check that entry points to a file Node can run. The cause holds the operating-system error",
    },
    protocol: {
        text: "sent invalid coordination messages to the supervisor",
        hint: "Use the same Fluxerly version in the parent and the child entry, and do not send other messages with process.send from the child",
    },
    restartLimit: {
        text: "kept stopping and used all its restarts",
        hint: "Check the child's output for the reason it stops, or raise restart.maxAttempts",
    },
    startupTimeout: {
        text: "did not become ready before the supervisor option startupTimeoutMs ran out",
        hint: "Check the child's output for errors, or raise the supervisor option startupTimeoutMs",
    },
    shardCount: {
        text: "could not count the bot's communities to size its shard plan",
        hint: 'Read the cause. Check that the supervisor option token is the bot token, or set totalShards to a number instead of "auto"',
    },
}

/**
 * Child-helper failure because the parent's message channel is unavailable or carries invalid coordination data
 *
 * @category Errors
 */
export class SupervisorChildError extends FluxerlyError {
    /** Discriminator for this SDK failure */
    readonly _tag = "SupervisorChildError"

    /** Construct a child coordination failure without retaining message contents */
    constructor(
        /** Whether the parent disconnected or sent malformed internal coordination data */
        readonly reason: "disconnected" | "protocol",
        /** Optional underlying failure retained as the error's cause */
        options?: { readonly cause?: unknown },
    ) {
        super(
            reason === "disconnected"
                ? "This process has no connection to a supervisor parent process"
                : "This process received invalid coordination messages from its supervisor parent process",
            {
                code: `supervisor.child.${reason}`,
                hint:
                    reason === "disconnected"
                        ? "Start this entry through a supervisor, not directly with node, and keep the parent running"
                        : "Use the same Fluxerly version in the supervisor parent and its child entry",
                cause: options?.cause,
                details: operationDetails({ reason }),
            },
        )
        this.name = this._tag
    }
}
