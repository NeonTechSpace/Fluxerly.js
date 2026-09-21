import { Effect, Exit, Scope } from "effect"
import type { Result } from "neverthrow"
import { afterEach, expect, test, vi } from "vitest"
import {
    createClient,
    type CacheEntriesOptions,
    type CachedResources,
    type CacheKind,
    type Message,
    type MessageInput,
} from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { MessageCache } from "../src/internal/cache.js"
import { ChannelCache } from "../src/internal/channel-cache.js"
import { GuildCache } from "../src/internal/guild-cache.js"
import { UserCache } from "../src/internal/user-cache.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const modes = ["default", "native"] as const
type Mode = (typeof modes)[number]

const wire = (id: string, content: string) => ({
    id,
    channel_id: "2000000000000000000",
    content,
    author: { id: "3000000000000000000", username: "fixture" },
})

const unwrap = <A, E>(result: Result<A, E>): A => {
    if (result.isErr()) throw result.error
    return result.value
}

async function driver(mode: Mode, options: Record<string, unknown>) {
    const scope = Scope.makeUnsafe()
    const defaultApi = mode === "default" ? unwrap(createClient(options as never)) : undefined
    const native =
        mode === "native"
            ? await Effect.runPromise(createNative(options as never).pipe(Scope.provide(scope)))
            : undefined
    return {
        fetch: (id = "1000000000000000000"): Promise<Message> =>
            defaultApi
                ? Promise.resolve(defaultApi.messages.fetch({ id, channelId: "2000000000000000000" })).then((result) =>
                      unwrap(result),
                  )
                : Effect.runPromise(native!.messages.fetch({ id, channelId: "2000000000000000000" })),
        send: (input: MessageInput) =>
            defaultApi
                ? defaultApi.messages.send("2000000000000000000", input).then(unwrap)
                : Effect.runPromise(native!.messages.send("2000000000000000000", input)),
        entries: <K extends CacheKind>(
            kind: K,
            options?: CacheEntriesOptions,
        ): Promise<readonly CachedResources[K][]> =>
            defaultApi
                ? Promise.resolve(unwrap(defaultApi.cache.entries(kind, options)))
                : Effect.runPromise(native!.cache.entries(kind, options)),
        diagnostics: () => defaultApi?.diagnostics() ?? native!.diagnostics(),
        clear: () => {
            if (defaultApi) defaultApi.cache.clear()
            else native!.cache.clear()
        },
        invalid: async (kind: unknown, options?: unknown) => {
            if (defaultApi) {
                const result = defaultApi.cache.entries(kind as never, options as never)
                return result.isErr() ? result.error : result.value
            }
            return Effect.runPromise(native!.cache.entries(kind as never, options as never)).catch((error) => error)
        },
        close: async () => {
            if (defaultApi) unwrap(await defaultApi.shutdown())
            else await Effect.runPromise(native!.shutdown())
            await Effect.runPromise(Scope.close(scope, Exit.void))
        },
    }
}

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

