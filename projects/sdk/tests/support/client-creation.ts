import { Effect, Exit, Scope } from "effect"
import { expect } from "vitest"
import { ConfigurationError, createClient, type ClientOptions } from "../../src/index.js"
import { createClient as createNative } from "../../src/effect.js"
import { fixtureToken, type Mode } from "./both-apis.js"

/** The value thrown by a synchronous call, failing the test when it returns */
export function thrownBy(call: () => unknown): unknown {
    try {
        call()
    } catch (error) {
        return error
    }
    return expect.fail("Expected the call to throw")
}

/**
 * Creation outcome for one API style with the fixture token and the given options: The ConfigurationError field, or
 * undefined when creation succeeded. The default API throws the error, while the native API dies with it as misuse
 */
export async function creationField(mode: Mode, options: object): Promise<string | undefined> {
    const input = { token: fixtureToken, ...options } as ClientOptions
    if (mode === "default") {
        try {
            const client = createClient(input)
            await client.shutdown()
            return undefined
        } catch (error) {
            expect(error).toBeInstanceOf(ConfigurationError)
            return (error as ConfigurationError).field
        }
    }
    const scope = Scope.makeUnsafe()
    const exit = await Effect.runPromiseExit(
        createNative(input as never).pipe(
            Effect.flatMap((client) => client.shutdown()),
            Scope.provide(scope),
        ),
    )
    await Effect.runPromise(Scope.close(scope, Exit.void))
    if (Exit.isSuccess(exit)) return undefined
    const reason = exit.cause.reasons.find((item) => item._tag === "Die")
    const defect = reason?._tag === "Die" ? reason.defect : undefined
    expect(defect).toBeInstanceOf(ConfigurationError)
    return (defect as ConfigurationError).field
}
