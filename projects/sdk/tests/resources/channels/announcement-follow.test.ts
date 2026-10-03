import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import type { ChannelFollowInput } from "../../../src/index.js"
import { createTestClient as createDefaultTestClient } from "../../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../../src/effect-testing.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { settle } from "../../support/settle.js"

async function setup(mode: Mode) {
    const options = { cache: { channels: true } } as const
    const scope = Scope.makeUnsafe()
    const defaultTest = mode === "default" ? createDefaultTestClient(options) : undefined
    const nativeTest =
        mode === "native"
            ? await Effect.runPromise(createNativeTestClient(options).pipe(Scope.provide(scope)))
            : undefined
    onTestFinished(async () => {
        if (defaultTest) await defaultTest.shutdown()
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    return (defaultTest ?? nativeTest)!
}

test.each(modes)("%s follows into a text channel with an audit reason and can unfollow by webhook ID", async (mode) => {
    const api = await setup(mode)
    const follow = api.rest.respond("POST /channels/10/followers", { body: { channel_id: "10", webhook_id: "30" } })
    const unfollow = api.rest.respond("DELETE /webhooks/30", { status: 204 })

    const result = await settle(
        api.client.channels.follow("10", { targetChannelId: "20" }, { auditReason: "  Release feed  " }),
    )
    expect(result).toEqual({ channelId: "10", webhookId: "30" })
    expect(Object.isFrozen(result)).toBe(true)
    expect(follow.requests()).toHaveLength(1)
    expect(follow.requests()[0]).toMatchObject({
        method: "POST",
        path: "/channels/10/followers",
        body: { webhook_channel_id: "20" },
        headers: { "x-audit-log-reason": "Release feed" },
    })
    expect(await settle(api.client.webhooks.delete(result.webhookId))).toBeUndefined()
    expect(unfollow.requests()).toHaveLength(1)
    expect(api.requests()).toHaveLength(2)
})

test.each(modes)("%s sends no audit header when follow has no reason and captures the target once", async (mode) => {
    const api = await setup(mode)
    const route = api.rest.respond("POST /channels/10/followers", { body: { channel_id: "10", webhook_id: "30" } })
    let reads = 0
    const input = {
        get targetChannelId() {
            reads++
            return reads === 1 ? "20" : "21"
        },
    }
    await settle(api.client.channels.follow("10", input))
    expect(reads).toBe(1)
    expect(route.requests()[0]!.body).toEqual({ webhook_channel_id: "20" })
    expect(route.requests()[0]!.headers).not.toHaveProperty("x-audit-log-reason")
})

test.each(modes)("%s rejects mismatched and malformed follow acknowledgements without resending", async (mode) => {
    const api = await setup(mode)
    for (const body of [
        { channel_id: "20", webhook_id: "30" },
        { channel_id: "10" },
        { channel_id: "10", webhook_id: 30 },
    ]) {
        const route = api.rest.respond("POST /channels/10/followers", { body })
        await expect(settle(api.client.channels.follow("10", { targetChannelId: "20" }))).rejects.toMatchObject({
            _tag: "ChannelOperationError",
            operation: "channels.follow",
            reason: "response",
            outcome: "unknown",
            status: 200,
        })
        expect(route.requests()).toHaveLength(1)
        route.remove()
    }
})

test.each(modes)("%s does not resend a follow after its response is lost", async (mode) => {
    const api = await setup(mode)
    const route = api.rest.respond("POST /channels/10/followers", () => {
        throw new Error("Synthetic lost response")
    })
    await expect(settle(api.client.channels.follow("10", { targetChannelId: "20" }))).rejects.toMatchObject({
        _tag: "ChannelOperationError",
        operation: "channels.follow",
        reason: "network",
        outcome: "unknown",
    })
    expect(route.requests()).toHaveLength(1)
})

test.each(modes)("%s clears the channel cache only after a follow is dispatched", async (mode) => {
    const api = await setup(mode)
    api.rest.respond("GET /channels/20", {
        body: { id: "20", guild_id: "40", type: 0, name: "release-feed" },
    })
    const channel = await settle(api.client.channels.fetch("20"))
    await expect(settle(api.client.channels.follow("10", { targetChannelId: "invalid" }))).rejects.toMatchObject({
        reason: "input",
        outcome: "notDispatched",
    })
    expect(await settle(api.client.channels.get("20"))).toBe(channel)
    const route = api.rest.respond("POST /channels/10/followers", () => {
        throw new Error("Synthetic lost response")
    })
    await expect(settle(api.client.channels.follow("10", { targetChannelId: "20" }))).rejects.toMatchObject({
        reason: "network",
        outcome: "unknown",
    })
    expect(route.requests()).toHaveLength(1)
    expect(await settle(api.client.channels.get("20"))).toBeUndefined()
})

test.each(modes)("%s rejects invalid follow IDs, keys and audit reasons before dispatch", async (mode) => {
    const api = await setup(mode)
    for (const [channelId, input] of [
        ["invalid", { targetChannelId: "20" }],
        ["10", { targetChannelId: "invalid" }],
        ["10", { targetChannelId: "20", unsupported: true }],
        ["10", null],
    ] as const) {
        await expect(
            settle(api.client.channels.follow(channelId, input as unknown as ChannelFollowInput)),
        ).rejects.toMatchObject({
            _tag: "ChannelOperationError",
            operation: "channels.follow",
            reason: "input",
            outcome: "notDispatched",
        })
    }
    await expect(
        settle(api.client.channels.follow("10", { targetChannelId: "20" }, { auditReason: "\n" })),
    ).rejects.toMatchObject({ reason: "input", outcome: "notDispatched" })
    expect(api.requests()).toHaveLength(0)
})

test.each(modes)("%s decodes follower statistics without replacing a cached channel", async (mode) => {
    const api = await setup(mode)
    api.rest.respond("GET /channels/10", { body: { id: "10", guild_id: "40", type: 5, name: "announcements" } })
    const stats = api.rest.respond("GET /channels/10/follower-stats", { body: { channel_count: 4, guild_count: 2 } })
    const channel = await settle(api.client.channels.fetch("10"))
    const result = await settle(api.client.channels.fetchFollowerStats("10"))
    expect(result).toEqual({ channelCount: 4, guildCount: 2 })
    expect(Object.isFrozen(result)).toBe(true)
    expect(await settle(api.client.channels.get("10"))).toBe(channel)
    expect(stats.requests()[0]).toMatchObject({ method: "GET", path: "/channels/10/follower-stats", body: undefined })
    expect(stats.requests()[0]!.headers).not.toHaveProperty("x-audit-log-reason")
})

test.each(modes)("%s rejects invalid statistics and unsupported audit options", async (mode) => {
    const api = await setup(mode)
    for (const body of [
        { channel_count: -1, guild_count: 0 },
        { channel_count: 1 },
        { channel_count: 1, guild_count: null },
    ]) {
        const route = api.rest.respond("GET /channels/10/follower-stats", { body })
        await expect(settle(api.client.channels.fetchFollowerStats("10"))).rejects.toMatchObject({
            _tag: "ChannelOperationError",
            operation: "channels.fetchFollowerStats",
            reason: "response",
        })
        expect(route.requests()).toHaveLength(1)
        route.remove()
    }
    const before = api.requests().length
    await expect(
        settle(api.client.channels.fetchFollowerStats("10", { auditReason: "Not supported" } as never)),
    ).rejects.toMatchObject({ reason: "input", outcome: "notDispatched" })
    await expect(settle(api.client.channels.fetchFollowerStats("invalid"))).rejects.toMatchObject({
        reason: "input",
        outcome: "notDispatched",
    })
    expect(api.requests()).toHaveLength(before)
})
