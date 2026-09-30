import { Cause, Effect, Exit, Result as NativeResult } from "effect"
import type { Result, ResultAsync } from "neverthrow"
import { expect } from "vitest"

/** Return a typed failure only when the complete Cause contains no defects or interruption */
export function typedFailure<E>(cause: Cause.Cause<E>): E {
    if (cause.reasons.some((reason) => reason._tag !== "Fail"))
        expect.fail(
            `Expected only typed failures, received ${cause.reasons.map((reason) => reason._tag).join(" + ")}: ${Cause.pretty(cause)}`,
        )
    const failure = cause.reasons.find((reason) => reason._tag === "Fail")
    if (failure?._tag !== "Fail") expect.fail(`Expected a typed failure, received ${Cause.pretty(cause)}`)
    return failure.error
}

/** Capture typed outcomes while keeping defects and interruption in the Effect failure channel */
export function typedResult<A, E, R>(
    operation: Effect.Effect<A, E, R>,
): Effect.Effect<NativeResult.Result<A, E>, never, R> {
    return Effect.exit(operation).pipe(
        Effect.flatMap((exit): Effect.Effect<NativeResult.Result<A, E>> => {
            if (Exit.isSuccess(exit)) return Effect.succeed(NativeResult.succeed(exit.value))
            if (exit.cause.reasons.some((reason) => reason._tag !== "Fail"))
                return Effect.failCause(exit.cause as Cause.Cause<never>)
            return Effect.succeed(NativeResult.fail(typedFailure(exit.cause)))
        }),
    )
}

/** A default Result, a default ResultAsync or a native Effect */
export type Operation<A, E> = Result<A, E> | ResultAsync<A, E> | PromiseLike<Result<A, E>> | Effect.Effect<A, E>

/**
 * Resolve a default result or run a native Effect, throwing the typed failure so the test reports it.
 * A plain value, such as a default cache lookup, is returned unchanged so both API styles can share one call
 */
export async function settle<A, E>(operation: Operation<A, E>): Promise<A>
export async function settle<A>(value: A): Promise<A>
export async function settle<A, E>(operation: Operation<A, E> | A): Promise<A> {
    if (Effect.isEffect(operation)) {
        const exit = await Effect.runPromiseExit(operation as Effect.Effect<A, E>)
        if (Exit.isFailure(exit)) throw typedFailure(exit.cause)
        return exit.value
    }
    const result: unknown = await operation
    if (typeof (result as { isErr?: unknown } | null | undefined)?.isErr !== "function") return result as A
    const settled = result as Result<A, E>
    if (settled.isErr()) throw settled.error
    return settled.value
}

/** Resolve a default result or run a native Effect and return its typed failure. Success fails the test */
export async function expectErr<A, E>(operation: Operation<A, E>): Promise<E> {
    if (Effect.isEffect(operation)) {
        const exit = await Effect.runPromiseExit(operation)
        if (Exit.isSuccess(exit)) expect.fail(`Expected a typed failure, received ${String(exit.value)}`)
        return typedFailure(exit.cause)
    }
    const result = await operation
    if (result.isOk()) expect.fail(`Expected an error result, received ${String(result.value)}`)
    return result.error
}

/** Run a native Effect and return the Cause of its failure, including defects and interruption. Success fails the test */
export async function expectFailure<A, E>(effect: Effect.Effect<A, E>): Promise<Cause.Cause<E>> {
    const exit = await Effect.runPromiseExit(effect)
    if (Exit.isSuccess(exit)) expect.fail(`Expected the Effect to fail, received ${String(exit.value)}`)
    return exit.cause
}
