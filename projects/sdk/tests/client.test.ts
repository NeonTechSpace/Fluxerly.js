import { inspect } from "node:util"
import { Cause, Deferred, Effect, Exit, Fiber, Logger, Result, Scope } from "effect"
import { afterEach, describe, expect, test, vi } from "vitest"
import { ConfigurationError, SdkDefect, createClient } from "../src/index.js"
import { createClient as createEffectClient, type Client } from "../src/effect.js"

afterEach(() => {
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
    ])("rejects invalid configuration with the same typed error ($field)", ({ options, field }) => {
        // @ts-expect-error Exercise malformed input from JavaScript consumers
        const defaultApi = createClient(options)
        // @ts-expect-error Exercise malformed input from JavaScript consumers
        const native = Effect.runSync(Effect.scoped(Effect.result(createEffectClient(options))))

        expect(defaultApi.isErr()).toBe(true)
        expect(Result.isFailure(native)).toBe(true)
        if (defaultApi.isErr() && Result.isFailure(native)) {
            for (const error of [defaultApi.error, native.failure]) {
                expect(error).toBeInstanceOf(ConfigurationError)
                expect(error._tag).toBe("ConfigurationError")
                expect(error.field).toBe(field)
                expect(Object.keys(error).sort()).toEqual(["_tag", "field", "name"])
            }
            expect(native.failure.message).toBe(defaultApi.error.message)
        }
    })

    test("creates opaque, read-only disconnected handles without network calls, timers or logs", () => {
        vi.useFakeTimers()
        const fetch = vi.fn(() => {
            throw new Error("Unexpected HTTP call")
        })
        const webSocket = vi.fn(() => {
            throw new Error("Unexpected WebSocket creation")
        })
        vi.stubGlobal("fetch", fetch)
        vi.stubGlobal("WebSocket", webSocket)
        const messages: unknown[] = []
        const token = "fixture-only-not-a-credential"
        const defaultApi = createClient({ token })
        expect(defaultApi.isOk()).toBe(true)
        if (defaultApi.isErr()) throw defaultApi.error

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

        expect(defaultApi.value.state).toBe("Disconnected")
        expect(Reflect.set(defaultApi.value, "state", "Connected")).toBe(false)
        expect(native.state).toBe("Closed")
        for (const client of [defaultApi.value, native]) {
            expect(inspect(client)).not.toContain(token)
            expect(JSON.stringify(client)).not.toContain(token)
            expect(Object.keys(client)).toEqual([
                "presence",
                "application",
                "users",
                "directMessages",
                "webhooks",
                "emojis",
                "stickers",
                "auditLogs",
                "invites",
                "discovery",
                "guilds",
                "channels",
                "members",
                "permissions",
                "roles",
                "messages",
                "on",
                "events",
                "state",
                "gatewayLatencyMs",
                "connect",
                "run",
                "waitForClose",
                "shutdown",
                "observeState",
            ])
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
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
            expect(Cause.hasFails(exit.cause)).toBe(true)
            expect(Cause.hasDies(exit.cause)).toBe(false)
        }
        expect(acquired?.state).toBe("Closed")
    })

    test("unexpected creation defects stay outside configuration results without exposing private input", () => {
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
            expect(inspect(error)).not.toContain(defect.message)
            expect(JSON.stringify(error)).not.toContain(defect.message)
        }

        const native = Effect.runSyncExit(Effect.scoped(createEffectClient(options)))
        expect(Exit.isFailure(native)).toBe(true)
        if (Exit.isFailure(native)) {
            expect(native.cause.reasons).toEqual([expect.objectContaining({ _tag: "Die", defect })])
        }
    })
})
