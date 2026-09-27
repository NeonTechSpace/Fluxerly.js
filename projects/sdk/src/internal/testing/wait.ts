/**
 * Bounded waits for test client controls, such as TestRoute.next and idle.
 * Invariant: Every wait settles exactly once, by its own condition, its timeout, the caller's abort signal or test
 * client shutdown, and leaves no timer or listener behind.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
// The node:timers functions stay real when a test fakes the global timers, so waits still time out and settle
import { clearTimeout, setTimeout } from "node:timers"
import { ConfigurationError } from "#sdk/errors"
import { TestTimeoutError } from "./errors.js"
import type { TestWaitOptions } from "./types.js"

/** Default time a test wait allows before it fails with TestTimeoutError */
const defaultWaitTimeoutMs = 2_000

/** Settle a pending wait with a value or a failure */
export type WaitOutcome<A> = { readonly value: A } | { readonly error: unknown }

/** Read and check a wait's timeout option. Misuse throws ConfigurationError */
export function waitTimeout(options: TestWaitOptions | undefined): number {
    if (options !== undefined && (typeof options !== "object" || options === null))
        throw new ConfigurationError("configuration", "Test wait options must be an object")
    const timeoutMs = options?.timeoutMs ?? defaultWaitTimeoutMs
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
        throw new ConfigurationError(
            "configuration",
            "Test wait timeoutMs must be an integer from 1 through 2,147,483,647",
        )
    return timeoutMs
}

/**
 * Start a wait and fail it with TestTimeoutError after timeoutMs, or with the signal's reason when aborted.
 * The start function receives the settle callback and returns its own cleanup
 */
export function timedWait<A>(
    wait: TestTimeoutError["wait"],
    timeoutMs: number,
    signal: AbortSignal | undefined,
    start: (settle: (outcome: WaitOutcome<A>) => void) => () => void,
): Promise<A> {
    return new Promise<A>((resolve, reject) => {
        let settled = false
        let cleanup: (() => void) | undefined
        const onAbort = () => settle({ error: signal?.reason })
        const timer = setTimeout(() => settle({ error: new TestTimeoutError(wait, timeoutMs) }), timeoutMs)
        function settle(outcome: WaitOutcome<A>) {
            if (settled) return
            settled = true
            clearTimeout(timer)
            signal?.removeEventListener("abort", onAbort)
            cleanup?.()
            if ("value" in outcome) resolve(outcome.value)
            else reject(outcome.error)
        }
        if (signal?.aborted) return settle({ error: signal.reason })
        signal?.addEventListener("abort", onAbort, { once: true })
        const stop = start(settle)
        if (settled) stop()
        else cleanup = stop
    })
}
