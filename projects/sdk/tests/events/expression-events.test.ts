import { Effect, Fiber, Stream } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient } from "../../src/index.js"
import { createClient as createNative } from "../../src/effect.js"
import { sendJson } from "../support/rest-server.js"
import { startHostedLoopback } from "../support/instance.js"
import { settle } from "../support/settle.js"

vi.mock("ws", (original) => import("../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))

afterEach(() => {
    vi.unstubAllGlobals()
})

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
    const { gateway } = await startHostedLoopback({
        routes: { "GET /v1/guilds/200/emojis": (_request, response) => sendJson(response, [emoji()]) },
        gateway: { sessionId: "expression-events" },
    })
    return {
        dispatch: (event: string, body: unknown) => gateway.dispatch(event, body),
    }
}

function defaultApi(options?: Parameters<typeof createClient>[0]) {
    const client = createClient(
        options ?? {
            token: "fixture-only-not-a-credential",
            gateway: { onMalformedDispatch: "terminate" as const },
        },
    )
    onTestFinished(async () => {
        await client.shutdown()
    })
    return client
}

test("default expression subscriptions project full frozen collections without wire-only fields", async () => {
    const server = await fixture()
    const client = defaultApi()
    const emojis: unknown[] = []
    client.on("guildEmojisUpdate", (update) => {
        emojis.push(update)
    })
    const stickers = client.subscribe("guildStickersUpdate")
    await settle(client.connect())
    server.dispatch("GUILD_EMOJIS_UPDATE", { guild_id: "200", emojis: [emoji()] })
    server.dispatch("GUILD_STICKERS_UPDATE", { guild_id: "200", stickers: [sticker()] })
    await vi.waitFor(() => expect(emojis).toHaveLength(1))
    const emojiUpdate = emojis[0] as { readonly guildId: string; readonly items: readonly object[] }
    const stickerUpdate = await settle(stickers.next())
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
                    gateway: { onMalformedDispatch: "terminate" as const },
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
                    Stream.runCollect(client.subscribe("guildStickersUpdate").pipe(Stream.take(1))),
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
    client.on("guildEmojisUpdate", (update) => {
        received.push(update)
    })
    client.on("guildStickersUpdate", (update) => {
        received.push(update)
    })
    await settle(client.connect())
    server.dispatch(event, body)
    const result = await client.waitForClose()
    expect(result.isErr() && result.error).toMatchObject({ _tag: "ConnectionError", reason: "protocol" })
    expect(received).toEqual([])
})
