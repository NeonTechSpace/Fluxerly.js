/**
 * The manual clock of default test clients: An Effect Clock whose time moves only when the test advances it.
 * Invariant: Time starts at 0, both as monotonic time and as Unix epoch milliseconds, and never moves backwards. A
 * sleep resumes only when the clock moves to or past its deadline, sleeps sharing a deadline resume in the order they
 * started, and an interrupted sleep leaves nothing behind.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import type * as Clock from "effect/Clock"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type { TestTime } from "./harness.js"

interface Sleep {
    readonly deadline: number
    readonly wake: () => void
}

/** A Clock for one test client, driven through the TestTime controls that the harness's advance uses */
export class ManualClock implements TestTime {
    #now = 0
    /** Pending sleeps in start order. Insertion order breaks ties between equal deadlines */
    readonly #sleeps = new Set<Sleep>()

    readonly clock: Clock.Clock = {
        currentTimeMillisUnsafe: () => this.#now,
        currentTimeMillis: Effect.sync(() => this.#now),
        currentTimeNanosUnsafe: () => this.#nanos(),
        currentTimeNanos: Effect.sync(() => this.#nanos()),
        monotonicTimeNanosUnsafe: () => this.#nanos(),
        monotonicTimeNanos: Effect.sync(() => this.#nanos()),
        sleep: (duration) =>
            Effect.callback<void>((resume) => {
                const delay = Duration.toMillis(duration)
                if (!(delay > 0)) {
                    resume(Effect.void)
                    return
                }
                const sleep: Sleep = { deadline: this.#now + delay, wake: () => resume(Effect.void) }
                this.#sleeps.add(sleep)
                return Effect.sync(() => {
                    this.#sleeps.delete(sleep)
                })
            }),
    }

    now(): number {
        return this.#now
    }

    nextDeadline(): number | undefined {
        let next: number | undefined
        for (const { deadline } of this.#sleeps)
            if (Number.isFinite(deadline) && (next === undefined || deadline < next)) next = deadline
        return next
    }

    moveTo(time: number): void {
        if (time > this.#now) this.#now = time
        const due = [...this.#sleeps].filter((sleep) => sleep.deadline <= this.#now)
        // A stable sort keeps the start order of sleeps that share a deadline
        due.sort((left, right) => left.deadline - right.deadline)
        for (const sleep of due) {
            this.#sleeps.delete(sleep)
            sleep.wake()
        }
    }

    #nanos(): bigint {
        return BigInt(Math.round(this.#now * 1_000_000))
    }
}
