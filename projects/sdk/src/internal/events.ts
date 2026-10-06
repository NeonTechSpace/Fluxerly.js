/**
 * Event intake: Per-subscription scheduling, bounded pending delivery, overflow policies and event waits.
 * Invariant: Gateway callbacks never await consumer work, overflow ends only the affected subscription, and shutdown discards
 * pending delivery. Default callback promises stay application-owned while native cleanup is cooperative and awaited, and a native
 * handler's shutdown request runs in the client scope so the handler never joins itself. Each admitted event keeps the shard and
 * received frame size it arrived with for its handler context, without changing queue accounting. Middleware wraps on handler
 * invocations only, with the list registered when an invocation starts, and every failure inside the chain is reported where it
 * occurs, so middleware cannot hide a handler failure. A partitioned handler starts events in receive order per key and runs
 * at most one invocation per key, selecting from its own bounded queue so queue limits still cover every waiting event.
 * A draining shutdown seals the bus: New events and registrations are refused while running and queued handler work
 * continues until the client stops the bus. Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import type * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type {
    EventBufferOptions,
    EventContext,
    EventInvocation,
    EventWaitOptions,
    HandlerOptions,
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
import { inputDefect, readInput } from "./defects.js"
import { withDeadline } from "./effect-failures.js"
import { nowMs } from "./clock.js"
import { record } from "./decode/primitives.js"
import { discardInvalidCallbackReturn } from "./invalid-callback-return.js"
import type { ClientLogger } from "./logging.js"
import {
    logHandlerReport,
    makeReport,
    messageReference,
    primaryError,
    standaloneHookQueue,
    throwIfErr,
    type FailureReporter,
    type HookQueue,
    type InternalReport,
} from "./failures.js"
import { metrics } from "./metrics.js"
import { RejectionScope, fiberRejectionScope, withRejectionScope } from "./rejection-scope.js"
import { emitObservation, failureFacts, observing } from "./observer.js"
import { editDistance, unsupportedKeyHint } from "./suggest.js"

/** Mutable facts shared by the event worker and a command router that handles this invocation */
interface InvocationOutcome {
    command: string | undefined
    failure: Cause.Cause<unknown> | undefined
}

// Rejection scopes already cross both the native fiber and default Promise boundaries of one invocation
const invocationOutcomes = new WeakMap<RejectionScope, InvocationOutcome>()

/** Select the canonical command name once a router matches, before its guards and middleware run */
export function identifyCommand(name: string): Effect.Effect<void> {
    return Effect.withFiber((fiber) => {
        const scope = fiberRejectionScope(fiber.context)
        const outcome = scope === undefined ? undefined : invocationOutcomes.get(scope)
        if (outcome) outcome.command = name
        return Effect.void
    })
}

/** Keep a reported command failure visible to the enclosing handler observation, even when dispatch recovers */
export function recordCommandFailure(
    name: string | undefined,
    cause: Cause.Cause<unknown>,
    context: Context.Context<never>,
): void {
    const scope = fiberRejectionScope(context)
    const outcome = scope === undefined ? undefined : invocationOutcomes.get(scope)
    if (outcome) outcome.failure ??= cause
    metrics.handlerFailure(name ?? "messageCreate", context)
}

/** One admitted event with the shard and received frame size it arrived with */
interface Delivery<A> {
    readonly message: A
    readonly bytes: number
    readonly shardId: number
    /** Partition key, computed once when a partitioned handler first considers this event, or the failure computing it */
    key?: string | { readonly failure: unknown }
}
type Resume<A> = (value: Effect.Effect<Delivery<A> | null, EventOverflowError>) => void
type Limits = Required<Omit<HandlerOptions, "partition">> & { readonly partition: HandlerOptions["partition"] }

/** Default handler concurrency when a partition is set, so events of different keys can run side by side */
const partitionedConcurrency = 8

/** Events whose own ID is the community they describe */
const guildSelfEvents: ReadonlySet<EventName> = new Set(["guildCreate", "guildUpdate", "guildDelete"])
/** Events whose own ID is the channel they describe */
const channelSelfEvents: ReadonlySet<EventName> = new Set([
    "guildChannelCreate",
    "guildChannelUpdate",
    "guildChannelDelete",
    "directMessageCreate",
    "directMessageUpdate",
    "directMessageDelete",
])

/**
 * The partition key of one event. The guild partition uses the community ID, else the channel ID, so direct messages are
 * ordered per conversation, and the channel partition uses the channel ID, else the community ID. An event with neither
 * uses the empty key, shared by all such events. A function's undefined also selects the empty key
 */
function partitionKey(partition: NonNullable<Limits["partition"]>, event: EventName, payload: unknown): unknown {
    if (typeof partition === "function") return partition(payload as never)
    const value = payload as { readonly id?: unknown; readonly guildId?: unknown; readonly channelId?: unknown }
    const guild = typeof value.guildId === "string" ? value.guildId : guildSelfEvents.has(event) ? value.id : undefined
    const channel =
        typeof value.channelId === "string" ? value.channelId : channelSelfEvents.has(event) ? value.id : undefined
    const key = partition === "guild" ? (guild ?? channel) : (channel ?? guild)
    return typeof key === "string" ? key : undefined
}

