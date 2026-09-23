import { once } from "node:events"
import { createServer } from "node:http"
import { Cause, Context, Effect, Exit } from "effect"
import { ok } from "neverthrow"
import { WebSocket, WebSocketServer } from "ws"
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest"
import {
    CriticalWorkerStoppedError,
    ConfigurationError,
    fromStructuredLogger,
    runBot,
    type Client,
    type Subscription,
} from "../src/index.js"
import {
    CriticalWorkerStoppedError as NativeCriticalWorkerStoppedError,
    runBot as runNativeBot,
    type Client as NativeClient,
} from "../src/effect.js"
import { runBotCore } from "../src/internal/bot-runner.js"
import { hostedDiscoveryDocument, stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

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
    let sequence = 1
    gateway.on("connection", (socket) => {
        sockets.push(socket)
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
        socket.on("message", (data) => {
            const command = JSON.parse(data.toString()) as { op: number }
            if (command.op !== 2) return
            identified.resolve()
            if (!holdReady)
                socket.send(JSON.stringify({ op: 0, s: sequence++, t: "READY", d: { session_id: "fixture-session" } }))
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
    return {
        identified: identified.promise,
        dispatch(event: string, data: unknown) {
            const frame = JSON.stringify({ op: 0, s: sequence++, t: event, d: data })
            for (const socket of sockets) socket.send(frame)
        },
    }
}

const token = "fixture-only-not-a-credential"
const messageWire = { id: "10", channel_id: "20", content: "!ping", author: { id: "30", username: "fixture" } }

describe("public runBot", () => {
    test("simple default events receive the client and bind replies to the delivered message", async () => {
        const fixture = await gateway()
        const abort = new AbortController()
        onTestFinished(() => abort.abort())
        const handled = deferred<void>()
        const requests: { url: string; body: unknown }[] = []
        stubFetchWithHostedDiscovery(async (url, init) => {
            requests.push({ url, body: JSON.parse(String(init.body)) })
            return Response.json({ ...messageWire, id: "11", content: "Pong!" })
        })
        const running = runBot({
            token,
            signal: abort.signal,
            events: {
                messageCreate: async (ctx) => {
                    expect(ctx.client.state).not.toBe("Closed")
                    expect(ctx.event.id).toBe("10")
                    expect(ctx.message).toBe(ctx.event)
                    expect(ctx.signal).toBeDefined()
                    const result = await ctx.reply({ content: "Pong!" })
                    expect(result.isOk()).toBe(true)
                    handled.resolve()
                },
            },
        })
        await fixture.identified
        fixture.dispatch("MESSAGE_CREATE", messageWire)
        await handled.promise
        expect(requests).toEqual([
            {
                url: "https://api.fluxer.app/v1/channels/20/messages",
                body: expect.objectContaining({
                    content: "Pong!",
                    message_reference: expect.objectContaining({ message_id: "10", channel_id: "20" }),
                }),
            },
        ])
        abort.abort()
        expect((await running).isOk()).toBe(true)
    })

    test("simple default reply is cancelled when its run stops", async () => {
        const fixture = await gateway()
        const abort = new AbortController()
        onTestFinished(() => abort.abort())
        const entered = deferred<AbortSignal>()
        let handlerSignal: import("../src/index.js").OperationSignal | undefined
        stubFetchWithHostedDiscovery((_url, init) => {
            entered.resolve(init.signal!)
            return new Promise<Response>((_resolve, reject) => {
                init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
                    once: true,
                })
            })
        })
        const running = runBot({
            token,
            signal: abort.signal,
            events: {
                messageCreate: async (ctx) => {
                    handlerSignal = ctx.signal
                    await ctx.reply({ content: "Pong!" })
                },
            },
        })
        await fixture.identified
        fixture.dispatch("MESSAGE_CREATE", messageWire)
        const requestSignal = await entered.promise
        abort.abort()
        expect((await running).isOk()).toBe(true)
        expect(handlerSignal?.aborted).toBe(true)
        expect(requestSignal.aborted).toBe(true)
    })

    test("simple non-message events retain their typed payload and full client", async () => {
        const fixture = await gateway()
        const abort = new AbortController()
        onTestFinished(() => abort.abort())
        const handled = deferred<void>()
        const running = runBot({
            token,
            signal: abort.signal,
            events: {
                channelPinsUpdate: (ctx) => {
                    expect(ctx.event.channelId).toBe("20")
                    expect(ctx.event.lastPinTimestamp).toBeNull()
                    expect(ctx.client.messages).toBeDefined()
                    handled.resolve()
                },
                messageCreate: undefined,
            },
        })
        await fixture.identified
        fixture.dispatch("CHANNEL_PINS_UPDATE", { channel_id: "20", last_pin_timestamp: null })
        await handled.promise
        abort.abort()
        expect((await running).isOk()).toBe(true)
    })

    test("simple event maps reject invalid runtime values through configuration failures", async () => {
        for (const events of [null, [], { unknownEvent: () => undefined }, { messageCreate: true }]) {
            const result = await runBot({ token, events } as never)
            expect(result.isErr() && result.error._tag).toBe("ConfigurationError")
            const native = await Effect.runPromiseExit(
                runNativeBot({ token, events } as never) as Effect.Effect<void, unknown>,
            )
            expect(Exit.isFailure(native)).toBe(true)
            if (Exit.isFailure(native))
                expect(
                    native.cause.reasons.some(
                        (reason) => reason._tag === "Fail" && reason.error instanceof ConfigurationError,
                    ),
                ).toBe(true)
        }
        expect((await runBot({ token: undefined, events: {} })).isErr()).toBe(true)
        const native = await Effect.runPromiseExit(runNativeBot({ token: undefined, events: {} }))
        expect(Exit.isFailure(native)).toBe(true)
    })

    test("failed later registration releases the partially installed run before connecting", async () => {
        const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]
        const fetch = vi.fn(async () => Response.json(hostedDiscoveryDocument))
        vi.stubGlobal("fetch", fetch)
        const events = { messageCreate: () => undefined, unsupportedEvent: () => undefined }
        const result = await runBot({ token, events, processSignals: true } as never)
        expect(result.isErr() && result.error._tag).toBe("ConfigurationError")
        const native = await Effect.runPromiseExit(
            runNativeBot({ token, events, processSignals: true } as never) as Effect.Effect<void, unknown>,
        )
        expect(Exit.isFailure(native)).toBe(true)
        if (Exit.isFailure(native))
            expect(
                native.cause.reasons.some(
                    (reason) => reason._tag === "Fail" && reason.error instanceof ConfigurationError,
                ),
            ).toBe(true)
        expect(fetch).not.toHaveBeenCalled()
        expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before)
    })

    test("simple handler failures are reported once and do not stop later delivery", async () => {
        const fixture = await gateway()
        const abort = new AbortController()
        onTestFinished(() => abort.abort())
        const handled = deferred<void>()
        const calls: string[] = []
        const reports: unknown[] = []
        const running = runBot({
            token,
            signal: abort.signal,
            logging: { logger: fromStructuredLogger((record) => reports.push(record)) },
            events: {
                messageCreate: ({ message }) => {
                    calls.push(message.id)
                    if (message.id === "10") throw new Error("private handler detail")
                    handled.resolve()
                },
            },
        })
        await fixture.identified
        fixture.dispatch("MESSAGE_CREATE", messageWire)
        await vi.waitFor(() =>
            expect(reports).toContainEqual(
                expect.objectContaining({
                    event: "eventSubscriptionFailed",
                    subscriptionEvent: "messageCreate",
                    failureKind: "handler",
                }),
            ),
        )
        fixture.dispatch("MESSAGE_CREATE", { ...messageWire, id: "11" })
        await handled.promise
        abort.abort()
        expect((await running).isOk()).toBe(true)
        expect(calls).toEqual(["10", "11"])
        expect(
            reports.filter((report) => (report as { event?: string }).event === "eventSubscriptionFailed"),
        ).toHaveLength(1)
        expect(JSON.stringify(reports)).not.toContain("private handler detail")
    })

    test("simple native events use the caller's services and interrupt in-flight handlers on stop", async () => {
        const fixture = await gateway()
        const abort = new AbortController()
        onTestFinished(() => abort.abort())
        const entered = deferred<void>()
        const interrupted = deferred<void>()
        const requests: unknown[] = []
        stubFetchWithHostedDiscovery(async (_url, init) => {
            requests.push(JSON.parse(String(init.body)))
            return Response.json({ ...messageWire, id: "11", content: "Pong!" })
        })
        const Service = Context.Service<{ label: string }>("run-bot-test-service")
        const program = runNativeBot({
            token,
            signal: abort.signal,
            events: {
                messageCreate: (ctx) =>
                    Effect.gen(function* () {
                        const service = yield* Service
                        expect(service.label).toBe("fixture")
                        expect(ctx.event.id).toBe("10")
                        expect(ctx.message).toBe(ctx.event)
                        expect(ctx.client.messages).toBeDefined()
                        yield* ctx.reply({ content: `${service.label}: Pong!` })
                        entered.resolve()
                        yield* Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => interrupted.resolve())))
                    }),
            },
        })
        const running = Effect.runPromiseExit(program.pipe(Effect.provideService(Service, { label: "fixture" })))
        await fixture.identified
        fixture.dispatch("MESSAGE_CREATE", messageWire)
        await entered.promise
        expect(requests).toEqual([
            expect.objectContaining({
                content: "fixture: Pong!",
                message_reference: expect.objectContaining({ message_id: "10", channel_id: "20" }),
            }),
        ])
        abort.abort()
        expect(Exit.isSuccess(await running)).toBe(true)
        await interrupted.promise
    })

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
