import { Cause, Effect, Exit, Scope } from "effect"
import type { Result, ResultAsync } from "neverthrow"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const modes = ["default", "native"] as const

afterEach(() => vi.unstubAllGlobals())

const wire = (id = "10") => ({
    id,
    channel_id: "20",
    content: "indexed fixture",
    author: { id: "30", username: "fixture", bot: false },
    embeds: [],
    attachments: [],
    stickers: [],
})

const page = (messages: unknown[] = [wire()], extra: Record<string, unknown> = {}) => ({
    messages,
    channels:
        messages.length === 0
            ? []
            : [{ id: "20", guild_id: "40", name: "general", type: 0, recipients: [{ id: "private" }] }],
    total: messages.length,
    hits_per_page: 25,
    page: 1,
    ...extra,
})

async function settle<A>(value: Result<A, unknown> | ResultAsync<A, unknown> | Effect.Effect<A, unknown>): Promise<A> {
    if (Effect.isEffect(value)) {
        const result = await Effect.runPromise(Effect.result(value))
        if (result._tag === "Failure") throw result.failure
        return result.success
    }
    const result = "then" in value ? await value : value
    if (result.isErr()) throw result.error
    return result.value
}

async function setup(mode: (typeof modes)[number], cache = false) {
    const scope = Scope.makeUnsafe()
    const options = { token: "fixture_only", ...(cache ? { cache: { messages: true } } : {}) }
    const client =
        mode === "default"
            ? createClient(options)._unsafeUnwrap()
            : await Effect.runPromise(createNative(options).pipe(Scope.provide(scope)))
    onTestFinished(async () => {
        await settle(client.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return client
}

test.each(modes)(
    "%s sends one contextual current-scope page and projects immutable cache-free observations",
    async (mode) => {
        const client = await setup(mode, true)
        const requests: Array<{ path: string; method: string | undefined; body: string | null | undefined }> = []
        stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
            requests.push({
                path: new URL(url).pathname,
                method: init.method,
                body: init.body as string | null | undefined,
            })
            return Response.json(page())
        })

        const result = await settle(
            client.messages.search(
                { guildId: "40", channelId: "20" },
                {
                    content: "release notes",
                    authorTypes: ["bot"],
                    has: ["link"],
                    sortBy: "relevance",
                    sortOrder: "asc",
                },
            ),
        )
        expect(result).toMatchObject({
            indexing: false,
            total: 1,
            hitsPerPage: 25,
            messages: [{ id: "10", channelId: "20", content: "indexed fixture" }],
            channels: [{ id: "20", guildId: "40", name: "general", type: 0 }],
        })
        if (result.indexing) throw new Error("Expected result page")
        expect(
            Object.isFrozen(result) &&
                Object.isFrozen(result.messages) &&
                Object.isFrozen(result.messages[0]) &&
                Object.isFrozen(result.channels) &&
                Object.isFrozen(result.channels[0]),
        ).toBe(true)
        expect(await settle(client.messages.get({ id: "10", channelId: "20" }))).toBeUndefined()
        expect(requests).toEqual([
            {
                path: "/v1/search/messages",
                method: "POST",
                body: JSON.stringify({
                    scope: "current",
                    context_guild_id: "40",
                    context_channel_id: "20",
                    hits_per_page: 25,
                    page: 1,
                    content: "release notes",
                    author_type: ["bot"],
                    has: ["link"],
                    sort_by: "relevance",
                    sort_order: "asc",
                }),
            },
        ])
    },
)

test.each(modes)("%s captures one validated search context before dispatch", async (mode) => {
    const client = await setup(mode)
    const bodies: unknown[] = []
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        return Response.json(page([], { total: 0 }))
    })
    let reads = 0
    const changingContext = {
        get guildId() {
            return ++reads === 1 ? "40" : "99"
        },
    }
    await settle(client.messages.search(changingContext))
    expect(reads).toBe(1)
    expect(bodies).toEqual([{ scope: "current", context_guild_id: "40", hits_per_page: 25, page: 1 }])

    const firstInvalid = {
        get guildId() {
            return "invalid"
        },
    }
    await expect(settle(client.messages.search(firstInvalid))).rejects.toMatchObject({
        operation: "search",
        reason: "input",
        outcome: "notDispatched",
    })
    expect(bodies).toHaveLength(1)
})

