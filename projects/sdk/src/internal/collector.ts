/**
 * Message collector: Channel-scoped buffering, filters, optional progress work and terminal cleanup.
 * Invariant: The channel is chosen before buffering, synchronous filters run apart from gateway decoding, and waiting messages and
 * saved results have separate limits without REST or cache reads. Internal lifecycle transitions are observed rather than the
 * coalescing state stream. A supplied guild ties the collector to that guild's shard and conflicting source events are discarded
 * before buffering, while a channel-only collector handles gaps on every shard. Progress work runs in a collector-owned fiber under
 * the client scope, client shutdown and registration-scope closure wait for it, and terminal cleanup releases listeners, timers,
 * queued payloads and callbacks, although application-held results may outlive it. Collectors never change subscription recovery,
 * and registration and remote sending are never atomic.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import type { ClientLogger } from "./logging.js"
import { messageIds, primaryError, type FailureReporter } from "./failures.js"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as Fiber from "effect/Fiber"
import type { ConnectionState, OperationOptions } from "#sdk/client"
import {
    CollectorError,
    type CollectorFailure,
    type CollectorOptions,
    type CollectorRegistrationError,
    type CollectorResult,
} from "#sdk/collectors"
import { ClientClosedError, ConfigurationError } from "#sdk/errors"
import type { Message, MessageCore } from "#sdk/messages"
import type { ClientOwner } from "./client.js"
import { identifier, record } from "./decode/primitives.js"
import { readCaller, readInput, suspendMarked, thrownCause } from "./defects.js"
import { discardInvalidCallbackReturn } from "./invalid-callback-return.js"
import { unsupportedKeyHint } from "./suggest.js"
import type { LogicalScheduler, LogicalTimer } from "./logical-scheduler.js"

type Settings<M extends MessageCore> = Required<Omit<CollectorOptions<M>, "filter" | "guildId" | "idleMs">> &
    Pick<CollectorOptions<M>, "filter" | "guildId"> & { readonly idleMs: number | undefined } & OperationOptions

const maximumGuildId = "18446744073709551615"

function guildId(value: unknown): value is string {
    return (
        typeof value === "string" &&
        /^[1-9][0-9]{0,19}$/.test(value) &&
        (value.length < maximumGuildId.length || value <= maximumGuildId)
    )
}

/** Why a collector limit option is invalid, naming the option and, for the timers, the largest accepted value */
export function collectorBudgetMessage(key: string): string {
    return `The collector option ${JSON.stringify(key)} must be a positive safe integer${key === "timeoutMs" || key === "idleMs" ? " of at most 2147483647 ms" : ""}`
}

function settings<M extends MessageCore>(
    channelId: unknown,
    options: unknown,
    defaultApi: boolean,
): Settings<M> | ConfigurationError {
    if (!identifier(channelId)) return new ConfigurationError("channelId", "Channel ID must be a decimal string")
    const input = options === undefined ? {} : options
    if (!record(input)) return new ConfigurationError("collectorOptions", "Collector options must be an object")
    const result = {
        maxMessages: 1,
        maxBytes: 4_194_304,
        timeoutMs: 30_000,
        idleMs: undefined as number | undefined,
        maxPendingMessages: 256,
        maxPendingBytes: 4_194_304,
    }
    const supported = [...Object.keys(result), "guildId", "filter", "onMessage", ...(defaultApi ? ["signal"] : [])]
    const unsupported = Object.keys(input).find((key) => !supported.includes(key))
    if (unsupported !== undefined)
        return new ConfigurationError(
            "collectorOptions",
            `Unsupported collector option ${JSON.stringify(unsupported)}`,
            {
                hint: unsupportedKeyHint(unsupported, supported),
            },
        )
    for (const key of Object.keys(result) as (keyof typeof result)[]) {
        const value = input[key]
        if (value === undefined) continue
        if (
            typeof value !== "number" ||
            !Number.isSafeInteger(value) ||
            value <= 0 ||
            ((key === "timeoutMs" || key === "idleMs") && value > 2_147_483_647)
        )
            return new ConfigurationError(key, collectorBudgetMessage(key))
        result[key] = value
    }
    if (input.filter !== undefined && typeof input.filter !== "function")
        return new ConfigurationError("filter", "Collector filter must be a function")
    if (input.guildId !== undefined && !guildId(input.guildId))
        return new ConfigurationError("guildId", "Guild ID must be a positive uint64 decimal string")
    if (input.onMessage !== undefined && typeof input.onMessage !== "function")
        return new ConfigurationError("onMessage", 'The collector option "onMessage" must be a function')
    const signal = input.signal
    if (
        signal !== undefined &&
        (!record(signal) ||
            typeof signal.aborted !== "boolean" ||
            typeof signal.addEventListener !== "function" ||
            typeof signal.removeEventListener !== "function")
    )
        return new ConfigurationError("signal", "Collector signal must be an AbortSignal")
    return {
        ...result,
        ...(input.guildId === undefined ? {} : { guildId: input.guildId }),
        ...(input.filter === undefined ? {} : { filter: input.filter as (message: M) => boolean }),
        ...(signal === undefined ? {} : { signal: signal as unknown as NonNullable<OperationOptions["signal"]> }),
    }
}

