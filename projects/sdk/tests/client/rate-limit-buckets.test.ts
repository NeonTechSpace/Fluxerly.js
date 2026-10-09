import { createHash } from "node:crypto"
import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient } from "../../src/index.js"
import { createClient as createNative } from "../../src/effect.js"
import { createTestClient as createDefaultTestClient } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { RateLimits, rateRoute } from "../../src/internal/rate-limits.js"
import { modes, type Mode } from "../support/both-apis.js"
import { fakeHostTime, hostTurnsUntil, outcome } from "../support/client-clock.js"

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
})

async function setup(mode: "default" | "native") {
    fakeHostTime()
    const scope = Scope.makeUnsafe()
    const options = { token: "fixture-only-not-a-credential" }
    const client =
        mode === "default"
            ? createClient(options)
            : await Effect.runPromise(createNative(options).pipe(Scope.provide(scope)))
    onTestFinished(async () => {
        await outcome(client.shutdown())
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return client
}

function limited(template: string, remaining: number, options: { limit?: number; resetAfter?: number } = {}) {
    return new Response(null, {
        status: 204,
        headers: {
            "x-ratelimit-bucket": createHash("sha256").update(template).digest("hex").slice(0, 16),
            "x-ratelimit-remaining": String(remaining),
            "x-ratelimit-reset-after": String(options.resetAfter ?? 1),
            ...(options.limit === undefined ? {} : { "x-ratelimit-limit": String(options.limit) }),
        },
    })
}

for (const mode of modes) {
    test(`${mode}: nickname and role-set PATCH operations learn Fluxer's shared member-update bucket`, async () => {
        const client = await setup(mode)
        let calls = 0
        stubFetchWithHostedDiscovery(async (url, init) => {
            expect(url).toBe("https://api.fluxer.app/v1/guilds/20/members/30")
            expect(init.method).toBe("PATCH")
            return Response.json(
                { user: { id: "30", username: "fixture" }, roles: [], joined_at: "2026-09-08T12:00:00Z" },
                {
                    headers: limited("guild:member:update::guild_id", ++calls === 3 ? 0 : 10).headers,
                },
            )
        })
        const target = { guildId: "20", userId: "30" }
        expect(await outcome(client.members.setNickname(target, "Fixture"))).toHaveProperty("value")
        expect(await outcome(client.members.setRoles(target, []))).toHaveProperty("value")
        expect(await outcome(client.members.setNickname(target, "Fixture"))).toHaveProperty("value")
        const queued = outcome(client.members.setRoles(target, [], { timeoutMs: 100 }))
        await vi.advanceTimersByTimeAsync(110)
        expect(await queued).toMatchObject({ error: { reason: "timeout", outcome: "notDispatched" } })
        expect(calls).toBe(3)
    })
    test(`${mode}: learned sharing blocks a different operation on the same resource`, async () => {
        const client = await setup(mode)
        let calls = 0
        stubFetchWithHostedDiscovery(async () => limited("channel:typing::channel_id", ++calls === 3 ? 0 : 10))
        const target = { channelId: "20", id: "10" }
        await outcome(client.messages.typing("20"))
        await outcome(client.messages.delete(target))
        await outcome(client.messages.typing("20"))
        const queued = outcome(client.messages.delete(target, { timeoutMs: 100 }))
        await vi.advanceTimersByTimeAsync(110)
        expect(await queued).toMatchObject({ error: { reason: "timeout", outcome: "notDispatched" } })
        expect(calls).toBe(3)
        await vi.advanceTimersByTimeAsync(1000)
        expect(await outcome(client.messages.delete(target))).toEqual({ value: undefined })
    })

    test(`${mode}: synthetic distinct same-channel DELETE buckets do not block each other`, async () => {
        const client = await setup(mode)
        let calls = 0
        stubFetchWithHostedDiscovery(async (url) => {
            calls++
            return url.includes("/attachments/")
                ? limited("attachment:delete", 0)
                : limited("channel:message:delete::channel_id", 10)
        })
        const target = { channelId: "20", id: "10" }
        await outcome(client.messages.delete(target))
        await outcome(client.messages.deleteAttachment(target, "30"))
        const independent = outcome(client.messages.delete(target, { timeoutMs: 100 }))
        await vi.advanceTimersByTimeAsync(110)
        expect(await independent).toEqual({ value: undefined })
        expect(calls).toBe(3)
    })

    test(`${mode}: a synthetic parameterless bucket shares across channels`, async () => {
        const client = await setup(mode)
        let calls = 0
        stubFetchWithHostedDiscovery(async () => limited("attachment:delete", ++calls === 3 ? 0 : 10))
        const first = { channelId: "20", id: "10" },
            second = { channelId: "21", id: "11" }
        await outcome(client.messages.deleteAttachment(first, "30"))
        await outcome(client.messages.deleteAttachment(second, "31"))
        await outcome(client.messages.deleteAttachment(first, "30"))
        const queued = outcome(client.messages.deleteAttachment(second, "31", { timeoutMs: 100 }))
        await vi.advanceTimersByTimeAsync(110)
        expect(await queued).toMatchObject({ error: { outcome: "notDispatched" } })
        expect(calls).toBe(3)
    })

    test(`${mode}: depleted leaky buckets admit one fair refill probe at a time`, async () => {
        const client = await setup(mode)
        const calls: string[] = []
        stubFetchWithHostedDiscovery(async (url, init) => {
            calls.push(`${init.method} ${url}`)
            return limited("channel:typing::channel_id", calls.length < 3 ? 3 - calls.length : 0, {
                limit: 4,
                resetAfter: 4,
            })
        })
        const target = { channelId: "20", id: "10" }
        expect(await outcome(client.messages.typing("20"))).toHaveProperty("value")
        expect(await outcome(client.messages.delete(target))).toHaveProperty("value")
        expect(await outcome(client.messages.typing("20"))).toHaveProperty("value")

        const first = outcome(client.messages.delete(target))
        const second = outcome(client.messages.typing("20"))
        const third = outcome(client.messages.delete(target))
        await vi.advanceTimersByTimeAsync(999)
        expect(calls).toHaveLength(3)
        await vi.advanceTimersByTimeAsync(1)
        expect(calls).toHaveLength(4)
        expect(await first).toEqual({ value: undefined })
        await vi.advanceTimersByTimeAsync(999)
        expect(calls).toHaveLength(4)
        await vi.advanceTimersByTimeAsync(1)
        expect(calls).toHaveLength(5)
        expect(await second).toEqual({ value: undefined })
        await vi.advanceTimersByTimeAsync(1000)
        expect(calls).toHaveLength(6)
        expect(await third).toEqual({ value: undefined })
        expect(calls.slice(3).map((call) => call.split(" ", 1)[0])).toEqual(["DELETE", "POST", "DELETE"])
    })

    test(`${mode}: a precise 429 body schedules the route retry before its rounded header`, async () => {
        const client = await setup(mode)
        let calls = 0
        stubFetchWithHostedDiscovery(async () => {
            calls++
            if (calls > 1) return limited("channel:typing::channel_id", 0, { limit: 4, resetAfter: 4 })
            const headers = limited("channel:typing::channel_id", 0, { limit: 4, resetAfter: 4 }).headers
            headers.set("retry-after", "1")
            return Response.json({ retry_after: 0.428 }, { status: 429, headers })
        })
        const operation = outcome(client.messages.typing("20"))
        await vi.advanceTimersByTimeAsync(0)
        expect(calls).toBe(1)
        await vi.advanceTimersByTimeAsync(427)
        expect(calls).toBe(1)
        await vi.advanceTimersByTimeAsync(1)
        expect(await operation).toEqual({ value: undefined })
        expect(calls).toBe(2)
    })
}

const announcementBuckets = [
    { operation: "follow", hash: "178d355aa4cdba76", route: "POST /channels/:channel/followers" },
    { operation: "fetchFollowerStats", hash: "ba708c5c56887621", route: "GET /channels/:channel/follower-stats" },
    { operation: "publish", hash: "a6f540055efc5dd3", route: "POST /channels/:channel/messages/:message/crosspost" },
    {
        operation: "fetchCrosspostSource",
        hash: "93dfc23c50db1e32",
        route: "GET /channels/:channel/messages/:message/crosspost-source",
    },
] as const

type AnnouncementOperation = (typeof announcementBuckets)[number]["operation"]

async function setupAnnouncementBuckets(mode: Mode) {
    fakeHostTime()
    const scope = Scope.makeUnsafe()
    const defaultTest = mode === "default" ? createDefaultTestClient() : undefined
    const nativeTest =
        mode === "native" ? await Effect.runPromise(createNativeTestClient().pipe(Scope.provide(scope))) : undefined
    onTestFinished(async () => {
        if (defaultTest) await defaultTest.shutdown()
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    const api = (defaultTest ?? nativeTest)!
    return {
        rest: api.rest,
        fixtures: api.fixtures,
        queued: () => api.client.diagnostics().rest.queuedRequests,
        call(operation: AnnouncementOperation, channelId: string, targetId: string, timeoutMs?: number) {
            const options = timeoutMs === undefined ? undefined : { timeoutMs }
            const target = { channelId, id: targetId }
            switch (operation) {
                case "follow":
                    return outcome(api.client.channels.follow(channelId, { targetChannelId: targetId }, options))
                case "fetchFollowerStats":
                    return outcome(api.client.channels.fetchFollowerStats(channelId, options))
                case "publish":
                    return outcome(api.client.messages.publish(target, options))
                case "fetchCrosspostSource":
                    return outcome(api.client.messages.fetchCrosspostSource(target, options))
            }
        },
    }
}

for (const mode of modes) {
    for (const { operation, hash, route } of announcementBuckets) {
        test(`${mode}: ${operation} learns its channel bucket without partitioning by message or follow target`, async () => {
            const api = await setupAnnouncementBuckets(mode)
            const counts = new Map<string, number>()
            const responses = api.rest.respond(route, (request) => {
                const parts = request.path.split("/")
                const channelId = parts[2]!
                const count = (counts.get(channelId) ?? 0) + 1
                counts.set(channelId, count)
                const body =
                    operation === "follow"
                        ? { channel_id: channelId, webhook_id: "40" }
                        : operation === "fetchFollowerStats"
                          ? { channel_count: 2, guild_count: 1 }
                          : operation === "publish"
                            ? api.fixtures.message({ id: parts[4]!, channel_id: channelId })
                            : {
                                  guild: {
                                      id: "40",
                                      name: "Fixture community",
                                      description: null,
                                      features: [],
                                      approximate_member_count: null,
                                      approximate_presence_count: null,
                                      discoverable: false,
                                  },
                              }
                return {
                    body,
                    headers: {
                        "x-ratelimit-bucket": hash,
                        "x-ratelimit-remaining": channelId === "20" && count >= 2 ? "0" : "10",
                        "x-ratelimit-reset-after": "1",
                    },
                }
            })

            // Both channels must learn the same provider hash before one is depleted. An unknown
            // hash shares conservatively, so removing the parameterized registry entry fails isolation.
            expect(await api.call(operation, "20", "30")).toHaveProperty("value")
            expect(await api.call(operation, "21", "31")).toHaveProperty("value")
            expect(await api.call(operation, "20", "32")).toHaveProperty("value")

            let sameChannelSettled = false
            const sameChannel = api.call(operation, "20", "33", 100).then((result) => {
                sameChannelSettled = true
                return result
            })
            // Observe admission through public diagnostics without advancing the clock or polling elapsed time.
            await hostTurnsUntil(() => sameChannelSettled || api.queued() === 1)
            let otherChannelSettled = false
            const otherChannel = api.call(operation, "21", "34", 100).then((result) => {
                otherChannelSettled = true
                return result
            })
            await hostTurnsUntil(() => otherChannelSettled || api.queued() === 2)
            await vi.advanceTimersByTimeAsync(100)

            expect(await sameChannel).toMatchObject({ error: { reason: "timeout", outcome: "notDispatched" } })
            expect(await otherChannel).toHaveProperty("value")
            expect(responses.requests().map((request) => request.path.split("/")[2])).toEqual(["20", "21", "20", "21"])
            if (operation === "follow")
                expect(responses.requests().map((request) => request.body)).toEqual([
                    { webhook_channel_id: "30" },
                    { webhook_channel_id: "31" },
                    { webhook_channel_id: "32" },
                    { webhook_channel_id: "34" },
                ])

            await vi.advanceTimersByTimeAsync(900)
            expect(await api.call(operation, "20", "35")).toHaveProperty("value")
            expect(responses.requests()).toHaveLength(5)
        })
    }
}

const channelRoute = (channel: string, method = "GET") => rateRoute(method, `/channels/${channel}/messages/10`, channel)

test("learned channel buckets isolate resources and scheduler owners", () => {
    const state = new RateLimits(),
        other = new RateLimits()
    const first = channelRoute("20"),
        second = channelRoute("21")
    state.observe(state.begin(first), limited("channel:message:read::channel_id", 0), 0)
    state.observe(state.begin(second), limited("channel:message:read::channel_id", 10), 0)
    expect(state.wait(first.key, 1)).toBe(1000)
    expect(state.wait(second.key, 1)).toBe(0)
    expect(other.wait(first.key, 1)).toBe(0)
})

test("guild, user and webhook resource bindings stay separate, including nested guild leave paths", () => {
    for (const [template, firstPath, secondPath, firstWebhook, secondWebhook] of [
        ["guild:leave::guild_id", "/users/@me/guilds/20", "/users/@me/guilds/21"],
        ["user:profile::target_id", "/users/20/profile", "/users/21/profile"],
        ["webhook:message_get::webhook_id", "/messages/10", "/messages/10", "20", "21"],
    ]) {
        const state = new RateLimits()
        const first = rateRoute("GET", firstPath!, "20", undefined, firstWebhook)
        const second = rateRoute("GET", secondPath!, "21", undefined, secondWebhook)
        state.observe(state.begin(first), limited(template!, 0), 0)
        state.observe(state.begin(second), limited(template!, 10), 0)
        expect(state.wait(first.key, 1)).toBe(1000)
        expect(state.wait(second.key, 1)).toBe(0)
    }
})

// Fluxer 4749eb7f: ChannelRateLimitConfig and GuildRateLimitConfig give every thread, thread member and forum post route
// a bucket that is enforced per channel or community. A thread is a channel, so thread-member routes use the thread's ID
test("thread, thread member and forum post buckets stay separate per channel or community", () => {
    for (const [template, method, firstPath, secondPath] of [
        ["channel:thread:create::channel_id", "POST", "/channels/20/threads", "/channels/21/threads"],
        [
            "channel:thread:create::channel_id",
            "POST",
            "/channels/20/messages/9/threads",
            "/channels/21/messages/9/threads",
        ],
        ["guild:threads:active::guild_id", "GET", "/guilds/20/threads/active", "/guilds/21/threads/active"],
        [
            "channel:threads:archived:list::channel_id",
            "GET",
            "/channels/20/threads/archived/public?limit=50",
            "/channels/21/threads/archived/public?limit=50",
        ],
        [
            "channel:threads:search::channel_id",
            "GET",
            "/channels/20/threads/search?name=a",
            "/channels/21/threads/search?name=a",
        ],
        [
            "channel:thread:member:put::channel_id",
            "PUT",
            "/channels/20/thread-members/@me",
            "/channels/21/thread-members/@me",
        ],
        [
            "channel:thread:member:put::channel_id",
            "PUT",
            "/channels/20/thread-members/40",
            "/channels/21/thread-members/40",
        ],
        [
            "channel:thread:member:delete::channel_id",
            "DELETE",
            "/channels/20/thread-members/40",
            "/channels/21/thread-members/40",
        ],
        [
            "channel:thread:member:get::channel_id",
            "GET",
            "/channels/20/thread-members/40",
            "/channels/21/thread-members/40",
        ],
        [
            "channel:thread:members:list::channel_id",
            "GET",
            "/channels/20/thread-members?limit=100",
            "/channels/21/thread-members?limit=100",
        ],
        [
            "channel:thread:member:settings::channel_id",
            "PATCH",
            "/channels/20/thread-members/@me/settings",
            "/channels/21/thread-members/@me/settings",
        ],
        ["channel:post_data::channel_id", "POST", "/channels/20/post-data", "/channels/21/post-data"],
    ] as const) {
        const state = new RateLimits()
        const first = rateRoute(method, firstPath, "20")
        const second = rateRoute(method, secondPath, "21")
        state.observe(state.begin(first), limited(template, 0), 0)
        state.observe(state.begin(second), limited(template, 10), 0)
        expect(state.wait(first.key, 1)).toBe(1000)
        expect(state.wait(second.key, 1)).toBe(0)
    }
})

test("older responses cannot remap a newer bucket or reopen exhausted capacity", () => {
    const state = new RateLimits(),
        route = channelRoute("20")
    const older = state.begin(route),
        newer = state.begin(route)
    state.observe(newer, limited("channel:message:read::channel_id", 0), 0)
    state.observe(older, limited("channel:pins::channel_id", 10), 10)
    expect(state.wait(route.key, 20)).toBe(1000)
    state.observe(state.begin(route), limited("channel:message:read::channel_id", 10), 30)
    expect(state.wait(route.key, 40)).toBe(1030)
})

test("zero remaining uses one conservative refill probe without inferring a reusable leak rate", () => {
    const state = new RateLimits()
    const route = channelRoute("20")
    state.observe(state.begin(route), limited("channel:message:read::channel_id", 0, { limit: 4, resetAfter: 4 }), 0)
    expect(state.wait(route.key, 999)).toBe(1000)
    expect(state.wait(route.key, 1000)).toBe(0)
    state.reserve(route.key, 1000)
    const probe = state.begin(route)
    expect(state.wait(route.key, 1000)).toBe(4000)
    state.observe(probe, limited("channel:message:read::channel_id", 0, { limit: 4, resetAfter: 4 }), 1001)
    expect(state.wait(route.key, 1002)).toBe(2001)
})

test("a precise 429 delay can shorten only its own observed refill probe", () => {
    const state = new RateLimits()
    const route = channelRoute("20")
    const first = state.begin(route)
    const key = state.observe(first, limited("channel:message:read::channel_id", 0, { limit: 4, resetAfter: 4 }), 0)
    state.pause(key, 428, 0, first.sequence)
    expect(state.wait(route.key, 1)).toBe(428)

    const newer = state.begin(route)
    state.observe(newer, limited("channel:message:read::channel_id", 0, { limit: 4, resetAfter: 8 }), 10)
    state.pause(key, 100, 10, first.sequence)
    expect(state.wait(route.key, 11)).toBe(2010)
})

test("a completed refill probe may restore only the remaining capacity it observes", () => {
    const state = new RateLimits()
    const route = channelRoute("20")
    state.observe(state.begin(route), limited("channel:message:read::channel_id", 0, { limit: 4, resetAfter: 4 }), 0)
    state.reserve(route.key, 1000)
    const probe = state.begin(route)
    state.observe(probe, limited("channel:message:read::channel_id", 2, { limit: 4, resetAfter: 2 }), 1001)
    expect(state.wait(route.key, 1002)).toBe(0)
    state.reserve(route.key, 1002)
    expect(state.wait(route.key, 1002)).toBe(0)
    state.reserve(route.key, 1002)
    expect(state.wait(route.key, 1002)).toBe(4000)
})

test("incomplete or changing leaky-bucket metadata retains the full-reset fallback", () => {
    const route = channelRoute("20")
    for (const response of [
        limited("channel:message:read::channel_id", 0, { resetAfter: 4 }),
        limited("channel:message:read::channel_id", 0, { limit: 0, resetAfter: 4 }),
    ]) {
        const state = new RateLimits()
        state.observe(state.begin(route), response, 0)
        expect(state.wait(route.key, 1000)).toBe(4000)
    }

    const state = new RateLimits()
    state.observe(state.begin(route), limited("channel:message:read::channel_id", 0, { limit: 4, resetAfter: 4 }), 0)
    state.observe(state.begin(route), limited("channel:message:read::channel_id", 0, { limit: 8, resetAfter: 4 }), 10)
    expect(state.wait(route.key, 1000)).toBe(4010)
})

test("relative refill pacing is independent of the provider's absolute clock", () => {
    const state = new RateLimits()
    const route = channelRoute("20")
    const response = limited("channel:message:read::channel_id", 0, { limit: 4, resetAfter: 4 })
    response.headers.set("x-ratelimit-reset", "1")
    state.observe(state.begin(route), response, 100)
    expect(state.wait(route.key, 1099)).toBe(1100)
})

test("an older response cannot release a newer refill probe", () => {
    const state = new RateLimits()
    const route = channelRoute("20")
    state.observe(state.begin(route), limited("channel:message:read::channel_id", 0, { limit: 4, resetAfter: 4 }), 0)
    const older = state.begin(route)
    state.reserve(route.key, 1000)
    const probe = state.begin(route)
    state.observe(older, limited("channel:message:read::channel_id", 0, { limit: 4, resetAfter: 4 }), 1001)
    expect(state.wait(route.key, 1002)).toBe(5001)
    state.observe(probe, limited("channel:message:read::channel_id", 0, { limit: 4, resetAfter: 4 }), 1003)
    expect(state.wait(route.key, 1004)).toBe(2003)
})

test("a later unmapped route cannot unlock or overrule an outstanding refill probe", () => {
    const state = new RateLimits()
    const route = channelRoute("20")
    const otherRoute = channelRoute("20", "POST")
    state.observe(state.begin(route), limited("channel:message:read::channel_id", 0, { limit: 4, resetAfter: 4 }), 0)
    state.reserve(route.key, 1000)
    const probe = state.begin(route)
    const other = state.begin(otherRoute)
    const key = state.observe(other, limited("channel:message:read::channel_id", 0, { limit: 4, resetAfter: 4 }), 1001)
    expect(state.wait(route.key, 1002)).toBe(5001)
    state.pause(key, 1500, 1002, other.sequence)
    expect(state.wait(route.key, 1003)).toBe(5001)

    state.observe(probe, limited("channel:message:read::channel_id", 2, { limit: 4, resetAfter: 2 }), 1004)
    expect(state.wait(route.key, 1005)).toBe(5001)
})

test("a later unmapped denial closes capacity restored by the exact refill probe", () => {
    const state = new RateLimits()
    const route = channelRoute("20")
    const otherRoute = channelRoute("20", "POST")
    state.observe(state.begin(route), limited("channel:message:read::channel_id", 0, { limit: 4, resetAfter: 4 }), 0)
    state.reserve(route.key, 1000)
    const probe = state.begin(route)
    const other = state.begin(otherRoute)
    state.observe(probe, limited("channel:message:read::channel_id", 2, { limit: 4, resetAfter: 2 }), 1001)
    expect(state.wait(route.key, 1002)).toBe(0)
    state.observe(other, limited("channel:message:read::channel_id", 0, { limit: 4, resetAfter: 4 }), 1003)
    expect(state.wait(route.key, 1004)).toBe(2003)
})

test("an idle alias cannot expire while its single refill probe is due", () => {
    const state = new RateLimits()
    const route = channelRoute("20")
    state.observe(state.begin(route), limited("channel:message:read::channel_id", 0, { limit: 2, resetAfter: 600 }), 0)
    expect(state.wait(route.key, 300_001)).toBe(0)
    state.reserve(route.key, 300_001)
    state.begin(route)
    expect(state.wait(route.key, 300_001)).toBe(600_000)
})

test("remapping keeps an unexpired prior denial without joining independent buckets permanently", () => {
    const state = new RateLimits(),
        route = channelRoute("20")
    state.observe(state.begin(route), limited("channel:message:read::channel_id", 0), 0)
    state.observe(state.begin(route), limited("channel:pins::channel_id", 10), 10)
    expect(state.wait(route.key, 20)).toBe(1000)
    expect(state.wait(route.key, 1001)).toBe(0)
    state.observe(state.begin(channelRoute("20", "POST")), limited("channel:message:read::channel_id", 0), 1002)
    expect(state.wait(route.key, 1003)).toBe(0)
})

test("idle aliases expire, while aliases carrying an active denial remain effective", () => {
    const state = new RateLimits(),
        first = channelRoute("20"),
        second = channelRoute("20", "POST")
    state.observe(state.begin(first), limited("channel:message:read::channel_id", 10), 0)
    state.observe(state.begin(second), limited("channel:message:read::channel_id", 10), 0)
    expect(state.wait(second.key, 300_001)).toBe(0)
    state.observe(state.begin(first), limited("channel:message:read::channel_id", 0), 300_002)
    expect(state.wait(second.key, 300_003)).toBe(0)
    const held = limited("channel:pins::channel_id", 0)
    held.headers.set("x-ratelimit-reset-after", "600")
    state.observe(state.begin(second), held, 300_004)
    expect(state.wait(second.key, 600_005)).toBe(900_004)
})

test("unknown templates are conservatively shared, and missing declared resources cannot bypass a denial", () => {
    const state = new RateLimits(),
        first = channelRoute("20"),
        second = channelRoute("21")
    state.observe(state.begin(first), limited("future-template", 10), 0)
    state.observe(state.begin(second), limited("future-template", 0), 0)
    expect(state.wait(first.key, 1)).toBe(1000)
    const noResource = rateRoute("GET", "/new-route", "new")
    const response = new Response(null, {
        status: 429,
        headers: {
            "x-ratelimit-bucket": createHash("sha256").update("channel:pins::channel_id").digest("hex").slice(0, 16),
        },
    })
    const key = state.observe(state.begin(noResource), response, 1001)
    state.pause(key, 2001, 1001)
    expect(state.wait(second.key, 1002)).toBe(2001)
})

test("expression lookups share one caller-wide bucket without pausing unrelated routes", () => {
    for (const [template, kind] of [
        ["guild:emoji:metadata::user_id", "emojis"],
        ["guild:emoji:source::user_id", "emojis"],
        ["guild:sticker:metadata::user_id", "stickers"],
        ["guild:sticker:source::user_id", "stickers"],
    ] as const) {
        const state = new RateLimits()
        const first = rateRoute("GET", `/${kind}/123/source`, kind)
        const second = rateRoute("GET", `/${kind}/456/source`, kind)
        // A success with capacity left must not hold back an unrelated channel request
        expect(state.observe(state.begin(first), limited(template, 10), 0)).not.toBe("overflow")
        expect(state.wait(channelRoute("20").key, 1)).toBe(0)
        // Fluxer keeps one bucket per caller, so exhausting it through one expression also delays the other
        state.observe(state.begin(second), limited(template, 0), 2)
        expect(state.wait(first.key, 3)).toBe(1002)
        expect(state.wait(channelRoute("20").key, 3)).toBe(0)
    }
})

test("provisional identities separate endpoint shapes and secrets stay out of retained keys", () => {
    expect(channelRoute("20").key).toBe(rateRoute("GET", "/channels/20/messages/11?limit=20", "20").key)
    expect(channelRoute("20").key).not.toBe(rateRoute("GET", "/channels/20/messages", "20").key)
    const first = rateRoute("GET", "/invites/private-code", "invites")
    const second = rateRoute("GET", "/invites/another-code", "invites")
    expect(first.key).not.toContain("private-code")
    expect(first.key).not.toBe(second.key)
    const state = new RateLimits()
    state.observe(state.begin(first), limited("invite:read::invite_code", 0), 0)
    state.observe(state.begin(second), limited("invite:read::invite_code", 10), 0)
    expect(state.wait(first.key, 1)).toBe(1000)
    expect(state.wait(second.key, 1)).toBe(0)
})

test("tracking pressure retains active denials and clears every pause on shutdown", () => {
    const state = new RateLimits()
    for (let index = 0; index < 2049; index++) {
        const route = channelRoute(String(index + 1))
        state.observe(state.begin(route), limited("channel:message:read::channel_id", 0), 0)
    }
    expect(state.wait(channelRoute("9999").key, 1)).toBe(1000)
    expect(state.wait(channelRoute("1").key, 1)).toBe(1000)
    state.clear()
    expect(state.wait(channelRoute("9999").key, 1)).toBe(0)
    expect(state.wait(channelRoute("1").key, 1)).toBe(0)
})

test("safe alias eviction discards learning, not a live denial", () => {
    const state = new RateLimits()
    for (let index = 0; index < 2049; index++) {
        state.observe(state.begin(channelRoute(String(index + 1))), limited("account-wide", 10), 0)
    }
    state.observe(state.begin(channelRoute("2049")), limited("account-wide", 0), 1)
    expect(state.wait(channelRoute("1").key, 2)).toBe(0)
    expect(state.wait(channelRoute("2").key, 2)).toBe(1001)
})
