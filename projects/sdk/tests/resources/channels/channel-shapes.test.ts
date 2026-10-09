import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import {
    ChannelFlags,
    ChannelType,
    ForumLayout,
    isThreadChannel,
    type EventMap,
    type GuildChannel,
} from "../../../src/index.js"
import { createFixtures, createTestClient as createDefaultTestClient } from "../../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../../src/effect-testing.js"
import { decodeThreadMember } from "../../../src/internal/channel-decode.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { settle } from "../../support/settle.js"

// Fluxer 4749eb7f: ThreadMappers.mapThreadToResponse, ThreadParentSettings.mapThreadParentFields and the thread,
// forum and channel documents describe the payloads below

test.each(modes)("%s reads each thread type into its own shape with flattened metadata", async (mode) => {
    const api = await open(mode)
    const { fixtures } = api
    const announcement = fixtures.thread({ type: 10, name: "launch notes" })
    const post = fixtures.thread({
        applied_tags: ["70"],
        flags: ChannelFlags.Pinned,
        member: { join_timestamp: "2026-01-02T00:00:00.000Z", flags: 2 },
        message_count: 3,
        total_message_sent: 4,
        member_count: 2,
    })
    const privateThread = fixtures.thread({ type: 12 })
    for (const thread of [announcement, post, privateThread])
        api.rest.respond(`GET /channels/${thread.id}`, { body: thread })

    const readAnnouncement = await api.fetch(announcement.id)
    expect(readAnnouncement).toEqual({
        id: announcement.id,
        guildId: fixtures.ids.guild,
        type: ChannelType.AnnouncementThread,
        parentId: fixtures.ids.channel,
        ownerId: fixtures.ids.user,
        name: "launch notes",
        archived: false,
        locked: false,
        autoArchiveMinutes: 4320,
        archiveTimestamp: "2026-01-01T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastMessageId: null,
        lastPinTimestamp: null,
        rateLimitPerUser: 0,
        flags: 0,
        messageCount: 0,
        totalMessageSent: 0,
        memberCount: 1,
    })
    expect(isThreadChannel(readAnnouncement)).toBe(true)
    expect(Object.isFrozen(readAnnouncement)).toBe(true)

    const readPost = await api.fetch(post.id)
    expect(readPost).toMatchObject({
        type: ChannelType.PublicThread,
        appliedTagIds: ["70"],
        flags: ChannelFlags.Pinned,
        messageCount: 3,
        totalMessageSent: 4,
        memberCount: 2,
        membership: { joinedAt: "2026-01-02T00:00:00.000Z", flags: 2 },
    })
    expect(readPost).not.toHaveProperty("invitable")

    const readPrivate = await api.fetch(privateThread.id)
    expect(readPrivate).toMatchObject({ type: ChannelType.PrivateThread, invitable: true })
    expect(readPrivate).not.toHaveProperty("membership")
})

test.each(modes)("%s rejects thread payloads without the fields every thread has", async (mode) => {
    const api = await open(mode)
    const valid = api.fixtures.thread()
    const malformed = [
        { ...valid, owner_id: undefined },
        { ...valid, parent_id: null },
        { ...valid, name: undefined },
        { ...valid, thread_metadata: undefined },
        { ...valid, thread_metadata: { ...valid.thread_metadata, archive_timestamp: "yesterday" } },
        // Fluxer always reports invitable on a private thread
        { ...valid, type: 12 },
        { ...valid, member: { join_timestamp: "2026-01-02T00:00:00.000Z" } },
    ]
    let index = 0
    api.rest.respond(`GET /channels/${valid.id}`, () => ({ body: malformed[index++] }))
    for (const _ of malformed)
        await expect(api.fetch(valid.id)).rejects.toMatchObject({
            _tag: "ChannelOperationError",
            operation: "channels.fetch",
            reason: "response",
        })
    expect(index).toBe(malformed.length)
})