test.each(modes)("%s exposes deeply frozen payload-free diagnostics and bounded cache entries", async (mode) => {
    const privateToken = "private-token-for-diagnostics"
    const privateBody = "private cached body"
    stubFetchWithHostedDiscovery(vi.fn(async () => Response.json(wire("1000000000000000000", privateBody))))
    const api = await driver(mode, {
        token: privateToken,
        cache: { messages: { maxEntries: 2, maxBytes: 10_000 } },
        uploads: { maxBytes: 1234 },
    })
    try {
        const snapshot = await api.fetch()
        const diagnostics = api.diagnostics()
        expect(diagnostics).toMatchObject({
            state: "Disconnected",
            rest: { activeRequests: 0, queuedRequests: 0, queuedJsonBytes: 0 },
            uploads: { reservedBytes: 0, byteCapacity: 1234 },
            gatewayRequests: { activeRequests: 0 },
            caches: {
                messages: {
                    configured: true,
                    retainedEntries: 1,
                    accountedBytes: Buffer.byteLength(JSON.stringify(snapshot)),
                    maxEntries: 2,
                    maxBytes: 10_000,
                },
                guilds: { configured: false, retainedEntries: 0, accountedBytes: 0, maxEntries: null, maxBytes: null },
            },
        })
        expect(Object.isFrozen(diagnostics)).toBe(true)
        expect(Object.isFrozen(diagnostics.shards)).toBe(true)
        expect(Object.isFrozen(diagnostics.shards[0]!)).toBe(true)
        expect(Object.isFrozen(diagnostics.rest)).toBe(true)
        expect(Object.isFrozen(diagnostics.uploads)).toBe(true)
        expect(Object.isFrozen(diagnostics.gatewayRequests)).toBe(true)
        expect(diagnostics.events).toEqual({
            subscriptions: 0,
            messageCollectors: 0,
            reactionCollectors: 0,
            activeHandlers: 0,
        })
        expect(Object.isFrozen(diagnostics.events)).toBe(true)
        expect(Object.isFrozen(diagnostics.caches)).toBe(true)
        expect(Object.isFrozen(diagnostics.caches.messages)).toBe(true)
        const encoded = JSON.stringify(diagnostics)
        expect(encoded).not.toContain(privateToken)
        expect(encoded).not.toContain(privateBody)
        expect(encoded).not.toContain("1000000000000000000")
        expect(encoded).not.toContain("2000000000000000000")

        const entries = await api.entries("messages", { limit: 1 })
        expect(entries).toEqual([snapshot])
        expect(Object.isFrozen(entries)).toBe(true)
        expect(Object.isFrozen(entries[0]!)).toBe(true)

        const kind = await api.invalid("unknown")
        expect(kind).toMatchObject({ _tag: "ConfigurationError", field: "kind" })
        const limit = await api.invalid("messages", { limit: 0 })
        expect(limit).toMatchObject({ _tag: "ConfigurationError", field: "limit" })
        const nullLimit = await api.invalid("messages", { limit: null })
        expect(nullLimit).toMatchObject({ _tag: "ConfigurationError", field: "limit" })
        const malformedOptions = await api.invalid("messages", { limit: 1, extra: true })
        expect(malformedOptions).toMatchObject({ _tag: "ConfigurationError", field: "limit" })
    } finally {
        await api.close()
    }
})

test.each(modes)(
    "%s clear preserves caller snapshots and blocks pre-clear message reads from cache admission",
    async (mode) => {
        let requests = 0
        let release!: () => void
        stubFetchWithHostedDiscovery(() => {
            requests++
            if (requests === 1) return Promise.resolve(Response.json(wire("1000000000000000000", "caller-held")))
            if (requests === 2)
                return new Promise<Response>((resolve) => {
                    release = () => resolve(Response.json(wire("1000000000000000000", "pre-clear")))
                })
            return Promise.resolve(Response.json(wire("1000000000000000000", "post-clear")))
        })
        const api = await driver(mode, { token: "fixture-only", cache: { messages: true } })
        try {
            const held = await api.fetch()
            const beforeClear = api.fetch()
            await vi.waitFor(() => expect(release).toBeTypeOf("function"), { interval: 5 })
            api.clear()
            api.clear()
            expect(requests).toBe(2)
            expect(held.content).toBe("caller-held")
            expect(Object.isFrozen(held)).toBe(true)
            expect((await api.entries("messages")).length).toBe(0)

            release()
            await beforeClear
            expect((await api.entries("messages")).length).toBe(0)

            const fresh = await api.fetch()
            expect(fresh.content).toBe("post-clear")
            expect((await api.entries("messages")).map((entry) => entry.content)).toEqual(["post-clear"])

            await api.close()
            expect(api.diagnostics()).toMatchObject({
                state: "Closed",
                caches: {
                    messages: {
                        configured: true,
                        retainedEntries: 0,
                        accountedBytes: 0,
                        maxEntries: 1000,
                        maxBytes: 8_388_608,
                    },
                },
            })
            api.clear()
            expect(await api.entries("messages")).toEqual([])
        } finally {
            await api.close()
        }
    },
)

