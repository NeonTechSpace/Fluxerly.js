/**
 * Cause-preserving Effect helpers and the sanitized transport error.
 * Invariant: Mapping and deadlines never drop defects or cleanup causes, and transport causes keep only an error code.
 * Implements [SDK contracts: Results and failures](/docs/SDK-CONTRACTS.md#results-and-failures)
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { applicationMarked } from "./defects.js"

/**
 * Selects the failure values one mapping handles. Since Effect 4.0.6, a typed failure that meets a defect becomes a
 * defect that keeps its value, so a mapping also uses this to find those values among the defects
 */
export type FailureMatch<E> = (value: unknown) => value is E

/**
 * Match failures by class. List the exact failure classes the mapped Effect can fail with, never a base such as Error or
 * FluxerlyError, which would also select genuine defects. A list that misses one of the Effect's failure types does not
 * compile
 */
export function failures<const C extends readonly (abstract new (...args: never) => unknown)[]>(
    ...classes: C
): FailureMatch<InstanceType<C[number]>> {
    return (value): value is InstanceType<C[number]> => classes.some((type) => value instanceof type)
}

/**
 * Matches nothing, for a failure channel of unknown values, such as an application callback's failure. Failures that
 * Effect turned into defects then stay exactly as they were raised
 */
export const keepConvertedFailures = (_value: unknown): _value is unknown => false

/**
 * Map an Effect's typed failures, and the failures Effect turned into defects beside another defect, so internal failure
 * types never reach callers. Mapping runs even when caller interruption is pending, and defects and interruption stay
 * beside the mapped failures
 */
export const mapFailureCause =
    <E, E2>(match: FailureMatch<E>, map: (error: NoInfer<E>) => E2) =>
    <A, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E2, R> =>
        Effect.uninterruptibleMask((restore) =>
            Effect.exit(restore(effect)).pipe(
                Effect.flatMap((exit) =>
                    Exit.isFailure(exit)
                        ? Effect.failCause(mapCause(exit.cause, match, map))
                        : Effect.succeed(exit.value),
                ),
            ),
        )

/**
 * Map a Cause's typed failures and the matching failures Effect turned into defects, keeping each reason's annotations
 * and order. A defect the application raised while the SDK read its input stays unchanged even when its class matches
 */
export function mapCause<E, E2>(
    cause: Cause.Cause<E>,
    match: FailureMatch<E>,
    map: (error: NoInfer<E>) => E2,
): Cause.Cause<E2> {
    const mapped = Cause.map(cause, map)
    if (!Cause.hasDies(cause)) return mapped
    return Cause.fromReasons(
        mapped.reasons.map((reason) =>
            reason._tag === "Die" && !applicationMarked(reason) && match(reason.defect)
                ? Cause.makeDieReason(map(reason.defect)).annotate(Cause.reasonAnnotations(reason))
                : reason,
        ),
    )
}

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
                        (reason) => !Exit.isFailure(exit) || !holdsReason(exit.cause, reason),
                    )
                    return missing.length ? Effect.failCause(Cause.fromReasons(missing)) : Effect.void
                }),
            )
        })

/**
 * Whether a Cause already holds a reason or its failure or defect value. Effect rebuilds a typed failure as a new defect
 * reason when a defect joins it, so matching reasons only by identity would report the same value twice
 */
export function holdsReason(cause: Cause.Cause<unknown>, reason: Cause.Reason<unknown>): boolean {
    if (reason._tag === "Interrupt") return cause.reasons.includes(reason)
    const value = reason._tag === "Fail" ? reason.error : reason.defect
    return cause.reasons.some(
        (held) =>
            held === reason ||
            (held._tag === "Fail" && Object.is(held.error, value)) ||
            (held._tag === "Die" && Object.is(held.defect, value)),
    )
}

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
