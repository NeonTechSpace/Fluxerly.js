import { types } from "node:util"

/** Discard invalid synchronous-callback returns without awaiting work or exposing rejection reasons */
export function discardInvalidCallbackReturn(value: unknown): void {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return
    try {
        // Brand detection includes foreign promises; bypass caller-owned then/catch properties
        if (types.isPromise(value))
            void Promise.prototype.then.call(
                value,
                () => undefined,
                () => undefined,
            )
        else
            void Promise.resolve()
                .then(() => value)
                .catch(() => undefined)
    } catch {
        // Disposal must not replace the callback owner's typed invalid-return failure
    }
}
