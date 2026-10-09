/**
 * Local supervisor: Forked child clients with fixed or computed assignments, Identify coordination, restarts, child
 * diagnostics and output forwarding.
 * Invariant: Assignments are fixed once known: At creation, or at start after one community count for totalShards "auto".
 * An automatic plan changes only when a child reports a 4011 (sharding required) closure: Every child stops, the
 * communities are counted again and a larger plan starts, at most three times an hour.
 * Only an application-supplied identify coordinator reaches beyond the children it forked. The children share Fluxer's
 * account-wide limits through the parent: It relays a global rate-limit pause one child learns to the others, and keeps
 * the one member request window, counting a granted request from its grant and again once it reached the socket. An
 * unanswered child uses its own window. Per-route REST buckets stay per process, and session retention belongs to each
 * child's own SessionStore. It terminates only an
 * unresponsive child after the graceful deadline and awaits that child's exit, passes its resolved format to children
 * through FLUXERLY_LOG_FORMAT and FLUXERLY_LOG_COLOR, and keeps forwarded JSON output valid JSON Lines. Implements [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
import { fork, type ChildProcess } from "node:child_process"
import { isAbsolute } from "node:path"
import type { Readable, Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import { ConfigurationError, ConnectionError } from "#sdk/errors"
import { loggingConfiguration, type ClientLogger } from "#sdk/internal/logging"
import { maskText } from "#sdk/internal/masking"
import { makeClient, type AccountLimits, type IdentifyGate } from "#sdk/internal/client"
import { memberRequestLimit, memberRequestWindowMs, type MemberRequestSlot } from "#sdk/internal/member-chunks"
import { validateConfiguration } from "#sdk/internal/configuration"
import {
    admitReshard,
    automaticShardPlan,
    guildsPerShard,
    largerShardPlan,
    maximumShardCount,
} from "#sdk/internal/sharding"
import { CloseCode } from "#sdk/internal/protocol/gateway"
import {
    SupervisorChildError,
    SupervisorError,
    type SupervisorAssignment,
    type SupervisorChildDiagnostics,
    type SupervisorChildState,
    type SupervisorOptions,
    type SupervisorState,
    type SupervisorStatus,
} from "#sdk/supervisor"
import type { ClientDiagnostics, ConnectionState } from "#sdk/client"
import { record, safeInteger, snapshotArray } from "#sdk/internal/decode/primitives"
import { callerFields, readCaller, suspendMarked } from "#sdk/internal/defects"
import { unsupportedKeyHint } from "#sdk/internal/suggest"
import type { LogCode } from "#sdk/internal/code-catalogue"

const maximumTimerMs = 2_147_483_647
const maximumAttempts = 100
const maximumChildEnvironmentEntries = 64
const maximumArgumentEntries = 64
const maximumArgumentLength = 4_096
const maximumChildIdLength = 128
const defaultStartupTimeoutMs = 30_000
const defaultShutdownTimeoutMs = 5_000
const grantAcknowledgementMs = 5_000
/** Longest wait for the parent's answer to a member request slot, after which the child uses its own window */
const memberAnswerMs = 1_000
const defaultDiagnosticsIntervalMs = 5_000
/** Part of shutdownTimeoutMs a stopping child keeps for closing its connections after draining running work */
const childCloseReserveMs = 1_000
/** Longest wait after a child exits for its forwarded output streams to close */
const outputDrainGraceMs = 1_000

interface RestartConfiguration {
    readonly maxAttempts: number
    readonly minDelayMs: number
    readonly maxDelayMs: number
    /** Running time after readiness that restores a child's full restart budget at its next exit */
    readonly healthyResetMs: number
}

/** The documented restart defaults, used when the restart option is omitted */
const defaultRestart: RestartConfiguration = Object.freeze({
    maxAttempts: 3,
    minDelayMs: 1_000,
    maxDelayMs: 30_000,
    healthyResetMs: 60_000,
})

/** How processes or shardsPerProcess divide every shard among the children */
type ProcessSplit = { readonly processes: number } | { readonly shardsPerProcess: number }

/** Settings for sizing the plan at start from the bot's community count */
interface AutomaticPlan {
    readonly split: ProcessSplit
    /** Validated client options for the transient client that counts the communities */
    readonly clientOptions: Readonly<Record<string, unknown>>
}

/** Bound permit function of an application identify coordinator */
type CoordinatorPermit = (shardId: number, totalShards: number, signal: AbortSignal) => unknown

interface SupervisorConfiguration {
    readonly entry: string
    /** Known assignments, empty until start has counted an automatic plan */
    readonly children: readonly ChildConfiguration[]
    readonly automatic: AutomaticPlan | undefined
    readonly restart: RestartConfiguration | undefined
    readonly minimumSpacingMs: number
    readonly coordinator: CoordinatorPermit | undefined
    readonly diagnosticsIntervalMs: number
    readonly startupTimeoutMs: number
    readonly shutdownTimeoutMs: number
    readonly environment: readonly (readonly [string, string])[]
    readonly args: readonly string[]
    readonly execArgv: readonly string[]
    /** How child standard output and error reach the parent */
    readonly childOutput: "prefix" | "inherit" | "ignore"
    /** Supervisor records for spawn, exit, crash and restart */
    readonly logger: ClientLogger
}

interface ChildConfiguration {
    readonly id: string
    readonly assignment: SupervisorAssignment
}

interface ChildSlot {
    readonly configuration: ChildConfiguration
    generation: number
    restarts: number
    child: ChildProcess | undefined
    hello: boolean
    ready: boolean
    /** Host time at which the current process finished configuration */
    readyAt: number | undefined
    connectionState: ConnectionState | null
    /** Latest diagnostics snapshot from the current process */
    diagnostics: SupervisorChildDiagnostics | null
    state: SupervisorChildState
    restartTimer: ReturnType<typeof setTimeout> | undefined
    startupTimer: ReturnType<typeof setTimeout> | undefined
    stopTimer: ReturnType<typeof setTimeout> | undefined
    disconnectTimer: ReturnType<typeof setTimeout> | undefined
}

const connectionStates = ["Disconnected", "Connecting", "Connected", "Recovering", "Closing", "Closed"] as const

function connectionState(value: unknown): value is ConnectionState {
    return typeof value === "string" && connectionStates.includes(value as ConnectionState)
}

/** Top-level fields of a ClientDiagnostics snapshot, which a diagnostics message must carry exactly */
const diagnosticsKeys: readonly (keyof ClientDiagnostics)[] = [
    "state",
    "gatewayLatencyMs",
    "shards",
    "rest",
    "uploads",
    "gatewayRequests",
    "events",
    "caches",
    "counters",
]

/** Freeze a snapshot received over IPC, which Node has already copied, so status readers cannot change it */
function deepFreeze<T>(value: T): T {
    if (typeof value === "object" && value !== null) {
        for (const entry of Object.values(value)) deepFreeze(entry)
        Object.freeze(value)
    }
    return value
}

interface IdentifyRequest {
    readonly slot: ChildSlot
    readonly generation: number
    readonly requestId: number
    readonly shardId: number
}

/** A member request counted against Fluxer's account limit, from its grant or from when it reached a socket */
interface CountedMemberRequest {
    readonly at: number
    /** The child request holding a granted slot that it has not reported as sent or withdrawn */
    readonly holder?: { readonly slot: ChildSlot; readonly generation: number; readonly requestId: number }
}

interface OutstandingIdentify extends IdentifyRequest {
    /** Acknowledgement deadline, set once the grant is sent */
    timer: ReturnType<typeof setTimeout> | undefined
    /** Aborts the identify coordinator's permit while the parent still waits for it */
    permit: AbortController | undefined
    stalled: boolean
}

/**
 * Split every shard of a plan into contiguous blocks, one per child, named process-0, process-1 and so on.
 * Processes get sizes that differ by at most one, and shardsPerProcess leaves the remainder to the last child
 */
function splitShards(totalShards: number, split: ProcessSplit): readonly ChildConfiguration[] {
    const count =
        "processes" in split ? Math.min(split.processes, totalShards) : Math.ceil(totalShards / split.shardsPerProcess)
    const children: ChildConfiguration[] = []
    let next = 0
    for (let index = 0; index < count; index += 1) {
        const size =
            "processes" in split
                ? Math.floor(totalShards / count) + (index < totalShards % count ? 1 : 0)
                : Math.min(split.shardsPerProcess, totalShards - next)
        const shardIds = Array.from({ length: size }, (_, offset) => next + offset)
        next += size
        children.push(
            Object.freeze({
                id: `process-${index}`,
                assignment: Object.freeze({ totalShards, shardIds: Object.freeze(shardIds) }),
            }),
        )
    }
    return Object.freeze(children)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    return Object.keys(value).every((key) => keys.includes(key))
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    return hasOnlyKeys(value, keys) && keys.every((key) => key in value)
}

function positiveTimer(value: unknown): value is number {
    return safeInteger(value) && value > 0 && value <= maximumTimerMs
}

function childEntry(value: unknown): string | undefined {
    if (typeof value === "string") return isAbsolute(value) ? value : undefined
    // Read the URL fields outside the parse guard, so a throwing getter stays an application fault
    if (!record(value) || value.protocol !== "file:") return undefined
    const href = value.href
    if (typeof href !== "string") return undefined
    try {
        const path = fileURLToPath(href)
        return isAbsolute(path) ? path : undefined
    } catch {
        // allow-silent: An unusable entry becomes the typed ConfigurationError returned by the caller
        return undefined
    }
}

function filteredExecArguments(values: readonly string[]): string[] {
    const result: string[] = []
    for (let index = 0; index < values.length; index += 1) {
        const argument = values[index]!
        // Child processes resolve the shipped output, so neither Node spelling may retain the source-test condition
        if ((argument === "--conditions" || argument === "-C") && values[index + 1] === "fluxerly-source") {
            index += 1
            continue
        }
        if (argument === "--conditions=fluxerly-source") continue
        result.push(argument)
    }
    return result
}

/** Copy a caller string array once, then validate the copy. A sparse entry copies as undefined and fails */
function stringArray(value: unknown, field: string): readonly string[] | ConfigurationError {
    const copied = snapshotArray(value, maximumArgumentEntries)
    if (copied === undefined)
        return new ConfigurationError(
            field as never,
            `The supervisor option ${JSON.stringify(field)} must be an array of at most ${maximumArgumentEntries} strings`,
        )
    if (copied.some((entry) => typeof entry !== "string" || entry.length > maximumArgumentLength))
        return new ConfigurationError(
            field as never,
            `The supervisor option ${JSON.stringify(field)} must contain only strings of at most ${maximumArgumentLength.toLocaleString("en-US")} characters, with no empty slots`,
        )
    return copied as readonly string[]
}

