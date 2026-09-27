import { inspect } from "node:util"
import { Cause, Effect, Exit, Scope } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { WebSocket } from "ws"
import { createClient, SdkDefect } from "../../src/index.js"
import { createClient as createNative } from "../../src/effect.js"
import { startInstance } from "../support/instance.js"

async function fixture() {
    const { instance, gateway } = await startInstance()
    return {
        sockets: gateway.sockets,
        options: { token: "fixture-only-token", instance: { url: instance, allowInsecure: true as const } },
    }
}

function expectShutdownCause(exit: Exit.Exit<void, never>, cleanup: Error) {
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    expect(Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(Cause.hasDies(exit.cause)).toBe(true)
    expect(exit.cause.reasons.some((reason) => reason._tag === "Fail")).toBe(false)
    const defect = exit.cause.reasons.find((reason) => reason._tag === "Die")
    expect(defect?._tag).toBe("Die")
    if (defect?._tag === "Die") expect(defect.defect).toBe(cleanup)
}

function expectConnectionAndCleanup(exit: Exit.Exit<void, unknown>, cleanup: Error) {
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) return
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    expect(failure?._tag).toBe("Fail")
    if (failure?._tag === "Fail") expect(failure.error).toMatchObject({ _tag: "ConnectionError" })
    const defect = exit.cause.reasons.find((reason) => reason._tag === "Die")
    expect(defect?._tag).toBe("Die")
    if (defect?._tag === "Die") expect(defect.defect).toBe(cleanup)
}

afterEach(() => vi.restoreAllMocks())

test("shutdown keeps interrupted cleanup causes structural across native, default, concurrent and late callers", async () => {
    const server = await fixture()
    const scope = Scope.makeUnsafe()
    const cleanup = new Error("private-shutdown-cleanup-sentinel")
    try {
        const native = await Effect.runPromise(createNative(server.options).pipe(Scope.provide(scope)))
        await Effect.runPromise(native.connect())
        const close = vi.spyOn(WebSocket.prototype, "close").mockImplementation(() => {
            throw cleanup
        })
        const [first, second] = await Promise.all([
            Effect.runPromiseExit(native.shutdown()),
            Effect.runPromiseExit(native.shutdown()),
        ])
        const late = await Effect.runPromiseExit(native.shutdown())
        for (const exit of [first, second, late]) expectShutdownCause(exit, cleanup)
        close.mockRestore()

        const defaultClient = createClient(server.options)
        await defaultClient.connect()
        const defaultClose = vi.spyOn(WebSocket.prototype, "close").mockImplementation(() => {
            throw cleanup
        })
        const error = await Promise.resolve(defaultClient.shutdown()).then(
            () => undefined,
            (error: unknown) => error,
        )
        defaultClose.mockRestore()
        expect(error).toBeInstanceOf(SdkDefect)
        if (error instanceof SdkDefect) {
            expect(error.reasons).toEqual(
                expect.arrayContaining([{ kind: "Interruption" }, expect.objectContaining({ kind: "Defect" })]),
            )
            expect(inspect(error)).toContain(cleanup.message)
            expect(JSON.stringify(error)).toContain(cleanup.message)
        }
    } finally {
        await Effect.runPromiseExit(Scope.close(scope, Exit.void))
    }
})

test("waitForClose and run retain a permanent connection failure beside its cleanup defect", async () => {
    const server = await fixture()
    const cleanup = new Error("private-mixed-cleanup-sentinel")
    const waitScope = Scope.makeUnsafe()
    const runScope = Scope.makeUnsafe()
    try {
        const waiting = await Effect.runPromise(createNative(server.options).pipe(Scope.provide(waitScope)))
        await Effect.runPromise(waiting.connect())
        const waitClose = vi.spyOn(WebSocket.prototype, "close").mockImplementation(() => {
            throw cleanup
        })
        server.sockets.at(-1)!.send("not JSON")
        expectConnectionAndCleanup(await Effect.runPromiseExit(waiting.waitForClose()), cleanup)
        waitClose.mockRestore()

        const running = await Effect.runPromise(createNative(server.options).pipe(Scope.provide(runScope)))
        const run = Effect.runPromiseExit(running.run())
        await vi.waitFor(() => expect(running.state).toBe("Connected"))
        const runClose = vi.spyOn(WebSocket.prototype, "close").mockImplementation(() => {
            throw cleanup
        })
        server.sockets.at(-1)!.send("not JSON")
        expectConnectionAndCleanup(await run, cleanup)
        runClose.mockRestore()
    } finally {
        await Effect.runPromiseExit(Scope.close(waitScope, Exit.void))
        await Effect.runPromiseExit(Scope.close(runScope, Exit.void))
    }
})
