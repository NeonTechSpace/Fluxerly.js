import { setImmediate as turn } from "node:timers/promises"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { onTestFinished, vi } from "vitest"

/**
 * Wait until a predicate holds, polling on event-loop turns rather than fixed sleeps.
 * The deadline bounds a hung test and is never part of the behavior under test
 */
export async function waitUntil(
    predicate: () => boolean | Promise<boolean>,
    { timeoutMs = 5_000, message = "Condition was not reached" }: { timeoutMs?: number; message?: string } = {},
): Promise<void> {
    const deadline = performance.now() + timeoutMs
    while (!(await predicate())) {
        if (performance.now() >= deadline) throw new Error(`${message} within ${timeoutMs} ms`)
        await turn()
        await new Promise((resolve) => setTimeout(resolve, 1))
    }
}

/**
 * Move the default Effect Clock's monotonic time forward without waiting.
 *
 * Default clients read logical time from Effect's default Clock, which uses process.hrtime.bigint. Advancing it makes
 * age and deadline checks observe elapsed time deterministically. Timers already scheduled on the host still fire on
 * host time, so use this for checks performed on access, such as cache expiry on lookup
 */
export function monotonicClock() {
    const real = process.hrtime.bigint.bind(process.hrtime)
    let offset = 0n
    const spy = vi.spyOn(process.hrtime, "bigint").mockImplementation(() => real() + offset)
    // The spy handle stays valid even when a file-level vi.restoreAllMocks() already restored it
    onTestFinished(() => {
        spy.mockRestore()
    })
    return {
        /** Add whole milliseconds to every later monotonic reading */
        advance(ms: number) {
            offset += BigInt(ms) * 1_000_000n
        },
    }
}

/**
 * Run an Effect with TestClock as its Clock. Inside it, TestClock.adjust advances logical time, so SDK owners created
 * there observe deadlines and expiry without host waiting. A ten-second warning flags a test that forgot to adjust
 */
export function runWithTestClock<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
    return Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer({ warningDelay: "10 seconds" }))))
}
