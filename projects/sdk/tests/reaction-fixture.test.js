import { expect, test } from "vitest"
import { crc32, inflateSync } from "node:zlib"
import { createReactionEmoji, cleanupReactionEmoji, reactionEmojiImage } from "./live/reaction-fixture.mjs"

test("the live emoji fixture contains a complete decodable one-pixel PNG", () => {
    expect(reactionEmojiImage.startsWith("data:image/png;base64,")).toBe(true)
    const bytes = Buffer.from(reactionEmojiImage.split(",")[1], "base64")
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
    const chunks = []
    let offset = 8
    while (offset < bytes.length) {
        const length = bytes.readUInt32BE(offset)
        const end = offset + 8 + length
        expect(end + 4).toBeLessThanOrEqual(bytes.length)
        expect(crc32(bytes.subarray(offset + 4, end))).toBe(bytes.readUInt32BE(end))
        chunks.push({ type: bytes.toString("ascii", offset + 4, offset + 8), data: bytes.subarray(offset + 8, end) })
        offset = end + 4
    }
    expect(offset).toBe(bytes.length)
    expect(chunks.map((chunk) => chunk.type)).toEqual(["IHDR", "IDAT", "IEND"])
    expect(chunks[0].data.toString("hex")).toBe("00000001000000010806000000")
    expect(inflateSync(chunks[1].data)).toEqual(Buffer.from([0, 32, 96, 240, 255]))
    expect(chunks[2].data.length).toBe(0)
})

test("confirmed validation rejection can be cleaned up but a transport failure retains unresolved intent", async () => {
    for (const error of [Object.assign(new Error(), { status: 400, code: "INVALID_FORM_BODY" }), new Error()]) {
        const journal = { guildId: "20" }
        const saved = []
        let creates = 0
        const api = async (method) => {
            if (method === "POST") {
                creates++
                throw error
            }
            expect(method).toBe("GET")
            return { status: 200, data: [] }
        }
        await expect(createReactionEmoji(api, journal, () => saved.push({ ...journal }), "30")).rejects.toBe(error)
        expect(creates).toBe(1)
        if (error.status === 400) {
            expect(saved[1].emojiCreateRejected).toBe(true)
            await cleanupReactionEmoji(api, journal, () => saved.push({ ...journal }))
        } else {
            expect(saved).toHaveLength(1)
            expect(journal.emojiCreateRejected).toBeUndefined()
            await expect(cleanupReactionEmoji(api, journal, () => saved.push({ ...journal }))).rejects.toBeDefined()
        }
    }
})

test("emoji intent precedes creation and cleanup verifies marker, uploader and absence", async () => {
    const journal = { guildId: "20" }
    const saved = []
    let items = []
    const api = async (method, path, body) => {
        expect(path.startsWith("/guilds/20/emojis")).toBe(true)
        if (method === "POST") {
            expect(saved).toHaveLength(1)
            expect(saved[0].emojiName).toBe(body.name)
            expect(body.name).toMatch(/^[a-zA-Z0-9_]{2,32}$/)
            items = [{ id: "45", name: body.name, user: { id: "30" } }]
            return { status: 200, data: items[0] }
        }
        if (method === "DELETE") {
            expect(path).toBe("/guilds/20/emojis/45")
            items = []
        }
        return { status: 200, data: items }
    }
    const emoji = await createReactionEmoji(api, journal, () => saved.push({ ...journal }), "30")
    expect(emoji.id).toBe("45")
    expect(saved[1].emojiId).toBe("45")
    await cleanupReactionEmoji(api, journal, () => saved.push({ ...journal }))
    expect(items).toEqual([])
    await cleanupReactionEmoji(api, journal, () => saved.push({ ...journal }))
})

test("lost create responses reconcile a unique marker but unresolved absence and ownership conflicts fail closed", async () => {
    const journal = { guildId: "20", emojiName: `fluxerly_${"a".repeat(24)}`, emojiOwnerId: "30" }
    let items = [{ id: "45", name: journal.emojiName, user: { id: "31" } }]
    let deletes = 0
    const api = async (method) => {
        if (method === "DELETE") {
            deletes++
            items = []
        }
        return { status: 200, data: items }
    }
    await expect(cleanupReactionEmoji(api, journal, () => undefined)).rejects.toBeDefined()
    expect(deletes).toBe(0)
    items = []
    await expect(cleanupReactionEmoji(api, journal, () => undefined)).rejects.toBeDefined()
    expect(deletes).toBe(0)
    items = [{ id: "45", name: journal.emojiName, user: { id: "30" } }]
    await cleanupReactionEmoji(api, journal, () => undefined)
    expect(deletes).toBe(1)
})
