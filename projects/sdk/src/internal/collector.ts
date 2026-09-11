import { Cause, Clock, Deferred, Effect, Exit, type Fiber } from "effect"
import type { ConnectionState, OperationOptions } from "#sdk/client"
import {
    CollectorError,
    type CollectorFailure,
    type CollectorOptions,
    type CollectorRegistrationError,
    type CollectorResult,
} from "#sdk/collectors"
import { ClientClosedError, ConfigurationError } from "#sdk/errors"
import type { Message } from "#sdk/messages"
import type { ClientOwner } from "./client.js"
import { identifier, record } from "./message.js"

type Settings = Required<Omit<CollectorOptions, "filter" | "guildId">> &
    Pick<CollectorOptions, "filter" | "guildId"> &
    OperationOptions

const maximumGuildId = "18446744073709551615"

function guildId(value: unknown): value is string {
    return (
        typeof value === "string" &&
        /^[1-9][0-9]{0,19}$/.test(value) &&
        (value.length < maximumGuildId.length || value <= maximumGuildId)
    )
}

function settings(channelId: unknown, options: unknown, defaultApi: boolean): Settings | ConfigurationError {
    if (!identifier(channelId)) return new ConfigurationError("channelId", "Channel ID must be a decimal string")
    const input = options === undefined ? {} : options
    if (!record(input)) return new ConfigurationError("collectorOptions", "Collector options must be an object")
    const result = {
        maxMessages: 1,
        maxBytes: 4_194_304,
        timeoutMs: 30_000,
        maxPendingMessages: 256,
        maxPendingBytes: 4_194_304,
    }
    if (
        Object.keys(input).some(
            (key) =>
                !Object.hasOwn(result, key) &&
                key !== "guildId" &&
                key !== "filter" &&
                key !== "onMessage" &&
                !(defaultApi && key === "signal"),
        )
    )
        return new ConfigurationError("collectorOptions", "Unsupported collector option")
    for (const key of Object.keys(result) as (keyof typeof result)[]) {
        const value = input[key]
        if (value === undefined) continue
        if (
            typeof value !== "number" ||
            !Number.isSafeInteger(value) ||
            value <= 0 ||
            (key === "timeoutMs" && value > 2_147_483_647)
        )
            return new ConfigurationError(
                key,
                "Collector budgets must be positive safe integers within the timer range",
            )
        result[key] = value
    }
    if (input.filter !== undefined && typeof input.filter !== "function")
        return new ConfigurationError("filter", "Collector filter must be a function")
    if (input.guildId !== undefined && !guildId(input.guildId))
        return new ConfigurationError("guildId", "Guild ID must be a positive uint64 decimal string")
    if (input.onMessage !== undefined && typeof input.onMessage !== "function")
        return new ConfigurationError("onMessage", "Message handler must be a function")
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
        ...(input.filter === undefined ? {} : { filter: input.filter as (message: Message) => boolean }),
        ...(signal === undefined ? {} : { signal: signal as unknown as NonNullable<OperationOptions["signal"]> }),
    }
}

/** One collection owns its queue, snapshots and scheduled work. Completion releases its client registration */
export class MessageCollector {
    readonly closed = Deferred.makeUnsafe<CollectorResult, CollectorFailure>()
    #active = true
    #pending: { message: Message; bytes: number }[] = []
    #pendingBytes = 0
    #messages: Message[] = []
    #ids = new Set<string>()
    #bytes = 0
    #timer: ReturnType<typeof setTimeout> | undefined
    #drain: ReturnType<typeof setImmediate> | undefined
    #release: (() => void) | undefined
    #settings: Settings | undefined
    readonly #deadline: number
    #busy = false
    #next = Deferred.makeUnsafe<Message>()
    #worker: Fiber.Fiber<void> | undefined
    #outcome: Exit.Exit<CollectorResult, CollectorFailure> | undefined
    #untrack: (() => void) | undefined

    owns(fiberId: number) {
        return this.#worker?.id === fiberId
    }

