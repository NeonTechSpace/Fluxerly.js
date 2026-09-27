import { Cause, Effect, Exit } from "effect"
import type { Result, ResultAsync } from "neverthrow"
import { expect } from "vitest"

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
        const result = await Effect.runPromise(Effect.result(operation as Effect.Effect<A, E>))
        if (result._tag === "Failure") throw result.failure
        return result.success
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
        const result = await Effect.runPromise(Effect.result(operation))
        if (result._tag === "Success") expect.fail(`Expected a typed failure, received ${String(result.success)}`)
        return result.failure
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
