import { once } from "node:events"
import { createServer } from "node:http"
import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { WebSocketServer } from "ws"
import {
    createClient,
    type EmbedInput,
    type MessageInput,
    type MessageReference,
    type EditMessageInput,
    type CollectorOptions,
    type Message,
    type CollectorResult,
} from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const transport = vi.hoisted(() => ({ url: "" }))
vi.mock("ws", async (original) => {
    const module = await original<typeof import("ws")>()
    return {
        ...module,
        default: class extends module.default {
            constructor(_url: string, options: import("ws").ClientOptions) {
                super(transport.url, options)
            }
        },
    }
})
afterEach(() => vi.unstubAllGlobals())
const modes = ["default", "native"] as const
const author = { id: "30", username: "fixture", bot: true }
const target = { id: "10", channelId: "20" }
const wire = (embeds: unknown = []) => ({ id: "10", channel_id: "20", content: "original", author, embeds })
const input: EmbedInput = {
    title: "Title",
    description: "Description",
    url: "https://example.com/build",
    color: 0x3d66b8,
    timestamp: "2026-09-08T14:30:00.000Z",
    author: { name: "Author", url: "https://example.com/author", iconUrl: "https://example.com/author.png" },
    footer: { text: "Footer", iconUrl: "https://example.com/footer.png" },
    image: { url: "https://example.com/image.png", description: "Image" },
    thumbnail: { url: "https://example.com/thumb.png", description: "Thumbnail" },
    fields: [
        { name: "Status", value: "Passed", inline: true },
        { name: "Details", value: "" },
    ],
}
const inputWire = {
    ...input,
    author: { name: "Author", url: "https://example.com/author", icon_url: "https://example.com/author.png" },
    footer: { text: "Footer", icon_url: "https://example.com/footer.png" },
}
const media = {
    url: "https://example.com/media",
    proxy_url: "https://example.com/proxy",
    content_type: "video/mp4",
    content_hash: "fixture-hash",
    width: 640,
    height: 480,
    description: "Media",
    placeholder: "fixture-base64",
    duration: 12,
    flags: 8,
}
const responseEmbed = {
    ...inputWire,
    type: "future-preview",
    fields: input.fields!.map((field) => ({ ...field, inline: field.inline ?? false })),
    author: { ...inputWire.author, proxy_icon_url: "https://example.com/proxy-author" },
    footer: { ...inputWire.footer, proxy_icon_url: "https://example.com/proxy-footer" },
    image: media,
    thumbnail: media,
    video: media,
    audio: media,
    provider: {
        name: "Provider",
        url: "https://example.com",
        icon_url: "https://example.com/icon",
        proxy_icon_url: "https://example.com/proxy-icon",
    },
    html: "<div>Fixture</div>",
    html_width: 640,
    html_height: 480,
    nsfw: false,
    children: [{ type: "image", image: media }],
    ignored: "not projected",
}

