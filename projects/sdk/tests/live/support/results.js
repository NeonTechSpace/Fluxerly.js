// Operation outcomes shared by the live harnesses that run both APIs. Each function accepts a default-API Result
// promise or an Effect operation. Effect is loaded only when running an operation, after configuration and locking

/** Capture typed outcomes without dropping a defect or interruption beside a typed failure */
export function typedResult(Effect, operation) {
    return Effect.exit(operation).pipe(
        Effect.flatMap((exit) => {
            if (exit._tag === "Success") return Effect.result(Effect.succeed(exit.value))
            if (exit.cause.reasons.some((reason) => reason._tag !== "Fail")) return Effect.failCause(exit.cause)
            const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
            if (failure?._tag !== "Fail") return Effect.die(new Error("Unexpected operation outcome"))
            // Result conversion is safe after checking every reason and reconstructing a pure typed failure
            return Effect.result(Effect.fail(failure.error))
        }),
    )
}

/**
 * Returns the success value and throws the typed failure, which is the Result error or the Effect failure.
 * A `signal` interrupts an Effect run
 */
export async function settle(operation, signal) {
    const { Effect } = await import("effect")
    if (Effect.isEffect(operation)) {
        return fromExit(await Effect.runPromiseExit(operation, signal ? { signal } : undefined))
    }
    const result = await operation
    if (result.isErr()) throw result.error
    return result.value
}

/**
 * Returns an Effect exit's success value and throws its typed failure. A defect throws a generic error without its
 * message, and any interruption throws `{ _tag: "TestInterrupted" }`
 */
export function fromExit(exit) {
    if (exit._tag === "Success") return exit.value
    if (exit.cause.reasons.some((reason) => reason._tag === "Die")) throw Error("Unexpected SDK defect")
    if (exit.cause.reasons.some((reason) => reason._tag === "Interrupt")) throw { _tag: "TestInterrupted" }
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    if (failure?._tag === "Fail") throw failure.error
    throw Error("Unexpected operation outcome")
}

/** Like `settle`, but an Effect outcome is classified by `fromExit` */
export async function settleExit(operation) {
    const { Effect } = await import("effect")
    if (Effect.isEffect(operation)) return fromExit(await Effect.runPromiseExit(operation))
    const result = await operation
    if (result.isErr()) throw result.error
    return result.value
}
