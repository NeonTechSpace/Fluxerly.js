import { Cause, Context, Effect, Exit } from "effect"
import { err } from "neverthrow"
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest"
import {
    ApplicationError,
    CriticalWorkerStoppedError,
    ConfigurationError,
    EventOverflowError,
    runBot,
    SdkDefect,
    type FailureReport,
    type LogRecord,
    type Client,
    type Subscription,
} from "../../src/index.js"
import {
    CriticalWorkerStoppedError as NativeCriticalWorkerStoppedError,
    runBot as runNativeBot,
    type Client as NativeClient,
    type Subscription as NativeSubscription,
} from "../../src/effect.js"
import * as defaultClientModule from "../../src/api/default/client.js"
import * as nativeClientModule from "../../src/api/effect/client.js"
import { runBotCore } from "../../src/internal/bot-runner.js"
import { clientServices, registerClientOwner } from "../../src/internal/client-registry.js"
import { Opcode as GatewayOpcode } from "../../src/internal/protocol/gateway.js"
import { startGatewayServer } from "../support/gateway-server.js"
import { hostedDiscoveryDocument, stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { captureLogs } from "../support/log-capture.js"
import { wsTarget } from "../support/ws-redirect.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

function deferred<A>() {
    let resolve!: (value: A) => void
    const promise = new Promise<A>((complete) => {
        resolve = complete
    })
    return { promise, resolve }
}

/**
 * Start a gateway fixture. afterReady runs on IDENTIFY, right after the fixture sends READY on the same socket,
 * so frames it dispatches arrive immediately after the client connects
 */
async function gateway(holdReady = false, afterReady?: (dispatch: (event: string, data: unknown) => void) => void) {
    const identified = deferred<void>()
    const fixture = await startGatewayServer({
        autoReady: !holdReady,
        onCommand: (command) => {
            if (command.op !== GatewayOpcode.identify) return
            afterReady?.((event, data) => fixture.dispatch(event, data))
            identified.resolve()
        },
    })
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(hostedDiscoveryDocument)),
    )
    return {
        identified: identified.promise,
        commands: fixture.commands,
        dispatch: (event: string, data: unknown) => fixture.dispatch(event, data),
    }
}

/** Answer message sends with an echo of their content, recording each request */
function replies() {
    const requests: { url: string; body: Record<string, unknown> }[] = []
    const fetch = stubFetchWithHostedDiscovery(async (url, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        requests.push({ url, body })
        return Response.json({ ...messageWire, id: String(900 + requests.length), content: body.content })
    })
    return { requests, fetch }
}

/** Run a native Effect that must fail and return the defects in its Cause */
async function defects(effect: Effect.Effect<unknown, unknown>): Promise<unknown[]> {
    const exit = await Effect.runPromiseExit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    return Exit.isFailure(exit)
        ? exit.cause.reasons.flatMap((reason) => (reason._tag === "Die" ? [reason.defect] : []))
        : []
}

const token = "fixture-only-not-a-credential"
const messageWire = { id: "10", channel_id: "20", type: 0, content: "!ping", author: { id: "30", username: "fixture" } }
const signalListeners = () => [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]

/**
 * Record every side effect that misuse must not cause: a created client in either entry point, a process signal
 * listener, even one removed again, an HTTP request and a gateway socket
 */
function watchSideEffects() {
    const before = signalListeners()
    const fetch = vi.fn(async () => Response.json(hostedDiscoveryDocument))
    vi.stubGlobal("fetch", fetch)
    const created = vi.spyOn(defaultClientModule, "createClient")
    const createdNative = vi.spyOn(nativeClientModule, "createClient")
    const listeners: (string | symbol)[] = []
    for (const method of ["on", "once", "addListener", "prependListener", "prependOnceListener"] as const) {
        const original = process[method].bind(process) as (...args: unknown[]) => NodeJS.Process
        vi.spyOn(process, method).mockImplementation(((event: string | symbol, listener: unknown) => {
            if (event === "SIGINT" || event === "SIGTERM") listeners.push(event)
            return original(event, listener)
        }) as never)
    }
    return {
        expectNone() {
            expect(created).not.toHaveBeenCalled()
            expect(createdNative).not.toHaveBeenCalled()
            expect(listeners).toEqual([])
            expect(fetch).not.toHaveBeenCalled()
            expect(wsTarget.sockets).toEqual([])
            expect(signalListeners()).toEqual(before)
        },
    }
}

/**
 * Run a bot in one entry point and deliver frames until a subscription set to overflow "stop" overflows, then request a
 * stop. Resolve with the run's failure, or undefined when that requested stop ended the run successfully
 */
async function failureAfterOverflow(
    mode: "default" | "native",
    options: Record<string, unknown>,
    frames: readonly [event: string, data: unknown][],
): Promise<unknown> {
    const fixture = await gateway()
    const abort = new AbortController()
    onTestFinished(() => abort.abort())
    const overflowed = deferred<void>()
    const settings = {
        token,
        signal: abort.signal,
        reportFailure: false,
        // A requested stop cancels the held handlers at once instead of draining them
        drainMs: 0,
        logging: {
            sink: (record: LogRecord) => {
                if (record.code === "events.overflow") overflowed.resolve()
            },
        },
        ...options,
    }
    const running =
        mode === "default"
            ? runBot(settings as never).then((result) => (result.isErr() ? result.error : undefined))
            : Effect.runPromiseExit(runNativeBot(settings as never)).then((exit) =>
                  Exit.isFailure(exit) ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error : undefined,
              )
    await fixture.identified
    for (const [event, data] of frames) fixture.dispatch(event, data)
    // The overflow is still reported. A bot that kept running without the subscription would end successfully here
    await overflowed.promise
    abort.abort()
    return running
}

/** Misuse shared by both entry points: runner settings, event entries and delivery settings, and client settings */
function sharedMisuse(handler: (...args: never[]) => unknown): Record<string, unknown>[] {
    return [
        { token, events: null },
        { token, events: { messageCreate: true } },
        { token, processSignals: true, events: { messageCreate: handler, unknownEvent: handler } },
        { token, processSignals: true, events: { messageCreate: { handler, concurrency: 0 } } },
        { token, events: { typingStart: { handler, overflow: "explode" } } },
        { token, events: { typingStart: { handler, maxPendingMessages: 1.5 } } },
        { token, events: { messageCreate: { handler, onError: "report" } } },
        { token, commands: { prefix: "!", commands: { ping: { execute: handler } }, concurrency: 0 } },
        { token, commands: { prefix: "!", commands: { ping: { execute: handler } }, overflow: "explode" } },
        { token, setup: "later" },
        { token, processSignals: "yes", events: {} },
        { token, ignoreBots: "no", events: { messageCreate: handler } },
        { token, processSignals: true, logging: { format: "xml" } },
        { token, events: { messageCreate: handler }, cache: "everything" },
        // Other misuse still throws when the token is also missing
        { token: "", processSignals: true, events: { messageCreate: handler }, cache: "everything" },
        { events: {}, logging: { format: "xml" } },
    ]
}

