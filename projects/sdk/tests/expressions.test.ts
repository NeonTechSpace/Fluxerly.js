import { Effect, Exit, Scope } from "effect"
import type { ResultAsync } from "neverthrow"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { GuildCache } from "../src/internal/guild-cache.js"

const modes = ["default", "native"] as const
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

async function settle<A>(value: ResultAsync<A, unknown> | Effect.Effect<A, unknown>): Promise<A> {
    if (Effect.isEffect(value)) {
        const result = await Effect.runPromise(Effect.result(value))
        if (result._tag === "Failure") throw result.failure
        return result.success
    }
    const result = await value
    if (result.isErr()) throw result.error
    return result.value
}

async function setup(mode: (typeof modes)[number], cache = true) {
    const scope = Scope.makeUnsafe()
    const options = { token: "fixture_only", cache: { emojis: cache, stickers: cache } }
    const client =
        mode === "default"
            ? createClient(options)._unsafeUnwrap()
            : await Effect.runPromise(createNative(options).pipe(Scope.provide(scope)))
    onTestFinished(async () => {
        const closed = client.shutdown()
        if (Effect.isEffect(closed)) await Effect.runPromise(closed)
        else await closed
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return client
}

test.each(modes)("%s manages expressions, projects allowlisted metadata and preserves explicit purge", async (mode) => {
    const client = await setup(mode)
    const requests: { path: string; method: string; body: any; audit: string | null }[] = []
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
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
            return Response.json({ success: [item], failed: [{ name: "Failed", error: "private response excluded" }] })
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
        expect(listed[0]).not.toHaveProperty("user")
        const local = api.get(target)
        expect(Effect.isEffect(local) ? await Effect.runPromise(local) : local._unsafeUnwrap()).toEqual(listed[0])
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
        expect(batch.failed).toEqual([{ name: "Failed" }])
        expect(JSON.stringify(batch)).not.toContain("private")
        expect(Object.isFrozen(batch.success[0])).toBe(true)
        await settle(api.delete(target))
        expect(requests.at(-1)?.path).toBe(`/v1/guilds/200/${kind}/100?purge=false`)
        const gone = api.get(target)
        expect(Effect.isEffect(gone) ? await Effect.runPromise(gone) : gone._unsafeUnwrap()).toBeUndefined()
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
    vi.stubGlobal("fetch", fetch)
    for (const op of [
        () => client.emojis.create("../200", { name: "Fixture", image }),
        () => client.emojis.create("200", { name: "invalid name", image }),
        () => client.emojis.create("200", { name: "Fixture", image: "https://private.example/image" }),
        () => client.emojis.create("200", { name: "Fixture", image: Buffer.alloc(524_289).toString("base64") }),
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
        () => client.emojis.create("200", { name: "Fixture", image }, { auditReason: "not ASCII é" }),
        () => client.emojis.delete(target, { purge: "true" } as never),
    ]) {
        await expect(settle<unknown>(op())).rejects.toMatchObject({
            _tag: "GuildOperationError",
            reason: "input",
            outcome: "notDispatched",
        })
    }
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)("%s accepts parameterized image data URIs without weakening base64 bounds", async (mode) => {
    const client = await setup(mode)
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
        expect(JSON.parse(String(init.body)).image).toBe("data:image/png;charset=utf-8;base64,aW1hZ2U=")
        return Response.json(wire(url.includes("stickers")))
    })
    vi.stubGlobal("fetch", fetch)
    const input = { name: "Fixture", image: "data:image/png;charset=utf-8;base64,aW1hZ2U=" }
    await settle(client.emojis.create("200", input))
    await settle(client.stickers.create("200", input))
    for (const image of [
        "data:image/png;charset=utf-8;base64,invalid*",
        "data:image/png;charset=utf-8;base64," + Buffer.alloc(524_289).toString("base64"),
    ])
        await expect(settle(client.emojis.create("200", { name: "Fixture", image }))).rejects.toMatchObject({
            reason: "input",
            outcome: "notDispatched",
        })
    expect(fetch).toHaveBeenCalledTimes(2)
})

test.each(modes)(
    "%s keeps uncertain writes unreplayed and invalidates overlapping expression observations",
    async (mode) => {
        const client = await setup(mode)
        let writes = 0
        vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
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
        expect(Effect.isEffect(local) ? await Effect.runPromise(local) : local._unsafeUnwrap()).toBeUndefined()
    },
)

test.each(modes)("%s rejects mismatched and malformed expression responses", async (mode) => {
    const client = await setup(mode, false)
    let response: unknown = { ...wire(), id: "999" }
    vi.stubGlobal("fetch", async () => Response.json(response))
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
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
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

test("expression caches share bounded retention, conflict and gateway-gap rules without retaining wire extras", () => {
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
