import { Cause, Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import {
    createClient,
    type ClientOptions,
    type DefaultUserOperationOptions,
    type UserProfile,
    type UserProfileQuery,
} from "../src/index.js"
import { createClient as createNative, type ClientOptions as NativeClientOptions } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

const modes = ["default", "native"] as const

afterEach(() => vi.unstubAllGlobals())

const user = (id = "30", extra: Record<string, unknown> = {}) => ({
    id,
    username: "fixture",
    discriminator: "0001",
    global_name: "Fixture",
    avatar: "avatar-hash",
    avatar_color: 42,
    flags: 7,
    bot: false,
    system: false,
    ...extra,
})

const fields = (extra: Record<string, unknown> = {}) => ({
    bio: "Account biography",
    pronouns: "they/them",
    banner: "banner-hash",
    banner_color: 11,
    accent_color: 22,
    ...extra,
})

const profile = (id = "30", extra: Record<string, unknown> = {}) => ({
    user: user(id),
    user_profile: fields(),
    connected_accounts: [{ type: "github", id: "private-connection" }],
    mutual_friends: [user("31")],
    mutual_guilds: [{ id: "20", nick: "private nickname" }],
    timezone_offset: 60,
    premium_type: 1,
    premium_since: "2025-01-01T00:00:00.000Z",
    premium_lifetime_sequence: 7,
    ...extra,
})

const guildFields = (extra: Record<string, unknown> = {}) => ({
    bio: "Guild biography",
    pronouns: "she/her",
    banner: "guild-banner-hash",
    accent_color: 33,
    ...extra,
})

async function unwrap<A>(value: { isErr(): boolean; value?: A; error?: unknown }): Promise<A> {
    if (value.isErr()) throw value.error
    return value.value!
}

async function run<A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal): Promise<A> {
    const result = await Effect.runPromise(Effect.result(effect), signal ? { signal } : undefined)
    if (result._tag === "Failure") throw result.failure
    return result.success
}

function rest(handler: (url: string, init: RequestInit) => Promise<Response>) {
    stubFetchWithHostedDiscovery((url: string, init: RequestInit) =>
        url.endsWith("/gateway/bot")
            ? Promise.resolve(Response.json({ url: "wss://gateway.fluxer.app" }))
            : handler(url, init),
    )
}

