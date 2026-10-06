/**
 * Bot runner core shared by both entry points: Event-handler snapshots, the client lifetime and optional signal handling.
 * Invariant: SIGINT and SIGTERM are handled only when the runner receives processSignals: true, which the default entry
 * point passes unless the application sets false and the native entry point passes only when the application sets true.
 * The listeners are removed after awaited cleanup, and the runner never terminates the consumer process. A requested stop drains running work for drainMs before
 * the usual shutdown, while every other end shuts down at once. A failed run only sets process.exitCode, unless reportFailure is false. Implements [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Scope from "effect/Scope"
import { CriticalWorkerStoppedError, type RunBotOptions } from "#sdk/bot-runner"
import type { ShutdownOptions } from "#sdk/client"
import { ClientClosedError, ConfigurationError } from "#sdk/errors"
import type { EventName } from "#sdk/events"
import type { MessageCore } from "#sdk/messages"
import { readCaller, readInput, suspendMarked } from "./defects.js"
import { operationSignalError } from "./operation-signal.js"
import { clientServices } from "./client-registry.js"
import { ClientLogger, loggingConfiguration } from "./logging.js"
import { missingTokenMessage, normalizeToken, validateConfiguration } from "./configuration.js"
import { unsupportedKeyHint } from "./suggest.js"
import { EventBus } from "./events.js"
import { shutdownDrainMs } from "./client/drain.js"

/** Default delivery for runBot event handlers. Overflow drops the oldest waiting event rather than stopping the bot,
 * and messageCreate handlers and partitioned handlers run up to eight at a time
 */
function botHandlerDefaults(event: EventName, partitioned = false): { concurrency: number; overflow: "dropOldest" } {
    return { concurrency: event === "messageCreate" || partitioned ? 8 : 1, overflow: "dropOldest" }
}

const handlerOptionKeys = [
    "handler",
    "concurrency",
    "partition",
    "overflow",
    "maxPendingMessages",
    "maxPendingBytes",
    "onError",
]

/** Check one event name and its delivery settings with the event bus's own rules, on a detached bus that no client
 * owns. Opening and immediately stopping a subscription there has no side effects, so the names, suggestions and bounds
 * stay identical to client.on without keeping a second list of event names
 */
function validateBotEvent(event: string, options: Readonly<Record<string, unknown>>, bus: EventBus) {
    const { onError, ...delivery } = options
    const opened = Effect.runSyncExit(bus.open(event as EventName, delivery))
    if (Exit.isFailure(opened)) {
        const reason = opened.cause.reasons.find((reason) => reason._tag === "Fail")
        if (reason?._tag === "Fail" && reason.error instanceof ConfigurationError) throw reason.error
        throw Cause.squash(opened.cause)
    }
    opened.value.stop()
    if (onError !== undefined && typeof onError !== "function")
        throw new ConfigurationError(
            "onError",
            `The onError setting of the ${JSON.stringify(event)} handler must be a function`,
        )
}

/** Read each configured handler once before any client exists, throwing ConfigurationError for a malformed entry,
 * an unknown event name or invalid delivery settings. An omitted events object registers nothing
 */
export function snapshotBotEvents(
    events: unknown,
): readonly { event: EventName; handler: unknown; options: Readonly<Record<string, unknown>> }[] {
    if (events === undefined) return []
    if (typeof events !== "object" || events === null || Array.isArray(events))
        throw new ConfigurationError(
            "configuration",
            'The option "events" must be an object that maps event names to handlers',
        )
    const bus = new EventBus()
    const entries: { event: EventName; handler: unknown; options: Readonly<Record<string, unknown>> }[] = []
    for (const [event, entry] of Object.entries(events)) {
        if (entry === undefined) continue
        if (typeof entry === "function") {
            const options = botHandlerDefaults(event as EventName)
            validateBotEvent(event, options, bus)
            entries.push({ event: event as EventName, handler: entry, options })
            continue
        }
        if (typeof entry !== "object" || entry === null || Array.isArray(entry))
            throw new ConfigurationError(
                "handler",
                `The ${JSON.stringify(event)} entry in events must be a function or an object with a handler`,
            )
        const unknown = Object.keys(entry).find((key) => !handlerOptionKeys.includes(key))
        if (unknown !== undefined)
            throw new ConfigurationError(
                "eventOptions",
                `Unsupported setting ${JSON.stringify(unknown)} for the ${JSON.stringify(event)} handler`,
                { hint: unsupportedKeyHint(unknown, handlerOptionKeys, "settings") },
            )
        const { handler, ...options } = entry as Record<string, unknown>
        if (typeof handler !== "function")
            throw new ConfigurationError("handler", `The ${JSON.stringify(event)} handler must be a function`)
        const settings = Object.freeze({
            ...botHandlerDefaults(event as EventName, options.partition !== undefined),
            ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
        })
        validateBotEvent(event, settings, bus)
        entries.push({ event: event as EventName, handler, options: settings })
    }
    return entries
}

