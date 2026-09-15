import { Effect, Exit, Scope, Stream } from "effect"
import type { Result } from "neverthrow"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient, type MessageSearchIterationLimits, type MessageSearchQuery } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const modes = ["default", "native"] as const
afterEach(() => vi.unstubAllGlobals())

const wire = (id: string) => ({
    id,
    channel_id: "20",
    content: `indexed ${id}`,
    author: { id: "30", username: "fixture" },
    embeds: [],
    attachments: [],
    stickers: [],
})
const page = (
    ids: string[],
    {
        page: pageNumber = 1,
        total = ids.length,
        hitsPerPage = 25,
        cursor,
    }: {
        readonly page?: number
        readonly total?: number
        readonly hitsPerPage?: number
        readonly cursor?: readonly string[]
    } = {},
) =>
    Response.json({
        messages: ids.map(wire),
        channels: ids.length === 0 ? [] : [{ id: "20", type: 0 }],
        total,
        hits_per_page: hitsPerPage,
        page: pageNumber,
        ...(cursor === undefined ? {} : { cursor }),
    })

async function setup(mode: (typeof modes)[number]) {
    const scope = Scope.makeUnsafe()
    const defaultApi =
        mode === "default"
            ? createClient({ token: "fixture_only", cache: { messages: true } })._unsafeUnwrap()
            : undefined
    const native =
        mode === "native"
            ? await Effect.runPromise(
                  createNative({ token: "fixture_only", cache: { messages: true } }).pipe(Scope.provide(scope)),
              )
            : undefined
    onTestFinished(async () => {
        if (defaultApi) await defaultApi.shutdown()
        else await Effect.runPromise(native!.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return {
        iterate: (
            filters: Omit<MessageSearchQuery, "limit" | "page">,
            limits: MessageSearchIterationLimits,
            options?: { readonly timeoutMs?: number },
        ) =>
            defaultApi
                ? defaultApi.messages.iterateSearch({ channelId: "20" }, filters, limits, options)
                : native!.messages.iterateSearch({ channelId: "20" }, filters, limits, options),
        iterateIn: (
            context: Parameters<NonNullable<typeof defaultApi>["messages"]["iterateSearch"]>[0],
            filters: Omit<MessageSearchQuery, "limit" | "page">,
            limits: MessageSearchIterationLimits,
            options?: { readonly timeoutMs?: number },
        ) =>
            defaultApi
                ? defaultApi.messages.iterateSearch(context, filters, limits, options)
                : native!.messages.iterateSearch(context, filters, limits, options),
        search: (
            context: Parameters<NonNullable<typeof defaultApi>["messages"]["search"]>[0],
            query?: MessageSearchQuery,
        ) => (defaultApi ? defaultApi.messages.search(context, query) : native!.messages.search(context, query)),
        get: () =>
            defaultApi
                ? defaultApi.messages.get({ id: "10", channelId: "20" })
                : native!.messages.get({ id: "10", channelId: "20" }),
    }
}

async function collect(source: ReturnType<Awaited<ReturnType<typeof setup>>["iterate"]>) {
    if (Stream.isStream(source)) {
        const result = await Effect.runPromise(Effect.result(Stream.runCollect(source)))
        if (result._tag === "Failure") throw result.failure
        return [...result.success]
    }
    const messages = []
    for await (const result of source) {
        if (result.isErr()) throw result.error
        messages.push(result.value)
    }
    return messages
}

async function read<A>(value: Result<A, unknown> | Effect.Effect<A, unknown>): Promise<A> {
    if (Effect.isEffect(value)) {
        const result = await Effect.runPromise(Effect.result(value))
        if (result._tag === "Failure") throw result.failure
        return result.success
    }
    const result = value
    if (result.isErr()) throw result.error
    return result.value!
}

test.each(modes)("%s search traversal is lazy, numbered, bounded, and cache-free", async (mode) => {
    const api = await setup(mode)
    const sent: Record<string, unknown>[] = []
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        sent.push(body)
        return body.page === 1
            ? page(["10", "11"], { page: 1, total: 4, hitsPerPage: 2, cursor: ["ignored"] })
            : page(["12", "13"], { page: 2, total: 4, hitsPerPage: 2, cursor: ["ignored"] })
    })
    const source = api.iterate({ content: "todo" }, { maxItems: 3, pageSize: 2 })
    expect(sent).toEqual([])
    const messages = await collect(source)
    expect(messages.map((message) => message.id)).toEqual(["10", "11", "12"])
    expect(sent).toEqual([
        { scope: "current", context_channel_id: "20", hits_per_page: 2, page: 1, content: "todo" },
        { scope: "current", context_channel_id: "20", hits_per_page: 2, page: 2, content: "todo" },
    ])
    expect(await read(api.get())).toBeUndefined()
})

test.each(modes)("%s stops indexing, malformed progress, and page budgets without hidden polling", async (mode) => {
    const api = await setup(mode)
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ indexing: true }))
    stubFetchWithHostedDiscovery(fetch)
    await expect(collect(api.iterate({}, { maxItems: 2 }))).rejects.toMatchObject({ reason: "indexing" })
    expect(fetch).toHaveBeenCalledTimes(1)

    fetch.mockReset()
    fetch.mockResolvedValueOnce(page(["10"], { page: 2, total: 2, hitsPerPage: 2 }))
    await expect(collect(api.iterate({}, { maxItems: 3 }))).rejects.toMatchObject({ reason: "cursorStalled" })

    fetch.mockReset()
    fetch.mockResolvedValueOnce(page(["10"], { total: 4, hitsPerPage: 3 }))
    await expect(collect(api.iterate({}, { maxItems: 3, maxPages: 1 }))).rejects.toMatchObject({ reason: "pageLimit" })

    fetch.mockReset()
    fetch.mockImplementation(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        return page([String(body.page)], { page: body.page, total: 401, hitsPerPage: 1 })
    })
    await expect(collect(api.iterate({}, { maxItems: 401, maxPages: 401, pageSize: 1 }))).rejects.toMatchObject({
        reason: "pageLimit",
    })
    expect(fetch).toHaveBeenCalledTimes(400)
})

