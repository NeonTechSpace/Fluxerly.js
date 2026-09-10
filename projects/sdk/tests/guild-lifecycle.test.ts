import { Effect, Exit, Scope, Stream } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import type { Result } from "neverthrow"
import { createClient, type GuildListQuery, type GuildIterationQuery, type Guild } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"

const modes = ["default", "native"] as const
const wireGuild = (id: string) => ({ id, name: "fixture", owner_id: "90", features: [] })
const value = <A, E>(result: Result<A, E>): A => {
    if (result.isErr()) throw result.error
    return result.value
}
async function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
    const result = await Effect.runPromise(Effect.result(effect))
    if (result._tag === "Failure") throw result.failure
    return result.success
}
afterEach(() => vi.unstubAllGlobals())

async function setup(mode: (typeof modes)[number]) {
    const scope = Scope.makeUnsafe()
    const cache = { guilds: true, members: true, roles: true, messages: true, channels: true } as const
    const defaultApi = mode === "default" ? value(createClient({ token: "fixture", cache })) : undefined
    const native =
        mode === "native" ? await run(createNative({ token: "fixture", cache }).pipe(Scope.provide(scope))) : undefined
    onTestFinished(async () => {
        if (defaultApi) value(await defaultApi.shutdown())
        else await run(native!.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return {
        page: async (query?: GuildListQuery): Promise<readonly Guild[]> =>
            defaultApi ? value(await defaultApi.guilds.fetchPage(query)) : run(native!.guilds.fetchPage(query)),
        leave: (id: string) =>
            defaultApi ? defaultApi.guilds.leave(id).then((result) => value(result)) : run(native!.guilds.leave(id)),
        fetchGuild: async (id: string): Promise<Guild> =>
            defaultApi ? value(await defaultApi.guilds.fetch(id)) : run(native!.guilds.fetch(id)),
        getGuild: (id: string) =>
            defaultApi ? Promise.resolve(value(defaultApi.guilds.get(id))) : run(native!.guilds.get(id)),
        fetchRoles: (id: string) =>
            defaultApi
                ? defaultApi.roles.fetchAll(id).then((result) => value(result))
                : run(native!.roles.fetchAll(id)),
        getRole: (guildId: string, id: string) =>
            defaultApi
                ? Promise.resolve(value(defaultApi.roles.get({ guildId, id })))
                : run(native!.roles.get({ guildId, id })),
        fetchChannel: async (id: string) =>
            defaultApi ? value(await defaultApi.channels.fetch(id)) : run(native!.channels.fetch(id)),
        getChannel: async (id: string) =>
            defaultApi ? value(defaultApi.channels.get(id)) : run(native!.channels.get(id)),
        fetchMessage: async () =>
            defaultApi
                ? value(await defaultApi.messages.fetch({ channelId: "30", id: "40" }))
                : run(native!.messages.fetch({ channelId: "30", id: "40" })),
        getMessage: async () =>
            defaultApi
                ? value(defaultApi.messages.get({ channelId: "30", id: "40" }))
                : run(native!.messages.get({ channelId: "30", id: "40" })),
        iterate(query: GuildIterationQuery): AsyncIterable<Guild> {
            if (native) return Stream.toAsyncIterable(native.guilds.iterate(query))
            return {
                async *[Symbol.asyncIterator]() {
                    for await (const item of defaultApi!.guilds.iterate(query)) yield value(item)
                },
            }
        },
        state: () => (defaultApi ?? native)!.state,
        setMembers: (id: string, memberIds: readonly string[]) =>
            defaultApi
                ? Promise.resolve(value(defaultApi.presence.setMembers(id, memberIds)))
                : run(native!.presence.setMembers(id, memberIds)),
    }
}
async function gather<A>(values: AsyncIterable<A>) {
    const items: A[] = []
    for await (const item of values) items.push(item)
    return items
}

test.each(modes)("%s guild pages are bounded, frozen, and do not populate a membership cache", async (mode) => {
    const api = await setup(mode)
    const calls: URL[] = []
    vi.stubGlobal("fetch", async (url: string) => {
        calls.push(new URL(url))
        return Response.json([wireGuild("20")])
    })
    const page = await api.page({ limit: 2, before: "30" })
    expect(page[0]?.id).toBe("20")
    expect(Object.isFrozen(page) && Object.isFrozen(page[0]) && Object.isFrozen(page[0]?.features)).toBe(true)
    expect(await api.getGuild("20")).toBeUndefined()
    expect(calls[0]?.pathname).toBe("/v1/users/@me/guilds")
    expect(Object.fromEntries(calls[0]!.searchParams)).toEqual({ limit: "2", with_counts: "false", before: "30" })
    for (const query of [
        { limit: 0 },
        { limit: 201 },
        { limit: null },
        { before: "1", after: "2" },
        { withCounts: "yes" },
    ])
        await expect(api.page(query as GuildListQuery)).rejects.toMatchObject({
            reason: "input",
            outcome: "notDispatched",
        })
    expect(calls).toHaveLength(1)
    for (const response of [[wireGuild("20"), wireGuild("20")], [wireGuild("30"), wireGuild("20")], [{ id: "20" }]]) {
        vi.stubGlobal("fetch", async () => Response.json(response))
        await expect(api.page()).rejects.toMatchObject({ reason: "response" })
    }
})

test.each(modes)(
    "%s guild pages preserve available list permissions and optional approximate counts without cache admission",
    async (mode) => {
        const api = await setup(mode)
        const calls: URL[] = []
        vi.stubGlobal("fetch", async (url: string) => {
            calls.push(new URL(url))
            return Response.json([
                {
                    ...wireGuild("20"),
                    permissions: "18446744073709551615",
                    approximate_member_count: 0,
                    approximate_presence_count: 4,
                },
                { ...wireGuild("21"), permissions: "0" },
            ])
        })
        const page = await api.page({ withCounts: true })
        expect(page).toMatchObject([
            {
                id: "20",
                permissions: 18_446_744_073_709_551_615n,
                approximateMemberCount: 0,
                approximatePresenceCount: 4,
            },
            { id: "21", permissions: 0n },
        ])
        expect("approximateMemberCount" in page[1]!).toBe(false)
        expect(await api.getGuild("20")).toBeUndefined()
        expect(Object.fromEntries(calls[0]!.searchParams)).toEqual({ limit: "200", with_counts: "true" })
        for (const permissions of ["-1", "18446744073709551616", "9".repeat(21), null]) {
            vi.stubGlobal("fetch", async () => Response.json([{ ...wireGuild("20"), permissions }]))
            await expect(api.page({ withCounts: true })).rejects.toMatchObject({ reason: "response" })
        }
    },
)

test.each(modes)("%s guild iteration forwards withCounts to every remote page", async (mode) => {
    const api = await setup(mode)
    const calls: URL[] = []
    vi.stubGlobal("fetch", async (url: string) => {
        const request = new URL(url)
        calls.push(request)
        return Response.json(
            request.searchParams.has("after") ? [] : [{ ...wireGuild("20"), approximate_member_count: 5 }],
        )
    })
    const page = await gather(api.iterate({ maxItems: 2, pageSize: 2, withCounts: true }))
    expect(page).toMatchObject([{ id: "20", approximateMemberCount: 5 }])
    expect(calls).toHaveLength(2)
    expect(calls.every((request) => request.searchParams.get("with_counts") === "true")).toBe(true)
})

test.each(modes)(
    "%s guild iteration is lazy, bounded and rejects a removed cursor before repeating a page",
    async (mode) => {
        const api = await setup(mode)
        const calls: URL[] = []
        vi.stubGlobal("fetch", async (url: string) => {
            const request = new URL(url)
            calls.push(request)
            return Response.json(request.searchParams.has("after") ? [] : [wireGuild("20")])
        })
        const iterable = api.iterate({ maxItems: 2, pageSize: 2 })
        expect(calls).toHaveLength(0)
        expect((await gather(iterable)).map((guild) => guild.id)).toEqual(["20"])
        expect(calls).toHaveLength(2)
        expect(calls[1]?.searchParams.get("after")).toBe("20")
        calls.length = 0
        for await (const _guild of iterable) break
        expect(calls).toHaveLength(1)
        vi.stubGlobal("fetch", async () => Response.json([wireGuild("20")]))
        const iterator = api.iterate({ maxItems: 4, pageSize: 1 })[Symbol.asyncIterator]()
        expect((await iterator.next()).value?.id).toBe("20")
        await expect(iterator.next()).rejects.toMatchObject({ reason: "cursorStalled" })
        await iterator.return?.()
        await expect(gather(api.iterate({ maxItems: 2, maxPages: 1 }))).rejects.toMatchObject({ reason: "pageLimit" })
    },
)

test.each(modes)("%s leave invalidates channel/message observations and their in-flight reads", async (mode) => {
    const api = await setup(mode)
    let hold = false
    const releases: Array<() => void> = []
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        if (init.method === "DELETE") return new Response(null, { status: 204 })
        if (hold) await new Promise<void>((resolve) => releases.push(resolve))
        return Response.json(
            url.includes("/messages/")
                ? { id: "40", channel_id: "30", content: "fixture", author: { id: "90", username: "fixture" } }
                : { id: "30", guild_id: "20", type: 0, name: "fixture", position: 0 },
        )
    })
    await api.fetchChannel("30")
    await api.fetchMessage()
    expect(await api.getChannel("30")).toBeDefined()
    expect(await api.getMessage()).toBeDefined()
    hold = true
    const pending = Promise.all([api.fetchChannel("30"), api.fetchMessage()])
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    await api.leave("20")
    expect(await api.getChannel("30")).toBeUndefined()
    expect(await api.getMessage()).toBeUndefined()
    for (const release of releases) release()
    await pending
    expect(await api.getChannel("30")).toBeUndefined()
    expect(await api.getMessage()).toBeUndefined()
})

test.each(modes)("%s leave rejects bad IDs locally and never retries an uncertain removal", async (mode) => {
    const api = await setup(mode)
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
        if (init.method === "DELETE") throw new TypeError("private transport failure")
        return Response.json(wireGuild("20"))
    })
    vi.stubGlobal("fetch", fetch)
    await expect(api.leave("bad/id")).rejects.toMatchObject({
        operation: "guilds.leave",
        reason: "input",
        outcome: "notDispatched",
    })
    expect(fetch).not.toHaveBeenCalled()
    await api.fetchGuild("20")
    await expect(api.leave("20")).rejects.toMatchObject({
        operation: "guilds.leave",
        reason: "network",
        outcome: "unknown",
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(await api.getGuild("20")).toBeUndefined()
    expect(api.state()).toBe("Disconnected")
})

test.each(modes)("%s only a successful explicit leave releases member-selection intent", async (mode) => {
    const api = await setup(mode)
    for (let id = 20; id < 120; id++) await api.setMembers(String(id), ["1"])
    await expect(async () => api.setMembers("200", ["1"])).rejects.toMatchObject({
        _tag: "PresenceError",
        reason: "limit",
    })
    vi.stubGlobal("fetch", async () => {
        throw new TypeError("Test-owned lost response")
    })
    await expect(api.leave("20")).rejects.toMatchObject({ outcome: "unknown" })
    await expect(async () => api.setMembers("200", ["1"])).rejects.toMatchObject({
        _tag: "PresenceError",
        reason: "limit",
    })
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }))
    await api.leave("20")
    await api.setMembers("200", ["1"])
})