/** Read the runBot ignoreBots setting, true unless it is false. Any value other than a boolean is misuse */
export function readIgnoreBots(ignoreBots: unknown): boolean {
    if (ignoreBots !== undefined && typeof ignoreBots !== "boolean")
        throw new ConfigurationError("configuration", 'The option "ignoreBots" must be true or false')
    return ignoreBots !== false
}

/** Whether a runBot handler skips this event: A messageCreate or messageUpdate whose author is a bot, while ignoreBots is on */
export function skipsBotMessage(event: EventName, payload: unknown, ignoreBots: boolean): boolean {
    return (
        ignoreBots &&
        (event === "messageCreate" || event === "messageUpdate") &&
        (payload as MessageCore).author.isBot === true
    )
}

/** The runBot option keys that are not client options. Each entry point removes them before validating the client options,
 * and the unknown-key hint lists them with the client keys
 */
export const botOptionKeys = [
    "events",
    "ignoreBots",
    "commands",
    "setup",
    "signal",
    "processSignals",
    "reportFailure",
    "drainMs",
] as const

/** How long a requested stop lets running work finish by default, within the 10 seconds Docker and similar tools wait */
const defaultBotDrainMs = 5_000

/** Check the client settings with createClient's rules before the runner adds signal listeners or creates a client.
 * Validation reads the settings without creating a logger, cache, socket or request. Misuse throws ConfigurationError,
 * including for an option key that neither runBot nor createClient supports.
 * A missing or empty token is returned instead, without a stack, once every other setting is valid, so runBot can
 * report it like a failed run
 */
export function validateBotClientOptions(options: unknown, native: boolean): ConfigurationError | undefined {
    const failure = clientOptionsFailure(options, native)
    if (failure === undefined) return undefined
    if (
        !(failure instanceof ConfigurationError) ||
        failure.field !== "token" ||
        failure.message !== missingTokenMessage
    )
        throw failure
    // Settings checked after the token, such as the cache, are checked again with a stand-in token
    const other = clientOptionsFailure({ ...(options as object), token: "stand-in" }, native)
    if (other !== undefined) throw other
    failure.stack = `${failure.name}: ${failure.message}`
    return failure
}

function clientOptionsFailure(options: unknown, native: boolean): unknown {
    const validated = Effect.runSyncExit(validateConfiguration(options, native, botOptionKeys))
    if (Exit.isSuccess(validated)) return undefined
    const reason = validated.cause.reasons.find((reason) => reason._tag === "Fail")
    return reason?._tag === "Fail" ? reason.error : Cause.squash(validated.cause)
}

/** Validate the runner settings before any client exists. Invalid settings are misuse and throw ConfigurationError */
export function validateRunOptions(options: unknown): asserts options is RunBotOptions {
    if (typeof options !== "object" || options === null || Array.isArray(options))
        throw new ConfigurationError("configuration", "The runBot options must be an object")
    const { signal, processSignals, reportFailure, drainMs } = options as RunBotOptions
    const signalError = operationSignalError(signal)
    if (signalError) throw signalError
    if (processSignals !== undefined && typeof processSignals !== "boolean")
        throw new ConfigurationError("configuration", 'The option "processSignals" must be true or false')
    if (reportFailure !== undefined && typeof reportFailure !== "boolean")
        throw new ConfigurationError("configuration", 'The option "reportFailure" must be true or false')
    const drain = shutdownDrainMs({ drainMs })
    if (drain instanceof ConfigurationError) throw drain
}