test.each(modes)("%s rejects invalid traversal settings before dispatch", async (mode) => {
    const api = await setup(mode)
    const fetch = vi.fn()
    stubFetchWithHostedDiscovery(fetch)
    await expect(collect(api.iterate({}, { maxItems: 0 }))).rejects.toMatchObject({ reason: "input" })
    await expect(collect(api.iterate({}, { maxItems: 1, pageSize: 26 }))).rejects.toMatchObject({ reason: "input" })
    await expect(collect(api.iterate({}, { maxItems: 1, maxPages: Number.POSITIVE_INFINITY }))).rejects.toMatchObject({
        reason: "input",
    })
    await expect(collect(api.iterate({ page: 1 } as never, { maxItems: 1 }))).rejects.toMatchObject({
        reason: "input",
    })
    const forbidden = {}
    Object.defineProperty(forbidden, "limit", { value: 1 })
    await expect(collect(api.iterate(forbidden, { maxItems: 1 }))).rejects.toMatchObject({ reason: "input" })
    const oversized = new Array<string>(11)
    Object.defineProperty(oversized, Symbol.iterator, {
        value: () => {
            throw new Error("Oversized filters must be rejected before iteration")
        },
    })
    const filters = new (class {
        get exactPhrases() {
            return oversized
        }
    })()
    const searched = api.search({ channelId: "20" }, filters)
    await expect(read(Effect.isEffect(searched) ? searched : await searched)).rejects.toMatchObject({
        reason: "input",
        inputValidation: { path: "query.exactPhrases[]" },
    })
    await expect(collect(api.iterate(filters, { maxItems: 1 }))).rejects.toMatchObject({
        reason: "input",
        inputValidation: { path: "query.exactPhrases[]" },
    })
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)("%s rejects invalid traversal context before dispatch", async (mode) => {
    const api = await setup(mode)
    const fetch = vi.fn()
    stubFetchWithHostedDiscovery(fetch)

    await expect(collect(api.iterateIn({ guildId: "not-an-id" }, {}, { maxItems: 1 }))).rejects.toMatchObject({
        reason: "input",
        inputValidation: { path: "context.guildId", constraint: "format" },
    })
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)("%s captures traversal scope, budgets and timeout once per consumption", async (mode) => {
    const api = await setup(mode)
    const sent: Record<string, unknown>[] = []
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        sent.push(body)
        return page([String(body.page)], {
            page: body.page,
            total: 4,
            hitsPerPage: body.hits_per_page,
        })
    })
    let contextReads = 0
    const changingContext = {
        get guildId() {
            return ++contextReads === 1 ? "40" : "99"
        },
    }
    let maxItemReads = 0
    const changingLimits = {
        get maxItems() {
            return ++maxItemReads === 1 ? 3 : 50
        },
    }
    let timeoutReads = 0
    const changingOptions = {
        get timeoutMs() {
            return ++timeoutReads === 1 ? 1_000 : 2_147_483_648
        },
    }

    expect(
        (await collect(api.iterateIn(changingContext, {}, changingLimits, changingOptions))).map(
            (message) => message.id,
        ),
    ).toEqual(["1", "2"])
    expect([contextReads, maxItemReads, timeoutReads]).toEqual([1, 1, 1])
    expect(sent).toEqual([
        { scope: "current", context_guild_id: "40", hits_per_page: 3, page: 1 },
        { scope: "current", context_guild_id: "40", hits_per_page: 3, page: 2 },
    ])

    await expect(collect(api.iterateIn({ guildId: "40" }, {}, { maxItems: 0 }))).rejects.toMatchObject({
        reason: "input",
    })
    expect(sent).toHaveLength(2)
})

