import { Cause, Clock, Deferred, Effect, Exit, Fiber, Queue, Random, Redacted, Scope, Stream } from "effect"
import type { ClientOptions, ConnectionState } from "#sdk/client"
import {
    ClientBusyError,
    ClientClosedError,
    ConnectionError,
    ConnectionTimeoutError,
    RateLimitError,
    type ConfigurationError,
    type ConnectError,
    type ConnectionFailure,
} from "#sdk/errors"
import { type Configuration, validateConfiguration } from "./configuration.js"
import { discoverGateway } from "./discovery.js"
import { AttemptFailure, runGateway, type Session } from "./gateway.js"

export class ClientOwner {
    #configuration: Configuration | undefined
    #state: ConnectionState = "Disconnected"
    #latency: number | null = null
    #worker: Fiber.Fiber<void> | undefined
    #workerExit: Exit.Exit<never, ConnectionFailure> | undefined
    #terminal = Deferred.makeUnsafe<void, ConnectionFailure>()
    #shutdown = Deferred.makeUnsafe<void>()
    #listeners = new Set<(state: ConnectionState) => void>()
    #session: Session = { id: undefined, sequence: null }
    #managed = false
    #shutdownStarted = false

    constructor(
        configuration: Configuration,
        readonly scope: Scope.Scope,
    ) {
        this.#configuration = configuration
    }
    get state(): ConnectionState {
        return this.#state
    }
    get gatewayLatencyMs(): number | null {
        return this.#latency
    }

    #setState(state: ConnectionState) {
        if (this.#state === state) return
        this.#state = state
        if (state !== "Connected") this.#latency = null
        for (const listener of this.#listeners) listener(state)
        if (state === "Closed") this.#listeners.clear()
    }

    subscribe(listener: (state: ConnectionState) => void) {
        if (this.#state !== "Closed") this.#listeners.add(listener)
        listener(this.#state)
        return () => {
            this.#listeners.delete(listener)
        }
    }

    observeState() {
        const owner = this
        return Stream.unwrap(
            Effect.gen(function* () {
                const queue = yield* Queue.sliding<ConnectionState, Cause.Done>(1)
                let initial: ConnectionState | undefined
                const unsubscribe = owner.subscribe((state) => {
                    if (initial === undefined) initial = state
                    else Queue.offerUnsafe(queue, state)
                    if (state === "Closed") Queue.endUnsafe(queue)
                })
                yield* Effect.addFinalizer(() => Effect.sync(unsubscribe).pipe(Effect.andThen(Queue.shutdown(queue))))
                return Stream.concat(Stream.succeed(initial!), Stream.fromQueue(queue))
            }),
        )
    }

    #finish() {
        if (this.#configuration) Redacted.wipeUnsafe(this.#configuration.token)
        this.#configuration = undefined
        this.#session = { id: undefined, sequence: null }
        this.#setState("Closed")
    }

    #loop(configuration: Configuration, startup: Deferred.Deferred<void, ConnectError>) {
        const owner = this
        return Effect.gen(function* () {
            const clock = yield* Clock.Clock
            const now = () => Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000
            const deadline = now() + configuration.startupTimeoutMs
            let established = false
            let attempts = 0
            let recoveryStep = 0
            let connectedAt: number | undefined
            let disconnectedAt: number | undefined
            let url: string | undefined
            while (true) {
                attempts += 1
                const budget = established ? 30_000 : Math.max(0, deadline - now())
                const attempt = Effect.gen(function* () {
                    const attemptDeadline = now() + budget
                    if (!url) {
                        url = yield* discoverGateway(configuration.token).pipe(
                            Effect.mapError(
                                (error) =>
                                    new AttemptFailure(
                                        error,
                                        error instanceof RateLimitError ||
                                            (error instanceof ConnectionError &&
                                                error.reason === "network" &&
                                                (error.status === null || error.status >= 500)),
                                    ),
                            ),
                            Effect.timeoutOrElse({
                                duration: budget,
                                orElse: () => Effect.fail(new AttemptFailure(new ConnectionTimeoutError(budget), true)),
                            }),
                        )
                    }
                    return yield* runGateway(
                        url,
                        configuration.token,
                        owner.#session,
                        Math.max(0, attemptDeadline - now()),
                        () => {
                            established = true
                            connectedAt = now()
                            disconnectedAt = undefined
                            owner.#setState("Connected")
                            Deferred.doneUnsafe(startup, Effect.void)
                        },
                        (latency) => {
                            owner.#latency = latency
                        },
                        () => {
                            disconnectedAt ??= now()
                            owner.#setState("Recovering")
                        },
                    )
                })
                const result = yield* Effect.exit(attempt)
                if (Exit.isSuccess(result))
                    return yield* Effect.die(new Error("Gateway lifetime ended without an outcome"))
                // Inspect the full cause before considering a retry; typed matching can hide a cleanup defect
                if (Cause.hasDies(result.cause) || Cause.hasInterrupts(result.cause)) {
                    return yield* Effect.failCause(Cause.map(result.cause, (failure) => failure.failure))
                }
                const reason = result.cause.reasons.find((reason) => reason._tag === "Fail")
                if (reason?._tag !== "Fail") return yield* Effect.die(new Error("Gateway failure had no reason"))
                const failure = reason.error
                if (failure.resetSession) owner.#session = { id: undefined, sequence: null }
                const reported =
                    !established && failure.failure instanceof ConnectionTimeoutError
                        ? new ConnectionTimeoutError(configuration.startupTimeoutMs)
                        : failure.failure
                if (!failure.retry) return yield* Effect.fail(reported)
                if (!established && attempts >= configuration.maxStartupAttempts) return yield* Effect.fail(reported)
                if (established) {
                    owner.#setState("Recovering")
                    if (connectedAt !== undefined && (disconnectedAt ?? now()) - connectedAt >= 60_000) recoveryStep = 0
                    connectedAt = undefined
                }
                const ceiling = established
                    ? Math.min(30_000, 1000 * 2 ** Math.min(recoveryStep++, 5))
                    : Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5))
                const jitter = (yield* Random.next) * ceiling
                const requiredWait = failure.failure instanceof RateLimitError ? (failure.failure.retryAfterMs ?? 0) : 0
                const delay = Math.max(jitter, requiredWait)
                if (!established && delay >= deadline - now()) {
                    return yield* Effect.fail(
                        requiredWait > 0 ? failure.failure : new ConnectionTimeoutError(configuration.startupTimeoutMs),
                    )
                }
                yield* Effect.sleep(delay)
            }
        })
    }

