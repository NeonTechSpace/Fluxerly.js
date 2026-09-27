// Operation outcomes shared by the live harnesses that run both APIs. Each function accepts a default-API Result
// promise or an Effect operation. Harnesses that load Effect lazily keep their own mode-selected unwrapping
import { Cause, Effect, Exit } from "effect"

/**
 * Returns the success value and throws the typed failure, which is the Result error or the Effect failure.
 * A `signal` interrupts an Effect run
 */
export async function settle(operation, signal) {
    if (Effect.isEffect(operation)) {
        const result = await Effect.runPromise(Effect.result(operation), signal ? { signal } : undefined)
        if (result._tag === "Failure") throw result.failure
        return result.success
    }
    const result = await operation
    if (result.isErr()) throw result.error
    return result.value
}

/**
 * Returns an Effect exit's success value and throws its typed failure. A defect throws a generic error without its
 * message, and an interruption alone throws `{ _tag: "TestInterrupted" }`
 */
export function fromExit(exit) {
    if (Exit.isSuccess(exit)) return exit.value
    if (Cause.hasDies(exit.cause)) throw Error("Unexpected SDK defect")
    if (Cause.hasInterruptsOnly(exit.cause)) throw { _tag: "TestInterrupted" }
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    if (failure?._tag === "Fail") throw failure.error
    throw Error("Unexpected operation outcome")
}

/** Like `settle`, but an Effect outcome is classified by `fromExit` */
export async function settleExit(operation) {
    if (Effect.isEffect(operation)) return fromExit(await Effect.runPromiseExit(operation))
    const result = await operation
    if (result.isErr()) throw result.error
    return result.value
}
