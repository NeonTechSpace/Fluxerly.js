import { fork, type ChildProcess } from "node:child_process"
import { isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import { Deferred, Effect } from "effect"
import { ConfigurationError, ConnectionError } from "#sdk/errors"
import type { IdentifyGate } from "#sdk/internal/client"
import {
    SupervisorChildError,
    SupervisorError,
    type SupervisorAssignment,
    type SupervisorChildState,
    type SupervisorOptions,
    type SupervisorState,
    type SupervisorStatus,
} from "#sdk/supervisor"
import type { ConnectionState, OperationSignal } from "#sdk/client"

const maximumTimerMs = 2_147_483_647
const maximumAttempts = 100
const maximumChildEnvironmentEntries = 64
const maximumArgumentEntries = 64
const maximumArgumentLength = 4_096
const maximumChildIdLength = 128
const defaultStartupTimeoutMs = 30_000
const defaultShutdownTimeoutMs = 5_000
const grantAcknowledgementMs = 5_000

interface RestartConfiguration {
    readonly maxAttempts: number
    readonly minDelayMs: number
    readonly maxDelayMs: number
}

interface SupervisorConfiguration {
    readonly entry: string
    readonly totalShards: number
    readonly children: readonly ChildConfiguration[]
    readonly restart: RestartConfiguration | undefined
    readonly minimumSpacingMs: number
    readonly startupTimeoutMs: number
    readonly shutdownTimeoutMs: number
    readonly environment: readonly (readonly [string, string])[]
    readonly args: readonly string[]
    readonly execArgv: readonly string[]
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
    connectionState: ConnectionState | null
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

interface IdentifyRequest {
    readonly slot: ChildSlot
    readonly generation: number
    readonly requestId: number
    readonly shardId: number
}

interface OutstandingIdentify extends IdentifyRequest {
    readonly timer: ReturnType<typeof setTimeout>
    stalled: boolean
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    return Object.keys(value).every((key) => keys.includes(key))
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    return hasOnlyKeys(value, keys) && keys.every((key) => key in value)
}

function safeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value)
}

function positiveTimer(value: unknown): value is number {
    return safeInteger(value) && value > 0 && value <= maximumTimerMs
}

function childEntry(value: unknown): string | undefined {
    try {
        if (typeof value === "string") return isAbsolute(value) ? value : undefined
        if (!record(value) || value.protocol !== "file:" || typeof value.href !== "string") return undefined
        const path = fileURLToPath(value.href)
        return isAbsolute(path) ? path : undefined
    } catch {
        return undefined
    }
}

function filteredExecArguments(values: readonly string[]): string[] {
    const result: string[] = []
    for (let index = 0; index < values.length; index += 1) {
        const argument = values[index]!
        if (argument === "--conditions" && values[index + 1] === "fluxerly-source") {
            index += 1
            continue
        }
        if (argument === "--conditions=fluxerly-source") continue
        result.push(argument)
    }
    return result
}

function stringArray(value: unknown, field: string): readonly string[] | ConfigurationError {
    if (!Array.isArray(value) || value.length > maximumArgumentEntries)
        return new ConfigurationError(
            field as never,
            `${field} must be an array of at most ${maximumArgumentEntries} strings`,
        )
    const copied: string[] = []
    for (let index = 0; index < value.length; index += 1) {
        if (!(index in value) || typeof value[index] !== "string" || value[index].length > maximumArgumentLength)
            return new ConfigurationError(
                field as never,
                `${field} must contain bounded strings without sparse entries`,
            )
        copied.push(value[index])
    }
    return Object.freeze(copied)
}

function assignment(value: unknown, totalShards: number): readonly number[] | undefined {
    if (!Array.isArray(value) || value.length === 0 || value.length > totalShards) return undefined
    const copied: number[] = []
    const seen = new Set<number>()
    for (let index = 0; index < value.length; index += 1) {
        if (!(index in value) || !safeInteger(value[index]) || value[index] < 0 || value[index] >= totalShards)
            return undefined
        if (seen.has(value[index])) return undefined
        seen.add(value[index])
        copied.push(value[index])
    }
    return copied
}

