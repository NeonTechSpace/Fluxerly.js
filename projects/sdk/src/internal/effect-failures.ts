import { Cause, Effect, Exit } from "effect"

// Effect.mapError drops defects in mixed causes; ordinary catchCause can skip mapping on interruption
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
