import { createServer } from "node:http"
import { once } from "node:events"
import { Cause, Effect, Exit, Fiber, Logger, References, Stream } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { WebSocketServer } from "ws"
import { createClient, SdkDefect, type Client, type Message } from "../src/index.js"
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
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})
const wire = (id = "10", content = "!ping") => ({
    id,
    channel_id: "20",
    content,
    author: { id: "30", username: "fixture", bot: false },
})

async function fixture() {
    const requests: Record<string, any>[] = []
    const sockets: import("ws").WebSocket[] = []
    let sequence = 1
    const control = {
        status: 200,
        retryAfter: 0.02,
        global: false,
        malformed: false,
        hold: false,
        failOnce: false,
        closed: 0,
    }
    const held: import("node:http").ServerResponse[] = []
    const server = createServer(async (request, response) => {
        if (request.url?.endsWith("/gateway/bot")) {
            response.end(JSON.stringify({ url: "wss://gateway.fluxer.app" }))
            return
        }
        expect(request.method).toBe("POST")
        expect(request.headers.authorization).toBe("Bot fixture-only-not-a-credential")
        let body = ""
        for await (const chunk of request) body += chunk.toString()
        const parsed = JSON.parse(body)
        requests.push(parsed)
        response.on("close", () => control.closed++)
        if (control.hold) {
            held.push(response)
            return
        }
        response.setHeader("Content-Type", "application/json")
        const status = parsed.message_reference?.message_id === "404" ? 404 : control.status
        response.writeHead(status)
        if (status === 429) {
            response.end(JSON.stringify({ retry_after: control.retryAfter, global: control.global }))
            if (control.failOnce) control.status = 200
        } else response.end(control.malformed ? "{}" : JSON.stringify(wire("99", parsed.content)))
    })
    const gateway = new WebSocketServer({ server })
    gateway.on("connection", (socket) => {
        sockets.push(socket)
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
        socket.on("message", (data) => {
            const packet = JSON.parse(data.toString())
            if (packet.op === 2)
                socket.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "fixture-session" } }))
            if (packet.op === 1) socket.send(JSON.stringify({ op: 11 }))
        })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing fixture port")
    transport.url = `ws://127.0.0.1:${address.port}`
    stubFetchWithHostedDiscovery((url: string, init: RequestInit) => {
        expect(url.startsWith("https://api.fluxer.app/v1/")).toBe(true)
        expect(init.redirect).toBe("error")
        return realFetch(url.replace("https://api.fluxer.app", `http://127.0.0.1:${address.port}`), init)
    })
    onTestFinished(async () => {
        for (const socket of sockets) socket.terminate()
        for (const response of held) response.destroy()
        await new Promise<void>((resolve) => gateway.close(() => resolve()))
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return {
        requests,
        control,
        held,
        dispatch: (id = "10", content = "!ping", authorId = "30") => {
            for (const socket of sockets)
                socket.send(
                    JSON.stringify({
                        op: 0,
                        s: ++sequence,
                        t: "MESSAGE_CREATE",
                        d: { ...wire(id, content), author: { ...wire().author, id: authorId } },
                    }),
                )
        },
    }
}

function defaultApi(): Client {
    const result = createClient({ token: "fixture-only-not-a-credential" })
    if (result.isErr()) throw result.error
    onTestFinished(async () => {
        await result.value.shutdown()
    })
    return result.value
}
function value<A, E>(result: { isErr(): boolean; value?: A; error?: E }): A {
    if (result.isErr()) throw result.error
    return result.value!
}

test("text send and reply work disconnected, preserve payloads, suppress mentions and return frozen plain snapshots", async () => {
    const server = await fixture()
    const client = defaultApi()
    const sent = value(await client.messages.send("20", { content: "  hello  " }))
    expect(sent.content).toBe("  hello  ")
    expect(Object.isFrozen(sent)).toBe(true)
    expect(Object.isFrozen(sent.author)).toBe(true)
    expect("reply" in sent).toBe(false)
    value(
        await client.messages.reply(sent, { content: "reply", allowedMentions: { users: ["30"], repliedUser: true } }),
    )
    expect(server.requests[0]!.allowed_mentions).toEqual({ parse: [], users: [], roles: [], replied_user: false })
    expect(server.requests[1]!.message_reference).toEqual({ message_id: "99", channel_id: "20", type: 0 })
    expect(server.requests[1]!.allowed_mentions.replied_user).toBe(true)
    expect((await client.messages.reply({ id: "404", channelId: "20" }, { content: "reply" })).isErr()).toBe(true)
    expect(server.requests).toHaveLength(3)
})

test("default callback receive-and-reply runs sequentially and reports handler failure without retrying it", async () => {
    const server = await fixture()
    const client = defaultApi()
    const started: string[] = []
    const reports: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
        release = resolve
    })
    const sub = value(
        client.on(
            "messageCreate",
            async (message, signal) => {
                started.push(message.id)
                if (message.id === "10") await gate
                if (message.id === "11") throw new Error("private fixture body must not be logged")
                value(await client.messages.reply(message, { content: "Pong!" }, { signal }))
            },
            {
                onError: (report) => {
                    reports.push(report.kind)
                },
            },
        ),
    )
    value(await client.connect())
    server.dispatch("10")
    await vi.waitFor(() => expect(started).toEqual(["10"]))
    server.dispatch("11")
    server.dispatch("12")
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(started).toEqual(["10"])
    release()
    await vi.waitFor(() => expect(started).toEqual(["10", "11", "12"]))
    await vi.waitFor(() => expect(server.requests).toHaveLength(2))
    expect(reports).toEqual(["handler"])
    sub.unsubscribe()
    value(await sub.waitForClose())
    expect(client.state).toBe("Connected")
})

