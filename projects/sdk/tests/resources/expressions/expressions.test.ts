import { afterEach, expect, test, vi } from "vitest"
import { GuildCache } from "../../../src/internal/guild-cache.js"
import { modes, setup as setupClient, type Mode } from "../../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"
import { captureLogs } from "../../support/log-capture.js"
import { settle } from "../../support/settle.js"

const image = "aW1hZ2U="
const target = { guildId: "200", id: "100" }
const wire = (sticker = false) => ({
    id: "100",
    name: "Fixture",
    animated: false,
    ...(sticker ? { description: "", tags: [] } : {}),
    user: { id: "999", private: "excluded" },
})
afterEach(() => vi.unstubAllGlobals())

const setup = (mode: Mode, cache = true) =>
    setupClient(mode, { token: "fixture_only", cache: { emojis: cache, stickers: cache } })

test.each(modes)("%s manages expressions, projects allowlisted metadata and preserves explicit purge", async (mode) => {
    const client = await setup(mode)
    const requests: { path: string; method: string; body: any; audit: string | null }[] = []
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname
        const body = init.body ? JSON.parse(String(init.body)) : undefined
        requests.push({
            path: new URL(url).pathname + new URL(url).search,
            method: init.method!,
            body,
            audit: new Headers(init.headers).get("X-Audit-Log-Reason"),
        })
        if (init.method === "DELETE") return new Response(null, { status: 204 })
        const item = wire(path.includes("stickers"))
        if (path.endsWith("metadata")) return Response.json({ ...item, guild_id: "200", allow_cloning: true })
        if (path.endsWith("bulk"))
            return Response.json({ success: [item], failed: [{ name: "Failed", error: "Maximum emojis reached" }] })
        if (init.method === "GET") return Response.json([item])
        return Response.json({
            ...item,
            ...(init.method === "PATCH" ? body : {}),
            ...(path.includes("stickers") && body?.description === null ? { description: "" } : {}),
        })
    })
    for (const kind of ["emojis", "stickers"] as const) {
        const api = client[kind]
        const listed = await settle(api.fetchAll("200"))
        // List reads keep only the uploader's ID from the partial user
        expect(listed[0]).not.toHaveProperty("user")
        expect(listed[0]?.creatorId).toBe("999")
        expect(JSON.stringify(listed)).not.toContain("excluded")
        const local = api.get(target)
        expect(await settle(local)).toEqual(listed[0])
        const metadata = await settle(api.fetchMetadata("100"))
        expect(metadata).toEqual({ guildId: "200", id: "100", name: "Fixture", animated: false, allowCloning: true })
        await settle(api.create("200", { name: "Fixture", image }, { auditReason: "Created for test" }))
        expect(requests.at(-1)?.audit).toBe("Created for test")
        await settle(api.clone("200", "101"))
        expect(requests.at(-1)?.body).toEqual({ [kind === "emojis" ? "source_emoji_id" : "source_sticker_id"]: "101" })
        const batch = await settle(
            api.createMany("200", [
                { name: "Fixture", image },
                { name: "Failed", image },
            ]),
        )
        // The provider's explanation is display text for a person, kept apart from the reviewed SDK fields
        expect(batch.failed).toEqual([{ name: "Failed", providerMessage: "Maximum emojis reached" }])
        expect(Object.isFrozen(batch.failed[0])).toBe(true)
        expect(Object.isFrozen(batch.success[0])).toBe(true)
        await settle(api.delete(target))
        expect(requests.at(-1)?.path).toBe(`/api/v1/guilds/200/${kind}/100?purge=false`)
        const gone = api.get(target)
        expect(await settle(gone)).toBeUndefined()
        await settle(api.delete(target, { purge: true, auditReason: "Explicit purge" }))
        expect(requests.at(-1)?.path.endsWith("?purge=true")).toBe(true)
    }
    await settle(client.emojis.edit(target, { name: "Renamed" }))
    expect(requests.at(-1)?.body).toEqual({ name: "Renamed" })
    const [sticker] = await settle(client.stickers.fetchAll("200"))
    await settle(client.stickers.edit(target, { ...sticker!, name: "Renamed" }))
    expect(requests.at(-1)?.body).toEqual({ name: "Renamed", description: null, tags: [] })
})