test.each(modes)("%s cancellation interrupts search without retrying or polling", async (mode) => {
    const client = await setup(mode)
    const fetch = vi.fn()
    stubFetchWithHostedDiscovery(fetch)
    const controller = new AbortController()
    controller.abort()
    if (mode === "default") {
        const defaultApi = client as import("../src/index.js").Client
        await expect(
            settle(defaultApi.messages.search({ channelId: "20" }, undefined, { signal: controller.signal })),
        ).rejects.toMatchObject({
            _tag: "CancelledError",
        })
    } else {
        const native = client as import("../src/effect.js").Client
        const exit = await Effect.runPromiseExit(native.messages.search({ channelId: "20" }), {
            signal: controller.signal,
        })
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(fetch).not.toHaveBeenCalled()
        return
    }
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)(
    "%s preserves explicit indexing and rejects invalid or malformed searches without leaking filters",
    async (mode) => {
        const client = await setup(mode)
        const fetch = vi.fn(async () => Response.json({ indexing: true }))
        stubFetchWithHostedDiscovery(fetch)
        expect(await settle(client.messages.search({ channelId: "20" }))).toEqual({ indexing: true })

        let invalid: unknown
        let malformed: unknown
        try {
            await settle(client.messages.search({} as never, { content: "private query" }))
        } catch (error) {
            invalid = error
        }
        fetch.mockResolvedValueOnce(
            Response.json({ messages: [wire()], channels: [], total: 1, hits_per_page: 25, page: 1 }),
        )
        try {
            await settle(client.messages.search({ channelId: "20" }, { content: "private query" }))
        } catch (error) {
            malformed = error
        }
        expect(invalid).toMatchObject({ operation: "search", reason: "input", outcome: "notDispatched" })
        expect(malformed).toMatchObject({ operation: "search", reason: "response", outcome: "unknown" })
        expect(String(malformed)).not.toContain("private query")
        expect(fetch).toHaveBeenCalledTimes(2)
    },
)

test.each(modes)("%s rejects sparse search filters before discovery", async (mode) => {
    const client = await setup(mode)
    const fetch = vi.fn()
    stubFetchWithHostedDiscovery(fetch)
    for (const query of [
        { channelIds: new Array(1) },
        { contents: new Array(1) },
        { authorTypes: new Array(1) },
        { cursor: new Array(1) },
    ])
        await expect(settle(client.messages.search({ channelId: "20" }, query))).rejects.toMatchObject({
            operation: "search",
            reason: "input",
            outcome: "notDispatched",
        })
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)("%s snapshots bounded search filters from indexed values", async (mode) => {
    const client = await setup(mode)
    const bodies: unknown[] = []
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        return Response.json(page())
    })
    const channelIds = ["20"]
    Object.defineProperty(channelIds, Symbol.iterator, {
        value: () => {
            throw Error("Search must not consume caller iterators")
        },
    })

    await settle(client.messages.search({ channelId: "20" }, { channelIds }))
    expect(bodies).toEqual([
        { scope: "current", context_channel_id: "20", hits_per_page: 25, page: 1, channel_id: ["20"] },
    ])

    let indexedReads = 0
    const invalid = ["20"]
    Object.defineProperty(invalid, "0", {
        get: () => {
            indexedReads++
            return "invalid"
        },
    })
    Object.defineProperty(invalid, Symbol.iterator, {
        value: () => {
            throw Error("Search must reject indexed invalid values without iterating")
        },
    })
    await expect(settle(client.messages.search({ channelId: "20" }, { channelIds: invalid }))).rejects.toMatchObject({
        operation: "search",
        reason: "input",
        outcome: "notDispatched",
    })
    expect(indexedReads).toBe(1)
    expect(bodies).toHaveLength(1)
})

test.each(modes)("%s ignores provider cursors rather than exposing a false continuation contract", async (mode) => {
    const client = await setup(mode)
    const sent: unknown[] = []
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)))
        return Response.json(page([], { total: 0, cursor: [] }))
    })
    const result = await settle(client.messages.search({ channelId: "20" }))
    expect(result).toMatchObject({ indexing: false, messages: [], total: 0 })
    expect(result).not.toHaveProperty("cursor")
    expect(sent).toEqual([{ scope: "current", context_channel_id: "20", hits_per_page: 25, page: 1 }])
})

test.each(modes)("%s projects nameless DM channels and enforces numbered page bounds", async (mode) => {
    const client = await setup(mode)
    stubFetchWithHostedDiscovery(async () =>
        Response.json(page([wire()], { channels: [{ id: "20", type: 1 }], total: 1, page: 400 })),
    )
    const result = await settle(client.messages.search({ channelId: "20" }, { page: 400 }))
    if (result.indexing) throw new Error("Expected result page")
    expect(result).toMatchObject({ page: 400, channels: [{ id: "20", type: 1 }] })
    expect(result.channels[0]).not.toHaveProperty("name")
    expect(result.channels[0]).not.toHaveProperty("guildId")
    await expect(settle(client.messages.search({ channelId: "20" }, { page: 401 }))).rejects.toMatchObject({
        operation: "search",
        reason: "input",
        outcome: "notDispatched",
    })
})

test.each(modes)(
    "%s keeps uncertain search POST failures single-attempt while honoring confirmed rate limits",
    async (mode) => {
        const client = await setup(mode)
        const fetch = vi.fn(async () => new Response(null, { status: 503 }))
        stubFetchWithHostedDiscovery(fetch)
        await expect(settle(client.messages.search({ channelId: "20" }))).rejects.toMatchObject({
            operation: "search",
            reason: "rejected",
            outcome: "unknown",
            status: 503,
        })
        expect(fetch).toHaveBeenCalledTimes(1)

        fetch.mockReset()
        fetch
            .mockResolvedValueOnce(
                Response.json({ retry_after: 0.001 }, { status: 429, headers: { "retry-after": "0.001" } }),
            )
            .mockResolvedValueOnce(Response.json(page()))
        expect((await settle(client.messages.search({ channelId: "20" }))).indexing).toBe(false)
        expect(fetch).toHaveBeenCalledTimes(2)
    },
)
