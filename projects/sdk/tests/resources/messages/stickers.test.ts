import { afterEach, expect, test, vi } from "vitest"
import { type EditMessageInput, type Message, type MessageInput } from "../../../src/index.js"
import { modes } from "../../support/both-apis.js"
import { driver, fixture, rejectsInput, rejectsResponse, responseEmbed, wire } from "./content-fixture.js"

vi.mock("ws", (original) => import("../../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => vi.unstubAllGlobals())

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
        await rejectsInput(api.send({ stickerIds } as MessageInput))
    await rejectsInput(api.send({ stickerIds: iteratorMaskedSticker } as MessageInput))
    await rejectsInput(api.edit({ content: "No replacement", stickerIds: ["501"] } as EditMessageInput))
    expect(server.requests).toHaveLength(before)
    for (const stickers of [null, undefined, []]) {
        server.set({ ...wire(), stickers })
        expect((await api.fetch()).stickers).toEqual([])
    }
    for (const stickers of [{}, [null], [{ id: "501", name: "x" }], [{ id: "501", name: 3, animated: false }]]) {
        server.set({ ...wire(), stickers })
        await rejectsResponse(api.fetch())
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
    await rejectsInput(api.send({ stickerIds } as MessageInput))
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