test.each(modes)("%s search and traversal retain validated getter context and input snapshots", async (mode) => {
    const api = await setup(mode)
    const sent: Record<string, unknown>[] = []
    const filters = { content: "original" }
    let requests = 0
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        sent.push(body)
        requests += 1
        if (requests === 2) filters.content = "mutated"
        return page([String(requests)], {
            page: body.page,
            total: 2,
            hitsPerPage: body.hits_per_page,
            cursor: ["ignored"],
        })
    })
    const context = new (class {
        get guildId() {
            return "10"
        }
    })()

    const searched = api.search(context)
    await read(Effect.isEffect(searched) ? searched : await searched)
    expect(
        (await collect(api.iterateIn(context, filters, { maxItems: 2, pageSize: 1 }))).map((message) => message.id),
    ).toEqual(["2", "3"])
    expect(sent).toEqual([
        { scope: "current", context_guild_id: "10", hits_per_page: 25, page: 1 },
        { scope: "current", context_guild_id: "10", hits_per_page: 1, page: 1, content: "original" },
        { scope: "current", context_guild_id: "10", hits_per_page: 1, page: 2, content: "original" },
    ])
})

test.each(modes)("%s search and traversal preserve structural filters at consumption", async (mode) => {
    const api = await setup(mode)
    const sent: Record<string, unknown>[] = []
    const phrases = ["initial"]
    Object.defineProperty(phrases, "0", { enumerable: false })
    Object.defineProperty(phrases, "toJSON", { value: () => ["not-the-filter"] })
    let content = "initial"
    const filters = new (class {
        get content() {
            return content
        }
        get exactPhrases() {
            return phrases
        }
    })()
    Object.defineProperty(filters, "pinned", { value: false })
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        sent.push(body)
        if (sent.length === 2) {
            content = "later"
            phrases[0] = "later"
        }
        return page([String(sent.length)], {
            page: body.page,
            total: 2,
            hitsPerPage: body.hits_per_page,
            cursor: ["ignored"],
        })
    })
    const source = api.iterate(filters, { maxItems: 2, pageSize: 1 })
    expect(sent).toEqual([])
    content = "accepted"
    phrases[0] = "accepted"
    const searched = api.search({ channelId: "20" }, filters)
    await read(Effect.isEffect(searched) ? searched : await searched)
    expect(await collect(source)).toHaveLength(2)
    expect(sent).toEqual([
        {
            scope: "current",
            context_channel_id: "20",
            hits_per_page: 25,
            page: 1,
            content: "accepted",
            exact_phrases: ["accepted"],
            pinned: false,
        },
        {
            scope: "current",
            context_channel_id: "20",
            hits_per_page: 1,
            page: 1,
            content: "accepted",
            exact_phrases: ["accepted"],
            pinned: false,
        },
        {
            scope: "current",
            context_channel_id: "20",
            hits_per_page: 1,
            page: 2,
            content: "accepted",
            exact_phrases: ["accepted"],
            pinned: false,
        },
    ])
    expect(await collect(source)).toHaveLength(2)
    expect(sent.slice(3)).toEqual([
        { ...sent[1], content: "later", exact_phrases: ["later"] },
        { ...sent[2], content: "later", exact_phrases: ["later"] },
    ])
})
