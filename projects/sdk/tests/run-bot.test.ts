import { once } from "node:events"
import { createServer } from "node:http"
import { Cause, Effect, Exit } from "effect"
import { ok } from "neverthrow"
import { WebSocket, WebSocketServer } from "ws"
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest"
import { CriticalWorkerStoppedError, runBot, type Client, type Subscription } from "../src/index.js"
import {
    CriticalWorkerStoppedError as NativeCriticalWorkerStoppedError,
    runBot as runNativeBot,
    type Client as NativeClient,
} from "../src/effect.js"
import { runBotCore } from "../src/internal/bot-runner.js"
import { hostedDiscoveryDocument } from "./hosted-discovery.js"

const transport = vi.hoisted(() => ({ url: "" }))
vi.mock("ws", async (original) => {
    const module = await original<typeof import("ws")>()
    return {
        ...module,
        default: class extends module.default {
            constructor(url: string, options: import("ws").ClientOptions) {
                super(transport.url || url, options)
            }
        },
    }
})

afterEach(() => {
    vi.unstubAllGlobals()
    transport.url = ""
})

function deferred<A>() {
    let resolve!: (value: A) => void
    const promise = new Promise<A>((complete) => {
        resolve = complete
    })
    return { promise, resolve }
}

async function gateway(holdReady = false) {
    const server = createServer()
    const gateway = new WebSocketServer({ server })
    const sockets: WebSocket[] = []
    const identified = deferred<void>()
    gateway.on("connection", (socket) => {
        sockets.push(socket)
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
        socket.on("message", (data) => {
            const command = JSON.parse(data.toString()) as { op: number }
            if (command.op !== 2) return
            identified.resolve()
            if (!holdReady)
                socket.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "fixture-session" } }))
        })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Expected loopback listener")
    transport.url = `ws://127.0.0.1:${address.port}`
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(hostedDiscoveryDocument)),
    )
    onTestFinished(async () => {
        for (const socket of sockets) socket.terminate()
        await new Promise<void>((resolve) => gateway.close(() => resolve()))
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return { identified: identified.promise }
}

const token = "fixture-only-not-a-credential"

describe("public runBot", () => {
    test("pre-aborted runs do not create clients or install handlers", async () => {
        const install = vi.fn(() => [])
        expect((await runBot({ token: "" }, install, { signal: AbortSignal.abort() })).isOk()).toBe(true)
        expect(install).not.toHaveBeenCalled()

        const nativeInstall = vi.fn(() => Effect.succeed([]))
        const native = await Effect.runPromiseExit(
            runNativeBot({ token: "" }, nativeInstall, { signal: AbortSignal.abort() }),
        )
        expect(Exit.isSuccess(native)).toBe(true)
        expect(nativeInstall).not.toHaveBeenCalled()
    })

    test("invalid configuration stays in each expected-failure channel", async () => {
        const result = await runBot({ token: "" }, () => [])
        expect(result.isErr() && result.error._tag).toBe("ConfigurationError")
        const native = await Effect.runPromiseExit(runNativeBot({ token: "" }, () => Effect.succeed([])))
        expect(Exit.isFailure(native)).toBe(true)
        if (Exit.isFailure(native))
            expect(
                native.cause.reasons.some(
                    (reason) => reason._tag === "Fail" && reason.error._tag === "ConfigurationError",
                ),
            ).toBe(true)
    })

    test("malformed JavaScript runner options fail before client creation or signal registration", async () => {
        const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]
        const install = vi.fn(() => [])
        const invalid = { processSignals: "yes" } as unknown as import("../src/index.js").RunBotOptions
        const result = await runBot({ token }, install, invalid)
        expect(result.isErr() && result.error._tag).toBe("ConfigurationError")
        expect(install).not.toHaveBeenCalled()
        const native = await Effect.runPromiseExit(
            runNativeBot({ token }, () => Effect.succeed([]), {
                signal: 1,
            } as unknown as import("../src/effect.js").RunBotOptions),
        )
        expect(Exit.isFailure(native)).toBe(true)
        if (Exit.isFailure(native))
            expect(
                native.cause.reasons.some(
                    (reason) => reason._tag === "Fail" && reason.error._tag === "ConfigurationError",
                ),
            ).toBe(true)
        expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before)
    })

    test("a throwing synchronous installer is sanitized and its client is closed", async () => {
        const error = new Error("private application detail")
        let client: Client | undefined
        await expect(
            runBot({ token }, (created) => {
                client = created
                throw error
            }),
        ).rejects.toMatchObject({ name: "SdkDefect", operation: "runBot", reasons: [{ kind: "Defect" }] })
        expect(client?.state).toBe("Closed")
    })

    test("default runner retains trusted startup failure plus cleanup defect without private text", async () => {
        const cleanup = new Error("private discovery cleanup detail")
        vi.stubGlobal(
            "fetch",
            vi.fn(
                async () =>
                    new Response(
                        new ReadableStream({
                            cancel: () => {
                                throw cleanup
                            },
                        }),
                        { status: 401 },
                    ),
            ),
        )
        const failure = await Promise.resolve(runBot({ token, connection: { maxStartupAttempts: 2 } }, () => [])).catch(
            (error: unknown) => error,
        )
        expect(failure).toMatchObject({
            name: "SdkDefect",
            operation: "runBot",
            reasons: expect.arrayContaining([
                { kind: "Failure", failure: expect.objectContaining({ _tag: "ConnectionError", phase: "discovery" }) },
                { kind: "Defect" },
            ]),
        })
        expect(JSON.stringify(failure)).not.toContain("private discovery cleanup detail")
    })

    test("native installation failure is retained and closes the client", async () => {
        const error = new Error("installation")
        let client: NativeClient | undefined
        const exit = await Effect.runPromiseExit(
            runNativeBot({ token }, (created) => {
                client = created
                return Effect.fail(error)
            }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
            expect(exit.cause.reasons.some((reason) => reason._tag === "Fail" && reason.error === error)).toBe(true)
        expect(client?.state).toBe("Closed")
    })

    test("signal stop awaits default and native gateway cleanup without process handlers", async () => {
        const fixture = await gateway(true)
        const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]
        const abort = new AbortController()
        let client: Client | undefined
        const running = runBot(
            { token },
            (created) => {
                client = created
                return []
            },
            { signal: abort.signal },
        )
        await fixture.identified
        expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before)
        abort.abort()
        expect((await running).isOk()).toBe(true)
        expect(client?.state).toBe("Closed")

        const nativeAbort = new AbortController()
        const nativeInstalled = deferred<void>()
        let nativeClient: NativeClient | undefined
        const native = Effect.runPromiseExit(
            runNativeBot(
                { token },
                (created) =>
                    Effect.sync(() => {
                        nativeClient = created
                        nativeInstalled.resolve()
                        return []
                    }),
                { signal: nativeAbort.signal },
            ),
        )
        await nativeInstalled.promise
        nativeAbort.abort()
        expect(Exit.isSuccess(await native)).toBe(true)
        expect(nativeClient?.state).toBe("Closed")
        expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before)
    })

    test("process signal handlers are opt-in and removed after shutdown", async () => {
        const fixture = await gateway(true)
        const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]
        const running = runBot({ token }, () => [], { processSignals: true })
        await fixture.identified
        expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before.map((n) => n + 1))
        process.emit("SIGINT")
        expect((await running).isOk()).toBe(true)
        expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before)
    })

    test("early critical subscription closure fails through both public entry points", async () => {
        await gateway(true)
        const defaultWorker = {
            unsubscribe: () => undefined,
            waitForClose: () => Promise.resolve(ok(undefined)),
        } as unknown as Subscription
        const result = await runBot({ token }, () => [defaultWorker])
        expect(result.isErr() && result.error).toBeInstanceOf(CriticalWorkerStoppedError)

        const native = await Effect.runPromiseExit(
            runNativeBot({ token }, (client) =>
                Effect.gen(function* () {
                    const worker = yield* client.on("messageCreate", () => Effect.void)
                    yield* worker.unsubscribe()
                    return [worker]
                }),
            ),
        )
        expect(Exit.isFailure(native)).toBe(true)
        if (Exit.isFailure(native))
            expect(
                native.cause.reasons.some(
                    (reason) => reason._tag === "Fail" && reason.error instanceof NativeCriticalWorkerStoppedError,
                ),
            ).toBe(true)
    })

    test("native signal cancels pending installation and awaits cleanup", async () => {
        const abort = new AbortController()
        const entered = deferred<void>()
        let client: NativeClient | undefined
        const result = Effect.runPromiseExit(
            runNativeBot(
                { token },
                (created) =>
                    Effect.sync(() => {
                        client = created
                        entered.resolve()
                    }).pipe(Effect.andThen(Effect.never)),
                { signal: abort.signal },
            ),
        )
        await entered.promise
        abort.abort()
        expect(Exit.isSuccess(await result)).toBe(true)
        expect(client?.state).toBe("Closed")
    })
})

