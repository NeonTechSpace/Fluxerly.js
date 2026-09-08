import { Cause, Clock, Deferred, Effect, Exit, Fiber, Queue, Random, Redacted, Scope, Stream } from "effect"
import type { ConnectionState } from "#sdk/client"
import type { CachePolicyErrorReport } from "#sdk/cache"
import { MessageOperationError } from "#sdk/message-errors"
import { reference } from "./message.js"
import { MessageCache } from "./cache.js"
import { makeCacheReports, type CacheReports } from "./cache-reports.js"
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
import { EventBus } from "./events.js"
import { RestOwner } from "./rest.js"
import type { ClientLogging } from "./logging.js"
import type {
    Message,
    EditMessageInput,
    MessageHistoryQuery,
    MessageInput,
    MessageOperationOptions,
    MessageReference,
    SendOptions,
} from "#sdk/messages"

export class ClientOwner {
    readonly logging: ClientLogging
    readonly events = new EventBus()
    readonly rest: RestOwner
    readonly cache: MessageCache | undefined
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
        private readonly reports: CacheReports | undefined,
        now: () => number,
    ) {
        this.#configuration = configuration
        this.logging = configuration.logging
        this.cache = configuration.cache
            ? new MessageCache(configuration.cache, (report) => reports!.offer(report), now)
            : undefined
        this.rest = new RestOwner(this.cache, configuration.uploadMaxBytes)
    }
    get state(): ConnectionState {
        return this.#state
    }
    get gatewayLatencyMs(): number | null {
        return this.#latency
    }

    #setState(state: ConnectionState) {
        if (this.#state === state) return
        if (state === "Recovering") this.cache?.gap()
        if (state === "Closing" || state === "Closed") this.cache?.close()
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
        this.events.stop()
        this.rest.stop()
        if (this.#configuration) Redacted.wipeUnsafe(this.#configuration.token)
        this.#configuration = undefined
        this.#session = { id: undefined, sequence: null }
        this.#setState("Closed")
    }

    send(channelId: string, input: MessageInput, options?: SendOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? (this.reports?.start() ?? Effect.void).pipe(
                      Effect.andThen(this.rest.send(this.#configuration.token, channelId, input, options)),
                  )
                : Effect.fail(new ClientClosedError()),
        )
    }

    fetch(target: MessageReference, options?: MessageOperationOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? (this.reports?.start() ?? Effect.void).pipe(
                      Effect.andThen(this.rest.fetch(this.#configuration.token, target, options)),
                  )
                : Effect.fail(new ClientClosedError()),
        )
    }

    fetchHistory(channelId: string, query?: MessageHistoryQuery, options?: MessageOperationOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? (this.reports?.start() ?? Effect.void).pipe(
                      Effect.andThen(this.rest.fetchHistory(this.#configuration.token, channelId, query, options)),
                  )
                : Effect.fail(new ClientClosedError()),
        )
    }

    edit(target: MessageReference, input: EditMessageInput, options?: MessageOperationOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? (this.reports?.start() ?? Effect.void).pipe(
                      Effect.andThen(this.rest.edit(this.#configuration.token, target, input, options)),
                  )
                : Effect.fail(new ClientClosedError()),
        )
    }

    delete(target: MessageReference, options?: MessageOperationOptions) {
        return Effect.suspend(() =>
            this.#configuration && this.#state !== "Closing" && this.#state !== "Closed"
                ? (this.reports?.start() ?? Effect.void).pipe(
                      Effect.andThen(this.rest.delete(this.#configuration.token, target, options)),
                  )
                : Effect.fail(new ClientClosedError()),
        )
    }

    get(target: MessageReference) {
        return Effect.suspend((): Effect.Effect<Message | undefined, ClientClosedError | MessageOperationError> => {
            if (!this.#configuration || this.#state === "Closing" || this.#state === "Closed")
                return Effect.fail(new ClientClosedError())
            if (!reference(target)) return Effect.fail(new MessageOperationError("get", "input", "notDispatched"))
            return Effect.succeed(this.cache?.get(target))
        })
    }

    #closeServices() {
        this.events.stop()
        this.rest.stop()
        return Effect.all(
            [
                Effect.exit(this.events.shutdown()),
                Effect.exit(this.rest.shutdown()),
                Effect.exit(this.reports?.shutdown() ?? Effect.void),
            ],
            {
                concurrency: "unbounded",
            },
        ).pipe(
            Effect.flatMap((exits) => {
                const reasons = exits.flatMap((exit) => (Exit.isFailure(exit) ? exit.cause.reasons : []))
                return reasons.length ? Effect.failCause(Cause.fromReasons<never>(reasons)) : Effect.void
            }),
        )
    }

    #loop(configuration: Configuration, startup: Deferred.Deferred<void, ConnectError>) {
        const owner = this
        return Effect.gen(function* () {
            const fiber = yield* Effect.withFiber((fiber) => Effect.succeed(fiber))
            const emit = (diagnostic: Parameters<ClientLogging["emit"]>[1]) => owner.logging.emit(fiber, diagnostic)
            emit({ event: "connecting", phase: "startup" })
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
                const phase = established ? "recovery" : "startup"
                const mode = owner.#session.id !== undefined && owner.#session.sequence !== null ? "resume" : "identify"
                emit({ event: "attempt", phase, attempt: attempts, mode })
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
                        (readyMode) => {
                            established = true
                            connectedAt = now()
                            disconnectedAt = undefined
                            owner.#setState("Connected")
                            emit({ event: "connected", phase, attempt: attempts, mode: readyMode })
                            Deferred.doneUnsafe(startup, Effect.void)
                        },
                        (latency) => {
                            owner.#latency = latency
                        },
                        () => {
                            disconnectedAt ??= now()
                            owner.#setState("Recovering")
                        },
                        (event, message, bytes) => {
                            if ("author" in message) owner.cache?.observe(message)
                            else if ("ids" in message) {
                                for (const id of message.ids) owner.cache?.delete({ id, channelId: message.channelId })
                            } else owner.cache?.delete(message)
                            owner.events.offer(event, message, bytes)
                        },
                    )
                })
                const result = yield* Effect.exit(attempt)
                if (Exit.isSuccess(result))
                    return yield* Effect.die(new Error("Gateway lifetime ended without an outcome"))
                // Inspect the full cause before considering a retry; typed matching can hide a cleanup defect
                if (Cause.hasDies(result.cause) || Cause.hasInterrupts(result.cause)) {
                    emit({
                        event: "connectionEnded",
                        phase: established ? "recovery" : "startup",
                        failure: Cause.hasDies(result.cause) ? "defect" : "interrupted",
                    })
                    return yield* Effect.failCause(Cause.map(result.cause, (failure) => failure.failure))
                }
                const reason = result.cause.reasons.find((reason) => reason._tag === "Fail")
                if (reason?._tag !== "Fail") return yield* Effect.die(new Error("Gateway failure had no reason"))
                const failure = reason.error
                if (established && connectedAt !== undefined) emit({ event: "connectionLost", phase: "recovery" })
                if (failure.resetSession) {
                    owner.#session = { id: undefined, sequence: null }
                    emit({ event: "sessionReset", phase, mode: "identify" })
                }
                const reported =
                    !established && failure.failure instanceof ConnectionTimeoutError
                        ? new ConnectionTimeoutError(configuration.startupTimeoutMs)
                        : failure.failure
                const classification =
                    failure.failure instanceof ConnectionError ? failure.failure.reason : failure.failure._tag
                if (!failure.retry || (!established && attempts >= configuration.maxStartupAttempts)) {
                    emit({
                        event: "connectionEnded",
                        phase: established ? "recovery" : "startup",
                        failure: classification,
                    })
                    return yield* Effect.fail(reported)
                }
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
                    emit({
                        event: "connectionEnded",
                        phase,
                        failure: requiredWait > 0 ? "RateLimitError" : "ConnectionTimeoutError",
                    })
                    return yield* Effect.fail(
                        requiredWait > 0 ? failure.failure : new ConnectionTimeoutError(configuration.startupTimeoutMs),
                    )
                }
                emit({
                    event: "retry",
                    phase: established ? "recovery" : "startup",
                    attempt: attempts,
                    delayMs: delay,
                    failure: classification,
                })
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
                yield* owner.reports?.start() ?? Effect.void
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
                            Effect.gen(function* () {
                                trackReady()
                                owner.#workerExit = exit
                                const closing = owner.#state === "Closing" || owner.#state === "Closed"
                                const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
                                const defect = Exit.isFailure(exit) && Cause.hasDies(exit.cause)
                                if (closing && !defect)
                                    Deferred.doneUnsafe(startup, Effect.fail(new ClientClosedError()))
                                else Deferred.doneUnsafe(startup, exit)
                                if (becameReady || defect) {
                                    const fiber = yield* Effect.withFiber((fiber) => Effect.succeed(fiber))
                                    if (!closing) owner.logging.emit(fiber, { event: "closing" })
                                    owner.#setState("Closing")
                                    const services = yield* Effect.exit(owner.#closeServices())
                                    const outcome = Exit.isFailure(services)
                                        ? Exit.failCause(
                                              Cause.combine(
                                                  Exit.isFailure(exit) ? exit.cause : Cause.empty,
                                                  services.cause,
                                              ),
                                          )
                                        : exit
                                    owner.#workerExit = outcome
                                    owner.#finish()
                                    if (!closing) owner.logging.emit(fiber, { event: "closed" })
                                    Deferred.doneUnsafe(
                                        owner.#terminal,
                                        interrupted && !Exit.isFailure(services) ? Effect.void : outcome,
                                    )
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
        return Effect.withFiber((fiber) =>
            this.events.ownsHandler(fiber.id) || this.reports?.owns(fiber.id)
                ? // A native handler cannot join its own cleanup: The client scope owns shutdown and interrupts this caller
                  Effect.forkIn(this.#performShutdown(), this.scope).pipe(Effect.andThen(Effect.never))
                : this.#performShutdown(),
        )
    }

    #performShutdown(): Effect.Effect<void> {
        const owner = this
        return Effect.uninterruptible(
            Effect.suspend(() => {
                if (owner.#shutdownStarted) return Deferred.await(owner.#shutdown)
                if (owner.#state === "Closed") return Effect.void
                owner.#shutdownStarted = true
                owner.#setState("Closing")
                owner.events.stop()
                owner.rest.stop()
                return Effect.gen(function* () {
                    const fiber = yield* Effect.withFiber((fiber) => Effect.succeed(fiber))
                    owner.logging.emit(fiber, { event: "closing" })
                    if (owner.#worker) yield* Fiber.interrupt(owner.#worker)
                    const services = yield* Effect.exit(owner.#closeServices())
                    const exit = owner.#workerExit
                    owner.#finish()
                    owner.logging.emit(fiber, { event: "closed" })
                    if (Exit.isFailure(services)) {
                        Deferred.doneUnsafe(owner.#terminal, services)
                        return yield* Effect.failCause(services.cause)
                    }
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

export function makeClient(
    options: unknown,
    scope: Scope.Scope,
    native = false,
): Effect.Effect<ClientOwner, ConfigurationError> {
    return Effect.gen(function* () {
        const configuration = yield* validateConfiguration(options, native)
        return yield* configuration.logging.provide(
            Effect.gen(function* () {
                const callback = configuration.cache?.onError
                const reporter = callback
                    ? (report: CachePolicyErrorReport): Effect.Effect<unknown, unknown> =>
                          native
                              ? Effect.suspend(() => {
                                    const result = callback(report)
                                    // The report worker supplies the captured creation context, including the native reporter's services
                                    return Effect.isEffect(result)
                                        ? (result as Effect.Effect<unknown, unknown>)
                                        : Effect.die(new Error("Cache reporter must return an Effect"))
                                })
                              : Effect.callback((resume) => {
                                    void Promise.resolve()
                                        .then(() => callback(report))
                                        .then(
                                            () => resume(Effect.void),
                                            () => resume(Effect.die(new Error("Cache reporter failed"))),
                                        )
                                })
                    : undefined
                const reports = configuration.cache ? yield* makeCacheReports(reporter, scope) : undefined
                const clock = yield* Clock.Clock
                return new ClientOwner(
                    configuration,
                    scope,
                    reports,
                    () => Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000,
                )
            }),
        )
    })
}