/**
 * One registered event middleware in its Effect form. Each entry point adapts its public middleware to this shape,
 * and next never fails: Failures after it are reported where they occur
 */
export type InternalMiddleware = (
    invocation: EventInvocation<MessageCore>,
    next: Effect.Effect<void>,
) => Effect.Effect<unknown, unknown>

/**
 * Adapt default-API middleware. Its next promise runs the rest of the chain with the invocation's services and signal,
 * and resolves once that finishes, even after a reported failure or interruption
 */
export function defaultMiddleware(
    middleware: (invocation: EventInvocation<MessageCore>, next: () => Promise<void>, signal: AbortSignal) => unknown,
): InternalMiddleware {
    return (invocation, next) =>
        Effect.flatMap(Effect.context<never>(), (services) =>
            Effect.tryPromise({
                try: (signal) =>
                    new Promise<unknown>((resolve) => {
                        const runNext = () =>
                            Effect.runPromiseExitWith(services)(next, { signal }).then(() => undefined)
                        resolve(middleware(invocation, runNext, signal))
                    }).then(throwIfErr),
                // Keep the thrown or rejected value itself for the failure report
                catch: (error) => error,
            }),
        )
}

/**
 * Adapt native middleware to run with the services captured at registration, while its next Effect runs the rest of
 * the chain with the handler's own services
 */
export function nativeMiddleware(
    middleware: (
        invocation: EventInvocation<MessageCore>,
        next: Effect.Effect<void>,
    ) => Effect.Effect<unknown, unknown, never>,
    services: Context.Context<never>,
): InternalMiddleware {
    return (invocation, next) =>
        Effect.flatMap(Effect.context<never>(), (outer) =>
            Effect.suspend(() =>
                middleware(
                    invocation,
                    Effect.updateContext(next, () => outer),
                ),
            ).pipe(Effect.provideContext(services)),
        )
}

/** Frozen delivery details for a handler */
function eventContext(delivery: Delivery<unknown>): EventContext {
    return Object.freeze({ shardId: delivery.shardId, receivedBytes: delivery.bytes })
}

/** Identity and logging for one event source, shared with its overflow records */
export interface SourceMeta {
    readonly event: EventName
    readonly id: string
    readonly logger: (() => ClientLogger | undefined) | undefined
    /** Whether overflow ends the source. Registrations report it separately */
    readonly managed: boolean
}

/** Names commonly guessed for a readiness event, compared in lowercase */
const readyNames: ReadonlySet<string> = new Set(["ready", "clientready", "onready", "connected"])

/** Explain an unsupported event name, suggesting the closest supported one. Event names are not sensitive */
function unknownEventError(event: unknown, names: readonly string[]): ConfigurationError {
    if (typeof event !== "string" || event.length > 64)
        return new ConfigurationError("event", "Unsupported event name", {
            hint: "Use an event name such as messageCreate",
        })
    // Readiness is connection state, not an event, so point to the ways to run code at startup
    if (readyNames.has(event.toLowerCase()))
        return new ConfigurationError("event", `Unknown event name ${JSON.stringify(event)}`, {
            hint: "Fluxerly has no ready event. runBot logs when the bot is connected, and its setup option runs startup work before the bot connects. With createClient, code after client.connect() runs once the bot is connected, and client.observeState reports each connection state",
        })
    let best: string | undefined
    let distance = Infinity
    for (const name of names) {
        const candidate = editDistance(event.toLowerCase(), name.toLowerCase())
        if (candidate < distance) {
            best = name
            distance = candidate
        }
    }
    const suggestion = best !== undefined && distance <= Math.max(2, Math.floor(event.length / 3)) ? best : undefined
    return new ConfigurationError("event", `Unknown event name ${JSON.stringify(event)}`, {
        hint: `${suggestion === undefined ? "" : `Did you mean ${JSON.stringify(suggestion)}? `}Event names are listed in EventMap, such as messageCreate and guildMemberAdd`,
    })
}
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
    const supported = [
        "filter",
        "timeoutMs",
        "maxPendingMessages",
        "maxPendingBytes",
        ...(allowSignal ? ["signal"] : []),
    ]
    const unsupported = Object.keys(input).find((key) => !supported.includes(key))
    if (unsupported !== undefined)
        return new ConfigurationError("eventOptions", `Unsupported event wait option ${JSON.stringify(unsupported)}`, {
            hint: unsupportedKeyHint(unsupported, supported),
        })
    // Read each option once, so the validated values are the ones the wait uses
    const timeoutInput = input.timeoutMs
    const timeoutMs = timeoutInput === undefined ? 30_000 : timeoutInput
    if (
        typeof timeoutMs !== "number" ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > maximumTimerMs
    )
        return new ConfigurationError(
            "timeoutMs",
            `The event wait option "timeoutMs" must be a positive safe integer of at most ${maximumTimerMs} ms`,
        )
    const filter = input.filter
    if (filter !== undefined && typeof filter !== "function")
        return new ConfigurationError("filter", 'The event wait option "filter" must be a function')
    const maxPendingMessages = input.maxPendingMessages
    const maxPendingBytes = input.maxPendingBytes
    return {
        buffer: {
            ...(maxPendingMessages === undefined ? {} : { maxPendingMessages }),
            ...(maxPendingBytes === undefined ? {} : { maxPendingBytes }),
        } as EventBufferOptions,
        filter: filter as ((event: EventMap<M>[K]) => boolean) | undefined,
        timeoutMs,
    }
}