test("explicit default concurrency is bounded and unsubscribe signals callbacks without awaiting an uncooperative promise", async () => {
    const server = await fixture()
    const client = defaultApi()
    const signals: { readonly aborted: boolean }[] = []
    const sub = value(
        client.on(
            "messageCreate",
            async (_message, signal) => {
                signals.push(signal)
                await new Promise<void>(() => {})
            },
            { concurrency: 2 },
        ),
    )
    value(await client.connect())
    server.dispatch("10")
    server.dispatch("11")
    server.dispatch("12")
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    sub.unsubscribe()
    value(await sub.waitForClose())
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    expect(signals).toHaveLength(2)
})

test.each(["messages", "bytes"] as const)(
    "%s overflow is retained, isolates the subscriber and discards pending events",
    async (limit) => {
        const server = await fixture()
        const client = defaultApi()
        const blocked = value(
            client.on("messageCreate", () => new Promise<void>(() => {}), {
                maxPendingMessages: 1,
                maxPendingBytes: limit === "bytes" ? 1 : 10000,
            }),
        )
        const other = value(client.events("messageCreate"))
        value(await client.connect())
        server.dispatch("10")
        value(await other.next())
        server.dispatch("11")
        server.dispatch("12")
        const outcome = await blocked.waitForClose()
        expect(outcome.isErr() && outcome.error._tag).toBe("EventOverflowError")
        if (outcome.isErr() && outcome.error._tag === "EventOverflowError") expect(outcome.error.limit).toBe(limit)
        blocked.unsubscribe()
        expect(await blocked.waitForClose()).toEqual(outcome)
        expect(value(await other.next())?.id).toBe("11")
        expect(value(await other.next())?.id).toBe("12")
        expect(client.state).toBe("Connected")
        other.unsubscribe()
        expect(value(await other.next())).toBe(null)
    },
)

test("pull cancellation only releases its own read, and overlapping reads return a typed busy error", async () => {
    const server = await fixture()
    const client = defaultApi()
    const source = value(client.events("messageCreate"))
    const controller = new AbortController()
    const reading = source.next({ signal: controller.signal })
    const busy = await source.next()
    expect(busy.isErr() && busy.error._tag).toBe("EventReadBusyError")
    controller.abort()
    expect((await reading).isErr()).toBe(true)
    value(await client.connect())
    server.dispatch()
    expect(value(await source.next())?.id).toBe("10")
    source.unsubscribe()
})

test("native handlers share concurrency controls, own cleanup and send replies through the native surface", async () => {
    const server = await fixture()
    const seen: string[] = []
    let cleaned = 0
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                const sub = yield* client.on(
                    "messageCreate",
                    (message) =>
                        Effect.gen(function* () {
                            seen.push(message.id)
                            yield* client.messages.reply(message, { content: "native" })
                            yield* Effect.never
                        }).pipe(
                            Effect.ensuring(
                                Effect.sync(() => {
                                    cleaned++
                                }),
                            ),
                        ),
                    { concurrency: 2 },
                )
                yield* client.connect()
                server.dispatch("10")
                server.dispatch("11")
                server.dispatch("12")
                yield* Effect.promise(() => vi.waitFor(() => expect(server.requests).toHaveLength(2)))
                yield* sub.unsubscribe()
                yield* sub.waitForClose()
                expect(seen).toEqual(["10", "11"])
                expect(cleaned).toBe(2)
            }),
        ),
    )
})