test.each(modes)(
    "%s leave preserves authored messages on the wire, invalidates related roles and blocks late reads",
    async (mode) => {
        const api = await setup(mode)
        const role = {
            id: "50",
            name: "fixture",
            color: 0,
            position: 1,
            permissions: "0",
            hoist: false,
            mentionable: false,
        }
        let delayed = false
        let release!: () => void
        let entered!: () => void
        const started = new Promise<void>((resolve) => {
            entered = resolve
        })
        const writes: { path: string; body: unknown }[] = []
        vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
            const request = new URL(url)
            if (init.method === "DELETE") {
                writes.push({ path: request.pathname + request.search, body: init.body })
                return new Response(null, { status: 204 })
            }
            if (request.pathname.endsWith("/roles")) {
                if (delayed) {
                    entered()
                    await new Promise<void>((resolve) => {
                        release = resolve
                    })
                }
                return Response.json([role])
            }
            return Response.json(wireGuild(request.pathname.split("/").at(-1)!))
        })
        await api.fetchGuild("20")
        await api.fetchGuild("21")
        await api.fetchRoles("20")
        delayed = true
        const late = api.fetchRoles("20")
        await started
        await api.leave("20")
        expect(writes).toEqual([{ path: "/v1/users/@me/guilds/20?delete_messages=false", body: undefined }])
        expect(await api.getGuild("20")).toBeUndefined()
        expect(await api.getGuild("21")).toBeDefined()
        expect(await api.getRole("20", "50")).toBeUndefined()
        release()
        await late
        expect(await api.getRole("20", "50")).toBeUndefined()
        expect(api.state()).toBe("Disconnected")
        expect((await api.fetchGuild("21")).id).toBe("21")
    },
)