test.each(modes)("%s validates expressions before HTTP, without leaking rejected input", async (mode) => {
    const client = await setup(mode)
    const fetch = vi.fn()
    stubFetchWithHostedDiscovery(fetch)
    for (const op of [
        () => client.emojis.create("../200", { name: "Fixture", image }),
        () => client.emojis.create("200", { name: "invalid name", image }),
        () => client.emojis.create("200", { name: "Fixture", image: "https://private.example/image" }),
        // Fluxer's default body limit for one upload, 15,029,592 bytes, replaces the old local 512 KiB image ceiling
        () => client.emojis.create("200", { name: "Fixture", image: "A".repeat(15_029_592) }),
        () => client.stickers.create("200", { name: "Fixture", image: "A".repeat(15_029_592) }),
        () => client.emojis.createMany("200", []),
        () => client.emojis.createMany("200", Array(1)),
        () => client.stickers.create("200", { name: "Fixture", image, tags: Array(1) }),
        () =>
            client.emojis.createMany(
                "200",
                Array.from({ length: 51 }, () => ({ name: "Fixture", image })),
            ),
        () => client.stickers.create("200", { name: "Fixture", image, tags: Array(11).fill("x") }),
        () => client.stickers.edit(target, { name: "Fixture" } as never),
        () => client.stickers.edit(target, { name: "Fixture", description: "", tags: [], id: "999" } as never),
        () => client.emojis.create("200", { name: "Fixture", image }, { auditReason: "lone \ud800" }),
        () => client.emojis.delete(target, { purge: "true" } as never),
    ]) {
        await expect(settle<unknown, unknown>(op())).rejects.toMatchObject({
            _tag: "GuildOperationError",
            reason: "input",
            outcome: "notDispatched",
        })
    }
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)("%s snapshots bounded expression inputs and sticker tags from indexed values", async (mode) => {
    const client = await setup(mode)
    const bodies: unknown[] = []
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        bodies.push(body)
        return new URL(url).pathname.endsWith("/bulk")
            ? Response.json({ success: [wire()], failed: [] })
            : Response.json(wire(new URL(url).pathname.includes("stickers")))
    })
    const inputs = [{ name: "Fixture", image }]
    Object.defineProperty(inputs, Symbol.iterator, {
        value: () => {
            throw Error("Expression batches must not consume caller iterators")
        },
    })
    const tags = ["fixture"]
    Object.defineProperty(tags, Symbol.iterator, {
        value: () => {
            throw Error("Sticker writes must not consume caller iterators")
        },
    })

    await settle(client.emojis.createMany("200", inputs))
    await settle(client.stickers.create("200", { name: "Fixture", image, tags }))
    expect(bodies).toEqual([
        { emojis: [{ name: "Fixture", image }] },
        { name: "Fixture", image, description: null, tags: ["fixture"] },
    ])

    let batchReads = 0
    const invalidInputs = [{ name: "Fixture", image }]
    Object.defineProperty(invalidInputs, "0", {
        get: () => {
            batchReads++
            return { name: "invalid name", image }
        },
    })
    Object.defineProperty(invalidInputs, Symbol.iterator, {
        value: () => {
            throw Error("Expression batches must reject indexed invalid values without iterating")
        },
    })
    let tagReads = 0
    const invalidTags = ["fixture"]
    Object.defineProperty(invalidTags, "0", {
        get: () => {
            tagReads++
            return ""
        },
    })
    Object.defineProperty(invalidTags, Symbol.iterator, {
        value: () => {
            throw Error("Sticker writes must reject indexed invalid values without iterating")
        },
    })
    await expect(settle(client.emojis.createMany("200", invalidInputs))).rejects.toMatchObject({
        _tag: "GuildOperationError",
        reason: "input",
        outcome: "notDispatched",
    })
    await expect(
        settle(client.stickers.create("200", { name: "Fixture", image, tags: invalidTags })),
    ).rejects.toMatchObject({ _tag: "GuildOperationError", reason: "input", outcome: "notDispatched" })
    expect(batchReads).toBe(1)
    expect(tagReads).toBe(1)
    expect(bodies).toHaveLength(2)
})

