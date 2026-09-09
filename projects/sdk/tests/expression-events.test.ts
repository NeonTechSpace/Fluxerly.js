import { createServer } from "node:http"
import { once } from "node:events"
import { Effect, Fiber, Stream } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { WebSocketServer } from "ws"
import { createClient } from "../src/index.js"
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

const emoji = (id = "100") => ({
    id,
    name: "Fixture",
    animated: false,
    user: { id: "900", private: "excluded" },
    image: "private-image-data",
})
const sticker = (id = "101") => ({
    ...emoji(id),
    description: "Fixture sticker",
    tags: ["fixture"],
})

async function fixture() {
    const sockets: import("ws").WebSocket[] = []
    let sequence = 1
    const server = createServer((request, response) => {
        if (request.url?.endsWith("/gateway/bot")) {
            response.end(JSON.stringify({ url: "wss://gateway.fluxer.app" }))
            return
        }
        if (request.url?.endsWith("/guilds/200/emojis")) {
            response.end(JSON.stringify([emoji()]))
            return
        }
        response.writeHead(404).end()
    })
    const gateway = new WebSocketServer({ server })
    gateway.on("connection", (socket) => {
        sockets.push(socket)
        socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }))
        socket.on("message", (data) => {
            const packet = JSON.parse(data.toString())
            if (packet.op === 2)
                socket.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "expression-events" } }))
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
        dispatch(event: string, body: unknown) {
            for (const socket of sockets) socket.send(JSON.stringify({ op: 0, s: ++sequence, t: event, d: body }))
        },
    }
}

function value<A, E>(result: { isErr(): boolean; value?: A; error?: E }): A {
    if (result.isErr()) throw result.error
    return result.value!
}

function defaultApi(options?: Parameters<typeof createClient>[0]) {
    const client = value(createClient(options ?? { token: "fixture-only-not-a-credential" }))
    onTestFinished(async () => {
        await client.shutdown()
    })
    return client
}

test("default expression subscriptions project full frozen collections without wire-only fields", async () => {
    const server = await fixture()
    const client = defaultApi()
    const emojis: unknown[] = []
    value(
        client.on("guildEmojisUpdate", (update) => {
            emojis.push(update)
        }),
    )
    const stickers = value(client.events("guildStickersUpdate"))
    value(await client.connect())
    server.dispatch("GUILD_EMOJIS_UPDATE", { guild_id: "200", emojis: [emoji()] })
    server.dispatch("GUILD_STICKERS_UPDATE", { guild_id: "200", stickers: [sticker()] })
    await vi.waitFor(() => expect(emojis).toHaveLength(1))
    const emojiUpdate = emojis[0] as { readonly guildId: string; readonly items: readonly object[] }
    const stickerUpdate = value(await stickers.next())
    expect(emojiUpdate).toEqual({
        guildId: "200",
        items: [{ guildId: "200", id: "100", name: "Fixture", animated: false }],
    })
    expect(stickerUpdate).toEqual({
        guildId: "200",
        items: [
            {
                guildId: "200",
                id: "101",
                name: "Fixture",
                animated: false,
                description: "Fixture sticker",
                tags: ["fixture"],
            },
        ],
    })
    expect(
        Object.isFrozen(emojiUpdate) &&
            Object.isFrozen(emojiUpdate.items) &&
            Object.isFrozen(emojiUpdate.items[0]!) &&
            Object.isFrozen(stickerUpdate!.items) &&
            Object.isFrozen(stickerUpdate!.items[0]!.tags),
    ).toBe(true)
    expect(JSON.stringify([emojiUpdate, stickerUpdate])).not.toContain("private")
    expect(JSON.stringify([emojiUpdate, stickerUpdate])).not.toContain("image")
})

test("native expression subscriptions invalidate an enabled cache before handler delivery without hydrating it", async () => {
    const server = await fixture()
    await Effect.runPromise(
        Effect.scoped(
            Effect.gen(function* () {
                const client = yield* createNative({
                    token: "fixture-only-not-a-credential",
                    cache: { emojis: true },
                })
                const target = { guildId: "200", id: "100" }
                yield* client.emojis.fetchAll("200")
                expect(yield* client.emojis.get(target)).toMatchObject({ id: "100" })
                let cachedAtDelivery: unknown = "not called"
                yield* client.on("guildEmojisUpdate", () =>
                    client.emojis.get(target).pipe(
                        Effect.tap((entry) =>
                            Effect.sync(() => {
                                cachedAtDelivery = entry
                            }),
                        ),
                    ),
                )
                const stickers = yield* Effect.forkScoped(
                    Stream.runCollect(client.events("guildStickersUpdate").pipe(Stream.take(1))),
                )
                yield* client.connect()
                server.dispatch("GUILD_EMOJIS_UPDATE", { guild_id: "200", emojis: [emoji("102")] })
                server.dispatch("GUILD_STICKERS_UPDATE", { guild_id: "200", stickers: [sticker()] })
                yield* Effect.promise(() => vi.waitFor(() => expect(cachedAtDelivery).toBeUndefined()))
                expect(yield* Fiber.join(stickers)).toEqual([
                    {
                        guildId: "200",
                        items: [
                            {
                                guildId: "200",
                                id: "101",
                                name: "Fixture",
                                animated: false,
                                description: "Fixture sticker",
                                tags: ["fixture"],
                            },
                        ],
                    },
                ])
                expect(yield* client.emojis.get({ guildId: "200", id: "102" })).toBeUndefined()
            }),
        ),
    )
})

test.each([
    ["GUILD_EMOJIS_UPDATE", { guild_id: "200", emojis: "not an array" }],
    ["GUILD_EMOJIS_UPDATE", { guild_id: "200", emojis: [emoji(), emoji()] }],
    ["GUILD_STICKERS_UPDATE", { guild_id: 200, stickers: [] }],
    ["GUILD_STICKERS_UPDATE", { guild_id: "200", stickers: [{ ...sticker(), tags: ["fixture", 3] }] }],
] as const)("malformed %s closes the connection without inventing an expression update", async (event, body) => {
    const server = await fixture()
    const client = defaultApi()
    const received: unknown[] = []
    value(
        client.on("guildEmojisUpdate", (update) => {
            received.push(update)
        }),
    )
    value(
        client.on("guildStickersUpdate", (update) => {
            received.push(update)
        }),
    )
    value(await client.connect())
    server.dispatch(event, body)
    const result = await client.waitForClose()
    expect(result.isErr() && result.error).toMatchObject({ _tag: "ConnectionError", reason: "protocol" })
    expect(received).toEqual([])
})
