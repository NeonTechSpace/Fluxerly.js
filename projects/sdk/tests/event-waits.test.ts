import { once } from "node:events"
import { createServer } from "node:http"
import { Effect, Exit, Fiber, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { WebSocketServer } from "ws"
import { createClient } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const transport = vi.hoisted(() => ({ url: "" }))
vi.mock("ws", async (original) => {
    const module = await original<typeof import("ws")>()
    return {
        ...module,
        default: class extends module.default {
            constructor(url: string, options: import("ws").ClientOptions) {
                expect(url).toBe("wss://gateway.fluxer.app/?v=1&encoding=json")
                super(transport.url, options)
            }
        },
    }
})

const realFetch = globalThis.fetch
afterEach(() => vi.unstubAllGlobals())

const wire = (id: string, content: string) => ({
    id,
    channel_id: "20",
    content,
    author: { id: "30", username: "fixture" },
})

async function fixture() {
    const sockets: import("ws").WebSocket[] = []
    let sequence = 1
    let requests = 0
    const server = createServer((request, response) => {
        requests++
        if (request.url?.endsWith("/gateway/bot")) response.end(JSON.stringify({ url: "wss://gateway.fluxer.app" }))
        else response.writeHead(404).end()
    })
    const gateway = new WebSocketServer({ server })
    gateway.on("connection", (socket) => {
        sockets.push(socket)
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
        socket.on("message", (data) => {
            const packet = JSON.parse(data.toString())
            if (packet.op === 2)
                socket.send(JSON.stringify({ op: 0, s: ++sequence, t: "READY", d: { session_id: "fixture-session" } }))
            if (packet.op === 1) socket.send(JSON.stringify({ op: 11 }))
        })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing fixture port")
    transport.url = `ws://127.0.0.1:${address.port}`
    stubFetchWithHostedDiscovery((url: string, init: RequestInit) =>
        realFetch(url.replace("https://api.fluxer.app", `http://127.0.0.1:${address.port}`), init),
    )
    onTestFinished(async () => {
        for (const socket of sockets) socket.terminate()
        await new Promise<void>((resolve) => gateway.close(() => resolve()))
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return {
        dispatch(content: string, id = content) {
            for (const socket of sockets)
                socket.send(JSON.stringify({ op: 0, s: ++sequence, t: "MESSAGE_CREATE", d: wire(id, content) }))
        },
        get requests() {
            return requests
        },
    }
}

function value<A, E>(result: { isErr(): boolean; value?: A; error?: E }): A {
    if (result.isErr()) throw result.error
    return result.value!
}

async function waitForFilter(
    dispatch: (content: string, id?: string) => void,
    seen: readonly string[],
    content = "probe",
) {
    for (let attempt = 0; attempt < 20 && !seen.includes(content); attempt++) {
        dispatch(content, String(100 + attempt))
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(seen).toContain(content)
}

test("default waits filter future events, share source fan-out and make no REST request after connection", async () => {
    const server = await fixture()
    const client = value(createClient({ token: "fixture-only-not-a-credential" }))
    onTestFinished(async () => {
        await client.shutdown()
    })
    value(await client.connect())
    const control: string[] = []
    value(
        client.on("messageCreate", (message) => {
            control.push(message.content)
        }),
    )
    server.dispatch("control", "10")
    await vi.waitFor(() => expect(control).toEqual(["control"]))
    expect(client.state).toBe("Connected")
    const events = value(client.events("messageCreate"))
    const filtered: string[] = []
    const waiting = client.waitFor("messageCreate", {
        filter: (message) => {
            filtered.push(message.content)
            return message.content === "answer"
        },
        timeoutMs: 1_000,
    })
    await waitForFilter((content, id) => server.dispatch(content, id), filtered, "ignore")
    server.dispatch("answer", "2")
    expect(value(await waiting)).toMatchObject({ id: "2", content: "answer" })
    while (true) {
        const event = value(await events.next())
        if (!event) throw new Error("Event source closed before answer")
        if (event.content === "answer") {
            expect(event).toMatchObject({ id: "2", content: "answer" })
            break
        }
        expect(event.content).toBe("ignore")
    }
    expect(server.requests).toBe(0)
})

test("native waits are lazy and use observed filter delivery rather than fork scheduling as a registration barrier", async () => {
    const server = await fixture()
    const seen: string[] = []
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                const wait = client.waitFor("messageCreate", {
                    filter: (message) => {
                        seen.push(message.content)
                        return message.content === "answer"
                    },
                    timeoutMs: 1_000,
                })
                const invalid = client.waitFor("messageCreate", { timeoutMs: 0 } as never)
                expect(seen).toEqual([])
                const invalidExit = yield* Effect.exit(invalid)
                expect(Exit.isFailure(invalidExit)).toBe(true)
                if (Exit.isFailure(invalidExit))
                    expect(invalidExit.cause.reasons).toContainEqual(
                        expect.objectContaining({
                            _tag: "Fail",
                            error: expect.objectContaining({ _tag: "ConfigurationError", field: "timeoutMs" }),
                        }),
                    )
                yield* client.connect()
                const fiber = yield* Effect.forkScoped(wait)
                yield* Effect.promise(() =>
                    waitForFilter((content, id) => server.dispatch(content, id), seen, "ignore"),
                )
                server.dispatch("answer", "2")
                const event = yield* Fiber.join(fiber)
                expect(event).toMatchObject({ id: "2", content: "answer" })
                const interruptedSeen: string[] = []
                const interrupted = yield* Effect.forkScoped(
                    client.waitFor("messageCreate", {
                        filter: (message) => {
                            interruptedSeen.push(message.content)
                            return false
                        },
                    }),
                )
                yield* Effect.promise(() =>
                    waitForFilter((content, id) => server.dispatch(content, id), interruptedSeen, "interrupt-probe"),
                )
                yield* Fiber.interrupt(interrupted)
                const stopped = [...interruptedSeen]
                server.dispatch("after-native-interrupt", "201")
                yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
                expect(interruptedSeen).toEqual(stopped)
                yield* client.shutdown()
            }),
        ),
    )
})

test("event waits retain typed timeout and safe filter failures", async () => {
    const server = await fixture()
    const defaultApi = value(createClient({ token: "fixture-only-not-a-credential" }))
    onTestFinished(async () => {
        await defaultApi.shutdown()
    })
    value(await defaultApi.connect())
    const timeout = await defaultApi.waitFor("messageCreate", { timeoutMs: 20 })
    expect(timeout.isErr() && timeout.error).toMatchObject({ _tag: "EventWaitError", reason: "timeout" })
    const invalidTimeout = await defaultApi.waitFor("messageCreate", { timeoutMs: Infinity } as never)
    expect(invalidTimeout.isErr() && invalidTimeout.error).toMatchObject({
        _tag: "ConfigurationError",
        field: "timeoutMs",
    })
    const filterCalls: string[] = []
    const failed = defaultApi.waitFor("messageCreate", {
        filter: (message) => {
            filterCalls.push(message.content)
            if (message.content === "probe") return false
            throw new Error("private event-wait filter")
        },
    })
    await waitForFilter((content, id) => server.dispatch(content, id), filterCalls)
    server.dispatch("answer", "200")
    const failure = await failed
    expect(failure.isErr() && failure.error).toMatchObject({ _tag: "EventWaitError", reason: "filter" })
    expect(JSON.stringify(failure)).not.toContain("private event-wait filter")

    const scope = Scope.makeUnsafe()
    const native = await Effect.runPromise(
        createNative({ token: "fixture-only-not-a-credential" }).pipe(Scope.provide(scope)),
    )
    try {
        await Effect.runPromise(native.connect())
        let nativeCalls = 0
        const nativeSeen: string[] = []
        const nativeFailure = await Effect.runPromise(
            Effect.gen(function* () {
                const fiber = yield* Effect.forkIn(
                    Effect.exit(
                        native.waitFor("messageCreate", {
                            filter: (message) => {
                                nativeCalls++
                                nativeSeen.push(message.content)
                                if (message.content === "probe") return false
                                return Promise.reject(new Error("private thenable")) as never
                            },
                        }),
                    ),
                    scope,
                )
                yield* Effect.promise(() => waitForFilter((content, id) => server.dispatch(content, id), nativeSeen))
                server.dispatch("native-filter", "200")
                return yield* Fiber.join(fiber)
            }),
        )
        expect(Exit.isFailure(nativeFailure)).toBe(true)
        if (Exit.isFailure(nativeFailure))
            expect(nativeFailure.cause.reasons).toContainEqual(
                expect.objectContaining({
                    _tag: "Fail",
                    error: expect.objectContaining({ _tag: "EventWaitError", reason: "filter" }),
                }),
            )
        expect(JSON.stringify(nativeFailure)).not.toContain("private thenable")
    } finally {
        await Effect.runPromise(native.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
    }
})

test("event wait cancellation releases intake before later dispatch", async () => {
    const server = await fixture()
    const client = value(createClient({ token: "fixture-only-not-a-credential" }))
    onTestFinished(async () => {
        await client.shutdown()
    })
    value(await client.connect())
    const controller = new AbortController()
    const seen: string[] = []
    const waiting = client.waitFor("messageCreate", {
        signal: controller.signal,
        filter: (message) => {
            seen.push(message.content)
            return false
        },
    })
    await waitForFilter((content, id) => server.dispatch(content, id), seen)
    controller.abort()
    const cancelled = await waiting
    expect(cancelled.isErr() && cancelled.error).toMatchObject({ _tag: "CancelledError" })
    const stopped = [...seen]
    server.dispatch("after-cancel", "200")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen).toEqual(stopped)
    expect(client.state).toBe("Connected")
})

test("event-source overflow does not interrupt a concurrent wait and shutdown closes a pending wait", async () => {
    const server = await fixture()
    const client = value(createClient({ token: "fixture-only-not-a-credential" }))
    onTestFinished(async () => {
        await client.shutdown()
    })
    value(await client.connect())
    const overflowing = value(client.events("messageCreate", { maxPendingMessages: 1 }))
    const filtered: string[] = []
    const waiting = client.waitFor("messageCreate", {
        filter: (message) => {
            filtered.push(message.content)
            return message.content === "answer"
        },
        timeoutMs: 1_000,
    })
    await waitForFilter((content, id) => server.dispatch(content, id), filtered)
    server.dispatch("one", "1")
    server.dispatch("two", "2")
    const overflow = await overflowing.waitForClose()
    expect(overflow.isErr() && overflow.error).toMatchObject({ _tag: "EventOverflowError", limit: "messages" })
    server.dispatch("answer", "3")
    expect(value(await waiting)).toMatchObject({ id: "3", content: "answer" })
    expect(client.state).toBe("Connected")

    const closingSeen: string[] = []
    const closing = client.waitFor("messageCreate", {
        filter: (message) => {
            closingSeen.push(message.content)
            return false
        },
        timeoutMs: 1_000,
    })
    await waitForFilter((content, id) => server.dispatch(content, id), closingSeen)
    await client.shutdown()
    const closed = await closing
    expect(closed.isErr() && closed.error).toMatchObject({ _tag: "ClientClosedError" })
})
