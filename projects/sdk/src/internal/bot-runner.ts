import { Cause, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { CriticalWorkerStoppedError, type RunBotOptions } from "#sdk/bot-runner"
import { ClientClosedError, ConfigurationError } from "#sdk/errors"
import { operationSignalError } from "./operation-signal.js"

interface RunnerClient<E> {
    readonly state: string
    run(): Effect.Effect<void, E>
    shutdown(): Effect.Effect<void>
}

interface RunnerWorker<E> {
    waitForClose(): Effect.Effect<void, E>
}

interface StopSignals {
    readonly requested: () => boolean
    readonly wait: Effect.Effect<void>
}

function stopSignals(options: RunBotOptions): Effect.Effect<StopSignals, never, Scope.Scope> {
    return Effect.acquireRelease(
        Effect.sync(() => {
            const stopped = Deferred.makeUnsafe<void>()
            let requested = options.signal?.aborted ?? false
            const stop = () => {
                requested = true
                Deferred.doneUnsafe(stopped, Effect.void)
            }
            if (options.processSignals === true) {
                process.once("SIGINT", stop)
                process.once("SIGTERM", stop)
            }
            options.signal?.addEventListener("abort", stop, { once: true })
            if (requested) stop()
            return {
                value: Object.freeze({ requested: () => requested, wait: Deferred.await(stopped) }),
                release: () => {
                    options.signal?.removeEventListener("abort", stop)
                    if (options.processSignals === true) {
                        process.removeListener("SIGINT", stop)
                        process.removeListener("SIGTERM", stop)
                    }
                },
            }
        }),
        ({ release }) => Effect.sync(release),
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
            if (runnerCanCloseRun) yield* Fiber.interrupt(runFiber)
            const shutdown = yield* Effect.exit(client.shutdown())
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

/** One lifetime algorithm for the default Result adapter and the native Effect entry point */
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
): Effect.Effect<
    void,
    ConfigurationError | CreateError | InstallError | RunError | WorkerError | CriticalWorkerStoppedError,
    Exclude<CreateServices | InstallServices, Scope.Scope>
> {
    return Effect.suspend(() => {
        if (typeof options !== "object" || options === null || Array.isArray(options))
            return Effect.fail(new ConfigurationError("configuration", "Bot runner options must be an object"))
        const signalError = operationSignalError(options.signal)
        if (signalError) return Effect.fail(signalError)
        if (options.processSignals !== undefined && typeof options.processSignals !== "boolean")
            return Effect.fail(new ConfigurationError("configuration", "Bot processSignals must be a boolean"))
        if (options.signal?.aborted) return Effect.void
        return Effect.scoped(
            Effect.gen(function* () {
                const stop = yield* stopSignals(options)
                const client = yield* create
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
                return yield* supervise(client, first.exit.value, stop)
            }),
        ) as Effect.Effect<
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