test.each(modes)("%s accepts parameterized image data URIs without weakening base64 bounds", async (mode) => {
    const client = await setup(mode)
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
        expect(JSON.parse(String(init.body)).image).toBe("data:image/png;charset=utf-8;base64,aW1hZ2U=")
        return Response.json(wire(url.includes("stickers")))
    })
    stubFetchWithHostedDiscovery(fetch)
    const input = { name: "Fixture", image: "data:image/png;charset=utf-8;base64,aW1hZ2U=" }
    await settle(client.emojis.create("200", input))
    await settle(client.stickers.create("200", input))
    for (const image of ["data:image/png;charset=utf-8;base64,invalid*", "data:image/png;charset=utf-8;base64,AB=="])
        await expect(settle(client.emojis.create("200", { name: "Fixture", image }))).rejects.toMatchObject({
            reason: "input",
            outcome: "notDispatched",
        })
    expect(fetch).toHaveBeenCalledTimes(2)
})

// Fluxer resolves emoji_max_size and sticker_max_size per community, and an instance may raise them past the 512 KiB
// default (fluxer_api/src/api/infrastructure/AvatarService.ts:111-136 and :214-220, ImageUploadValidation.ts:30-55,
// packages/constants/src/LimitConfigMetadata.ts:348-368 at 0098958f), so larger images go to Fluxer whole
test.each(modes)("%s sends expression images larger than 512 KiB for Fluxer to check", async (mode) => {
    const client = await setup(mode, false)
    const bodies: { path: string; body: string }[] = []
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname
        bodies.push({ path, body: String(init.body) })
        const item = wire(path.includes("stickers"))
        return path.endsWith("/bulk")
            ? Response.json({ success: [item, { ...item, id: "101" }], failed: [] })
            : Response.json(item)
    })
    // 1 MiB and one byte of decoded image, twice the old local ceiling
    const large = Buffer.alloc(1_048_577).toString("base64")
    const dataUri = `data:image/png;base64,${large}`
    for (const kind of ["emojis", "stickers"] as const) {
        const api = client[kind]
        await settle(api.create("200", { name: "Fixture", image: large }))
        expect(bodies.at(-1)?.path).toBe(`/api/v1/guilds/200/${kind}`)
        expect(JSON.parse(bodies.at(-1)!.body).image).toBe(large)
        const batch = await settle(
            api.createMany("200", [
                { name: "One", image: large },
                { name: "Two", image: dataUri },
            ]),
        )
        expect(batch.success).toHaveLength(2)
        expect(bodies.at(-1)?.path).toBe(`/api/v1/guilds/200/${kind}/bulk`)
        expect(JSON.parse(bodies.at(-1)!.body)[kind].map((item: { image: string }) => item.image)).toEqual([
            large,
            dataUri,
        ])
    }
    expect(bodies).toHaveLength(4)
})

