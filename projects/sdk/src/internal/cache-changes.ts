/**
 * Cache change notifications: One client-wide hub that every client-owned cache reports set, delete and clear changes to.
 * Invariant: Notification never changes a cache result, event delivery or REST outcome. Caches only record a change after
 * applying it and build no record while no observer is registered. Records are delivered in applied order from a microtask
 * after the synchronous cache work that produced them, so a listener never runs inside a cache operation, and a failing
 * listener is reported as a cache failure without affecting other listeners. Client closure delivers the final clears and
 * then closes every observer. Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import * as Cause from "effect/Cause"
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as Fiber from "effect/Fiber"
import type * as Scope from "effect/Scope"
import type { CacheChange } from "#sdk/cache"
import type { CacheKind } from "#sdk/client"
import { ConfigurationError } from "#sdk/errors"
import type { MessageCore } from "#sdk/messages"
import type { CacheObserver } from "#sdk/api/default/cache"
import type { CacheObserver as NativeCacheObserver } from "#sdk/api/effect/cache"
import type { ClientOwner } from "./client.js"
import { throwIfErr } from "./failures.js"

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

    /** Deliver the changes already recorded, including shutdown's final clears, then close every observer */
    close() {
        if (this.#closed) return
        this.#flush()
        this.#closed = true
        for (const observer of this.#observers) observer.close()
        this.#observers.clear()
        this.#queue = []
    }
}

/** A listener's failure as a client cache report. Reporting never throws */
function reportFailure<M extends MessageCore>(
    owner: ClientOwner<M>,
    input: { readonly error: unknown } | { readonly cause: Cause.Cause<unknown> },
) {
    owner.failures.report({ kind: "cache", ...input })
}

const closedObserver: CacheObserver = Object.freeze({ close: () => undefined, [Symbol.dispose]: () => undefined })

/** Default-API cache.onChange: Listeners run from a microtask, and returned promises are observed but not awaited */
export const defaultCacheOnChange =
    <M extends MessageCore>({ owner }: { readonly owner: ClientOwner<M> }) =>
    (listener: (change: CacheChange) => unknown): CacheObserver => {
        if (typeof listener !== "function")
            throw new ConfigurationError("listener", "Cache change listener must be a function")
        const hub = owner.cacheChanges
        hub.watch(owner)
        const report = (error: unknown) => reportFailure(owner, { error })
        let open = true
        const observer = hub.add((since) => ({
            since,
            deliver: (change) => {
                if (!open) return
                try {
                    const result = listener(change)
                    if (
                        typeof result === "object" &&
                        result !== null &&
                        typeof (result as { then?: unknown }).then === "function"
                    )
                        Promise.resolve(result).then(throwIfErr).catch(report)
                    else throwIfErr(result)
                } catch (error) {
                    report(error)
                }
            },
            close: () => {
                open = false
            },
        }))
        if (!observer) return closedObserver
        const close = () => {
            if (!open) return
            open = false
            hub.remove(observer)
        }
        return Object.freeze({ close, [Symbol.dispose]: close })
    }

/** Native cache.onChange: Each change forks the listener Effect with the registration services, closed with its Scope */
export const nativeCacheOnChange =
    <M extends MessageCore>(owner: ClientOwner<M>) =>
    <E = never, R = never>(
        listener: (change: CacheChange) => Effect.Effect<unknown, E, R>,
    ): Effect.Effect<NativeCacheObserver, never, R | Scope.Scope> =>
        Effect.gen(function* () {
            if (typeof listener !== "function")
                return yield* Effect.die(new ConfigurationError("listener", "Cache change listener must be a function"))
            const services = (yield* Effect.context<R>()) as Context.Context<never>
            const hub = owner.cacheChanges
            const close = yield* Effect.acquireRelease(
                Effect.sync(() => {
                    hub.watch(owner)
                    const running = new Set<Fiber.Fiber<unknown, unknown>>()
                    let open = true
                    const stop = () => {
                        if (!open) return
                        open = false
                        for (const fiber of running) fiber.interruptUnsafe()
                        running.clear()
                    }
                    const observer = hub.add((since) => ({
                        since,
                        deliver: (change) => {
                            if (!open) return
                            try {
                                const fiber = Effect.runForkWith(services)(
                                    Effect.suspend(() => listener(change) as Effect.Effect<unknown, unknown>),
                                )
                                running.add(fiber)
                                fiber.addObserver((exit) => {
                                    running.delete(fiber)
                                    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
                                        reportFailure(owner, { cause: exit.cause })
                                })
                            } catch (error) {
                                reportFailure(owner, { error })
                            }
                        },
                        close: stop,
                    }))
                    return () => {
                        stop()
                        if (observer) hub.remove(observer)
                    }
                }),
                (close) => Effect.sync(close),
            )
            return Object.freeze({ close: () => Effect.sync(close) })
        })
