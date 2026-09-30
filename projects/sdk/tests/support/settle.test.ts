import { Cause, Effect, Exit } from "effect"
import { err, errAsync, ok, okAsync } from "neverthrow"
import { expect, test } from "vitest"
import { outcome } from "./client-clock.js"
import { expectErr, expectFailure, settle, typedResult } from "./settle.js"

const rejection = { _tag: "FixtureFailure" }
const defect = new Error("fixture cleanup defect")
const mixed = Effect.fail(rejection).pipe(Effect.ensuring(Effect.die(defect)))

test("settle preserves values and the original typed rejection in both API styles", async () => {
    for (const operation of [ok(42), okAsync(42), Effect.succeed(42), 42])
        await expect(settle(operation)).resolves.toBe(42)
    for (const operation of [err(rejection), errAsync(rejection), Effect.fail(rejection)])
        await expect(settle(operation)).rejects.toBe(rejection)
})

test("expectErr preserves typed failures and rejects success in both API styles", async () => {
    for (const operation of [err(rejection), errAsync(rejection), Effect.fail(rejection)])
        await expect(expectErr(operation)).resolves.toBe(rejection)
    for (const operation of [ok(42), okAsync(42), Effect.succeed(42)])
        await expect(expectErr(operation)).rejects.toThrow()
})

test.each([
    { name: "settle", helper: settle },
    { name: "expectErr", helper: expectErr },
])("$name rejects a mixed typed failure and cleanup defect with the defect visible", async ({ helper }) => {
    await expect(helper(mixed)).rejects.toThrow("fixture cleanup defect")
})

test.each([
    { name: "settle", helper: settle },
    { name: "expectErr", helper: expectErr },
])("$name rejects interruption alone or beside a typed failure", async ({ helper }) => {
    await expect(helper(Effect.interrupt)).rejects.toThrow(/interrupt/i)
    await expect(helper(Effect.fail(rejection).pipe(Effect.ensuring(Effect.interrupt)))).rejects.toThrow(/interrupt/i)
    await expect(helper(Effect.die(defect))).rejects.toThrow("fixture cleanup defect")
})

test("expectFailure and typedResult preserve every reason in a mixed Cause", async () => {
    const cause = await expectFailure(mixed)
    expect(Cause.hasFails(cause)).toBe(true)
    expect(Cause.hasDies(cause)).toBe(true)
    const exit = await Effect.runPromiseExit(typedResult(mixed))
    expect(Exit.isFailure(exit) && exit.cause).toEqual(cause)
    await expect(outcome(mixed)).rejects.toThrow("fixture cleanup defect")
    await expect(outcome(Effect.fail(rejection))).resolves.toEqual({ error: rejection })
    await expect(outcome(Effect.succeed(42))).resolves.toEqual({ value: 42 })
})
