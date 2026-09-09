import { Effect, Exit, Scope, Stream } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient, type MemberSearchQuery, type MemberSearchIterationLimits } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"

const modes = ["default", "native"] as const
afterEach(() => vi.unstubAllGlobals())
const hit = (id: string) => ({
    id: `200:${id}`,
    guild_id: "200",
    user_id: id,
    username: "fixture",
    discriminator: "0001",
    global_name: null,
    nickname: null,
    role_ids: [],
    joined_at: 1_700_000_000,
    is_bot: false,
    supplemental: { join_source_type: null, source_invite_code: null, inviter_id: null },
})
const page = (ids: string[], total: number, indexing = false) =>
    Response.json({
        guild_id: "200",
        members: ids.map(hit),
        page_result_count: ids.length,
        total_result_count: total,
        indexing,
    })

async function setup(mode: (typeof modes)[number]) {
    const scope = Scope.makeUnsafe()
    const defaultApi = mode === "default" ? createClient({ token: "fixture_only" })._unsafeUnwrap() : undefined
    const native =
        mode === "native"
            ? await Effect.runPromise(createNative({ token: "fixture_only" }).pipe(Scope.provide(scope)))
            : undefined
    onTestFinished(async () => {
        if (defaultApi) await defaultApi.shutdown()
        else await Effect.runPromise(native!.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return {
        iterate: (filters: Omit<MemberSearchQuery, "limit">, limits: MemberSearchIterationLimits) =>
            defaultApi
                ? defaultApi.members.iterateSearch("200", filters, limits)
                : native!.members.iterateSearch("200", filters, limits),
    }
}

async function collect(source: ReturnType<Awaited<ReturnType<typeof setup>>["iterate"]>) {
    if (Stream.isStream(source)) {
        const result = await Effect.runPromise(Effect.result(Stream.runCollect(source)))
        if (result._tag === "Failure") throw result.failure
        return [...result.success]
    }
    const items = []
    for await (const result of source) {
        if (result.isErr()) throw result.error
        items.push(result.value)
    }
    return items
}

test.each(modes)("%s search traversal advances offsets and deduplicates changing index pages", async (mode) => {
    const api = await setup(mode),
        requests: { offset: number; limit: number }[] = []
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        requests.push(body)
        return body.offset === 0
            ? page(["301", "302"], 5)
            : body.offset === 2
              ? page(["302", "303"], 5)
              : page(["304"], 5)
    })
    const items = await collect(api.iterate({}, { maxItems: 4, pageSize: 2 }))
    expect(items.map((item) => item.userId)).toEqual(["301", "302", "303", "304"])
    expect(requests.map(({ offset, limit }) => ({ offset, limit }))).toEqual([
        { offset: 0, limit: 2 },
        { offset: 2, limit: 2 },
        { offset: 4, limit: 1 },
    ])
})

test.each(modes)("%s search traversal exposes indexing, stalls and page budgets", async (mode) => {
    const api = await setup(mode)
    vi.stubGlobal("fetch", async () => page([], 0, true))
    await expect(collect(api.iterate({}, { maxItems: 10 }))).rejects.toMatchObject({ reason: "indexing" })
    vi.stubGlobal("fetch", async () => page([], 10))
    await expect(collect(api.iterate({}, { maxItems: 10 }))).rejects.toMatchObject({ reason: "cursorStalled" })
    vi.stubGlobal("fetch", async () => page(["301"], 10))
    await expect(collect(api.iterate({}, { maxItems: 10, maxPages: 1 }))).rejects.toMatchObject({ reason: "pageLimit" })
})

test.each(modes)("%s search traversal is lazy, reusable and copies filters at consumption", async (mode) => {
    const api = await setup(mode),
        sent: unknown[] = []
    const filters = { roleIds: ["401"] }
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)))
        filters.roleIds[0] = "403"
        return page(["301"], 10)
    })
    const source = api.iterate(filters, { maxItems: 1 })
    expect(sent).toHaveLength(0)
    filters.roleIds[0] = "402"
    expect(await collect(source)).toHaveLength(1)
    expect(sent[0]).toMatchObject({ role_ids: ["402"] })
    expect(await collect(source)).toHaveLength(1)
    expect(sent[1]).toMatchObject({ role_ids: ["403"] })
})

test.each(modes)("%s rejects invalid traversal before requests", async (mode) => {
    const api = await setup(mode),
        fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    for (const limits of [{ maxItems: 0 }, { maxItems: 3, pageSize: 101 }, { maxItems: 3, maxPages: 0 }])
        await expect(collect(api.iterate({}, limits))).rejects.toMatchObject({ reason: "input" })
    await expect(collect(api.iterate({ limit: 2 } as never, { maxItems: 2 }))).rejects.toMatchObject({
        reason: "input",
    })
    await expect(collect(api.iterate({}, { maxItems: 2, pageSize: null } as never))).rejects.toMatchObject({
        reason: "input",
    })
    expect(fetch).not.toHaveBeenCalled()
})
