/**
 * Logical timers tied to SDK work, over the Clock captured when an owner is created.
 * Invariant: Timers belong to the owner's scope, stay separate from host watchdogs and protocol wall time, and report callback failures.
 * Implements [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Scope from "effect/Scope"
import { nowMs } from "./clock.js"

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

    constructor(
        readonly clock: Clock.Clock,
        /** Report a failed timer callback with its owner label and full Cause */
        private readonly onFailure?: (owner: string, cause: Cause.Cause<unknown>) => void,
    ) {}

    now(): number {
        return nowMs(this.clock)
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
                            // A failed callback is reported with its cause and cannot orphan unrelated timers
                            Effect.catchCause((cause) =>
                                Effect.sync(() => {
                                    if (this.onFailure) this.onFailure(entry.owner, cause)
                                    else
                                        process.stderr.write(
                                            `Fluxerly ${entry.owner} timer callback failed: ${String(Cause.squash(cause))}\n`,
                                        )
                                }).pipe(
                                    // allow-silent: A failing reporter must not stop the scheduler loop
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

export const makeLogicalScheduler = (
    scope: Scope.Scope,
    onFailure?: (owner: string, cause: Cause.Cause<unknown>) => void,
): Effect.Effect<LogicalScheduler> =>
    Effect.gen(function* () {
        const clock = yield* Clock.Clock
        const scheduler = new LogicalScheduler(clock, onFailure)
        yield* Effect.forkIn(scheduler.run.pipe(Effect.interruptible), scope, { uninterruptible: true })
        yield* Scope.addFinalizer(
            scope,
            Effect.sync(() => scheduler.close()),
        )
        return scheduler
    })
