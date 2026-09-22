import { Cause, Deferred, Effect, Exit, Fiber, type Scope } from "effect"
import {
    createClient,
    type Client,
    type ClientOptions,
    type ConfigurationError,
    type ConnectError,
    type EventOverflowError,
    type MessageCore,
    type MessageFields,
    type SelectedMessage,
    type Subscription,
} from "@neontechspace/fluxerly/effect"

export class CriticalWorkerStoppedError extends Error {
    readonly _tag = "CriticalWorkerStoppedError"
    readonly workerIndex: number

    constructor(workerIndex: number) {
        super(`Critical worker ${workerIndex + 1} stopped before the bot`)
        this.name = "CriticalWorkerStoppedError"
        this.workerIndex = workerIndex
    }
}

interface StopSignals {
    readonly requested: () => boolean
    readonly wait: Effect.Effect<void>
}

function stopSignals(signal?: AbortSignal): Effect.Effect<StopSignals, never, Scope.Scope> {
    return Effect.acquireRelease(
        Effect.sync(() => {
            const stopped = Deferred.makeUnsafe<void>()
            let requested = signal?.aborted ?? false
            const stop = () => {
                requested = true
                Deferred.doneUnsafe(stopped, Effect.void)
            }
            const onSignal = () => stop()
            process.once("SIGINT", onSignal)
            process.once("SIGTERM", onSignal)
            signal?.addEventListener("abort", stop, { once: true })
            if (requested) stop()
            return {
                value: Object.freeze({ requested: () => requested, wait: Deferred.await(stopped) }),
                release: () => {
                    signal?.removeEventListener("abort", stop)
                    process.removeListener("SIGINT", onSignal)
                    process.removeListener("SIGTERM", onSignal)
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

function superviseWithSignals<M extends MessageCore>(
    client: Client<M>,
    workers: readonly Subscription[],
    stop: StopSignals,
): Effect.Effect<void, ConnectError | EventOverflowError | CriticalWorkerStoppedError, Scope.Scope> {
    return Effect.gen(function* () {
        const tasks = [client.run(), ...workers.map((worker) => worker.waitForClose())]
        const fibers = yield* Effect.all(tasks.map((task) => Effect.forkScoped(task)))
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
        const shutdown = yield* Effect.exit(client.shutdown())
        const outcomes = yield* Fiber.awaitAll(fibers)
        return yield* combine([...outcomes, shutdown, ...(unexpected ? [unexpected] : [])])
    })
}

/** Supervise one native client run and every critical subscription inside the caller's scope */
export function supervise<M extends MessageCore>(
    client: Client<M>,
    workers: readonly Subscription[],
    signal?: AbortSignal,
): Effect.Effect<void, ConnectError | EventOverflowError | CriticalWorkerStoppedError, Scope.Scope> {
    return stopSignals(signal).pipe(Effect.flatMap((stop) => superviseWithSignals(client, workers, stop)))
}

/**
 * Create and supervise a native bot without installing a separate Effect runtime
 * Only returned subscriptions are supervised. No worker is restarted and unreturned effects remain application-owned
 */
export function runBot<
    OptionsError = never,
    OptionsServices = never,
    InstallError = never,
    InstallServices = never,
    const F extends MessageFields | undefined = undefined,
>(
    options: ClientOptions<OptionsError, OptionsServices, F>,
    install: (
        client: Client<SelectedMessage<F>>,
    ) => Effect.Effect<readonly Subscription[], InstallError, InstallServices | Scope.Scope>,
    signal?: AbortSignal,
): Effect.Effect<
    void,
    ConfigurationError | ConnectError | EventOverflowError | CriticalWorkerStoppedError | InstallError,
    OptionsServices | Exclude<InstallServices, Scope.Scope>
> {
    return Effect.suspend(() => {
        if (signal?.aborted) return Effect.void
        return Effect.scoped(
            Effect.gen(function* () {
                const stop = yield* stopSignals(signal)
                const client = yield* createClient(options)
                const installation = yield* Effect.forkScoped(install(client))
                const first = yield* Effect.raceFirst(
                    Fiber.await(installation).pipe(Effect.map((exit) => ({ kind: "installed" as const, exit }))),
                    stop.wait.pipe(Effect.as({ kind: "stop" as const })),
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
                return yield* superviseWithSignals(client, first.exit.value, stop)
            }),
        )
    }) as Effect.Effect<
        void,
        ConfigurationError | ConnectError | EventOverflowError | CriticalWorkerStoppedError | InstallError,
        OptionsServices | Exclude<InstallServices, Scope.Scope>
    >
}