describe("public runBot", () => {
    test("simple default events receive the client and bind replies to the delivered message", async () => {
        const fixture = await gateway()
        const abort = new AbortController()
        onTestFinished(() => abort.abort())
        const handled = deferred<void>()
        const { requests } = replies()
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
                    // A string reply is sent as the message content
                    expect((await ctx.reply("Pong again")).isOk()).toBe(true)
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
            {
                url: "https://api.fluxer.app/v1/channels/20/messages",
                body: expect.objectContaining({
                    content: "Pong again",
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
        let handlerSignal: AbortSignal | undefined
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
            // Without a drain, the stop cancels the running handler at once
            drainMs: 0,
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

    test("default misuse throws ConfigurationError before any client, listener or request exists", async () => {
        const side = watchSideEffects()
        const execute = () => undefined
        const handler = () => undefined
        const misuse: (Record<string, unknown> | null)[] = [
            ...sharedMisuse(handler),
            { token, events: [] },
            { token, events: { messageCreate: { handler, unknownSetting: 1 } } },
            { token, commands: { prefix: "", commands: { ping: { execute } } } },
            { token, commands: { prefix: "!", commands: { ping: { execute } }, onError: "report" } },
            { token, commands: { prefix: "!", commands: { "bad name": { execute } } } },
            { token, commands: { prefix: "!", commands: () => "not a router" } },
            { token, signal: 1 },
            null,
        ]
        for (const options of misuse) {
            for (const signal of [undefined, AbortSignal.abort()]) {
                const input =
                    options !== null && signal !== undefined && !("signal" in options)
                        ? { ...options, signal }
                        : options
                let thrown: unknown
                try {
                    void runBot(input as never)
                } catch (error) {
                    thrown = error
                }
                expect(thrown, JSON.stringify(input)).toBeInstanceOf(ConfigurationError)
            }
        }
        side.expectNone()
    })

    test("default option getter failures throw an application SdkDefect before any client, listener or request exists", async () => {
        const side = watchSideEffects()
        const failure = new Error("fixture option getter failure")
        const throwing = (target: object, key: string) =>
            Object.defineProperty(target, key, {
                enumerable: true,
                get() {
                    throw failure
                },
            })
        // Top-level runner, event, delivery, command and client settings are each read before a client exists
        const inputs = [
            throwing({ token }, "setup"),
            { token, events: throwing({}, "messageCreate") },
            { token, events: { messageCreate: throwing({ handler: () => undefined }, "concurrency") } },
            { token, commands: throwing({ prefix: "!" }, "commands") },
            { token, cache: throwing({}, "messages") },
            { token, signal: throwing({}, "aborted") },
        ]
        for (const input of inputs) {
            let thrown: unknown
            try {
                void runBot(input as never)
            } catch (error) {
                thrown = error
            }
            expect(thrown, Object.keys(input).join()).toBeInstanceOf(SdkDefect)
            expect(thrown).toMatchObject({
                code: "application.defect",
                operation: "runBot",
                reasons: [{ kind: "Defect", origin: "application", defect: failure }],
            })
            expect((thrown as SdkDefect).cause).toBe(failure)
        }
        side.expectNone()
    })

    test("an unknown event name is explained with the closest known name in both entry points", async () => {
        const side = watchSideEffects()
        let thrown: unknown
        try {
            void runBot({ token, events: { messageCreated: () => undefined } as never })
        } catch (error) {
            thrown = error
        }
        const [native] = await defects(
            runNativeBot({ token, events: { messageCreated: () => Effect.void } as never }) as Effect.Effect<
                unknown,
                unknown
            >,
        )
        for (const failure of [thrown, native]) {
            expect(failure).toBeInstanceOf(ConfigurationError)
            expect(failure).toMatchObject({ field: "event", hint: expect.stringContaining('"messageCreate"') })
        }
        side.expectNone()
    })

    test("a ready event points to the connected log, setup and connect in both entry points", async () => {
        const side = watchSideEffects()
        let thrown: unknown
        try {
            void runBot({ token, events: { ready: () => undefined } as never })
        } catch (error) {
            thrown = error
        }
        const [native] = await defects(
            runNativeBot({ token, events: { clientReady: () => Effect.void } as never }) as Effect.Effect<
                unknown,
                unknown
            >,
        )
        for (const failure of [thrown, native]) {
            expect(failure).toBeInstanceOf(ConfigurationError)
            expect(failure).toMatchObject({ field: "event", hint: expect.stringMatching(/no ready event.*setup/) })
        }
        side.expectNone()
    })

    test("a misspelled runBot option is rejected with the closest runBot or client option in both entry points", async () => {
        const side = watchSideEffects()
        let thrown: unknown
        try {
            void runBot({ token, event: { messageCreate: () => undefined } } as never)
        } catch (error) {
            thrown = error
        }
        const [native] = await defects(
            runNativeBot({ token, event: { messageCreate: () => Effect.void } } as never) as Effect.Effect<
                unknown,
                unknown
            >,
        )
        for (const failure of [thrown, native]) {
            expect(failure).toBeInstanceOf(ConfigurationError)
            expect(failure).toMatchObject({ field: "configuration", hint: expect.stringContaining('"events"') })
        }
        side.expectNone()
    })

    test("native misuse dies with ConfigurationError before any client, listener or request exists", async () => {
        const side = watchSideEffects()
        const execute = () => Effect.void
        const misuse: Record<string, unknown>[] = [
            ...sharedMisuse(() => Effect.void),
            { token, commands: { prefix: "!", commands: { "bad name": { execute } } } },
            { token, commands: { prefix: "!", commands: () => "not a router" } },
            { token, commands: { prefix: "!", commands: { ping: { execute } }, onError: "report" } },
        ]
        for (const options of misuse) {
            for (const signal of [undefined, AbortSignal.abort()]) {
                const input = signal === undefined ? options : { ...options, signal }
                const found = await defects(runNativeBot(input as never) as Effect.Effect<unknown, unknown>)
                expect(
                    found.some((defect) => defect instanceof ConfigurationError),
                    JSON.stringify(input),
                ).toBe(true)
            }
        }
        side.expectNone()
    })

    test("default event and command registration completes before the first event is dispatched", async () => {
        const seen: string[] = []
        const fixture = await gateway(false, (dispatch) => {
            dispatch("MESSAGE_CREATE", messageWire)
            dispatch("TYPING_START", { channel_id: "20", user_id: "30", timestamp: 1 })
        })
        const { requests } = replies()
        const abort = new AbortController()
        onTestFinished(() => abort.abort())
        const running = runBot({
            token,
            signal: abort.signal,
            events: {
                messageCreate: ({ message }) => void seen.push(`event:${message.content}`),
                typingStart: ({ event }) => void seen.push(`typing:${event.timestamp}`),
            },
            commands: { prefix: "!", commands: { ping: { execute: ({ reply }) => reply("Pong") } } },
            setup: (client) => {
                client.on("typingStart", (event) => void seen.push(`setup:${event.timestamp}`))
            },
        })
        await fixture.identified
        await vi.waitFor(() => expect(requests).toHaveLength(1))
        await vi.waitFor(() => expect(seen).toHaveLength(3))
        expect(seen.sort()).toEqual(["event:!ping", "setup:1", "typing:1"])
        expect(requests[0]!.body).toMatchObject({ content: "Pong", message_reference: { message_id: "10" } })
        abort.abort()
        expect((await running).isOk()).toBe(true)
    })

    test("native event and command registration completes before the first event is dispatched", async () => {
        const seen: string[] = []
        const fixture = await gateway(false, (dispatch) => {
            dispatch("MESSAGE_CREATE", messageWire)
            dispatch("TYPING_START", { channel_id: "20", user_id: "30", timestamp: 1 })
        })
        const { requests } = replies()
        const abort = new AbortController()
        onTestFinished(() => abort.abort())
        const running = Effect.runPromiseExit(
            runNativeBot({
                token,
                signal: abort.signal,
                events: {
                    messageCreate: ({ message }) => Effect.sync(() => void seen.push(`event:${message.content}`)),
                    typingStart: ({ event }) => Effect.sync(() => void seen.push(`typing:${event.timestamp}`)),
                },
                commands: { prefix: "!", commands: { ping: { execute: ({ reply }) => reply("Pong") } } },
                setup: (client) =>
                    client.on("typingStart", (event) => Effect.sync(() => void seen.push(`setup:${event.timestamp}`))),
            }),
        )
        await fixture.identified
        await vi.waitFor(() => expect(requests).toHaveLength(1))
        await vi.waitFor(() => expect(seen).toHaveLength(3))
        expect(seen.sort()).toEqual(["event:!ping", "setup:1", "typing:1"])
        expect(requests[0]!.body).toMatchObject({ content: "Pong", message_reference: { message_id: "10" } })
        abort.abort()
        expect(Exit.isSuccess(await running)).toBe(true)
    })

    test("setup finishes before the gateway connects in both entry points", async () => {
        // Each entry point records, at its first discovery request, whether setup had already finished
        const connectionAfterSetup = async <A>(run: (setupDone: () => void) => A): Promise<{ running: A }> => {
            let finished = false
            let finishedAtFirstRequest: boolean | undefined
            const fixture = await gateway(true)
            vi.stubGlobal(
                "fetch",
                vi.fn(async () => {
                    finishedAtFirstRequest ??= finished
                    return Response.json(hostedDiscoveryDocument)
                }),
            )
            const running = run(() => {
                finished = true
            })
            await fixture.identified
            expect(finishedAtFirstRequest).toBe(true)
            return { running }
        }
        // Setup yields for several event-loop turns, which a connection not waiting on it would use to start
        const turns = async () => {
            for (let index = 0; index < 20; index++) await new Promise((resolve) => setImmediate(resolve))
        }

        const abort = new AbortController()
        onTestFinished(() => abort.abort())
        const { running } = await connectionAfterSetup((setupDone) =>
            runBot({
                token,
                signal: abort.signal,
                setup: async () => {
                    await turns()
                    setupDone()
                },
            }),
        )
        abort.abort()
        expect((await running).isOk()).toBe(true)

        const nativeAbort = new AbortController()
        onTestFinished(() => nativeAbort.abort())
        const { running: native } = await connectionAfterSetup((setupDone) =>
            Effect.runPromiseExit(
                runNativeBot({
                    token,
                    signal: nativeAbort.signal,
                    setup: () => Effect.promise(turns).pipe(Effect.andThen(Effect.sync(setupDone))),
                }),
            ),
        )
        nativeAbort.abort()
        expect(Exit.isSuccess(await native)).toBe(true)
    })

    test("a failing default setup returns Err ApplicationError naming runBot setup and closes the client unconnected", async () => {
        const fetch = vi.fn(async () => Response.json(hostedDiscoveryDocument))
        vi.stubGlobal("fetch", fetch)
        const failure = new Error("private setup detail")
        const setups: ((client: Client) => unknown)[] = [
            () => {
                throw failure
            },
            async () => Promise.reject(failure),
            () => err(failure),
            async () => err(failure),
        ]
        for (const setup of setups) {
            let client: Client | undefined
            const handled: string[] = []
            const result = await runBot({
                token,
                events: { messageCreate: () => void handled.push("message") },
                setup: (created) => {
                    client = created
                    return setup(created)
                },
            })
            expect(result.isErr()).toBe(true)
            const error = result.isErr() ? result.error : undefined
            expect(error).toBeInstanceOf(ApplicationError)
            expect(error).toMatchObject({ _tag: "ApplicationError", source: "runBot setup" })
            expect((error as ApplicationError).cause).toBe(failure)
            expect(client?.state).toBe("Closed")
            expect(handled).toEqual([])
        }
        expect(fetch).not.toHaveBeenCalled()
    })

    test("an SdkDefect thrown by a default setup still rejects runBot with SdkDefect", async () => {
        const fetch = vi.fn(async () => Response.json(hostedDiscoveryDocument))
        vi.stubGlobal("fetch", fetch)
        const defect = new SdkDefect("users.fetchSelf", [])
        let client: Client | undefined
        const outcome = await Promise.resolve(
            runBot({
                token,
                setup: (created) => {
                    client = created
                    throw defect
                },
            }),
        ).catch((error: unknown) => error)
        expect(outcome).toBeInstanceOf(SdkDefect)
        expect(outcome).toMatchObject({ operation: "runBot", reasons: [expect.objectContaining({ defect })] })
        expect(client?.state).toBe("Closed")
        expect(fetch).not.toHaveBeenCalled()
    })

    test("a failing native setup fails with ApplicationError naming runBot setup and closes the client unconnected", async () => {
        const fetch = vi.fn(async () => Response.json(hostedDiscoveryDocument))
        vi.stubGlobal("fetch", fetch)
        const failure = new Error("native setup detail")
        let client: NativeClient | undefined
        const exit = await Effect.runPromiseExit(
            runNativeBot({
                token,
                setup: (created) => {
                    client = created
                    return Effect.fail(failure)
                },
            }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        const reasons = Exit.isFailure(exit) ? exit.cause.reasons : []
        expect(reasons).toEqual([
            expect.objectContaining({
                _tag: "Fail",
                error: expect.objectContaining({ _tag: "ApplicationError", source: "runBot setup" }),
            }),
        ])
        const error = (reasons[0] as { readonly error: ApplicationError }).error
        expect(error).toBeInstanceOf(ApplicationError)
        expect(error.cause).toBe(failure)
        expect(client?.state).toBe("Closed")

        // A defect in setup keeps its original value as the defect
        const found = await defects(runNativeBot({ token, setup: () => Effect.die(failure) }))
        expect(found).toEqual([failure])
        expect(fetch).not.toHaveBeenCalled()
    })

    test("pre-aborted runs return success without creating clients, registering handlers or running setup", async () => {
        const setup = vi.fn()
        const handler = vi.fn()
        const execute = vi.fn()
        const side = watchSideEffects()
        const result = await runBot({
            token,
            signal: AbortSignal.abort(),
            events: { messageCreate: handler },
            commands: { prefix: "!", commands: { ping: { execute } } },
            setup,
        })
        expect(result.isOk()).toBe(true)

        const native = await Effect.runPromiseExit(
            runNativeBot({
                token,
                signal: AbortSignal.abort(),
                events: { messageCreate: () => Effect.sync(handler) },
                setup: () => Effect.sync(setup),
            }),
        )
        expect(Exit.isSuccess(native)).toBe(true)
        side.expectNone()
        expect(setup).not.toHaveBeenCalled()
        expect(handler).not.toHaveBeenCalled()
        expect(execute).not.toHaveBeenCalled()
    })

    test("default commands run from keyed definitions or a register callback and report failures to their hook", async () => {
        const fixture = await gateway()
        const { requests } = replies()
        const abort = new AbortController()
        onTestFinished(() => abort.abort())
        const reports: FailureReport[] = []
        const clientReports: FailureReport[] = []
        const failure = new Error("command failed")
        const running = runBot({
            token,
            signal: abort.signal,
            onError: (report) => void clientReports.push(report),
            commands: {
                prefix: "!",
                onReject: "reply",
                commands: {
                    ping: { execute: ({ reply }) => reply("Pong") },
                    roll: {
                        arguments: { sides: { type: "integer", min: 2, max: 100, default: 6 } },
                        execute: ({ reply, values }) => reply(`sides ${values.sides}`),
                    },
                    fail: {
                        execute: () => {
                            throw failure
                        },
                    },
                },
                onError: (report) => void reports.push(report),
            },
        })
        await fixture.identified
        fixture.dispatch("MESSAGE_CREATE", messageWire)
        fixture.dispatch("MESSAGE_CREATE", { ...messageWire, id: "11", content: "!roll" })
        fixture.dispatch("MESSAGE_CREATE", { ...messageWire, id: "12", content: "!roll 1" })
        fixture.dispatch("MESSAGE_CREATE", { ...messageWire, id: "13", content: "!fail" })
        await vi.waitFor(() => expect(requests).toHaveLength(3))
        await vi.waitFor(() => expect(reports).toHaveLength(1))
        const sent = Object.fromEntries(
            requests.map(({ body }) => [
                (body.message_reference as { message_id: string }).message_id,
                body.content as string,
            ]),
        )
        expect(sent["10"]).toBe("Pong")
        expect(sent["11"]).toBe("sides 6")
        // The out-of-range argument is rejected with a reply instead of running the command
        expect(sent["12"]).toEqual(expect.any(String))
        expect(sent["12"]).not.toBe("sides 1")
        expect(reports[0]).toMatchObject({ kind: "handler", command: "fail", error: failure })
        expect(clientReports).toEqual([])
        abort.abort()
        expect((await running).isOk()).toBe(true)

        const grouped = await gateway()
        const executed: string[] = []
        const groupedAbort = new AbortController()
        onTestFinished(() => groupedAbort.abort())
        const groupedRun = runBot({
            token,
            signal: groupedAbort.signal,
            commands: {
                prefix: "!",
                commands: (router) =>
                    router.registerGroup({ name: "admin" }).register(
                        { name: "stats", execute: ({ path }) => void executed.push(path!.join(" ")) },
                        {
                            group: ["admin"],
                        },
                    ),
            },
        })
        await grouped.identified
        grouped.dispatch("MESSAGE_CREATE", { ...messageWire, content: "!admin stats" })
        await vi.waitFor(() => expect(executed).toEqual(["admin stats"]))
        groupedAbort.abort()
        expect((await groupedRun).isOk()).toBe(true)
    })

    test("native commands run from keyed definitions or a register callback and report failures to their hook", async () => {
        const fixture = await gateway()
        const { requests } = replies()
        const abort = new AbortController()
        onTestFinished(() => abort.abort())
        const reports: FailureReport[] = []
        const failure = new Error("command failed")
        const running = Effect.runPromiseExit(
            runNativeBot({
                token,
                signal: abort.signal,
                commands: {
                    prefix: "!",
                    commands: {
                        ping: { execute: ({ reply }) => reply("Pong") },
                        fail: { execute: () => Effect.fail(failure) },
                    },
                    onError: (report) => Effect.sync(() => void reports.push(report)),
                },
            }),
        )
        await fixture.identified
        fixture.dispatch("MESSAGE_CREATE", messageWire)
        fixture.dispatch("MESSAGE_CREATE", { ...messageWire, id: "13", content: "!fail" })
        await vi.waitFor(() => expect(requests).toHaveLength(1))
        await vi.waitFor(() => expect(reports).toHaveLength(1))
        expect(requests[0]!.body).toMatchObject({ content: "Pong", message_reference: { message_id: "10" } })
        expect(reports[0]).toMatchObject({ kind: "handler", command: "fail", error: failure })
        abort.abort()
        expect(Exit.isSuccess(await running)).toBe(true)

        const grouped = await gateway()
        const executed: string[] = []
        const groupedAbort = new AbortController()
        onTestFinished(() => groupedAbort.abort())
        const groupedRun = Effect.runPromiseExit(
            runNativeBot({
                token,
                signal: groupedAbort.signal,
                commands: {
                    prefix: "!",
                    commands: (router) =>
                        router.registerGroup({ name: "admin" }).register(
                            {
                                name: "stats",
                                execute: ({ path }) => Effect.sync(() => void executed.push(path!.join(" "))),
                            },
                            { group: ["admin"] },
                        ),
                },
            }),
        )
        await grouped.identified
        grouped.dispatch("MESSAGE_CREATE", { ...messageWire, content: "!admin stats" })
        await vi.waitFor(() => expect(executed).toEqual(["admin stats"]))
        groupedAbort.abort()
        expect(Exit.isSuccess(await groupedRun)).toBe(true)
    })

    test("native events reply with a string as the message content", async () => {
        const fixture = await gateway()
        const { requests } = replies()
        const abort = new AbortController()
        onTestFinished(() => abort.abort())
        const running = Effect.runPromiseExit(
            runNativeBot({
                token,
                signal: abort.signal,
                events: { messageCreate: ({ reply }) => reply("Pong") },
            }),
        )
        await fixture.identified
        fixture.dispatch("MESSAGE_CREATE", messageWire)
        await vi.waitFor(() => expect(requests).toHaveLength(1))
        expect(requests[0]!.body).toMatchObject({ content: "Pong", message_reference: { message_id: "10" } })
        abort.abort()
        expect(Exit.isSuccess(await running)).toBe(true)
    })

    test("simple handler failures are reported once and do not stop later delivery", async () => {
        const fixture = await gateway()
        const abort = new AbortController()
        onTestFinished(() => abort.abort())
        const handled = deferred<void>()
        const calls: string[] = []
        const reports: FailureReport[] = []
        const logs = captureLogs()
        const failure = new Error("handler detail")
        const running = runBot({
            token,
            signal: abort.signal,
            logging: logs.logging,
            onError: (report) => {
                reports.push(report)
            },
            events: {
                messageCreate: ({ message }) => {
                    calls.push(message.id)
                    if (message.id === "10") throw failure
                    handled.resolve()
                },
            },
        })
        await fixture.identified
        fixture.dispatch("MESSAGE_CREATE", messageWire)
        await vi.waitFor(() =>
            expect(reports).toEqual([
                expect.objectContaining({
                    kind: "handler",
                    event: "messageCreate",
                    error: failure,
                    message: expect.objectContaining({ id: "10" }),
                }),
            ]),
        )
        fixture.dispatch("MESSAGE_CREATE", { ...messageWire, id: "11" })
        await handled.promise
        abort.abort()
        expect((await running).isOk()).toBe(true)
        expect(calls).toEqual(["10", "11"])
        expect(reports).toHaveLength(1)
        // The hook received the failure, so the log keeps it at Debug instead of printing it again
        expect(logs.withCode("events.handlerFailed")).toEqual([])
        expect(logs.codes()).toContain("lifecycle.stopRequested")
    })

    test("event handlers run eight messageCreate at a time and overflow drops the oldest without stopping the bot", async () => {
        const fixture = await gateway()
        const abort = new AbortController()
        onTestFinished(() => abort.abort())
        const gate = deferred<void>()
        const active: string[] = []
        const typing: number[] = []
        let client: Client | undefined
        const logs = captureLogs()
        const running = runBot({
            token,
            signal: abort.signal,
            logging: logs.logging,
            events: {
                messageCreate: async ({ message, client: running }) => {
                    client = running
                    active.push(message.id)
                    await gate.promise
                },
                typingStart: {
                    maxPendingMessages: 1,
                    handler: async ({ event }) => {
                        typing.push(event.timestamp)
                        await gate.promise
                    },
                },
            },
        })
        await fixture.identified
        for (let index = 0; index < 10; index++)
            fixture.dispatch("MESSAGE_CREATE", { ...messageWire, id: String(100 + index) })
        await vi.waitFor(() => expect(active).toHaveLength(8))
        expect(client!.diagnostics().events.activeHandlers).toBe(8)
        for (let timestamp = 1; timestamp <= 4; timestamp++)
            fixture.dispatch("TYPING_START", { channel_id: "20", user_id: "30", timestamp })
        await vi.waitFor(() => expect(client!.diagnostics().counters.eventsDropped.overflow).toBe(2))
        await vi.waitFor(() => expect(typing).toEqual([1]))
        // The Typing frames followed all ten messages, and a handler started for one of them, so the two waiting
        // messages have been delivered and are held by the concurrency limit rather than not yet received
        expect(active).toHaveLength(8)
        expect(client!.diagnostics().events.activeHandlers).toBe(9)
        expect(logs.withCode("events.dropped")[0]).toMatchObject({
            level: "warn",
            event: "typingStart",
            fields: { policy: "dropOldest" },
        })
        gate.resolve()
        await vi.waitFor(() => expect(typing).toEqual([1, 4]))
        await vi.waitFor(() => expect(active).toHaveLength(10))
        expect(client!.state).toBe("Connected")
        abort.abort()
        expect((await running).isOk()).toBe(true)
    })

    test("a handler set to overflow stop that overflows fails the run, naming its event and capacity, in both entry points", async () => {
        const typing = [1, 2, 3].map((timestamp) => [
            "TYPING_START",
            { channel_id: "20", user_id: "30", timestamp },
        ]) as [string, unknown][]
        const stop = { overflow: "stop", maxPendingMessages: 1 } as const
        const failures = [
            await failureAfterOverflow(
                "default",
                {
                    events: {
                        messageCreate: () => undefined,
                        typingStart: { ...stop, handler: () => new Promise(() => undefined) },
                    },
                },
                typing,
            ),
            await failureAfterOverflow(
                "native",
                {
                    events: {
                        messageCreate: () => Effect.void,
                        typingStart: { ...stop, handler: () => Effect.never },
                    },
                },
                typing,
            ),
        ]
        for (const failure of failures) {
            expect(failure).toBeInstanceOf(CriticalWorkerStoppedError)
            expect(failure).toMatchObject({
                workerIndex: 1,
                details: { event: "typingStart", limit: "messages", capacity: 1 },
            })
            expect((failure as Error).cause).toBeInstanceOf(EventOverflowError)
        }
    })

    test("runBot commands pass their delivery settings to the router in both entry points", async () => {
        // The router defaults run eight commands at a time and drop the oldest waiting message, so only these settings
        // let three held commands overflow
        const delivery = { concurrency: 1, maxPendingMessages: 1, overflow: "stop" } as const
        const messages = ["11", "12", "13"].map((id) => [
            "MESSAGE_CREATE",
            { ...messageWire, id, content: "!hold" },
        ]) as [string, unknown][]
        const failures = [
            await failureAfterOverflow(
                "default",
                {
                    commands: {
                        prefix: "!",
                        ...delivery,
                        commands: { hold: { execute: () => new Promise(() => undefined) } },
                    },
                },
                messages,
            ),
            await failureAfterOverflow(
                "native",
                { commands: { prefix: "!", ...delivery, commands: { hold: { execute: () => Effect.never } } } },
                messages,
            ),
        ]
        for (const failure of failures) {
            expect(failure).toBeInstanceOf(CriticalWorkerStoppedError)
            expect(failure).toMatchObject({
                workerIndex: 0,
                details: { event: "messageCreate", limit: "messages", capacity: 1 },
            })
        }
    })

    test("simple native events use the caller's services and interrupt in-flight handlers on stop", async () => {
        const fixture = await gateway()
        const abort = new AbortController()
        onTestFinished(() => abort.abort())
        const entered = deferred<void>()
        const interrupted = deferred<void>()
        const { requests } = replies()
        const Service = Context.Service<{ label: string }>("run-bot-test-service")
        const program = runNativeBot({
            token,
            signal: abort.signal,
            // Without a drain, the stop interrupts the running handler at once
            drainMs: 0,
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
        expect(requests.map(({ body }) => body)).toEqual([
            expect.objectContaining({
                content: "fixture: Pong!",
                message_reference: expect.objectContaining({ message_id: "10", channel_id: "20" }),
            }),
        ])
        abort.abort()
        expect(Exit.isSuccess(await running)).toBe(true)
        await interrupted.promise
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
        const failure = await Promise.resolve(runBot({ token, connection: { maxStartupAttempts: 2 } })).catch(
            (error: unknown) => error,
        )
        expect(failure).toMatchObject({
            name: "SdkDefect",
            operation: "runBot",
            reasons: expect.arrayContaining([
                { kind: "Failure", failure: expect.objectContaining({ _tag: "ConnectionError", phase: "discovery" }) },
                expect.objectContaining({ kind: "Defect" }),
            ]),
        })
        expect(JSON.stringify(failure)).toContain("private discovery cleanup detail")
    })

    test("signal stop awaits default and native gateway cleanup without process handlers", async () => {
        const fixture = await gateway(true)
        const before = signalListeners()
        const abort = new AbortController()
        let client: Client | undefined
        const running = runBot({
            token,
            signal: abort.signal,
            processSignals: false,
            setup: (created) => {
                client = created
            },
        })
        await fixture.identified
        expect(signalListeners()).toEqual(before)
        abort.abort()
        expect((await running).isOk()).toBe(true)
        expect(client?.state).toBe("Closed")

        const nativeAbort = new AbortController()
        const nativeInstalled = deferred<void>()
        let nativeClient: NativeClient | undefined
        const native = Effect.runPromiseExit(
            runNativeBot({
                token,
                signal: nativeAbort.signal,
                setup: (created) =>
                    Effect.sync(() => {
                        nativeClient = created
                        nativeInstalled.resolve()
                    }),
            }),
        )
        await nativeInstalled.promise
        nativeAbort.abort()
        expect(Exit.isSuccess(await native)).toBe(true)
        expect(nativeClient?.state).toBe("Closed")
        expect(signalListeners()).toEqual(before)
    })

    test("default runBot handles process signals unless processSignals is false and removes them after shutdown", async () => {
        const fixture = await gateway(true)
        const before = signalListeners()
        const running = runBot({ token })
        await fixture.identified
        expect(signalListeners()).toEqual(before.map((n) => n + 1))
        process.emit("SIGINT")
        expect((await running).isOk()).toBe(true)
        expect(signalListeners()).toEqual(before)

        const abort = new AbortController()
        const installed = deferred<void>()
        const optedOut = runBot({
            token,
            signal: abort.signal,
            processSignals: false,
            setup: () => installed.resolve(),
        })
        await installed.promise
        expect(signalListeners()).toEqual(before)
        abort.abort()
        expect((await optedOut).isOk()).toBe(true)
    })

    test("native runBot handles process signals only when processSignals is true", async () => {
        await gateway(true)
        const before = signalListeners()
        const abort = new AbortController()
        const installed = deferred<void>()
        const unhandled = Effect.runPromiseExit(
            runNativeBot({ token, signal: abort.signal, setup: () => Effect.sync(() => installed.resolve()) }),
        )
        await installed.promise
        // A launcher such as NodeRuntime.runMain may already handle these signals
        expect(signalListeners()).toEqual(before)
        abort.abort()
        expect(Exit.isSuccess(await unhandled)).toBe(true)

        const optedIn = deferred<void>()
        const handled = Effect.runPromiseExit(
            runNativeBot({ token, processSignals: true, setup: () => Effect.sync(() => optedIn.resolve()) }),
        )
        await optedIn.promise
        expect(signalListeners()).toEqual(before.map((n) => n + 1))
        process.emit("SIGTERM")
        expect(Exit.isSuccess(await handled)).toBe(true)
        expect(signalListeners()).toEqual(before)
    })

    test("default setup receives a signal that aborts when the bot begins stopping", async () => {
        const fixture = await gateway(true)
        const abort = new AbortController()
        let setupSignal: AbortSignal | undefined
        const statesAtAbort: string[] = []
        const running = runBot({
            token,
            signal: abort.signal,
            processSignals: false,
            setup: (client, { signal }) => {
                setupSignal = signal
                signal.addEventListener("abort", () => statesAtAbort.push(client.state))
            },
        })
        await fixture.identified
        expect(setupSignal?.aborted).toBe(false)
        abort.abort()
        expect((await running).isOk()).toBe(true)
        expect(setupSignal?.aborted).toBe(true)
        // The signal aborts before the client closes, so setup work can end with the bot
        expect(statesAtAbort).toHaveLength(1)
        expect(statesAtAbort[0]).not.toBe("Closed")
    })

    test("a stop while default setup is pending aborts the setup signal", async () => {
        await gateway(true)
        const abort = new AbortController()
        const started = deferred<void>()
        let setupAborted = false
        const running = runBot({
            token,
            signal: abort.signal,
            processSignals: false,
            setup: (_client, context) => {
                started.resolve()
                context.signal.addEventListener("abort", () => {
                    setupAborted = true
                })
                return new Promise(() => {})
            },
        })
        await started.promise
        abort.abort()
        expect((await running).isOk()).toBe(true)
        expect(setupAborted).toBe(true)
    })

    test("native setup finalizers run when the bot stops, after its client has shut down", async () => {
        await gateway(true)
        const abort = new AbortController()
        const installed = deferred<void>()
        const statesAtFinalizer: string[] = []
        const exit = Effect.runPromiseExit(
            runNativeBot({
                token,
                signal: abort.signal,
                setup: (client) =>
                    Effect.addFinalizer(() => Effect.sync(() => statesAtFinalizer.push(client.state))).pipe(
                        Effect.andThen(Effect.sync(() => installed.resolve())),
                    ),
            }),
        )
        await installed.promise
        expect(statesAtFinalizer).toEqual([])
        abort.abort()
        expect(Exit.isSuccess(await exit)).toBe(true)
        expect(statesAtFinalizer).toEqual(["Closed"])
    })

    test("bot-authored messages reach runBot handlers in both entry points when ignoreBots is false", async () => {
        const botMessage = { ...messageWire, author: { id: "31", username: "bridge", bot: true } }
        const fixture = await gateway()
        const abort = new AbortController()
        onTestFinished(() => abort.abort())
        const received = deferred<boolean>()
        const running = runBot({
            token,
            signal: abort.signal,
            processSignals: false,
            ignoreBots: false,
            events: { messageCreate: ({ message }) => received.resolve(message.author.isBot) },
        })
        await fixture.identified
        fixture.dispatch("MESSAGE_CREATE", botMessage)
        expect(await received.promise).toBe(true)
        abort.abort()
        expect((await running).isOk()).toBe(true)

        const nativeFixture = await gateway()
        const nativeAbort = new AbortController()
        onTestFinished(() => nativeAbort.abort())
        const nativeReceived = deferred<boolean>()
        const native = Effect.runPromiseExit(
            runNativeBot({
                token,
                signal: nativeAbort.signal,
                ignoreBots: false,
                events: {
                    messageCreate: ({ message }) => Effect.sync(() => nativeReceived.resolve(message.author.isBot)),
                },
            }),
        )
        await nativeFixture.identified
        nativeFixture.dispatch("MESSAGE_CREATE", botMessage)
        expect(await nativeReceived.promise).toBe(true)
        nativeAbort.abort()
        expect(Exit.isSuccess(await native)).toBe(true)
    })

    test("a bot subscription that closes early fails the run with the index of that subscription", async () => {
        await gateway(true)
        // Record the subscriptions runBot registers, which applications cannot reach, by wrapping the client it creates
        const subscriptions: Subscription[] = []
        const create = defaultClientModule.createClient
        vi.spyOn(defaultClientModule, "createClient").mockImplementation((options) => {
            const client = create(options) as Client
            const on = (...args: Parameters<Client["on"]>) => {
                const subscription = client.on(...args)
                subscriptions.push(subscription)
                return subscription
            }
            const wrapped = new Proxy({} as Client, {
                get: (_target, key) => (key === "on" ? on : Reflect.get(client, key)),
            })
            return registerClientOwner(wrapped, clientServices(client)!) as never
        })
        const result = await runBot({
            token,
            events: { messageCreate: () => undefined, typingStart: () => undefined },
            commands: { prefix: "!", commands: { ping: { execute: () => undefined } } },
            // Events come first in configuration order, then the command router
            setup: () => subscriptions.at(-1)!.close(),
        })
        expect(subscriptions).toHaveLength(3)
        expect(result.isErr() && result.error).toBeInstanceOf(CriticalWorkerStoppedError)
        expect(result.isErr() && result.error).toMatchObject({ workerIndex: 2 })

        const nativeSubscriptions: NativeSubscription[] = []
        const createNative = nativeClientModule.createClient
        vi.spyOn(nativeClientModule, "createClient").mockImplementation(
            (options) =>
                createNative(options).pipe(
                    Effect.map((client) => {
                        const register = client.on as (...args: unknown[]) => Effect.Effect<NativeSubscription>
                        const on = (...args: unknown[]) =>
                            register(...args).pipe(
                                Effect.tap((subscription) => Effect.sync(() => nativeSubscriptions.push(subscription))),
                            )
                        return registerClientOwner(
                            new Proxy({} as NativeClient, {
                                get: (_target, key) => (key === "on" ? on : Reflect.get(client, key)),
                            }),
                            clientServices(client)!,
                        )
                    }),
                ) as never,
        )
        const native = await Effect.runPromiseExit(
            runNativeBot({
                token,
                events: { messageCreate: () => Effect.void, typingStart: () => Effect.void },
                setup: () => nativeSubscriptions[0]!.close(),
            }),
        )
        expect(nativeSubscriptions).toHaveLength(2)
        expect(Exit.isFailure(native)).toBe(true)
        if (Exit.isFailure(native))
            expect(
                native.cause.reasons.some(
                    (reason) =>
                        reason._tag === "Fail" &&
                        reason.error instanceof NativeCriticalWorkerStoppedError &&
                        reason.error.workerIndex === 0,
                ),
            ).toBe(true)
    })

    test("a stop signal cancels pending setup in both entry points and awaits cleanup", async () => {
        const fetch = vi.fn(async () => Response.json(hostedDiscoveryDocument))
        vi.stubGlobal("fetch", fetch)
        const abort = new AbortController()
        const entered = deferred<void>()
        let client: Client | undefined
        const running = runBot({
            token,
            signal: abort.signal,
            setup: (created) => {
                client = created
                entered.resolve()
                return new Promise<never>(() => undefined)
            },
        })
        await entered.promise
        abort.abort()
        expect((await running).isOk()).toBe(true)
        expect(client?.state).toBe("Closed")

        const nativeAbort = new AbortController()
        const nativeEntered = deferred<void>()
        let nativeClient: NativeClient | undefined
        const result = Effect.runPromiseExit(
            runNativeBot({
                token,
                signal: nativeAbort.signal,
                setup: (created) =>
                    Effect.sync(() => {
                        nativeClient = created
                        nativeEntered.resolve()
                    }).pipe(Effect.andThen(Effect.never)),
            }),
        )
        await nativeEntered.promise
        nativeAbort.abort()
        expect(Exit.isSuccess(await result)).toBe(true)
        expect(nativeClient?.state).toBe("Closed")
        expect(fetch).not.toHaveBeenCalled()
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

describe("run signal methods that throw", () => {
    /** A run signal whose chosen listener method throws, with a way to fire the listener runBot registered */
    function faultySignal(method: "addEventListener" | "removeEventListener", failure: Error) {
        let listener: (() => void) | undefined
        return {
            signal: {
                aborted: false,
                addEventListener: (_type: string, added: () => void) => {
                    if (method === "addEventListener") throw failure
                    listener = added
                },
                removeEventListener: () => {
                    if (method === "removeEventListener") throw failure
                },
            } as unknown as AbortSignal,
            abort: () => listener?.(),
        }
    }

    test.each(["addEventListener", "removeEventListener"] as const)(
        "default runBot reports a throwing %s as an application defect, removes process listeners and shuts down its client",
        async (method) => {
            vi.stubGlobal(
                "fetch",
                vi.fn(async () => Response.json(hostedDiscoveryDocument)),
            )
            const create = vi.spyOn(defaultClientModule, "createClient")
            const failure = new Error("caller signal method failure")
            const { signal, abort } = faultySignal(method, failure)
            const before = signalListeners()
            const rejection = await runBot({
                token,
                processSignals: true,
                signal,
                setup: () => {
                    abort()
                    return new Promise(() => {})
                },
            }).then(
                () => undefined,
                (error: unknown) => error,
            )
            expect(rejection).toBeInstanceOf(SdkDefect)
            expect(rejection).toMatchObject({ code: "application.defect", cause: failure })
            expect((rejection as SdkDefect).reasons).toContainEqual(
                expect.objectContaining({ kind: "Defect", defect: failure, origin: "application" }),
            )
            expect(signalListeners()).toEqual(before)
            expect(create).toHaveBeenCalledTimes(1)
            expect((create.mock.results[0]!.value as Client).state).toBe("Closed")
        },
    )

    test.each(["addEventListener", "removeEventListener"] as const)(
        "native runBot keeps a throwing %s as its defect and removes process listeners",
        async (method) => {
            vi.stubGlobal(
                "fetch",
                vi.fn(async () => Response.json(hostedDiscoveryDocument)),
            )
            const failure = new Error("caller signal method failure")
            const { signal, abort } = faultySignal(method, failure)
            const before = signalListeners()
            const found = await defects(
                runNativeBot({
                    token,
                    processSignals: true,
                    signal,
                    setup: () => Effect.sync(abort).pipe(Effect.andThen(Effect.never)),
                }),
            )
            expect(found).toContain(failure)
            expect(signalListeners()).toEqual(before)
        },
    )
})

describe.each(["default", "native"] as const)("%s runBot failure reporting", (mode) => {
    /** Run a bot to its end in one API style, returning its failure or undefined for success */
    async function outcome(options: Record<string, unknown>): Promise<unknown> {
        if (mode === "default") {
            const result = await runBot({ token, ...options } as never)
            return result.isErr() ? result.error : undefined
        }
        const exit = await Effect.runPromiseExit(runNativeBot({ token, ...options } as never))
        return Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    }

    test("a failed run is logged once and sets process.exitCode, unless reportFailure is false", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json(hostedDiscoveryDocument)),
        )
        const failed = mode === "default" ? () => err(new Error("setup failed")) : () => Effect.fail("setup failed")
        const logs = captureLogs()
        process.exitCode = undefined
        const error = await outcome({ logging: logs.logging, setup: failed })
        expect(error).toMatchObject({ _tag: "ApplicationError", source: "runBot setup" })
        // The returned failure is the one reported, so the application sees the same error it could print itself
        expect(logs.withCode("lifecycle.botFailed")).toEqual([
            expect.objectContaining({ level: "error", error: expect.objectContaining({ name: "ApplicationError" }) }),
        ])
        expect(process.exitCode).toBe(1)

        const quiet = captureLogs()
        process.exitCode = undefined
        await outcome({ logging: quiet.logging, setup: failed, reportFailure: false })
        expect(quiet.withCode("lifecycle.botFailed")).toEqual([])
        expect(process.exitCode).toBeUndefined()
    })

    test("a failure the client already logged is not logged a second time, and a normal stop reports nothing", async () => {
        await startGatewayServer({
            autoReady: false,
            onCommand: (command, socket) => {
                if (command.op === GatewayOpcode.identify) socket.close(4004, "Authentication failed")
            },
        })
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => Response.json(hostedDiscoveryDocument)),
        )
        const logs = captureLogs()
        process.exitCode = undefined
        const error = await outcome({ logging: logs.logging })
        expect(error).toMatchObject({ _tag: "AuthenticationError" })
        expect(logs.withCode("lifecycle.connectionEnded")).toHaveLength(1)
        expect(logs.withCode("lifecycle.botFailed")).toEqual([])
        expect(process.exitCode).toBe(1)

        process.exitCode = undefined
        const abort = new AbortController()
        const stopped = await outcome({
            signal: abort.signal,
            setup: () => (abort.abort(), mode === "native" ? Effect.void : undefined),
        })
        expect(stopped).toBeUndefined()
        expect(process.exitCode).toBeUndefined()
    })

    test("a throwing commands register callback is logged once with the token masked and sets process.exitCode", async () => {
        const create = vi.spyOn(mode === "default" ? defaultClientModule : nativeClientModule, "createClient")
        const commands = {
            prefix: "!",
            commands: () => {
                throw new Error(`register failed for ${token}`)
            },
        }
        const logs = captureLogs()
        process.exitCode = undefined
        const error = await outcome({ logging: logs.logging, commands })
        expect(error).toMatchObject({ _tag: "ApplicationError", source: "runBot commands" })
        const records = logs.withCode("lifecycle.botFailed")
        expect(records).toEqual([
            expect.objectContaining({ level: "error", error: expect.objectContaining({ name: "ApplicationError" }) }),
        ])
        expect(JSON.stringify(records)).toContain("register failed for")
        expect(JSON.stringify(records)).not.toContain(token)
        expect(process.exitCode).toBe(1)
        expect(create).not.toHaveBeenCalled()

        const quiet = captureLogs()
        process.exitCode = undefined
        await outcome({ logging: quiet.logging, commands, reportFailure: false })
        expect(quiet.records).toEqual([])
        expect(process.exitCode).toBeUndefined()
    })

    test("misuse and other failures before a client exists are shown and fail the exit status", async () => {
        const logs = captureLogs()
        process.exitCode = undefined
        if (mode === "default") {
            // The default API throws misuse, so an awaited call shows it and Node fails the exit status
            expect(() => runBot({ token, evnts: {}, logging: logs.logging } as never)).toThrow(ConfigurationError)
            return
        }
        // Nothing else shows a native defect when the application only runs the Effect, so runBot reports it
        const found = await defects(runNativeBot({ token, evnts: {}, logging: logs.logging } as never))
        expect(found).toEqual([expect.objectContaining({ _tag: "ConfigurationError", field: "configuration" })])
        expect(logs.withCode("lifecycle.botFailed")).toEqual([
            expect.objectContaining({
                level: "error",
                error: expect.objectContaining({
                    name: "ConfigurationError",
                    code: "configuration.invalid",
                    hint: expect.any(String),
                }),
            }),
        ])
        expect(process.exitCode).toBe(1)

        // Unusable logging settings are part of the misuse, so the report falls back to the default output
        process.exitCode = undefined
        await defects(runNativeBot({ token, logging: { level: "loud" } } as never))
        expect(process.exitCode).toBe(1)

        // An option getter that throws is reported the same way, keeping the thrown value as the defect
        process.exitCode = undefined
        const thrown = new Error("option getter failed")
        const throwing = Object.defineProperty({ token }, "events", {
            enumerable: true,
            get: () => {
                throw thrown
            },
        })
        expect(await defects(runNativeBot(throwing as never))).toEqual([thrown])
        expect(process.exitCode).toBe(1)

        // A client that cannot be created has no logger yet, so the report uses the configured logging settings
        process.exitCode = undefined
        const created = captureLogs()
        vi.spyOn(nativeClientModule, "createClient").mockReturnValue(Effect.die(new Error("create failed")) as never)
        await defects(runNativeBot({ token, logging: created.logging }))
        expect(created.withCode("lifecycle.botFailed")).toHaveLength(1)
        expect(process.exitCode).toBe(1)

        const quiet = captureLogs()
        process.exitCode = undefined
        await defects(runNativeBot({ token, evnts: {}, logging: quiet.logging, reportFailure: false } as never))
        expect(quiet.records).toEqual([])
        expect(process.exitCode).toBeUndefined()
    })

    test("a missing or empty token is a reported run failure before any client exists, not misuse", async () => {
        /** The expected failure of a run, or undefined. A default throw or a native defect fails the test */
        async function expectedFailure(options: Record<string, unknown>): Promise<unknown> {
            if (mode === "default") {
                const result = await runBot(options as never)
                return result.isErr() ? result.error : undefined
            }
            const exit = await Effect.runPromiseExit(runNativeBot(options as never))
            if (Exit.isSuccess(exit)) return undefined
            expect(Cause.hasDies(exit.cause)).toBe(false)
            return Cause.squash(exit.cause)
        }
        for (const missing of [undefined, "", "  ", '""']) {
            for (const signal of [undefined, AbortSignal.abort()]) {
                const side = watchSideEffects()
                const logs = captureLogs()
                process.exitCode = undefined
                const failure = await expectedFailure({
                    token: missing,
                    logging: logs.logging,
                    events: {},
                    ...(signal === undefined ? {} : { signal }),
                })
                expect(failure).toBeInstanceOf(ConfigurationError)
                expect(failure).toMatchObject({ field: "token", hint: expect.stringContaining(".env.example") })
                const records = logs.withCode("lifecycle.botFailed")
                expect(records).toEqual([
                    expect.objectContaining({
                        level: "error",
                        error: expect.objectContaining({ name: "ConfigurationError" }),
                    }),
                ])
                // A beginner's missing token shows the error and its hint, without a stack trace
                expect(records[0]?.error?.stack ?? "").not.toMatch(/\n\s+at /)
                expect(process.exitCode).toBe(1)
                side.expectNone()
                vi.restoreAllMocks()
            }
        }

        const quiet = captureLogs()
        process.exitCode = undefined
        const failure = await expectedFailure({ token: undefined, logging: quiet.logging, reportFailure: false })
        expect(failure).toMatchObject({ _tag: "ConfigurationError", field: "token" })
        expect(quiet.records).toEqual([])
        expect(process.exitCode).toBeUndefined()
    })

    test("rejects a non-boolean reportFailure as misuse before creating a client", async () => {
        const create = vi.spyOn(mode === "default" ? defaultClientModule : nativeClientModule, "createClient")
        const misuse = await (mode === "default"
            ? Promise.resolve()
                  .then(() => runBot({ token, reportFailure: "yes" } as never))
                  .catch((error: unknown) => error)
            : defects(runNativeBot({ token, reportFailure: "yes" } as never)).then((found) => found[0]))
        expect(misuse).toMatchObject({ _tag: "ConfigurationError", field: "configuration" })
        expect(create).not.toHaveBeenCalled()
    })
})