/** Copy caller shard IDs once, then validate the copy, so the validated IDs are the ones assigned */
function assignment(value: unknown, totalShards: number): readonly number[] | undefined {
    const copied = snapshotArray(value, totalShards)
    if (copied === undefined || copied.length === 0) return undefined
    const seen = new Set<number>()
    for (const shardId of copied) {
        if (!safeInteger(shardId) || shardId < 0 || shardId >= totalShards || seen.has(shardId)) return undefined
        seen.add(shardId)
    }
    return copied as readonly number[]
}

function childEnvironment(value: unknown): readonly (readonly [string, string])[] | ConfigurationError {
    if (value === undefined) return Object.freeze([])
    if (!record(value) || Object.getOwnPropertySymbols(value).length > 0)
        return new ConfigurationError(
            "childEnvironment",
            'The supervisor option "childEnvironment" must be an object of environment variable names and string values',
        )
    const entries = Object.entries(value)
    if (entries.length > maximumChildEnvironmentEntries)
        return new ConfigurationError(
            "childEnvironment",
            `The supervisor option "childEnvironment" can have at most ${maximumChildEnvironmentEntries} entries`,
        )
    const copied: (readonly [string, string])[] = []
    for (const [key, current] of entries) {
        if (
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
            typeof current !== "string" ||
            current.length > maximumArgumentLength
        )
            return new ConfigurationError(
                "childEnvironment",
                `The supervisor option "childEnvironment" must use names of letters, digits and underscores that do not start with a digit, and string values of at most ${maximumArgumentLength.toLocaleString("en-US")} characters`,
            )
        copied.push(Object.freeze([key, current]))
    }
    return Object.freeze(copied)
}

/**
 * Validate and snapshot supervisor configuration without creating a child process. Each caller field is read once, and
 * only the reads of the options are marked as application input, so a fault in the surrounding validation or logger
 * creation stays an SDK fault
 */
function validateSupervisorConfiguration(
    options: unknown,
    native = false,
): Effect.Effect<SupervisorConfiguration, ConfigurationError> {
    return suspendMarked(() => supervisorSettings(options, native))
}

const supervisorOptionKeys: readonly string[] = [
    "entry",
    "totalShards",
    "assignments",
    "processes",
    "shardsPerProcess",
    "token",
    "instance",
    "transport",
    "restart",
    "identify",
    "diagnosticsIntervalMs",
    "startupTimeoutMs",
    "shutdownTimeoutMs",
    "childEnvironment",
    "args",
    "execArgv",
    "childOutput",
    "logging",
]

/** Reject malformed supervisor option objects and suggest supported names before their values are read */
export function supervisorOptionError(
    options: unknown,
    supported: readonly string[],
    field: ConfigurationError["field"],
    label: string,
): ConfigurationError | undefined {
    if (!record(options)) return new ConfigurationError(field, `${label} must be an object`)
    const unsupported = Object.keys(options).find((key) => !supported.includes(key))
    return unsupported === undefined
        ? undefined
        : new ConfigurationError(
              field,
              `Unsupported option ${JSON.stringify(unsupported)} in the ${label.charAt(0).toLowerCase()}${label.slice(1)}`,
              {
                  hint: unsupportedKeyHint(unsupported, supported),
              },
          )
}

function supervisorSettings(
    options: unknown,
    native: boolean,
): Effect.Effect<SupervisorConfiguration, ConfigurationError> {
    {
        if (!record(options))
            return Effect.fail(new ConfigurationError("supervisor", "Supervisor settings must be an object"))
        const unsupported = readCaller(() => Object.keys(options)).find((key) => !supervisorOptionKeys.includes(key))
        if (unsupported !== undefined)
            return Effect.fail(
                new ConfigurationError("supervisor", `Unsupported supervisor option ${JSON.stringify(unsupported)}`, {
                    hint: unsupportedKeyHint(unsupported, supervisorOptionKeys),
                }),
            )
        const field = callerFields(options)
        const entry = readCaller(() => childEntry(field("entry")))
        if (!entry)
            return Effect.fail(
                new ConfigurationError("entry", 'The supervisor option "entry" must be an absolute path or a file URL'),
            )
        const totalShards = field("totalShards")
        if (totalShards !== "auto" && (!safeInteger(totalShards) || totalShards < 1 || totalShards > maximumShardCount))
            return Effect.fail(
                new ConfigurationError(
                    "totalShards",
                    'The supervisor option "totalShards" must be an integer from 1 through 16,384, or "auto"',
                ),
            )
        const split = processSplit(field("assignments"), field("processes"), field("shardsPerProcess"), totalShards)
        if (split instanceof ConfigurationError) return Effect.fail(split)
        const counting = ["token", "instance", "transport"].map((key) => [key, field(key)] as const)
        const automatic =
            totalShards === "auto"
                ? countingOptions(counting, field("logging"), split as ProcessSplit, native)
                : undefined
        if (automatic instanceof ConfigurationError) return Effect.fail(automatic)
        if (totalShards !== "auto") {
            const supplied = counting.find(([, value]) => value !== undefined)
            if (supplied)
                return Effect.fail(
                    new ConfigurationError(
                        supplied[0] as "token" | "instance" | "transport",
                        `The supervisor option ${JSON.stringify(supplied[0])} is used only to count the bot's communities when totalShards is "auto"`,
                        { hint: 'Remove it, or set totalShards to "auto" to size the plan at start' },
                    ),
                )
        }
        const children =
            totalShards === "auto"
                ? Object.freeze([])
                : split === undefined
                  ? readCaller(() => fixedAssignments(field("assignments"), totalShards))
                  : splitShards(totalShards, split)
        if (children instanceof ConfigurationError) return Effect.fail(children)
        const restart = field("restart")
        let restartConfiguration: RestartConfiguration | undefined = defaultRestart
        if (restart === false) restartConfiguration = undefined
        else if (restart !== undefined) {
            const configured = readCaller(() => restartSettings(restart))
            if (configured instanceof ConfigurationError) return Effect.fail(configured)
            restartConfiguration = configured
        }
        const identify = readCaller(() => identifySettings(field("identify")))
        if (identify instanceof ConfigurationError) return Effect.fail(identify)
        const diagnosticsInput = field("diagnosticsIntervalMs")
        const diagnosticsIntervalMs = diagnosticsInput === undefined ? defaultDiagnosticsIntervalMs : diagnosticsInput
        if (!positiveTimer(diagnosticsIntervalMs) || diagnosticsIntervalMs < 1_000)
            return Effect.fail(
                new ConfigurationError(
                    "diagnosticsIntervalMs",
                    'The supervisor option "diagnosticsIntervalMs" must be an integer from 1,000 through 2,147,483,647 milliseconds',
                ),
            )
        const startupInput = field("startupTimeoutMs")
        const startupTimeoutMs = startupInput === undefined ? defaultStartupTimeoutMs : startupInput
        if (!positiveTimer(startupTimeoutMs))
            return Effect.fail(
                new ConfigurationError(
                    "startupTimeoutMs",
                    'The supervisor option "startupTimeoutMs" must be an integer from 1 through 2,147,483,647 milliseconds',
                ),
            )
        const shutdownInput = field("shutdownTimeoutMs")
        const shutdownTimeoutMs = shutdownInput === undefined ? defaultShutdownTimeoutMs : shutdownInput
        if (!positiveTimer(shutdownTimeoutMs))
            return Effect.fail(
                new ConfigurationError(
                    "shutdownTimeoutMs",
                    'The supervisor option "shutdownTimeoutMs" must be an integer from 1 through 2,147,483,647 milliseconds',
                ),
            )
        const childEnvironmentOverrides = readCaller(() => childEnvironment(field("childEnvironment")))
        if (childEnvironmentOverrides instanceof ConfigurationError) return Effect.fail(childEnvironmentOverrides)
        const environment = new Map<string, string>()
        for (const [key, value] of Object.entries(process.env)) {
            if (typeof value === "string") environment.set(key, value)
        }
        for (const [key, value] of childEnvironmentOverrides) environment.set(key, value)
        const argsInput = field("args")
        const args = argsInput === undefined ? Object.freeze([]) : readCaller(() => stringArray(argsInput, "args"))
        if (args instanceof ConfigurationError) return Effect.fail(args)
        const execArgvOption = field("execArgv")
        const execArgv = readCaller(() =>
            stringArray(execArgvOption === undefined ? process.execArgv : execArgvOption, "execArgv"),
        )
        if (execArgv instanceof ConfigurationError) return Effect.fail(execArgv)
        const childOutputInput = field("childOutput")
        const childOutput = childOutputInput === undefined ? "prefix" : childOutputInput
        if (childOutput !== "prefix" && childOutput !== "inherit" && childOutput !== "ignore")
            return Effect.fail(
                new ConfigurationError(
                    "childOutput",
                    'The supervisor option "childOutput" must be "prefix", "inherit" or "ignore"',
                ),
            )
        const logger = loggingConfiguration(field("logging"), native)
        if (logger instanceof ConfigurationError) return Effect.fail(logger)
        return Effect.succeed(
            Object.freeze({
                entry,
                children,
                automatic,
                restart: restartConfiguration,
                minimumSpacingMs: identify.minimumSpacingMs,
                coordinator: identify.coordinator,
                diagnosticsIntervalMs,
                startupTimeoutMs,
                shutdownTimeoutMs,
                environment: Object.freeze([...environment].map((entry) => Object.freeze(entry))),
                args,
                execArgv: Object.freeze(filteredExecArguments(execArgv)),
                childOutput,
                logger,
            }),
        )
    }
}

/**
 * Choose how children are formed: undefined for explicit assignments, otherwise the processes or shardsPerProcess
 * split. Exactly one of the three must be present, and an automatic total needs a split
 */
function processSplit(
    assignments: unknown,
    processes: unknown,
    shardsPerProcess: unknown,
    totalShards: number | "auto",
): ProcessSplit | undefined | ConfigurationError {
    const chosen = [assignments, processes, shardsPerProcess].filter((value) => value !== undefined).length
    if (chosen !== 1)
        return new ConfigurationError(
            chosen === 0 ? "assignments" : "supervisor",
            chosen === 0
                ? 'The supervisor needs one of the options "assignments", "processes" or "shardsPerProcess"'
                : 'The supervisor options "assignments", "processes" and "shardsPerProcess" cannot be combined',
            {
                hint: "Use processes to split every shard evenly across that many children, or assignments to choose each child's shards",
            },
        )
    if (assignments !== undefined) {
        if (totalShards === "auto")
            return new ConfigurationError(
                "assignments",
                'The supervisor option "assignments" needs a numeric totalShards, because fixed shard IDs depend on the total',
                { hint: 'Use processes or shardsPerProcess with totalShards "auto"' },
            )
        return undefined
    }
    const name = processes !== undefined ? "processes" : "shardsPerProcess"
    const value = processes ?? shardsPerProcess
    if (!safeInteger(value) || value < 1 || value > maximumShardCount)
        return new ConfigurationError(name, `The supervisor option "${name}" must be an integer from 1 through 16,384`)
    if (name === "processes" && totalShards !== "auto" && value > totalShards)
        return new ConfigurationError(
            "processes",
            'The supervisor option "processes" can be at most totalShards, because each child needs at least one shard',
        )
    return name === "processes" ? { processes: value } : { shardsPerProcess: value }
}

