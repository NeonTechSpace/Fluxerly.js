import { createHash } from "node:crypto"
import { Effect, Exit, Scope } from "effect"
import type { ResultAsync } from "neverthrow"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createClient } from "../src/index.js"
import { createClient as createNative } from "../src/effect.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"
import { RateLimits, rateRoute } from "../src/internal/rate-limits.js"

afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

async function settle<A>(operation: ResultAsync<A, unknown> | Effect.Effect<A, unknown>) {
    if (Effect.isEffect(operation)) {
        const result = await Effect.runPromise(Effect.result(operation))
        return result._tag === "Failure" ? { error: result.failure } : { value: result.success }
    }
    const result = await operation
    return result.isErr() ? { error: result.error } : { value: result.value }
}

async function setup(mode: "default" | "native") {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] })
    const scope = Scope.makeUnsafe()
    const options = { token: "fixture-only-not-a-credential" }
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

function limited(template: string, remaining: number) {
    return new Response(null, {
        status: 204,
        headers: {
            "x-ratelimit-bucket": createHash("sha256").update(template).digest("hex").slice(0, 16),
            "x-ratelimit-remaining": String(remaining),
            "x-ratelimit-reset-after": "1",
        },
    })
}

for (const mode of ["default", "native"] as const) {
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
        expect(await settle(client.members.setNickname(target, "Fixture"))).toHaveProperty("value")
        expect(await settle(client.members.setRoles(target, []))).toHaveProperty("value")
        expect(await settle(client.members.setNickname(target, "Fixture"))).toHaveProperty("value")
        const queued = settle(client.members.setRoles(target, [], { timeoutMs: 100 }))
        await vi.advanceTimersByTimeAsync(110)
        expect(await queued).toMatchObject({ error: { reason: "timeout", outcome: "notDispatched" } })
        expect(calls).toBe(3)
    })
    test(`${mode}: learned sharing blocks a different operation on the same resource`, async () => {
        const client = await setup(mode)
        let calls = 0
        stubFetchWithHostedDiscovery(async () => limited("channel:typing::channel_id", ++calls === 3 ? 0 : 10))
        const target = { channelId: "20", id: "10" }
        await settle(client.messages.typing("20"))
        await settle(client.messages.delete(target))
        await settle(client.messages.typing("20"))
        const queued = settle(client.messages.delete(target, { timeoutMs: 100 }))
        await vi.advanceTimersByTimeAsync(110)
        expect(await queued).toMatchObject({ error: { reason: "timeout", outcome: "notDispatched" } })
        expect(calls).toBe(3)
        await vi.advanceTimersByTimeAsync(1000)
        expect(await settle(client.messages.delete(target))).toEqual({ value: undefined })
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
        await settle(client.messages.delete(target))
        await settle(client.messages.deleteAttachment(target, "30"))
        const independent = settle(client.messages.delete(target, { timeoutMs: 100 }))
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
        await settle(client.messages.deleteAttachment(first, "30"))
        await settle(client.messages.deleteAttachment(second, "31"))
        await settle(client.messages.deleteAttachment(first, "30"))
        const queued = settle(client.messages.deleteAttachment(second, "31", { timeoutMs: 100 }))
        await vi.advanceTimersByTimeAsync(110)
        expect(await queued).toMatchObject({ error: { outcome: "notDispatched" } })
        expect(calls).toBe(3)
    })
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

test("successful emoji metadata with an unresolved producer user binding pauses conservatively", () => {
    const state = new RateLimits()
    const route = rateRoute("GET", "/emojis/123/metadata", "emojis")
    const key = state.observe(state.begin(route), limited("guild:emoji:metadata::user_id", 10), 0)
    expect(key).toBe("overflow")
    expect(state.wait(channelRoute("20").key, 1)).toBe(1000)
    expect(state.wait(channelRoute("20").key, 1001)).toBe(0)
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
