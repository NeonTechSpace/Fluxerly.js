/**
 * Monotonic millisecond reads from an Effect Clock, shared by every SDK owner that measures deadlines or ages.
 * Invariant: Every read goes through the supplied Clock at call time, so TestClock and caller-provided clocks apply.
 * Implements the timing rule in [SDK contracts](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
import type * as Clock from "effect/Clock"

/** Current monotonic time in milliseconds from the given Clock. Never wall-clock time */
export function nowMs(clock: Clock.Clock): number {
    return Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000
}