/** Validate the settings of the transient client that counts communities for totalShards "auto" */
function countingOptions(
    counting: readonly (readonly [string, unknown])[],
    logging: unknown,
    split: ProcessSplit,
    native: boolean,
): AutomaticPlan | ConfigurationError {
    const clientOptions: Record<string, unknown> = {}
    for (const [key, value] of counting) if (value !== undefined) clientOptions[key] = value
    if (logging !== undefined) clientOptions.logging = logging
    if (clientOptions.token === undefined)
        return new ConfigurationError("token", 'The supervisor option "token" is required when totalShards is "auto"', {
            hint: "Pass the bot token, such as process.env.FLUXER_BOT_TOKEN, so the supervisor can count the bot's communities",
        })
    const validated = Effect.runSyncExit(validateConfiguration(clientOptions, native))
    if (Exit.isFailure(validated)) {
        const failure = validated.cause.reasons.find((reason) => reason._tag === "Fail")
        if (failure?._tag === "Fail") return failure.error
        throw Cause.squash(validated.cause)
    }
    return Object.freeze({ split, clientOptions: Object.freeze(clientOptions) })
}

/** Copy and validate explicit assignments for a numeric total */
function fixedAssignments(value: unknown, totalShards: number): readonly ChildConfiguration[] | ConfigurationError {
    const assignments = snapshotArray(value, totalShards)
    if (assignments === undefined || assignments.length === 0)
        return new ConfigurationError(
            "assignments",
            `The supervisor option "assignments" must be a non-empty array with at most ${totalShards} entries, one per child`,
        )
    const seenIds = new Set<string>()
    const seenShards = new Set<number>()
    const children: ChildConfiguration[] = []
    for (const current of assignments) {
        if (!record(current))
            return new ConfigurationError(
                "assignments",
                "Each supervisor assignment must be an object with id and shardIds",
            )
        const invalidKeys = supervisorOptionError(
            current,
            ["id", "shardIds"],
            "assignments",
            "Supervisor assignment options",
        )
        if (invalidKeys) return invalidKeys
        if (!hasExactKeys(current, ["id", "shardIds"]))
            return new ConfigurationError(
                "assignments",
                "Each supervisor assignment must contain exactly id and shardIds",
            )
        const id = current.id
        if (typeof id === "string" && seenIds.has(id))
            return new ConfigurationError(
                "childId",
                `Supervisor assignment ID ${JSON.stringify(id)} is used more than once`,
            )
        if (typeof id !== "string" || id.trim().length === 0 || id.length > maximumChildIdLength)
            return new ConfigurationError(
                "childId",
                `Supervisor assignment IDs must be non-blank strings of at most ${maximumChildIdLength} characters`,
            )
        const shardIds = assignment(current.shardIds, totalShards)
        if (!shardIds)
            return new ConfigurationError(
                "shardIds",
                `The shardIds of supervisor assignment ${JSON.stringify(id)} must be a non-empty array of unique integers from 0 through ${totalShards - 1}`,
            )
        for (const shardId of shardIds) {
            if (seenShards.has(shardId))
                return new ConfigurationError(
                    "shardIds",
                    `Shard ${shardId} is assigned to more than one supervisor child`,
                )
            seenShards.add(shardId)
        }
        seenIds.add(id)
        children.push(
            Object.freeze({ id, assignment: Object.freeze({ totalShards, shardIds: Object.freeze([...shardIds]) }) }),
        )
    }
    return Object.freeze(children)
}

/** Validate a supplied restart object, filling each omitted setting with its default */
function restartSettings(restart: unknown): RestartConfiguration | ConfigurationError {
    if (!record(restart))
        return new ConfigurationError("restart", 'The supervisor option "restart" must be an object or false')
    const restartKeys = ["maxAttempts", "minDelayMs", "maxDelayMs", "healthyResetMs"]
    const unsupportedRestart = Object.keys(restart).find((key) => !restartKeys.includes(key))
    if (unsupportedRestart !== undefined)
        return new ConfigurationError("restart", `Unsupported restart setting ${JSON.stringify(unsupportedRestart)}`, {
            hint: unsupportedKeyHint(unsupportedRestart, restartKeys, "settings"),
        })
    const restartField = callerFields(restart)
    const orDefault = (key: keyof RestartConfiguration) => {
        const value = restartField(key)
        return value === undefined ? defaultRestart[key] : value
    }
    const maxAttempts = orDefault("maxAttempts")
    const minDelayMs = orDefault("minDelayMs")
    const maxDelayMs = orDefault("maxDelayMs")
    const healthyResetMs = orDefault("healthyResetMs")
    if (!safeInteger(maxAttempts) || maxAttempts < 0 || maxAttempts > maximumAttempts)
        return new ConfigurationError(
            "maxAttempts",
            `The supervisor option "restart.maxAttempts" must be an integer from 0 through ${maximumAttempts}`,
        )
    if (!positiveTimer(minDelayMs) || !positiveTimer(maxDelayMs) || minDelayMs > maxDelayMs)
        return new ConfigurationError(
            "restart",
            'The supervisor options "restart.minDelayMs" and "restart.maxDelayMs" must be integers from 1 through 2,147,483,647 milliseconds, with minDelayMs no larger than maxDelayMs',
        )
    if (!positiveTimer(healthyResetMs))
        return new ConfigurationError(
            "healthyResetMs",
            'The supervisor option "restart.healthyResetMs" must be an integer from 1 through 2,147,483,647 milliseconds',
        )
    return Object.freeze({ maxAttempts, minDelayMs, maxDelayMs, healthyResetMs })
}

/** Validate Identify pacing: Parent spacing, or an application coordinator that replaces it */
function identifySettings(
    identify: unknown,
): { readonly minimumSpacingMs: number; readonly coordinator: CoordinatorPermit | undefined } | ConfigurationError {
    if (identify !== undefined && !record(identify))
        return new ConfigurationError("identify", "Supervisor Identify options must be an object")
    if (identify !== undefined) {
        const invalidKeys = supervisorOptionError(
            identify,
            ["minimumSpacingMs", "coordinator"],
            "identify",
            "Supervisor Identify options",
        )
        if (invalidKeys) return invalidKeys
    }
    const spacing = identify?.minimumSpacingMs
    const coordinator = identify?.coordinator
    if (coordinator !== undefined) {
        if (spacing !== undefined)
            return new ConfigurationError(
                "identify",
                'The supervisor options "identify.minimumSpacingMs" and "identify.coordinator" cannot be combined, because the coordinator owns Identify pacing',
                { hint: "Space the permits inside the coordinator instead" },
            )
        const permit = record(coordinator) ? coordinator.permit : undefined
        if (typeof permit !== "function")
            return new ConfigurationError(
                "identify",
                'The supervisor option "identify.coordinator" must be an object with a permit function',
            )
        return { minimumSpacingMs: 0, coordinator: permit.bind(coordinator) as CoordinatorPermit }
    }
    const minimumSpacingMs = spacing === undefined ? 1_000 : spacing
    if (!positiveTimer(minimumSpacingMs) || minimumSpacingMs < 1_000)
        return new ConfigurationError(
            "minimumSpacingMs",
            'The supervisor option "identify.minimumSpacingMs" must be an integer from 1,000 through 2,147,483,647 milliseconds',
        )
    return { minimumSpacingMs, coordinator: undefined }
}

/** Label for one child's forwarded output lines, naming its shard when it owns exactly one */
function outputLabel(configuration: ChildConfiguration) {
    const shards = configuration.assignment.shardIds
    return shards.length === 1 ? `[shard ${shards[0]}]` : `[child ${configuration.id}]`
}

/** Longest forwarded line in characters. Longer lines are cut with a marker so one child cannot grow parent memory */
export const maximumForwardedLineLength = 262_144
const truncationMarker = " … [line truncated by the supervisor]"

/** One child line in the parent's JSON Lines output. An SDK record gains a fields.child entry, another JSON object
 * passes through unchanged, and any other text becomes a supervisor.childOutput record, so the output stays valid
 */
function jsonOutputLine(line: string, configuration: ChildConfiguration, stream: "stdout" | "stderr"): string {
    try {
        const value = JSON.parse(line) as unknown
        if (record(value)) {
            if (typeof value.level !== "string" || typeof value.code !== "string" || typeof value.category !== "string")
                return line
            const fields = record(value.fields) ? value.fields : {}
            return JSON.stringify({ ...value, fields: { ...fields, child: configuration.id } })
        }
    } catch {
        // allow-silent: A line that is not JSON is wrapped as a supervisor.childOutput record below
    }
    return JSON.stringify({
        time: new Date().toISOString(),
        level: stream === "stderr" ? "warn" : "info",
        category: "supervisor",
        code: "supervisor.childOutput",
        message: maskText(line),
        fields: { child: configuration.id, shards: configuration.assignment.shardIds.join(","), stream },
    })
}

/**
 * Forward each line from a child stream in the parent's format for that stream: Labelled text for pretty output,
 * or JSON Lines for json output. Lines longer than maximumForwardedLineLength are truncated with a marker, the child
 * stream pauses while the parent stream applies backpressure, and a partial final line is forwarded at the end.
 * The done callback runs once the child stream has ended or closed
 */
function forwardLines(
    stream: Readable | null,
    target: Writable,
    name: "stdout" | "stderr",
    configuration: ChildConfiguration,
    logger: ClientLogger,
    done: () => void,
) {
    if (!stream) return done()
    const label = outputLabel(configuration)
    const json = logger.consoleFormat(name).format === "json"
    let pending = ""
    let skipping = false
    let finished = false
    const emit = (line: string) => {
        const text = json ? jsonOutputLine(line, configuration, name) : `${label} ${line}`
        if (!target.write(`${text}\n`) && !stream.isPaused()) {
            stream.pause()
            target.once("drain", () => stream.resume())
        }
    }
    stream.setEncoding("utf8")
    stream.on("data", (chunk: string) => {
        let start = 0
        while (start < chunk.length) {
            const end = chunk.indexOf("\n", start)
            const piece = chunk.slice(start, end === -1 ? chunk.length : end)
            start = end === -1 ? chunk.length : end + 1
            if (!skipping) {
                pending += piece
                if (pending.length > maximumForwardedLineLength) {
                    emit(`${pending.slice(0, maximumForwardedLineLength)}${truncationMarker}`)
                    pending = ""
                    skipping = true
                }
            }
            if (end !== -1) {
                if (!skipping) emit(pending.endsWith("\r") ? pending.slice(0, -1) : pending)
                pending = ""
                skipping = false
            }
        }
    })
    const finish = () => {
        if (finished) return
        finished = true
        if (pending !== "" && !skipping) emit(pending)
        pending = ""
        done()
    }
    stream.once("end", finish)
    stream.once("close", finish)
    // A read error ends forwarding of this stream while the child can keep running, so the error is recorded. The child's
    // exit is still observed and logged separately
    stream.once("error", (error) => {
        logger.log({
            level: "warn",
            category: "supervisor",
            code: "supervisor.outputFailed",
            message: `Reading the ${name === "stdout" ? "standard output" : "standard error"} of child ${configuration.id} failed, so the supervisor stops forwarding it`,
            error,
            fields: { child: configuration.id, shards: configuration.assignment.shardIds.join(","), stream: name },
        })
        finish()
    })
}