test("native stream is lazy, scoped and live with no history replay", async () => {
    const server = await fixture()
    const messages = await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                const stream = client.events("messageCreate")
                yield* client.connect()
                const collecting = yield* Effect.forkChild(Stream.runCollect(Stream.take(stream, 2)))
                yield* Effect.sleep(10)
                server.dispatch("10")
                server.dispatch("11")
                return yield* Fiber.join(collecting)
            }),
        ),
    )
    expect(messages.map((message: Message) => message.id)).toEqual(["10", "11"])
})

test("confirmed rate limits retry with the same nonce, while server failure and malformed success never resend", async () => {
    const server = await fixture()
    const client = defaultApi()
    server.control.status = 429
    server.control.failOnce = true
    value(await client.messages.send("20", { content: "retry" }))
    expect(server.requests).toHaveLength(2)
    expect(server.requests[0]!.nonce).toBe(server.requests[1]!.nonce)
    server.control.status = 500
    const rejected = await client.messages.send("20", { content: "do not repeat" })
    expect(rejected.isErr() && rejected.error._tag === "MessageError" && rejected.error.delivery).toBe("unknown")
    server.control.status = 200
    server.control.malformed = true
    const malformed = await client.messages.send("20", { content: "decode" })
    expect(malformed.isErr() && malformed.error._tag === "MessageError" && malformed.error.reason).toBe("response")
    expect(server.requests).toHaveLength(4)
})

test("send deadlines include server waits and cancellation aborts HTTP without retrying", async () => {
    const server = await fixture()
    const client = defaultApi()
    server.control.status = 429
    server.control.retryAfter = 10
    const limited = await client.messages.send("20", { content: "wait" }, { timeoutMs: 100 })
    expect(limited.isErr() && limited.error._tag === "MessageError" && limited.error.reason).toBe("rateLimit")
    expect(server.requests).toHaveLength(1)
    // Another channel is not blocked by this channel's rate-limit state
    server.control.status = 200
    server.control.hold = true
    const controller = new AbortController()
    const sending = client.messages.send("21", { content: "cancel" }, { signal: controller.signal })
    await vi.waitFor(() => expect(server.requests).toHaveLength(2))
    controller.abort()
    expect((await sending).isErr()).toBe(true)
    await vi.waitFor(() => expect(server.control.closed).toBe(2))
    expect(server.requests).toHaveLength(2)
})

test("invalid options and message inputs fail without network work; native sends remain lazy", async () => {
    const server = await fixture()
    const client = defaultApi()
    expect(client.events("messageCreate", { maxPendingMessages: 0 }).isErr()).toBe(true)
    expect(client.on("messageCreate", () => {}, { concurrency: -1 }).isErr()).toBe(true)
    for (const input of [
        { content: "" },
        { content: "hi", allowedMentions: null },
        { content: "hi", messageReference: null },
    ]) {
        expect((await client.messages.send("20", input as any)).isErr()).toBe(true)
    }
    expect((await client.messages.send("20", { content: "hi" }, { timeoutMs: null } as any)).isErr()).toBe(true)
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const native = yield* createNative({ token: "fixture-only-not-a-credential" })
                native.messages.send("20", { content: "not executed" })
                const failure = yield* Effect.exit(native.on("messageCreate", () => Effect.void, { concurrency: 0 }))
                expect(Exit.isFailure(failure)).toBe(true)
            }),
        ),
    )
    expect(server.requests).toHaveLength(0)
})

test("default reply returns a sanitized SdkDefect for an eager input getter", async () => {
    const client = defaultApi()
    const privateBody = "private default boundary getter defect"
    const reply = client.messages.reply(
        { id: "10", channelId: "20" },
        Object.defineProperty({}, "content", {
            get() {
                throw new Error(privateBody)
            },
        }) as import("../src/index.js").ReplyInput,
    )
    let error: unknown
    try {
        await reply
    } catch (caught) {
        error = caught
    }
    expect(error).toBeInstanceOf(SdkDefect)
    expect(error).toMatchObject({ operation: "reply", reasons: [{ kind: "Defect" }] })
    expect(JSON.stringify(error)).not.toContain(privateBody)
    expect(String(error)).not.toContain(privateBody)
})

