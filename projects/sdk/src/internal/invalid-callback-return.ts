/**
 * Handling for invalid synchronous-callback returns.
 * Invariant: An invalid return is discarded without awaiting its work or exposing a rejection reason.
 * Implements [SDK contracts: User-handler failures](/docs/SDK-CONTRACTS.md#user-handler-failures)
 */
import { types } from "node:util"

/** Discard invalid synchronous-callback returns without awaiting work or exposing rejection reasons */
export function discardInvalidCallbackReturn(value: unknown): void {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return
    try {
        // Brand detection includes foreign promises. Bypass caller-owned then/catch properties
        if (types.isPromise(value))
            // allow-silent: The callback owner already returned a typed invalid-return failure for this promise
            void Promise.prototype.then.call(
                value,
                () => undefined,
                () => undefined,
            )
        else
            void Promise.resolve()
                .then(() => value)
                // allow-silent: The rejection of a mistakenly asynchronous callback follows its typed invalid-return failure
                .catch(() => undefined)
    } catch {
        // allow-silent: Disposal must not replace the callback owner's typed invalid-return failure
    }
}