    run<E, R>(owner: ClientOwner, handler: (message: Message) => Effect.Effect<unknown, E, R>) {
        const collector = this
        return Effect.gen(function* () {
            collector.#untrack = owner.trackMessageCollector(collector)
            const work = Effect.gen(function* () {
                while (collector.#active) {
                    const message = yield* Deferred.await(collector.#next)
                    collector.#next = Deferred.makeUnsafe<Message>()
                    yield* Effect.scoped(Effect.suspend(() => handler(message))).pipe(
                        Effect.catchCause((cause) =>
                            !collector.#active && Cause.hasDies(cause)
                                ? Effect.failCause(
                                      Cause.fromReasons<never>(
                                          cause.reasons.filter((reason) => reason._tag !== "Fail"),
                                      ),
                                  )
                                : Effect.sync(() => collector.fail(collector.#handlerFailure())),
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

    #handlerFailure() {
        const error = new CollectorError("handler")
        // Materialize the retained safe stack without keeping its callback frame alive
        const stack = error.stack
        if (stack !== undefined) error.stack = stack
        return error
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
        settings: Settings,
        private readonly clock: Clock.Clock,
    ) {
        this.#settings = settings
        this.#deadline = this.#now() + settings.timeoutMs
    }

    #now() {
        return Number(this.clock.monotonicTimeNanosUnsafe()) / 1_000_000
    }

    start(owner: ClientOwner, channelId: string) {
        const settings = this.#settings!
        const signal = settings.signal
        const abort = () => this.#finish(Exit.interrupt())
        const shardId = settings.guildId === undefined ? undefined : owner.shardIdForGuild(settings.guildId)
        const intake = owner.events.listenMessages(channelId, this.#offer.bind(this), shardId)
        let state: (() => void) | undefined
        this.#release = () => {
            intake()
            state?.()
            signal?.removeEventListener("abort", abort)
        }
        try {
            state =
                settings.guildId === undefined
                    ? owner.subscribe(this.#stateChanged.bind(this))
                    : owner.subscribeGateway(settings.guildId, this.#stateChanged.bind(this))
            if (!this.#active) state()
            signal?.addEventListener("abort", abort, { once: true })
            if (signal?.aborted) abort()
            if (this.#active) this.#scheduleDeadline()
        } catch (error) {
            this.#finish(Exit.die(error))
            throw error
        }
    }

    #stateChanged(state: ConnectionState) {
        if (state === "Recovering" || state === "Disconnected") this.fail(new CollectorError("connectionLost"))
        else if (state === "Closing" || state === "Closed") this.fail(new ClientClosedError())
    }

    #scheduleDeadline() {
        this.#timer = setTimeout(
            () => {
                this.#timer = undefined
                this.#guard(() => {
                    if (!this.#expired()) this.#scheduleDeadline()
                })
            },
            Math.max(1, Math.ceil(this.#deadline - this.#now())),
        )
    }

    #expired() {
        if (this.#now() < this.#deadline) return false
        this.#succeed("timeout")
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

    #offer(message: Message, bytes: number) {
        if (!this.#active) return
        if (this.#busy && this.#messages.length === this.#settings!.maxMessages) return
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
            } catch {
                return this.fail(new CollectorError("filter"))
            }
            if (accepted instanceof Promise) void accepted.catch(() => undefined)
            if (!this.#active) return
            if (this.#expired()) return
            if (typeof accepted !== "boolean") return this.fail(new CollectorError("filter"))
            if (!accepted) continue
            const size = Buffer.byteLength(JSON.stringify(message))
            if (size > this.#settings!.maxBytes - this.#bytes)
                return this.fail(new CollectorError("overflow", "maxBytes", this.#settings!.maxBytes))
            this.#messages.push(message)
            this.#ids.add(message.id)
            this.#bytes += size
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
    fail(error: CollectorFailure) {
        this.#finish(Exit.fail(error))
    }
    #succeed(reason: CollectorResult["reason"]) {
        if (this.#active) this.#finish(Exit.succeed(Object.freeze({ messages: Object.freeze(this.#messages), reason })))
    }
    #finish(outcome: Exit.Exit<CollectorResult, CollectorFailure>) {
        if (!this.#active) return
        this.#active = false
        if (this.#timer !== undefined) clearTimeout(this.#timer)
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
                Cause.combine(Exit.isFailure(outcome) ? outcome.cause : Cause.empty, Cause.die(error)),
            )
        }
        this.#outcome = outcome
        if (this.#worker) this.#worker.interruptUnsafe()
        else this.#complete()
    }
    #complete() {
        this.#untrack?.()
        this.#untrack = undefined
        this.#next = Deferred.makeUnsafe<Message>()
        if (this.#outcome) Deferred.doneUnsafe(this.closed, this.#outcome)
    }
}

export function collect<E = never, R = never>(
    owner: ClientOwner,
    channelId: string,
    options?: CollectorOptions,
    defaultApi = false,
    handler?: (message: Message) => Effect.Effect<unknown, E, R>,
): Effect.Effect<MessageCollector, CollectorRegistrationError, R> {
    return Effect.gen(function* () {
        if (owner.state === "Closing" || owner.state === "Closed") return yield* Effect.fail(new ClientClosedError())
        const config = settings(channelId, options, defaultApi)
        if (config instanceof ConfigurationError) return yield* Effect.fail(config)
        if (config.signal?.aborted) return yield* Effect.interrupt
        if (config.guildId === undefined) {
            if (owner.state !== "Connected") return yield* Effect.fail(new CollectorError("notConnected"))
        } else if (
            owner.shardIdForGuild(config.guildId) === undefined ||
            owner.gatewayState(config.guildId) !== "Connected"
        )
            return yield* Effect.fail(new CollectorError("notConnected"))
        const clock = yield* Clock.Clock
        const collector = new MessageCollector(config, clock)
        if (handler) yield* collector.run(owner, handler)
        collector.start(owner, channelId)
        return collector
    })
}
