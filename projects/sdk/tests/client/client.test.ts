import { inspect } from "node:util"
import { Cause, Deferred, Effect, Exit, Fiber, Logger, Scope } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import { ConfigurationError, SdkDefect, createClient } from "../../src/index.js"
import { createClient as createEffectClient, type Client } from "../../src/effect.js"
import { thrownBy } from "../support/client-creation.js"

const webSocket = vi.hoisted(() =>
    vi.fn(function () {
        throw new Error("Unexpected WebSocket creation")
    }),
)

vi.mock("ws", () => ({ default: webSocket }))

/** The single defect of a failed Exit, failing the test when it succeeded or failed differently */
function defectOf(exit: Exit.Exit<unknown, unknown>): unknown {
    if (Exit.isSuccess(exit)) return expect.fail("Expected the Effect to die")
    const dies = exit.cause.reasons.filter((reason) => reason._tag === "Die")
    expect(dies).toHaveLength(1)
    return dies[0]?._tag === "Die" ? dies[0].defect : undefined
}

afterEach(() => {
    webSocket.mockClear()
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

describe("client creation through both public entry points", () => {
    test.each([
        { options: null, field: "configuration" },
        { options: undefined, field: "configuration" },
        { options: [], field: "configuration" },
        { options: "invalid", field: "configuration" },
        { options: {}, field: "token" },
        { options: { token: null }, field: "token" },
        { options: { token: 42 }, field: "token" },
        { options: { token: "" }, field: "token" },
        { options: { token: " \t\n" }, field: "token" },
    ])("rejects invalid configuration with the same ConfigurationError ($field)", ({ options, field }) => {
        // The default API throws the error, while the native API dies with it as misuse
        const defaultError = thrownBy(() => createClient(options as never))
        const native = Effect.runSyncExit(Effect.scoped(createEffectClient(options as never)))
        const nativeError = defectOf(native)

        for (const error of [defaultError, nativeError]) {
            expect(error).toBeInstanceOf(ConfigurationError)
            if (!(error instanceof ConfigurationError)) continue
            expect(error._tag).toBe("ConfigurationError")
            expect(error.field).toBe(field)
            expect(Object.keys(error).sort()).toEqual(["_tag", "code", "details", "field", "hint", "name"])
        }
        expect((nativeError as ConfigurationError).message).toBe((defaultError as ConfigurationError).message)
    })

    test.each([
        { name: "undefined", token: undefined },
        { name: "empty", token: "" },
        { name: "blank", token: "   " },
    ])("a $name token names an unset environment variable and a missing --env-file as likely causes", ({ token }) => {
        const defaultError = thrownBy(() => createClient({ token }))
        const nativeError = defectOf(Effect.runSyncExit(Effect.scoped(createEffectClient({ token }))))
        for (const error of [defaultError, nativeError]) {
            expect(error).toBeInstanceOf(ConfigurationError)
            expect(error).toMatchObject({ field: "token" })
            expect((error as ConfigurationError).hint).toContain("environment variable")
            expect((error as ConfigurationError).hint).toContain("--env-file=.env")
            expect((error as ConfigurationError).hint).toContain(".env.txt")
        }
    })

    test.each([
        { options: { token: "fixture-only-not-a-credential", loging: {} }, suggestion: "logging" },
        { options: { token: "fixture-only-not-a-credential", intents: 513 }, suggestion: undefined },
    ])("rejects an unknown top-level option and names the closest supported one", ({ options, suggestion }) => {
        const defaultError = thrownBy(() => createClient(options as never))
        const nativeError = defectOf(Effect.runSyncExit(Effect.scoped(createEffectClient(options as never))))
        for (const error of [defaultError, nativeError]) {
            expect(error).toBeInstanceOf(ConfigurationError)
            const { field, hint } = error as ConfigurationError
            expect(field).toBe("configuration")
            // The hint lists the supported options, and leads with a suggestion only when one is close
            expect(hint).toContain("token")
            if (suggestion === undefined) expect(hint).not.toContain("Did you mean")
            else expect(hint).toContain(JSON.stringify(suggestion))
        }
    })

    test.each(["Bot fixture-only-not-a-credential", "bearer fixture-only-not-a-credential"])(
        "rejects a token that carries an auth scheme without echoing it (%s)",
        (token) => {
            const defaultError = thrownBy(() => createClient({ token }))
            const nativeError = defectOf(Effect.runSyncExit(Effect.scoped(createEffectClient({ token }))))
            for (const error of [defaultError, nativeError]) {
                expect(error).toMatchObject({ _tag: "ConfigurationError", field: "token" })
                expect(JSON.stringify((error as ConfigurationError).toJSON())).not.toContain("fixture-only")
            }
        },
    )

    test("creates opaque, read-only disconnected handles without network calls, timers or logs", () => {
        vi.useFakeTimers()
        const fetch = vi.fn(() => {
            throw new Error("Unexpected HTTP call")
        })
        vi.stubGlobal("fetch", fetch)
        const messages: unknown[] = []
        const token = "fixture-only-not-a-credential"
        const defaultApi = createClient({ token })

        const native = Effect.runSync(
            Effect.scoped(
                Effect.gen(function* () {
                    const client = yield* createEffectClient({ token })
                    expect(client.state).toBe("Disconnected")
                    expect(Reflect.set(client, "state", "Connected")).toBe(false)
                    return client
                }),
            ).pipe(
                Effect.withLogger(
                    Logger.make((entry) => {
                        messages.push(entry.message)
                    }),
                ),
            ),
        )

        expect(defaultApi.state).toBe("Disconnected")
        expect(Reflect.set(defaultApi, "state", "Connected")).toBe(false)
        expect(native.state).toBe("Closed")
        for (const client of [defaultApi, native]) {
            expect(inspect(client)).not.toContain(token)
            expect(JSON.stringify(client)).not.toContain(token)
        }
        expect(fetch).not.toHaveBeenCalled()
        expect(webSocket).not.toHaveBeenCalled()
        expect(vi.getTimerCount()).toBe(0)
        expect(messages).toEqual([])
    })

    test("native creation is lazy and each execution creates a separate client", () => {
        let reads = 0
        const creation = createEffectClient({
            get token() {
                reads += 1
                return "fixture-only-not-a-credential"
            },
        })
        expect(reads).toBe(0)
        const first = Effect.runSync(Effect.scoped(creation))
        const second = Effect.runSync(Effect.scoped(creation))
        expect(reads).toBe(2)
        expect(first).not.toBe(second)
        expect(first.state).toBe("Closed")
        expect(second.state).toBe("Closed")
    })

    test("closing an owning scope closes only its clients and is repeat-safe", () => {
        const firstScope = Scope.makeUnsafe()
        const secondScope = Scope.makeUnsafe()
        const options = { token: "fixture-only-not-a-credential" }
        const first = Effect.runSync(createEffectClient(options).pipe(Scope.provide(firstScope)))
        const sibling = Effect.runSync(createEffectClient(options).pipe(Scope.provide(firstScope)))
        const independent = Effect.runSync(createEffectClient(options).pipe(Scope.provide(secondScope)))
        try {
            Effect.runSync(Scope.close(firstScope, Exit.void))
            Effect.runSync(Scope.close(firstScope, Exit.void))
            expect(first.state).toBe("Closed")
            expect(sibling.state).toBe("Closed")
            expect(independent.state).toBe("Disconnected")
        } finally {
            Effect.runSync(Scope.close(firstScope, Exit.void))
            Effect.runSync(Scope.close(secondScope, Exit.void))
        }
    })

    test("interruption closes the actual native client before completing", async () => {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const created = yield* Deferred.make<Client>()
                    const worker = yield* Effect.forkScoped(
                        Effect.scoped(
                            Effect.gen(function* () {
                                const client = yield* createEffectClient({ token: "fixture-only-not-a-credential" })
                                yield* Deferred.succeed(created, client)
                                yield* Effect.never
                            }),
                        ),
                    )
                    const client = yield* Deferred.await(created)
                    expect(client.state).toBe("Disconnected")
                    yield* Fiber.interrupt(worker)
                    expect(client.state).toBe("Closed")
                    const exit = yield* Effect.exit(Fiber.join(worker))
                    expect(Exit.isFailure(exit)).toBe(true)
                    if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
                }),
            ),
        )
    })

    test("an escaping configuration failure closes clients already owned by that scope", () => {
        let acquired: Client | undefined
        const exit = Effect.runSyncExit(
            Effect.scoped(
                Effect.gen(function* () {
                    acquired = yield* createEffectClient({ token: "fixture-only-not-a-credential" })
                    yield* createEffectClient({ token: "" })
                }),
            ),
        )
        // Invalid native options are misuse, so they die rather than fail with a typed error
        expect(defectOf(exit)).toBeInstanceOf(ConfigurationError)
        if (Exit.isFailure(exit)) expect(Cause.hasFails(exit.cause)).toBe(false)
        expect(acquired?.state).toBe("Closed")
    })

    test("unexpected creation defects stay outside configuration results and carry the original defect", () => {
        const defect = new Error("fixture-only-private-detail")
        const options = {
            get token(): string {
                throw defect
            },
        }
        expect(() => createClient(options)).toThrow(SdkDefect)
        try {
            createClient(options)
            expect.fail("Creation must throw")
        } catch (error) {
            expect(error).toBeInstanceOf(SdkDefect)
            expect(inspect(error)).toContain(defect.message)
            expect(JSON.stringify(error)).toContain(defect.message)
        }

        const native = Effect.runSyncExit(Effect.scoped(createEffectClient(options)))
        expect(Exit.isFailure(native)).toBe(true)
        if (Exit.isFailure(native)) {
            expect(native.cause.reasons).toEqual([expect.objectContaining({ _tag: "Die", defect })])
        }
    })
})