/** Owns only processes forked from one local supervisor instance */
function childSlot(configuration: ChildConfiguration): ChildSlot {
    return {
        configuration,
        generation: 0,
        restarts: 0,
        child: undefined,
        hello: false,
        ready: false,
        readyAt: undefined,
        connectionState: null,
        diagnostics: null,
        state: "idle",
        restartTimer: undefined,
        startupTimer: undefined,
        stopTimer: undefined,
        disconnectTimer: undefined,
    }
}

export class SupervisorOwner {
    /** One slot per assignment. Empty for an automatic plan until its count completes */
    #slots: ChildSlot[]
    /** The running community count for totalShards "auto" */
    #counting: Fiber.Fiber<void> | undefined
    /** Whether the count finished, which can happen before runFork returns its fiber */
    #countSettled = false
    /** Times of moves to a larger automatic plan, for the hourly limit */
    readonly #reshards: number[] = []
    /** The plan being replaced while its children stop and the communities are counted again */
    #resharding: { readonly previousTotalShards: number; readonly childId: string } | undefined
    readonly #native: boolean
    readonly #startup = Deferred.makeUnsafe<void, SupervisorError>()
    readonly #terminal = Deferred.makeUnsafe<void, SupervisorError>()
    readonly #stopped = Deferred.makeUnsafe<void>()
    #readiness = Deferred.makeUnsafe<void, SupervisorError>()
    #readyObserved = false
    #configuration: SupervisorConfiguration | undefined
    #state: SupervisorState = "idle"
    #stopping = false
    #failed = false
    #failure: SupervisorError | undefined
    #pending: IdentifyRequest[] = []
    #outstanding: OutstandingIdentify | undefined
    #lastIdentifyAt = -Infinity
    #grantTimer: ReturnType<typeof setTimeout> | undefined
    /** Host time at which the latest global rate-limit pause a child reported ends. Fluxer pauses the whole account */
    #globalPauseUntil = 0
    /**
     * Member requests of every child counted against Fluxer's account limit, oldest first. Only the latest
     * memberRequestLimit decide admission, so no more are kept
     */
    #memberRequests: CountedMemberRequest[] = []

    constructor(configuration: SupervisorConfiguration, native = false) {
        this.#configuration = configuration
        this.#native = native
        this.#slots = configuration.children.map(childSlot)
    }

