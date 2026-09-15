import { Effect, Exit, Scope } from "effect"
import type { ResultAsync } from "neverthrow"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient, DiscoveryCategories } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const modes = ["default", "native"] as const
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
async function setup(mode: (typeof modes)[number]) {
    const scope = Scope.makeUnsafe()
    const options = { token: "fixture_only", cache: { guilds: true } }
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
const wire = (extra: Record<string, unknown> = {}) => ({
    guild_id: "200",
    status: "pending",
    description: "Fixture community description",
    category_type: 4,
    primary_language: "en-US",
    custom_tags: ["typescript"],
    applied_at: "2026-09-09T10:00:00.000Z",
    reviewed_at: null,
    review_reason: null,
    removed_at: null,
    removal_reason: null,
    ...extra,
})
const directoryGuild = (extra: Record<string, unknown> = {}) => ({
    id: "200",
    name: "Fixture directory",
    icon: null,
    banner: null,
    description: "A fixture directory result",
    category_type: 4,
    primary_language: "en-US",
    custom_tags: ["typescript"],
    member_count: 12,
    online_count: 3,
    features: ["DISCOVERABLE"],
    verification_level: 2,
    ...extra,
})

test.each(modes)("%s reads one volatile directory page with explicit metadata and GET recovery", async (mode) => {
    const client = await setup(mode)
    let attempts = 0
    const fetch = vi.fn(async (url: string) => {
        if (++attempts === 1) return new Response(null, { status: 503 })
        expect(url).toBe(
            "https://api.fluxer.app/v1/discovery/guilds?limit=2&offset=4&query=fixture&category=4&language=en-US&tag=typescript&sort_by=online_count",
        )
        return Response.json({
            guilds: [
                directoryGuild({
                    icon: undefined,
                    banner: undefined,
                    description: undefined,
                    primary_language: undefined,
                    private_owner: "drop",
                }),
            ],
            total: 7,
            category_counts: [{ category_type: 4, count: 7 }],
        })
    })
    stubFetchWithHostedDiscovery(fetch)
    const page = await settle(
        client.discovery.search({
            query: "fixture",
            categoryId: 4,
            primaryLanguage: "en-US",
            tag: "typescript",
            sortBy: "onlineCount",
            limit: 2,
            offset: 4,
        }),
    )
    expect(page).toMatchObject({ total: 7, offset: 4, limit: 2, categoryCounts: [{ categoryId: 4, count: 7 }] })
    expect(page.guilds[0]).toMatchObject({
        id: "200",
        onlineCount: 3,
        icon: null,
        banner: null,
        description: null,
        primaryLanguage: null,
    })
    expect(JSON.stringify(page)).not.toContain("private_owner")
    expect(Object.isFrozen(page) && Object.isFrozen(page.guilds) && Object.isFrozen(page.guilds[0])).toBe(true)
    expect(attempts).toBe(2)
})

test.each(modes)("%s rejects invalid directory queries and malformed page entries", async (mode) => {
    const client = await setup(mode)
    let response: unknown = { guilds: [directoryGuild({ online_count: -1 })], total: 1, category_counts: [] }
    const fetch = vi.fn(async () => Response.json(response))
    stubFetchWithHostedDiscovery(fetch)
    for (const query of [
        { limit: 0 },
        { limit: 49 },
        { offset: -1 },
        { categoryId: 9 },
        { sortBy: "new" },
        { extra: true },
    ])
        await expect(settle(client.discovery.search(query as never))).rejects.toMatchObject({
            reason: "input",
            outcome: "notDispatched",
        })
    await expect(settle(client.discovery.search())).rejects.toMatchObject({ reason: "response", outcome: "unknown" })
    response = { guilds: [directoryGuild(), directoryGuild()], total: 2, category_counts: [] }
    await expect(settle(client.discovery.search({ limit: 2 }))).rejects.toMatchObject({
        reason: "response",
        outcome: "unknown",
    })
    await expect(settle(client.discovery.search({ limit: 1 }))).rejects.toMatchObject({
        reason: "response",
        outcome: "unknown",
    })
    expect(fetch).toHaveBeenCalledTimes(3)
})

test.each(modes)("%s reports directory UTF-16 limits and safe-integer offsets exactly", async (mode) => {
    const client = await setup(mode)
    const fetch = vi.fn(async () => Response.json({ guilds: [], total: 0, category_counts: [] }))
    stubFetchWithHostedDiscovery(fetch)
    for (const [query, detail] of [
        [
            { query: "😀".repeat(51) },
            {
                path: "query.query",
                constraint: "length",
                explanation: "Discovery query must contain at most 100 UTF-16 code units",
            },
        ],
        [
            { tag: "😀".repeat(16) },
            {
                path: "query.tag",
                constraint: "length",
                explanation: "Discovery tag must contain at most 30 UTF-16 code units",
            },
        ],
        [
            { primaryLanguage: "e" },
            {
                path: "query.primaryLanguage",
                constraint: "format",
                explanation: "Discovery primary language must be a 2 through 35 UTF-16 code unit language tag",
            },
        ],
        [
            { offset: Number.MAX_SAFE_INTEGER + 1 },
            {
                path: "query.offset",
                constraint: "range",
                explanation: "Discovery offset must be a nonnegative safe integer",
            },
        ],
    ] as const)
        await expect(settle(client.discovery.search(query))).rejects.toMatchObject({
            reason: "input",
            outcome: "notDispatched",
            inputValidation: detail,
        })
    expect(fetch).not.toHaveBeenCalled()
    const page = await settle(
        client.discovery.search({ query: "😀".repeat(50), tag: "😀".repeat(15), offset: Number.MAX_SAFE_INTEGER }),
    )
    expect(page.offset).toBe(Number.MAX_SAFE_INTEGER)
    expect(fetch).toHaveBeenCalledTimes(1)
})

test.each(modes)(
    "%s reports remote eligibility and permission rejection without replay or private bodies",
    async (mode) => {
        const client = await setup(mode)
        let status = 400
        const fetch = vi.fn(async () =>
            Response.json({ code: "DISCOVERY_ERROR", message: "Private application detail" }, { status }),
        )
        stubFetchWithHostedDiscovery(fetch)
        for (status of [400, 403, 404]) {
            let failure: unknown
            try {
                await settle(
                    client.discovery.apply("200", { description: "Private application detail", categoryId: 4 }),
                )
            } catch (error) {
                failure = error
            }
            expect(failure).toMatchObject({
                _tag: "GuildOperationError",
                operation: "discovery.apply",
                status,
                outcome: "rejected",
            })
            expect(JSON.stringify(failure)).not.toContain("Private application detail")
        }
        expect(fetch).toHaveBeenCalledTimes(3)
    },
)

test.each(modes)("%s aborts discovery writes at their deadline and cleans up for subsequent reads", async (mode) => {
    const client = await setup(mode)
    let aborted = false
    stubFetchWithHostedDiscovery(
        (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
                const abort = () => {
                    aborted = true
                    reject(init.signal?.reason)
                }
                if (init.signal?.aborted) abort()
                else init.signal?.addEventListener("abort", abort, { once: true })
            }),
    )
    await expect(settle(client.discovery.withdraw("200", { timeoutMs: 100 }))).rejects.toMatchObject({
        reason: "timeout",
        outcome: "unknown",
    })
    expect(aborted).toBe(true)
    stubFetchWithHostedDiscovery(async () =>
        Response.json({ application: null, eligible: true, min_member_count: 100 }),
    )
    expect((await settle(client.discovery.fetchStatus("200"))).application).toBeNull()
})