/**
 * Report a finished run's failure once, unless the caller opted out: Log its primary error at Error, unless this logger
 * already showed that error, and set process.exitCode to 1. The run's outcome is unchanged.
 * Interruption reports nothing. The default API returns defects by rejecting, which Node reports itself, so only a
 * native run reports a defect here
 */
export function reportBotFailure(
    exit: Exit.Exit<unknown, unknown>,
    logger: ClientLogger | undefined,
    options: RunBotOptions,
): Effect.Effect<void> {
    return Effect.suspend(() => {
        if (options.reportFailure === false || Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause))
            return Effect.void
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
        const defect = exit.cause.reasons.find((reason) => reason._tag === "Die")
        const reported =
            failure?._tag === "Fail"
                ? failure.error
                : defect?._tag === "Die" && logger?.native
                  ? defect.defect
                  : undefined
        if (reported === undefined) return Effect.void
        process.exitCode = 1
        if (logger === undefined || logger.loggedError(reported)) return Effect.void
        return logger.logEffect({
            level: "error",
            category: "lifecycle",
            code: "lifecycle.botFailed",
            message: "The bot stopped because of an error, and the process exit code is set to 1",
            error: reported,
            ...(logger.native ? { cause: exit.cause } : {}),
        })
    })
}

/**
 * A logger for a run that failed before its client existed, built from the client logging settings. Settings that
 * cannot be used, which may be the misuse being reported, fall back to the default logging, so the failure is still shown
 */
export function standaloneBotLogger(clientOptions: Readonly<Record<string, unknown>>, native: boolean): ClientLogger {
    let logger: ClientLogger | ConfigurationError | undefined
    try {
        logger = loggingConfiguration(clientOptions.logging, native)
    } catch {
        // allow-silent: A throwing logging getter is itself the misuse the caller reports through the default logger below
    }
    if (!(logger instanceof ClientLogger)) logger = loggingConfiguration(undefined, native) as ClientLogger
    const token = normalizeToken(clientOptions.token)
    if (typeof token === "string") logger.addSecret(token)
    return logger
}

interface RunnerClient<E> {
    readonly state: string
    /** The client logger, used for stop-request records */
    readonly logger?: ClientLogger | undefined
    run(): Effect.Effect<void, E>
    shutdown(options?: ShutdownOptions): Effect.Effect<void>
}

interface RunnerWorker<E> {
    waitForClose(): Effect.Effect<void, E>
}

interface StopSignals {
    readonly requested: () => boolean
    readonly wait: Effect.Effect<void>
    /** Record later stop requests in this client's log */
    readonly attach: (logger: ClientLogger | undefined) => void
}

/**
 * Register the stop sources. The caller signal's aborted getter and listener methods are application input, so their
 * throws are marked as application faults. Its listener is added before the process listeners and removed after them,
 * so a throw from either method never leaves SIGINT or SIGTERM listeners installed
 */