    start(): Effect.Effect<void, SupervisorError> {
        const owner = this
        return Effect.uninterruptibleMask((restore) =>
            Effect.suspend(() => {
                if (owner.#state === "closed" || owner.#state === "failed" || owner.#state === "stopping")
                    return Effect.fail(new SupervisorError(null, "closed"))
                owner.#beginStart()
                return restore(Deferred.await(owner.#startup)).pipe(Effect.onInterrupt(() => owner.shutdown()))
            }),
        )
    }

    waitForClose(): Effect.Effect<void, SupervisorError> {
        return Deferred.await(this.#terminal)
    }

    waitForReady(): Effect.Effect<void, SupervisorError> {
        return Effect.suspend(() => {
            if (this.#state === "idle" || this.#state === "closed" || this.#state === "stopping")
                return Effect.fail(new SupervisorError(null, "closed"))
            if (this.#state === "failed") return Effect.fail(this.#failure ?? new SupervisorError(null, "closed"))
            if (this.#allConnected()) return Effect.void
            return Deferred.await(this.#readiness)
        })
    }

    status(): SupervisorStatus {
        return Object.freeze({
            state: this.#state,
            children: Object.freeze(
                this.#slots.map((slot) =>
                    Object.freeze({
                        id: slot.configuration.id,
                        assignment: slot.configuration.assignment,
                        generation: slot.generation,
                        pid: typeof slot.child?.pid === "number" ? slot.child.pid : null,
                        restarts: slot.restarts,
                        state: slot.state,
                        connectionState: slot.connectionState,
                        diagnostics: slot.diagnostics,
                    }),
                ),
            ),
        })
    }

    shutdown(): Effect.Effect<void> {
        return Effect.uninterruptible(
            Effect.sync(() => this.#beginShutdown()).pipe(Effect.andThen(Deferred.await(this.#stopped))),
        )
    }

    /** Whether every child reported Connected. An automatic plan that is still counting has no children yet */
    #allConnected() {
        return this.#slots.length > 0 && this.#slots.every((slot) => slot.connectionState === "Connected")
    }

    #beginStart() {
        if (this.#state !== "idle") return
        this.#state = "starting"
        const automatic = this.#configuration!.automatic
        if (automatic) return this.#startCount(automatic)
        this.#spawnAll()
    }

    /** Count the communities in the background, for the first plan or, while resharding, a larger one */
    #startCount(automatic: AutomaticPlan) {
        this.#countSettled = false
        const counting = this.#countPlan(automatic)
        const context = this.#configuration!.logger.context
        const fiber = (context ? Effect.runForkWith(context) : Effect.runFork)(counting)
        if (!this.#countSettled) this.#counting = fiber
    }

    /**
     * Answer a child's 4011 (sharding required) closure under an automatic plan: Stop every child, then count the
     * communities again and start a larger plan once all have exited. Beyond the hourly limit the supervisor fails, as a
     * client with sharding "auto" ends. A second report during the move joins it
     */
    #reshard(slot: ChildSlot) {
        if (this.#resharding !== undefined) return
        const previousTotalShards = slot.configuration.assignment.totalShards
        const refused = admitReshard(this.#reshards, performance.now(), previousTotalShards)
        if (refused !== undefined) {
            this.#log(
                "error",
                "supervisor.resharded",
                `Fluxer closed a shard of child ${slot.configuration.id} with close code 4011 (sharding required), but the supervisor cannot move to a larger plan because ${refused}, so the supervisor shuts down`,
                slot,
                { fields: { totalShards: previousTotalShards } },
            )
            this.#fail(new SupervisorError(slot.configuration.id, "closed"))
            return
        }
        this.#resharding = { previousTotalShards, childId: slot.configuration.id }
        if (this.#grantTimer) clearTimeout(this.#grantTimer)
        this.#grantTimer = undefined
        this.#pending = []
        // A granted Identify can still reach Fluxer before its child stops. It stays outstanding until the child reports
        // it sent or exits, so the larger plan's first Identify keeps the spacing after it
        if (this.#outstanding?.timer === undefined) this.#clearOutstanding()
        for (const current of this.#slots) {
            if (current.restartTimer) clearTimeout(current.restartTimer)
            current.restartTimer = undefined
            if (current.startupTimer) clearTimeout(current.startupTimer)
            current.startupTimer = undefined
            if (current.child) this.#requestStop(current)
            else current.state = "closed"
        }
        this.#continueReshard()
    }

    /** Count again once every child of the old plan has exited */
    #continueReshard() {
        if (this.#resharding === undefined || this.#counting || this.#slots.some((slot) => slot.child !== undefined))
            return
        this.#startCount(this.#configuration!.automatic!)
    }

    #spawnAll() {
        for (const slot of this.#slots) {
            this.#spawn(slot)
            if (this.#failed) break
        }
    }

    /**
     * Count the bot's communities with a transient client, then split the resulting plan into children and start them.
     * Shutdown interrupts the count, and cleanup completes only after the transient client has closed
     */
    #countPlan(automatic: AutomaticPlan): Effect.Effect<void> {
        const owner = this
        const configuration = this.#configuration!
        const count = Effect.scoped(
            Effect.gen(function* () {
                const scope = yield* Effect.scope
                const client = yield* makeClient(automatic.clientOptions, scope, owner.#native)
                yield* Effect.addFinalizer(() => client.shutdown())
                return yield* client.countGuilds(configuration.startupTimeoutMs)
            }),
        )
        // onExit also runs when shutdown interrupts the count, so shutdown can finish after the client has closed
        return count.pipe(
            Effect.onExit((exit) => Effect.sync(() => owner.#planned(exit, automatic.split))),
            // allow-silent: #planned turns a failed count into the SupervisorError that start and waitForClose return
            Effect.ignore,
        )
    }

    #planned(exit: Exit.Exit<number, unknown>, split: ProcessSplit) {
        this.#counting = undefined
        this.#countSettled = true
        if (this.#stopping || this.#failed) return this.#checkStopped()
        if (Exit.isFailure(exit)) {
            const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
            const cause = failure?._tag === "Fail" ? failure.error : Cause.squash(exit.cause)
            return this.#fail(new SupervisorError(null, "shardCount", { cause }))
        }
        const guilds = exit.value
        const resharding = this.#resharding
        this.#resharding = undefined
        if (resharding !== undefined) {
            const { totalShards } = largerShardPlan(guilds, resharding.previousTotalShards)
            this.#slots = splitShards(totalShards, split).map(childSlot)
            this.#log(
                "warn",
                "supervisor.resharded",
                `Fluxer closed a shard of child ${resharding.childId} with close code 4011 (sharding required), so the supervisor moved from ${resharding.previousTotalShards} to ${totalShards} shards for ${guilds} communit${guilds === 1 ? "y" : "ies"}, split across ${this.#slots.length} child process${this.#slots.length === 1 ? "" : "es"}. Every shard starts a new session, so events sent during the move are missed`,
                undefined,
                {
                    fields: {
                        guilds,
                        previousTotalShards: resharding.previousTotalShards,
                        totalShards,
                        children: this.#slots.length,
                    },
                },
            )
            return this.#spawnAll()
        }
        const { totalShards } = automaticShardPlan(guilds)
        this.#slots = splitShards(totalShards, split).map(childSlot)
        this.#log(
            "info",
            "supervisor.automaticSharding",
            `The supervisor chose ${totalShards} shard${totalShards === 1 ? "" : "s"} for ${guilds} communit${guilds === 1 ? "y" : "ies"}, aiming for at most ${guildsPerShard} per shard on average, split across ${this.#slots.length} child process${this.#slots.length === 1 ? "" : "es"}`,
            undefined,
            { fields: { guilds, totalShards, guildsPerShard, children: this.#slots.length } },
        )
        this.#spawnAll()
    }

    #spawn(slot: ChildSlot) {
        if (this.#stopping || this.#failed) return
        this.#clearDisconnectTimer(slot)
        slot.generation += 1
        slot.hello = false
        slot.ready = false
        slot.readyAt = undefined
        slot.connectionState = null
        slot.diagnostics = null
        slot.state = "starting"
        let child: ChildProcess
        const generation = slot.generation
        const output = this.#configuration!.childOutput
        const stdio = output === "prefix" ? "pipe" : output
        // Prefixed children write into pipes, so they receive the parent's console format and color rather than
        // choosing JSON for a non-terminal output. Explicit environment values still win
        const inherited =
            output === "prefix"
                ? (() => {
                      const { format, color } = this.#configuration!.logger.consoleFormat("stdout")
                      return { FLUXERLY_LOG_FORMAT: format, FLUXERLY_LOG_COLOR: color ? "1" : "0" }
                  })()
                : {}
        try {
            child = fork(this.#configuration!.entry, [...this.#configuration!.args], {
                env: { ...inherited, ...Object.fromEntries(this.#configuration!.environment) },
                execArgv: [...this.#configuration!.execArgv],
                stdio: ["ignore", stdio, stdio, "ipc"],
                windowsHide: true,
            } as unknown as Parameters<typeof fork>[2])
        } catch (error) {
            slot.state = "failed"
            this.#log("error", "supervisor.spawnFailed", `Could not start child ${slot.configuration.id}`, slot, {
                error,
            })
            this.#fail(new SupervisorError(slot.configuration.id, "spawn", { cause: error }))
            return
        }
        // Exit is handled after forwarded output has drained, so a crash stack trace printed just before exit is kept.
        // A grandchild holding a pipe open cannot delay exit handling beyond a bounded grace period
        let openStreams = output === "prefix" ? 2 : 0
        let exited: [number | null, NodeJS.Signals | null] | undefined
        let grace: ReturnType<typeof setTimeout> | undefined
        const settle = (force = false) => {
            if (!exited || (openStreams > 0 && !force)) return
            const [code, signal] = exited
            exited = undefined
            if (grace) clearTimeout(grace)
            this.#exit(slot, child, generation, code, signal)
        }
        if (output === "prefix") {
            const drained = () => {
                openStreams -= 1
                settle()
            }
            const logger = this.#configuration!.logger
            forwardLines(child.stdout, process.stdout, "stdout", slot.configuration, logger, drained)
            forwardLines(child.stderr, process.stderr, "stderr", slot.configuration, logger, drained)
        }
        this.#log(
            "info",
            "supervisor.spawn",
            `Started child ${slot.configuration.id}${typeof child.pid === "number" ? ` (pid ${child.pid})` : ""} for ${slot.configuration.assignment.shardIds.length === 1 ? "shard" : "shards"} ${slot.configuration.assignment.shardIds.join(", ")}`,
            slot,
            { fields: { generation: slot.generation } },
        )
        slot.child = child
        const startupTimeoutMs = this.#configuration!.startupTimeoutMs
        slot.startupTimer = setTimeout(() => {
            if (slot.child !== child || slot.generation !== generation || slot.ready) return
            this.#log(
                "error",
                "supervisor.startupTimeout",
                `Child ${slot.configuration.id} did not become ready within ${startupTimeoutMs} ms (startupTimeoutMs), so the supervisor shuts down`,
                slot,
                { fields: { startupTimeoutMs } },
            )
            this.#fail(new SupervisorError(slot.configuration.id, "startupTimeout"))
        }, startupTimeoutMs)
        child.on("message", (message: unknown) => this.#message(slot, child, generation, message))
        child.once("disconnect", () => this.#disconnect(slot, child, generation))
        child.once("error", (error) => this.#childError(slot, child, generation, error))
        child.once("exit", (code, signal) => {
            exited = [code, signal]
            if (openStreams > 0) grace = setTimeout(() => settle(true), outputDrainGraceMs)
            settle()
        })
    }

    #log(
        level: "info" | "warn" | "error",
        code: LogCode,
        message: string,
        slot: ChildSlot | undefined,
        extra: {
            readonly error?: unknown
            readonly origin?: "application"
            readonly fields?: Record<string, string | number | boolean | null>
        } = {},
    ) {
        this.#configuration?.logger.log({
            level,
            category: "supervisor",
            code,
            message,
            ...(extra.error === undefined ? {} : { error: extra.error }),
            ...(extra.origin === undefined ? {} : { origin: extra.origin }),
            fields: {
                ...(slot === undefined
                    ? {}
                    : { child: slot.configuration.id, shards: slot.configuration.assignment.shardIds.join(",") }),
                ...extra.fields,
            },
        })
    }

    #childError(slot: ChildSlot, child: ChildProcess, generation: number, error?: unknown) {
        if (slot.child !== child || slot.generation !== generation) return
        slot.state = "failed"
        this.#log(
            "error",
            "supervisor.spawnFailed",
            `Child ${slot.configuration.id} failed to start, or the supervisor could not send it a message`,
            slot,
            {
                error,
            },
        )
        this.#fail(new SupervisorError(slot.configuration.id, "spawn", { cause: error }))
        if (typeof child.pid !== "number") {
            if (slot.stopTimer) clearTimeout(slot.stopTimer)
            slot.stopTimer = undefined
            this.#clearDisconnectTimer(slot)
            slot.child = undefined
            this.#checkStopped()
            return
        }
        this.#requestStop(slot)
    }

    #disconnect(slot: ChildSlot, child: ChildProcess, generation: number) {
        if (slot.child !== child || slot.generation !== generation) return
        slot.connectionState = null
        this.#refreshReadiness()
        if (this.#stopping || this.#failed || slot.disconnectTimer) return
        if (slot.startupTimer) clearTimeout(slot.startupTimer)
        slot.startupTimer = undefined
        this.#pending = this.#pending.filter((request) => request.slot !== slot || request.generation !== generation)
        if (this.#outstanding?.slot === slot && this.#outstanding.generation === generation) {
            if (this.#outstanding.timer) clearTimeout(this.#outstanding.timer)
            this.#outstanding.permit?.abort()
        }
        // A normal process exit closes IPC just before its exit event. Reuse the configured graceful deadline
        // before classifying a still-running current child as a terminal supervisor failure
        const shutdownTimeoutMs = this.#configuration!.shutdownTimeoutMs
        slot.disconnectTimer = setTimeout(() => {
            slot.disconnectTimer = undefined
            if (
                this.#stopping ||
                this.#failed ||
                slot.child !== child ||
                slot.generation !== generation ||
                child.exitCode !== null ||
                child.signalCode !== null
            )
                return
            // The observation window is the disconnected child's only graceful exit window. Do not give it a
            // second shutdown timeout after terminal coordination loss, while sibling children still receive
            // their normal graceful stop request
            this.#log(
                "error",
                "supervisor.terminated",
                `Child ${slot.configuration.id} lost its message channel to the supervisor and was still running ${shutdownTimeoutMs} ms later (shutdownTimeoutMs), so the supervisor shuts down and force-terminates it`,
                slot,
                { fields: { shutdownTimeoutMs } },
            )
            this.#fail(new SupervisorError(slot.configuration.id, "closed"))
            this.#requestStop(slot, true)
        }, shutdownTimeoutMs)
    }

    #message(slot: ChildSlot, child: ChildProcess, generation: number, message: unknown) {
        if (slot.child !== child || slot.generation !== generation || slot.disconnectTimer) return
        // Children that drain during a shutdown still share the account limits, so they never wait for an answer
        if (this.#accountLimitMessage(slot, generation, message)) return
        if (this.#stopping || this.#failed) return
        if (!record(message) || typeof message.type !== "string")
            return this.#fail(new SupervisorError(slot.configuration.id, "protocol"))
        if ("generation" in message && message.generation !== generation) return
        if (message.type === "hello") {
            if (!hasExactKeys(message, ["type"]) || slot.hello)
                return this.#fail(new SupervisorError(slot.configuration.id, "protocol"))
            slot.hello = true
            const { diagnosticsIntervalMs, shutdownTimeoutMs } = this.#configuration!
            this.#send(slot, {
                type: "assignment",
                generation,
                assignment: slot.configuration.assignment,
                diagnosticsIntervalMs,
                // A stopping child lets running work finish, keeping a reserve of shutdownTimeoutMs to close
                drainMs: Math.max(0, shutdownTimeoutMs - childCloseReserveMs),
            })
            // A new or restarted child starts with the account's running global pause
            const waitMs = Math.ceil(this.#globalPauseUntil - performance.now())
            if (waitMs > 0) this.#send(slot, { type: "globalPause", generation, waitMs })
            return
        }
        if (
            message.type === "diagnostics" &&
            hasExactKeys(message, ["type", "generation", "diagnostics"]) &&
            slot.ready &&
            record(message.diagnostics) &&
            hasExactKeys(message.diagnostics, diagnosticsKeys)
        ) {
            slot.diagnostics = Object.freeze({
                receivedAt: Date.now(),
                client: deepFreeze(message.diagnostics as unknown as ClientDiagnostics),
            })
            return
        }
        if (
            message.type === "state" &&
            hasExactKeys(message, ["type", "generation", "state"]) &&
            slot.hello &&
            !slot.ready &&
            connectionState(message.state)
        )
            return
        if (message.type === "ready" && hasExactKeys(message, ["type", "generation"]) && slot.hello && !slot.ready) {
            slot.ready = true
            slot.readyAt = performance.now()
            slot.state = "running"
            if (slot.startupTimer) clearTimeout(slot.startupTimer)
            slot.startupTimer = undefined
            if (this.#slots.every((current) => current.ready)) {
                this.#state = "running"
                Deferred.doneUnsafe(this.#startup, Effect.void)
            }
            return
        }
        if (
            message.type === "state" &&
            hasExactKeys(message, ["type", "generation", "state"]) &&
            slot.hello &&
            slot.ready &&
            connectionState(message.state)
        ) {
            slot.connectionState = message.state
            this.#refreshReadiness()
            return
        }
        if (
            message.type === "identify" &&
            hasExactKeys(message, ["type", "generation", "requestId", "shardId"]) &&
            safeInteger(message.requestId) &&
            message.requestId >= 0 &&
            safeInteger(message.shardId) &&
            slot.hello &&
            slot.ready &&
            slot.configuration.assignment.shardIds.includes(message.shardId)
        ) {
            // Every child stops during a reshard, so its request stays unanswered until stopping withdraws it
            if (this.#resharding !== undefined) return
            if (
                this.#pending.some(
                    (request) =>
                        request.slot === slot &&
                        request.generation === generation &&
                        request.requestId === message.requestId,
                ) ||
                (this.#outstanding?.slot === slot &&
                    this.#outstanding.generation === generation &&
                    this.#outstanding.requestId === message.requestId)
            )
                return this.#fail(new SupervisorError(slot.configuration.id, "protocol"))
            this.#pending.push({ slot, generation, requestId: message.requestId, shardId: message.shardId })
            this.#scheduleGrant()
            return
        }
        if (
            message.type === "cancel" &&
            hasExactKeys(message, ["type", "generation", "requestId"]) &&
            safeInteger(message.requestId) &&
            message.requestId >= 0
        ) {
            if (
                this.#outstanding?.slot === slot &&
                this.#outstanding.generation === generation &&
                this.#outstanding.requestId === message.requestId
            ) {
                if (this.#outstanding.stalled) return
                this.#clearOutstanding()
                this.#send(slot, { type: "cancelled", generation, requestId: message.requestId })
                this.#scheduleGrant()
                return
            }
            this.#pending = this.#pending.filter(
                (request) =>
                    !(
                        request.slot === slot &&
                        request.generation === generation &&
                        request.requestId === message.requestId
                    ),
            )
            this.#send(slot, { type: "cancelled", generation, requestId: message.requestId })
            return
        }
        if (
            message.type === "sent" &&
            hasExactKeys(message, ["type", "generation", "requestId"]) &&
            safeInteger(message.requestId) &&
            this.#outstanding?.slot === slot &&
            this.#outstanding.generation === generation &&
            this.#outstanding.requestId === message.requestId &&
            // A send before the grant, while the coordinator is still deciding, is a protocol failure
            this.#outstanding.timer !== undefined
        ) {
            if (this.#outstanding.stalled) return
            this.#clearOutstanding()
            this.#lastIdentifyAt = performance.now()
            this.#scheduleGrant()
            return
        }
        if (
            (message.type === "closed" || message.type === "failed") &&
            hasExactKeys(
                message,
                message.type === "closed" ? ["type", "generation"] : ["type", "generation", "reason"],
            ) &&
            slot.hello
        ) {
            if (
                message.type === "failed" &&
                message.reason !== "client" &&
                message.reason !== "configure" &&
                message.reason !== "sharding"
            )
                return this.#fail(new SupervisorError(slot.configuration.id, "protocol"))
            // An explicit total is the application's plan, so its 4011 closure is an ordinary child failure
            if (message.type === "failed" && message.reason === "sharding" && this.#configuration!.automatic)
                return this.#reshard(slot)
            this.#requestStop(slot)
            return
        }
        this.#fail(new SupervisorError(slot.configuration.id, "protocol"))
    }

    /**
     * Handle a child message about Fluxer's account-wide limits, in every supervisor state. Returns false for any other
     * message, including a malformed one, which the caller then treats like other messages
     */
    #accountLimitMessage(slot: ChildSlot, generation: number, message: unknown): boolean {
        if (!record(message) || message.generation !== generation || !slot.hello) return false
        const { type, requestId } = message
        const request = safeInteger(requestId) && requestId >= 0 ? requestId : undefined
        const exact = (keys: readonly string[]) => hasExactKeys(message, ["type", "generation", ...keys])
        if (type === "globalPause" && exact(["waitMs"]) && positiveTimer(message.waitMs)) {
            this.#relayGlobalPause(slot, message.waitMs)
            return true
        }
        if (type === "memberRequest" && exact(["requestId"]) && request !== undefined) {
            const now = performance.now()
            this.#memberRequests = this.#memberRequests.filter(({ at }) => at > now - memberRequestWindowMs)
            if (this.#memberRequests.length >= memberRequestLimit) {
                const oldest = this.#memberRequests[this.#memberRequests.length - memberRequestLimit]!
                this.#send(slot, {
                    type: "memberDenied",
                    generation,
                    requestId: request,
                    retryAfterMs: Math.max(1, Math.ceil(oldest.at + memberRequestWindowMs - now)),
                })
                return true
            }
            this.#countMemberRequest({ at: now, holder: { slot, generation, requestId: request } })
            this.#send(slot, { type: "memberGrant", generation, requestId: request })
            return true
        }
        // A sent report without requestId is a member request that had no grant, such as one from gateway.send
        if (type === "memberSent" && (exact([]) || (exact(["requestId"]) && request !== undefined))) {
            if (request !== undefined) this.#releaseMemberRequest(slot, generation, request)
            this.#countMemberRequest({ at: performance.now() })
            return true
        }
        if (type === "memberWithdrawn" && exact(["requestId"]) && request !== undefined) {
            this.#releaseMemberRequest(slot, generation, request)
            return true
        }
        return false
    }

    /** Record a global pause one child learned and pass it to every other child, unless a running pause ends later */
    #relayGlobalPause(source: ChildSlot, waitMs: number) {
        const until = performance.now() + waitMs
        if (until <= this.#globalPauseUntil) return
        this.#globalPauseUntil = until
        for (const slot of this.#slots)
            if (slot !== source && slot.hello && slot.child?.connected && !slot.disconnectTimer)
                this.#send(slot, { type: "globalPause", generation: slot.generation, waitMs })
    }

    /** Count a member request as the latest, keeping only the latest memberRequestLimit */
    #countMemberRequest(request: CountedMemberRequest) {
        this.#memberRequests.push(request)
        if (this.#memberRequests.length > memberRequestLimit) this.#memberRequests.shift()
    }

    /** Stop counting a child's granted request from its grant. It has been withdrawn, or is counted again as sent */
    #releaseMemberRequest(slot: ChildSlot, generation: number, requestId: number) {
        const index = this.#memberRequests.findIndex(
            ({ holder }) => holder?.slot === slot && holder.generation === generation && holder.requestId === requestId,
        )
        if (index !== -1) this.#memberRequests.splice(index, 1)
    }

    #scheduleGrant() {
        if (this.#grantTimer || this.#outstanding || this.#stopping || this.#failed || this.#pending.length === 0)
            return
        const delay = Math.max(0, this.#lastIdentifyAt + this.#configuration!.minimumSpacingMs - performance.now())
        if (delay === 0) return this.#grant()
        this.#grantTimer = setTimeout(() => {
            this.#grantTimer = undefined
            this.#scheduleGrant()
        }, Math.ceil(delay))
    }

    #refreshReadiness() {
        const ready = this.#allConnected()
        if (ready && !this.#readyObserved) {
            this.#readyObserved = true
            Deferred.doneUnsafe(this.#readiness, Effect.void)
        } else if (!ready && this.#readyObserved) {
            this.#readyObserved = false
            this.#readiness = Deferred.makeUnsafe<void, SupervisorError>()
        }
    }

    #grant() {
        if (this.#stopping || this.#failed || this.#outstanding) return
        while (this.#pending.length) {
            const request = this.#pending.shift()!
            if (request.slot.child === undefined || request.slot.generation !== request.generation) continue
            const outstanding: OutstandingIdentify = { ...request, timer: undefined, permit: undefined, stalled: false }
            this.#outstanding = outstanding
            const coordinator = this.#configuration!.coordinator
            if (coordinator) this.#askCoordinator(outstanding, coordinator)
            else this.#sendGrant(outstanding)
            return
        }
    }

    /**
     * Wait for the application coordinator before granting. The request stays outstanding meanwhile, so no other child
     * is granted, and a cancel, exit or shutdown aborts the permit signal
     */
    #askCoordinator(outstanding: OutstandingIdentify, coordinator: CoordinatorPermit) {
        const controller = new AbortController()
        outstanding.permit = controller
        const slot = outstanding.slot
        const totalShards = slot.configuration.assignment.totalShards
        let permit: Promise<unknown>
        try {
            permit = Promise.resolve(coordinator(outstanding.shardId, totalShards, controller.signal))
        } catch (error) {
            permit = Promise.reject(error)
        }
        permit.then(
            () => {
                if (controller.signal.aborted || this.#outstanding !== outstanding) return
                outstanding.permit = undefined
                this.#sendGrant(outstanding)
            },
            (error: unknown) => {
                // A rejection after this supervisor aborted the permit answers its own cancellation
                if (controller.signal.aborted || this.#outstanding !== outstanding) return
                outstanding.permit = undefined
                this.#log(
                    "error",
                    "supervisor.identifyPermitFailed",
                    `The identify coordinator (identify.coordinator) failed to grant shard ${outstanding.shardId} permission to start a new session, so child ${slot.configuration.id} retries the connection as after a network failure`,
                    slot,
                    { error, origin: "application", fields: { shardId: outstanding.shardId } },
                )
                this.#clearOutstanding()
                this.#send(slot, {
                    type: "denied",
                    generation: outstanding.generation,
                    requestId: outstanding.requestId,
                })
                this.#scheduleGrant()
            },
        )
    }

    #sendGrant(outstanding: OutstandingIdentify) {
        outstanding.timer = setTimeout(() => {
            if (this.#outstanding === outstanding) {
                outstanding.stalled = true
                this.#log(
                    "warn",
                    "supervisor.identifyUnacknowledged",
                    `Child ${outstanding.slot.configuration.id} did not confirm sending Identify for shard ${outstanding.shardId} within ${grantAcknowledgementMs} ms of its permission, so the supervisor stops it`,
                    outstanding.slot,
                    { fields: { shardId: outstanding.shardId } },
                )
                this.#requestStop(outstanding.slot)
            }
        }, grantAcknowledgementMs)
        if (
            !this.#send(outstanding.slot, {
                type: "grant",
                generation: outstanding.generation,
                requestId: outstanding.requestId,
            })
        )
            this.#requestStop(outstanding.slot)
    }