test("default async operations reject a sanitized SdkDefect for an eager signal getter", async () => {
    const client = defaultApi()
    const privateBody = "private default boundary getter defect"
    const fetch = client.messages.fetch(
        { id: "10", channelId: "20" },
        Object.defineProperty({}, "signal", {
            get() {
                throw new Error(privateBody)
            },
        }) as import("../src/index.js").DefaultMessageOperationOptions,
    )
    let error: unknown
    try {
        await fetch
    } catch (caught) {
        error = caught
    }
    expect(error).toBeInstanceOf(SdkDefect)
    expect(error).toMatchObject({ operation: "fetch", reasons: [{ kind: "Defect" }] })
    expect(JSON.stringify(error)).not.toContain(privateBody)
    expect(String(error)).not.toContain(privateBody)
})

test("default async operations sanitize listener cleanup defects without losing their primary failure", async () => {
    const client = defaultApi()
    const privateBody = "private default listener cleanup defect"
    const listeners = new Set<() => void>()
    let removals = 0
    const fetch = client.messages.fetch(
        { id: "invalid", channelId: "20" },
        {
            signal: {
                aborted: false,
                addEventListener: (_type, listener) => {
                    listeners.add(listener)
                },
                removeEventListener: (_type, listener) => {
                    removals++
                    listeners.delete(listener)
                    throw new Error(privateBody)
                },
            },
        },
    )
    let error: unknown
    try {
        await fetch
    } catch (caught) {
        error = caught
    }
    expect(error).toBeInstanceOf(SdkDefect)
    expect(error).toMatchObject({
        operation: "fetch",
        reasons: [
            { kind: "Failure", failure: { _tag: "MessageOperationError", reason: "input", outcome: "notDispatched" } },
            { kind: "Defect" },
        ],
    })
    expect(removals).toBe(1)
    expect(listeners.size).toBe(0)
    expect(JSON.stringify(error)).not.toContain(privateBody)
    expect(String(error)).not.toContain(privateBody)
})

test("default async operations remove a listener registered before signal setup throws", async () => {
    const client = defaultApi()
    const privateBody = "private default listener setup defect"
    const listeners = new Set<() => void>()
    let removals = 0
    const fetch = client.messages.fetch(
        { id: "10", channelId: "20" },
        {
            signal: {
                aborted: false,
                addEventListener: (_type, listener) => {
                    listeners.add(listener)
                    throw new Error(privateBody)
                },
                removeEventListener: (_type, listener) => {
                    removals++
                    listeners.delete(listener)
                },
            },
        },
    )
    let error: unknown
    try {
        await fetch
    } catch (caught) {
        error = caught
    }
    expect(error).toBeInstanceOf(SdkDefect)
    expect(error).toMatchObject({ operation: "fetch", reasons: [{ kind: "Defect" }] })
    expect(removals).toBe(1)
    expect(listeners.size).toBe(0)
    expect(JSON.stringify(error)).not.toContain(privateBody)
    expect(String(error)).not.toContain(privateBody)
})

test("default subscriptions throw a sanitized SdkDefect for an eager reporter getter", () => {
    const client = defaultApi()
    const privateBody = "private default boundary getter defect"
    let error: unknown
    try {
        client.on(
            "messageCreate",
            () => {},
            Object.defineProperty({}, "onError", {
                get() {
                    throw new Error(privateBody)
                },
            }) as import("../src/index.js").EventHandlerOptions,
        )
    } catch (caught) {
        error = caught
    }
    expect(error).toBeInstanceOf(SdkDefect)
    expect(error).toMatchObject({ operation: "on" })
    expect(JSON.stringify(error)).not.toContain(privateBody)
    expect(String(error)).not.toContain(privateBody)
})