function stopSignals(options: RunBotOptions): Effect.Effect<StopSignals, never, Scope.Scope> {
    return Effect.acquireRelease(
        suspendMarked(() => {
            const stopped = Deferred.makeUnsafe<void>()
            let requested = readCaller(() => options.signal?.aborted) ?? false
            let logger: ClientLogger | undefined
            const stop = (source?: unknown) => {
                if (!requested || typeof source === "string")
                    logger?.log({
                        level: "info",
                        category: "lifecycle",
                        code: "lifecycle.stopRequested",
                        message:
                            typeof source === "string"
                                ? `Received ${source}, so the bot is shutting down`
                                : "The signal passed to runBot was aborted, so the bot is shutting down",
                        ...(typeof source === "string" ? { fields: { signal: source } } : {}),
                    })
                requested = true
                Deferred.doneUnsafe(stopped, Effect.void)
            }
            const abort = () => stop()
            readCaller(() => options.signal?.addEventListener("abort", abort, { once: true }))
            if (options.processSignals === true) {
                process.once("SIGINT", stop)
                process.once("SIGTERM", stop)
            }
            if (requested) stop()
            return Effect.succeed({
                value: Object.freeze({
                    requested: () => requested,
                    wait: Deferred.await(stopped),
                    attach: (value: ClientLogger | undefined) => {
                        logger = value
                    },
                }),
                release: () =>
                    Effect.suspend(() => {
                        if (options.processSignals === true) {
                            process.removeListener("SIGINT", stop)
                            process.removeListener("SIGTERM", stop)
                        }
                        return readInput(() => options.signal?.removeEventListener("abort", abort))
                    }),
            })
        }),
        ({ release }) => release(),
    ).pipe(Effect.map(({ value }) => value))
}

type ExitError<T> = T extends Exit.Exit<unknown, infer E> ? E : never

function combine<const Exits extends readonly Exit.Exit<unknown, unknown>[]>(
    exits: Exits,
): Effect.Effect<void, ExitError<Exits[number]>> {
    const combined = Exit.asVoidAll(exits)
    return (Exit.isFailure(combined) ? Effect.failCause(combined.cause) : Effect.void) as Effect.Effect<
        void,
        ExitError<Exits[number]>
    >
}

function supervise<RunError, WorkerError>(
    client: RunnerClient<RunError>,
    workers: readonly RunnerWorker<WorkerError>[],
    stop: StopSignals,
    drainMs: number,
): Effect.Effect<void, RunError | WorkerError | CriticalWorkerStoppedError, Scope.Scope> {
    return Effect.gen(function* () {
        const runFiber = yield* Effect.forkScoped(client.run(), { startImmediately: true })
        const workerFibers = yield* Effect.all(workers.map((worker) => Effect.forkScoped(worker.waitForClose())))
        const fibers: Fiber.Fiber<void, RunError | WorkerError>[] = [runFiber, ...workerFibers]
        return yield* Effect.gen(function* () {
            const first = yield* Effect.raceAllFirst([
                stop.wait.pipe(Effect.as({ kind: "stop" as const })),
                ...fibers.map((fiber, index) =>
                    Fiber.await(fiber).pipe(Effect.map((exit) => ({ kind: "task" as const, index, exit }))),
                ),
            ])
            let unexpected: Exit.Exit<void, CriticalWorkerStoppedError> | undefined
            if (
                first.kind === "task" &&
                first.index > 0 &&
                Exit.isSuccess(first.exit) &&
                !stop.requested() &&
                client.state !== "Closing" &&
                client.state !== "Closed"
            )
                unexpected = Exit.fail(new CriticalWorkerStoppedError(first.index - 1))
            const runnerCanCloseRun =
                fibers[0]!.pollUnsafe() === undefined && client.state !== "Closing" && client.state !== "Closed"
            // A requested stop drains running work first. The drained shutdown then ends the run itself, while any
            // other end, such as a failed subscription, stops at once
            const drain = first.kind === "stop" ? drainMs : 0
            if (runnerCanCloseRun && drain === 0) yield* Fiber.interrupt(runFiber)
            const shutdown = yield* Effect.exit(client.shutdown(drain === 0 ? undefined : { drainMs: drain }))
            const outcomes = yield* Fiber.awaitAll(fibers)
            const run = outcomes[0]!
            const reason = Exit.isFailure(run) && run.cause.reasons.length === 1 ? run.cause.reasons[0] : undefined
            const expectedClosure =
                runnerCanCloseRun && reason?._tag === "Fail" && reason.error instanceof ClientClosedError
            const expectedInterruption = runnerCanCloseRun && Exit.isFailure(run) && Cause.hasInterruptsOnly(run.cause)
            const normalizedRun = expectedClosure || expectedInterruption ? Exit.void : run
            return yield* combine([normalizedRun, ...outcomes.slice(1), shutdown, ...(unexpected ? [unexpected] : [])])
        }).pipe(
            Effect.onInterrupt(() =>
                Effect.gen(function* () {
                    const outcomes = yield* Effect.all(
                        fibers.map((fiber) => Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))),
                    )
                    const shutdown = yield* Effect.exit(client.shutdown())
                    // Interruption already belongs to the parent cause, so retain only additional child failures and defects
                    const retained = outcomes.filter((outcome) =>
                        Exit.isFailure(outcome) ? !Cause.hasInterruptsOnly(outcome.cause) : false,
                    )
                    return yield* combine([...retained, shutdown])
                }),
            ),
        ) as Effect.Effect<void, RunError | WorkerError | CriticalWorkerStoppedError>
    })
}