function childEnvironment(value: unknown): readonly (readonly [string, string])[] | ConfigurationError {
    if (value === undefined) return Object.freeze([])
    if (!record(value) || Object.getOwnPropertySymbols(value).length > 0)
        return new ConfigurationError("childEnvironment", "childEnvironment must be a string record")
    const entries = Object.entries(value)
    if (entries.length > maximumChildEnvironmentEntries)
        return new ConfigurationError("childEnvironment", "childEnvironment has too many entries")
    const copied: (readonly [string, string])[] = []
    for (const [key, current] of entries) {
        if (
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
            typeof current !== "string" ||
            current.length > maximumArgumentLength
        )
            return new ConfigurationError(
                "childEnvironment",
                "childEnvironment keys and values must be bounded strings",
            )
        copied.push(Object.freeze([key, current]))
    }
    return Object.freeze(copied)
}

/** Validate and snapshot supervisor configuration without creating a child process */
export function validateSupervisorConfiguration(
    options: unknown,
): Effect.Effect<SupervisorConfiguration, ConfigurationError> {
    return Effect.suspend(() => {
        if (
            !record(options) ||
            !hasOnlyKeys(options, [
                "entry",
                "totalShards",
                "assignments",
                "restart",
                "identify",
                "startupTimeoutMs",
                "shutdownTimeoutMs",
                "childEnvironment",
                "args",
                "execArgv",
            ])
        )
            return Effect.fail(
                new ConfigurationError("supervisor", "Supervisor settings must contain only supported options"),
            )
        const entry = childEntry(options.entry)
        if (!entry)
            return Effect.fail(new ConfigurationError("entry", "Supervisor entry must be an absolute path or file URL"))
        const totalShards = options.totalShards
        if (!safeInteger(totalShards) || totalShards < 1 || totalShards > 16_384)
            return Effect.fail(
                new ConfigurationError(
                    "totalShards",
                    "Supervisor totalShards must be an integer from 1 through 16,384",
                ),
            )
        if (
            !Array.isArray(options.assignments) ||
            options.assignments.length === 0 ||
            options.assignments.length > totalShards
        )
            return Effect.fail(
                new ConfigurationError("assignments", "Supervisor assignments must be a bounded non-empty array"),
            )
        const seenIds = new Set<string>()
        const seenShards = new Set<number>()
        const children: ChildConfiguration[] = []
        for (let index = 0; index < options.assignments.length; index += 1) {
            if (!(index in options.assignments) || !record(options.assignments[index]))
                return Effect.fail(
                    new ConfigurationError("assignments", "Supervisor assignments must be object entries"),
                )
            const current = options.assignments[index]
            if (!hasExactKeys(current, ["id", "shardIds"]))
                return Effect.fail(
                    new ConfigurationError(
                        "assignments",
                        "Supervisor assignment settings contain an unsupported option",
                    ),
                )
            if (
                typeof current.id !== "string" ||
                current.id.trim().length === 0 ||
                current.id.length > maximumChildIdLength ||
                seenIds.has(current.id)
            )
                return Effect.fail(
                    new ConfigurationError("childId", "Supervisor child IDs must be unique bounded strings"),
                )
            const shardIds = assignment(current.shardIds, totalShards)
            if (!shardIds)
                return Effect.fail(
                    new ConfigurationError("shardIds", "Supervisor shard IDs must be unique non-empty values in range"),
                )
            for (const shardId of shardIds) {
                if (seenShards.has(shardId))
                    return Effect.fail(new ConfigurationError("shardIds", "Supervisor shard IDs must not overlap"))
                seenShards.add(shardId)
            }
            seenIds.add(current.id)
            children.push(
                Object.freeze({
                    id: current.id,
                    assignment: Object.freeze({ totalShards, shardIds: Object.freeze([...shardIds]) }),
                }),
            )
        }
        const restart = options.restart
        let restartConfiguration: RestartConfiguration | undefined
        if (restart !== undefined) {
            if (!record(restart) || !hasOnlyKeys(restart, ["maxAttempts", "minDelayMs", "maxDelayMs"]))
                return Effect.fail(
                    new ConfigurationError("restart", "Restart settings must contain only supported options"),
                )
            const maxAttempts = restart.maxAttempts === undefined ? 3 : restart.maxAttempts
            const minDelayMs = restart.minDelayMs === undefined ? 1_000 : restart.minDelayMs
            const maxDelayMs = restart.maxDelayMs === undefined ? 30_000 : restart.maxDelayMs
            if (!safeInteger(maxAttempts) || maxAttempts < 0 || maxAttempts > maximumAttempts)
                return Effect.fail(
                    new ConfigurationError(
                        "maxAttempts",
                        `maxAttempts must be an integer from 0 through ${maximumAttempts}`,
                    ),
                )
            if (!positiveTimer(minDelayMs) || !positiveTimer(maxDelayMs) || minDelayMs > maxDelayMs)
                return Effect.fail(
                    new ConfigurationError("restart", "Restart delays must be ordered timer-safe positive integers"),
                )
            restartConfiguration = Object.freeze({ maxAttempts, minDelayMs, maxDelayMs })
        }
        const identify = options.identify
        if (identify !== undefined && (!record(identify) || !hasOnlyKeys(identify, ["minimumSpacingMs"])))
            return Effect.fail(
                new ConfigurationError("identify", "Identify settings must contain only minimumSpacingMs"),
            )
        const minimumSpacingMs = identify?.minimumSpacingMs === undefined ? 1_000 : identify.minimumSpacingMs
        if (!positiveTimer(minimumSpacingMs) || minimumSpacingMs < 1_000)
            return Effect.fail(
                new ConfigurationError(
                    "minimumSpacingMs",
                    "Identify spacing must be a timer-safe integer of at least 1,000 ms",
                ),
            )
        const startupTimeoutMs =
            options.startupTimeoutMs === undefined ? defaultStartupTimeoutMs : options.startupTimeoutMs
        if (!positiveTimer(startupTimeoutMs))
            return Effect.fail(
                new ConfigurationError("startupTimeoutMs", "startupTimeoutMs must be a positive timer-safe integer"),
            )
        const shutdownTimeoutMs =
            options.shutdownTimeoutMs === undefined ? defaultShutdownTimeoutMs : options.shutdownTimeoutMs
        if (!positiveTimer(shutdownTimeoutMs))
            return Effect.fail(
                new ConfigurationError("shutdownTimeoutMs", "shutdownTimeoutMs must be a positive timer-safe integer"),
            )
        const childEnvironmentOverrides = childEnvironment(options.childEnvironment)
        if (childEnvironmentOverrides instanceof ConfigurationError) return Effect.fail(childEnvironmentOverrides)
        const environment = new Map<string, string>()
        for (const [key, value] of Object.entries(process.env)) {
            if (typeof value === "string") environment.set(key, value)
        }
        for (const [key, value] of childEnvironmentOverrides) environment.set(key, value)
        const args = options.args === undefined ? Object.freeze([]) : stringArray(options.args, "args")
        if (args instanceof ConfigurationError) return Effect.fail(args)
        const execArgvInput = options.execArgv === undefined ? process.execArgv : options.execArgv
        const execArgv = stringArray(execArgvInput, "execArgv")
        if (execArgv instanceof ConfigurationError) return Effect.fail(execArgv)
        return Effect.succeed(
            Object.freeze({
                entry,
                totalShards,
                children: Object.freeze(children),
                restart: restartConfiguration,
                minimumSpacingMs,
                startupTimeoutMs,
                shutdownTimeoutMs,
                environment: Object.freeze([...environment].map((entry) => Object.freeze(entry))),
                args,
                execArgv: Object.freeze(filteredExecArguments(execArgv)),
            }),
        )
    })
}