    #clearOutstanding() {
        if (!this.#outstanding) return
        if (this.#outstanding.timer) clearTimeout(this.#outstanding.timer)
        this.#outstanding.permit?.abort()
        this.#outstanding = undefined
    }

    #send(slot: ChildSlot, message: object): boolean {
        const child = slot.child
        if (!child || !child.connected) {
            // Parent-initiated shutdown remains successful when a child has already lost IPC. The owned process
            // still follows the normal stop deadline and verified-exit path
            if (!this.#stopping && !this.#failed && !slot.disconnectTimer)
                this.#fail(new SupervisorError(slot.configuration.id, "spawn"))
            return false
        }
        try {
            child.send(message, undefined, undefined, (error) => {
                if (error && slot.child === child && !(this.#stopping && !child.connected) && !slot.disconnectTimer)
                    this.#childError(slot, child, slot.generation, error)
            })
            return true
        } catch (error) {
            if ((this.#stopping && !child.connected) || slot.disconnectTimer) return false
            this.#childError(slot, child, slot.generation, error)
            return false
        }
    }

    #exit(
        slot: ChildSlot,
        child: ChildProcess,
        generation: number,
        code: number | null = null,
        signal: NodeJS.Signals | null = null,
    ) {
        if (slot.child !== child || slot.generation !== generation) return
        const expected = this.#stopping || slot.state === "stopping"
        this.#log(
            expected ? "info" : "warn",
            "supervisor.exit",
            `Child ${slot.configuration.id} exited${signal === null ? ` with code ${code ?? "unknown"}` : ` after signal ${signal}`}${expected ? "" : " unexpectedly"}`,
            slot,
            { fields: { exitCode: code, signal } },
        )
        slot.child = undefined
        slot.connectionState = null
        slot.diagnostics = null
        this.#refreshReadiness()
        if (slot.startupTimer) clearTimeout(slot.startupTimer)
        slot.startupTimer = undefined
        if (slot.stopTimer) clearTimeout(slot.stopTimer)
        slot.stopTimer = undefined
        this.#clearDisconnectTimer(slot)
        this.#pending = this.#pending.filter((request) => request.slot !== slot || request.generation !== generation)
        if (this.#outstanding?.slot === slot && this.#outstanding.generation === generation) {
            this.#clearOutstanding()
            // The child might have sent after the parent lost IPC, so start a fresh full interval only after verified exit
            this.#lastIdentifyAt = performance.now()
        }
        // A granted member request the child never reported may have reached Fluxer just before the exit, so it counts
        // from the exit
        const exited = ({ holder }: CountedMemberRequest) => holder?.slot === slot && holder.generation === generation
        const held = this.#memberRequests.filter(exited).length
        this.#memberRequests = this.#memberRequests.filter((request) => !exited(request))
        for (let index = 0; index < held; index++) this.#countMemberRequest({ at: performance.now() })
        if (this.#stopping || this.#failed) {
            slot.state = this.#failed ? "failed" : "closed"
            this.#checkStopped()
            return
        }
        if (this.#resharding !== undefined) {
            slot.state = "closed"
            return this.#continueReshard()
        }
        const restart = this.#configuration!.restart
        if (!restart) {
            slot.state = "failed"
            this.#log(
                "error",
                "supervisor.crash",
                `Child ${slot.configuration.id} stopped unexpectedly, and the supervisor option restart is false, so the supervisor shuts down`,
                slot,
                {
                    fields: { exitCode: code, signal },
                },
            )
            this.#fail(new SupervisorError(slot.configuration.id, "closed"))
            return
        }
        // Only consecutive crashes count: A child that ran long enough after readiness failed on its own, not in a loop
        const budgetReset =
            slot.restarts > 0 &&
            slot.readyAt !== undefined &&
            performance.now() - slot.readyAt >= restart.healthyResetMs
        if (budgetReset) slot.restarts = 0
        if (slot.restarts >= restart.maxAttempts) {
            slot.state = "failed"
            this.#log(
                "error",
                "supervisor.crash",
                `Child ${slot.configuration.id} stopped again after using all ${restart.maxAttempts} restarts (restart.maxAttempts), so the supervisor shuts down`,
                slot,
                { fields: { exitCode: code, signal, restarts: slot.restarts } },
            )
            this.#fail(new SupervisorError(slot.configuration.id, "restartLimit"))
            return
        }
        slot.restarts += 1
        slot.state = "restarting"
        const delay = Math.min(restart.maxDelayMs, restart.minDelayMs * 2 ** (slot.restarts - 1))
        this.#log(
            "warn",
            "supervisor.restart",
            `Restarting child ${slot.configuration.id} in ${delay} ms (restart ${slot.restarts} of ${restart.maxAttempts}${budgetReset ? ", count reset after a healthy run" : ""})`,
            slot,
            { fields: { restarts: slot.restarts, delayMs: delay, budgetReset } },
        )
        slot.restartTimer = setTimeout(() => {
            slot.restartTimer = undefined
            this.#spawn(slot)
        }, delay)
        this.#scheduleGrant()
    }