async function fixture() {
    let message: Record<string, any> = wire([responseEmbed])
    const requests: { method: string; body: any }[] = []
    const sockets: import("ws").WebSocket[] = []
    let sequence = 1
    const server = createServer()
    const gateway = new WebSocketServer({ server })
    gateway.on("connection", (socket) => {
        sockets.push(socket)
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
        socket.on("message", (data) => {
            const packet = JSON.parse(data.toString())
            if (packet.op === 2) socket.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "fixture" } }))
            if (packet.op === 1) socket.send(JSON.stringify({ op: 11 }))
        })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw Error("Fixture port missing")
    transport.url = `ws://127.0.0.1:${address.port}`
    const deliver = (event: string) => {
        for (const socket of sockets) socket.send(JSON.stringify({ op: 0, s: ++sequence, t: event, d: message }))
    }
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        if (url.endsWith("/gateway/bot")) return Response.json({ url: "wss://gateway.fluxer.app" })
        expect(url.startsWith("https://api.fluxer.app/v1/channels/20/messages")).toBe(true)
        const body = init.body ? JSON.parse(String(init.body)) : undefined
        requests.push({ method: init.method!, body })
        if (init.method === "POST" || init.method === "PATCH") {
            if (init.method === "PATCH" && body.embeds?.length === 0 && !body.content)
                return Response.json({}, { status: 400 })
            const base = init.method === "POST" ? wire([]) : message
            message = {
                ...base,
                ...(body.sticker_ids === undefined
                    ? {}
                    : { stickers: body.sticker_ids.map((id: string) => ({ id, name: "Fixture", animated: false })) }),
                ...(body.content === undefined ? {} : { content: body.content }),
                ...(body.embeds === undefined
                    ? {}
                    : {
                          embeds: body.embeds.map((embed: any) => ({
                              ...embed,
                              type: "rich",
                              ...(embed.fields
                                  ? {
                                        fields: embed.fields.map((field: any) => ({
                                            ...field,
                                            inline: field.inline ?? false,
                                        })),
                                    }
                                  : {}),
                              ...(embed.image ? { image: { ...embed.image, flags: 0 } } : {}),
                              ...(embed.thumbnail ? { thumbnail: { ...embed.thumbnail, flags: 0 } } : {}),
                          })),
                      }),
            }
            if (init.method === "POST" && body.content === undefined) message.content = ""
            deliver(init.method === "POST" ? "MESSAGE_CREATE" : "MESSAGE_UPDATE")
        }
        return Response.json(url.includes("?") ? [message] : message)
    })
    onTestFinished(async () => {
        sockets.forEach((socket) => socket.terminate())
        await new Promise<void>((resolve) => gateway.close(() => resolve()))
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return {
        requests,
        set: (value: Record<string, any>) => {
            message = value
        },
        deliver,
    }
}

async function driver(mode: (typeof modes)[number], maxBytes = 1_000_000) {
    const scope = Scope.makeUnsafe()
    const options = { token: "fixture-only-not-a-credential", cache: { messages: { maxBytes } } }
    const defaultApi = mode === "default" ? createClient(options)._unsafeUnwrap() : undefined
    const native =
        mode === "native" ? await Effect.runPromise(createNative(options).pipe(Scope.provide(scope))) : undefined
    onTestFinished(async () => {
        if (defaultApi) await defaultApi.shutdown()
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    const run = async <A, E>(effect: Effect.Effect<A, E>) => {
        const result = await Effect.runPromise(Effect.result(effect))
        if (result._tag === "Failure") throw result.failure
        return result.success
    }
    return {
        send: async (input: MessageInput): Promise<Message> =>
            defaultApi
                ? (await defaultApi.messages.send("20", input))._unsafeUnwrap()
                : run(native!.messages.send("20", input)),
        reply: async (input: MessageInput): Promise<Message> =>
            defaultApi
                ? (await defaultApi.messages.reply(target, input))._unsafeUnwrap()
                : run(native!.messages.reply(target, input)),
        edit: async (input: EditMessageInput): Promise<Message> =>
            defaultApi
                ? (await defaultApi.messages.edit(target, input))._unsafeUnwrap()
                : run(native!.messages.edit(target, input)),
        fetch: async (): Promise<Message> =>
            defaultApi
                ? (await defaultApi.messages.fetch(target))._unsafeUnwrap()
                : run(native!.messages.fetch(target)),
        history: async (): Promise<readonly Message[]> =>
            defaultApi
                ? (await defaultApi.messages.fetchHistory("20"))._unsafeUnwrap()
                : run(native!.messages.fetchHistory("20")),
        get: (ref: MessageReference = target) =>
            defaultApi ? Promise.resolve(defaultApi.messages.get(ref)._unsafeUnwrap()) : run(native!.messages.get(ref)),
        connect: async () => (defaultApi ? (await defaultApi.connect())._unsafeUnwrap() : run(native!.connect())),
        closed: async () => {
            if (defaultApi) {
                const result = await defaultApi.waitForClose()
                return result.isErr() ? result.error : undefined
            }
            return run(native!.waitForClose().pipe(Effect.flip))
        },
        updates: async (receive: (message: Message) => void) => {
            if (defaultApi) defaultApi.on("messageUpdate", receive)._unsafeUnwrap()
            else
                await Effect.runPromise(
                    native!
                        .on("messageUpdate", (message) => Effect.sync(() => receive(message)))
                        .pipe(Scope.provide(scope)),
                )
        },
        collect: async (options?: CollectorOptions) => {
            if (defaultApi) {
                const collector = defaultApi.messages.collect("20", options)._unsafeUnwrap()
                return async (): Promise<CollectorResult> => {
                    const r = await collector.waitForClose()
                    if (r.isErr()) throw r.error
                    return r.value
                }
            }
            const collector = await Effect.runPromise(
                native!.messages.collect("20", options).pipe(Scope.provide(scope)),
            )
            return () => run(collector.waitForClose())
        },
    }
}

test.each(modes)("%s sends stickers without text, replies and projects frozen sticker snapshots", async (mode) => {
    const server = await fixture()
    const api = await driver(mode)
    const input = { stickerIds: ["501", "502"] }
    const sent = await api.send(input)
    expect(server.requests[0]?.body.sticker_ids).toEqual(["501", "502"])
    expect(sent.content).toBe("")
    expect(sent.stickers.map((item) => item.id)).toEqual(["501", "502"])
    expect(Object.isFrozen(sent.stickers)).toBe(true)
    expect(sent.stickers.every(Object.isFrozen)).toBe(true)
    await api.reply({ stickerIds: ["502"] })
    expect(server.requests[1]?.body.message_reference.message_id).toBe("10")
    expect((await api.history())[0]?.stickers).toEqual([{ id: "502", name: "Fixture", animated: false }])
    expect((await api.get())?.stickers).toEqual([{ id: "502", name: "Fixture", animated: false }])
    expect((await api.edit({ content: "Caption" })).stickers).toEqual([{ id: "502", name: "Fixture", animated: false }])
    const iteratorStickers = ["501"]
    Object.defineProperty(iteratorStickers, Symbol.iterator, {
        value: function* () {
            yield "501"
            yield "502"
            yield "503"
            yield "504"
        },
    })
    const iteratorSent = await api.send({ stickerIds: iteratorStickers })
    expect(server.requests.at(-1)?.body.sticker_ids).toEqual(["501"])
    expect(iteratorSent.stickers.map((sticker) => sticker.id)).toEqual(["501"])
    const alternatingStickers = ["501"]
    let stickerReads = 0
    Object.defineProperty(alternatingStickers, 0, {
        get: () => (stickerReads++ === 0 ? "501" : "not-an-id"),
        enumerable: true,
    })
    const alternatingSent = await api.send({ stickerIds: alternatingStickers })
    expect(server.requests.at(-1)?.body.sticker_ids).toEqual(["501"])
    expect(alternatingSent.stickers.map((sticker) => sticker.id)).toEqual(["501"])
    expect(stickerReads).toBe(1)
    const iteratorMaskedSticker = ["not-an-id"]
    Object.defineProperty(iteratorMaskedSticker, Symbol.iterator, {
        value: function* () {
            yield "501"
        },
    })
    const before = server.requests.length
    for (const stickerIds of [[], null, Array(1), ["../501"], [501], ["1", "2", "3", "4"]])
        await expect(api.send({ stickerIds } as MessageInput)).rejects.toBeDefined()
    await expect(api.send({ stickerIds: iteratorMaskedSticker } as MessageInput)).rejects.toBeDefined()
    await expect(api.edit({ content: "No replacement", stickerIds: ["501"] } as EditMessageInput)).rejects.toBeDefined()
    expect(server.requests).toHaveLength(before)
    for (const stickers of [null, undefined, []]) {
        server.set({ ...wire(), stickers })
        expect((await api.fetch()).stickers).toEqual([])
    }
    for (const stickers of [{}, [null], [{ id: "501", name: "x" }], [{ id: "501", name: 3, animated: false }]]) {
        server.set({ ...wire(), stickers })
        await expect(api.fetch()).rejects.toBeDefined()
    }
})

test.each(modes)("%s rejects maximal sparse sticker arrays before reading indexed entries", async (mode) => {
    const server = await fixture()
    const api = await driver(mode)
    const stickerIds = new Array(2 ** 32 - 1)
    Object.defineProperty(stickerIds, 0, {
        get: () => {
            throw Error("Oversized sticker arrays must not read entries")
        },
    })
    await expect(api.send({ stickerIds } as MessageInput)).rejects.toBeDefined()
    expect(server.requests).toEqual([])
})

test.each(modes)("%s receives sticker-only gateway changes without retaining extra fields", async (mode) => {
    const server = await fixture()
    const api = await driver(mode)
    const updates: Message[] = []
    await api.updates((message) => updates.push(message))
    await api.connect()
    await api.fetch()
    server.set({
        ...wire([responseEmbed]),
        stickers: [{ id: "501", name: "Sticker", animated: true, private: "excluded" }],
    })
    server.deliver("MESSAGE_UPDATE")
    await vi.waitFor(() => expect(updates).toHaveLength(1))
    expect(updates[0]?.stickers).toEqual([{ id: "501", name: "Sticker", animated: true }])
    expect((await api.get())?.stickers).toEqual(updates[0]?.stickers)
})

test.each(modes)(
    "%s sends every embed input field, replies, preserves omissions, replaces and clears",
    async (mode) => {
        const server = await fixture()
        const api = await driver(mode)
        const sent = await api.send({ embeds: [input] })
        expect(sent.content).toBe("")
        expect(sent.embeds[0]?.author?.iconUrl).toBe(input.author?.iconUrl)
        expect(server.requests[0]?.body).toMatchObject({
            embeds: [inputWire],
            allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
        })
        expect(server.requests[0]?.body).not.toHaveProperty("content")
        await api.reply({ embeds: [input] })
        expect(server.requests[1]?.body.message_reference).toEqual({ message_id: "10", channel_id: "20", type: 0 })
        const preserved = await api.edit({ content: "Updated text" })
        expect(preserved.embeds).toEqual(sent.embeds)
        expect(server.requests[2]?.body).not.toHaveProperty("embeds")
        const replacement = await api.edit({ embeds: [{ title: "Replacement" }] })
        expect(replacement.content).toBe("Updated text")
        expect(replacement.embeds).toEqual([{ type: "rich", title: "Replacement" }])
        expect(server.requests[3]?.body).not.toHaveProperty("content")
        expect((await api.edit({ content: "", embeds: [{ title: "Embed only" }] })).content).toBe("")
        await expect(api.edit({ embeds: [] })).rejects.toBeDefined()
        expect((await api.edit({ content: "Plain text", embeds: [] })).embeds).toEqual([])
        expect(server.requests.map((r) => r.method)).not.toContain("GET")
    },
)

test.each(modes)("%s reads direct embed fields only from indexed array entries", async (mode) => {
    const server = await fixture()
    const api = await driver(mode)
    const fields = [{ name: "Indexed", value: "field" }]
    Object.defineProperty(fields, Symbol.iterator, {
        value: function* () {
            for (let index = 0; index < 26; index++) yield { name: `Iterator ${index}`, value: "field" }
        },
    })
    const input = { embeds: [{ fields }] }
    await api.send(input)
    await api.reply(input)
    await api.edit(input)
    expect(server.requests.map((request) => request.body.embeds?.[0]?.fields)).toEqual([
        [{ name: "Indexed", value: "field" }],
        [{ name: "Indexed", value: "field" }],
        [{ name: "Indexed", value: "field" }],
    ])
    const iteratorMaskedField = [{ name: "Indexed", value: 1 }]
    Object.defineProperty(iteratorMaskedField, Symbol.iterator, {
        value: function* () {
            yield { name: "Indexed", value: "field" }
        },
    })
    const before = server.requests.length
    await expect(
        api.send({ embeds: [{ fields: iteratorMaskedField }] } as unknown as MessageInput),
    ).rejects.toBeDefined()
    expect(server.requests).toHaveLength(before)
})

test.each(modes)("%s preserves valid leap-day offset and 24:00 embed timestamps", async (mode) => {
    const server = await fixture()
    const api = await driver(mode)
    const timestamp = "2024-02-29T24:00:00+14:00"
    await api.send({ embeds: [{ timestamp }] })
    expect(server.requests[0]?.body.embeds?.[0]?.timestamp).toBe(timestamp)
})

test.each(modes)(
    "%s projects received-only metadata through fetch/history/cache and freezes every nested object",
    async (mode) => {
        await fixture()
        const api = await driver(mode)
        const fetched = await api.fetch()
        const embed = fetched.embeds[0]!
        expect(embed).toMatchObject({
            type: "future-preview",
            author: { proxyIconUrl: "https://example.com/proxy-author" },
            footer: { proxyIconUrl: "https://example.com/proxy-footer" },
            provider: { name: "Provider", proxyIconUrl: "https://example.com/proxy-icon" },
            html: "<div>Fixture</div>",
            htmlWidth: 640,
            htmlHeight: 480,
            nsfw: false,
            children: [{ type: "image" }],
        })
        const mappedMedia = {
            url: media.url,
            proxyUrl: media.proxy_url,
            contentType: media.content_type,
            contentHash: media.content_hash,
            width: 640,
            height: 480,
            description: "Media",
            placeholder: "fixture-base64",
            duration: 12,
            flags: 8,
        }
        for (const item of [embed.image, embed.thumbnail, embed.video, embed.audio, embed.children?.[0]?.image])
            expect(item).toEqual(mappedMedia)
        expect(embed).not.toHaveProperty("ignored")
        const frozen = (value: unknown) => {
            if (value && typeof value === "object") {
                expect(Object.isFrozen(value)).toBe(true)
                Object.values(value).forEach(frozen)
            }
        }
        frozen(fetched)
        expect(await api.get()).toEqual(fetched)
        expect(await api.history()).toEqual([fetched])
    },
)

test.each(modes)(
    "%s normalizes optional nulls without fabricating metadata and rejects malformed responses",
    async (mode) => {
        const server = await fixture()
        const api = await driver(mode)
        for (const absent of [undefined, null, []]) {
            server.set(wire(absent))
            expect((await api.fetch()).embeds).toEqual([])
        }
        server.set(wire([{ type: "rich", title: null, fields: null, author: { name: "Author", icon_url: null } }]))
        expect((await api.fetch()).embeds).toEqual([{ type: "rich", author: { name: "Author" } }])
        for (const bad of [
            "bad",
            [{}],
            [{ type: 1 }],
            [{ type: "rich", image: { url: "x" } }],
            [{ type: "rich", fields: [{ name: "n", value: "v", inline: 1 }] }],
            [{ type: "rich", children: [{ type: "x" }, { type: "y" }] }],
            [{ type: "rich", video: { url: "x", flags: 0, width: -1 } }],
            [{ type: "rich", timestamp: "yesterday" }],
            [{ type: "rich", timestamp: "2025-02-29T00:00:00.000Z" }],
        ]) {
            server.set(wire(bad))
            await expect(api.fetch()).rejects.toBeDefined()
            await expect(api.history()).rejects.toBeDefined()
        }
    },
)

test.each(modes)("%s rejects invalid input before dispatch without exposing private embed contents", async (mode) => {
    const server = await fixture()
    const api = await driver(mode)
    const invalid = [
        { type: "rich" },
        { title: null },
        { title: "x".repeat(257) },
        { color: -1 },
        { color: 0x1000000 },
        { color: 0.5 },
        { timestamp: "yesterday" },
        { timestamp: "2025-02-29T00:00:00.000Z" },
        { url: "javascript:alert(1)" },
        { image: { url: "attachment://file.png" } },
        { author: { name: "" } },
        { footer: { text: "x", unknown: true } },
        { image: {} },
        { fields: [{ name: "n" }] },
        { fields: [{ name: "n", value: "v", inline: null }] },
        { fields: Array.from({ length: 26 }, () => ({ name: "n", value: "v" })) },
    ]
    for (const embed of invalid) {
        const body = { embeds: [{ description: "private-fixture-sentinel", ...embed }] } as { embeds: EmbedInput[] }
        for (const operation of [() => api.send(body), () => api.reply(body), () => api.edit(body)]) {
            const error = await operation().then(
                () => undefined,
                (error) => error,
            )
            expect(error).toBeDefined()
            expect(String(error)).not.toContain("private-fixture-sentinel")
        }
    }
    for (const body of [{}, { embeds: null }, { embeds: [] }, { content: "", embeds: [] }])
        await expect(api.send(body as MessageInput)).rejects.toBeDefined()
    expect(server.requests).toEqual([])
    await api.send({ embeds: Array.from({ length: 11 }, () => ({ title: "Instance-owned count limit" })) })
    expect(server.requests).toHaveLength(1)
})

test.each(modes)(
    "%s gateway collectors retain the original embed snapshot after edit and cache replacement",
    async (mode) => {
        await fixture()
        const api = await driver(mode)
        await api.connect()
        const wait = await api.collect({ filter: (message) => message.embeds[0]?.title === "Original" })
        const sent = await api.send({ embeds: [{ title: "Original", fields: [{ name: "n", value: "v" }] }] })
        const collected = await wait()
        expect(collected.messages[0]).toEqual(sent)
        await api.edit({ embeds: [{ title: "Edited" }] })
        await vi.waitFor(async () => expect((await api.get())?.embeds[0]?.title).toBe("Edited"))
        expect(collected.messages[0]?.embeds[0]?.title).toBe("Original")
        expect(Object.isFrozen(collected.messages[0]?.embeds[0]?.fields?.[0])).toBe(true)
    },
)

test.each(modes)("%s counts embed bytes in cache and collector retention", async (mode) => {
    const server = await fixture()
    const api = await driver(mode, 250)
    await api.connect()
    const wait = await api.collect({ maxBytes: 250 })
    const outcome = wait().catch((error) => error)
    server.set(wire([{ type: "rich", description: "x".repeat(500) }]))
    server.deliver("MESSAGE_CREATE")
    expect(await outcome).toMatchObject({ _tag: "CollectorError", reason: "overflow" })
    await api.fetch()
    expect(await api.get()).toBeUndefined()
})

test.each(modes)("%s rejects malformed embed updates through the existing protocol failure boundary", async (mode) => {
    const server = await fixture()
    const api = await driver(mode)
    const received: Message[] = []
    await api.updates((message) => received.push(message))
    await api.connect()
    const original = await api.fetch()
    server.set(wire([{ type: "rich", fields: "invalid" }]))
    server.deliver("MESSAGE_UPDATE")
    expect(await api.closed()).toMatchObject({ _tag: "ConnectionError", reason: "protocol" })
    expect(received).toEqual([])
    expect(original.embeds[0]?.type).toBe("future-preview")
})
