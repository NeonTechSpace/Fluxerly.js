import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import { ChannelType, type ChannelCreate, type ChannelEdit, type GuildChannel } from "../../../src/index.js"
import { createTestClient as createDefaultTestClient } from "../../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../../src/effect-testing.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { settle } from "../../support/settle.js"

// Fluxer 597116a: ChannelCreateAnnouncementRequest shares ChannelCreateCommon with text creation
const channel = (type: number, extra: Record<string, unknown> = {}) => ({
    id: "10",
    guild_id: "20",
    type,
    name: "announcements",
    topic: "Release notices",
    position: 1,
    parent_id: null,
    last_message_id: "9",
    last_pin_timestamp: "2026-09-08T12:00:00.000Z",
    rate_limit_per_user: 15,
    nsfw: false,
    nsfw_override: null,
    content_warning_level: 0,
    content_warning_text: null,
    permission_overwrites: [],
    ...extra,
})

const projectedAnnouncement = {
    id: "10",
    guildId: "20",
    type: 5,
    topic: "Release notices",
    lastMessageId: "9",
    lastPinTimestamp: "2026-09-08T12:00:00.000Z",
    rateLimitPerUser: 15,
}

test.each(modes)("%s decodes announcement fields from REST reads and retains unknown channel types", async (mode) => {
    const api = await setup(mode)
    api.rest.respond("GET /channels/10", { body: channel(5) })
    api.rest.respond("GET /guilds/20/channels", { body: [channel(5), channel(71, { id: "11" })] })

    const received = await api.fetch()
    expect(received).toMatchObject(projectedAnnouncement)
    expect(received).not.toHaveProperty("rawType")
    expect(Object.isFrozen(received)).toBe(true)
    const listed = await api.fetchAll()
    expect(listed[0]).toMatchObject(projectedAnnouncement)
    expect(listed[1]).toMatchObject({ id: "11", type: "unknown", rawType: 71, topic: "Release notices" })
})

test.each(modes)("%s creates announcement channels and encodes conversion patches without a prefetch", async (mode) => {
    const api = await setup(mode)
    const created = api.rest.respond("POST /guilds/20/channels", (request) => ({
        body: channel(5, request.body as Record<string, unknown>),
    }))
    const edited = api.rest.respond("PATCH /channels/10", (request) => ({
        body: channel(5, request.body as Record<string, unknown>),
    }))

    expect(
        await api.create({
            type: ChannelType.Announcement,
            name: "announcements",
            topic: "Release notices",
            parentId: null,
            rateLimitPerUser: 15,
            permissionOverwrites: [],
            nsfw: false,
            nsfwOverride: null,
            contentWarningLevel: 0,
            contentWarningText: null,
        }),
    ).toMatchObject(projectedAnnouncement)
    expect(created.requests().map((request) => request.body)).toEqual([
        {
            type: 5,
            name: "announcements",
            topic: "Release notices",
            parent_id: null,
            rate_limit_per_user: 15,
            permission_overwrites: [],
            nsfw: false,
            nsfw_override: null,
            content_warning_level: 0,
            content_warning_text: null,
        },
    ])
    expect((await api.edit({ type: ChannelType.Announcement })).type).toBe(ChannelType.Announcement)
    expect((await api.edit({ type: ChannelType.Text, topic: "Converted" })).type).toBe(ChannelType.Text)
    expect(edited.requests().map((request) => request.body)).toEqual([{ type: 5 }, { type: 0, topic: "Converted" }])
    expect(api.requests().map((request) => request.method)).toEqual(["POST", "PATCH", "PATCH"])
})

test.each(modes)("%s rejects invalid conversion types locally without dispatch", async (mode) => {
    const api = await setup(mode)
    const route = api.rest.respond("PATCH /channels/10", { body: channel(5) })
    for (const type of [1, 2, 4, 998, 71, -1, null, "5", 5.5]) {
        await expect(api.edit({ type } as ChannelEdit)).rejects.toMatchObject({
            _tag: "ChannelOperationError",
            operation: "channels.edit",
            reason: "input",
            outcome: "notDispatched",
            inputValidation: { path: "type", constraint: "allowedValue" },
        })
    }
    expect(route.requests()).toEqual([])
    expect(api.requests()).toEqual([])
})

test.each(modes)(
    "%s replaces cached channel observations before delivering type-changing gateway updates",
    async (mode) => {
        const api = await setup(mode)
        api.rest.respond("GET /channels/10", { body: channel(0, { topic: "Before conversion" }) })
        const updates: GuildChannel[] = []
        const cached: Array<GuildChannel | undefined> = []
        await api.onUpdate(async (value) => {
            updates.push(value)
            cached.push(await api.get())
        })
        await api.ready()
        const previous = await api.fetch()
        expect(await api.get()).toBe(previous)

        await api.emit(channel(5))
        await api.idle()
        expect(updates).toHaveLength(1)
        expect(updates[0]).toMatchObject(projectedAnnouncement)
        expect(cached[0]).toBe(updates[0])
        expect(await api.get()).toBe(updates[0])
        expect(updates[0]).not.toHaveProperty("rawType")
        expect(Object.isFrozen(updates[0])).toBe(true)
        expect(previous.type).toBe(ChannelType.Text)
        expect(previous).toMatchObject({ topic: "Before conversion" })

        await api.emit(channel(0, { topic: "After conversion", rate_limit_per_user: 0 }))
        await api.idle()
        expect(updates).toHaveLength(2)
        expect(updates[1]).toMatchObject({ type: ChannelType.Text, topic: "After conversion", rateLimitPerUser: 0 })
        expect(cached[1]).toBe(updates[1])
        expect(await api.get()).toBe(updates[1])
    },
)

async function setup(mode: Mode) {
    const options = { cache: { channels: true }, gateway: { ignoredEvents: [] } } as const
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
    return {
        rest: (defaultTest ?? nativeTest)!.rest,
        requests: () => (defaultTest ?? nativeTest)!.requests(),
        fetch: () =>
            defaultTest
                ? settle(defaultTest.client.channels.fetch("10"))
                : settle(nativeTest!.client.channels.fetch("10")),
        fetchAll: () =>
            defaultTest
                ? settle(defaultTest.client.channels.fetchAll("20"))
                : settle(nativeTest!.client.channels.fetchAll("20")),
        create: (input: ChannelCreate) =>
            defaultTest
                ? settle(defaultTest.client.channels.create("20", input))
                : settle(nativeTest!.client.channels.create("20", input)),
        edit: (input: ChannelEdit) =>
            defaultTest
                ? settle(defaultTest.client.channels.edit("10", input))
                : settle(nativeTest!.client.channels.edit("10", input)),
        get: async () =>
            defaultTest ? defaultTest.client.channels.get("10") : settle(nativeTest!.client.channels.get("10")),
        ready: () => (defaultTest ? defaultTest.ready() : Effect.runPromise(nativeTest!.ready())),
        emit: async (value: unknown) =>
            defaultTest
                ? defaultTest.emit("CHANNEL_UPDATE", value)
                : Effect.runPromise(nativeTest!.emit("CHANNEL_UPDATE", value)),
        idle: () => (defaultTest ? defaultTest.idle() : Effect.runPromise(nativeTest!.idle())),
        onUpdate: async (handler: (value: GuildChannel) => Promise<void>) =>
            defaultTest
                ? defaultTest.client.on("guildChannelUpdate", handler)
                : Effect.runPromise(
                      nativeTest!.client
                          .on("guildChannelUpdate", (value) => Effect.promise(() => handler(value)))
                          .pipe(Scope.provide(scope)),
                  ),
    }
}