function limits(options: unknown, defaultOverflow: Limits["overflow"]): Limits | ConfigurationError {
    if (options === undefined) options = {}
    if (!record(options)) return new ConfigurationError("eventOptions", "Event options must be an object")
    const partition = options.partition
    if (partition !== undefined && partition !== "guild" && partition !== "channel" && typeof partition !== "function")
        return new ConfigurationError(
            "partition",
            'The event option "partition" must be "guild", "channel" or a function',
        )
    const defaults = {
        concurrency: partition === undefined ? 1 : partitionedConcurrency,
        maxPendingMessages: 256,
        maxPendingBytes: 4_194_304,
    }
    for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
        const value = options[key]
        if (value !== undefined) {
            if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
                return new ConfigurationError(
                    key,
                    `The event option ${JSON.stringify(key)} must be a positive safe integer`,
                )
            defaults[key] = value
        }
    }
    const overflow = options.overflow ?? defaultOverflow
    if (overflow !== "stop" && overflow !== "dropOldest" && overflow !== "dropNewest")
        return new ConfigurationError(
            "overflow",
            'The event option "overflow" must be "stop", "dropOldest" or "dropNewest"',
        )
    return { ...defaults, overflow, partition: partition as Limits["partition"] }
}

/** One bounded subscription. Gateway callbacks never await asynchronous consumer work, though a waiting synchronous filter can continue immediately after admission */
export class EventSource<A = Message> {
    readonly closed = Deferred.makeUnsafe<void, EventOverflowError>()
    readonly limits: Limits
    #pending: Delivery<A>[] = []
    #bytes = 0
    #waiters = new Set<Resume<A>>()
    #active = true
    #reading = false
    #failure: EventOverflowError | undefined
    #stopWorker: (() => void) | undefined
    #managed = false
    #cleanupCause: Cause.Cause<never> = Cause.empty
    #arrival: (() => void) | undefined
    readonly meta: SourceMeta

    constructor(
        limits: Limits,
        readonly release: () => void,
        meta: SourceMeta = { event: "messageCreate", id: "messageCreate#0", logger: undefined, managed: false },
    ) {
        this.limits = limits
        this.meta = meta
    }
    /** Stable subscription identifier used in failure reports and log records */
    get id() {
        return this.meta.id
    }
    get active() {
        return this.#active
    }
    get failure() {
        return this.#failure
    }
    /** Events waiting in this source's queue */
    get pendingCount() {
        return this.#pending.length
    }

    /** Call this function after each event that enters the queue, for a worker that selects events with takeFirst */
    onArrival(callback: () => void) {
        this.#arrival = callback
    }

