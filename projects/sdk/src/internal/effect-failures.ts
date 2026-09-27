/**
 * Cause-preserving Effect helpers and the sanitized transport error.
 * Invariant: Mapping and deadlines never drop defects or cleanup causes, and transport causes keep only an error code.
 * Implements [SDK contracts: Results and failures](/docs/SDK-CONTRACTS.md#results-and-failures)
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"

// Effect.mapError drops defects in mixed causes, and ordinary catchCause can skip mapping on interruption
export const mapFailureCause =
    <E, E2>(map: (error: E) => E2) =>
    <A, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E2, R> =>
        Effect.uninterruptibleMask((restore) =>
            Effect.exit(restore(effect)).pipe(
                Effect.flatMap((exit) =>
                    Exit.isFailure(exit) ? Effect.failCause(Cause.map(exit.cause, map)) : Effect.succeed(exit.value),
                ),
            ),
        )

// Effect's timeout race awaits the losing work but discards its cleanup cause
// Retain defects with their operation failures or interruption, including caller cancellation
export const withDeadline =
    <E2>(duration: number, onTimeout: () => E2) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | E2, R> =>
        Effect.suspend(() => {
            let result: Exit.Exit<A, E> | undefined
            return effect.pipe(
                Effect.onExit((exit) =>
                    Effect.sync(() => {
                        result = exit
                    }),
                ),
                Effect.timeoutOrElse({ duration, orElse: () => Effect.fail(onTimeout()) }),
                Effect.onExit((exit) => {
                    if (!result || !Exit.isFailure(result) || !Cause.hasDies(result.cause)) return Effect.void
                    const missing = result.cause.reasons.filter(
                        (reason) => !Exit.isFailure(exit) || !exit.cause.reasons.includes(reason),
                    )
                    return missing.length ? Effect.failCause(Cause.fromReasons(missing)) : Effect.void
                }),
            )
        })

function transportCode(error: unknown, depth = 0): string | undefined {
    if (typeof error !== "object" || error === null || depth > 3) return undefined
    const code = (error as { code?: unknown }).code
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code
    return transportCode((error as { cause?: unknown }).cause, depth + 1)
}

/** A sanitized network failure kept as an error's cause. It keeps the transport code, such as ECONNRESET,
 * but not the transport message, which can contain URLs, credentials or upstream text
 */
export class TransportError extends Error {
    /** Transport error code such as ECONNREFUSED or UND_ERR_CONNECT_TIMEOUT, when the runtime supplied one */
    readonly code: string | undefined
    constructor(source: unknown, what = "network request") {
        const code = transportCode(source)
        super(`The ${what} failed${code === undefined ? "" : ` (${code})`}`)
        this.name = "TransportError"
        this.code = code
    }
}
