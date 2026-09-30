import { setImmediate as turn } from "node:timers/promises"
import { Clock, Duration, Effect, Exit } from "effect"
import type { ResultAsync } from "neverthrow"
import { expect, vi } from "vitest"
import { typedFailure } from "./settle.js"

/**
 * Control only the SDK's Effect Clock and jitter, while loopback I/O and test deadlines keep real time
 *
 * Spies on the default Effect Clock, so default clients and native clients created without their own Clock both
 * observe it. Monotonic and wall-clock time start at zero, each sleep waits until advance moves past its deadline, and
 * Math.random, which drives the default Random, returns 0.5. Call it before creating the client
 */
export function sdkClock() {
    let now = 0
    const pending = new Set<{ at: number; delay: number; wake: () => void }>()
    const clock = Effect.runSync(Clock.Clock)
    vi.spyOn(clock, "monotonicTimeNanosUnsafe").mockImplementation(() => BigInt(now) * 1_000_000n)
    vi.spyOn(clock, "currentTimeMillisUnsafe").mockImplementation(() => now)
    vi.spyOn(clock, "sleep").mockImplementation((duration) =>
        Effect.callback<void>((resume) => {
            const delay = Duration.toMillis(duration)
            if (delay <= 0) {
                resume(Effect.void)
                return
            }
            const item = { at: now + delay, delay, wake: () => resume(Effect.void) }
            pending.add(item)
            return Effect.sync(() => pending.delete(item))
        }),
    )
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    return {
        /** Current SDK time in milliseconds */
        now: () => now,
        /** Sleeps that have not reached their deadline */
        pending,
        /** Wait until the SDK sleeps for exactly this many milliseconds */
        waiting: (delay: number) =>
            vi.waitFor(() => expect([...pending].some((item) => item.delay === delay)).toBe(true), { interval: 5 }),
        /** Move SDK time forward and wake every sleep whose deadline has passed */
        async advance(milliseconds: number) {
            now += milliseconds
            for (const item of [...pending]) {
                if (item.at <= now) {
                    pending.delete(item)
                    item.wake()
                }
            }
            // Let resumed fibers and socket callbacks run without advancing another SDK deadline
            for (let index = 0; index < 5; index++) await turn()
        },
    }
}

export type SdkClock = ReturnType<typeof sdkClock>

/**
 * Fake host timers, performance and Date, and make the default Effect Clock's monotonic time follow the faked
 * performance.now. Advance with vi.advanceTimersByTimeAsync. The caller's afterEach restores real timers and mocks
 */
export function fakeHostTime() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] })
    vi.spyOn(Effect.runSync(Clock.Clock), "monotonicTimeNanosUnsafe").mockImplementation(() =>
        BigInt(Math.round(performance.now() * 1_000_000)),
    )
}

/**
 * Poll a condition on real event-loop turns while host timers are faked, without advancing fake time.
 * The turn limit bounds a hung test and is never part of the behavior under test
 */
export async function hostTurnsUntil(predicate: () => boolean, turns = 10_000): Promise<void> {
    for (let count = 0; !predicate(); count++) {
        if (count >= turns) throw new Error(`Condition was not reached within ${turns} event-loop turns`)
        await turn()
    }
}

/** Settle a default ResultAsync or run a native Effect into its value or typed error, without throwing */
export async function outcome<A, E>(
    operation: ResultAsync<A, E> | Effect.Effect<A, E>,
): Promise<{ value: A } | { error: E }> {
    if (Effect.isEffect(operation)) {
        const exit = await Effect.runPromiseExit(operation)
        return Exit.isFailure(exit) ? { error: typedFailure(exit.cause) } : { value: exit.value }
    }
    const result = await operation
    return result.isErr() ? { error: result.error } : { value: result.value }
}