    #start(): Effect.Effect<void, ConnectError> {
        const owner = this
        return Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
                if (owner.#state === "Closing" || owner.#state === "Closed")
                    return yield* Effect.fail(new ClientClosedError())
                if (owner.#state === "Connected") return
                if (owner.#state !== "Disconnected") return yield* Effect.fail(new ClientBusyError())
                const configuration = owner.#configuration!
                const startup = Deferred.makeUnsafe<void, ConnectError>()
                let becameReady = false
                owner.#workerExit = undefined
                owner.#setState("Connecting")
                const trackReady = owner.subscribe((state) => {
                    if (state === "Connected") becameReady = true
                })
                owner.#worker = yield* Effect.forkIn(
                    owner.#loop(configuration, startup).pipe(
                        Effect.onExit((exit) =>
                            Effect.sync(() => {
                                trackReady()
                                owner.#workerExit = exit
                                const closing = owner.#state === "Closing" || owner.#state === "Closed"
                                const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
                                const defect = Exit.isFailure(exit) && Cause.hasDies(exit.cause)
                                if (closing && !defect)
                                    Deferred.doneUnsafe(startup, Effect.fail(new ClientClosedError()))
                                else Deferred.doneUnsafe(startup, exit)
                                if (becameReady || defect) {
                                    owner.#finish()
                                    Deferred.doneUnsafe(owner.#terminal, interrupted ? Effect.void : exit)
                                } else if (!closing) {
                                    owner.#session = { id: undefined, sequence: null }
                                    owner.#setState("Disconnected")
                                }
                            }),
                        ),
                        // Outcomes are retained above, not left as unobserved fiber failures
                        Effect.catchCause(() => Effect.void),
                    ),
                    owner.scope,
                )
                const worker = owner.#worker
                return yield* restore(Deferred.await(startup)).pipe(
                    Effect.onInterrupt(() =>
                        Effect.gen(function* () {
                            yield* Fiber.interrupt(worker)
                            const exit = owner.#workerExit
                            if (exit && Exit.isFailure(exit) && Cause.hasDies(exit.cause))
                                return yield* Effect.failCause(exit.cause)
                        }),
                    ),
                )
            }),
        )
    }

    connect(): Effect.Effect<void, ConnectError> {
        return Effect.suspend(() => {
            if (this.#state === "Closing" || this.#state === "Closed") return Effect.fail(new ClientClosedError())
            return this.#managed ? Effect.fail(new ClientBusyError()) : this.#start()
        })
    }

    waitForClose(): Effect.Effect<void, ConnectionFailure> {
        return Deferred.await(this.#terminal)
    }

    shutdown(): Effect.Effect<void> {
        const owner = this
        return Effect.uninterruptible(
            Effect.suspend(() => {
                if (owner.#shutdownStarted) return Deferred.await(owner.#shutdown)
                if (owner.#state === "Closed") return Effect.void
                owner.#shutdownStarted = true
                owner.#setState("Closing")
                return Effect.gen(function* () {
                    if (owner.#worker) yield* Fiber.interrupt(owner.#worker)
                    const exit = owner.#workerExit
                    owner.#finish()
                    if (exit && Exit.isFailure(exit) && Cause.hasDies(exit.cause)) {
                        Deferred.doneUnsafe(owner.#terminal, exit)
                        return yield* Effect.die(exit.cause)
                    }
                    Deferred.doneUnsafe(owner.#terminal, Effect.void)
                }).pipe(Effect.onExit((exit) => Deferred.done(owner.#shutdown, exit)))
            }),
        )
    }

    run(): Effect.Effect<void, ConnectError> {
        const owner = this
        return Effect.uninterruptibleMask((restore) =>
            Effect.suspend(() => {
                if (owner.#state === "Closed" || owner.#state === "Closing") return Effect.fail(new ClientClosedError())
                if (owner.#managed || owner.#state !== "Disconnected") return Effect.fail(new ClientBusyError())
                owner.#managed = true
                return restore(owner.#start().pipe(Effect.andThen(owner.waitForClose()))).pipe(
                    Effect.ensuring(owner.shutdown()),
                )
            }),
        )
    }
}

export function makeClient(options: ClientOptions, scope: Scope.Scope): Effect.Effect<ClientOwner, ConfigurationError> {
    return Effect.map(validateConfiguration(options), (configuration) => new ClientOwner(configuration, scope))
}