test("a full outgoing queue rejects only new work, queued cancellation releases admission and shutdown closes active HTTP", async () => {
    const server = await fixture()
    server.control.hold = true
    const client = defaultApi()
    const active = Array.from({ length: 4 }, () => client.messages.send("20", { content: "active" }))
    await vi.waitFor(() => expect(server.requests).toHaveLength(4))
    const controller = new AbortController()
    const queued = Array.from({ length: 256 }, () =>
        client.messages.send("20", { content: "queued" }, { signal: controller.signal }),
    )
    const rejected = await client.messages.send("20", { content: "rejected" })
    expect(rejected.isErr() && rejected.error._tag === "MessageError" && rejected.error.reason).toBe("busy")
    controller.abort()
    const cancelled = await Promise.all(queued)
    expect(cancelled.every((result) => result.isErr() && result.error._tag === "CancelledError")).toBe(true)
    const admitted = client.messages.send("20", { content: "newly admitted" })
    value(await client.shutdown())
    const stopped = await Promise.all([...active, admitted])
    expect(stopped.every((result) => result.isErr() && result.error._tag === "ClientClosedError")).toBe(true)
    expect(server.requests).toHaveLength(4)
    await vi.waitFor(() => expect(server.control.closed).toBe(4))
})

test("outgoing byte budget applies independently of request count and queued deadlines release their entries", async () => {
    const server = await fixture()
    server.control.hold = true
    const client = defaultApi()
    const active = Array.from({ length: 4 }, () => client.messages.send("20", { content: "active" }))
    await vi.waitFor(() => expect(server.requests).toHaveLength(4))
    const large = client.messages.send("20", { content: "x".repeat(3 * 1024 * 1024) }, { timeoutMs: 150 })
    const rejected = await client.messages.send("20", { content: "y".repeat(2 * 1024 * 1024) })
    expect(rejected.isErr() && rejected.error._tag === "MessageError" && rejected.error.reason).toBe("busy")
    const expired = await large
    expect(expired.isErr() && expired.error._tag === "MessageError" && expired.error.delivery).toBe("notSent")
    value(await client.shutdown())
    await Promise.all(active)
    expect(server.requests).toHaveLength(4)
})

test("native callback retains caller annotations and cleanup defects remain in subscription closure", async () => {
    const server = await fixture()
    const observed: unknown[] = []
    const defect = new Error("fixture cleanup defect")
    const exit = await Effect.runPromiseExit(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                const sub = yield* client.on("messageCreate", () =>
                    Effect.gen(function* () {
                        const annotations = yield* References.CurrentLogAnnotations
                        observed.push(annotations.requestId)
                        yield* Effect.never
                    }).pipe(Effect.ensuring(Effect.die(defect))),
                )
                yield* client.connect()
                server.dispatch()
                yield* Effect.promise(() => vi.waitFor(() => expect(observed).toEqual(["caller-context"])))
                yield* sub.unsubscribe()
                const closed = yield* Effect.exit(sub.waitForClose())
                expect(Exit.isFailure(closed) && Cause.hasDies(closed.cause)).toBe(true)
            }),
        ).pipe(Effect.annotateLogs("requestId", "caller-context")),
    )
    // An explicitly unsubscribed handler's failure is retained on its own handle, not used to stop unrelated work
    expect(exit).toMatchObject({ _tag: "Success" })
})

test("native shutdown invoked by a handler interrupts that handler without joining itself", async () => {
    const server = await fixture()
    let afterShutdown = false
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                yield* client.on("messageCreate", () =>
                    client.shutdown().pipe(
                        Effect.andThen(
                            Effect.sync(() => {
                                afterShutdown = true
                            }),
                        ),
                    ),
                )
                yield* client.connect()
                server.dispatch()
                yield* client.waitForClose()
                expect(client.state).toBe("Closed")
                expect(afterShutdown).toBe(false)
            }),
        ),
    )
})

test("native overflow is a typed stream failure and error reporters get safe metadata with one fallback", async () => {
    const server = await fixture()
    const logs: unknown[] = []
    const reports: unknown[] = []
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                const sub = yield* client.on("messageCreate", () => Effect.fail("private handler failure"), {
                    onError: (report) =>
                        Effect.sync(() => {
                            reports.push(report)
                            throw new Error("private reporter failure")
                        }),
                })
                yield* client.connect()
                server.dispatch()
                yield* Effect.promise(() => vi.waitFor(() => expect(reports).toHaveLength(1)))
                expect(reports).toEqual([{ event: "messageCreate", kind: "handler" }])
                expect(JSON.stringify(logs)).not.toContain("private")
                expect(logs).toHaveLength(1)
                yield* sub.unsubscribe()
                yield* sub.waitForClose()
                const reading = yield* Effect.forkChild(
                    Stream.runForEach(client.events("messageCreate", { maxPendingMessages: 1 }), () =>
                        Effect.sleep(60),
                    ),
                )
                yield* Effect.sleep(10)
                server.dispatch("11")
                yield* Effect.sleep(10)
                server.dispatch("12")
                server.dispatch("13")
                const ended = yield* Effect.exit(Fiber.join(reading))
                expect(
                    Exit.isFailure(ended) &&
                        ended.cause.reasons.some(
                            (reason) => reason._tag === "Fail" && reason.error._tag === "EventOverflowError",
                        ),
                ).toBe(true)
            }),
        ).pipe(
            Effect.withLogger(
                Logger.make((entry) => {
                    logs.push(entry.message)
                }),
            ),
        ),
    )
})