    /** Remove and return the first waiting event that accept selects, or undefined when none qualifies */
    takeFirst(accept: (delivery: Delivery<A>) => boolean): Delivery<A> | undefined {
        if (!this.#active) return undefined
        const index = this.#pending.findIndex(accept)
        if (index === -1) return undefined
        const [delivery] = this.#pending.splice(index, 1)
        this.#bytes -= delivery!.bytes
        return delivery
    }

    /** Admit one event received by a shard, in a frame of the given byte length */
    offer(message: A, bytes: number, shardId = 0) {
        if (!this.#active) return
        const waiter = this.#waiters.values().next().value
        if (waiter) {
            this.#waiters.delete(waiter)
            waiter(Effect.succeed({ message, bytes, shardId }))
            return
        }
        const full = () =>
            this.#pending.length >= this.limits.maxPendingMessages || bytes > this.limits.maxPendingBytes - this.#bytes
        if (!full()) {
            this.#pending.push({ message, bytes, shardId })
            this.#bytes += bytes
            this.#arrival?.()
            return
        }
        const limit = this.#pending.length >= this.limits.maxPendingMessages ? "messages" : "bytes"
        const policy = this.limits.overflow
        if (policy === "dropOldest" && bytes <= this.limits.maxPendingBytes) {
            let dropped = 0
            while (full() && this.#pending.length) {
                this.#bytes -= this.#pending.shift()!.bytes
                dropped++
            }
            this.#pending.push({ message, bytes, shardId })
            this.#bytes += bytes
            this.#dropped(dropped, dropped === 1 ? "the oldest waiting event" : "the oldest waiting events", limit)
            this.#arrival?.()
            return
        }
        if (policy !== "stop") {
            this.#dropped(1, "the newest event", limit)
            return
        }
        const discarded = this.#pending.length + 1
        const failure = new EventOverflowError(
            limit,
            limit === "messages" ? this.limits.maxPendingMessages : this.limits.maxPendingBytes,
        )
        const logger = this.meta.logger?.()
        logger?.countDrop("overflow", discarded)
        if (!this.meta.managed)
            logger?.log({
                level: "warn",
                category: "events",
                code: "events.overflow",
                message: `The ${this.meta.event} subscription ${this.meta.id} stopped because ${limit === "messages" ? `more than ${failure.capacity} ${failure.capacity === 1 ? "event was" : "events were"} waiting (maxPendingMessages)` : `waiting events exceeded ${failure.capacity} bytes (maxPendingBytes)`}, so ${discarded} unhandled ${discarded === 1 ? "event was" : "events were"} discarded`,
                event: this.meta.event,
                subscriptionId: this.meta.id,
                fields: { limit, capacity: failure.capacity, discarded },
                error: failure,
            })
        this.stop(failure)
    }

    #dropped(count: number, which: string, limit: "messages" | "bytes") {
        const logger = this.meta.logger?.()
        if (!logger) return
        logger.drop(
            { event: "overflow", amount: count },
            {
                level: "warn",
                category: "events",
                code: "events.dropped",
                message: `The queue of the ${this.meta.event} subscription ${this.meta.id} is full (${limit === "messages" ? "maxPendingMessages" : "maxPendingBytes"}), so ${which} ${count === 1 ? "was" : "were"} dropped`,
                event: this.meta.event,
                subscriptionId: this.meta.id,
                fields: {
                    limit,
                    capacity: limit === "messages" ? this.limits.maxPendingMessages : this.limits.maxPendingBytes,
                    policy: this.limits.overflow,
                },
            },
        )
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
        this.#arrival = undefined
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
        return Effect.map(this.takeDelivery(), (delivery) => (delivery === null ? null : delivery.message))
    }

    /** Take the next event with the shard and frame size it arrived with */
    takeDelivery(): Effect.Effect<Delivery<A> | null, EventOverflowError> {
        return Effect.suspend(() => {
            if (this.#failure) return Effect.fail(this.#failure)
            if (!this.#active) return Effect.succeed(null)
            const item = this.#pending.shift()
            if (item) {
                this.#bytes -= item.bytes
                return Effect.succeed(item)
            }
            return Effect.callback<Delivery<A> | null, EventOverflowError>((resume) => {
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
        return nowMs(this.clock)
    }

    #expired() {
        return this.#now() >= this.deadline
    }

    #accept(event: EventMap<M>[K]): boolean | EventWaitError {
        if (!this.#filter) return true
        let accepted: unknown
        try {
            accepted = this.#filter(event)
        } catch (error) {
            return new EventWaitError("filter", { cause: error })
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
    constructor(
        private readonly logging?: () => ClientLogger,
        private readonly failures?: () => FailureReporter,
    ) {}
    #nextId = 0

    #reactionCollectors = new Map<
        string,
        Set<
            (reaction: MessageReaction | MessageReactionBatch, bytes: number, shardId: number, removal: boolean) => void
        >
    >()
    /** Open reaction listeners that also receive single removals, so Identify keeps MESSAGE_REACTION_REMOVE */
    #reactionRemovalListeners = 0

    /**
     * Exact message selection precedes queue admission, and user filters run outside gateway decoding.
     * With removals, single messageReactionRemove events reach the listener in the same order as additions
     */
    listenReactions(
        target: MessageReference,
        listener: (reaction: MessageReaction | MessageReactionBatch, bytes: number) => void,
        shardId?: number,
        removals = false,
    ) {
        const key = `${target.channelId}:${target.id}`
        let listeners = this.#reactionCollectors.get(key)
        if (!listeners) this.#reactionCollectors.set(key, (listeners = new Set()))
        const offer = (
            message: MessageReaction | MessageReactionBatch,
            bytes: number,
            sourceShard: number,
            removal: boolean,
        ) => {
            if ((removals || !removal) && (shardId === undefined || shardId === sourceShard)) listener(message, bytes)
        }
        listeners.add(offer)
        if (removals) this.#reactionRemovalListeners += 1
        let open = true
        return () => {
            if (!open) return
            open = false
            if (removals) this.#reactionRemovalListeners -= 1
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
        guildHealthUpdate: new Set(),
        entranceSoundPlay: new Set(),
        callCreate: new Set(),
        callUpdate: new Set(),
        callDelete: new Set(),
        raw: new Set(),
    }
    /** Registered middleware in registration order. Replaced rather than mutated, so an invocation keeps the list it started with */
    #middleware: readonly InternalMiddleware[] = []
    /** Whether the bus stopped with its client, so registration fails with ClientClosedError */
    get closed() {
        return this.#closed
    }
    /** Add middleware around later on handler invocations, returning its idempotent removal */
    addMiddleware(middleware: InternalMiddleware): () => void {
        // A wrapper gives each registration its own identity, even for a middleware function registered twice
        const entry: InternalMiddleware = (invocation, next) => middleware(invocation, next)
        this.#middleware = [...this.#middleware, entry]
        return () => {
            this.#middleware = this.#middleware.filter((candidate) => candidate !== entry)
        }
    }
    /** Whether any open source currently receives this event, so producers can skip building unused payloads */
    hasSources(event: EventName): boolean {
        return this.#sources[event].size > 0
    }
    /** Event names with at least one open subscription, stream, wait or collector */
    registeredEvents(): ReadonlySet<EventName> {
        const names = new Set(
            (Object.keys(this.#sources) as EventName[]).filter((event) => this.#sources[event].size > 0),
        )
        if (this.#collectors.size) names.add("messageCreate")
        if (this.#reactionCollectors.size) {
            names.add("messageReactionAdd")
            names.add("messageReactionAddMany")
        }
        if (this.#reactionRemovalListeners) names.add("messageReactionRemove")
        return names
    }
    #closed = false
    /** Whether intake stopped for a draining shutdown: New events and registrations are refused, admitted work continues */
    #sealed = false
    /** Handler invocations started and not yet finished, counted from admission so a drain never misses one about to start */
    #running = 0
    /** Released and replaced whenever a handler invocation finishes, so a drain can wait for progress */
    #progress = Deferred.makeUnsafe<void>()
    #closingSources: Pick<EventSource, "stop" | "closed">[] = []
    #handlerFibers = new Set<number>()
    ownsHandler(fiberId: number) {
        return this.#handlerFibers.has(fiberId)
    }
    /** Stop intake for a draining shutdown. Handlers keep running, and events already waiting in on handler queues still run */
    seal() {
        this.#sealed = true
    }
    /** Handler invocations still running and events still waiting in on handler queues */
    drainState(): { readonly running: number; readonly waiting: number } {
        let waiting = 0
        for (const sources of Object.values(this.#sources))
            for (const source of sources) if (source.meta.managed && source.active) waiting += source.pendingCount
        return { running: this.#running, waiting }
    }
    /** Wait until the next handler invocation finishes */
    progress(): Effect.Effect<void> {
        return Effect.suspend(() => Deferred.await(this.#progress))
    }
    #invocationFinished() {
        this.#running--
        this.#signalProgress()
    }
    /** Wake a waiting drain after its work changed without a finished invocation, such as a closed subscription */
    #signalProgress() {
        const released = this.#progress
        this.#progress = Deferred.makeUnsafe<void>()
        Deferred.doneUnsafe(released, Effect.void)
    }
    diagnostics() {
        return {
            subscriptions: Object.values(this.#sources).reduce((total, sources) => total + sources.size, 0),
            messageCollectors: [...this.#collectors.values()].reduce((total, listeners) => total + listeners.size, 0),
            reactionCollectors: [...this.#reactionCollectors.values()].reduce(
                (total, listeners) => total + listeners.size,
                0,
            ),
            activeHandlers: this.#handlerFibers.size,
        }
    }
    /**
     * Open a source for one event. Misuse fails with ConfigurationError before the closed check. On a closing or closed
     * bus, whenClosed "closed" returns an already-stopped source that never receives events, because shutdown can race a
     * still-running handler that registers, and whenClosed "fail" fails with ClientClosedError for one-shot waits.
     * An omitted overflow policy uses defaultOverflow, stop unless the caller names another
     */
    open<K extends EventName>(
        event: K,
        options?: EventBufferOptions | HandlerOptions,
        behavior: {
            readonly managed?: boolean
            readonly whenClosed?: "closed" | "fail"
            readonly defaultOverflow?: Limits["overflow"]
        } = {},
    ): Effect.Effect<EventSource<EventMap<M>[K]>, RegistrationError> {
        const { managed = false, whenClosed = "closed", defaultOverflow = "stop" } = behavior
        return Effect.suspend((): Effect.Effect<EventSource<EventMap<M>[K]>, RegistrationError> => {
            if (typeof event !== "string" || !Object.hasOwn(this.#sources, event))
                return Effect.fail(unknownEventError(event, Object.keys(this.#sources)))
            let settings: Limits | ConfigurationError
            try {
                settings = limits(options, defaultOverflow)
            } catch (error) {
                return Effect.failCause(inputDefect(error))
            }
            if (settings instanceof ConfigurationError) return Effect.fail(settings)
            // A draining client receives no new events, so a new registration is as closed as after shutdown
            if (this.#closed || this.#sealed)
                return whenClosed === "fail"
                    ? Effect.fail(new ClientClosedError())
                    : Effect.succeed(this.#closedSource(event, settings, managed))
            const sources = this.#sources[event]
            const source = new EventSource<EventMap<M>[K]>(
                settings,
                () => {
                    sources.delete(source)
                    this.#signalProgress()
                },
                {
                    event,
                    id: `${event}#${++this.#nextId}`,
                    logger: this.logging,
                    managed,
                },
            )
            sources.add(source)
            return Effect.succeed(source)
        })
    }
    /** A source registered after shutdown began: Stopped at once, never added to the bus and recorded as a warning */
    #closedSource<K extends EventName>(event: K, settings: Limits, managed: boolean) {
        const id = `${event}#${++this.#nextId}`
        const source = new EventSource<EventMap<M>[K]>(settings, () => undefined, {
            event,
            id,
            logger: this.logging,
            managed,
        })
        source.stop()
        this.logging?.().log({
            level: "warn",
            category: "events",
            code: "events.registeredAfterShutdown",
            message: `The ${event} subscription ${id} was registered after the client began shutting down, so it starts closed and receives no events`,
            event,
            subscriptionId: id,
        })
        return source
    }
    offer<K extends EventName>(event: K, message: EventMap<M>[K], bytes: number, shardId = 0) {
        if (this.#sealed) return
        if (
            event === "messageReactionAdd" ||
            event === "messageReactionAddMany" ||
            (event === "messageReactionRemove" && this.#reactionRemovalListeners)
        ) {
            const reaction = message as MessageReaction | MessageReactionBatch
            for (const offer of this.#reactionCollectors.get(`${reaction.channelId}:${reaction.id}`) ?? [])
                offer(reaction, bytes, shardId, event === "messageReactionRemove")
        }
        if (event === "messageCreate" && isMessageEvent<K, M>(event, message)) {
            const created = message
            for (const offer of this.#collectors.get(created.channelId) ?? []) offer(created, bytes, shardId)
        }
        for (const source of this.#sources[event]) source.offer(message, bytes, shardId)
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
        handler: (message: EventMap<M>[K], context: EventContext) => Effect.Effect<unknown, E, R>,
        options: HandlerOptions<EventMap<M>[K]> | undefined,
        onError: ((report: InternalReport) => Effect.Effect<unknown, E2, R2>) | undefined,
        scope: Scope.Scope,
        command?: string,
    ): Effect.Effect<EventSource<EventMap<M>[K]>, RegistrationError, R | R2> {
        const bus = this
        return Effect.uninterruptible(
            Effect.gen(function* () {
                if (typeof handler !== "function")
                    return yield* Effect.fail(new ConfigurationError("handler", "The event handler must be a function"))
                if (onError !== undefined && typeof onError !== "function")
                    return yield* Effect.fail(
                        new ConfigurationError("onError", 'The option "onError" must be a function'),
                    )
                // Handlers drop the oldest waiting event by default, so one burst never ends a long-lived handler
                const source = yield* bus.open(event, options, { managed: true, defaultOverflow: "dropOldest" })
                // A registration after shutdown began gets an already-closed subscription with no worker or hook queue
                if (!source.active) return source
                // The subscription's own hook gets a bounded queue with one worker in the registration context, so
                // reporting only enqueues: Hooks run one at a time in order and never hold a handler slot or shutdown
                let hooks: HookQueue | undefined
                if (onError !== undefined) {
                    const hook = onError as (report: InternalReport) => Effect.Effect<unknown, unknown>
                    const context = (yield* Effect.context<R2>()) as Context.Context<never>
                    const failures = bus.failures?.()
                    hooks = failures
                        ? failures.subscriptionQueue(hook, context)
                        : standaloneHookQueue(() => bus.logging?.(), hook, context)
                }
                const report = (kind: "handler" | "overflow", cause: Cause.Cause<unknown>, message?: unknown) =>
                    Effect.withFiber((fiber) => {
                        const logger = bus.logging?.()
                        try {
                            const internal = makeReport(
                                {
                                    kind,
                                    cause,
                                    event,
                                    command,
                                    subscriptionId: source.id,
                                    message: messageReference(message),
                                },
                                logger?.secrets,
                            )
                            if (kind === "handler") metrics.handlerFailure(command ?? event, fiber.context)
                            if (hooks) {
                                if (kind === "handler") logger?.count("handlerFailures")
                                hooks.offer(internal)
                                return Effect.void
                            }
                            const failures = bus.failures?.()
                            if (failures) failures.report(internal, fiber.context)
                            else if (logger) logHandlerReport(logger, internal, fiber.context)
                        } catch (fault) {
                            // Reporting never alters handler scheduling or subscription lifetime
                            logger?.outputFailure(fault)
                        }
                        return Effect.void
                    })
                // Failures after a middleware's next are reported where they occur, so next itself never fails and a
                // middleware cannot hide a handler failure. Interruption still ends the whole invocation. The outcome
                // records the first reported failure of one invocation for its handler observation
                type Outcome = InvocationOutcome
                const failed = (outcome: Outcome, cause: Cause.Cause<unknown>, message: EventMap<M>[K]) => {
                    outcome.failure ??= cause
                    return report("handler", cause, message)
                }
                const reported = (
                    effect: Effect.Effect<unknown, unknown, R>,
                    message: EventMap<M>[K],
                    outcome: Outcome,
                ) =>
                    effect.pipe(
                        Effect.asVoid,
                        Effect.catchCause((cause) =>
                            Cause.hasInterrupts(cause)
                                ? Effect.failCause(
                                      Cause.fromReasons<never>(
                                          cause.reasons.filter((reason) => reason._tag !== "Fail") as never,
                                      ),
                                  )
                                : failed(outcome, cause, message),
                        ),
                    )
                // Run the middleware registered when this invocation starts, first registered outermost, around the handler
                const invoke = (
                    message: EventMap<M>[K],
                    context: EventContext,
                    outcome: Outcome,
                ): Effect.Effect<unknown, unknown, R> => {
                    const chain = bus.#middleware
                    if (chain.length === 0) return handler(message, context)
                    const invocation = Object.freeze({
                        event,
                        payload: message,
                        context,
                        subscriptionId: source.id,
                    }) as EventInvocation<MessageCore>
                    const step = (index: number): Effect.Effect<unknown, unknown, R> => {
                        if (index === chain.length) return Effect.suspend(() => handler(message, context))
                        return Effect.suspend(() => {
                            let started: Deferred.Deferred<void> | undefined
                            let finished = false
                            const next: Effect.Effect<void, never, R> = Effect.suspend(() => {
                                if (finished)
                                    return failed(
                                        outcome,
                                        Cause.fail(
                                            new ConfigurationError(
                                                "next",
                                                "Event middleware called next after it finished, so the rest of the chain did not run",
                                                { hint: "Return or await the result of next inside the middleware" },
                                            ),
                                        ),
                                        message,
                                    )
                                // A repeated call observes the same run instead of invoking the handler again
                                if (started) return Deferred.await(started)
                                const done = (started = Deferred.makeUnsafe<void>())
                                return reported(step(index + 1), message, outcome).pipe(
                                    Effect.ensuring(Effect.sync(() => Deferred.doneUnsafe(done, Effect.void))),
                                )
                            })
                            return Effect.exit(
                                Effect.suspend(() => chain[index]!(invocation, next as Effect.Effect<void>)),
                            ).pipe(
                                Effect.flatMap((exit) => {
                                    finished = true
                                    // A middleware that started next without awaiting it still holds this handler slot until the chain ends
                                    return started ? Deferred.await(started).pipe(Effect.andThen(exit)) : exit
                                }),
                            )
                        })
                    }
                    return step(0)
                }
                /** Report one finished invocation to the application observer */
                const observeInvocation = (
                    exit: Exit.Exit<unknown, unknown>,
                    outcome: Outcome,
                    context: EventContext,
                    startedAt: number,
                ) => {
                    const logger = bus.logging?.()
                    const cancelled = Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
                    const failure = cancelled ? undefined : outcome.failure
                    emitObservation(logger, {
                        type: "handler",
                        event,
                        ...(outcome.command === undefined ? {} : { command: outcome.command }),
                        subscriptionId: source.id,
                        shardId: context.shardId,
                        durationMs: performance.now() - startedAt,
                        outcome: cancelled ? "cancelled" : failure ? "failure" : "success",
                        ...(failure ? failureFacts(primaryError(failure), logger?.secrets ?? []) : {}),
                    })
                }
                let active = 0
                let capacity = Deferred.makeUnsafe<void>()
                // Replace the latch before releasing it. Completion resumes the waiting loop synchronously, and a loop
                // that found the completed latch again would spin
                const wake = () => {
                    const released = capacity
                    capacity = Deferred.makeUnsafe<void>()
                    Deferred.doneUnsafe(released, Effect.void)
                }
                const partition = source.limits.partition
                /** Partition keys with a running invocation, so later events of the same key wait their turn */
                const busyKeys = new Set<string>()
                const worker = (delivery: Delivery<EventMap<M>[K]>) =>
                    Effect.withFiber((fiber) => {
                        const { message } = delivery
                        const context = eventContext(delivery)
                        const outcome: Outcome = { command, failure: undefined }
                        const startedAt = observing(bus.logging?.()) ? performance.now() : undefined
                        // Rejection records of this invocation wait for its outcome, so a failure is logged once
                        const rejections = new RejectionScope()
                        invocationOutcomes.set(rejections, outcome)
                        const invocation = Effect.gen(function* () {
                            bus.#handlerFibers.add(fiber.id)
                            yield* Effect.scoped(Effect.suspend(() => invoke(message, context, outcome))).pipe(
                                Effect.withSpan(
                                    command === undefined ? "fluxerly.event.handle" : "fluxerly.command.execute",
                                    {
                                        attributes: {
                                            "fluxerly.event": event,
                                            "fluxerly.subscription": source.id,
                                            ...(command === undefined ? {} : { "fluxerly.command": command }),
                                        },
                                    },
                                    // The SDK-internal call site gives applications nothing, and capturing it costs every invocation
                                    { captureStackTrace: false },
                                ),
                                Effect.onExit((exit) =>
                                    Effect.sync(() => {
                                        source.recordCleanup(exit)
                                    }),
                                ),
                                Effect.catchCause((cause) => {
                                    if (Cause.hasInterrupts(cause))
                                        return Effect.failCause(
                                            Cause.fromReasons(cause.reasons.filter((reason) => reason._tag !== "Fail")),
                                        )
                                    return failed(outcome, cause, message)
                                }),
                            )
                        })
                        return withRejectionScope(invocation, rejections).pipe(
                            Effect.ensuring(Effect.sync(() => rejections.end())),
                            Effect.onExit((exit) =>
                                Effect.sync(() => {
                                    invocationOutcomes.delete(rejections)
                                    if (startedAt !== undefined) observeInvocation(exit, outcome, context, startedAt)
                                }),
                            ),
                        )
                    })
                /** Release an invocation's slot and key. Runs as a fiber observer, so it also runs for a worker interrupted before it started */
                const finished = (fiberId: number, key: string | undefined) => {
                    bus.#handlerFibers.delete(fiberId)
                    active--
                    if (key !== undefined) busyKeys.delete(key)
                    bus.#invocationFinished()
                    wake()
                }
                /** The partition key of a waiting event, computed once. A throwing or invalid partition function becomes the event's failure */
                const keyOf = (delivery: Delivery<EventMap<M>[K]>): string | { readonly failure: unknown } => {
                    if (delivery.key !== undefined) return delivery.key
                    let key: string | { readonly failure: unknown }
                    try {
                        const value = partitionKey(partition!, event, delivery.message)
                        key =
                            value === undefined
                                ? ""
                                : typeof value === "string"
                                  ? value
                                  : {
                                        failure: new ConfigurationError(
                                            "partition",
                                            "The partition function must return a string or undefined",
                                        ),
                                    }
                    } catch (error) {
                        key = { failure: error }
                    }
                    delivery.key = key
                    return key
                }
                // An event whose key is running waits, while a later event of another key can start before it
                const eligible = (delivery: Delivery<EventMap<M>[K]>) => {
                    const key = keyOf(delivery)
                    return typeof key !== "string" || !busyKeys.has(key)
                }
                // Allocate work only for received messages, not one idle fiber for every configured concurrency slot
                const program = Effect.scoped(
                    Effect.gen(function* () {
                        if (partition !== undefined) source.onArrival(wake)
                        while (source.active) {
                            if (active >= source.limits.concurrency) {
                                yield* Deferred.await(capacity)
                                continue
                            }
                            let delivery: Delivery<EventMap<M>[K]> | null | undefined
                            let key: string | undefined
                            if (partition === undefined) {
                                delivery = yield* source.takeDelivery()
                                if (delivery === null || !source.active) return
                            } else {
                                // Nothing can arrive or finish between this scan and the wait, so no wake-up is missed
                                const latch = capacity
                                delivery = source.takeFirst(eligible)
                                if (delivery === undefined) {
                                    yield* Deferred.await(latch)
                                    continue
                                }
                                const selected = keyOf(delivery)
                                if (typeof selected !== "string") {
                                    // The handler cannot run without a key, so the failure is reported in its place
                                    yield* report("handler", Cause.fail(selected.failure), delivery.message)
                                    bus.#signalProgress()
                                    continue
                                }
                                key = selected
                                busyKeys.add(key)
                            }
                            active++
                            bus.#running++
                            const invocation = yield* Effect.forkScoped(
                                worker(delivery).pipe(
                                    // allow-silent: The worker reports handler failures itself, so only interruption reaches this point
                                    Effect.catchCause(() => Effect.void),
                                ),
                            )
                            const selectedKey = key
                            invocation.addObserver(() => finished(invocation.id, selectedKey))
                        }
                    }).pipe(Effect.onExit(() => Effect.sync(() => source.stop()))),
                ).pipe(
                    Effect.interruptible,
                    Effect.onExit((exit) =>
                        Effect.gen(function* () {
                            source.stop()
                            if (source.failure) yield* report("overflow", Cause.fail(source.failure))
                            source.finish(exit)
                        }),
                    ),
                    // allow-silent: The source.finish call retains the subscription outcome for waitForClose
                    Effect.catchCause(() => Effect.void),
                )
                // Effect.forkIn retains the registration caller's context, with no hidden native runPromise or detached runtime
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
            const settings = yield* readInput(() => eventWaitSettings(options, allowSignal))
            if (settings instanceof ConfigurationError) return yield* Effect.fail(settings)
            // A one-shot wait on a closing client keeps its distinct ClientClosedError failure
            const source = yield* bus.open(event, settings.buffer, { whenClosed: "fail" })
            const now = nowMs(clock)
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