describe("shared runner failure preservation", () => {
    test("operation, worker and shutdown failures remain in Cause", async () => {
        const operation = new Error("operation")
        const worker = new Error("worker")
        const cleanup = new Error("cleanup")
        const client = {
            state: "Connecting",
            run: () => Effect.fail(operation),
            shutdown: () => Effect.die(cleanup),
        }
        const exit = await Effect.runPromiseExit(
            runBotCore(Effect.succeed(client), () => Effect.succeed([{ waitForClose: () => Effect.fail(worker) }]), {}),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
            expect(exit.cause.reasons.some((reason) => reason._tag === "Fail" && reason.error === operation)).toBe(true)
            expect(exit.cause.reasons.some((reason) => reason._tag === "Fail" && reason.error === worker)).toBe(true)
            expect(exit.cause.reasons.some((reason) => reason._tag === "Die" && reason.defect === cleanup)).toBe(true)
        }
    })

    test("external fiber interruption retains a cleanup defect", async () => {
        const cleanup = new Error("cleanup")
        const started = deferred<void>()
        const controller = new AbortController()
        const client = {
            state: "Connecting",
            run: () => Effect.sync(() => started.resolve()).pipe(Effect.andThen(Effect.never)),
            shutdown: () => Effect.die(cleanup),
        }
        const running = Effect.runPromiseExit(
            runBotCore(Effect.succeed(client), () => Effect.succeed([]), {}),
            {
                signal: controller.signal,
            },
        )
        await started.promise
        controller.abort()
        const exit = await running
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
            expect(Cause.hasInterrupts(exit.cause)).toBe(true)
            expect(exit.cause.reasons.some((reason) => reason._tag === "Die" && reason.defect === cleanup)).toBe(true)
        }
    })

    test("external interruption during installation retains installer and shutdown defects", async () => {
        const installation = new Error("installation cleanup")
        const cleanup = new Error("client cleanup")
        const entered = deferred<void>()
        const controller = new AbortController()
        const client = {
            state: "Disconnected",
            run: () => Effect.never,
            shutdown: () => Effect.die(cleanup),
        }
        const running = Effect.runPromiseExit(
            runBotCore(
                Effect.succeed(client),
                () =>
                    Effect.sync(() => entered.resolve()).pipe(
                        Effect.andThen(Effect.never),
                        Effect.onInterrupt(() => Effect.die(installation)),
                    ),
                {},
            ),
            { signal: controller.signal },
        )
        await entered.promise
        controller.abort()
        const exit = await running
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
            expect(Cause.hasInterrupts(exit.cause)).toBe(true)
            expect(exit.cause.reasons.some((reason) => reason._tag === "Die" && reason.defect === installation)).toBe(
                true,
            )
            expect(exit.cause.reasons.some((reason) => reason._tag === "Die" && reason.defect === cleanup)).toBe(true)
        }
    })
})
