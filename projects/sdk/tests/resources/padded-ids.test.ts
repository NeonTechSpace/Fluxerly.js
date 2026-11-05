import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { createTestClient as createDefaultTestClient } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { createWebhookClient, format, hierarchy, snowflakes } from "../../src/index.js"
import { createWebhookClient as createNativeWebhook } from "../../src/effect.js"
import { modes, setup, type Mode } from "../support/both-apis.js"
import { stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { expectErr, settle } from "../support/settle.js"

// These follow Fluxer at commit 0098958f. Its SnowflakeType reads every request ID with String(value).trim(), then
// requires a decimal without leading zeros from 0 through the signed int64 maximum
// (packages/schema/src/primitives/SchemaPrimitives.ts:39-52, 110-116). So the SDK trims a caller's ID once and uses the
// trimmed ID for the request, its result and the cache. Each case below failed on the old code, which refused padded IDs

const notDispatched = { reason: "input", outcome: "notDispatched" }

type Seen = { path: string; query: string; method: string; body: any }

/** Record every operation request and answer it with an empty refusal, since only the request matters here */
function stubRest() {
    const requests: Seen[] = []
    stubFetchWithHostedDiscovery(async (url: string, init: RequestInit) => {
        const parsed = new URL(url)
        requests.push({
            path: parsed.pathname,
            query: parsed.search,
            method: init.method ?? "GET",
            body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
        })
        return Response.json({ code: "UNKNOWN_CHANNEL", message: "Unknown" }, { status: 404 })
    })
    return requests
}

/** The one request an operation sent, whatever the answer made of it */
async function sent(requests: Seen[], start: () => unknown): Promise<Seen> {
    const before = requests.length
    try {
        await settle(start() as never)
    } catch {
        // allow-silent: Only the request matters here, and the stub answer is a refusal
    }
    expect(requests.length).toBe(before + 1)
    return requests.at(-1)!
}

afterEach(() => vi.unstubAllGlobals())

test.each(modes)("%s trims padded IDs in paths, queries and bodies", async (mode) => {
    const api = await setup(mode, { token: "fixture_only" })
    const requests = stubRest()
    const path = (start: () => unknown) => sent(requests, start).then((request) => request.path)

    expect(await path(() => api.channels.fetch(" 10 "))).toBe("/api/v1/channels/10")
    expect(await path(() => api.guilds.fetch("\t20\n"))).toBe("/api/v1/guilds/20")
    expect(await path(() => api.users.fetch(" 30"))).toBe("/api/v1/users/30")
    expect(await path(() => api.members.fetch({ guildId: " 20 ", userId: " 30 " }))).toBe(
        "/api/v1/guilds/20/members/30",
    )
    expect(await path(() => api.webhooks.fetch("40 "))).toBe("/api/v1/webhooks/40")
    expect(await path(() => api.messages.edit({ channelId: " 10 ", id: " 50 " }, "Edited"))).toBe(
        "/api/v1/channels/10/messages/50",
    )

    const follow = await sent(requests, () => api.channels.follow(" 10 ", { targetChannelId: " 11 " }))
    expect(follow.path).toBe("/api/v1/channels/10/followers")
    expect(follow.body).toEqual({ webhook_channel_id: "11" })

    const reply = await sent(requests, () => api.messages.reply({ channelId: " 10 ", id: " 50 " }, "Reply"))
    expect(reply.path).toBe("/api/v1/channels/10/messages")
    expect(reply.body.message_reference).toMatchObject({ message_id: "50", channel_id: "10" })

    const send = await sent(requests, () =>
        api.messages.send(" 10 ", { content: "<@30>", allowedMentions: { users: [" 30 "] }, stickerIds: [" 60 "] }),
    )
    expect(send.path).toBe("/api/v1/channels/10/messages")
    expect(send.body).toMatchObject({ allowed_mentions: { users: ["30"] }, sticker_ids: ["60"] })

    const bulk = await sent(requests, () => api.messages.deleteMany(" 10 ", [" 50 ", "51 "]))
    expect(bulk.path).toBe("/api/v1/channels/10/messages/bulk-delete")
    expect(bulk.body).toEqual({ message_ids: ["50", "51"] })

    const history = await sent(requests, () => api.messages.fetchHistory(" 10 ", { before: " 50 " }))
    expect(history.path).toBe("/api/v1/channels/10/messages")
    expect(new URLSearchParams(history.query).get("before")).toBe("50")

    const overwrite = await sent(requests, () =>
        api.channels.setPermissionOverwrite(" 10 ", { id: " 70 ", type: "role", allow: 0n, deny: 0n }),
    )
    expect(overwrite.path).toBe("/api/v1/channels/10/permissions/70")
})

test.each(modes)("%s still refuses IDs that are invalid after trimming, as Fluxer does", async (mode) => {
    const api = await setup(mode, { token: "fixture_only" })
    const requests = stubRest()
    for (const id of ["", "   ", " 01 ", "1 2", "abc", "-1", "+1", "1.0", "1e3", "9223372036854775808"]) {
        expect(await expectErr(api.channels.fetch(id))).toMatchObject(notDispatched)
        expect(await expectErr(api.messages.send(id, "Hi"))).toMatchObject(notDispatched)
        expect(await expectErr(api.members.fetch({ guildId: "20", userId: id }))).toMatchObject(notDispatched)
        expect(await expectErr(api.messages.deleteMany("10", ["50", id]))).toMatchObject(notDispatched)
    }
    expect(requests).toHaveLength(0)
    // The largest ID Fluxer accepts, and 0, which its SnowflakeType also accepts
    expect((await sent(requests, () => api.channels.fetch(" 9223372036854775807 "))).path).toBe(
        "/api/v1/channels/9223372036854775807",
    )
    expect((await sent(requests, () => api.channels.fetch(" 0 "))).path).toBe("/api/v1/channels/0")
})

// Fluxer's SnowflakeType also accepts JSON integers (SchemaPrimitives.ts:39-40). The SDK refuses number IDs on purpose:
// Real IDs exceed Number.MAX_SAFE_INTEGER, so a number has usually lost digits before the SDK sees it
test.each(modes)("%s refuses number IDs and says why", async (mode) => {
    const api = await setup(mode, { token: "fixture_only" })
    const requests = stubRest()
    // A real ID read into a number, which has already lost its last digits
    for (const id of [10, Number("1234567890123456789")]) {
        const failure = await expectErr(api.channels.fetch(id as never))
        expect(failure).toMatchObject(notDispatched)
        expect(failure.message).toContain(
            "Channel IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    }
    expect(requests).toHaveLength(0)
})

/** A ready in-memory test client with a community, a channel, a role and a message in its caches */
async function cached(mode: Mode) {
    const cache = { guilds: true, channels: true, roles: true, members: true, users: true, messages: true } as const
    if (mode === "default") {
        const test = createDefaultTestClient({ cache })
        onTestFinished(() => test.shutdown())
        await test.ready()
        return { test, emit: (type: string, payload: unknown) => test.emit(type, payload), run: <A>(value: A) => value }
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const test = await Effect.runPromise(createNativeTestClient({ cache }).pipe(Scope.provide(scope)))
    await Effect.runPromise(test.ready())
    return {
        test,
        emit: (type: string, payload: unknown) => Effect.runPromise(test.emit(type, payload)),
        run: <A>(value: Effect.Effect<A>) => Effect.runSync(value),
    }
}

test.each(modes)("%s finds cached objects by padded IDs", async (mode) => {
    const { test, emit, run } = await cached(mode)
    const { fixtures } = test
    const guild = fixtures.guildCreate()
    const channel = guild.channels[0]!
    const role = guild.roles[0]!
    const message = fixtures.message()
    await emit("GUILD_CREATE", guild)
    await emit("MESSAGE_CREATE", message)
    const client = test.client as any
    const pad = (id: string) => ` ${id}\n`

    expect(run(client.guilds.get(pad(guild.id)))).toMatchObject({ id: guild.id })
    expect(run(client.channels.get(pad(channel.id)))).toMatchObject({ id: channel.id })
    expect(run(client.roles.get({ guildId: pad(guild.id), id: pad(role.id) }))).toMatchObject({ id: role.id })
    expect(run(client.members.get({ guildId: pad(guild.id), userId: pad(fixtures.ids.bot) }))).toMatchObject({
        userId: fixtures.ids.bot,
    })
    expect(run(client.messages.get({ channelId: pad(message.channel_id), id: pad(message.id) }))).toMatchObject({
        id: message.id,
    })
})

test("helpers read padded IDs as Fluxer does", () => {
    expect(snowflakes.parse(" 175928847299117063 ")).toBe(175928847299117063n)
    expect(snowflakes.isValid("\t175928847299117063\n")).toBe(true)
    expect(format.userMention(" 30 ")).toBe("<@30>")
    expect(snowflakes.isValid(" 01 ")).toBe(false)
    expect(snowflakes.isValid("9223372036854775808")).toBe(false)
})

test("role hierarchy helpers read padded IDs in snapshots", () => {
    const role = (id: string, position: number) => ({ guildId: " 1 ", id, position }) as never
    const high = role(" 3 ", 2)
    expect(hierarchy.compare(role("2", 1), role(" 2 ", 1))).toBe(0)
    expect(hierarchy.isAbove(high, role("2", 1))).toBe(true)
    const member = (userId: string, roleIds: string[]) => ({ guildId: "1 ", userId, roleIds }) as never
    expect(hierarchy.highestRole(member("10", [" 2", "3 "]), [role("2", 1), high])).toBe(high)
    expect(
        hierarchy.canManage({
            guild: { id: " 1", ownerId: "99 " } as never,
            actor: member(" 10 ", ["3"]),
            target: member("11", [" 2 "]),
            roles: [role("2", 1), high],
        }),
    ).toBe(true)
})

const invite = {
    code: "FixtureCode",
    type: 0,
    channel: { id: "10", type: 0, name: null },
    guild: { id: "20", name: "Guild" },
    presence_count: 1,
    max_age: 86400,
    member_count: 2,
    temporary: false,
    created_at: "2026-09-09T00:00:00.000Z",
    expires_at: null,
    uses: 0,
    max_uses: 0,
}

test.each(modes)("%s compares a successful answer with the trimmed ID", async (mode) => {
    const api = await setup(mode, { token: "fixture_only" })
    const paths: string[] = []
    stubFetchWithHostedDiscovery(async (url: string) => {
        paths.push(new URL(url).pathname)
        return Response.json(invite)
    })
    // The answer names channel 10, which matches the trimmed ID rather than the padded one
    expect(await settle(api.invites.create(" 10 "))).toMatchObject({ code: "FixtureCode", channel: { id: "10" } })
    expect(paths.at(-1)).toBe("/api/v1/channels/10/invites")
})

test.each(modes)("%s sends a padded webhook client ID trimmed", async (mode) => {
    const options = { id: " 100 ", token: "test_only_secret" }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const webhook =
        mode === "native"
            ? await Effect.runPromise(createNativeWebhook(options).pipe(Effect.provideService(Scope.Scope, scope)))
            : createWebhookClient(options)
    onTestFinished(async () => {
        const stopped = webhook.shutdown()
        await (Effect.isEffect(stopped) ? Effect.runPromise(stopped) : stopped)
    })
    const paths: string[] = []
    stubFetchWithHostedDiscovery(async (url: string) => {
        paths.push(new URL(url).pathname)
        return Response.json({
            id: "400",
            channel_id: "300",
            webhook_id: "100",
            content: "Hi",
            author: { id: "100", username: "Hook", bot: true },
        })
    })
    await settle(webhook.send("Hi"))
    expect(
        paths.filter((path) => path.includes("/webhooks/")).map((path) => path.split("/").slice(0, 5).join("/")),
    ).toEqual(["/api/v1/webhooks/100"])
})

test.each(modes)("%s deletes a cache entry by a padded key", async (mode) => {
    const { test, emit, run } = await cached(mode)
    const message = test.fixtures.message()
    await emit("MESSAGE_CREATE", message)
    const client = test.client as any
    client.cache.delete("messages", ` ${message.channel_id} : ${message.id} `)
    expect(run(client.messages.get({ channelId: message.channel_id, id: message.id }))).toBeUndefined()
})
