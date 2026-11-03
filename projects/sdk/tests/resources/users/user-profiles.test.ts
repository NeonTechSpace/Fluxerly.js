import { setImmediate as turn } from "node:timers/promises"
import { Cause, Effect, Exit } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import type { RequestOptions, UserProfileQuery } from "../../../src/index.js"
import type { Client as NativeClient } from "../../../src/effect.js"
import { fixtureToken, modes, setup, type FixtureClientOptions, type Mode } from "../../support/both-apis.js"
import { driveSdkTime, sdkClock } from "../../support/client-clock.js"
import { settle } from "../../support/settle.js"
import { stubFetchWithHostedDiscovery } from "../../support/hosted-discovery.js"

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

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

function rest(handler: (url: string, init: RequestInit) => Promise<Response>) {
    stubFetchWithHostedDiscovery((url: string, init: RequestInit) =>
        url.endsWith("/gateway/bot")
            ? Promise.resolve(Response.json({ url: "wss://gateway.fluxer.com" }))
            : handler(url, init),
    )
}

/** A client for one API style with the profile and user reads these tests use */
async function profiles(mode: Mode, options?: FixtureClientOptions) {
    const client = await setup(mode, options)
    return {
        client,
        fetchProfile: (id = "30", query?: UserProfileQuery, options?: RequestOptions) =>
            settle(client.users.fetchProfile(id, query, options)),
        fetchUser: (id = "30") => settle(client.users.fetch(id)),
        getUser: (id = "30") => settle(client.users.get(id)),
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
    const api = await profiles(mode)

    const result = await api.fetchProfile("30", { guildId: "20" })

    expect(result).toStrictEqual({
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
    expect(JSON.stringify(result)).not.toContain("private")
    expect(calls).toEqual([
        {
            path: "/api/v1/users/30/profile",
            query: "?guild_id=20",
            method: "GET",
            authorization: `Bot ${fixtureToken}`,
        },
    ])
})

test.each(modes)("%s preserves privacy-limited nulls and an omitted banner color", async (mode) => {
    rest(async () =>
        Response.json(
            profile("30", {
                user_profile: fields({ bio: null, pronouns: null, banner_color: undefined }),
                guild_member_profile: guildFields({ bio: null, pronouns: null }),
                profile_limited: true,
            }),
        ),
    )
    const api = await profiles(mode)

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
    const api = await profiles(mode)

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
        if (path === "/api/v1/users/30") return Response.json(user("30", { username: "cached" }))
        if (path === "/api/v1/users/30/profile")
            return rejected ? Response.json({}, { status: 403 }) : Response.json(profile())
        throw Error(`Unexpected profile request ${path}`)
    })
    const api = await profiles(mode, { cache: { users: true } })

    await api.fetchUser()
    const result = await api.fetchProfile()

    expect(result.user.username).toBe("fixture")
    await expect(api.getUser()).resolves.toMatchObject({ username: "cached" })
    rejected = true
    await expect(api.fetchProfile()).rejects.toMatchObject({ reason: "rejected" })
    await expect(api.getUser()).resolves.toMatchObject({ username: "cached" })
})

test.each(modes)("%s retries profile reads, redacts failure bodies, and awaits cancellation cleanup", async (mode) => {
    const clock = sdkClock()
    const api = await profiles(mode)
    let calls = 0
    rest(async () => {
        calls += 1
        return calls === 1
            ? Response.json({ message: "private transient profile body" }, { status: 503 })
            : Response.json(profile())
    })
    await driveSdkTime(clock, expect(api.fetchProfile()).resolves.toMatchObject({ user: { id: "30" } }))
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
    // The aborted read finishes its cleanup only when the test releases it
    const cleanup = Promise.withResolvers<void>()
    let aborted = false
    rest(
        (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
                started = true
                init.signal?.addEventListener(
                    "abort",
                    () => {
                        aborted = true
                        void cleanup.promise.then(() => {
                            cleaned = true
                            reject(Error("profile cancellation"))
                        })
                    },
                    { once: true },
                )
            }),
    )
    // Prove the cancelled read still waits for the held cleanup, then release it
    const release = async (pending: Promise<unknown>) => {
        let settled = false
        const mark = () => {
            settled = true
        }
        void pending.then(mark, mark)
        await vi.waitFor(() => expect(aborted).toBe(true))
        // One host turn drains the promise jobs that would settle a read not waiting for its cleanup
        await turn()
        expect(settled).toBe(false)
        cleanup.resolve()
    }
    try {
        const controller = new AbortController()
        if (mode === "default") {
            const pending = api.fetchProfile("30", undefined, { signal: controller.signal })
            await vi.waitFor(() => expect(started).toBe(true))
            controller.abort()
            await release(pending)
            await expect(pending).rejects.toMatchObject({ _tag: "CancelledError" })
        } else {
            const pending = Effect.runPromiseExit((api.client as NativeClient).users.fetchProfile("30"), {
                signal: controller.signal,
            })
            await vi.waitFor(() => expect(started).toBe(true))
            controller.abort()
            await release(pending)
            const exit = await pending
            expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
        expect(cleaned).toBe(true)
    } finally {
        // Release the held cleanup so a failed assertion does not stall client shutdown
        cleanup.resolve()
    }
})

