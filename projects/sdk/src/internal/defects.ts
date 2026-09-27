/**
 * Default-API defect reasons built from Effect causes, and the marking of faults raised while reading caller input.
 * Invariant: Every failure and defect value is kept, including application-thrown values, marked by which side raised it.
 * A throw from reading caller-supplied input, such as a property getter or an AbortSignal listener method, is marked
 * where the SDK reads that input. A boundary that also runs SDK work marks only the reads made through readCaller, so a
 * fault in the SDK work around them stays an SDK fault.
 * Implements [SDK contracts: Results and failures](/docs/SDK-CONTRACTS.md#results-and-failures)
 */
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { ApplicationError, ConfigurationError, type DefectReason } from "#sdk/errors"
import { fieldsOnce } from "./decode/primitives.js"

/** Cause annotation marking a Die reason whose value the application threw while the SDK read its input */
class ApplicationInput extends Context.Service<ApplicationInput, true>()("@neontechspace/fluxerly/ApplicationInput") {}
const applicationInput = Context.make(ApplicationInput, true)

/** A Die cause for a value thrown while the SDK read caller-supplied input, marked as an application fault */
export const inputDefect = (defect: unknown): Cause.Cause<never> => Cause.annotate(Cause.die(defect), applicationInput)

/** A value thrown by a marked read of caller-supplied input, carried through SDK code to the boundary that reports it */
class InputFault {
    constructor(readonly defect: unknown) {}
}

/**
 * Run one marked synchronous read of caller-supplied input, such as snapshotting an options object or calling an
 * AbortSignal listener method. ConfigurationError passes through as misuse, and any other throw propagates as an input
 * fault that the enclosing boundary reports as an application fault. Every call must run under suspendInput,
 * suspendMarked, thrownCause or thrownReason
 */
export function readCaller<A>(read: () => A): A {
    try {
        return read()
    } catch (error) {
        if (error instanceof ConfigurationError || error instanceof InputFault) throw error
        throw new InputFault(error)
    }
}

/** Read each field of a caller object at most once, with every read marked as readCaller marks it */
export function callerFields(value: Record<string, unknown>): (key: string) => unknown {
    const field = fieldsOnce(value)
    return (key) => readCaller(() => field(key))
}

/** The Die cause for a value thrown through a boundary: Marked as an application fault only when a marked read threw it */
export const thrownCause = (error: unknown): Cause.Cause<never> =>
    error instanceof InputFault ? inputDefect(error.defect) : Cause.die(error)

/** The default-API Defect reason for a value thrown through a synchronous boundary, as thrownCause classifies it */
export const thrownReason = (error: unknown): DefectReason =>
    error instanceof InputFault ? defectReason(error.defect, "application") : defectReason(error)

/**
 * Suspend a body that mixes marked caller reads, made through readCaller, with SDK work. A throw from a marked read dies
 * with its original value marked as an application fault, and any other throw stays an SDK fault
 */
export const suspendMarked = <A, E, R>(body: () => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
        try {
            return body()
        } catch (error) {
            return Effect.failCause(thrownCause(error))
        }
    })

/**
 * Suspend an operation whose synchronous body only reads and validates caller-supplied input before returning the
 * Effect that does the work. A throw from the body dies with the original value, marked as an application fault.
 * The returned Effect runs outside the marked region, so its own defects stay SDK faults
 */
export const suspendInput = <A, E, R>(body: () => Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
        try {
            return body()
        } catch (error) {
            return Effect.failCause(inputDefect(error instanceof InputFault ? error.defect : error))
        }
    })

/** Read caller-supplied input synchronously inside an Effect, marking a throw as an application fault */
export const readInput = <A>(read: () => A): Effect.Effect<A> => suspendInput(() => Effect.succeed(read()))

/**
 * One Defect entry that keeps the original fault value.
 * The origin is application for an ApplicationError naming a callback, or when the caller marks a throw from reading
 * caller-supplied input, and sdk otherwise
 */
export function defectReason(
    defect: unknown,
    origin: "application" | "sdk" = defect instanceof ApplicationError ? "application" : "sdk",
): DefectReason {
    return Object.freeze({ kind: "Defect" as const, defect, origin })
}

/** Convert every Cause entry into a default-API DefectReason, keeping expected failures and fault values */
export function causeReasons(cause: Cause.Cause<unknown>): DefectReason[] {
    return cause.reasons.map((reason) =>
        reason._tag === "Fail"
            ? Object.freeze({
                  kind: "Failure",
                  failure: reason.error as Extract<DefectReason, { readonly kind: "Failure" }>["failure"],
              })
            : reason._tag === "Die"
              ? defectReason(
                    reason.defect,
                    Context.getOrUndefined(Cause.reasonAnnotations(reason), ApplicationInput)
                        ? "application"
                        : undefined,
                )
              : Object.freeze({ kind: "Interruption" }),
    )
}
