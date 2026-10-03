import { inspect } from "node:util"
import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import { WebhookType } from "../../../src/index.js"
import { WebhookType as NativeWebhookType } from "../../../src/effect.js"
import { createTestClient } from "../../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../../src/effect-testing.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { expectErr, settle } from "../../support/settle.js"

const secret = "synthetic_webhook_secret"
const incoming = (extra = {}) => ({
    id: "100",
    guild_id: "200",
    channel_id: "300",
    type: 1,
    name: "Deployments",
    avatar: null,
    token: secret,
    ...extra,
})
const follower = (extra = {}) => ({
    id: "101",
    guild_id: "200",
    channel_id: "300",
    type: 2,
    name: "Announcements",
    avatar: null,
    ...extra,
})

async function setup(mode: Mode) {
    if (mode === "default") {
        const harness = createTestClient()
        onTestFinished(() => harness.shutdown())
        return harness
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    return Effect.runPromise(createNativeTestClient().pipe(Effect.provideService(Scope.Scope, scope)))
}

test.each(modes)("%s lists, fetches, edits and deletes tokenless follower webhooks", async (mode) => {
    const harness = await setup(mode)
    const kinds = mode === "default" ? WebhookType : NativeWebhookType
    const followed = follower({
        source_guild: { id: "201", name: "Source community", icon: null },
        source_channel: { id: "301", name: "news" },
    })
    harness.rest.respond("GET /channels/300/webhooks", { body: [incoming(), followed] })
    harness.rest.respond("GET /guilds/200/webhooks", { body: [incoming(), followed] })
    harness.rest.respond("GET /webhooks/101", { body: followed })
    const edits = harness.rest.respond("PATCH /webhooks/101", {
        body: follower({ ...followed, name: "Renamed", channel_id: "302" }),
    })
    harness.rest.respond("DELETE /webhooks/101", { status: 204 })

    const channelList = await settle(harness.client.webhooks.fetchForChannel("300"))
    const guildList = await settle(harness.client.webhooks.fetchForGuild("200"))
    expect(guildList).toEqual(channelList)
    expect(channelList.map((webhook) => webhook.type)).toEqual([kinds.Incoming, kinds.ChannelFollower])
    expect(Object.isFrozen(channelList)).toBe(true)
    const fetched = await settle(harness.client.webhooks.fetch("101"))
    expect(fetched).toEqual(channelList[1])
    if (fetched.type !== kinds.ChannelFollower) throw new Error("Expected a follower webhook")
    expect(fetched.sourceGuild).toEqual({ id: "201", name: "Source community", icon: null })
    expect(fetched.sourceChannel).toEqual({ id: "301", name: "news" })
    expect(Object.isFrozen(fetched)).toBe(true)
    expect(Object.isFrozen(fetched.sourceGuild)).toBe(true)
    expect(Object.isFrozen(fetched.sourceChannel)).toBe(true)
    expect(fetched).not.toHaveProperty("token")
    expect(fetched).not.toHaveProperty("credentials")
    const edited = await settle(harness.client.webhooks.edit("101", { name: "Renamed", channelId: "302" }))
    expect(edited).toMatchObject({ type: kinds.ChannelFollower, name: "Renamed", channelId: "302" })
    expect(edits.requests()[0]?.body).toEqual({ name: "Renamed", channel_id: "302" })
    await settle(harness.client.webhooks.delete("101"))
    for (const value of [channelList, guildList, fetched, edited, harness.logs()]) {
        expect(JSON.stringify(value)).not.toContain(secret)
        expect(inspect(value, { showHidden: true, depth: 8 })).not.toContain(secret)
    }
})

test.each(modes)("%s preserves independently optional follower sources and optional icons", async (mode) => {
    const harness = await setup(mode)
    const responses = [
        follower(),
        follower({ source_guild: { id: "201", name: "Source community" } }),
        follower({ source_guild: { id: "201", name: "Source community", icon: "icon_hash" } }),
        follower({ source_channel: { id: "301", name: "news" } }),
    ]
    for (const response of responses) {
        harness.rest.respond("GET /webhooks/101", { body: response })
        const webhook = await settle(harness.client.webhooks.fetch("101"))
        if (webhook.type !== WebhookType.ChannelFollower) throw new Error("Expected a follower webhook")
        expect(webhook.sourceGuild).toEqual("source_guild" in response ? response.source_guild : undefined)
        expect(webhook.sourceChannel).toEqual("source_channel" in response ? response.source_channel : undefined)
        if (webhook.sourceGuild) expect(Object.isFrozen(webhook.sourceGuild)).toBe(true)
        if (webhook.sourceChannel) expect(Object.isFrozen(webhook.sourceChannel)).toBe(true)
    }
})

test.each(modes)("%s preserves an unknown webhook kind without inferring credentials", async (mode) => {
    const harness = await setup(mode)
    harness.rest.respond("GET /webhooks/101", {
        body: follower({
            type: 99,
            token: secret,
            source_guild: { id: "201", name: "Future source", icon: null, token: secret },
            source_channel: { id: "301", name: "future", private: secret },
        }),
    })
    const webhook = await settle(harness.client.webhooks.fetch("101"))
    expect(webhook.type).toBe("unknown")
    if (webhook.type !== "unknown") throw new Error("Expected an unknown webhook kind")
    expect(webhook.rawType).toBe(99)
    expect(webhook.sourceGuild).toEqual({ id: "201", name: "Future source", icon: null })
    expect(webhook.sourceChannel).toEqual({ id: "301", name: "future" })
    expect(Object.isFrozen(webhook)).toBe(true)
    expect(Object.isFrozen(webhook.sourceGuild)).toBe(true)
    expect(Object.isFrozen(webhook.sourceChannel)).toBe(true)
    expect(webhook).not.toHaveProperty("credentials")
    expect(JSON.stringify(webhook)).not.toContain(secret)
    expect(inspect(webhook, { showHidden: true, depth: 8 })).not.toContain(secret)
})

test.each(modes)("%s fails decoding malformed present source metadata", async (mode) => {
    const harness = await setup(mode)
    const malformed = [
        { source_guild: null },
        { source_guild: [] },
        { source_guild: { name: "Source" } },
        { source_guild: { id: "invalid", name: "Source" } },
        { source_guild: { id: "201" } },
        { source_guild: { id: "201", name: null } },
        { source_guild: { id: "201", name: "Source", icon: 7 } },
        { source_channel: null },
        { source_channel: [] },
        { source_channel: { name: "news" } },
        { source_channel: { id: "invalid", name: "news" } },
        { source_channel: { id: "301" } },
        { source_channel: { id: "301", name: null } },
    ]
    for (const extra of malformed) {
        harness.rest.respond("GET /webhooks/101", { body: follower(extra) })
        expect(await expectErr(harness.client.webhooks.fetch("101"))).toMatchObject({ reason: "response" })
    }
    harness.rest.respond("GET /channels/300/webhooks", {
        body: [incoming(), follower({ source_channel: { id: "301" } })],
    })
    expect(await expectErr(harness.client.webhooks.fetchForChannel("300"))).toMatchObject({ reason: "response" })
    harness.rest.respond("PATCH /webhooks/101", { body: follower({ source_guild: null }) })
    expect(await expectErr(harness.client.webhooks.edit("101", { name: "Renamed" }))).toMatchObject({
        reason: "response",
        outcome: "unknown",
    })
})

test.each(modes)("%s requires a numeric webhook kind instead of guessing incoming", async (mode) => {
    const harness = await setup(mode)
    for (const type of [undefined, null, "1", -1, 1.5, 2_147_483_648]) {
        harness.rest.respond("GET /webhooks/100", { body: incoming({ type }) })
        expect(await expectErr(harness.client.webhooks.fetch("100"))).toMatchObject({ reason: "response" })
    }
})

test.each(modes)("%s creates credentials only for incoming webhooks with a required valid token", async (mode) => {
    const harness = await setup(mode)
    harness.rest.respond("POST /channels/300/webhooks", { body: incoming() })
    const created = await settle(harness.client.webhooks.create("300", { name: "Deployments" }))
    expect(created.webhook.type).toBe(WebhookType.Incoming)
    expect(created.credentials.id).toBe(created.webhook.id)
    expect(created.credentials.revealToken()).toBe(secret)
    expect(JSON.stringify(created)).not.toContain(secret)
    for (const body of [
        incoming({ token: undefined }),
        incoming({ token: null }),
        incoming({ token: "" }),
        incoming({ token: "invalid/token" }),
        follower({ token: secret }),
        incoming({ type: 99 }),
    ]) {
        harness.rest.respond("POST /channels/300/webhooks", { body })
        expect(await expectErr(harness.client.webhooks.create("300", { name: "Deployments" }))).toMatchObject({
            reason: "response",
            outcome: "unknown",
        })
    }
    expect(JSON.stringify(harness.logs())).not.toContain(secret)
})
