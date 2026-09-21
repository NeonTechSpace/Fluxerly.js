import { Clock, Deferred, Duration, Effect, Scope } from "effect"

export type LogicalTimer = object

type Entry = {
    readonly callback: () => void
    readonly deadline: number
    readonly owner: string
    readonly sequence: number
}

/** Scope-owned scheduling over the Clock captured when an SDK owner is created */
export class LogicalScheduler {
    readonly #entries = new Map<LogicalTimer, Entry>()
    #closed = false
    #sequence = 0
    #wake = Deferred.makeUnsafe<void>()

    constructor(readonly clock: Clock.Clock) {}

    now(): number {
        return Number(this.clock.monotonicTimeNanosUnsafe()) / 1_000_000
    }

    set(callback: () => void, delayMs: number, owner: string): LogicalTimer {
        const timer = Object.freeze({})
        if (this.#closed) return timer
        this.#entries.set(timer, {
            callback,
            deadline: this.now() + Math.max(0, delayMs),
            owner,
            sequence: this.#sequence++,
        })
        this.#signal()
        return timer
    }

    clear(timer: LogicalTimer | undefined): void {
        if (timer !== undefined && this.#entries.delete(timer)) this.#signal()
    }

    close(): void {
        if (this.#closed) return
        this.#closed = true
        this.#entries.clear()
        this.#signal()
    }

    readonly run: Effect.Effect<void> = Effect.suspend(() => {
        if (this.#closed) return Effect.void
        const wake = this.#wake
        let earliest = Infinity
        for (const entry of this.#entries.values()) earliest = Math.min(earliest, entry.deadline)
        const wait =
            earliest === Infinity
                ? Deferred.await(wake)
                : Effect.raceFirst(
                      this.clock.sleep(Duration.millis(Math.max(0, Math.ceil(earliest - this.now())))),
                      Deferred.await(wake),
                  )
        return wait.pipe(
            Effect.andThen(
                Effect.sync(() => {
                    if (wake !== this.#wake) return
                    const now = this.now()
                    return [...this.#entries.entries()]
                        .filter(([, entry]) => entry.deadline <= now)
                        .sort((left, right) =>
                            left[1].deadline === right[1].deadline
                                ? left[1].sequence - right[1].sequence
                                : left[1].deadline - right[1].deadline,
                        )
                }),
            ),
            Effect.flatMap((due) =>
                Effect.forEach(
                    due ?? [],
                    ([timer, entry]) => {
                        // An earlier callback can cancel a later callback from the same due snapshot
                        if (!this.#entries.delete(timer)) return Effect.void
                        return Effect.sync(entry.callback).pipe(
                            // Report only the closed owner label. A defective logger cannot orphan unrelated timers
                            Effect.catchCause(() =>
                                Effect.logError(`${entry.owner} logical timer callback failed`).pipe(
                                    Effect.catchCause(() => Effect.void),
                                ),
                            ),
                        )
                    },
                    { discard: true },
                ),
            ),
            Effect.andThen(this.run),
        )
    })

    #signal(): void {
        const wake = this.#wake
        this.#wake = Deferred.makeUnsafe<void>()
        Deferred.doneUnsafe(wake, Effect.void)
    }
}

export const makeLogicalScheduler = (scope: Scope.Scope): Effect.Effect<LogicalScheduler> =>
    Effect.gen(function* () {
        const clock = yield* Clock.Clock
        const scheduler = new LogicalScheduler(clock)
        yield* Effect.forkIn(scheduler.run.pipe(Effect.interruptible), scope, { uninterruptible: true })
        yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => scheduler.close()),
        )
        return scheduler
    })
