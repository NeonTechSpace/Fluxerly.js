// Compile-only check, run by the test typecheck: a failure matcher must list every failure class the mapped Effect can
// fail with, so a converted failure of an unlisted class cannot reach callers unmapped
// The rejected mapping below is the point of this file, so the Effect diagnostic for it is off
// @effect-diagnostics missingEffectError:off
import * as Effect from "effect/Effect"
import { failures, mapFailureCause } from "../../src/internal/effect-failures.js"

class FirstFailure {
    readonly _tag = "FirstFailure"
}

class SecondFailure {
    readonly _tag = "SecondFailure"
}

declare const work: Effect.Effect<void, FirstFailure | SecondFailure>

export const complete = work.pipe(mapFailureCause(failures(FirstFailure, SecondFailure), (error) => error._tag))

// @ts-expect-error The matcher misses SecondFailure
export const incomplete = work.pipe(mapFailureCause(failures(FirstFailure), (error) => error._tag))