test.each(modes)("%s reads categories and complete status remotely without caching review state", async (mode) => {
    const client = await setup(mode)
    let app: unknown = null
    const fetch = vi.fn(async (url: string) =>
        url.endsWith("/categories")
            ? Response.json([{ id: 4, name: "Science & Technology", private_field: "drop" }])
            : Response.json({ application: app, eligible: false, min_member_count: 100 }),
    )
    stubFetchWithHostedDiscovery(fetch)
    const categories = await settle(client.discovery.fetchCategories())
    expect(categories).toEqual([{ id: DiscoveryCategories.ScienceAndTechnology, name: "Science & Technology" }])
    expect(Object.isFrozen(categories) && Object.isFrozen(categories[0])).toBe(true)
    expect(await settle(client.discovery.fetchStatus("200"))).toEqual({
        application: null,
        eligible: false,
        minMemberCount: 100,
    })
    app = wire({
        status: "removed",
        reviewed_at: "2026-09-09T11:00:00Z",
        review_reason: "Approved fixture",
        removed_at: "2026-09-09T12:00:00Z",
        removal_reason: "Removed fixture",
        reviewed_by: "private-reviewer",
        guild_nsfw_level: 0,
    })
    const state = await settle(client.discovery.fetchStatus("200"))
    expect(state.application).toMatchObject({
        guildId: "200",
        reviewReason: "Approved fixture",
        removalReason: "Removed fixture",
        guildNsfwLevel: 0,
    })
    expect(JSON.stringify(state)).not.toContain("private-reviewer")
    expect(
        Object.isFrozen(state) && Object.isFrozen(state.application) && Object.isFrozen(state.application?.tags),
    ).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(3)
})

