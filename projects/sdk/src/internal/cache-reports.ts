import { Cause, Context, Effect, Fiber, Logger, LogLevel, Queue, Scope } from "effect"
import type { CachePolicyErrorReport } from "#sdk/cache"

/** A single scoped reporter, with synchronous fallback logging and no growing diagnostic backlog */
export class CacheReports {
    #busy = false
    #closed = false
    #started = false
    #worker: Fiber.Fiber<void> | undefined
    private context: Context.Context<never> | undefined
    private loggers: ReadonlySet<Logger.Logger<unknown, unknown>>

    constructor(
        private readonly queue: Queue.Queue<CachePolicyErrorReport>,
        private callback: ((report: CachePolicyErrorReport) => Effect.Effect<unknown, unknown>) | undefined,
        private creator: Fiber.Fiber<unknown, unknown> | undefined,
        private readonly scope: Scope.Scope,
    ) {
        this.context = creator!.context
        this.loggers = creator!.getRef(Logger.CurrentLoggers)
    }

    #log(reason: string) {
        const fiber = this.creator
        if (!fiber || LogLevel.isLessThan("Error", fiber.cache.minimumLogLevel)) return
        for (const logger of this.loggers) {
            try {
                logger.log({
                    message: [`Fluxerly cache policy failure (${reason})`],
                    logLevel: "Error",
                    cause: Cause.empty,
                    fiber,
                    date: new Date(),
                })
            } catch {
                /* A failed fallback must not recursively report or stop delivery */
            }
        }
    }

    offer(report: CachePolicyErrorReport) {
        if (this.#closed) return
        if (!this.callback || this.#busy) {
            this.#log(report.reason)
            return
        }
        this.#busy = true
        Queue.offerUnsafe(this.queue, report)
    }

    start(): Effect.Effect<void> {
        const owner = this
        return Effect.uninterruptible(
            Effect.suspend(() => {
                if (owner.#closed || owner.#started || !owner.callback) return Effect.void
                owner.#started = true
                const work = Effect.gen(function* () {
                    while (!owner.#closed) {
                        const report = yield* Queue.take(owner.queue)
                        yield* Effect.suspend(() => owner.callback!(report)).pipe(
                            Effect.catchCause((cause) =>
                                Cause.hasInterruptsOnly(cause) && owner.#closed
                                    ? Effect.void
                                    : Effect.sync(() => owner.#log(`${report.reason}; reporter`)),
                            ),
                            Effect.ensuring(
                                Effect.sync(() => {
                                    owner.#busy = false
                                }),
                            ),
                        )
                    }
                }).pipe(Effect.provideContext(owner.context!), Effect.interruptible)
                return Effect.forkIn(work, owner.scope).pipe(
                    Effect.map((fiber) => {
                        owner.#worker = fiber
                    }),
                )
            }),
        )
    }

    owns(fiberId: number) {
        return this.#worker?.id === fiberId
    }

    shutdown(): Effect.Effect<void> {
        const owner = this
        return Effect.gen(function* () {
            owner.#closed = true
            if (owner.#worker) yield* Fiber.interrupt(owner.#worker)
            yield* Queue.shutdown(owner.queue)
            owner.#worker = undefined
            owner.callback = undefined
            owner.creator = undefined
            owner.context = undefined
            owner.loggers = new Set()
        })
    }
}

export function makeCacheReports(
    callback: ((report: CachePolicyErrorReport) => Effect.Effect<unknown, unknown>) | undefined,
    scope: Scope.Scope,
) {
    return Effect.gen(function* () {
        const queue = yield* Queue.make<CachePolicyErrorReport>({ capacity: 1 })
        return yield* Effect.withFiber((fiber) => Effect.succeed(new CacheReports(queue, callback, fiber, scope)))
    })
}
