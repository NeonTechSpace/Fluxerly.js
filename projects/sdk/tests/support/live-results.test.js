import { Cause, Effect, Exit } from "effect"
import { expect, test } from "vitest"
import { fromExit, settle, typedResult } from "../live/support/results.js"

const rejection = { _tag: "FixtureFailure" }

test("live result helpers preserve success values and pure typed failures", async () => {
    await expect(settle(Effect.succeed(42))).resolves.toBe(42)
    await expect(settle(Effect.fail(rejection))).rejects.toBe(rejection)
    expect(await Effect.runPromise(typedResult(Effect, Effect.fail(rejection)))).toMatchObject({
        _tag: "Failure",
        failure: rejection,
    })
})

test("live result capture preserves a failure converted beside a defect while settlement keeps defect details private", async () => {
    const defect = new Error("fixture private defect detail")
    const mixed = Effect.fail(rejection).pipe(Effect.ensuring(Effect.die(defect)))
    const exit = await Effect.runPromiseExit(typedResult(Effect, mixed))
    expect(Exit.isFailure(exit)).toBe(true)
    // Effect turns a typed failure beside a defect into a defect that keeps its value
    expect(Cause.hasFails(exit.cause)).toBe(false)
    expect(exit.cause.reasons.map((reason) => reason._tag)).toEqual(["Die", "Die"])
    expect(exit.cause.reasons[0].defect).toBe(rejection)
    expect(exit.cause.reasons[1].defect).toBe(defect)
    const error = await settle(mixed).catch((failure) => failure)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).not.toContain("fixture private defect detail")
})

test("live settlement does not mistake a typed failure with interruption for a pure typed rejection", async () => {
    const mixed = Effect.fail(rejection).pipe(Effect.ensuring(Effect.interrupt))
    const exit = await Effect.runPromiseExit(mixed)
    expect(() => fromExit(exit)).toThrow(expect.objectContaining({ _tag: "TestInterrupted" }))
    await expect(settle(mixed)).rejects.toMatchObject({ _tag: "TestInterrupted" })
})