test.each(modes)("%s submits required fields, normalizes tags and patches without hidden reads", async (mode) => {
    const client = await setup(mode)
    const bodies: unknown[] = [],
        methods: string[] = []
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        expect(url).toBe("https://api.fluxer.app/v1/guilds/200/discovery")
        methods.push(init.method!)
        if (init.method === "DELETE") return new Response(null, { status: 204 })
        bodies.push(JSON.parse(init.body as string))
        return Response.json(wire())
    })
    const input = {
        description: "Fixture community description",
        categoryId: 4,
        tags: [" TypeScript ", "typescript", "BUILD   TOOLS"],
    }
    const operation = client.discovery.apply("200", input)
    if (mode === "native") expect(methods).toEqual([])
    expect((await settle(operation)).guildId).toBe("200")
    expect(input.tags).toEqual([" TypeScript ", "typescript", "BUILD   TOOLS"])
    await settle(client.discovery.edit("200", { tags: [] }))
    await settle(client.discovery.edit("200", { primaryLanguage: "de" }))
    await settle(client.discovery.withdraw("200"))
    expect(methods).toEqual(["POST", "PATCH", "PATCH", "DELETE"])
    expect(bodies).toEqual([
        { description: input.description, category_type: 4, custom_tags: ["typescript", "build tools"] },
        { custom_tags: [] },
        { primary_language: "de" },
    ])
})

test.each(modes)("%s rejects invalid applications and empty patches before dispatch", async (mode) => {
    const client = await setup(mode)
    const fetch = vi.fn()
    stubFetchWithHostedDiscovery(fetch)
    const valid = { description: "Fixture community description", categoryId: 4 }
    for (const input of [
        undefined,
        {},
        { ...valid, description: "short" },
        { ...valid, description: "x".repeat(301) },
        { ...valid, categoryId: 9 },
        { ...valid, categoryId: "4" },
        { ...valid, categoryId: 0.5 },
        { ...valid, primaryLanguage: null },
        { ...valid, tags: ["a"] },
        { ...valid, tags: ["a".repeat(31)] },
        { ...valid, tags: Array(1) },
        { ...valid, tags: Array(11).fill("ok") },
        { ...valid, tags: ["bad!tag"] },
        { ...valid, private_field: true },
    ]) {
        await expect(settle(client.discovery.apply("200", input as never))).rejects.toMatchObject({
            reason: "input",
            outcome: "notDispatched",
        })
    }
    for (const patch of [{}, { tags: undefined }, { description: null }, { categoryId: null }, { tags: null }])
        await expect(settle(client.discovery.edit("200", patch as never))).rejects.toMatchObject({ reason: "input" })
    await expect(settle(client.discovery.fetchStatus("../private"))).rejects.toMatchObject({ reason: "input" })
    await expect(
        settle(client.discovery.withdraw("200", { auditReason: "Unsupported" } as never)),
    ).rejects.toMatchObject({ reason: "input" })
    expect(fetch).not.toHaveBeenCalled()
})

