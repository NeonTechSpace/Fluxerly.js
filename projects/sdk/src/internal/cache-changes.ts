/**
 * Cache change notifications: One client-wide hub that every client-owned cache reports set, delete and clear changes to.
 * Invariant: Notification never changes a cache result, event delivery or REST outcome. Caches only record a change after
 * applying it and build no record while no observer is registered. Records are delivered in applied order from a microtask
 * after the synchronous cache work that produced them, so a listener never runs inside a cache operation, and a failing
 * listener is reported as a cache failure without affecting other listeners. Each listener holds at most its concurrency
 * of unfinished calls and its maxPendingChanges of waiting changes, and a full queue drops its oldest change with a logged
 * and counted Warn, so a stuck listener cannot grow memory. Client closure hands the final clears to listeners with a free
 * call, then closes every observer without waiting for unfinished calls, dropping the changes still waiting with the same
 * logged and counted Warn. Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import * as Cause from "effect/Cause"
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as Fiber from "effect/Fiber"
import type * as Scope from "effect/Scope"
import type { CacheChange, CacheObserverOptions } from "#sdk/cache"
import type { CacheKind } from "#sdk/client"
import { ConfigurationError } from "#sdk/errors"
import type { MessageCore } from "#sdk/messages"
import type { CacheObserver } from "#sdk/api/default/cache"
import type { CacheObserver as NativeCacheObserver } from "#sdk/api/effect/cache"
import { localValue } from "#sdk/internal/binding/execute"
import type { ClientOwner } from "./client.js"
import { record as isRecord } from "./decode/primitives.js"
import { suspendInput } from "./defects.js"
import { throwIfErr } from "./failures.js"
import type { ClientLogger } from "./logging.js"
import { unsupportedKeyHint } from "./suggest.js"

/** One registered listener in either entry point's form */
interface Observer {
    /** Emission sequence number at registration. Only later records are delivered */
    readonly since: number
    deliver(change: CacheChange): void
    close(): void
}

type Queued = { readonly sequence: number; readonly change: CacheChange }

/** Client-wide cache change fan-out. Caches call record after applying a change */
export class CacheChangeHub {
    readonly #observers = new Set<Observer>()
    #queue: Queued[] = []
    #sequence = 0
    #ids = 0
    #scheduled = false
    #closed = false
    #watching = false

    /** Whether any listener is registered, so caches can skip building change records */
    get active(): boolean {
        return this.#observers.size > 0
    }

