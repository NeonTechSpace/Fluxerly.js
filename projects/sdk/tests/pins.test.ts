import { once } from "node:events"
import { Effect, Exit, Scope, Stream } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { WebSocketServer } from "ws"
import {
    createClient,
    type EventName,
    type MessagePinsQuery,
    type MessageReference,
    type DefaultMessageOperationOptions,
} from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"

const transport = vi.hoisted(() => ({ url: "", sockets: [] as import("ws").WebSocket[] }))
vi.mock("ws", async (original) => {
    const module = await original<typeof import("ws")>()
    return {
        ...module,
        default: class extends module.default {
            constructor(_url: string, options: import("ws").ClientOptions) {
                super(transport.url, options)
                transport.sockets.push(this)
            }
        },
    }
})
afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    transport.sockets = []
})
const modes = ["default", "native"] as const
const target = { id: "10", channelId: "20" }
const wire = (id = "10", pinned?: boolean) => ({
    id,
    channel_id: "20",
    content: "fixture",
    author: { id: "30", username: "fixture" },
    ...(pinned === undefined ? {} : { pinned }),
})
const pin = (id = "10", time = "2026-09-08T12:00:00.000Z") => ({ message: wire(id, true), pinned_at: time })
function rest(handler: (url: string, init: RequestInit) => Promise<Response>) {
    vi.stubGlobal("fetch", (url: string, init: RequestInit) =>
        url.endsWith("/gateway/bot")
            ? Promise.resolve(Response.json({ url: "wss://gateway.fluxer.app" }))
            : handler(url, init),
    )
}
async function fixture(mode: (typeof modes)[number]) {
    const scope = Scope.makeUnsafe()
    const unwrap = <A, E>(r: { isErr(): boolean; value?: A; error?: E }): A => {
        if (r.isErr()) throw r.error
        return r.value!
    }
    const run = async <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal) => {
        const r = await Effect.runPromise(Effect.result(effect), signal ? { signal } : undefined)
        if (r._tag === "Failure") throw r.failure
        return r.success
    }
    const defaultApi =
        mode === "default" ? unwrap(createClient({ token: "fixture", cache: { messages: true } })) : undefined
    const native =
        mode === "native"
            ? await run(createNative({ token: "fixture", cache: { messages: true } }).pipe(Scope.provide(scope)))
            : undefined
    const close = async () => {
        if (defaultApi) unwrap(await defaultApi.shutdown())
        else await run(native!.shutdown())
    }
    onTestFinished(async () => {
        await close()
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return {
        defaultApi,
        native,
        close,
        connect: async () => (defaultApi ? unwrap(await defaultApi.connect()) : run(native!.connect())),
        state: () => (defaultApi ?? native)!.state,
        fetch: async (message = target) =>
            defaultApi ? unwrap(await defaultApi.messages.fetch(message)) : run(native!.messages.fetch(message)),
        get: async (message = target) =>
            defaultApi ? unwrap(defaultApi.messages.get(message)) : run(native!.messages.get(message)),
        mutate: async (
            operation: "pin" | "unpin",
            message: MessageReference = target,
            options?: DefaultMessageOperationOptions,
        ) =>
            defaultApi
                ? unwrap(await defaultApi.messages[operation](message, options))
                : run(native!.messages[operation](message, options), options?.signal as AbortSignal | undefined),
        pins: async (query?: MessagePinsQuery, channel = "20", options?: DefaultMessageOperationOptions) =>
            defaultApi
                ? unwrap(await defaultApi.messages.fetchPins(channel, query, options))
                : run(native!.messages.fetchPins(channel, query, options), options?.signal as AbortSignal | undefined),
        on: async (event: EventName, handler: (value: any) => void, maxPendingBytes?: number) => {
            if (defaultApi)
                return unwrap(
                    defaultApi.on(event, handler, maxPendingBytes === undefined ? undefined : { maxPendingBytes }),
                )
            const subscription = await run(
                native!
                    .on(
                        event,
                        (value) => Effect.sync(() => handler(value)),
                        maxPendingBytes === undefined ? undefined : { maxPendingBytes },
                    )
                    .pipe(Scope.provide(scope)),
            )
            return { waitForClose: () => run(subscription.waitForClose()) }
        },
        readOne: async () => {
            if (defaultApi) {
                const source = unwrap(defaultApi.events("channelPinsUpdate"))
                try {
                    return unwrap(await source.next())
                } finally {
                    source.unsubscribe()
                }
            }
            return (await run(Stream.runCollect(native!.events("channelPinsUpdate").pipe(Stream.take(1)))))[0]
        },
        closed: async () => (defaultApi ? unwrap(await defaultApi.waitForClose()) : run(native!.waitForClose())),
    }
}
async function gateway() {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" })
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw Error("Missing fixture port")
    transport.url = `ws://127.0.0.1:${address.port}`
    let seq = 0
    server.on("connection", (socket) => {
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 600_000 } }))
        socket.on("message", (data) => {
            const frame = JSON.parse(data.toString())
            if (frame.op === 1) socket.send(JSON.stringify({ op: 11 }))
            if (frame.op === 2 || frame.op === 6)
                socket.send(
                    JSON.stringify({
                        op: 0,
                        s: ++seq,
                        t: frame.op === 2 ? "READY" : "RESUMED",
                        d: { session_id: "fixture" },
                    }),
                )
        })
    })
    onTestFinished(async () => {
        for (const socket of server.clients) socket.terminate()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return (event: string, body: unknown, synchronous = false) => {
        if (synchronous) {
            transport.sockets
                .at(-1)!
                .emit("message", Buffer.from(JSON.stringify({ op: 0, s: ++seq, t: event, d: body })), false)
            return
        }
        for (const socket of server.clients) socket.send(JSON.stringify({ op: 0, s: ++seq, t: event, d: body }))
    }
}

test.each(modes)(
    "%s pins and unpins exact targets without implicit connection or optimistic cache state",
    async (mode) => {
        const calls: [string, string][] = []
        rest(async (url, init) => {
            if (init.method === "GET") return Response.json(wire(url.endsWith("/11") ? "11" : "10", false))
            calls.push([init.method!, url])
            expect(init.body).toBeUndefined()
            return new Response(null, { status: 204 })
        })
        const api = await fixture(mode)
        const other = await api.fetch({ ...target, id: "11" })
        for (const op of ["pin", "unpin"] as const) {
            expect((await api.fetch()).pinned).toBe(false)
            await api.mutate(op)
            expect(await api.get()).toBeUndefined()
            expect(await api.get({ ...target, id: "11" })).toBe(other)
        }
        expect(calls).toEqual([
            ["PUT", "https://api.fluxer.app/v1/channels/20/pins/10"],
            ["DELETE", "https://api.fluxer.app/v1/channels/20/pins/10"],
        ])
        expect(api.state()).not.toBe("Connected")
    },
)

test.each(modes)("%s lists explicit frozen timestamp pages without traversal or cache population", async (mode) => {
    const calls: string[] = []
    rest(async (url) => {
        calls.push(url)
        return Response.json(
            calls.length === 1
                ? { items: [pin("10"), pin("11")], has_more: true }
                : { items: [pin("11")], has_more: false },
        )
    })
    const api = await fixture(mode)
    const page = await api.pins({ limit: 2 })
    expect(calls).toHaveLength(1)
    expect(page.items.map((p) => p.message.id)).toEqual(["10", "11"])
    expect(page.nextBefore).toBe(page.items[1]!.pinnedAt)
    expect(page.hasMore).toBe(true)
    expect(
        Object.isFrozen(page) &&
            Object.isFrozen(page.items) &&
            page.items.every(
                (p) => Object.isFrozen(p) && Object.isFrozen(p.message) && Object.isFrozen(p.message.author),
            ),
    ).toBe(true)
    const next = await api.pins({ before: page.nextBefore! })
    expect(next.items[0]!.message.id).toBe("11")
    expect(next.nextBefore).toBeNull()
    expect(calls[1]).toBe(
        "https://api.fluxer.app/v1/channels/20/messages/pins?limit=50&before=2026-09-08T12%3A00%3A00.000Z",
    )
    expect(await api.get()).toBeUndefined()
})

test.each(modes)("%s rejects invalid pin inputs and malformed pages without partial results", async (mode) => {
    let calls = 0,
        body: unknown = { items: [], has_more: false }
    rest(async () => {
        calls++
        return Response.json(body)
    })
    const api = await fixture(mode)
    for (const query of [
        null,
        { limit: 0 },
        { limit: 51 },
        { limit: 1.5 },
        { after: "10" },
        { before: "10" },
        { before: "2026-09-08" },
    ])
        await expect(api.pins(query as any)).rejects.toMatchObject({
            operation: "fetchPins",
            reason: "input",
            outcome: "notDispatched",
        })
    await expect(api.pins({}, "bad")).rejects.toMatchObject({ reason: "input" })
    for (const operation of ["pin", "unpin"] as const)
        for (const message of [null, {}, { id: "10/11", channelId: "20" }, { id: "10", channelId: "020" }])
            await expect(api.mutate(operation, message as MessageReference)).rejects.toMatchObject({
                operation,
                reason: "input",
            })
    expect(calls).toBe(0)
    for (const invalid of [
        null,
        [],
        { items: [], has_more: true },
        { items: [], has_more: "false" },
        { items: [pin(), pin()], has_more: false },
        { items: [pin("10"), pin("11", "2026-09-09T00:00:00Z")], has_more: false },
        { items: [pin("10", "invalid")], has_more: false },
        { items: [{ ...pin(), message: { ...wire(), channel_id: "21" } }], has_more: false },
        { items: [{ ...pin(), message: wire("10", false) }], has_more: false },
        { items: [{ ...pin(), message: { ...wire(), pinned: "true" } }], has_more: false },
    ]) {
        body = invalid
        await expect(api.pins({ limit: 2 })).rejects.toMatchObject({
            operation: "fetchPins",
            reason: "response",
            status: 200,
        })
    }
    body = { items: [pin()], has_more: false }
    await expect(api.pins({ before: "2026-09-07T00:00:00Z" })).rejects.toMatchObject({
        operation: "fetchPins",
        reason: "response",
    })
    body = { items: [], has_more: false }
    expect(await api.pins()).toEqual({ items: [], hasMore: false, nextBefore: null })
    await api.close()
    await expect(api.pins()).rejects.toMatchObject({ _tag: "ClientClosedError" })
    await expect(api.mutate("pin")).rejects.toMatchObject({ _tag: "ClientClosedError" })
})

test.each(modes)(
    "%s classifies pin failures, preserves rejected cache entries and evicts uncertain changes",
    async (mode) => {
        let status = 204,
            calls = 0
        rest(async (_url, init) =>
            init.method === "GET" ? Response.json(wire()) : (calls++, new Response(null, { status })),
        )
        const api = await fixture(mode)
        for (const operation of ["pin", "unpin"] as const) {
            for (const [code, reason, outcome] of [
                [403, "rejected", "rejected"],
                [404, "notFound", "rejected"],
                [500, "rejected", "unknown"],
                [200, "response", "unknown"],
            ] as const) {
                const cached = await api.fetch()
                status = code
                await expect(api.mutate(operation)).rejects.toMatchObject({ operation, reason, outcome, status })
                expect(await api.get()).toBe(outcome === "unknown" ? undefined : cached)
            }
        }
        expect(calls).toBe(8)
        for (const code of [403, 404, 500, 204]) {
            rest(async () => new Response(null, { status: code }))
            await expect(api.pins()).rejects.toMatchObject({ operation: "fetchPins", status: code })
        }
    },
)

test.each(modes)("%s pin mutations prevent older in-flight reads from repopulating cached pin state", async (mode) => {
    let respond!: (value: Response) => void
    rest((_, init) =>
        init.method === "GET"
            ? new Promise((resolve) => {
                  respond = resolve
              })
            : Promise.resolve(new Response(null, { status: 204 })),
    )
    const api = await fixture(mode)
    const old = api.fetch()
    await vi.waitFor(() => expect(respond).toBeTypeOf("function"))
    await api.mutate("pin")
    respond(Response.json(wire("10", false)))
    expect((await old).pinned).toBe(false)
    expect(await api.get()).toBeUndefined()
})

test.each(modes)("%s shares the pin rate bucket and awaits cancelled and closed requests", async (mode) => {
    const api = await fixture(mode)
    let calls = 0
    rest(async () =>
        ++calls === 1 ? Response.json({ retry_after: 0.01 }, { status: 429 }) : new Response(null, { status: 204 }),
    )
    await api.mutate("pin")
    expect(calls).toBe(2)
    rest(async () => {
        calls++
        return Response.json({ retry_after: 60 }, { status: 429 })
    })
    await expect(api.mutate("unpin", target, { timeoutMs: 10 })).rejects.toMatchObject({ reason: "rateLimit" })
    const before = calls
    await expect(api.pins({}, "20", { timeoutMs: 10 })).rejects.toMatchObject({
        reason: "timeout",
        outcome: "notDispatched",
    })
    expect(calls).toBe(before)
    // Use a fresh owner without the prior rate window
    const fresh = await fixture(mode)
    let active = 0
    rest(
        (_, init) =>
            new Promise((_resolve, reject) => {
                active++
                init.signal!.addEventListener(
                    "abort",
                    () => {
                        active--
                        reject(Error("private"))
                    },
                    { once: true },
                )
            }),
    )
    for (const operation of ["pin", "unpin", "fetchPins"] as const) {
        const controller = new AbortController()
        const pending = (
            operation === "fetchPins"
                ? fresh.pins({}, "20", { signal: controller.signal })
                : fresh.mutate(operation, target, { signal: controller.signal })
        ).catch(() => "cancelled")
        await vi.waitFor(() => expect(active).toBe(1))
        controller.abort()
        expect(await pending).toBe("cancelled")
        expect(active).toBe(0)
    }
    const pending = fresh.pins().catch((e) => e)
    await vi.waitFor(() => expect(active).toBe(1))
    await fresh.close()
    expect(await pending).toMatchObject({ _tag: "ClientClosedError" })
    expect(active).toBe(0)
})

test.each(modes)(
    "%s exposes frozen pin notifications and received pin state without guessing missing values",
    async (mode) => {
        const dispatch = await gateway()
        rest(async () => Response.json(wire()))
        const api = await fixture(mode)
        await api.connect()
        const received: any[] = []
        await api.on("channelPinsUpdate", (value) => received.push(value))
        const updated: any[] = []
        await api.on("messageUpdate", (value) => updated.push(value))
        const read = api.readOne()
        dispatch("CHANNEL_PINS_UPDATE", { channel_id: "20", last_pin_timestamp: null, private: "discard" })
        expect(await read).toEqual({ channelId: "20", lastPinTimestamp: null })
        const stamp = "2026-09-08T12:00:00.000Z"
        dispatch("CHANNEL_PINS_UPDATE", { channel_id: "20", last_pin_timestamp: stamp })
        dispatch("MESSAGE_UPDATE", wire("10", true))
        await vi.waitFor(() => expect(updated).toHaveLength(1))
        expect(updated[0].pinned).toBe(true)
        expect((await api.get())?.pinned).toBe(true)
        expect(received).toEqual([
            { channelId: "20", lastPinTimestamp: null },
            { channelId: "20", lastPinTimestamp: stamp },
        ])
        expect(received.every(Object.isFrozen)).toBe(true)
        dispatch("MESSAGE_UPDATE", wire("10", false))
        await vi.waitFor(() => expect(updated).toHaveLength(2))
        expect((await api.get())?.pinned).toBe(false)
        expect(await api.fetch()).not.toHaveProperty("pinned")
    },
)

test.each(modes)("%s pin event overflow is subscription-local and subscriptions survive resume", async (mode) => {
    const dispatch = await gateway()
    rest(async () => Response.json(wire()))
    const api = await fixture(mode)
    await api.connect()
    const tiny = await api.on("channelPinsUpdate", () => {}, 1)
    const closed = Promise.resolve(tiny.waitForClose()).catch((e) => e)
    const received: any[] = []
    await api.on("channelPinsUpdate", (value) => received.push(value))
    dispatch("CHANNEL_PINS_UPDATE", { channel_id: "20", last_pin_timestamp: null }, true)
    dispatch("CHANNEL_PINS_UPDATE", { channel_id: "20", last_pin_timestamp: null }, true)
    const outcome = await closed
    if (mode === "default") expect(outcome.error).toMatchObject({ _tag: "EventOverflowError", limit: "bytes" })
    else expect(outcome).toMatchObject({ _tag: "EventOverflowError", limit: "bytes" })
    expect(api.state()).toBe("Connected")
    vi.spyOn(Math, "random").mockReturnValue(0)
    transport.sockets.at(-1)!.close(4000)
    await vi.waitFor(() => expect(transport.sockets).toHaveLength(2))
    await vi.waitFor(() => expect(api.state()).toBe("Connected"))
    dispatch("CHANNEL_PINS_UPDATE", { channel_id: "20", last_pin_timestamp: null })
    await vi.waitFor(() => expect(received).toHaveLength(3))
})

test.each(modes)("%s malformed pin notifications fail protocol validation without partial delivery", async (mode) => {
    const dispatch = await gateway()
    rest(async () => Response.json(wire()))
    const api = await fixture(mode)
    await api.connect()
    const handler = vi.fn()
    await api.on("channelPinsUpdate", handler)
    dispatch("CHANNEL_PINS_UPDATE", { channel_id: "20", last_pin_timestamp: 1 })
    await expect(api.closed()).rejects.toMatchObject({ reason: "protocol" })
    expect(handler).not.toHaveBeenCalled()
})