/** Owns only processes forked from one local supervisor instance */
export class SupervisorOwner {
    readonly #slots: ChildSlot[]
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

    constructor(configuration: SupervisorConfiguration) {
        this.#configuration = configuration
        this.#slots = configuration.children.map((configuration) => ({
            configuration,
            generation: 0,
            restarts: 0,
            child: undefined,
            hello: false,
            ready: false,
            connectionState: null,
            state: "idle",
            restartTimer: undefined,
            startupTimer: undefined,
            stopTimer: undefined,
            disconnectTimer: undefined,
        }))
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
            if (this.#slots.every((slot) => slot.connectionState === "Connected")) return Effect.void
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

    #beginStart() {
        if (this.#state === "idle") {
            this.#state = "starting"
            for (const slot of this.#slots) {
                this.#spawn(slot)
                if (this.#failed) break
            }
        }
    }

    #spawn(slot: ChildSlot) {
        if (this.#stopping || this.#failed) return
        this.#clearDisconnectTimer(slot)
        slot.generation += 1
        slot.hello = false
        slot.ready = false
        slot.connectionState = null
        slot.state = "starting"
        let child: ChildProcess
        try {
            child = fork(this.#configuration!.entry, [...this.#configuration!.args], {
                env: Object.fromEntries(this.#configuration!.environment),
                execArgv: [...this.#configuration!.execArgv],
                stdio: ["ignore", "ignore", "ignore", "ipc"],
                windowsHide: true,
            } as unknown as Parameters<typeof fork>[2])
        } catch {
            slot.state = "failed"
            this.#fail(new SupervisorError(slot.configuration.id, "spawn"))
            return
        }
        slot.child = child
        const generation = slot.generation
        slot.startupTimer = setTimeout(() => {
            if (slot.child === child && slot.generation === generation && !slot.ready)
                this.#fail(new SupervisorError(slot.configuration.id, "startupTimeout"))
        }, this.#configuration!.startupTimeoutMs)
        child.on("message", (message: unknown) => this.#message(slot, child, generation, message))
        child.once("disconnect", () => this.#disconnect(slot, child, generation))
        child.once("error", () => this.#childError(slot, child, generation))
        child.once("exit", () => this.#exit(slot, child, generation))
    }

    #childError(slot: ChildSlot, child: ChildProcess, generation: number) {
        if (slot.child !== child || slot.generation !== generation) return
        slot.state = "failed"
        this.#fail(new SupervisorError(slot.configuration.id, "spawn"))
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
        if (this.#outstanding?.slot === slot && this.#outstanding.generation === generation)
            clearTimeout(this.#outstanding.timer)
        // A normal process exit closes IPC just before its exit event. Reuse the configured graceful deadline
        // before classifying a still-running current child as a terminal supervisor failure
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
            this.#fail(new SupervisorError(slot.configuration.id, "closed"))
            this.#requestStop(slot, true)
        }, this.#configuration!.shutdownTimeoutMs)
    }

    #message(slot: ChildSlot, child: ChildProcess, generation: number, message: unknown) {
        if (this.#stopping || this.#failed || slot.child !== child || slot.generation !== generation) return
        if (slot.disconnectTimer) return
        if (!record(message) || typeof message.type !== "string")
            return this.#fail(new SupervisorError(slot.configuration.id, "protocol"))
        if ("generation" in message && message.generation !== generation) return
        if (message.type === "hello") {
            if (!hasExactKeys(message, ["type"]) || slot.hello)
                return this.#fail(new SupervisorError(slot.configuration.id, "protocol"))
            slot.hello = true
            this.#send(slot, { type: "assignment", generation, assignment: slot.configuration.assignment })
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
            this.#outstanding.requestId === message.requestId
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
            if (message.type === "failed" && message.reason !== "client" && message.reason !== "configure")
                return this.#fail(new SupervisorError(slot.configuration.id, "protocol"))
            this.#requestStop(slot)
            return
        }
        this.#fail(new SupervisorError(slot.configuration.id, "protocol"))
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
        const ready = this.#slots.every((slot) => slot.connectionState === "Connected")
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
            const timer = setTimeout(() => {
                if (
                    this.#outstanding?.slot === request.slot &&
                    this.#outstanding.generation === request.generation &&
                    this.#outstanding.requestId === request.requestId
                ) {
                    this.#outstanding.stalled = true
                    this.#requestStop(request.slot)
                }
            }, grantAcknowledgementMs)
            this.#outstanding = { ...request, timer, stalled: false }
            if (
                !this.#send(request.slot, {
                    type: "grant",
                    generation: request.generation,
                    requestId: request.requestId,
                })
            )
                this.#requestStop(request.slot)
            return
        }
    }

    #clearOutstanding() {
        if (!this.#outstanding) return
        clearTimeout(this.#outstanding.timer)
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
                    this.#childError(slot, child, slot.generation)
            })
            return true
        } catch {
            if ((this.#stopping && !child.connected) || slot.disconnectTimer) return false
            this.#childError(slot, child, slot.generation)
            return false
        }
    }

    #exit(slot: ChildSlot, child: ChildProcess, generation: number) {
        if (slot.child !== child || slot.generation !== generation) return
        slot.child = undefined
        slot.connectionState = null
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
        if (this.#stopping || this.#failed) {
            slot.state = this.#failed ? "failed" : "closed"
            this.#checkStopped()
            return
        }
        const restart = this.#configuration!.restart
        if (!restart) {
            slot.state = "failed"
            this.#fail(new SupervisorError(slot.configuration.id, "closed"))
            return
        }
        if (slot.restarts >= restart.maxAttempts) {
            slot.state = "failed"
            this.#fail(new SupervisorError(slot.configuration.id, "restartLimit"))
            return
        }
        slot.restarts += 1
        slot.state = "restarting"
        const delay = Math.min(restart.maxDelayMs, restart.minDelayMs * 2 ** (slot.restarts - 1))
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
            } catch {
                this.#childError(slot, child, slot.generation)
            }
            return
        }
        if (slot.stopTimer) return
        slot.state = "stopping"
        const generation = slot.generation
        slot.stopTimer = setTimeout(() => {
            if (slot.child !== child || slot.generation !== generation) return
            try {
                // Only this exact ChildProcess is force-terminated. Completion still waits for its exit event
                child.kill("SIGKILL")
            } catch {
                this.#childError(slot, child, generation)
            }
        }, this.#configuration!.shutdownTimeoutMs)
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
        if (this.#outstanding) clearTimeout(this.#outstanding.timer)
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
        if (this.#slots.some((slot) => slot.child !== undefined)) return
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

interface PendingPermit {
    readonly send: () => void
    readonly resume: (effect: Effect.Effect<void, ConnectionError>) => void
}

/** Child-side IPC bridge. It owns no process signals and reports no child output */
export class ChildBridge {
    readonly #assignment = Deferred.makeUnsafe<SupervisorAssignment, SupervisorChildError>()
    readonly #stop = Deferred.makeUnsafe<void, SupervisorChildError>()
    readonly #pending = new Map<number, PendingPermit>()
    readonly #cancelled = new Set<number>()
    #generation: number | undefined
    #nextRequestId = 0
    #stopping = false
    #ended = false
    #cleaned = false
    readonly #abort = new AbortController()

    readonly signal: OperationSignal = this.#abort.signal

    readonly identifyGate: IdentifyGate = {
        permit: (shardId, send) => this.#permit(shardId, send),
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

    failed(reason: "client" | "configure") {
        if (!this.#ended && this.#generation !== undefined)
            this.#send({ type: "failed", generation: this.#generation, reason })
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
                resume(Effect.fail(new ConnectionError("gateway", "closed")))
                return
            }
            bridge.#pending.set(requestId, { send, resume })
            if (!bridge.#send({ type: "identify", generation, requestId, shardId })) {
                bridge.#pending.delete(requestId)
                resume(Effect.fail(new ConnectionError("gateway", "closed")))
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

    #message(message: unknown) {
        if (this.#ended) return
        if (!record(message) || typeof message.type !== "string") return this.#protocol()
        if (
            message.type === "assignment" &&
            hasExactKeys(message, ["type", "generation", "assignment"]) &&
            safeInteger(message.generation) &&
            message.generation > 0 &&
            record(message.assignment) &&
            hasExactKeys(message.assignment, ["totalShards", "shardIds"]) &&
            safeInteger(message.assignment.totalShards) &&
            message.assignment.totalShards > 0
        ) {
            if (this.#generation !== undefined) return this.#protocol()
            const shardIds = assignment(message.assignment.shardIds, message.assignment.totalShards)
            if (!shardIds) return this.#protocol()
            this.#generation = message.generation
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
                        catch: () => new ConnectionError("gateway", "closed"),
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
        process.off("message", this.onMessage)
        process.off("disconnect", this.onDisconnect)
        for (const [requestId, pending] of this.#pending) {
            if (notifyCancellation && this.#generation !== undefined)
                this.#send({ type: "cancel", generation: this.#generation, requestId })
            pending.resume(Effect.fail(new ConnectionError("gateway", "closed")))
        }
        this.#pending.clear()
        this.#cancelled.clear()
    }

    #send(message: object): boolean {
        try {
            if (!process.connected || typeof process.send !== "function") return false
            process.send(message, undefined, undefined, (error) => {
                if (error) this.#disconnect()
            })
            return true
        } catch {
            return false
        }
    }
}

export function createSupervisor(options: SupervisorOptions): Effect.Effect<SupervisorOwner, ConfigurationError> {
    return validateSupervisorConfiguration(options).pipe(
        Effect.map((configuration) => new SupervisorOwner(configuration)),
    )
}
