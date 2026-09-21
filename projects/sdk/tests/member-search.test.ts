import { Effect, Exit, Scope } from "effect"
import type { Result, ResultAsync } from "neverthrow"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { type GuildMemberJoinSourceType, GuildMemberJoinSourceTypes, createClient } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const modes = ["default", "native"] as const

afterEach(() => vi.unstubAllGlobals())

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

async function setup(mode: (typeof modes)[number], cacheMembers = false) {
    const scope = Scope.makeUnsafe()
    const options = { token: "fixture_only", ...(cacheMembers ? { cache: { members: true } } : {}) }
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

const hit = (extra: Record<string, unknown> = {}) => ({
    id: "20_30",
    guild_id: "20",
    user_id: "30",
    username: "member",
    discriminator: "0001",
    global_name: "Member",
    nickname: null,
    role_ids: ["40"],
    joined_at: 1_700_000_000,
    supplemental: { join_source_type: undefined, source_invite_code: null, inviter_id: null },
    is_bot: false,
    ...extra,
})

const page = (members: unknown[] = [hit()], extra: Record<string, unknown> = {}) => ({
    guild_id: "20",
    members,
    page_result_count: members.length,
    total_result_count: members.length,
    indexing: false,
    ...extra,
})

const selfMember = {
    user: { id: "30", username: "bot", bot: true },
    roles: [],
    joined_at: "2026-01-01T00:00:00.000Z",
    nick: null,
    avatar: null,
    banner: null,
}

const guild = {
    id: "20",
    owner_id: "40",
    name: "Fixture guild",
    features: [],
    icon: null,
    banner: null,
    splash: null,
    embed_splash: null,
    content_warning_text: null,
}

const roles = (permissions: string) => [
    {
        id: "20",
        name: "@everyone",
        color: 0,
        position: 0,
        permissions,
        hoist: false,
        mentionable: false,
        unicode_emoji: null,
    },
]

test.each(modes)(
    "%s sends validated pages and projects immutable indexed hits without cache admission",
    async (mode) => {
        const client = await setup(mode, true)
        const requests: Array<{ path: string; method: string | undefined; body: unknown }> = []
        stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
            requests.push({ path: new URL(url).pathname, method: init.method, body: init.body })
            return Response.json(page())
        })

        const result = await settle(
            client.members.search("20", {
                query: "alex",
                roleIds: ["40"],
                joinedAtAfterSeconds: 1_700_000_000,
                joinedAtBeforeSeconds: 1_700_000_100,
                userCreatedAtAfterSeconds: 1_600_000_000,
                userCreatedAtBeforeSeconds: 1_600_000_100,
                isBot: false,
                sortBy: "joinedAt",
                sortOrder: "asc",
            }),
        )
        const cached = await settle(client.members.get({ guildId: "20", userId: "30" }))

        expect(result).toMatchObject({
            guildId: "20",
            pageResultCount: 1,
            totalResultCount: 1,
            indexing: false,
            members: [
                {
                    guildId: "20",
                    userId: "30",
                    username: "member",
                    discriminator: "0001",
                    globalName: "Member",
                    nickname: null,
                    roleIds: ["40"],
                    joinedAtSeconds: 1_700_000_000,
                    isBot: false,
                    joinSourceType: null,
                    sourceInviteCode: null,
                    inviterId: null,
                },
            ],
        })
        expect(
            Object.isFrozen(result) && Object.isFrozen(result.members) && Object.isFrozen(result.members[0]!.roleIds),
        ).toBe(true)
        expect(cached).toBeUndefined()
        expect(requests).toEqual([
            {
                path: "/v1/guilds/20/members-search",
                method: "POST",
                body: JSON.stringify({
                    query: "alex",
                    limit: 25,
                    offset: 0,
                    role_ids: ["40"],
                    joined_at_gte: 1_700_000_000,
                    joined_at_lte: 1_700_000_100,
                    is_bot: false,
                    user_created_at_gte: 1_600_000_000,
                    user_created_at_lte: 1_600_000_100,
                    sort_by: "joinedAt",
                    sort_order: "asc",
                }),
            },
        ])
    },
)

test.each(modes)("%s preflights ManageGuild before sending sensitive filters", async (mode) => {
    const client = await setup(mode)
    const requests: Array<{ path: string; method: string | undefined; body: unknown }> = []
    const joinSourceTypes: GuildMemberJoinSourceType[] = [GuildMemberJoinSourceTypes.InstantInvite]
    const sourceInviteCodes = ["fixture-invite"]
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname
        requests.push({ path, method: init.method, body: init.body })
        if (path === "/v1/guilds/20/members/@me") {
            joinSourceTypes[0] = GuildMemberJoinSourceTypes.Creator
            sourceInviteCodes[0] = "mutated-invite"
            return Response.json(selfMember)
        }
        if (path === "/v1/guilds/20") return Response.json(guild)
        if (path === "/v1/guilds/20/roles") return Response.json(roles("32"))
        if (path === "/v1/guilds/20/members-search") return Response.json(page())
        throw new Error(`Unexpected fixture route: ${path}`)
    })

    expect(await settle(client.members.search("20", { joinSourceTypes, sourceInviteCodes }))).toMatchObject({
        pageResultCount: 1,
    })
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
        "GET /v1/guilds/20/members/@me",
        "GET /v1/guilds/20",
        "GET /v1/guilds/20/roles",
        "POST /v1/guilds/20/members-search",
    ])
    expect(requests[3]?.body).toBe(
        JSON.stringify({
            limit: 25,
            offset: 0,
            join_source_type: [GuildMemberJoinSourceTypes.InstantInvite],
            source_invite_code: ["fixture-invite"],
        }),
    )
})

