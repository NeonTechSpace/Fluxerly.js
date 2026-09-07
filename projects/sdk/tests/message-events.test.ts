import { createServer } from "node:http"
import { once } from "node:events"
import { Effect, Fiber, References, Stream } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { WebSocketServer } from "ws"
import { createClient, type Message, type MessageDeletion, type MessageBulkDeletion } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"

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
const wire = (content = "changed") => ({
    id: "10",
    channel_id: "20",
    content,
    author: { id: "30", username: "fixture" },
})

async function fixture() {
    const sockets: import("ws").WebSocket[] = []
    let sequence = 1
    let requests = 0
    const server = createServer(async (request, response) => {
        requests++
        if (request.url?.endsWith("/gateway/bot")) {
            response.end(JSON.stringify({ url: "wss://gateway.fluxer.app" }))
            return
        }
        let text = ""
        for await (const chunk of request) text += chunk.toString()
        if (request.method === "DELETE") response.writeHead(204).end()
        else response.end(JSON.stringify(wire(text ? JSON.parse(text).content : undefined)))
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
    vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
        realFetch(url.replace("https://api.fluxer.app", `http://127.0.0.1:${address.port}`), init),
    )
    onTestFinished(async () => {
        for (const socket of sockets) socket.terminate()
        await new Promise<void>((resolve) => gateway.close(() => resolve()))
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return {
        get requests() {
            return requests
        },
        dispatch(event: string, body: unknown) {
            for (const socket of sockets) socket.send(JSON.stringify({ op: 0, s: ++sequence, t: event, d: body }))
        },
    }
}

function value<A, E>(result: { isErr(): boolean; value?: A; error?: E }): A {
    if (result.isErr()) throw result.error
    return result.value!
}
function defaultApi() {
    const client = value(createClient({ token: "fixture-only-not-a-credential" }))
    onTestFinished(async () => {
        await client.shutdown()
    })
    return client
}

test("default callbacks and pull subscriptions route frozen updates and deletion payloads without cache or bulk fan-out", async () => {
    const server = await fixture()
    const client = defaultApi()
    const updates: Message[] = []
    const deletions: MessageDeletion[] = []
    const batches: MessageBulkDeletion[] = []
    let creates = 0
    value(
        client.on("messageCreate", () => {
            creates++
        }),
    )
    value(
        client.on("messageUpdate", (message) => {
            updates.push(message)
        }),
    )
    value(
        client.on("messageDelete", (message) => {
            deletions.push(message)
        }),
    )
    value(
        client.on("messageDeleteBulk", (batch) => {
            batches.push(batch)
        }),
    )
    const pull = value(client.events("messageDelete"))
    value(await client.connect())
    server.dispatch("MESSAGE_UPDATE", wire())
    server.dispatch("MESSAGE_UPDATE", wire())
    for (const body of [
        { id: "10", channel_id: "20" },
        { id: "11", channel_id: "20", content: null },
        { id: "12", channel_id: "20", content: "", author_id: "30" },
    ])
        server.dispatch("MESSAGE_DELETE", body)
    server.dispatch("MESSAGE_DELETE_BULK", { channel_id: "20", ids: ["40", "41"], guild_id: "99" })
    await vi.waitFor(() => expect([updates.length, deletions.length, batches.length]).toEqual([2, 3, 1]))
    expect(creates).toBe(0)
    expect(updates[0]).toEqual({
        id: "10",
        channelId: "20",
        content: "changed",
        author: { id: "30", username: "fixture", isBot: false },
    })
    expect(deletions).toEqual([
        { id: "10", channelId: "20" },
        { id: "11", channelId: "20", content: null },
        { id: "12", channelId: "20", content: "", authorId: "30" },
    ])
    expect(batches).toEqual([{ channelId: "20", ids: ["40", "41"] }])
    expect(
        Object.isFrozen(updates[0]!.author) && Object.isFrozen(deletions[0]) && Object.isFrozen(batches[0]!.ids),
    ).toBe(true)
    for (const expected of deletions) expect(value(await pull.next())).toEqual(expected)
    const controller = new AbortController()
    const waiting = pull.next({ signal: controller.signal })
    controller.abort()
    expect((await waiting).isErr()).toBe(true)
    expect(server.requests).toBe(1)
    value(await client.shutdown())
    expect(value(await pull.next())).toBeNull()
})

test("native callbacks preserve caller context and streams route single and bulk deletions", async () => {
    const server = await fixture()
    const received: unknown[] = []
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                const update = yield* client.on("messageUpdate", (message) =>
                    Effect.gen(function* () {
                        expect((yield* References.CurrentLogAnnotations).fixture).toBe("events")
                        received.push(message)
                    }),
                )
                const deleted = yield* Effect.forkScoped(
                    Stream.runCollect(client.events("messageDelete").pipe(Stream.take(1))),
                )
                const bulk = yield* Effect.forkScoped(
                    Stream.runCollect(client.events("messageDeleteBulk").pipe(Stream.take(1))),
                )
                yield* client.connect()
                server.dispatch("MESSAGE_UPDATE", wire("native"))
                server.dispatch("MESSAGE_DELETE", { id: "10", channel_id: "20", content: "native", author_id: "30" })
                server.dispatch("MESSAGE_DELETE_BULK", { channel_id: "20", ids: ["11", "12"] })
                expect(yield* Fiber.join(deleted)).toEqual([
                    { id: "10", channelId: "20", content: "native", authorId: "30" },
                ])
                expect(yield* Fiber.join(bulk)).toEqual([{ channelId: "20", ids: ["11", "12"] }])
                yield* Effect.promise(() => vi.waitFor(() => expect(received).toHaveLength(1)))
                yield* update.unsubscribe()
                yield* update.waitForClose()
                expect(server.requests).toBe(1)
            }),
        ).pipe(Effect.annotateLogs("fixture", "events")),
    )
})

