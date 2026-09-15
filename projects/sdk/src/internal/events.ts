import { Cause, Clock, Deferred, Effect, Exit, Scope, Stream } from "effect"
import type {
    EventBufferOptions,
    EventWaitOptions,
    HandlerOptions,
    HandlerErrorReport,
    EventMap,
    EventName,
} from "#sdk/events"
import { ClientClosedError, ConfigurationError } from "#sdk/errors"
import {
    EventOverflowError,
    EventReadBusyError,
    EventWaitError,
    type EventReadError,
    type RegistrationError,
} from "#sdk/message-errors"
import type { Message, MessageCore } from "#sdk/messages"
import type { MessageReference } from "#sdk/messages"
import type { MessageReaction, MessageReactionBatch } from "#sdk/reactions"
import { withDeadline } from "./effect-failures.js"
import { record } from "./message.js"
import { discardInvalidCallbackReturn } from "./invalid-callback-return.js"

type Resume<A> = (value: Effect.Effect<A | null, EventOverflowError>) => void
type Limits = Required<HandlerOptions>
/** Narrow the two message-bearing dispatch names without treating other events as messages */
export function isMessageEvent<K extends EventName, M extends MessageCore>(
    event: K,
    _message: EventMap<M>[K],
): _message is EventMap<M>[K] & M {
    return event === "messageCreate" || event === "messageUpdate"
}
type EventWaitSettings<K extends EventName, M extends MessageCore = Message> = {
    readonly buffer: EventBufferOptions
    readonly filter: ((event: EventMap<M>[K]) => boolean) | undefined
    readonly timeoutMs: number
}

const maximumTimerMs = 2_147_483_647

function eventWaitSettings<K extends EventName, M extends MessageCore = Message>(
    options: EventWaitOptions<K, M> | undefined,
    allowSignal: boolean,
): EventWaitSettings<K, M> | ConfigurationError {
    const input = options === undefined ? {} : options
    if (!record(input)) return new ConfigurationError("eventOptions", "Event wait options must be an object")
    if (
        Object.keys(input).some(
            (key) =>
                key !== "filter" &&
                key !== "timeoutMs" &&
                key !== "maxPendingMessages" &&
                key !== "maxPendingBytes" &&
                !(allowSignal && key === "signal"),
        )
    )
        return new ConfigurationError("eventOptions", "Unsupported event wait option")
    const timeoutMs = input.timeoutMs === undefined ? 30_000 : input.timeoutMs
    if (
        typeof timeoutMs !== "number" ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > maximumTimerMs
    )
        return new ConfigurationError(
            "timeoutMs",
            "Event wait timeout must be a positive safe integer within the timer range",
        )
    if (input.filter !== undefined && typeof input.filter !== "function")
        return new ConfigurationError("filter", "Event wait filter must be a function")
    return {
        buffer: {
            ...(input.maxPendingMessages === undefined ? {} : { maxPendingMessages: input.maxPendingMessages }),
            ...(input.maxPendingBytes === undefined ? {} : { maxPendingBytes: input.maxPendingBytes }),
        } as EventBufferOptions,
        filter: input.filter as ((event: EventMap<M>[K]) => boolean) | undefined,
        timeoutMs,
    }
}

function limits(options: unknown): Limits | ConfigurationError {
    if (options === undefined) options = {}
    if (!record(options)) return new ConfigurationError("eventOptions", "Event options must be an object")
    const defaults = { concurrency: 1, maxPendingMessages: 256, maxPendingBytes: 4_194_304 }
    for (const key of Object.keys(defaults) as (keyof Limits)[]) {
        const value = options[key]
        if (value !== undefined) {
            if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
                return new ConfigurationError(key, "Event budgets must be positive safe integers")
            defaults[key] = value
        }
    }
    return defaults
}

/** One bounded subscription. Gateway callbacks never await asynchronous consumer work, though a waiting synchronous filter can continue immediately after admission */
export class EventSource<A = Message> {
    readonly closed = Deferred.makeUnsafe<void, EventOverflowError>()
    readonly limits: Limits
    #pending: { message: A; bytes: number }[] = []
    #bytes = 0
    #waiters = new Set<Resume<A>>()
    #active = true
    #reading = false
    #failure: EventOverflowError | undefined
    #stopWorker: (() => void) | undefined
    #managed = false
    #cleanupCause: Cause.Cause<never> = Cause.empty

