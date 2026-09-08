import { Cause, Clock, Deferred, Effect, Exit } from "effect"
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

type Settings = Required<Omit<CollectorOptions, "filter">> & Pick<CollectorOptions, "filter"> & OperationOptions

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
            (key) => !Object.hasOwn(result, key) && key !== "filter" && !(defaultApi && key === "signal"),
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
        ...(input.filter === undefined ? {} : { filter: input.filter as (message: Message) => boolean }),
        ...(signal === undefined ? {} : { signal: signal as NonNullable<OperationOptions["signal"]> }),
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
        const signal = this.#settings!.signal
        const abort = () => this.#finish(Exit.interrupt())
        const intake = owner.events.listenMessages(channelId, this.#offer.bind(this))
        const state = owner.subscribe(this.#stateChanged.bind(this))
        this.#release = () => {
            intake()
            state()
            signal?.removeEventListener("abort", abort)
        }
        try {
            signal?.addEventListener("abort", abort, { once: true })
            if (signal?.aborted) abort()
            if (this.#active) this.#scheduleDeadline()
        } catch (error) {
            this.#finish(Exit.die(error))
            throw error
        }
    }

    #stateChanged(state: ConnectionState) {
        if (state === "Recovering") this.fail(new CollectorError("connectionLost"))
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
        try {
            if (this.#expired()) return
            const settings = this.#settings!
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
        Deferred.doneUnsafe(this.closed, outcome)
    }
}

export function collect(
    owner: ClientOwner,
    channelId: string,
    options?: CollectorOptions,
    defaultApi = false,
): Effect.Effect<MessageCollector, CollectorRegistrationError> {
    return Effect.gen(function* () {
        if (owner.state === "Closing" || owner.state === "Closed") return yield* Effect.fail(new ClientClosedError())
        const config = settings(channelId, options, defaultApi)
        if (config instanceof ConfigurationError) return yield* Effect.fail(config)
        if (config.signal?.aborted) return yield* Effect.interrupt
        if (owner.state !== "Connected") return yield* Effect.fail(new CollectorError("notConnected"))
        const clock = yield* Clock.Clock
        const collector = new MessageCollector(config, clock)
        collector.start(owner, channelId)
        return collector
    })
}
