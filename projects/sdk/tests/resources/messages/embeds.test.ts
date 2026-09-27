import { afterEach, expect, test, vi } from "vitest"
import { type EmbedInput, type Message, type MessageInput } from "../../../src/index.js"
import { modes } from "../../support/both-apis.js"
import { driver, fixture, input, inputWire, media, rejectsInput, rejectsResponse, wire } from "./content-fixture.js"

vi.mock("ws", (original) => import("../../support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
afterEach(() => vi.unstubAllGlobals())

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
        // The fixture rejects an edit that would leave the message empty, so the SDK forwards it unchanged
        await expect(api.edit({ embeds: [] })).rejects.toMatchObject({ reason: "rejected", status: 400 })
        expect((await api.edit({ content: "Plain text", embeds: [] })).embeds).toEqual([])
        expect(server.requests.map((r) => r.method)).not.toContain("GET")
        expect(server.requests.map((r) => r.url)).toEqual([
            "https://api.fluxer.app/v1/channels/20/messages",
            "https://api.fluxer.app/v1/channels/20/messages",
            ...Array.from({ length: 5 }, () => "https://api.fluxer.app/v1/channels/20/messages/10"),
        ])
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
    await rejectsInput(api.send({ embeds: [{ fields: iteratorMaskedField }] } as unknown as MessageInput))
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
    "%s normalizes optional nulls without fabricating metadata and rejects malformed embed responses",
    async (mode) => {
        const server = await fixture()
        const api = await driver(mode)
        for (const absent of [undefined, null, []]) {
            server.set(wire(absent))
            expect((await api.fetch()).embeds).toEqual([])
        }
        server.set(wire([{ type: "rich", title: null, fields: null, author: { name: "Author", icon_url: null } }]))
        expect((await api.fetch()).embeds).toEqual([{ type: "rich", author: { name: "Author" } }])
        // Field-type rows are covered by the decoder table. These rows cover a missing type, media without flags,
        // more than one child and an impossible calendar date
        for (const bad of [
            [{}],
            [{ type: "rich", image: { url: "x" } }],
            [{ type: "rich", children: [{ type: "x" }, { type: "y" }] }],
            [{ type: "rich", timestamp: "2025-02-29T00:00:00.000Z" }],
        ]) {
            server.set(wire(bad))
            await rejectsResponse(api.fetch())
            await rejectsResponse(api.history())
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
            expect(error).toMatchObject({ reason: "input", outcome: "notDispatched" })
            expect(String(error)).not.toContain("private-fixture-sentinel")
        }
    }
    for (const body of [{}, { embeds: null }, { embeds: [] }, { content: "", embeds: [] }])
        await rejectsInput(api.send(body as MessageInput))
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