    constructor(
        limits: Limits,
        readonly release: () => void,
    ) {
        this.limits = limits
    }
    get active() {
        return this.#active
    }
    get failure() {
        return this.#failure
    }

    offer(message: A, bytes: number) {
        if (!this.#active) return
        const waiter = this.#waiters.values().next().value
        if (waiter) {
            this.#waiters.delete(waiter)
            waiter(Effect.succeed(message))
        } else if (this.#pending.length >= this.limits.maxPendingMessages) {
            this.stop(new EventOverflowError("messages", this.limits.maxPendingMessages))
        } else if (bytes > this.limits.maxPendingBytes - this.#bytes) {
            this.stop(new EventOverflowError("bytes", this.limits.maxPendingBytes))
        } else {
            this.#pending.push({ message, bytes })
            this.#bytes += bytes
        }
    }

    stop(failure?: EventOverflowError) {
        if (!this.#active) return
        this.#active = false
        this.#failure = failure
        this.#pending = []
        this.#bytes = 0
        for (const resume of this.#waiters) resume(failure ? Effect.fail(failure) : Effect.succeed(null))
        this.#waiters.clear()
        this.#stopWorker?.()
        if (!this.#managed) this.finish(Exit.void)
    }

    manage(stopWorker: () => void) {
        this.#managed = true
        this.#stopWorker = stopWorker
        if (!this.#active) stopWorker()
    }

    recordCleanup(exit: Exit.Exit<unknown, unknown>) {
        if (!this.#active && Exit.isFailure(exit) && Cause.hasDies(exit.cause)) {
            this.#cleanupCause = Cause.combine(
                this.#cleanupCause,
                Cause.fromReasons<never>(exit.cause.reasons.filter((reason) => reason._tag !== "Fail")),
            )
        }
    }

    finish(exit: Exit.Exit<unknown, unknown>) {
        this.#active = false
        this.#pending = []
        this.#bytes = 0
        this.#stopWorker = undefined
        this.release()
        let cause: Cause.Cause<EventOverflowError> = this.#failure ? Cause.fail(this.#failure) : Cause.empty
        if (Exit.isFailure(exit) && Cause.hasDies(exit.cause)) {
            cause = Cause.combine(
                cause,
                Cause.fromReasons(exit.cause.reasons.filter((reason) => reason._tag !== "Fail")),
            )
        }
        cause = Cause.fromReasons([...new Set([...cause.reasons, ...this.#cleanupCause.reasons])])
        Deferred.doneUnsafe(this.closed, cause.reasons.length ? Effect.failCause(cause) : Effect.void)
    }

    take(): Effect.Effect<A | null, EventOverflowError> {
        return Effect.suspend(() => {
            if (this.#failure) return Effect.fail(this.#failure)
            if (!this.#active) return Effect.succeed(null)
            const item = this.#pending.shift()
            if (item) {
                this.#bytes -= item.bytes
                return Effect.succeed(item.message)
            }
            return Effect.callback((resume) => {
                this.#waiters.add(resume)
                return Effect.sync(() => {
                    this.#waiters.delete(resume)
                })
            })
        })
    }

    next(): Effect.Effect<A | null, EventReadError> {
        return Effect.suspend((): Effect.Effect<A | null, EventReadError> => {
            if (this.#reading) return Effect.fail(new EventReadBusyError())
            this.#reading = true
            return this.take().pipe(
                Effect.ensuring(
                    Effect.sync(() => {
                        this.#reading = false
                    }),
                ),
            )
        })
    }
}

/** One internal single-consumption event wait */
interface EventWaitSource<K extends EventName, M extends MessageCore = Message> {
    stop(): void
    wait(): Effect.Effect<EventMap<M>[K], EventWaitError | EventOverflowError | ClientClosedError>
}

class EventWait<K extends EventName, M extends MessageCore = Message> implements EventWaitSource<K, M> {
    #stopped = false
    #filter: ((event: EventMap<M>[K]) => boolean) | undefined

    constructor(
        private readonly source: EventSource<EventMap<M>[K]>,
        filter: ((event: EventMap<M>[K]) => boolean) | undefined,
        private readonly deadline: number,
        private readonly clock: Clock.Clock,
    ) {
        this.#filter = filter
    }

    stop() {
        if (this.#stopped) return
        this.#stopped = true
        this.#filter = undefined
        this.source.stop()
    }

    #now() {
        return Number(this.clock.monotonicTimeNanosUnsafe()) / 1_000_000
    }

    #expired() {
        return this.#now() >= this.deadline
    }

    #accept(event: EventMap<M>[K]): boolean | EventWaitError {
        if (!this.#filter) return true
        let accepted: unknown
        try {
            accepted = this.#filter(event)
        } catch {
            return new EventWaitError("filter")
        }
        discardInvalidCallbackReturn(accepted)
        return typeof accepted === "boolean" ? accepted : new EventWaitError("filter")
    }

    wait(): Effect.Effect<EventMap<M>[K], EventWaitError | EventOverflowError | ClientClosedError> {
        return Effect.suspend(() => {
            const remaining = this.deadline - this.#now()
            if (remaining <= 0) {
                this.stop()
                return Effect.fail(new EventWaitError("timeout"))
            }
            const waiter = this
            const wait = Effect.gen(function* () {
                while (true) {
                    const event = yield* waiter.source.take()
                    if (event === null) return yield* Effect.fail(new ClientClosedError())
                    if (waiter.#expired()) return yield* Effect.fail(new EventWaitError("timeout"))
                    const accepted = waiter.#accept(event)
                    if (accepted instanceof EventWaitError) return yield* Effect.fail(accepted)
                    if (waiter.#expired()) return yield* Effect.fail(new EventWaitError("timeout"))
                    if (accepted) return event
                }
            })
            return wait.pipe(
                withDeadline(Math.max(1, Math.ceil(remaining)), () => new EventWaitError("timeout")),
                Effect.ensuring(Effect.sync(() => this.stop())),
            )
        })
    }
}

export class EventBus<M extends MessageCore = Message> {
    #reactionCollectors = new Map<
        string,
        Set<(reaction: MessageReaction | MessageReactionBatch, bytes: number, shardId: number) => void>
    >()

    /** Exact message selection precedes queue admission; user filters run outside gateway decoding */
    listenReactions(
        target: MessageReference,
        listener: (reaction: MessageReaction | MessageReactionBatch, bytes: number) => void,
        shardId?: number,
    ) {
        const key = `${target.channelId}:${target.id}`
        let listeners = this.#reactionCollectors.get(key)
        if (!listeners) this.#reactionCollectors.set(key, (listeners = new Set()))
        const offer = (message: MessageReaction | MessageReactionBatch, bytes: number, sourceShard: number) => {
            if (shardId === undefined || shardId === sourceShard) listener(message, bytes)
        }
        listeners.add(offer)
        return () => {
            listeners.delete(offer)
            if (!listeners.size) this.#reactionCollectors.delete(key)
        }
    }
    #collectors = new Map<string, Set<(message: M, bytes: number, shardId: number) => void>>()

    /** Channel selection precedes collector queue admission. These callbacks only enqueue, never run user filters */
    listenMessages(channelId: string, listener: (message: M, bytes: number) => void, shardId?: number) {
        let listeners = this.#collectors.get(channelId)
        if (!listeners) this.#collectors.set(channelId, (listeners = new Set()))
        const offer = (message: M, bytes: number, sourceShard: number) => {
            if (shardId === undefined || shardId === sourceShard) listener(message, bytes)
        }
        listeners.add(offer)
        return () => {
            listeners.delete(offer)
            if (!listeners.size) this.#collectors.delete(channelId)
        }
    }
    #sources: { [K in EventName]: Set<EventSource<EventMap<M>[K]>> } = {
        userUpdate: new Set(),
        directMessageCreate: new Set(),
        directMessageUpdate: new Set(),
        directMessageDelete: new Set(),
        directMessageRecipientAdd: new Set(),
        directMessageRecipientRemove: new Set(),
        guildCreate: new Set(),
        guildUpdate: new Set(),
        guildDelete: new Set(),
        webhooksUpdate: new Set(),
        inviteCreate: new Set(),
        inviteDelete: new Set(),
        guildAuditLogEntryCreate: new Set(),
        guildEmojisUpdate: new Set(),
        guildStickersUpdate: new Set(),
        guildChannelCreate: new Set(),
        guildChannelUpdate: new Set(),
        guildChannelDelete: new Set(),
        guildChannelUpdateBulk: new Set(),
        channelPinsUpdate: new Set(),
        guildMemberAdd: new Set(),
        guildMemberUpdate: new Set(),
        guildMemberRemove: new Set(),
        presenceUpdate: new Set(),
        presenceUpdateBulk: new Set(),
        voiceStateSnapshot: new Set(),
        voiceStateUpdate: new Set(),
        guildBanAdd: new Set(),
        guildBanRemove: new Set(),
        guildRoleDelete: new Set(),
        guildRoleCreate: new Set(),
        guildRoleUpdate: new Set(),
        guildRoleUpdateBulk: new Set(),
        typingStart: new Set(),
        messageCreate: new Set(),
        messageUpdate: new Set(),
        messageDelete: new Set(),
        messageDeleteBulk: new Set(),
        messageReactionAdd: new Set(),
        messageReactionAddMany: new Set(),
        messageReactionRemove: new Set(),
        messageReactionRemoveAll: new Set(),
        messageReactionRemoveEmoji: new Set(),
    }
    #closed = false
    #closingSources: Pick<EventSource, "stop" | "closed">[] = []
    #handlerFibers = new Set<number>()
    ownsHandler(fiberId: number) {
        return this.#handlerFibers.has(fiberId)
    }
    open<K extends EventName>(
        event: K,
        options?: EventBufferOptions,
    ): Effect.Effect<EventSource<EventMap<M>[K]>, RegistrationError> {
        return Effect.suspend((): Effect.Effect<EventSource<EventMap<M>[K]>, RegistrationError> => {
            if (this.#closed) return Effect.fail(new ClientClosedError())
            if (typeof event !== "string" || !Object.hasOwn(this.#sources, event))
                return Effect.fail(new ConfigurationError("event", "Unsupported event name"))
            const settings = limits(options)
            if (settings instanceof ConfigurationError) return Effect.fail(settings)
            const sources = this.#sources[event]
            const source = new EventSource<EventMap<M>[K]>(settings, () => sources.delete(source))
            sources.add(source)
            return Effect.succeed(source)
        })
    }
    offer<K extends EventName>(event: K, message: EventMap<M>[K], bytes: number, shardId = 0) {
        if (event === "messageReactionAdd" || event === "messageReactionAddMany") {
            const reaction = message as MessageReaction | MessageReactionBatch
            for (const offer of this.#reactionCollectors.get(`${reaction.channelId}:${reaction.id}`) ?? [])
                offer(reaction, bytes, shardId)
        }
        if (event === "messageCreate" && isMessageEvent<K, M>(event, message)) {
            const created = message
            for (const offer of this.#collectors.get(created.channelId) ?? []) offer(created, bytes, shardId)
        }
        for (const source of this.#sources[event]) source.offer(message, bytes)
    }
    stop() {
        if (this.#closed) return
        this.#closed = true
        this.#closingSources = Object.values(this.#sources).flatMap((sources) => [...sources])
        for (const source of this.#closingSources) source.stop()
    }
    shutdown(): Effect.Effect<void> {
        return Effect.suspend(() => {
            this.stop()
            return Effect.forEach(this.#closingSources, (source) => Effect.exit(Deferred.await(source.closed)), {
                concurrency: "unbounded",
            }).pipe(
                Effect.flatMap((exits) => {
                    const reasons = exits.flatMap((exit) =>
                        Exit.isFailure(exit) && Cause.hasDies(exit.cause)
                            ? exit.cause.reasons.filter((reason) => reason._tag !== "Fail")
                            : [],
                    )
                    return reasons.length ? Effect.failCause(Cause.fromReasons<never>(reasons)) : Effect.void
                }),
                Effect.ensuring(
                    Effect.sync(() => {
                        this.#closingSources = []
                    }),
                ),
            )
        })
    }
    stream<K extends EventName>(event: K, options?: EventBufferOptions) {
        const bus = this
        return Stream.unwrap(
            Effect.gen(function* () {
                const source = yield* Effect.acquireRelease(bus.open(event, options), (source) =>
                    Effect.sync(() => source.stop()),
                )
                return Stream.fromEffectRepeat(source.take()).pipe(
                    Stream.takeWhile((message) => message !== null),
                    Stream.map((message) => message!),
                )
            }),
        )
    }

    on<K extends EventName, E, R, E2, R2>(
        event: K,
        handler: (message: EventMap<M>[K]) => Effect.Effect<unknown, E, R>,
        options: HandlerOptions | undefined,
        onError: ((report: HandlerErrorReport) => Effect.Effect<unknown, E2, R2>) | undefined,
        scope: Scope.Scope,
    ): Effect.Effect<EventSource<EventMap<M>[K]>, RegistrationError, R | R2> {
        const bus = this
        return Effect.uninterruptible(
            Effect.gen(function* () {
                if (typeof handler !== "function")
                    return yield* Effect.fail(new ConfigurationError("handler", "Handler must be a function"))
                if (onError !== undefined && typeof onError !== "function")
                    return yield* Effect.fail(new ConfigurationError("onError", "Error reporter must be a function"))
                const source = yield* bus.open(event, options)
                const report = (kind: HandlerErrorReport["kind"]) => {
                    const fallback = Effect.logError(`Fluxerly event subscription ${event} ${kind} failure`).pipe(
                        Effect.catchCause(() => Effect.void),
                    )
                    return onError
                        ? Effect.suspend(() => onError(Object.freeze({ event, kind }))).pipe(
                              Effect.asVoid,
                              Effect.catchCause(() =>
                                  Effect.logError(
                                      `Fluxerly event subscription ${event} ${kind} failure (error reporter also failed)`,
                                  ).pipe(Effect.catchCause(() => Effect.void)),
                              ),
                          )
                        : fallback
                }
                let active = 0
                let capacity = Deferred.makeUnsafe<void>()
                const worker = (message: EventMap<M>[K]) =>
                    Effect.withFiber((fiber) =>
                        Effect.gen(function* () {
                            bus.#handlerFibers.add(fiber.id)
                            yield* Effect.scoped(Effect.suspend(() => handler(message))).pipe(
                                Effect.onExit((exit) => Effect.sync(() => source.recordCleanup(exit))),
                                Effect.catchCause((cause) => {
                                    if (Cause.hasInterrupts(cause))
                                        return Effect.failCause(
                                            Cause.fromReasons(cause.reasons.filter((reason) => reason._tag !== "Fail")),
                                        )
                                    return report("handler")
                                }),
                            )
                        }).pipe(
                            Effect.ensuring(
                                Effect.sync(() => {
                                    bus.#handlerFibers.delete(fiber.id)
                                    active--
                                    Deferred.doneUnsafe(capacity, Effect.void)
                                    capacity = Deferred.makeUnsafe<void>()
                                }),
                            ),
                        ),
                    )
                // Allocate work only for received messages, not one idle fiber for every configured concurrency slot
                const program = Effect.scoped(
                    Effect.gen(function* () {
                        while (source.active) {
                            if (active >= source.limits.concurrency) {
                                yield* Deferred.await(capacity)
                                continue
                            }
                            const message = yield* source.take()
                            if (message === null || !source.active) return
                            active++
                            yield* Effect.forkScoped(worker(message).pipe(Effect.catchCause(() => Effect.void)))
                        }
                    }).pipe(Effect.onExit(() => Effect.sync(() => source.stop()))),
                ).pipe(
                    Effect.interruptible,
                    Effect.onExit((exit) =>
                        Effect.gen(function* () {
                            source.stop()
                            if (source.failure) yield* report("overflow")
                            source.finish(exit)
                        }),
                    ),
                    Effect.catchCause(() => Effect.void),
                )
                // forkIn retains the registration caller's context; no hidden native runPromise or detached runtime
                // Install closure before enabling interruption, including cancellation before the first fiber turn
                const fiber = yield* Effect.forkIn(program, scope, { uninterruptible: true })
                source.manage(() => fiber.interruptUnsafe())
                return source
            }),
        )
    }
}

function openEventWait<K extends EventName, M extends MessageCore = Message>(
    bus: EventBus<M>,
    event: K,
    options?: EventWaitOptions<K, M>,
    allowSignal = false,
): Effect.Effect<EventWaitSource<K, M>, RegistrationError> {
    return Clock.clockWith((clock) =>
        Effect.gen(function* () {
            const settings = eventWaitSettings(options, allowSignal)
            if (settings instanceof ConfigurationError) return yield* Effect.fail(settings)
            const source = yield* bus.open(event, settings.buffer)
            const now = Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000
            return new EventWait(source, settings.filter, now + settings.timeoutMs, clock)
        }),
    )
}

/** One lazy wait. Its internal scope releases intake on completion, timeout, interruption or client shutdown */
export function waitForEvent<K extends EventName, M extends MessageCore = Message>(
    bus: EventBus<M>,
    event: K,
    options?: EventWaitOptions<K, M>,
    allowSignal = false,
): Effect.Effect<EventMap<M>[K], RegistrationError | EventWaitError | EventOverflowError> {
    return Effect.scoped(
        Effect.acquireRelease(openEventWait(bus, event, options, allowSignal), (source) =>
            Effect.sync(() => source.stop()),
        ).pipe(Effect.flatMap((source) => source.wait())),
    )
}