/** One collection owns its queue, snapshots and scheduled work. Completion releases its client registration */
export class MessageCollector<M extends MessageCore = Message> {
    readonly closed = Deferred.makeUnsafe<CollectorResult<M>, CollectorFailure>()
    #active = true
    #pending: { message: M; bytes: number }[] = []
    #pendingBytes = 0
    #messages: M[] = []
    #ids = new Set<string>()
    #bytes = 0
    #timer: LogicalTimer | undefined
    #drain: ReturnType<typeof setImmediate> | undefined
    #release: (() => void) | undefined
    #settings: Settings<M> | undefined
    readonly #deadline: number
    #idleDeadline: number
    #busy = false
    #next = Deferred.makeUnsafe<M>()
    #worker: Fiber.Fiber<void> | undefined
    #outcome: Exit.Exit<CollectorResult<M>, CollectorFailure> | undefined
    #untrack: (() => void) | undefined
    #logger: ClientLogger | undefined
    #failures: FailureReporter | undefined

    owns(fiberId: number) {
        return this.#worker?.id === fiberId
    }

    run<E, R>(owner: ClientOwner<M>, handler: (message: M) => Effect.Effect<unknown, E, R>) {
        const collector = this
        return Effect.gen(function* () {
            collector.#untrack = owner.trackMessageCollector(collector)
            collector.#logger = owner.logging
            collector.#failures = owner.failures
            const work = Effect.gen(function* () {
                while (collector.#active) {
                    const message = yield* Deferred.await(collector.#next)
                    collector.#next = Deferred.makeUnsafe<M>()
                    yield* Effect.scoped(Effect.suspend(() => handler(message))).pipe(
                        Effect.catchCause((cause) =>
                            !collector.#active && Cause.hasDies(cause)
                                ? Effect.failCause(
                                      Cause.fromReasons<never>(
                                          cause.reasons.filter((reason) => reason._tag !== "Fail"),
                                      ),
                                  )
                                : Effect.sync(() =>
                                      collector.fail(collector.#handlerFailure(cause), { cause, item: message }),
                                  ),
                        ),
                    )
                    collector.#busy = false
                    if (!collector.#active) return
                    if (collector.#expired()) return
                    if (collector.#messages.length === collector.#settings!.maxMessages) collector.#succeed("limit")
                    else collector.#scheduleDrain()
                }
            }).pipe(
                Effect.interruptible,
                Effect.onExit((exit) => Effect.sync(() => collector.#workerFinished(exit))),
            )
            collector.#worker = yield* Effect.forkIn(work, owner.scope, { uninterruptible: true })
        })
    }

    #handlerFailure(cause: Cause.Cause<unknown>) {
        return new CollectorError("handler", null, null, { cause: primaryError(cause) })
    }

    #workerFinished(exit: Exit.Exit<void, unknown>) {
        if (this.#active) this.stop()
        this.#worker = undefined
        if (Exit.isFailure(exit) && Cause.hasDies(exit.cause)) {
            const cause = Cause.fromReasons<CollectorFailure>(
                exit.cause.reasons.filter((reason) => reason._tag === "Die"),
            )
            this.#outcome = Exit.failCause(
                Cause.combine(
                    this.#outcome && Exit.isFailure(this.#outcome) ? this.#outcome.cause : Cause.empty,
                    cause,
                ),
            )
        }
        this.#complete()
    }

    constructor(
        settings: Settings<M>,
        private readonly logical: LogicalScheduler,
    ) {
        this.#settings = settings
        const now = this.#now()
        this.#deadline = now + settings.timeoutMs
        this.#idleDeadline = settings.idleMs === undefined ? Infinity : now + settings.idleMs
    }

    #now() {
        return this.logical.now()
    }

    start(owner: ClientOwner<M>, channelId: string) {
        // Filter failures need these even when no callback worker runs
        this.#logger = owner.logging
        this.#failures = owner.failures
        const settings = this.#settings!
        const signal = settings.signal
        const abort = () => this.#finish(Exit.interrupt())
        const shardId = settings.guildId === undefined ? undefined : owner.shardIdForGuild(settings.guildId)
        const intake = owner.events.listenMessages(channelId, this.#offer.bind(this), shardId)
        let state: (() => void) | undefined
        this.#release = () => {
            intake()
            state?.()
            readCaller(() => signal?.removeEventListener("abort", abort))
        }
        try {
            state =
                settings.guildId === undefined
                    ? owner.subscribe(this.#stateChanged.bind(this))
                    : owner.subscribeGateway(settings.guildId, this.#stateChanged.bind(this))
            if (!this.#active) state()
            readCaller(() => signal?.addEventListener("abort", abort, { once: true }))
            if (readCaller(() => signal?.aborted)) abort()
            if (this.#active) this.#scheduleDeadline()
        } catch (error) {
            this.#finish(Exit.failCause(thrownCause(error)))
            throw error
        }
    }

    #stateChanged(state: ConnectionState) {
        if (state === "Recovering" || state === "Disconnected") this.fail(new CollectorError("connectionLost"))
        else if (state === "Closing" || state === "Closed") this.fail(new ClientClosedError())
    }

    #scheduleDeadline() {
        this.#timer = this.logical.set(
            () => {
                this.#timer = undefined
                this.#guard(() => {
                    if (!this.#expired()) this.#scheduleDeadline()
                })
            },
            Math.max(1, Math.ceil(Math.min(this.#deadline, this.#idleDeadline) - this.#now())),
            "message collector",
        )
    }

    #expired() {
        if (this.#now() < Math.min(this.#deadline, this.#idleDeadline)) return false
        this.#succeed(this.#idleDeadline < this.#deadline ? "idle" : "timeout")
        return true
    }

    #guard(work: () => void) {
        if (!this.#active) return
        try {
            work()
        } catch (error) {
            this.#finish(Exit.die(error))
        }
    }

    #offer(message: M, bytes: number) {
        if (!this.#active) return
        if (this.#busy && this.#messages.length === this.#settings!.maxMessages) {
            // The collector is full and finishing its last callback, so later events cannot join the result
            this.#logger?.drop(
                { event: "collector" },
                {
                    level: "debug",
                    category: "collectors",
                    code: "collectors.dropped",
                    message: "A full message collector ignored an event while its last callback finished",
                },
            )
            return
        }
        try {
            if (this.#expired()) return
            const settings = this.#settings!
            if (settings.guildId !== undefined && message.guildId !== undefined && message.guildId !== settings.guildId)
                return
            const limit =
                this.#pending.length >= settings.maxPendingMessages
                    ? "maxPendingMessages"
                    : bytes > settings.maxPendingBytes - this.#pendingBytes
                      ? "maxPendingBytes"
                      : undefined
            if (limit) return this.fail(new CollectorError("overflow", limit, settings[limit]))
            this.#pending.push({ message, bytes })
            this.#pendingBytes += bytes
            this.#scheduleDrain()
        } catch (error) {
            this.#finish(Exit.die(error))
        }
    }

    #scheduleDrain() {
        if (this.#busy || !this.#active) return
        // Do not create this callback inside offer: Retained error stacks can keep its closure and the offered payload alive
        this.#drain ??= setImmediate(() => {
            this.#drain = undefined
            this.#guard(() => this.#consume())
        })
    }

    #consume() {
        while (this.#active && this.#pending.length) {
            if (this.#expired()) return
            const { message, bytes } = this.#pending.shift()!
            this.#pendingBytes -= bytes
            if (this.#ids.has(message.id)) continue
            let accepted: unknown
            try {
                accepted = this.#settings!.filter ? this.#settings!.filter(message) : true
            } catch (error) {
                return this.fail(new CollectorError("filter", null, null, { cause: error }), { item: message })
            }
            discardInvalidCallbackReturn(accepted)
            if (!this.#active) return
            if (this.#expired()) return
            if (typeof accepted !== "boolean") return this.fail(new CollectorError("filter"), { item: message })
            if (!accepted) continue
            const size = Buffer.byteLength(JSON.stringify(message))
            if (this.#expired()) return
            if (size > this.#settings!.maxBytes - this.#bytes)
                return this.fail(new CollectorError("overflow", "maxBytes", this.#settings!.maxBytes))
            this.#messages.push(message)
            this.#ids.add(message.id)
            this.#bytes += size
            // Renewal only moves the quiet deadline later. The existing timer rechecks it before completing
            if (this.#settings!.idleMs !== undefined) this.#idleDeadline = this.#now() + this.#settings!.idleMs
            if (this.#worker) {
                this.#busy = true
                Deferred.doneUnsafe(this.#next, Effect.succeed(message))
                return
            }
            if (this.#messages.length === this.#settings!.maxMessages) return this.#succeed("limit")
        }
    }

    stop() {
        this.#succeed("stopped")
    }
    /** End the collector with a failure. A failed application filter or callback is also reported with its original
     * value through the client's onError, or logged at Error, while waitForClose still returns the CollectorError
     */
    fail(error: CollectorFailure, source?: { readonly cause?: Cause.Cause<unknown>; readonly item?: M }) {
        if (this.#active && error instanceof CollectorError && error.reason !== "connectionLost") {
            if ((error.reason === "handler" || error.reason === "filter") && this.#failures) {
                // The result keeps this error. Serializing its stack now releases the frames V8 captured with it, whose
                // closures would otherwise keep the failed item and callbacks alive for as long as the result is held
                void error.stack
                this.#failures.report({
                    kind: error.reason === "filter" ? "filter" : "collector",
                    error: error.cause ?? error,
                    cause: source?.cause,
                    message: source?.item === undefined ? undefined : messageIds(source.item),
                })
            } else
                this.#logger?.log({
                    level: "warn",
                    category: "collectors",
                    code: "collectors.failed",
                    message: `A message collector failed: ${error.message}`,
                    fields: { reason: error.reason },
                    error,
                    origin: error.reason === "handler" || error.reason === "filter" ? "application" : "sdk",
                })
        }
        this.#finish(Exit.fail(error))
    }
    #succeed(reason: CollectorResult<M>["reason"]) {
        if (this.#active) this.#finish(Exit.succeed(Object.freeze({ messages: Object.freeze(this.#messages), reason })))
    }
    #finish(outcome: Exit.Exit<CollectorResult<M>, CollectorFailure>) {
        if (!this.#active) return
        this.#active = false
        this.logical.clear(this.#timer)
        if (this.#drain !== undefined) clearImmediate(this.#drain)
        this.#timer = undefined
        this.#drain = undefined
        this.#pending = []
        this.#messages = []
        this.#ids.clear()
        this.#bytes = this.#pendingBytes = 0
        this.#settings = undefined
        const release = this.#release
        this.#release = undefined
        try {
            release?.()
        } catch (error) {
            outcome = Exit.failCause(
                Cause.combine(Exit.isFailure(outcome) ? outcome.cause : Cause.empty, thrownCause(error)),
            )
        }
        this.#outcome = outcome
        if (this.#worker) this.#worker.interruptUnsafe()
        else this.#complete()
    }
    #complete() {
        this.#untrack?.()
        this.#untrack = undefined
        this.#next = Deferred.makeUnsafe<M>()
        if (this.#outcome) Deferred.doneUnsafe(this.closed, this.#outcome)
    }
}

export function collect<E = never, R = never, M extends MessageCore = Message>(
    owner: ClientOwner<M>,
    channelId: string,
    options?: CollectorOptions<M>,
    defaultApi = false,
    handler?: (message: M) => Effect.Effect<unknown, E, R>,
): Effect.Effect<MessageCollector<M>, CollectorRegistrationError, R> {
    return Effect.gen(function* () {
        const config = yield* readInput(() => settings<M>(channelId, options, defaultApi))
        if (config instanceof ConfigurationError) return yield* Effect.fail(config)
        // Misuse is checked first. A closing client is a shutdown race, which the bindings return as a failed handle
        if (owner.state === "Closing" || owner.state === "Closed") return yield* Effect.fail(new ClientClosedError())
        if (yield* readInput(() => config.signal?.aborted)) return yield* Effect.interrupt
        if (config.guildId === undefined) {
            if (owner.state !== "Connected") return yield* Effect.fail(new CollectorError("notConnected"))
        } else if (
            owner.shardIdForGuild(config.guildId) === undefined ||
            owner.gatewayState(config.guildId) !== "Connected"
        )
            return yield* Effect.fail(new CollectorError("notConnected"))
        const collector = new MessageCollector<M>(config, owner.logical)
        if (handler) yield* collector.run(owner, handler)
        // The caller signal methods are marked reads, so their throws are application faults
        yield* suspendMarked(() => {
            collector.start(owner, channelId)
            return Effect.void
        })
        return collector
    })
}