test.each(modes)("%s starts independent sensitive-search preflight reads together before dispatch", async (mode) => {
    const client = await setup(mode)
    const ready = Promise.withResolvers<void>()
    const started: string[] = []
    let searchCalls = 0
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        const path = new URL(url).pathname
        if (path.endsWith("/members-search")) {
            searchCalls++
            expect(started).toHaveLength(3)
            return Response.json(page())
        }
        started.push(path)
        if (started.length === 3) ready.resolve()
        const abort = () => ready.reject(new Error("Fixture preflight aborted"))
        init.signal?.addEventListener("abort", abort, { once: true })
        try {
            await ready.promise
        } finally {
            init.signal?.removeEventListener("abort", abort)
        }
        return Response.json(path.endsWith("/@me") ? selfMember : path.endsWith("/roles") ? roles("32") : guild)
    })
    await settle(client.members.search("20", { sourceInviteCodes: ["fixture"] }, { timeoutMs: 1_000 }))
    expect(started).toHaveLength(3)
    expect(searchCalls).toBe(1)
})

test.each(modes)(
    "%s cancels sibling preflight reads after failure without dispatching sensitive search",
    async (mode) => {
        const client = await setup(mode)
        const ready = Promise.withResolvers<void>()
        let started = 0
        let aborted = 0
        let searchCalls = 0
        stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
            const path = new URL(url).pathname
            if (path.endsWith("/members-search")) {
                searchCalls++
                return Response.json(page())
            }
            if (++started === 3) ready.resolve()
            await ready.promise
            if (path.endsWith("/@me")) return new Response(null, { status: 403 })
            return new Promise<Response>((_resolve, reject) => {
                const abort = () => {
                    aborted++
                    reject(new Error("Fixture sibling cancelled"))
                }
                if (init.signal?.aborted) abort()
                else init.signal?.addEventListener("abort", abort, { once: true })
            })
        })
        await expect(settle(client.members.search("20", { sourceInviteCodes: ["fixture"] }))).rejects.toMatchObject({
            reason: "rejected",
        })
        expect(aborted).toBe(2)
        expect(searchCalls).toBe(0)
    },
)

test.each(modes)(
    "%s rejects permission denial and invalid options before an unexpected search request",
    async (mode) => {
        const client = await setup(mode)
        const requests: string[] = []
        stubFetchWithHostedDiscovery(async (url: string) => {
            const path = new URL(url).pathname
            requests.push(path)
            if (path === "/v1/guilds/20/members/@me") return Response.json(selfMember)
            if (path === "/v1/guilds/20") return Response.json(guild)
            if (path === "/v1/guilds/20/roles") return Response.json(roles("0"))
            throw new Error(`Unexpected fixture route: ${path}`)
        })

        const failures: unknown[] = []
        for (const [query, options] of [
            [{ joinSourceTypes: [GuildMemberJoinSourceTypes.InstantInvite] }, undefined],
            [{ joinSourceTypes: [GuildMemberJoinSourceTypes.InstantInvite] }, { timeoutMs: 0 }],
            [{ sourceInviteCodes: new Array<string>(1) }, undefined],
        ] as const) {
            try {
                await settle(client.members.search("20", query, options))
            } catch (error) {
                failures.push(error)
            }
        }

        expect(failures).toMatchObject([
            { operation: "members.search", reason: "rejected", outcome: "notDispatched" },
            { operation: "members.search", reason: "input", outcome: "notDispatched" },
            { operation: "members.search", reason: "input", outcome: "notDispatched" },
        ])
        expect(requests).toEqual(["/v1/guilds/20/members/@me", "/v1/guilds/20", "/v1/guilds/20/roles"])
    },
)

test.each(modes)("%s rejects malformed pages without caching an invented member", async (mode) => {
    const client = await setup(mode, true)
    stubFetchWithHostedDiscovery(async () => Response.json(page([hit()], { page_result_count: 0 })))

    let failure: unknown
    try {
        await settle(client.members.search("20"))
    } catch (error) {
        failure = error
    }

    expect(failure).toMatchObject({ operation: "members.search", reason: "response", outcome: "unknown" })
    expect(await settle(client.members.get({ guildId: "20", userId: "30" }))).toBeUndefined()
})

test.each(modes)("%s keeps unknown POST failures single-attempt but retries confirmed rate limits", async (mode) => {
    const client = await setup(mode)
    const fetch = vi.fn(async () => new Response(null, { status: 503 }))
    stubFetchWithHostedDiscovery(fetch)

    let failure: unknown
    try {
        await settle(client.members.search("20"))
    } catch (error) {
        failure = error
    }
    expect(failure).toMatchObject({ reason: "rejected", outcome: "unknown", status: 503 })
    expect(fetch).toHaveBeenCalledTimes(1)

    fetch.mockReset()
    fetch
        .mockResolvedValueOnce(
            Response.json({ retry_after: 0.001 }, { status: 429, headers: { "retry-after": "0.001" } }),
        )
        .mockResolvedValueOnce(Response.json(page()))
    expect((await settle(client.members.search("20"))).pageResultCount).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(2)
})