/** One lifetime algorithm for the default Result adapter and the native Effect entry point. A failure before the client
 * exists is reported through fallbackLogger, when given
 */
export function runBotCore<
    C extends RunnerClient<RunError>,
    W extends RunnerWorker<WorkerError>,
    CreateError,
    InstallError,
    RunError,
    WorkerError,
    CreateServices,
    InstallServices,
>(
    create: Effect.Effect<C, CreateError, CreateServices | Scope.Scope>,
    install: (client: C) => Effect.Effect<readonly W[], InstallError, InstallServices | Scope.Scope>,
    options: RunBotOptions,
    fallbackLogger?: () => ClientLogger,
): Effect.Effect<
    void,
    ConfigurationError | CreateError | InstallError | RunError | WorkerError | CriticalWorkerStoppedError,
    Exclude<CreateServices | InstallServices, Scope.Scope>
> {
    return suspendMarked(() => {
        if (readCaller(() => options.signal?.aborted)) return Effect.void
        let logger: ClientLogger | undefined
        return Effect.scoped(
            Effect.gen(function* () {
                const stop = yield* stopSignals(options)
                const client = yield* create
                logger = client.logger ?? clientServices(client)?.logging
                stop.attach(logger)
                yield* Effect.addFinalizer(() => client.shutdown())
                const installation = yield* Effect.forkScoped(install(client))
                const first = yield* Effect.raceFirst(
                    Fiber.await(installation).pipe(Effect.map((exit) => ({ kind: "installed" as const, exit }))),
                    stop.wait.pipe(Effect.as({ kind: "stop" as const })),
                ).pipe(
                    Effect.onInterrupt(() =>
                        Effect.gen(function* () {
                            yield* Fiber.interrupt(installation)
                            const installed = yield* Fiber.await(installation)
                            const shutdown = yield* Effect.exit(client.shutdown())
                            const retained =
                                Exit.isFailure(installed) && !Cause.hasInterruptsOnly(installed.cause)
                                    ? installed
                                    : Exit.void
                            return yield* combine([retained, shutdown])
                        }),
                    ),
                )
                if (first.kind === "stop") {
                    yield* Fiber.interrupt(installation)
                    const installed = yield* Fiber.await(installation)
                    const shutdown = yield* Effect.exit(client.shutdown())
                    if (Exit.isFailure(installed) && Cause.hasInterruptsOnly(installed.cause))
                        return yield* combine([shutdown])
                    return yield* combine([installed, shutdown])
                }
                if (Exit.isFailure(first.exit)) {
                    const shutdown = yield* Effect.exit(client.shutdown())
                    return yield* combine([first.exit, shutdown])
                }
                return yield* supervise(client, first.exit.value, stop, options.drainMs ?? defaultBotDrainMs)
            }),
        ).pipe(Effect.onExit((exit) => reportBotFailure(exit, logger ?? fallbackLogger?.(), options))) as Effect.Effect<
            void,
            ConfigurationError | CreateError | InstallError | RunError | WorkerError | CriticalWorkerStoppedError,
            Exclude<CreateServices | InstallServices, Scope.Scope>
        >
    }) as Effect.Effect<
        void,
        ConfigurationError | CreateError | InstallError | RunError | WorkerError | CriticalWorkerStoppedError,
        Exclude<CreateServices | InstallServices, Scope.Scope>
    >
}
