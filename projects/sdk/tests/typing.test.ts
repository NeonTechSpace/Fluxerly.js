import { once } from "node:events"
import { createServer } from "node:http"
import { Context, Deferred, Effect, Exit, Fiber } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { WebSocketServer } from "ws"
import {
    createClient,
    ClientClosedError,
    MessageOperationError,
    SdkDefect,
    type Client,
    type MessageOperationFailure,
    type TypingStart,
} from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const gatewayTransport = vi.hoisted(() => ({ url: "" }))
vi.mock("ws", async (original) => {
    const module = await original<typeof import("ws")>()
    return {
        ...module,
        default: class extends module.default {
            constructor(url: string, options: import("ws").ClientOptions) {
                super(gatewayTransport.url || url, options)
            }
        },
    }
})

type Request = { readonly url: string; readonly method: string; readonly body: BodyInit | null | undefined }
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
    gatewayTransport.url = ""
})

function defaultApi(): Client {
    const created = createClient({ token: "fixture-only-not-a-credential" })
    if (created.isErr()) throw created.error
    onTestFinished(async () => {
        await created.value.shutdown()
    })
    return created.value
}

function typingFetch(statuses: readonly number[] = [204]) {
    const requests: Request[] = []
    let index = 0
    stubFetchWithHostedDiscovery(async (url: string | URL, init?: RequestInit) => {
        requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body })
        return new Response(null, { status: statuses[Math.min(index++, statuses.length - 1)]! })
    })
    return requests
}

async function settled() {
    for (let index = 0; index < 64; index++) await Promise.resolve()
}

test("default typing uses Fluxer's one-shot channel route without a body or local state", async () => {
    const requests = typingFetch()
    const client = defaultApi()

    expect((await client.messages.typing("20")).isOk()).toBe(true)
    const invalid = await client.messages.typing("invalid")
    expect(invalid.isErr() && invalid.error).toMatchObject({
        _tag: "MessageOperationError",
        operation: "typing",
        reason: "input",
        outcome: "notDispatched",
    })
    expect(requests).toEqual([{ url: "https://api.fluxer.app/v1/channels/20/typing", method: "POST", body: undefined }])

    await client.shutdown()
    const closed = await client.messages.typing("20")
    expect(closed.isErr() && closed.error).toBeInstanceOf(ClientClosedError)
})

test("native typing is lazy and repeatable with the same one-shot request", async () => {
    const requests = typingFetch()
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                const typing = client.messages.typing("20")
                expect(requests).toHaveLength(0)
                yield* typing
                yield* typing
                expect(requests).toEqual([
                    { url: "https://api.fluxer.app/v1/channels/20/typing", method: "POST", body: undefined },
                    { url: "https://api.fluxer.app/v1/channels/20/typing", method: "POST", body: undefined },
                ])
            }),
        ),
    )
})

test("an initial typing HTTP failure prevents default task invocation", async () => {
    const requests = typingFetch([500])
    const client = defaultApi()
    let called = false

    const result = await client.messages.keepTyping("20", async () => {
        called = true
        return "unexpected"
    })

    expect(result.isErr() && result.error).toMatchObject({
        _tag: "MessageOperationError",
        operation: "typing",
    })
    expect(called).toBe(false)
    expect(requests).toEqual([{ url: "https://api.fluxer.app/v1/channels/20/typing", method: "POST", body: undefined }])
})

test("native keepTyping preserves its caller context", async () => {
    const requests = typingFetch()
    const Label = Context.Service<string>("typing-caller-label")

    const value = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                return yield* client.messages.keepTyping(
                    "20",
                    Effect.gen(function* () {
                        return yield* Label
                    }),
                )
            }).pipe(Effect.provideService(Label, "caller context")),
        ),
    )

    expect(value).toBe("caller context")
    expect(requests).toEqual([{ url: "https://api.fluxer.app/v1/channels/20/typing", method: "POST", body: undefined }])
})

test("default keepTyping refreshes at a bounded rate, never overlaps a held refresh, and stops after work", async () => {
    vi.useFakeTimers()
    const requests: Request[] = []
    let held: (() => void) | undefined
    stubFetchWithHostedDiscovery((url: string | URL, init?: RequestInit) => {
        requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body })
        if (requests.length === 2)
            return new Promise<Response>((resolve) => {
                held = () => resolve(new Response(null, { status: 204 }))
            })
        return Promise.resolve(new Response(null, { status: 204 }))
    })
    const client = defaultApi()
    let finish: ((value: string) => void) | undefined
    const result = client.messages.keepTyping(
        "20",
        () =>
            new Promise<string>((resolve) => {
                finish = resolve
            }),
    )

    await settled()
    await vi.advanceTimersByTimeAsync(100)
    await settled()
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(7_900)
    expect(requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await settled()
    expect(requests).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(16_000)
    expect(requests).toHaveLength(2)
    held!()
    await settled()
    finish!("prepared")
    const completed = await result
    expect(completed.isOk()).toBe(true)
    if (completed.isOk()) expect(completed.value).toBe("prepared")
    await vi.advanceTimersByTimeAsync(32_000)
    expect(requests).toHaveLength(2)
})

