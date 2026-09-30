import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { afterEach, expect, test, vi } from "vitest"
import { TestHarness } from "../../../src/internal/testing/harness.js"
import { SupervisorChildError } from "../../../src/supervisor.js"

afterEach(() => {
    vi.doUnmock("#sdk/internal/supervisor")
    vi.useRealTimers()
    vi.resetModules()
})

function controlledBridge() {
    const stop = Deferred.makeUnsafe<void, SupervisorChildError>()
    const connected = Promise.withResolvers<void>()
    const closed = Promise.withResolvers<void>()
    return {
        drainMs: 10_000,
        identifyGate: { permit: (_shard: number, send: () => void) => Effect.sync(send) },
        signal: new AbortController().signal,
        waitForAssignment: () => Effect.succeed({ totalShards: 1, shardIds: [0] }),
        waitForStop: () => Deferred.await(stop),
        ready: () => undefined,
        state: (state: string) => {
            if (state === "Connected") connected.resolve()
        },
        failed: vi.fn(),
        close: () => closed.resolve(),
        reportDiagnostics: () => undefined,
        connected: connected.promise,
        closed: closed.promise,
        stop: (failure = false) =>
            Deferred.doneUnsafe(stop, failure ? Effect.fail(new SupervisorChildError("disconnected")) : Effect.void),
    }
}

test.each((["default", "native"] as const).flatMap((mode) => [false, true].map((failure) => [mode, failure] as const)))(
    "%s real child preserves drain and failure cleanup ordering (failure: %s)",
    async (mode, failure) => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
        vi.resetModules()
        const bridge = controlledBridge()
        vi.doMock("#sdk/internal/supervisor", async (original) => ({
            ...(await original<object>()),
            ChildBridge: { open: () => Effect.succeed(bridge) },
        }))
        const gate = Promise.withResolvers<void>()
        const started = Promise.withResolvers<void>()
        const draining = Promise.withResolvers<void>()
        let cancelled = false
        const harness = new TestHarness({})
        harness.http.respond("POST /channels/:id/messages", { body: harness.fixtures.message({ content: "done" }) })
        const { token, ...clientOptions } = harness.clientOptions({
            logging: {
                sink: (record: { code: string }) => {
                    if (record.code === "lifecycle.draining") draining.resolve()
                },
            },
        })
        let running: Promise<unknown>
        if (mode === "default") {
            const { supervisor } = await import("../../../src/index.js")
            running = Promise.resolve(
                supervisor.child.run({
                    token,
                    clientOptions,
                    configure: ({ client }) => {
                        client.on("messageCreate", async (message, signal) => {
                            signal.addEventListener(
                                "abort",
                                () => {
                                    cancelled = true
                                },
                                { once: true },
                            )
                            started.resolve()
                            await gate.promise
                            await client.messages.reply(message, "done", { signal })
                        })
                    },
                }),
            )
        } else {
            const { supervisor } = await import("../../../src/effect.js")
            running = Effect.runPromiseExit(
                supervisor.child.run({
                    token,
                    clientOptions,
                    configure: ({ client }) =>
                        client
                            .on("messageCreate", (message) =>
                                Effect.sync(() => started.resolve()).pipe(
                                    Effect.andThen(Effect.promise(() => gate.promise)),
                                    Effect.andThen(client.messages.reply(message, "done")),
                                    Effect.asVoid,
                                    Effect.onInterrupt(() =>
                                        Effect.sync(() => {
                                            cancelled = true
                                        }),
                                    ),
                                ),
                            )
                            .pipe(Effect.asVoid),
                }),
            )
        }
        try {
            await vi.advanceTimersByTimeAsync(0)
            await bridge.connected
            harness.gateway.emit("MESSAGE_CREATE", harness.fixtures.message(), undefined)
            await started.promise
            bridge.stop(failure)
            // Broken ordering closes run before a drain starts, so this also settles against the regression
            await Promise.race([draining.promise, bridge.closed])
            gate.resolve()
            const result = await running
            if (mode === "default")
                expect(result).toMatchObject(
                    failure ? { error: { _tag: "SupervisorChildError" } } : { value: undefined },
                )
            else {
                const exit = result as Exit.Exit<unknown, unknown>
                expect(Exit.isSuccess(exit)).toBe(!failure)
                if (Exit.isFailure(exit))
                    expect(exit.cause.reasons).toEqual([
                        expect.objectContaining({
                            _tag: "Fail",
                            error: expect.objectContaining({ _tag: "SupervisorChildError" }),
                        }),
                    ])
            }
            expect(harness.http.requests().filter((request) => request.method === "POST")).toHaveLength(failure ? 0 : 1)
            expect(harness.logs().some((record) => record.code === "lifecycle.drained")).toBe(!failure)
            if (failure) {
                expect(cancelled).toBe(true)
                expect(harness.logs().some((record) => record.code === "lifecycle.draining")).toBe(false)
            }
        } finally {
            gate.resolve()
            bridge.stop()
            await running
            harness.close()
        }
    },
)
