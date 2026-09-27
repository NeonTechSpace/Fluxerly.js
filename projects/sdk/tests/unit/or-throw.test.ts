import { err, errAsync, ok, okAsync } from "neverthrow"
import { expect, test } from "vitest"
import { orThrow } from "../../src/index.js"

const failure = new Error("fixture failure")

test("orThrow returns the value of an Ok result synchronously", () => {
    const value = { id: "10" }
    expect(orThrow(ok(value))).toBe(value)
})

test("orThrow throws the error of an Err result itself, not a wrapper", () => {
    expect(() => orThrow(err(failure))).toThrow(failure)
    // Non-Error failures are thrown unchanged too
    const tagged = { _tag: "FixtureFailure" }
    try {
        orThrow(err(tagged))
        expect.fail("orThrow must throw")
    } catch (error) {
        expect(error).toBe(tagged)
    }
})

test("orThrow resolves a ResultAsync with its value or rejects with its error", async () => {
    const pending = orThrow(okAsync("value"))
    expect(pending).toBeInstanceOf(Promise)
    await expect(pending).resolves.toBe("value")
    await expect(orThrow(errAsync(failure))).rejects.toBe(failure)
})

test("orThrow accepts any promise of a Result", async () => {
    await expect(orThrow(Promise.resolve(ok(1)))).resolves.toBe(1)
    await expect(orThrow(Promise.resolve(err(failure)))).rejects.toBe(failure)
})