    /** Queue one applied change for the registered listeners. Never runs a listener inline and never throws */
    record(kind: CacheKind, op: CacheChange["op"], key: string | null): void {
        if (this.#observers.size === 0) return
        this.#queue.push({ sequence: ++this.#sequence, change: Object.freeze({ kind, op, key }) })
        if (this.#scheduled) return
        this.#scheduled = true
        queueMicrotask(() => this.#flush())
    }

    #flush() {
        this.#scheduled = false
        // Changes a listener causes are appended to a fresh queue and delivered by this same loop, in applied order
        while (this.#queue.length) {
            const batch = this.#queue
            this.#queue = []
            for (const { sequence, change } of batch)
                for (const observer of this.#observers) if (observer.since < sequence) observer.deliver(change)
        }
    }

    /** A new observer identifier, also given to registrations after closure */
    nextId(): string {
        return `cacheChange#${++this.#ids}`
    }

    /** Register an observer, or return undefined after client closure, when no further change can occur */
    add(create: (since: number) => Observer): Observer | undefined {
        if (this.#closed) return undefined
        const observer = create(this.#sequence)
        this.#observers.add(observer)
        return observer
    }

    remove(observer: Observer) {
        this.#observers.delete(observer)
        if (this.#observers.size === 0) this.#queue = []
    }

    /** Close every observer once its owner client closes. Watching starts with the first registration */
    watch(owner: Pick<ClientOwner<MessageCore>, "subscribe">) {
        if (this.#watching) return
        this.#watching = true
        owner.subscribe((state) => {
            if (state === "Closed") this.close()
        })
    }

    /**
     * Deliver the changes already recorded, including shutdown's final clears, then close every observer. A listener
     * at its concurrency keeps them waiting, so its observer drops them with a Warn rather than holding shutdown
     */
    close() {
        if (this.#closed) return
        this.#flush()
        this.#closed = true
        for (const observer of this.#observers) observer.close()
        this.#observers.clear()
        this.#queue = []
    }
}

type Bounds = { readonly concurrency: number; readonly maxPendingChanges: number }
const boundKeys = ["concurrency", "maxPendingChanges"] as const

/** The validated onChange options, each read once. A throwing read dies as an application fault */
const observerBounds = (options: unknown): Effect.Effect<Bounds, ConfigurationError> =>
    suspendInput(() => {
        if (options === undefined) options = {}
        if (!isRecord(options))
            return Effect.fail(
                new ConfigurationError("cacheObserverOptions", "Cache observer options must be an object"),
            )
        const unsupported = Object.keys(options).find((key) => !(boundKeys as readonly string[]).includes(key))
        if (unsupported !== undefined)
            return Effect.fail(
                new ConfigurationError(
                    "cacheObserverOptions",
                    `Unsupported option ${JSON.stringify(unsupported)} in the cache observer options`,
                    { hint: unsupportedKeyHint(unsupported, boundKeys) },
                ),
            )
        const bounds = { concurrency: 256, maxPendingChanges: 256 }
        for (const key of boundKeys) {
            const value = options[key]
            if (value === undefined) continue
            if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
                return Effect.fail(
                    new ConfigurationError(
                        key,
                        `The cache observer option ${JSON.stringify(key)} must be a positive safe integer`,
                    ),
                )
            bounds[key] = value
        }
        return Effect.succeed(bounds)
    })

/**
 * Bounded delivery to one listener: At most concurrency calls are unfinished, later changes wait in applied order, and a
 * change arriving while maxPendingChanges wait drops the oldest waiting change with a counted Warn
 */
class ListenerQueue {
    #running = 0
    #waiting: CacheChange[] = []
    #dropped = 0
    #draining = false
    #open = true

    constructor(
        readonly id: string,
        private readonly bounds: Bounds,
        private readonly logger: ClientLogger,
        /** Start one listener call. It never throws and calls done once that call has finished */
        private readonly start: (change: CacheChange, done: () => void) => void,
    ) {}

    deliver(change: CacheChange) {
        if (!this.#open) return
        if (this.#running < this.bounds.concurrency && this.#waiting.length === 0) {
            this.#run(change)
            return
        }
        if (this.#waiting.length >= this.bounds.maxPendingChanges) {
            this.#waiting.shift()
            this.#drop()
        }
        this.#waiting.push(change)
    }

    /**
     * Stop delivery and discard waiting changes. At client shutdown, which never waits for unfinished calls, the
     * discarded changes are logged and counted as drops
     */
    close(shutdown = false) {
        this.#open = false
        const discarded = this.#waiting.length
        this.#waiting = []
        if (!shutdown || discarded === 0) return
        this.#dropped += discarded
        const { concurrency } = this.bounds
        this.logger.count("cacheChangesDropped", discarded)
        this.logger.log({
            level: "warn",
            category: "cache",
            code: "cache.changesDropped",
            message: `The client shut down while ${discarded} ${discarded === 1 ? "change" : "changes"} waited for the cache.onChange listener ${this.id}, which had ${concurrency} unfinished ${concurrency === 1 ? "call" : "calls"} (concurrency), so ${discarded === 1 ? "it was" : "they were"} dropped`,
            subscriptionId: this.id,
            fields: { dropped: this.#dropped, concurrency, maxPendingChanges: this.bounds.maxPendingChanges },
        })
    }

    #run(change: CacheChange) {
        this.#running++
        let finished = false
        this.start(change, () => {
            if (finished) return
            finished = true
            this.#running--
            this.#drain()
        })
    }

    /** Start waiting changes while calls are free. Calls that finish synchronously continue this loop rather than nest */
    #drain() {
        if (this.#draining) return
        this.#draining = true
        try {
            while (this.#open && this.#running < this.bounds.concurrency && this.#waiting.length)
                this.#run(this.#waiting.shift()!)
        } finally {
            this.#draining = false
        }
    }

    #drop() {
        this.#dropped++
        const { concurrency, maxPendingChanges } = this.bounds
        // The message stays the same for every drop, so repeats collapse while fields.dropped carries the latest total
        this.logger.drop("cacheChangesDropped", {
            level: "warn",
            category: "cache",
            code: "cache.changesDropped",
            message: `The cache.onChange listener ${this.id} has ${concurrency} unfinished ${concurrency === 1 ? "call" : "calls"} (concurrency) and ${maxPendingChanges} waiting ${maxPendingChanges === 1 ? "change" : "changes"} (maxPendingChanges), so the oldest waiting change was dropped`,
            subscriptionId: this.id,
            fields: { dropped: this.#dropped, concurrency, maxPendingChanges },
        })
    }
}

/** A listener's failure as a client cache report. Reporting never throws */
function reportFailure<M extends MessageCore>(
    owner: ClientOwner<M>,
    input: { readonly error: unknown } | { readonly cause: Cause.Cause<unknown> },
) {
    owner.failures.report({ kind: "cache", ...input })
}

const closedObserver = (id: string): CacheObserver =>
    Object.freeze({ id, close: () => undefined, [Symbol.dispose]: () => undefined })

/** Default-API cache.onChange: Listeners run from a microtask, and returned promises are observed but not awaited */
export const defaultCacheOnChange =
    <M extends MessageCore>({ owner }: { readonly owner: ClientOwner<M> }) =>
    (listener: (change: CacheChange) => unknown, options?: CacheObserverOptions): CacheObserver => {
        if (typeof listener !== "function")
            throw new ConfigurationError("listener", "Cache change listener must be a function")
        const bounds = localValue(observerBounds(options), "cache.onChange")
        const hub = owner.cacheChanges
        hub.watch(owner)
        const id = hub.nextId()
        const report = (error: unknown) => reportFailure(owner, { error })
        const queue = new ListenerQueue(id, bounds, owner.logging, (change, done) => {
            let settled: Promise<unknown> | undefined
            try {
                const result = listener(change)
                if (
                    typeof result === "object" &&
                    result !== null &&
                    typeof (result as { then?: unknown }).then === "function"
                )
                    settled = Promise.resolve(result).then(throwIfErr)
                else throwIfErr(result)
            } catch (error) {
                report(error)
            }
            if (settled === undefined) done()
            else void settled.catch(report).then(done)
        })
        let open = true
        const observer = hub.add((since) => ({
            since,
            deliver: (change) => queue.deliver(change),
            // The hub closes observers only at client shutdown
            close: () => {
                open = false
                queue.close(true)
            },
        }))
        if (!observer) return closedObserver(id)
        const close = () => {
            if (!open) return
            open = false
            queue.close()
            hub.remove(observer)
        }
        return Object.freeze({ id, close, [Symbol.dispose]: close })
    }

/** Native cache.onChange: Each change forks the listener Effect with the registration services, closed with its Scope */
export const nativeCacheOnChange =
    <M extends MessageCore>(owner: ClientOwner<M>) =>
    <E = never, R = never>(
        listener: (change: CacheChange) => Effect.Effect<unknown, E, R>,
        options?: CacheObserverOptions,
    ): Effect.Effect<NativeCacheObserver, never, R | Scope.Scope> =>
        Effect.gen(function* () {
            if (typeof listener !== "function")
                return yield* Effect.die(new ConfigurationError("listener", "Cache change listener must be a function"))
            // Invalid options are misuse, so they become a defect rather than a typed failure
            const bounds = yield* observerBounds(options).pipe(Effect.orDie)
            const services = (yield* Effect.context<R>()) as Context.Context<never>
            const hub = owner.cacheChanges
            const id = hub.nextId()
            const close = yield* Effect.acquireRelease(
                Effect.sync(() => {
                    hub.watch(owner)
                    const running = new Set<Fiber.Fiber<unknown, unknown>>()
                    const queue = new ListenerQueue(id, bounds, owner.logging, (change, done) => {
                        try {
                            const fiber = Effect.runForkWith(services)(
                                Effect.suspend(() => listener(change) as Effect.Effect<unknown, unknown>),
                            )
                            running.add(fiber)
                            fiber.addObserver((exit) => {
                                running.delete(fiber)
                                if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
                                    reportFailure(owner, { cause: exit.cause })
                                done()
                            })
                        } catch (error) {
                            reportFailure(owner, { error })
                            done()
                        }
                    })
                    let open = true
                    const stop = (shutdown = false) => {
                        if (!open) return
                        open = false
                        queue.close(shutdown)
                        for (const fiber of running) fiber.interruptUnsafe()
                        running.clear()
                    }
                    const observer = hub.add((since) => ({
                        since,
                        deliver: (change) => queue.deliver(change),
                        // The hub closes observers only at client shutdown
                        close: () => stop(true),
                    }))
                    return () => {
                        stop()
                        if (observer) hub.remove(observer)
                    }
                }),
                (close) => Effect.sync(close),
            )
            return Object.freeze({ id, close: () => Effect.sync(close) })
        })
