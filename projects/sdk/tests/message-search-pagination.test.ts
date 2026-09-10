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
const page = (ids: string[], cursor?: readonly string[]) =>
    Response.json({
        messages: ids.map(wire),
        channels: [],
        total: 10,
        hits_per_page: 25,
        page: 1,
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
            filters: Omit<MessageSearchQuery, "limit" | "page" | "cursor">,
            limits: MessageSearchIterationLimits,
        ) =>
            defaultApi
                ? defaultApi.messages.iterateSearch({ channelId: "20" }, filters, limits)
                : native!.messages.iterateSearch({ channelId: "20" }, filters, limits),
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

test.each(modes)("%s search traversal is lazy, bounded, cursor-based and cache-free", async (mode) => {
    const api = await setup(mode)
    const sent: Record<string, unknown>[] = []
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body))
        sent.push(body)
        return body.cursor === undefined ? page(["10", "11"], ["opaque", "one"]) : page(["11", "12"])
    })
    const source = api.iterate({ content: "todo" }, { maxItems: 3, pageSize: 2 })
    expect(sent).toEqual([])
    const messages = await collect(source)
    expect(messages.map((message) => message.id)).toEqual(["10", "11", "12"])
    expect(sent).toEqual([
        { scope: "current", context_channel_id: "20", hits_per_page: 2, page: 1, content: "todo" },
        { scope: "current", context_channel_id: "20", hits_per_page: 1, cursor: ["opaque", "one"], content: "todo" },
    ])
    expect(await read(api.get())).toBeUndefined()
})

test.each(modes)("%s stops indexing, repeated opaque cursors and page budgets without hidden polling", async (mode) => {
    const api = await setup(mode)
    const fetch = vi.fn(async () => Response.json({ indexing: true }))
    stubFetchWithHostedDiscovery(fetch)
    await expect(collect(api.iterate({}, { maxItems: 2 }))).rejects.toMatchObject({ reason: "indexing" })
    expect(fetch).toHaveBeenCalledTimes(1)

    fetch.mockReset()
    fetch.mockResolvedValueOnce(page(["10"], ["same"])).mockResolvedValueOnce(page(["11"], ["same"]))
    await expect(collect(api.iterate({}, { maxItems: 3 }))).rejects.toMatchObject({ reason: "cursorStalled" })

    fetch.mockReset()
    fetch.mockResolvedValueOnce(page(["10"], ["next"]))
    await expect(collect(api.iterate({}, { maxItems: 3, maxPages: 1 }))).rejects.toMatchObject({ reason: "pageLimit" })
})

test.each(modes)("%s rejects invalid traversal settings before dispatch", async (mode) => {
    const api = await setup(mode)
    const fetch = vi.fn()
    stubFetchWithHostedDiscovery(fetch)
    await expect(collect(api.iterate({}, { maxItems: 0 }))).rejects.toMatchObject({ reason: "input" })
    await expect(collect(api.iterate({}, { maxItems: 1, pageSize: 26 }))).rejects.toMatchObject({ reason: "input" })
    await expect(collect(api.iterate({ cursor: ["wrong"] } as never, { maxItems: 1 }))).rejects.toMatchObject({
        reason: "input",
    })
    expect(fetch).not.toHaveBeenCalled()
})
