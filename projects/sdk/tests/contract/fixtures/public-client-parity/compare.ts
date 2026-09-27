// The one default/native parity comparator. The public client contract compiles it against the real entry points in
// actual.ts and against the deliberate mutations in mutation.ts, so the self-test exercises the same guard
import type * as Effect from "effect/Effect"
import type * as Stream from "effect/Stream"
import type { Result, ResultAsync } from "neverthrow"

/** Strict type identity: A dropped optional member, a changed modifier or a wider type all count as different */
export type Equal<A, B> =
    (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
        ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
            ? true
            : false
        : false

type Outcome<K extends "operation" | "stream", A, E> = {
    readonly kind: K
    readonly success: A
    readonly failure: E
}

type NormalizeReturn<T, Ignored> =
    T extends ResultAsync<infer A, infer E>
        ? Outcome<"operation", A, Exclude<E, Ignored>>
        : T extends Result<infer A, infer E>
          ? Outcome<"operation", A, Exclude<E, Ignored>>
          : T extends AsyncIterable<Result<infer A, infer E>>
            ? Outcome<"stream", A, Exclude<E, Ignored>>
            : T extends Effect.Effect<infer A, infer E, infer _R>
              ? Outcome<"operation", A, Exclude<E, Ignored>>
              : T extends Stream.Stream<infer A, infer E, infer _R>
                ? Outcome<"stream", A, Exclude<E, Ignored>>
                : T

type WithoutSignal<T> = T extends unknown ? ("signal" extends keyof T ? Omit<T, "signal"> : T) : never

// A trailing options parameter that carries only the default API's AbortSignal has no native counterpart
type SignalOnly<T> = "signal" extends keyof Exclude<T, undefined>
    ? [keyof WithoutSignal<Exclude<T, undefined>>] extends [never]
        ? true
        : false
    : false

type WithoutSignalOnlyTail<P extends readonly unknown[]> =
    Required<P> extends readonly [...infer Head, infer Last]
        ? Head extends P
            ? SignalOnly<Last> extends true
                ? Head
                : P
            : P
        : P

// Homomorphic over a type parameter, so tuples stay tuples with their optional elements
type MapWithoutSignal<T extends readonly unknown[]> = { [K in keyof T]: WithoutSignal<T[K]> }

type NormalizeParameters<P extends readonly unknown[]> = MapWithoutSignal<WithoutSignalOnlyTail<P>>

/** Compare shapes without the default-only signal option and with operation and stream outcomes spelled alike */
export type NormalizeMember<T, Ignored = never> = T extends (...args: infer P) => infer R
    ? (...args: NormalizeParameters<P>) => NormalizeReturn<R, Ignored>
    : T

// Default local lookups return the cached value directly, while native lookups return a never-failing Effect
type AsNeverFailingOperation<T> = T extends (...args: infer P) => infer R
    ? (...args: P) => Outcome<"operation", R, never>
    : T

type CallableKeys<P extends readonly [object, object]> = {
    [K in keyof P[0] & keyof P[1]]: P[0][K] extends (...args: never[]) => unknown
        ? P[1][K] extends (...args: never[]) => unknown
            ? K
            : never
        : never
}[keyof P[0] & keyof P[1]]

type DefaultMember<P extends readonly [object, object], K extends keyof P[0], Lookup, Ignored> = K extends Lookup
    ? NormalizeMember<AsNeverFailingOperation<P[0][K]>, never>
    : NormalizeMember<P[0][K], Ignored>

type PairMismatches<P extends readonly [object, object], Excluded, Lookup, Ignored> = {
    [K in Exclude<CallableKeys<P>, Excluded>]: Equal<
        DefaultMember<P, K, Lookup, Ignored>,
        NormalizeMember<P[1][K & keyof P[1]], Ignored>
    > extends true
        ? never
        : K
}[Exclude<CallableKeys<P>, Excluded>]

type Entry<T, K> = K extends keyof T ? T[K] : never

/**
 * Names every `Surface.member` whose default and native signatures differ after the documented normalization.
 * `Paired` maps a surface name to its [default, native] types, `Exceptions` lists members with deliberately different
 * contracts, `Lookups` lists default members that return a local value directly, and `IgnoredFailures` lists
 * failures left out on both sides because the APIs express them differently
 */
export type PairFailures<
    Paired extends Record<string, readonly [object, object]>,
    Exceptions = {},
    Lookups = {},
    IgnoredFailures = never,
> = {
    [
        S in keyof Paired
    ]: `${S & string}.${PairMismatches<Paired[S], Entry<Exceptions, S>, Entry<Lookups, S>, IgnoredFailures> & string}`
}[keyof Paired]

export type AssertNever<T extends never> = T