test.each(modes)("%s reads forum and media channels with their post settings, keeping unknown values", async (mode) => {
    const api = await open(mode)
    const forum = api.fixtures.forumChannel({
        flags: ChannelFlags.RequireTag | (1 << 20),
        available_tags: [
            { id: "70", name: "solved", moderated: false, emoji_id: null, emoji_name: "✅" },
            { id: "71", name: "staff", moderated: true, emoji_id: "72", emoji_name: null },
        ],
        default_reaction_emoji: { emoji_id: null, emoji_name: "👍" },
        default_sort_order: 1,
        default_forum_layout: ForumLayout.Grid,
        default_tag_setting: "match_future",
        default_auto_archive_duration: 1440,
        default_thread_rate_limit_per_user: 30,
        topic: "One question per post",
        last_pin_timestamp: "2026-01-01T00:00:00.000Z",
    })
    const media = api.fixtures.forumChannel({ type: 16, flags: ChannelFlags.HideMediaDownloadOptions })
    api.rest.respond(`GET /channels/${forum.id}`, { body: forum })
    api.rest.respond(`GET /channels/${media.id}`, { body: { ...media, default_forum_layout: 1 } })

    const readForum = await api.fetch(forum.id)
    expect(readForum).toMatchObject({
        type: ChannelType.Forum,
        topic: "One question per post",
        flags: ChannelFlags.RequireTag | (1 << 20),
        availableTags: [
            { id: "70", name: "solved", moderated: false, emojiId: null, emojiName: "✅" },
            { id: "71", name: "staff", moderated: true, emojiId: "72", emojiName: null },
        ],
        defaultReactionEmoji: { emojiId: null, emojiName: "👍" },
        defaultSortOrder: 1,
        defaultForumLayout: ForumLayout.Grid,
        defaultTagSetting: "match_future",
        defaultAutoArchiveMinutes: 1440,
        defaultThreadRateLimitPerUser: 30,
    })
    // A forum holds no messages of its own, so its shape leaves out the pin time Fluxer still sends
    expect(readForum).not.toHaveProperty("lastPinTimestamp")
    expect(isThreadChannel(readForum)).toBe(false)

    const readMedia = await api.fetch(media.id)
    expect(readMedia).toMatchObject({
        type: ChannelType.Media,
        flags: ChannelFlags.HideMediaDownloadOptions,
        availableTags: [],
        defaultReactionEmoji: null,
        defaultTagSetting: "match_some",
    })
    // Only a forum channel has a layout setting
    expect(readMedia).not.toHaveProperty("defaultForumLayout")
})

test.each(modes)(
    "%s reads thread defaults on text channels and keeps a future type unknown with its number",
    async (mode) => {
        const api = await open(mode)
        const { fixtures } = api
        const text = fixtures.channel({ default_auto_archive_duration: 60, default_thread_rate_limit_per_user: 5 })
        const future = fixtures.channel({ id: fixtures.nextId(), type: 13, default_auto_archive_duration: "x" })
        api.rest.respond(`GET /guilds/${fixtures.ids.guild}/channels`, { body: [text, future] })

        const [readText, readFuture] = await api.fetchAll(fixtures.ids.guild)
        expect(readText).toMatchObject({
            type: ChannelType.Text,
            defaultAutoArchiveMinutes: 60,
            defaultThreadRateLimitPerUser: 5,
        })
        expect(readFuture).toMatchObject({ id: future.id, type: "unknown", rawType: 13, name: "general" })
        expect(isThreadChannel(readFuture)).toBe(false)
    },
)

// Fluxer 4749eb7f: ChannelUtilsService.dispatchChannelDelete maps a forum channel without its post settings
test.each(modes)(
    "%s delivers forum and media channel events, including a deletion without post settings",
    async (mode) => {
        const api = await open(mode)
        const created: GuildChannel[] = []
        const deleted: GuildChannel[] = []
        await api.on("guildChannelCreate", (channel) => void created.push(channel))
        await api.on("guildChannelDelete", (channel) => void deleted.push(channel))
        await api.ready()
        const forum = api.fixtures.forumChannel()
        const media = api.fixtures.forumChannel({ type: 16 })
        const {
            flags: _flags,
            available_tags: _tags,
            default_reaction_emoji: _reaction,
            default_sort_order: _order,
            default_forum_layout: _layout,
            default_tag_setting: _setting,
            default_auto_archive_duration: _archive,
            default_thread_rate_limit_per_user: _slowmode,
            ...forumWithoutSettings
        } = forum

        await api.emit("CHANNEL_CREATE", forum)
        await api.emit("CHANNEL_CREATE", media)
        await api.emit("CHANNEL_DELETE", forumWithoutSettings)
        await api.idle()

        expect(created.map((channel) => channel.type)).toEqual([ChannelType.Forum, ChannelType.Media])
        expect(created[0]).toMatchObject({ availableTags: [], defaultForumLayout: 0 })
        expect(deleted).toHaveLength(1)
        expect(deleted[0]).toMatchObject({ id: forum.id, type: ChannelType.Forum, name: "fixture-forum" })
        expect(deleted[0]).not.toHaveProperty("availableTags")
    },
)

