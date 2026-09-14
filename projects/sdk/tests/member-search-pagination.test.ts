import { Effect, Exit, Scope, Stream } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient, type MemberSearchQuery, type MemberSearchIterationLimits } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

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
        search: async (query: MemberSearchQuery) => {
            if (defaultApi) {
                const result = await defaultApi.members.search("200", query)
                if (result.isErr()) throw result.error
                return result.value
            }
            return Effect.runPromise(native!.members.search("200", query))
        },
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
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
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
    stubFetchWithHostedDiscovery(async () => page([], 0, true))
    await expect(collect(api.iterate({}, { maxItems: 10 }))).rejects.toMatchObject({ reason: "indexing" })
    stubFetchWithHostedDiscovery(async () => page([], 10))
    await expect(collect(api.iterate({}, { maxItems: 10 }))).rejects.toMatchObject({ reason: "cursorStalled" })
    stubFetchWithHostedDiscovery(async () => page(["301"], 10))
    await expect(collect(api.iterate({}, { maxItems: 10, maxPages: 1 }))).rejects.toMatchObject({ reason: "pageLimit" })
})

test.each(modes)("%s search traversal is lazy, reusable and copies filters at consumption", async (mode) => {
    const api = await setup(mode),
        sent: unknown[] = []
    const filters = { roleIds: ["401"] }
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
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
    stubFetchWithHostedDiscovery(fetch)
    for (const limits of [{ maxItems: 0 }, { maxItems: 3, pageSize: 101 }, { maxItems: 3, maxPages: 0 }])
        await expect(collect(api.iterate({}, limits))).rejects.toMatchObject({ reason: "input" })
    await expect(collect(api.iterate({ limit: 2 } as never, { maxItems: 2 }))).rejects.toMatchObject({
        reason: "input",
    })
    await expect(collect(api.iterate({}, { maxItems: 2, pageSize: null } as never))).rejects.toMatchObject({
        reason: "input",
    })
    const forbidden = new (class {
        get query() {
            return "fixture"
        }
        get limit() {
            return 1
        }
    })()
    await expect(collect(api.iterate(forbidden, { maxItems: 1 }))).rejects.toMatchObject({ reason: "input" })
    const oversized = new Array<string>(11)
    Object.defineProperty(oversized, Symbol.iterator, {
        value: () => {
            throw new Error("Oversized filters must be rejected before iteration")
        },
    })
    const filters = new (class {
        get roleIds() {
            return oversized
        }
    })()
    await expect(api.search(filters)).rejects.toMatchObject({
        reason: "input",
        inputValidation: { path: "query.roleIds[]" },
    })
    await expect(collect(api.iterate(filters, { maxItems: 1 }))).rejects.toMatchObject({
        reason: "input",
        inputValidation: { path: "query.roleIds[]" },
    })
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)("%s search and traversal preserve structural filters at consumption", async (mode) => {
    const api = await setup(mode)
    const sent: Record<string, unknown>[] = []
    const roles = ["401"]
    Object.defineProperty(roles, "0", { enumerable: false })
    Object.defineProperty(roles, "toJSON", { value: () => ["999"] })
    let query = "initial"
    const filters = new (class {
        get query() {
            return query
        }
        get roleIds() {
            return roles
        }
        get offset() {
            return 2
        }
    })()
    Object.defineProperty(filters, "isBot", { value: false })
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        sent.push(body)
        if (sent.length === 2) {
            query = "later"
            roles[0] = "403"
        }
        return page([String(300 + sent.length)], 4)
    })
    const source = api.iterate(filters, { maxItems: 2, pageSize: 1 })
    expect(sent).toEqual([])
    query = "accepted"
    roles[0] = "402"
    await api.search(filters)
    expect(await collect(source)).toHaveLength(2)
    expect(sent).toEqual([
        { query: "accepted", limit: 25, offset: 2, role_ids: ["402"], is_bot: false },
        { query: "accepted", limit: 1, offset: 2, role_ids: ["402"], is_bot: false },
        { query: "accepted", limit: 1, offset: 3, role_ids: ["402"], is_bot: false },
    ])
    expect(await collect(source)).toHaveLength(2)
    expect(sent.slice(3)).toEqual([
        { ...sent[1], query: "later", role_ids: ["403"] },
        { ...sent[2], query: "later", role_ids: ["403"] },
    ])
})