// Fluxer's routes keep fixed body limits: 15,029,592 bytes for one upload, the default for a route without its own, and
// 36,001,112 bytes for a batch, 50 images at the default 512 KiB (RequestBodyLimitMiddleware.ts:12-28,
// GuildEmojiController.ts:57, GuildStickerController.ts:61, AssetFormatPolicy.ts:162-177 at 0098958f)
test.each(modes)("%s refuses expression bodies over Fluxer's route limits", async (mode) => {
    const client = await setup(mode, false)
    const sizes: number[] = []
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        sizes.push(Buffer.byteLength(String(init.body)))
        return Response.json({ success: [wire(), { ...wire(), id: "101" }], failed: [] })
    })
    const overhead = JSON.stringify({
        emojis: [
            { name: "One", image: "" },
            { name: "Two", image: "" },
        ],
    }).length
    const half = Math.floor((36_001_112 - overhead) / 8) * 4
    const fitting = [
        { name: "One", image: "A".repeat(half) },
        { name: "Two", image: "A".repeat(half) },
    ]
    await settle(client.emojis.createMany("200", fitting))
    expect(sizes).toHaveLength(1)
    expect(sizes[0]).toBeGreaterThan(36_001_112 - 8)
    await expect(
        settle(client.emojis.createMany("200", [fitting[0]!, { name: "Two", image: "A".repeat(half + 8) }])),
    ).rejects.toMatchObject({
        reason: "input",
        outcome: "notDispatched",
        message: expect.stringContaining("36,001,112"),
    })
    for (const kind of ["emojis", "stickers"] as const)
        await expect(
            settle(client[kind].create("200", { name: "Fixture", image: "A".repeat(15_029_592) })),
        ).rejects.toMatchObject({
            reason: "input",
            outcome: "notDispatched",
            message: expect.stringContaining("15,029,592"),
        })
    expect(sizes).toHaveLength(1)
})

test.each(modes)(
    "%s keeps uncertain writes unreplayed and invalidates overlapping expression observations",
    async (mode) => {
        const client = await setup(mode)
        let writes = 0
        stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
            if (init.method === "GET") return Response.json([wire()])
            writes++
            throw Error("private transport detail")
        })
        await settle(client.emojis.fetchAll("200"))
        await expect(settle(client.emojis.edit(target, { name: "Renamed" }))).rejects.toMatchObject({
            reason: "network",
            outcome: "unknown",
        })
        expect(writes).toBe(1)
        const local = client.emojis.get(target)
        expect(await settle(local)).toBeUndefined()
    },
)

test.each(modes)("%s rejects mismatched and malformed expression responses", async (mode) => {
    const client = await setup(mode, false)
    let response: unknown = { ...wire(), id: "999" }
    stubFetchWithHostedDiscovery(async () => Response.json(response))
    await expect(settle(client.emojis.edit(target, { name: "Renamed" }))).rejects.toMatchObject({
        reason: "response",
        outcome: "unknown",
    })
    response = [wire(), wire()]
    await expect(settle(client.emojis.fetchAll("200"))).rejects.toMatchObject({ reason: "response" })
    response = { success: [wire()], failed: [] }
    await expect(
        settle(
            client.emojis.createMany("200", [
                { name: "One", image },
                { name: "Two", image },
            ]),
        ),
    ).rejects.toMatchObject({ reason: "response" })
})

test.each(modes)("%s uses fetched emoji snapshots directly in reaction operations", async (mode) => {
    const client = await setup(mode)
    const requests: string[] = []
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        requests.push(url)
        return init.method === "GET" ? Response.json([wire()]) : new Response(null, { status: 204 })
    })
    const [emoji] = await settle(client.emojis.fetchAll("200"))
    await settle(client.messages.addReaction({ channelId: "300", id: "400" }, emoji!))
    expect(requests.at(-1)).toContain("/messages/400/reactions/Fixture%3A100/@me")
    await expect(
        settle(client.messages.addReaction({ channelId: "300", id: "400" }, { ...emoji!, unexpected: true } as never)),
    ).rejects.toMatchObject({ reason: "input", outcome: "notDispatched" })
    expect(requests).toHaveLength(2)
})