const badge = (extra: Record<string, unknown> = {}) => ({
    key: "staff",
    kind: "staff",
    label: "Fluxer Staff",
    asset: "0123456789abcdef",
    asset_url: null,
    aspect_ratio: null,
    caption: null,
    href: "https://fluxer.com/staff",
    ...extra,
})

test.each(modes)("%s keeps public profile badges in order, unknown kinds included", async (mode) => {
    let response: unknown = profile("30", {
        profile_badges: [
            badge({ small_asset: "fedcba9876543210", accessible_label: null, details: null, count: null }),
            badge({
                key: "custom:40",
                kind: "custom",
                label: "Event winner",
                asset: null,
                asset_url: "https://cdn.example.test/badges/40.webp",
                aspect_ratio: 2.5,
                caption: "#1",
                href: null,
                count: 3,
                accessible_label: "Event winner, 3 times",
                details: { title: "Event winner", lines: ["Spring", "Autumn"] },
            }),
            badge({ key: "future_kind", kind: "future_kind", label: "Something new", asset: null, extra: true }),
        ],
    })
    rest(async () => Response.json(response))
    const api = await profiles(mode)

    const result = await api.fetchProfile()

    expect(result.profileBadges).toStrictEqual([
        {
            key: "staff",
            kind: "staff",
            label: "Fluxer Staff",
            asset: "0123456789abcdef",
            assetUrl: null,
            smallAsset: "fedcba9876543210",
            aspectRatio: null,
            caption: null,
            href: "https://fluxer.com/staff",
        },
        {
            key: "custom:40",
            kind: "custom",
            label: "Event winner",
            asset: null,
            assetUrl: "https://cdn.example.test/badges/40.webp",
            aspectRatio: 2.5,
            caption: "#1",
            href: null,
            count: 3,
            accessibleLabel: "Event winner, 3 times",
            details: { title: "Event winner", lines: ["Spring", "Autumn"] },
        },
        {
            key: "future_kind",
            kind: "future_kind",
            label: "Something new",
            asset: null,
            assetUrl: null,
            aspectRatio: null,
            caption: null,
            href: "https://fluxer.com/staff",
        },
    ])
    expect(
        Object.isFrozen(result.profileBadges) &&
            result.profileBadges!.every(Object.isFrozen) &&
            Object.isFrozen(result.profileBadges![1]!.details) &&
            Object.isFrozen(result.profileBadges![1]!.details!.lines),
    ).toBe(true)

    // An empty list stays empty, and an instance that sends no list leaves the field out
    response = profile("30", { profile_badges: [] })
    expect((await api.fetchProfile()).profileBadges).toStrictEqual([])
    response = profile("30")
    expect(Object.hasOwn(await api.fetchProfile(), "profileBadges")).toBe(false)

    // Instances from before custom badges send neither key nor asset_url
    response = profile("30", { profile_badges: [badge({ key: undefined, asset_url: undefined })] })
    expect((await api.fetchProfile()).profileBadges).toMatchObject([{ key: "staff", assetUrl: null }])
})

test.each(modes)("%s rejects malformed profile badges as a malformed response", async (mode) => {
    let response: unknown
    rest(async () => Response.json(response))
    const api = await profiles(mode)
    for (const badges of [
        {},
        [null],
        [badge({ kind: 1 })],
        [badge({ label: undefined })],
        [badge({ asset: 1 })],
        [badge({ asset_url: 1 })],
        [badge({ aspect_ratio: 0 })],
        [badge({ count: 1.5 })],
        [badge({ details: { title: "x", lines: [1] } })],
    ]) {
        response = profile("30", { profile_badges: badges })
        await expect(api.fetchProfile()).rejects.toMatchObject({
            _tag: "UserOperationError",
            operation: "users.fetchProfile",
            reason: "response",
        })
    }
})
