import { Cause, Effect, Exit, Scope } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { oauth as defaultApi, SdkDefect } from "../src/index.js"
import { oauth as native } from "../src/effect.js"

afterEach(() => vi.unstubAllGlobals())

test.each(["default", "native"] as const)("%s contains OAuth input accessors inside execution", async (mode) => {
    const fetch = vi.fn(() => {
        throw new Error("Unexpected request")
    })
    vi.stubGlobal("fetch", fetch)
    const scope = Scope.makeUnsafe()
    const config = { clientId: "123", clientSecret: "fixture-only" }
    const client =
        mode === "default"
            ? defaultApi.create(config)._unsafeUnwrap()
            : await Effect.runPromise(native.create(config).pipe(Scope.provide(scope)))
    let reads = 0
    const fail = (): never => {
        reads += 1
        throw new Error("private accessor fixture")
    }
    const authorization = {
        get redirectUri(): string {
            return fail()
        },
        state: "fixture",
        scopes: ["identify"] as const,
        codeChallenge: "a".repeat(43),
    }
    const calls = [
        () => client.authorizationUrl(authorization),
        () =>
            client.exchangeCode({
                get code(): string {
                    return fail()
                },
                redirectUri: "https://example.test/callback",
                codeVerifier: "a".repeat(43),
            }),
        () =>
            client.revoke({
                get token(): string {
                    return fail()
                },
            }),
        () =>
            client.fetchGuilds("fixture", {
                get limit(): number {
                    return fail()
                },
            }),
        () =>
            client.refresh("fixture", {
                get timeoutMs(): number {
                    return fail()
                },
            }),
        () => client.introspect("fixture", new Proxy({}, { ownKeys: fail })),
    ]
    try {
        for (const call of calls) {
            const before = reads
            let operation: ReturnType<typeof call> | undefined
            expect(() => {
                operation = call()
            }).not.toThrow()
            if (Effect.isEffect(operation)) {
                expect(reads).toBe(before)
                const exit = await Effect.runPromiseExit(operation)
                expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
            } else {
                if (!operation) throw new Error("Missing default operation")
                const failure = await operation.then(
                    () => undefined,
                    (error: unknown) => error,
                )
                expect(failure).toBeInstanceOf(SdkDefect)
                expect(String(failure)).not.toContain("private accessor fixture")
            }
            expect(reads).toBeGreaterThan(before)
        }
        expect(fetch).not.toHaveBeenCalled()
    } finally {
        const closing = client.shutdown()
        if (Effect.isEffect(closing)) await Effect.runPromise(closing)
        else await closing
        await Effect.runPromise(Scope.close(scope, Exit.void))
    }
})

test("default OAuth signal copying returns a rejected ResultAsync rather than throwing", async () => {
    const client = defaultApi.create({ clientId: "123", clientSecret: "fixture-only" })._unsafeUnwrap()
    try {
        const options = {
            get signal(): AbortSignal {
                throw new Error("private signal fixture")
            },
        }
        let operation: ReturnType<typeof client.fetchIdentity> | undefined
        expect(() => {
            operation = client.fetchIdentity("fixture", options)
        }).not.toThrow()
        if (!operation) throw new Error("Missing operation")
        await expect(operation).rejects.toBeInstanceOf(SdkDefect)
        await expect(operation).rejects.not.toThrow("private signal fixture")
    } finally {
        await client.shutdown()
    }
})
