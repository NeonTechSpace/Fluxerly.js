import type { Effect } from "effect"
import { expect } from "vitest"
import { expectFailure } from "../support/settle.js"

/** Call a default operation that must throw synchronously and return the thrown value */
export function expectThrown(operation: () => unknown): unknown {
    try {
        operation()
    } catch (error) {
        return error
    }
    return expect.fail("Expected the operation to throw")
}

/**
 * Run a native Effect that must die and return its defect.
 * Native misuse, such as invalid options or an invalid cache lookup, is a defect rather than a typed failure
 */
export async function expectDefect<A, E>(effect: Effect.Effect<A, E>): Promise<unknown> {
    const cause = await expectFailure(effect)
    expect(cause.reasons.some((reason) => reason._tag === "Fail")).toBe(false)
    const die = cause.reasons.find((reason) => reason._tag === "Die")
    if (die?._tag !== "Die") return expect.fail("Expected the Effect to die")
    return die.defect
}