async function setup(mode: (typeof modes)[number], options: ClientOptions = { token: "fixture" }) {
    const scope = Scope.makeUnsafe()
    const defaultApi = mode === "default" ? await unwrap(createClient(options)) : undefined
    const native =
        mode === "native"
            ? await run(createNative(options as NativeClientOptions).pipe(Scope.provide(scope)))
            : undefined
    const close = async () => (defaultApi ? unwrap(await defaultApi.shutdown()) : run(native!.shutdown()))
    onTestFinished(async () => {
        await close()
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return {
        defaultApi,
        native,
        fetchProfile: async (
            id = "30",
            query?: UserProfileQuery,
            options?: DefaultUserOperationOptions,
        ): Promise<UserProfile> => {
            if (defaultApi) return unwrap(await defaultApi.users.fetchProfile(id, query, options))
            const { signal, ...request } = options ?? {}
            return run(native!.users.fetchProfile(id, query, request), signal as AbortSignal | undefined)
        },
        fetchUser: async (id = "30") =>
            defaultApi ? unwrap(await defaultApi.users.fetch(id)) : run(native!.users.fetch(id)),
        getUser: async (id = "30") => (defaultApi ? unwrap(defaultApi.users.get(id)) : run(native!.users.get(id))),
    }
}

test.each(modes)("%s projects an explicit guild-context profile without private expansion", async (mode) => {
    const calls: { path: string; query: string; method: string; authorization: string | null }[] = []
    rest(async (url, init) => {
        const request = new URL(url)
        calls.push({
            path: request.pathname,
            query: request.search,
            method: init.method ?? "GET",
            authorization: new Headers(init.headers).get("authorization"),
        })
        return Response.json(
            profile("30", {
                guild_member: { guild_id: "20", user: { id: "30" } },
                guild_member_profile: guildFields(),
                email: "private@example.test",
            }),
        )
    })
    const api = await setup(mode)

    const result = await api.fetchProfile("30", { guildId: "20" })

    expect(result).toEqual({
        user: {
            id: "30",
            username: "fixture",
            discriminator: "0001",
            displayName: "Fixture",
            avatar: "avatar-hash",
            avatarColor: 42,
            isBot: false,
            isSystem: false,
            flags: 7,
        },
        profile: {
            bio: "Account biography",
            pronouns: "they/them",
            banner: "banner-hash",
            bannerColor: 11,
            accentColor: 22,
        },
        guildProfile: {
            bio: "Guild biography",
            pronouns: "she/her",
            banner: "guild-banner-hash",
            accentColor: 33,
        },
        isLimited: false,
    })
    expect(
        Object.isFrozen(result) &&
            Object.isFrozen(result.user) &&
            Object.isFrozen(result.profile) &&
            Object.isFrozen(result.guildProfile),
    ).toBe(true)
    expect(Object.keys(result.profile)).toEqual(["bio", "pronouns", "banner", "bannerColor", "accentColor"])
    expect(Object.keys(result.guildProfile!)).toEqual(["bio", "pronouns", "banner", "accentColor"])
    expect(JSON.stringify(result)).not.toContain("private")
    expect(calls).toEqual([
        {
            path: "/v1/users/30/profile",
            query: "?guild_id=20",
            method: "GET",
            authorization: "Bot fixture",
        },
    ])
})

test.each(modes)("%s preserves privacy-limited nulls and an omitted banner colour", async (mode) => {
    rest(async () =>
        Response.json(
            profile("30", {
                user_profile: fields({ bio: null, pronouns: null, banner_color: undefined }),
                guild_member_profile: guildFields({ bio: null, pronouns: null }),
                profile_limited: true,
            }),
        ),
    )
    const api = await setup(mode)

    const result = await api.fetchProfile("30", { guildId: "20" })

    expect(result).toMatchObject({
        profile: { bio: null, pronouns: null, banner: "banner-hash", accentColor: 22 },
        guildProfile: { bio: null, pronouns: null, banner: "guild-banner-hash", accentColor: 33 },
        isLimited: true,
    })
    expect(Object.hasOwn(result.profile, "bannerColor")).toBe(false)
    expect(Object.hasOwn(result.guildProfile!, "bannerColor")).toBe(false)
})

test.each(modes)("%s validates profile request and contextual response identities", async (mode) => {
    const fetch = vi.fn()
    stubFetchWithHostedDiscovery(fetch)
    const api = await setup(mode)

    for (const request of [
        () => api.fetchProfile("bad"),
        () => api.fetchProfile("30", { guildId: "bad" }),
        () => api.fetchProfile("30", { unknown: true } as never),
    ])
        await expect(request()).rejects.toMatchObject({
            _tag: "UserOperationError",
            operation: "users.fetchProfile",
            reason: "input",
            outcome: "notDispatched",
        })
    expect(fetch).not.toHaveBeenCalled()

    let response: unknown = profile("31")
    rest(async () => Response.json(response))
    await expect(api.fetchProfile()).rejects.toMatchObject({
        _tag: "UserOperationError",
        operation: "users.fetchProfile",
        reason: "response",
        outcome: "unknown",
    })
    response = profile("30", { guild_member: { guild_id: "21", user: { id: "30" } } })
    await expect(api.fetchProfile("30", { guildId: "20" })).rejects.toMatchObject({ reason: "response" })
    response = profile("30", { guild_member: { guild_id: "20", user: { id: "31" } } })
    await expect(api.fetchProfile("30", { guildId: "20" })).rejects.toMatchObject({ reason: "response" })
    response = profile("30", { guild_member_profile: guildFields() })
    await expect(api.fetchProfile()).rejects.toMatchObject({ reason: "response" })
})

test.each(modes)("%s avoids all user-cache writes and invalidation", async (mode) => {
    let rejected = false
    rest(async (url) => {
        const path = new URL(url).pathname
        if (path === "/v1/users/30") return Response.json(user("30", { username: "cached" }))
        if (path === "/v1/users/30/profile")
            return rejected ? Response.json({}, { status: 403 }) : Response.json(profile())
        throw Error(`Unexpected profile request ${path}`)
    })
    const api = await setup(mode, { token: "fixture", cache: { users: true } })

    await api.fetchUser()
    const result = await api.fetchProfile()

    expect(result.user.username).toBe("fixture")
    await expect(api.getUser()).resolves.toMatchObject({ username: "cached" })
    rejected = true
    await expect(api.fetchProfile()).rejects.toMatchObject({ reason: "rejected" })
    await expect(api.getUser()).resolves.toMatchObject({ username: "cached" })
})

test.each(modes)("%s retries profile reads, redacts failure bodies, and awaits cancellation cleanup", async (mode) => {
    const api = await setup(mode)
    let calls = 0
    rest(async () => {
        calls += 1
        return calls === 1
            ? Response.json({ message: "private transient profile body" }, { status: 503 })
            : Response.json(profile())
    })
    await expect(api.fetchProfile()).resolves.toMatchObject({ user: { id: "30" } })
    expect(calls).toBe(2)

    calls = 0
    rest(async () => {
        calls += 1
        return Response.json({ message: "private rejected profile body" }, { status: 403 })
    })
    let failure: unknown
    try {
        await api.fetchProfile()
    } catch (error) {
        failure = error
    }
    expect(failure).toMatchObject({
        _tag: "UserOperationError",
        operation: "users.fetchProfile",
        reason: "rejected",
        outcome: "rejected",
        status: 403,
    })
    expect(JSON.stringify(failure)).not.toContain("private rejected profile body")
    expect(calls).toBe(1)

    let started = false
    let cleaned = false
    rest(
        (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
                started = true
                init.signal?.addEventListener(
                    "abort",
                    () =>
                        setTimeout(() => {
                            cleaned = true
                            reject(Error("profile cancellation"))
                        }, 15),
                    { once: true },
                )
            }),
    )
    const controller = new AbortController()
    if (mode === "default") {
        const pending = api.fetchProfile("30", undefined, { signal: controller.signal })
        await vi.waitFor(() => expect(started).toBe(true))
        controller.abort()
        await expect(pending).rejects.toMatchObject({ _tag: "CancelledError" })
    } else {
        const pending = Effect.runPromiseExit(api.native!.users.fetchProfile("30"), { signal: controller.signal })
        await vi.waitFor(() => expect(started).toBe(true))
        controller.abort()
        const exit = await pending
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }
    expect(cleaned).toBe(true)
})