    #requestStop(slot: ChildSlot, force = false) {
        const child = slot.child
        if (!child) return
        if (force) {
            if (slot.stopTimer) clearTimeout(slot.stopTimer)
            slot.stopTimer = undefined
            slot.state = "stopping"
            try {
                // The disconnected child has already consumed its configured observation window
                child.kill("SIGKILL")
            } catch (error) {
                this.#childError(slot, child, slot.generation, error)
            }
            return
        }
        if (slot.stopTimer) return
        slot.state = "stopping"
        const generation = slot.generation
        const shutdownTimeoutMs = this.#configuration!.shutdownTimeoutMs
        slot.stopTimer = setTimeout(() => {
            if (slot.child !== child || slot.generation !== generation) return
            this.#log(
                "warn",
                "supervisor.terminated",
                `Child ${slot.configuration.id} did not exit within ${shutdownTimeoutMs} ms (shutdownTimeoutMs) of the stop request, so the supervisor force-terminates it`,
                slot,
                { fields: { shutdownTimeoutMs } },
            )
            try {
                // Only this exact ChildProcess is force-terminated. Completion still waits for its exit event
                child.kill("SIGKILL")
            } catch (error) {
                this.#childError(slot, child, generation, error)
            }
        }, shutdownTimeoutMs)
        this.#send(slot, { type: "shutdown", generation })
    }

    #fail(error: SupervisorError) {
        if (this.#failed) return
        this.#failed = true
        this.#state = "failed"
        this.#failure = error
        this.#beginShutdown()
    }

    #beginShutdown() {
        if (this.#stopping) return
        this.#stopping = true
        if (!this.#failed) this.#state = "stopping"
        if (this.#grantTimer) clearTimeout(this.#grantTimer)
        this.#grantTimer = undefined
        this.#pending = []
        if (this.#outstanding?.timer) clearTimeout(this.#outstanding.timer)
        this.#outstanding?.permit?.abort()
        // The count's own cleanup closes its transient client, and #planned then completes the shutdown
        if (this.#counting) Effect.runFork(Fiber.interrupt(this.#counting))
        for (const slot of this.#slots) {
            if (slot.restartTimer) clearTimeout(slot.restartTimer)
            slot.restartTimer = undefined
            if (slot.startupTimer) clearTimeout(slot.startupTimer)
            slot.startupTimer = undefined
            this.#clearDisconnectTimer(slot)
            if (slot.child) this.#requestStop(slot)
            else {
                slot.state = this.#failed ? "failed" : "closed"
                slot.connectionState = null
            }
        }
        this.#checkStopped()
    }

    #clearDisconnectTimer(slot: ChildSlot) {
        if (slot.disconnectTimer) clearTimeout(slot.disconnectTimer)
        slot.disconnectTimer = undefined
    }

    #checkStopped() {
        if (this.#counting || this.#slots.some((slot) => slot.child !== undefined)) return
        this.#clearOutstanding()
        if (this.#failed) {
            Deferred.doneUnsafe(this.#startup, Effect.fail(this.#failure!))
            Deferred.doneUnsafe(this.#terminal, Effect.fail(this.#failure!))
            Deferred.doneUnsafe(this.#readiness, Effect.fail(this.#failure!))
        } else {
            this.#state = "closed"
            Deferred.doneUnsafe(this.#startup, Effect.fail(new SupervisorError(null, "closed")))
            Deferred.doneUnsafe(this.#terminal, Effect.void)
            Deferred.doneUnsafe(this.#readiness, Effect.fail(new SupervisorError(null, "closed")))
        }
        this.#configuration = undefined
        Deferred.doneUnsafe(this.#stopped, Effect.void)
    }
}

/** The failure of a session start that the supervisor can no longer grant, because it stopped this child or lost contact */
function supervisorStopped(): ConnectionError {
    return new ConnectionError("gateway", "closed", null, {
        details: { detail: "the supervisor stopped this child or lost contact with it" },
    })
}

interface PendingPermit {
    readonly send: () => void
    readonly resume: (effect: Effect.Effect<void, ConnectionError>) => void
}

const unreachable: MemberRequestSlot = Object.freeze({ kind: "unreachable" })

/** Child-side IPC bridge. It owns no process signals and reports no child output */
export class ChildBridge {
    readonly #assignment = Deferred.makeUnsafe<SupervisorAssignment, SupervisorChildError>()
    readonly #stop = Deferred.makeUnsafe<void, SupervisorChildError>()
    readonly #pending = new Map<number, PendingPermit>()
    readonly #cancelled = new Set<number>()
    /** Member request slots waiting for the parent's answer, by request ID */
    readonly #memberAnswers = new Map<number, (slot: MemberRequestSlot) => void>()
    /** Host time at which the latest global pause the parent relayed ends */
    #globalPauseUntil = 0
    #onGlobalPause: ((waitMs: number) => void) | undefined
    #generation: number | undefined
    #diagnosticsIntervalMs = defaultDiagnosticsIntervalMs
    #drainMs = 0
    #diagnosticsTimer: ReturnType<typeof setInterval> | undefined
    #nextRequestId = 0
    #stopping = false
    #ended = false
    #cleaned = false
    readonly #abort = new AbortController()

    readonly signal: AbortSignal = this.#abort.signal

    readonly identifyGate: IdentifyGate = {
        permit: (shardId, send) => this.#permit(shardId, send),
    }

    readonly accountLimits: AccountLimits = {
        shareGlobalPause: (waitMs) => {
            if (!this.#ended && this.#generation !== undefined && positiveTimer(waitMs))
                this.#send({ type: "globalPause", generation: this.#generation, waitMs })
        },
        onGlobalPause: (listener) => {
            this.#onGlobalPause = listener
            const waitMs = Math.ceil(this.#globalPauseUntil - performance.now())
            if (waitMs > 0) listener(waitMs)
        },
        members: {
            request: () => this.#memberRequest(),
            sent: () => {
                if (!this.#ended && this.#generation !== undefined)
                    this.#send({ type: "memberSent", generation: this.#generation })
            },
        },
    }

    private readonly onMessage = (message: unknown) => this.#message(message)
    private readonly onDisconnect = () => this.#disconnect()

    private constructor() {
        process.on("message", this.onMessage)
        process.once("disconnect", this.onDisconnect)
        if (!this.#send({ type: "hello" })) this.#disconnect()
    }

    static open(): Effect.Effect<ChildBridge, SupervisorChildError> {
        return Effect.suspend(() => {
            if (typeof process.send !== "function" || !process.connected)
                return Effect.fail(new SupervisorChildError("disconnected"))
            return Effect.succeed(new ChildBridge())
        })
    }

    waitForAssignment(): Effect.Effect<SupervisorAssignment, SupervisorChildError> {
        return Deferred.await(this.#assignment)
    }

    waitForStop(): Effect.Effect<void, SupervisorChildError> {
        return Deferred.await(this.#stop)
    }

    ready() {
        if (!this.#ended && this.#generation !== undefined) this.#send({ type: "ready", generation: this.#generation })
    }

    state(state: ConnectionState) {
        if (!this.#ended && this.#generation !== undefined)
            this.#send({ type: "state", generation: this.#generation, state })
    }

    /** How long a stop requested by the parent lets running work finish, within the parent's shutdownTimeoutMs */
    get drainMs() {
        return this.#drainMs
    }

    failed(reason: "client" | "configure" | "sharding") {
        if (!this.#ended && this.#generation !== undefined)
            this.#send({ type: "failed", generation: this.#generation, reason })
    }

    /**
     * Send the client's diagnostics now and then at the parent's interval until this bridge closes. The timer does not
     * keep the process alive
     */
    reportDiagnostics(read: () => ClientDiagnostics) {
        if (this.#diagnosticsTimer || this.#ended) return
        const report = () => {
            if (!this.#ended && this.#generation !== undefined)
                this.#send({ type: "diagnostics", generation: this.#generation, diagnostics: read() })
        }
        report()
        this.#diagnosticsTimer = setInterval(report, this.#diagnosticsIntervalMs)
        this.#diagnosticsTimer.unref()
    }

    close() {
        if (!this.#ended) {
            this.#ended = true
            this.#abort.abort()
            if (this.#generation !== undefined) this.#send({ type: "closed", generation: this.#generation })
        }
        Deferred.doneUnsafe(this.#stop, Effect.void)
        this.#cleanup(true)
    }

    #permit(shardId: number, send: () => void): Effect.Effect<void, ConnectionError> {
        const bridge = this
        return Effect.callback<void, ConnectionError>((resume) => {
            const generation = bridge.#generation
            const requestId = bridge.#nextRequestId++
            if (bridge.#ended || bridge.#stopping || generation === undefined) {
                resume(Effect.fail(supervisorStopped()))
                return
            }
            bridge.#pending.set(requestId, { send, resume })
            if (!bridge.#send({ type: "identify", generation, requestId, shardId })) {
                bridge.#pending.delete(requestId)
                resume(Effect.fail(supervisorStopped()))
                return
            }
            return Effect.sync(() => {
                if (bridge.#pending.delete(requestId)) {
                    bridge.#cancelled.add(requestId)
                    bridge.#send({ type: "cancel", generation, requestId })
                }
            })
        })
    }

    /**
     * Ask the parent for a member request slot. The answer is unreachable at once without a channel, when the channel
     * closes, or after memberAnswerMs without an answer, so a child never waits on a parent that cannot answer.
     * Interruption or a missed answer withdraws the request, so a late grant frees its slot again
     */
    #memberRequest(): Effect.Effect<MemberRequestSlot> {
        const bridge = this
        return Effect.callback<MemberRequestSlot>((resume) => {
            const generation = bridge.#generation
            if (bridge.#ended || generation === undefined) {
                resume(Effect.succeed(unreachable))
                return
            }
            const requestId = bridge.#nextRequestId++
            const withdraw = () => bridge.#send({ type: "memberWithdrawn", generation, requestId })
            const timer = setTimeout(() => {
                if (!bridge.#memberAnswers.delete(requestId)) return
                withdraw()
                resume(Effect.succeed(unreachable))
            }, memberAnswerMs)
            bridge.#memberAnswers.set(requestId, (slot) => {
                clearTimeout(timer)
                resume(Effect.succeed(slot))
            })
            if (!bridge.#send({ type: "memberRequest", generation, requestId })) {
                bridge.#memberAnswers.delete(requestId)
                clearTimeout(timer)
                resume(Effect.succeed(unreachable))
                return
            }
            return Effect.sync(() => {
                if (!bridge.#memberAnswers.delete(requestId)) return
                clearTimeout(timer)
                withdraw()
            })
        })
    }

    /** A granted slot that reports exactly once whether its request reached the socket */
    #grantedMember(generation: number, requestId: number): MemberRequestSlot {
        let reported = false
        const report = (type: "memberSent" | "memberWithdrawn") => {
            if (reported) return
            reported = true
            if (!this.#ended) this.#send({ type, generation, requestId })
        }
        return { kind: "granted", sent: () => report("memberSent"), withdraw: () => report("memberWithdrawn") }
    }

    #message(message: unknown) {
        if (this.#ended) return
        if (!record(message) || typeof message.type !== "string") return this.#protocol()
        if (
            (message.type === "memberGrant" || message.type === "memberDenied") &&
            hasExactKeys(
                message,
                message.type === "memberGrant"
                    ? ["type", "generation", "requestId"]
                    : ["type", "generation", "requestId", "retryAfterMs"],
            ) &&
            safeInteger(message.generation) &&
            message.generation === this.#generation &&
            safeInteger(message.requestId) &&
            (message.type === "memberGrant" || positiveTimer(message.retryAfterMs))
        ) {
            const answer = this.#memberAnswers.get(message.requestId)
            // An answer after this child stopped waiting is ignored. The child withdrew that request then
            if (!answer) return
            this.#memberAnswers.delete(message.requestId)
            answer(
                message.type === "memberGrant"
                    ? this.#grantedMember(message.generation, message.requestId)
                    : { kind: "refused", retryAfterMs: message.retryAfterMs as number },
            )
            return
        }
        if (
            message.type === "globalPause" &&
            hasExactKeys(message, ["type", "generation", "waitMs"]) &&
            message.generation === this.#generation &&
            positiveTimer(message.waitMs)
        ) {
            const until = performance.now() + message.waitMs
            if (until > this.#globalPauseUntil) {
                this.#globalPauseUntil = until
                this.#onGlobalPause?.(message.waitMs)
            }
            return
        }
        if (
            message.type === "assignment" &&
            hasExactKeys(message, ["type", "generation", "assignment", "diagnosticsIntervalMs", "drainMs"]) &&
            safeInteger(message.generation) &&
            message.generation > 0 &&
            positiveTimer(message.diagnosticsIntervalMs) &&
            safeInteger(message.drainMs) &&
            message.drainMs >= 0 &&
            message.drainMs <= maximumTimerMs &&
            record(message.assignment) &&
            hasExactKeys(message.assignment, ["totalShards", "shardIds"]) &&
            safeInteger(message.assignment.totalShards) &&
            message.assignment.totalShards > 0
        ) {
            if (this.#generation !== undefined) return this.#protocol()
            const shardIds = assignment(message.assignment.shardIds, message.assignment.totalShards)
            if (!shardIds) return this.#protocol()
            this.#generation = message.generation
            this.#diagnosticsIntervalMs = message.diagnosticsIntervalMs
            this.#drainMs = message.drainMs
            Deferred.doneUnsafe(
                this.#assignment,
                Effect.succeed(
                    Object.freeze({
                        totalShards: message.assignment.totalShards,
                        shardIds: Object.freeze([...shardIds]),
                    }),
                ),
            )
            return
        }
        if (
            message.type === "grant" &&
            hasExactKeys(message, ["type", "generation", "requestId"]) &&
            message.generation === this.#generation &&
            safeInteger(message.requestId)
        ) {
            const pending = this.#pending.get(message.requestId)
            if (!pending) {
                if (this.#cancelled.delete(message.requestId)) return
                return this.#protocol()
            }
            this.#pending.delete(message.requestId)
            const generation = this.#generation
            pending.resume(
                Effect.uninterruptible(
                    Effect.try({
                        try: () => {
                            if (this.#stopping || this.#ended) throw new Error("closed")
                            pending.send()
                            if (
                                generation === undefined ||
                                !this.#send({ type: "sent", generation, requestId: message.requestId })
                            )
                                throw new Error("closed")
                        },
                        catch: () => supervisorStopped(),
                    }),
                ),
            )
            return
        }
        if (
            message.type === "cancelled" &&
            hasExactKeys(message, ["type", "generation", "requestId"]) &&
            message.generation === this.#generation &&
            safeInteger(message.requestId)
        ) {
            this.#cancelled.delete(message.requestId)
            return
        }
        if (
            message.type === "denied" &&
            hasExactKeys(message, ["type", "generation", "requestId"]) &&
            message.generation === this.#generation &&
            safeInteger(message.requestId)
        ) {
            const pending = this.#pending.get(message.requestId)
            if (!pending) {
                if (this.#cancelled.delete(message.requestId)) return
                return this.#protocol()
            }
            this.#pending.delete(message.requestId)
            // The parent logged the coordinator's failure. The client retries this like a network failure
            pending.resume(
                Effect.fail(
                    new ConnectionError("gateway", "network", null, {
                        details: {
                            detail: "the supervisor's identify coordinator did not grant permission to start a new session",
                        },
                        hint: "Check the supervisor's records with code supervisor.identifyPermitFailed and the permit function of its identify.coordinator",
                    }),
                ),
            )
            return
        }
        if (
            message.type === "shutdown" &&
            hasExactKeys(message, ["type", "generation"]) &&
            message.generation === this.#generation
        ) {
            this.#stopping = true
            this.#abort.abort()
            Deferred.doneUnsafe(this.#stop, Effect.void)
            return
        }
        this.#protocol()
    }

    #disconnect() {
        if (this.#ended) return this.#cleanup(false)
        this.#ended = true
        this.#stopping = true
        this.#abort.abort()
        Deferred.doneUnsafe(this.#assignment, Effect.fail(new SupervisorChildError("disconnected")))
        Deferred.doneUnsafe(this.#stop, Effect.fail(new SupervisorChildError("disconnected")))
        this.#cleanup(false)
    }

    #protocol() {
        if (this.#ended) return this.#cleanup(false)
        this.#ended = true
        this.#stopping = true
        Deferred.doneUnsafe(this.#assignment, Effect.fail(new SupervisorChildError("protocol")))
        Deferred.doneUnsafe(this.#stop, Effect.fail(new SupervisorChildError("protocol")))
        this.#cleanup(false)
    }

    #cleanup(notifyCancellation: boolean) {
        if (this.#cleaned) return
        this.#cleaned = true
        if (this.#diagnosticsTimer) clearInterval(this.#diagnosticsTimer)
        this.#diagnosticsTimer = undefined
        process.off("message", this.onMessage)
        process.off("disconnect", this.onDisconnect)
        for (const [requestId, pending] of this.#pending) {
            if (notifyCancellation && this.#generation !== undefined)
                this.#send({ type: "cancel", generation: this.#generation, requestId })
            pending.resume(Effect.fail(supervisorStopped()))
        }
        this.#pending.clear()
        this.#cancelled.clear()
        const answers = [...this.#memberAnswers.values()]
        this.#memberAnswers.clear()
        for (const answer of answers) answer(unreachable)
        this.#onGlobalPause = undefined
    }

    #send(message: object): boolean {
        try {
            if (!process.connected || typeof process.send !== "function") return false
            process.send(message, undefined, undefined, (error) => {
                if (error) this.#disconnect()
            })
            return true
        } catch {
            // allow-silent: A false return makes the child treat the parent as disconnected and stop
            return false
        }
    }
}

/**
 * The failure reason a child reports for its stopped client: Sharding when Fluxer closed a shard with 4011 (sharding
 * required), so a supervisor with totalShards "auto" can move to a larger plan, otherwise client
 */
export function childFailureReason(error: unknown): "client" | "sharding" {
    // Tags rather than classes, so a failure from another copy of the SDK module graph is still recognized
    const failure = record(error) && error._tag === "ShardConnectionError" ? error.failure : error
    return record(failure) &&
        failure._tag === "ConnectionError" &&
        failure.phase === "gateway" &&
        failure.status === CloseCode.shardingRequired
        ? "sharding"
        : "client"
}

export function createSupervisor(
    options: SupervisorOptions,
    native = false,
): Effect.Effect<SupervisorOwner, ConfigurationError> {
    return validateSupervisorConfiguration(options, native).pipe(
        Effect.tap((configuration) =>
            Effect.withFiber((fiber) => {
                if (native) configuration.logger.context = fiber.context
                return Effect.void
            }),
        ),
        Effect.map((configuration) => new SupervisorOwner(configuration, native)),
    )
}