test("default cancellation aborts application work and waits for its cooperative settlement", async () => {
    vi.useFakeTimers()
    const requests = typingFetch()
    const client = defaultApi()
    const controller = new AbortController()
    let aborted = false
    let finish: (() => void) | undefined
    const result = client.messages.keepTyping(
        "20",
        (signal) =>
            new Promise<void>((resolve) => {
                finish = resolve
                signal.addEventListener("abort", () => {
                    aborted = true
                })
            }),
        { signal: controller.signal },
    )
    await settled()
    await vi.advanceTimersByTimeAsync(100)
    await settled()
    expect(finish).toBeTypeOf("function")
    controller.abort()
    await settled()
    expect(aborted).toBe(true)
    let completed = false
    void result.then(() => {
        completed = true
    })
    await settled()
    expect(completed).toBe(false)
    finish!()
    const cancelled = await result
    expect(cancelled.isErr() && cancelled.error._tag).toBe("CancelledError")
    await vi.advanceTimersByTimeAsync(16_000)
    expect(requests).toHaveLength(1)
})

test("default cancellation retains a task defect that arrives during cleanup", async () => {
    const requests = typingFetch()
    const client = defaultApi()
    const controller = new AbortController()
    let rejectTask: ((error: Error) => void) | undefined
    const result = client.messages.keepTyping(
        "20",
        () =>
            new Promise<never>((_resolve, reject) => {
                rejectTask = reject
            }),
        { signal: controller.signal },
    )

    await settled()
    await vi.waitFor(() => expect(rejectTask).toBeTypeOf("function"))
    controller.abort()
    await settled()
    rejectTask!(new Error("late task failure"))

    await expect(result).rejects.toMatchObject({
        name: "SdkDefect",
        operation: "keepTyping",
        reasons: expect.arrayContaining([{ kind: "Interruption" }, { kind: "Defect" }]),
    } satisfies Partial<SdkDefect>)
    expect(requests).toHaveLength(1)
})

test("default normal task rejection retains one application defect", async () => {
    const requests = typingFetch()
    const client = defaultApi()

    await expect(
        client.messages.keepTyping("20", () => Promise.reject(new Error("task failed"))),
    ).rejects.toMatchObject({
        name: "SdkDefect",
        operation: "keepTyping",
        reasons: [{ kind: "Defect" }],
    } satisfies Partial<SdkDefect>)
    expect(requests).toHaveLength(1)
})

test("native interruption stops refresh work before the caller scope continues", async () => {
    vi.useFakeTimers()
    const requests = typingFetch()
    const ready = Deferred.makeUnsafe<Fiber.Fiber<never, MessageOperationFailure>>()
    const release = Deferred.makeUnsafe<void>()
    const running = Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                const fiber = yield* Effect.forkChild(client.messages.keepTyping("20", Effect.never))
                Deferred.doneUnsafe(ready, Effect.succeed(fiber))
                yield* Deferred.await(release)
            }),
        ),
    )
    const fiber = await Effect.runPromise(Deferred.await(ready))
    await vi.advanceTimersByTimeAsync(100)
    await settled()
    expect(requests).toHaveLength(1)
    await Effect.runPromise(Fiber.interrupt(fiber))
    await vi.advanceTimersByTimeAsync(16_000)
    expect(requests).toHaveLength(1)
    Deferred.doneUnsafe(release, Effect.void)
    await running
})

test("typing refresh and task failures retain both native causes and default safe causes", async () => {
    vi.useFakeTimers()
    const defaultRequests = typingFetch([204, 500])
    const defaultClient = defaultApi()
    let rejectTask: ((error: Error) => void) | undefined
    const defaultResult = defaultClient.messages.keepTyping(
        "20",
        () =>
            new Promise<never>((_resolve, reject) => {
                rejectTask = reject
            }),
    )
    await settled()
    await vi.advanceTimersByTimeAsync(100)
    await settled()
    await vi.advanceTimersByTimeAsync(8_000)
    await settled()
    expect(defaultRequests).toHaveLength(2)
    rejectTask!(new Error("task failed"))
    await expect(defaultResult).rejects.toMatchObject({
        name: "SdkDefect",
        operation: "keepTyping",
        reasons: expect.arrayContaining([
            expect.objectContaining({
                kind: "Failure",
                failure: expect.objectContaining({ _tag: "MessageOperationError", operation: "typing" }),
            }),
            { kind: "Defect" },
        ]),
    } satisfies Partial<SdkDefect>)

    vi.unstubAllGlobals()
    const nativeRequests = typingFetch([204, 500])
    const task = Deferred.makeUnsafe<never, { readonly _tag: "TaskFailure" }>()
    const nativeResult = Effect.runPromiseExit(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                return yield* client.messages.keepTyping("20", Deferred.await(task))
            }),
        ),
    )
    await settled()
    await vi.advanceTimersByTimeAsync(100)
    await settled()
    await vi.advanceTimersByTimeAsync(8_000)
    await settled()
    expect(nativeRequests).toHaveLength(2)
    Deferred.doneUnsafe(task, Effect.fail({ _tag: "TaskFailure" as const }))
    const nativeExit = await nativeResult
    expect(Exit.isFailure(nativeExit)).toBe(true)
    if (Exit.isFailure(nativeExit))
        expect(nativeExit.cause.reasons).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ _tag: "Fail", error: expect.any(MessageOperationError) }),
                expect.objectContaining({ _tag: "Fail", error: { _tag: "TaskFailure" } }),
            ]),
        )
})