test("an uncooperative default reporter cannot hold subscription or client shutdown open", async () => {
    const server = await fixture()
    const client = defaultApi()
    let reported = false
    const sub = value(
        client.on("messageCreate", () => new Promise<void>(() => {}), {
            maxPendingMessages: 1,
            onError: () => {
                reported = true
                return new Promise<void>(() => {})
            },
        }),
    )
    value(await client.connect())
    server.dispatch("10")
    await new Promise((resolve) => setTimeout(resolve, 15))
    server.dispatch("11")
    server.dispatch("12")
    expect((await sub.waitForClose()).isErr()).toBe(true)
    await vi.waitFor(() => expect(reported).toBe(true))
    value(await client.shutdown())
})

test("the default event queue retains 256 messages and the next event fails it without harming other consumers", async () => {
    const server = await fixture()
    const client = defaultApi()
    const source = value(client.events("messageCreate"))
    let delivered = 0
    const witness = value(
        client.on(
            "messageCreate",
            () => {
                delivered++
            },
            { maxPendingMessages: 1024 },
        ),
    )
    value(await client.connect())
    for (let index = 0; index < 256; index++) server.dispatch(String(index + 100), "fixture", "0")
    await vi.waitFor(() => expect(delivered).toBe(256))
    for (let index = 0; index < 256; index++) {
        const message = value(await source.next())
        expect(message?.id).toBe(String(index + 100))
        expect(message?.author.id).toBe("0")
    }
    for (let index = 0; index < 257; index++) server.dispatch(String(index + 1000))
    const overflow = await source.waitForClose()
    expect(overflow.isErr() && overflow.error._tag === "EventOverflowError" && overflow.error.capacity).toBe(256)
    await vi.waitFor(() => expect(delivered).toBe(513))
    witness.unsubscribe()
})

test("high configured concurrency allocates no idle worker array and can close before receiving messages", async () => {
    const client = defaultApi()
    const sub = value(client.on("messageCreate", () => {}, { concurrency: Number.MAX_SAFE_INTEGER }))
    sub.unsubscribe()
    value(await sub.waitForClose())
})

test("native immediate unsubscribe and client shutdown retain completed subscription closure", async () => {
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                const stopped = yield* client.on("messageCreate", () => Effect.void)
                yield* stopped.unsubscribe()
                yield* stopped.waitForClose()
                const owned = yield* client.on("messageCreate", () => Effect.void)
                yield* client.shutdown()
                yield* owned.waitForClose()
                expect(client.state).toBe("Closed")
            }),
        ),
    )
})

test("client shutdown waits for other native cleanup even when one finalizer defects", async () => {
    const server = await fixture()
    let started = 0
    let cleaned = false
    const exit = await Effect.runPromiseExit(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                const handler = Effect.sync(() => {
                    started++
                }).pipe(Effect.andThen(Effect.never))
                yield* client.on("messageCreate", () =>
                    handler.pipe(Effect.ensuring(Effect.die(new Error("fixture finalizer failure")))),
                )
                yield* client.on("messageCreate", () =>
                    handler.pipe(
                        Effect.ensuring(
                            Effect.sleep(25).pipe(
                                Effect.andThen(
                                    Effect.sync(() => {
                                        cleaned = true
                                    }),
                                ),
                            ),
                        ),
                    ),
                )
                yield* client.connect()
                server.dispatch()
                yield* Effect.promise(() => vi.waitFor(() => expect(started).toBe(2)))
                const shutdown = yield* Effect.exit(client.shutdown())
                expect(Exit.isFailure(shutdown) && Cause.hasDies(shutdown.cause)).toBe(true)
                expect(cleaned).toBe(true)
                const terminal = yield* Effect.exit(client.waitForClose())
                expect(Exit.isFailure(terminal) && Cause.hasDies(terminal.cause)).toBe(true)
            }),
        ),
    )
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
})