test.each(modes)("%s reports local REST queue and upload occupancy until owned cleanup releases it", async (mode) => {
    const queuedResponses: ((response: Response) => void)[] = []
    stubFetchWithHostedDiscovery(
        () =>
            new Promise<Response>((resolve) => {
                queuedResponses.push(resolve)
            }),
    )
    const api = await driver(mode, { token: "fixture-only", uploads: { maxBytes: 4 } })
    try {
        const active = Array.from({ length: 4 }, () => api.fetch())
        await vi.waitFor(() => expect(queuedResponses).toHaveLength(4), { interval: 5 })
        const queued = api.send({ content: "queued request body" })
        await vi.waitFor(
            () =>
                expect(api.diagnostics().rest).toMatchObject({
                    activeRequests: 4,
                    queuedRequests: 1,
                    queuedJsonBytes: expect.any(Number),
                }),
            { interval: 5 },
        )
        expect(api.diagnostics().rest.queuedJsonBytes).toBeGreaterThan(0)
        for (let index = 0; index < 5; index++) {
            await vi.waitFor(() => expect(queuedResponses.length).toBeGreaterThan(0), { interval: 5 })
            queuedResponses.shift()!(Response.json(wire("1000000000000000000", "released")))
        }
        await Promise.all([...active, queued])
        expect(api.diagnostics().rest).toMatchObject({ activeRequests: 0, queuedRequests: 0, queuedJsonBytes: 0 })
    } finally {
        await api.close()
    }

    let release!: (response: Response) => void
    stubFetchWithHostedDiscovery(
        () =>
            new Promise<Response>((resolve) => {
                release = resolve
            }),
    )
    const uploads = await driver(mode, { token: "fixture-only", uploads: { maxBytes: 4 } })
    try {
        const sending = uploads.send({ attachments: [{ data: new Uint8Array([1, 2, 3]), filename: "fixture.bin" }] })
        await vi.waitFor(() => expect(release).toBeTypeOf("function"), { interval: 5 })
        expect(uploads.diagnostics()).toMatchObject({
            rest: { activeRequests: 1 },
            uploads: { reservedBytes: 3, byteCapacity: 4 },
        })
        release(Response.json({}))
        await expect(sending).rejects.toBeDefined()
        await vi.waitFor(
            () =>
                expect(uploads.diagnostics()).toMatchObject({
                    rest: { activeRequests: 0 },
                    uploads: { reservedBytes: 0 },
                }),
            { interval: 5 },
        )
    } finally {
        await uploads.close()
    }
})

test.each(modes)("%s applies the public cache-entry default and cap", async (mode) => {
    let identifier = 0
    stubFetchWithHostedDiscovery(
        vi.fn(async () =>
            Response.json(wire((1000000000000000000n + BigInt(identifier++)).toString(), "bounded snapshot")),
        ),
    )
    const api = await driver(mode, { token: "fixture-only", cache: { messages: true } })
    try {
        for (let index = 0; index < 101; index++) await api.fetch((1000000000000000000n + BigInt(index)).toString())
        expect(await api.entries("messages")).toHaveLength(100)
        expect(await api.entries("messages", { limit: 1000 })).toHaveLength(101)
        expect(await api.invalid("messages", { limit: 1001 })).toMatchObject({
            _tag: "ConfigurationError",
            field: "limit",
        })
    } finally {
        await api.close()
    }
})

test("cache-owner clear generations reject every pre-clear read without changing LRU enumeration", () => {
    let now = 0
    const message = (id: string): Message =>
        ({
            id,
            channelId: "20",
            content: id,
            embeds: [],
            attachments: [],
            stickers: [],
            author: { id: "30", username: "fixture", isBot: false },
        }) as Message
    const messages = new MessageCache(
        { maxEntries: 2, maxBytes: 10_000, maxAgeMs: 5, onError: undefined },
        () => undefined,
        () => now,
    )
    const messageGuard = messages.begin("20", "10", false, messages.generation)
    messages.clear()
    messages.complete(messageGuard, [message("10")])
    expect(messages.entries(2)).toEqual([])
    messages.end(messageGuard)
    messages.observe(message("10"))
    messages.observe(message("11"))
    expect(messages.entries(1).map((entry) => entry.id)).toEqual(["10"])
    messages.observe(message("12"))
    expect(messages.entries(2).map((entry) => entry.id)).toEqual(["11", "12"])
    now = 5
    expect(messages.entries(2)).toEqual([])
    expect(messages.diagnostics()).toMatchObject({ retainedEntries: 0, accountedBytes: 0 })

    const settings = { maxEntries: 2, maxBytes: 10_000, maxAgeMs: null } as const
    const guilds = new GuildCache({ guilds: settings }, () => now)
    const guildGuard = guilds.begin({ selection: { kind: "guilds", guildId: "20" } })
    guilds.clear()
    guilds.complete(guildGuard, [{ id: "20", name: "Guild", features: [] }] as never)
    expect(guilds.entries("guilds", 1)).toEqual([])
    guilds.end(guildGuard, false)

    const channels = new ChannelCache(settings, () => now)
    const channelGuard = channels.begin({ channelId: "40", guildId: "20" })
    channels.clear()
    channels.complete(channelGuard, { id: "40", guildId: "20", name: "chat" } as never)
    expect(channels.entries(1)).toEqual([])
    channels.end(channelGuard, false)

    const users = new UserCache({ users: settings }, () => now)
    const userGuard = users.begin("users", { id: "30" })
    users.clear()
    users.complete(userGuard, [{ id: "30", username: "fixture" }] as never)
    expect(users.entries("users", 1)).toEqual([])
})