test("client shutdown stops and awaits refreshes without claiming to cancel default task work", async () => {
    vi.useFakeTimers()
    const requests = typingFetch()
    const client = defaultApi()
    let finish: ((value: string) => void) | undefined
    const result = client.messages.keepTyping(
        "20",
        () =>
            new Promise<string>((resolve) => {
                finish = resolve
            }),
    )
    await settled()
    await vi.advanceTimersByTimeAsync(100)
    await settled()
    expect(finish).toBeTypeOf("function")
    const shutdown = client.shutdown()
    await vi.advanceTimersByTimeAsync(0)
    await settled()
    await shutdown
    await vi.advanceTimersByTimeAsync(16_000)
    expect(requests).toHaveLength(1)
    finish!("completed after shutdown")
    const closed = await result
    expect(closed.isErr() && closed.error).toBeInstanceOf(ClientClosedError)
})

async function gatewayFixture() {
    const sockets: import("ws").WebSocket[] = []
    const server = createServer()
    const gateway = new WebSocketServer({ server })
    gateway.on("connection", (socket) => {
        sockets.push(socket)
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
        socket.on("message", (data) => {
            const packet = JSON.parse(data.toString()) as { readonly op: number }
            if (packet.op === 2)
                socket.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "typing-session" } }))
            if (packet.op === 1) socket.send(JSON.stringify({ op: 11 }))
        })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing loopback address")
    gatewayTransport.url = `ws://127.0.0.1:${address.port}`
    const discoveryRequests: Request[] = []
    stubFetchWithHostedDiscovery(async (url: string | URL, init?: RequestInit) => {
        discoveryRequests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body })
        return new Response(JSON.stringify({ url: "wss://gateway.fluxer.app" }), { status: 200 })
    })
    onTestFinished(async () => {
        for (const socket of sockets) socket.terminate()
        await new Promise<void>((resolve) => gateway.close(() => resolve()))
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return {
        discoveryRequests,
        dispatch(body: unknown) {
            for (const socket of sockets) socket.send(JSON.stringify({ op: 0, s: 2, t: "TYPING_START", d: body }))
        },
    }
}

test("typingStart is frozen delivery-only gateway data, including valid partial provider variants", async () => {
    const gateway = await gatewayFixture()
    const client = defaultApi()
    const received = Deferred.makeUnsafe<TypingStart>()
    const subscription = client.on("typingStart", (event) => {
        Deferred.doneUnsafe(received, Effect.succeed(event))
    })
    if (subscription.isErr()) throw subscription.error
    expect((await client.connect()).isOk()).toBe(true)
    gateway.dispatch({
        channel_id: "20",
        user_id: "30",
        timestamp: 1_700_000_000,
        guild_id: "40",
        member: { deliberately: "ignored without hydration" },
    })
    const full = await Effect.runPromise(Deferred.await(received))
    expect(full).toEqual({ channelId: "20", userId: "30", timestamp: 1_700_000_000, guildId: "40" })
    expect(Object.isFrozen(full)).toBe(true)
    expect(gateway.discoveryRequests).toEqual([])

    const partial = Deferred.makeUnsafe<TypingStart>()
    const second = client.on("typingStart", (event) => {
        Deferred.doneUnsafe(partial, Effect.succeed(event))
    })
    if (second.isErr()) throw second.error
    gateway.dispatch({ channel_id: "20", user_id: "31", timestamp: 1_700_000_001, member: [] })
    expect(await Effect.runPromise(Deferred.await(partial))).toEqual({
        channelId: "20",
        userId: "31",
        timestamp: 1_700_000_001,
    })

    const nativeReceived = Deferred.makeUnsafe<TypingStart>()
    const nativeReady = Deferred.makeUnsafe<void>()
    const nativeDelivery = Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const native = yield* createNative({ token: "fixture-only-not-a-credential" })
                yield* native.on("typingStart", (event) =>
                    Effect.sync(() => {
                        Deferred.doneUnsafe(nativeReceived, Effect.succeed(event))
                    }),
                )
                yield* native.connect()
                Deferred.doneUnsafe(nativeReady, Effect.void)
                return yield* Deferred.await(nativeReceived)
            }),
        ),
    )
    await Effect.runPromise(Deferred.await(nativeReady))
    gateway.dispatch({ channel_id: "20", user_id: "32", timestamp: 1_700_000_002 })
    expect(await nativeDelivery).toEqual({ channelId: "20", userId: "32", timestamp: 1_700_000_002 })
})