test("REST edit/delete acknowledgements do not synthesize gateway events", async () => {
    const server = await fixture()
    const client = defaultApi()
    const update = value(client.events("messageUpdate", { maxPendingMessages: 1 }))
    const deletion = value(client.events("messageDelete", { maxPendingMessages: 1 }))
    value(await client.messages.edit({ id: "10", channelId: "20" }, { content: "REST only" }))
    value(await client.messages.delete({ id: "10", channelId: "20" }))
    value(await client.connect())
    server.dispatch("MESSAGE_UPDATE", wire("gateway only"))
    server.dispatch("MESSAGE_DELETE", { id: "11", channel_id: "20" })
    expect(value(await update.next())?.content).toBe("gateway only")
    expect(value(await deletion.next())?.id).toBe("11")
})

test("bulk batches count as one queued payload but consume their full source bytes and isolate overflow", async () => {
    const server = await fixture()
    const client = defaultApi()
    const one = value(client.events("messageDeleteBulk", { maxPendingMessages: 1 }))
    const bytes = value(client.events("messageDeleteBulk", { maxPendingBytes: 1 }))
    const other = value(client.events("messageUpdate"))
    value(await client.connect())
    const ids = Array.from({ length: 100 }, (_, index) => String(index + 1))
    server.dispatch("MESSAGE_DELETE_BULK", { channel_id: "20", ids })
    const tooLarge = await bytes.waitForClose()
    expect(tooLarge.isErr() && tooLarge.error).toMatchObject({ _tag: "EventOverflowError", limit: "bytes" })
    expect(value(await one.next())?.ids).toEqual(ids)
    server.dispatch("MESSAGE_DELETE_BULK", { channel_id: "20", ids: ["1"] })
    server.dispatch("MESSAGE_DELETE_BULK", { channel_id: "20", ids: ["2"] })
    const overflow = await one.waitForClose()
    expect(overflow.isErr() && overflow.error).toMatchObject({
        _tag: "EventOverflowError",
        limit: "messages",
        capacity: 1,
    })
    server.dispatch("MESSAGE_UPDATE", wire())
    expect(value(await other.next())?.content).toBe("changed")
    expect(client.state).toBe("Connected")
})

test("new-event handlers remain sequential by default, report the matching name and release active native work", async () => {
    const server = await fixture()
    let started = 0
    let cleaned = 0
    const reports: string[] = []
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({ token: "fixture-only-not-a-credential" })
                const failure = yield* client.on("messageDelete", () => Effect.fail("fixture private failure"), {
                    onError: (report) =>
                        Effect.sync(() => {
                            reports.push(report.event)
                            expect(JSON.stringify(report)).not.toContain("private")
                        }),
                })
                yield* client.on("messageUpdate", () =>
                    Effect.sync(() => {
                        started++
                    }).pipe(
                        Effect.andThen(Effect.never),
                        Effect.ensuring(
                            Effect.sync(() => {
                                cleaned++
                            }),
                        ),
                    ),
                )
                yield* client.connect()
                server.dispatch("MESSAGE_UPDATE", wire())
                server.dispatch("MESSAGE_UPDATE", wire())
                server.dispatch("MESSAGE_DELETE", { id: "10", channel_id: "20" })
                yield* Effect.promise(() => vi.waitFor(() => expect(reports).toEqual(["messageDelete"])))
                expect(started).toBe(1)
                yield* failure.unsubscribe()
                yield* failure.waitForClose()
                yield* client.shutdown()
                expect(cleaned).toBe(1)
            }),
        ),
    )
})

test.each([
    ["MESSAGE_UPDATE", { id: "10", channel_id: "20", content: "partial" }],
    ["MESSAGE_DELETE", { channel_id: "20" }],
    ["MESSAGE_DELETE", { id: "10", channel_id: "20", content: 42 }],
    ["MESSAGE_DELETE", { id: "10", channel_id: "20", author_id: null }],
    ["MESSAGE_DELETE_BULK", { channel_id: "20", ids: ["1", 2] }],
] as const)(
    "malformed %s closes with a typed protocol failure instead of emitting invented data",
    async (event, body) => {
        const server = await fixture()
        const client = defaultApi()
        value(await client.connect())
        server.dispatch(event, body)
        const result = await client.waitForClose()
        expect(result.isErr() && result.error).toMatchObject({ _tag: "ConnectionError", reason: "protocol" })
        expect(client.state).toBe("Closed")
    },
)