test("expression caches share bounded retention, conflict and gateway-gap rules", () => {
    let now = 0
    const cache = new GuildCache({ emojis: { maxEntries: 1, maxBytes: 1000, maxAgeMs: 10 } }, () => now)
    const selection = { kind: "emojis" as const, guildId: "200" }
    const value = { ...target, name: "Fixture", animated: false }
    const read = cache.begin({ selection })
    cache.complete(read, [value])
    cache.end(read, false)
    expect(cache.get("emojis", "200", "100")).toEqual(value)
    const pending = cache.begin({ selection })
    cache.guildEvent("GUILD_EMOJIS_UPDATE", { guild_id: "200", emojis: [] })
    cache.complete(pending, [value])
    cache.end(pending, false)
    expect(cache.get("emojis", "200", "100")).toBeUndefined()
    const newer = cache.begin({ selection })
    cache.complete(newer, [value, { ...value, id: "101" }])
    cache.end(newer, false)
    expect(cache.get("emojis", "200", "100")).toBeUndefined()
    expect(cache.get("emojis", "200", "101")).toBeDefined()
    now = 11
    expect(cache.get("emojis", "200", "101")).toBeUndefined()
    const old = cache.begin({ selection })
    cache.gap()
    cache.complete(old, [value])
    cache.end(old, false)
    expect(cache.get("emojis", "200", "100")).toBeUndefined()
    cache.close()
})

test.each(modes)("%s reads expression source guilds strictly without caching or logging raw IDs", async (mode) => {
    const logs = captureLogs()
    const client = await setupClient(mode, {
        token: "fixture_only",
        cache: { emojis: true, stickers: true },
        logging: { ...logs.logging, debug: ["rest"] },
    })
    const sourceId = "7070707070"
    let response: unknown
    let status = 200
    const requests: string[] = []
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        requests.push(`${init.method} ${new URL(url).pathname}`)
        return Response.json(response, { status })
    })
    for (const kind of ["emojis", "stickers"] as const) {
        response = {
            id: "300",
            name: "Source guild",
            icon: "a_icon_hash",
            features: ["VERIFIED", "FUTURE_BADGE"],
            owner_id: "private",
        }
        const source = await settle(client[kind].fetchSource(sourceId))
        expect(requests.at(-1)).toBe(`GET /api/v1/${kind}/${sourceId}/source`)
        // Unrecognized badges are retained, and undocumented response fields are not copied
        expect(source).toEqual({
            id: "300",
            name: "Source guild",
            icon: "a_icon_hash",
            features: ["VERIFIED", "FUTURE_BADGE"],
        })
        expect(Object.isFrozen(source) && Object.isFrozen(source.features)).toBe(true)
        response = { id: "300", name: "Source guild", icon: null, features: [] }
        expect(await settle(client[kind].fetchSource(sourceId))).toEqual({ ...(response as object) })
        expect(await settle(client[kind].get({ guildId: "300", id: sourceId }))).toBeUndefined()

        for (const malformed of [
            { id: "300", name: "Source guild", features: [] },
            { id: "300", name: "Source guild", icon: 1, features: [] },
            { id: "300", name: "Source guild", icon: null },
            { id: "300", name: "Source guild", icon: null, features: ["VERIFIED", 1] },
            { id: "guild", name: "Source guild", icon: null, features: [] },
            { id: "300", icon: null, features: [] },
        ]) {
            response = malformed
            await expect(settle(client[kind].fetchSource(sourceId))).rejects.toMatchObject({
                _tag: "GuildOperationError",
                operation: `${kind}.fetchSource`,
                reason: "response",
            })
        }
        status = 404
        response = { code: "UNKNOWN_GUILD", message: "private provider text" }
        await expect(settle(client[kind].fetchSource(sourceId))).rejects.toMatchObject({
            operation: `${kind}.fetchSource`,
            reason: "notFound",
            apiError: { code: "unknownResource", providerCode: "UNKNOWN_GUILD" },
        })
        status = 200
        const dispatched = requests.length
        await expect(settle(client[kind].fetchSource("../300"))).rejects.toMatchObject({
            reason: "input",
            outcome: "notDispatched",
        })
        expect(requests).toHaveLength(dispatched)
    }
    expect(logs.records.length).toBeGreaterThan(0)
    expect(JSON.stringify(logs.records)).not.toContain(sourceId)
})