test("isThreadChannel accepts only the three thread types", () => {
    const base = { id: "1", guildId: "2" }
    for (const type of [ChannelType.AnnouncementThread, ChannelType.PublicThread, ChannelType.PrivateThread])
        expect(isThreadChannel({ ...base, type } as GuildChannel)).toBe(true)
    for (const type of [ChannelType.Text, ChannelType.Forum, ChannelType.Media, "unknown"])
        expect(isThreadChannel({ ...base, type } as GuildChannel)).toBe(false)
    expect(isThreadChannel(undefined)).toBe(false)
    expect(isThreadChannel(null as unknown as GuildChannel)).toBe(false)
})

// The thread member decoder is the contract for thread member reads and events: Fluxer 4749eb7f omits id on an inline
// membership, sends member null for a user without a guild membership and never carries the guild ID itself
test("decodes thread members with their thread and guild context", () => {
    const fixtures = createFixtures()
    const { guild_id: _guild, ...guildMember } = fixtures.member()
    const wire = { user_id: fixtures.ids.user, join_timestamp: "2026-01-02T00:00:00.000Z", flags: 3 }
    expect(decodeThreadMember({ ...wire, id: "70", member: guildMember }, fixtures.ids.guild)).toEqual({
        threadId: "70",
        userId: fixtures.ids.user,
        joinedAt: "2026-01-02T00:00:00.000Z",
        flags: 3,
        member: expect.objectContaining({ guildId: fixtures.ids.guild, userId: fixtures.ids.user }),
    })
    expect(decodeThreadMember({ ...wire, member: null }, fixtures.ids.guild, "70")).toEqual({
        threadId: "70",
        userId: fixtures.ids.user,
        joinedAt: "2026-01-02T00:00:00.000Z",
        flags: 3,
    })
    for (const [value, threadId] of [
        [wire, undefined],
        [{ ...wire, id: "71" }, "70"],
        [{ ...wire, id: "70", user_id: undefined }, undefined],
        [{ ...wire, id: "70", member: { user: {} } }, undefined],
    ] as const)
        expect(decodeThreadMember(value, fixtures.ids.guild, threadId)).toBeUndefined()
})

async function open(mode: Mode) {
    const options = { gateway: { ignoredEvents: [] } } as const
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
    const test = (defaultTest ?? nativeTest)!
    return {
        fixtures: test.fixtures,
        rest: test.rest,
        fetch: (channelId: string) =>
            defaultTest
                ? settle(defaultTest.client.channels.fetch(channelId))
                : settle(nativeTest!.client.channels.fetch(channelId)),
        fetchAll: (guildId: string) =>
            defaultTest
                ? settle(defaultTest.client.channels.fetchAll(guildId))
                : settle(nativeTest!.client.channels.fetchAll(guildId)),
        ready: () => (defaultTest ? defaultTest.ready() : Effect.runPromise(nativeTest!.ready())),
        idle: () => (defaultTest ? defaultTest.idle() : Effect.runPromise(nativeTest!.idle())),
        emit: async (type: string, value: unknown) =>
            defaultTest ? defaultTest.emit(type, value) : Effect.runPromise(nativeTest!.emit(type, value)),
        on: async <K extends "guildChannelCreate" | "guildChannelDelete">(
            event: K,
            handler: (value: EventMap[K]) => void,
        ) =>
            defaultTest
                ? void defaultTest.client.on(event, handler as never)
                : void (await Effect.runPromise(
                      nativeTest!.client
                          .on(event, (value) => Effect.sync(() => handler(value as EventMap[K])))
                          .pipe(Scope.provide(scope)),
                  )),
    }
}