test.each(modes)("%s snapshots bounded discovery tags from indexed values", async (mode) => {
    const client = await setup(mode)
    const bodies: unknown[] = []
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        return Response.json(wire())
    })
    const tags = ["TypeScript"]
    Object.defineProperty(tags, Symbol.iterator, {
        value: () => {
            throw Error("Discovery writes must not consume caller iterators")
        },
    })

    await settle(client.discovery.apply("200", { description: "Fixture community description", categoryId: 4, tags }))
    expect(bodies).toEqual([
        { description: "Fixture community description", category_type: 4, custom_tags: ["typescript"] },
    ])

    let indexedReads = 0
    const invalid = ["TypeScript"]
    Object.defineProperty(invalid, "0", {
        get: () => {
            indexedReads++
            return "bad!tag"
        },
    })
    Object.defineProperty(invalid, Symbol.iterator, {
        value: () => {
            throw Error("Discovery writes must reject indexed invalid values without iterating")
        },
    })
    await expect(
        settle(
            client.discovery.apply("200", {
                description: "Fixture community description",
                categoryId: 4,
                tags: invalid,
            }),
        ),
    ).rejects.toMatchObject({ reason: "input", outcome: "notDispatched" })
    expect(indexedReads).toBe(1)
    expect(bodies).toHaveLength(1)
})

test.each(modes)("%s rejects malformed collections and cross-guild application responses", async (mode) => {
    const client = await setup(mode)
    let response: unknown
    stubFetchWithHostedDiscovery(async () => Response.json(response))
    for (response of [
        [
            { id: 4, name: "A" },
            { id: 4, name: "B" },
        ],
        [{ id: "4", name: "A" }],
        null,
    ])
        await expect(settle(client.discovery.fetchCategories())).rejects.toMatchObject({ reason: "response" })
    for (const app of [
        wire({ guild_id: "201" }),
        wire({ applied_at: "not-a-date" }),
        wire({ applied_at: "2025-02-29T00:00:00Z" }),
        wire({ reviewed_at: "2025-04-31T00:00:00Z" }),
        wire({ custom_tags: [42] }),
        wire({ review_reason: 42 }),
    ]) {
        response = { application: app, eligible: true, min_member_count: 100 }
        await expect(settle(client.discovery.fetchStatus("200"))).rejects.toMatchObject({ reason: "response" })
    }
    response = { application: null, eligible: true, min_member_count: -1 }
    await expect(settle(client.discovery.fetchStatus("200"))).rejects.toMatchObject({ reason: "response" })
    response = wire({ guild_id: "201" })
    await expect(settle(client.discovery.edit("200", { tags: [] }))).rejects.toMatchObject({
        reason: "response",
        outcome: "unknown",
    })
})

test.each(modes)("%s retries reads but not uncertain submission or withdrawal", async (mode) => {
    const client = await setup(mode)
    let reads = 0,
        writes = 0
    stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
        if (init.method === "GET") {
            if (++reads === 1) return new Response(null, { status: 503 })
            return Response.json({ application: null, eligible: true, min_member_count: 100 })
        }
        writes++
        throw Error("Private application lost")
    })
    await settle(client.discovery.fetchStatus("200"))
    expect(reads).toBe(2)
    for (const operation of [
        () => client.discovery.apply("200", { description: "Private application", categoryId: 4 }),
        () => client.discovery.withdraw("200"),
    ]) {
        let failure: unknown
        try {
            await settle<unknown>(operation())
        } catch (error) {
            failure = error
        }
        expect(failure).toMatchObject({ reason: "network", outcome: "unknown" })
        expect(JSON.stringify(failure)).not.toContain("Private application")
    }
    expect(writes).toBe(2)
})

test.each(modes)(
    "%s invalidates pending guild observations after potentially changing discovery features",
    async (mode) => {
        const client = await setup(mode)
        let entered!: () => void, release!: () => void
        const ready = new Promise<void>((resolve) => {
            entered = resolve
        })
        const held = new Promise<void>((resolve) => {
            release = resolve
        })
        stubFetchWithHostedDiscovery(async (_url: string, init: RequestInit) => {
            if (init.method === "GET") {
                entered()
                await held
                return Response.json({ id: "200", owner_id: "300", name: "Fixture", features: [] })
            }
            return Response.json(wire({ status: "approved" }))
        })
        const pending = settle(client.guilds.fetch("200"))
        await ready
        try {
            await settle(client.discovery.apply("200", { description: "Fixture community", categoryId: 4 }))
        } finally {
            release()
        }
        await pending
        const local = client.guilds.get("200")
        expect(Effect.isEffect(local) ? await Effect.runPromise(local) : local._unsafeUnwrap()).toBeUndefined()
    },
)
