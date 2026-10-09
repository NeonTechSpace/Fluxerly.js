import { setImmediate as turn } from "node:timers/promises"
import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import {
    ChannelType,
    ConfigurationError,
    type EventMap,
    type EventName,
    type GuildChannel,
    type MessageReference,
} from "../../src/index.js"
import {
    createTestClient as createDefaultTestClient,
    type TestClientOptions,
    type TestResponse,
} from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { modes, type Mode } from "../support/both-apis.js"
import { settle } from "../support/settle.js"

// Fluxer 4749eb7f: gateway/threads.md, gateway/events.md and the payloads built in guild_thread_dispatch.erl,
// guild_thread_view.erl and ThreadDispatch.ts describe the dispatches below

afterEach(() => {
    vi.useRealTimers()
})

const joined = { join_timestamp: "2026-01-02T00:00:00.000Z", flags: 2 }

/** One test client driven through either API style with the same promise-returning calls */
async function open(mode: Mode, options: TestClientOptions = {}) {
    const settings: TestClientOptions = { gateway: { ignoredEvents: [] }, ...options }
    const scope = Scope.makeUnsafe()
    const defaultTest = mode === "default" ? createDefaultTestClient(settings) : undefined
    const nativeTest =
        mode === "native"
            ? await Effect.runPromise(createNativeTestClient(settings as never).pipe(Scope.provide(scope)))
            : undefined
    onTestFinished(async () => {
        if (defaultTest) await defaultTest.shutdown()
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    const test = (defaultTest ?? nativeTest)!
    const { fixtures } = test
    return {
        fixtures,
        rest: test.rest,
        logs: () => test.logs(),
        commands: () => test.commands(),
        counters: () => test.counters(),
        state: () => test.client.state,
        ready: () => (defaultTest ? defaultTest.ready() : Effect.runPromise(nativeTest!.ready())),
        idle: () => (defaultTest ? defaultTest.idle() : Effect.runPromise(nativeTest!.idle())),
        emit: async (type: string, value: unknown) =>
            defaultTest ? defaultTest.emit(type, value) : Effect.runPromise(nativeTest!.emit(type, value)),
        disconnect: async () => (defaultTest ? defaultTest.disconnect() : Effect.runPromise(nativeTest!.disconnect())),
        channel: (id: string): Promise<GuildChannel | undefined> =>
            defaultTest ? settle(defaultTest.client.channels.get(id)) : settle(nativeTest!.client.channels.get(id)),
        message: (target: MessageReference) =>
            defaultTest
                ? settle(defaultTest.client.messages.get(target))
                : settle(nativeTest!.client.messages.get(target)),
        fetchAll: (guildId: string) =>
            defaultTest
                ? settle(defaultTest.client.channels.fetchAll(guildId))
                : settle(nativeTest!.client.channels.fetchAll(guildId)),
        fetchChannel: (id: string) =>
            defaultTest ? settle(defaultTest.client.channels.fetch(id)) : settle(nativeTest!.client.channels.fetch(id)),
        fetchMessage: (target: MessageReference) =>
            defaultTest
                ? settle(defaultTest.client.messages.fetch(target))
                : settle(nativeTest!.client.messages.fetch(target)),
        /** Collect every payload of one event from a handler registered now */
        collect: async <K extends EventName>(event: K): Promise<EventMap[K][]> => {
            const values: EventMap[K][] = []
            if (defaultTest) defaultTest.client.on(event, (value) => void values.push(value as EventMap[K]))
            else
                await Effect.runPromise(
                    nativeTest!.client
                        .on(event, (value) => Effect.sync(() => void values.push(value as EventMap[K])))
                        .pipe(Scope.provide(scope)),
                )
            return values
        },
        /** The bot's own thread member, as Fluxer sends it in a thread list or THREAD_MEMBER_UPDATE */
        ownMember: (threadId: string) => ({
            id: threadId,
            user_id: fixtures.ids.bot,
            ...joined,
            muted: false,
            mute_config: null,
        }),
        /** A message in a channel of the default community, as gateway events carry it */
        post: (channelId: string, guildId = fixtures.ids.guild) =>
            fixtures.message({ channel_id: channelId, guild_id: guildId }),
    }
}

type Api = Awaited<ReturnType<typeof open>>

const reference = (message: { readonly id: string; readonly channel_id: string }): MessageReference => ({
    id: message.id,
    channelId: message.channel_id,
})

/** Emit messages into the message cache and wait until they are retained */
async function cacheMessages(api: Api, messages: readonly { readonly id: string; readonly channel_id: string }[]) {
    for (const message of messages) await api.emit("MESSAGE_CREATE", message)
    await api.idle()
    for (const message of messages) expect(await api.message(reference(message))).toBeDefined()
}

test.each(modes)("%s delivers each thread event as a frozen typed payload", async (mode) => {
    const api = await open(mode)
    const { fixtures } = api
    const guildId = fixtures.ids.guild
    const created = await api.collect("threadCreate")
    const updated = await api.collect("threadUpdate")
    const deleted = await api.collect("threadDelete")
    const synced = await api.collect("threadListSync")
    const members = await api.collect("threadMembersUpdate")
    await api.ready()

    const thread = fixtures.thread({ name: "plans" })
    await api.emit("THREAD_CREATE", { ...thread, newly_created: true, member: api.ownMember(thread.id) })
    // A bot added to an existing thread receives it without newly_created
    await api.emit("THREAD_CREATE", thread)
    await api.emit("THREAD_UPDATE", { ...thread, name: "renamed" })
    await api.emit("THREAD_DELETE", { id: thread.id, guild_id: guildId, parent_id: fixtures.ids.channel, type: 11 })
    const listed = fixtures.thread({ type: 12 })
    await api.emit("THREAD_LIST_SYNC", {
        guild_id: guildId,
        channel_ids: [fixtures.ids.channel],
        threads: [listed],
        members: [api.ownMember(listed.id)],
    })
    await api.emit("THREAD_LIST_SYNC", { guild_id: guildId, threads: [], members: [] })
    const { guild_id: _guild, ...guildMember } = fixtures.member()
    await api.emit("THREAD_MEMBERS_UPDATE", {
        id: thread.id,
        guild_id: guildId,
        member_count: 2,
        added_members: [{ id: thread.id, user_id: fixtures.ids.user, ...joined, member: guildMember, presence: null }],
        removed_member_ids: ["99"],
    })
    await api.emit("THREAD_MEMBERS_UPDATE", { id: thread.id, guild_id: guildId, member_count: 1 })
    // The bot's own membership change has no public event
    await api.emit("THREAD_MEMBER_UPDATE", { ...api.ownMember(thread.id), guild_id: guildId })
    await api.idle()

    expect(created).toEqual([
        expect.objectContaining({
            id: thread.id,
            type: ChannelType.PublicThread,
            name: "plans",
            isNewlyCreated: true,
            membership: { joinedAt: joined.join_timestamp, flags: 2 },
        }),
        expect.objectContaining({ id: thread.id, isNewlyCreated: false }),
    ])
    expect(created[1]).not.toHaveProperty("membership")
    expect(updated).toEqual([expect.objectContaining({ id: thread.id, name: "renamed" })])
    expect(updated[0]).not.toHaveProperty("isNewlyCreated")
    expect(deleted).toEqual([
        { id: thread.id, guildId, parentId: fixtures.ids.channel, type: ChannelType.PublicThread },
    ])
    expect(synced).toEqual([
        {
            guildId,
            parentIds: [fixtures.ids.channel],
            threads: [
                expect.objectContaining({
                    id: listed.id,
                    type: ChannelType.PrivateThread,
                    membership: { joinedAt: joined.join_timestamp, flags: 2 },
                }),
            ],
        },
        { guildId, threads: [] },
    ])
    expect(members).toEqual([
        {
            threadId: thread.id,
            guildId,
            memberCount: 2,
            added: [
                {
                    threadId: thread.id,
                    userId: fixtures.ids.user,
                    joinedAt: joined.join_timestamp,
                    flags: 2,
                    member: expect.objectContaining({ guildId, userId: fixtures.ids.user }),
                },
            ],
            removedUserIds: ["99"],
        },
        { threadId: thread.id, guildId, memberCount: 1, added: [], removedUserIds: [] },
    ])
    for (const payload of [...created, ...updated, ...deleted, ...synced, ...members])
        expect(Object.isFrozen(payload)).toBe(true)
    expect(api.logs().filter((record) => record.code === "gateway.dispatchRejected")).toEqual([])
})

test.each(modes)(
    "%s skips a malformed thread dispatch and evicts only the thread, and the messages of a deletion",
    async (mode) => {
        const api = await open(mode, { cache: { channels: true, messages: true } })
        const { fixtures } = api
        const guildId = fixtures.ids.guild
        const updates = await api.collect("threadUpdate")
        await api.ready()
        await api.emit("GUILD_CREATE", fixtures.guildCreate())
        const thread = fixtures.thread()
        await api.emit("THREAD_CREATE", thread)
        const inThread = api.post(thread.id)
        const inChannel = api.post(fixtures.ids.channel)
        await cacheMessages(api, [inThread, inChannel])

        const { thread_metadata: _metadata, ...withoutMetadata } = thread
        const malformed: [string, unknown][] = [
            ["THREAD_UPDATE", withoutMetadata],
            ["THREAD_CREATE", { ...thread, newly_created: "yes" }],
            ["THREAD_MEMBERS_UPDATE", { id: thread.id, guild_id: guildId, member_count: -1 }],
            ["THREAD_MEMBER_UPDATE", { id: thread.id, guild_id: guildId, user_id: fixtures.ids.bot }],
        ]
        for (const [type, body] of malformed) {
            await api.emit("THREAD_CREATE", thread)
            await api.idle()
            expect(await api.channel(thread.id)).toBeDefined()
            await api.emit(type, body)
            await api.idle()
            expect(await api.channel(thread.id), type).toBeUndefined()
        }
        expect(updates).toEqual([])
        // None of them changes messages or other channels
        expect(await api.message(reference(inThread))).toBeDefined()
        expect(await api.channel(fixtures.ids.channel)).toBeDefined()

        await api.emit("THREAD_DELETE", { id: thread.id, guild_id: guildId, parent_id: fixtures.ids.channel, type: 99 })
        await api.idle()
        expect(await api.message(reference(inThread))).toBeUndefined()
        expect(await api.message(reference(inChannel))).toBeDefined()

        // A malformed list names no thread, so the community's cached channels go
        await api.emit("THREAD_LIST_SYNC", { guild_id: guildId, threads: "none", members: [] })
        await api.idle()
        expect(await api.channel(fixtures.ids.channel)).toBeUndefined()

        const rejected = api.logs().filter((record) => record.code === "gateway.dispatchRejected")
        expect(rejected.map((record) => record.fields?.dispatch)).toEqual([
            ...malformed.map(([type]) => type),
            "THREAD_DELETE",
            "THREAD_LIST_SYNC",
        ])
        expect(api.state()).toBe("Connected")
    },
)

test.each(modes)(
    "%s fills the channel cache with a snapshot's threads and logs each malformed one it leaves out",
    async (mode) => {
        const api = await open(mode, { cache: { channels: true } })
        const { fixtures } = api
        const guilds = await api.collect("guildCreate")
        await api.ready()
        const kept = fixtures.thread()
        const replaced = fixtures.thread()
        const { owner_id: _owner, ...withoutOwner } = fixtures.thread()
        await api.emit("GUILD_CREATE", fixtures.guildCreate({ threads: [kept, withoutOwner as never, replaced] }))
        await api.idle()

        expect(await api.channel(kept.id)).toMatchObject({
            type: ChannelType.PublicThread,
            parentId: fixtures.ids.channel,
        })
        expect(await api.channel(replaced.id)).toBeDefined()
        expect(guilds).toHaveLength(1)
        expect(api.logs().filter((record) => record.code === "gateway.threadSkipped")).toEqual([
            expect.objectContaining({
                level: "warn",
                fields: expect.objectContaining({
                    dispatch: "GUILD_CREATE",
                    guildId: fixtures.ids.guild,
                    field: "threads[1]",
                }),
            }),
        ])

        // A later snapshot replaces the community's threads
        await api.emit("GUILD_CREATE", fixtures.guildCreate({ threads: [kept] }))
        await api.idle()
        expect(await api.channel(kept.id)).toBeDefined()
        expect(await api.channel(replaced.id)).toBeUndefined()
    },
)

test.each(modes)(
    "%s stores created and updated threads and evicts a deleted thread with its messages",
    async (mode) => {
        const api = await open(mode, { cache: { channels: true, messages: true } })
        const { fixtures } = api
        await api.ready()
        const thread = fixtures.thread({ name: "plans" })
        await api.emit("THREAD_CREATE", { ...thread, newly_created: true })
        await api.idle()
        const stored = await api.channel(thread.id)
        expect(stored).toMatchObject({ id: thread.id, name: "plans" })
        expect(stored).not.toHaveProperty("isNewlyCreated")
        expect(Object.isFrozen(stored)).toBe(true)

        await api.emit("THREAD_UPDATE", {
            ...thread,
            name: "renamed",
            thread_metadata: { ...thread.thread_metadata, archived: true },
        })
        await api.idle()
        expect(await api.channel(thread.id)).toMatchObject({ name: "renamed", archived: true })

        const inThread = api.post(thread.id)
        const elsewhere = api.post(fixtures.ids.channel)
        await cacheMessages(api, [inThread, elsewhere])
        await api.emit("THREAD_DELETE", {
            id: thread.id,
            guild_id: fixtures.ids.guild,
            parent_id: fixtures.ids.channel,
            type: 11,
        })
        await api.idle()
        expect(await api.channel(thread.id)).toBeUndefined()
        expect(await api.message(reference(inThread))).toBeUndefined()
        expect(await api.message(reference(elsewhere))).toBeDefined()
    },
)

test.each(modes)("%s replaces a community's threads from a thread list, or only those of its parents", async (mode) => {
    const api = await open(mode, { cache: { channels: true } })
    const { fixtures } = api
    const guildId = fixtures.ids.guild
    await api.ready()
    const otherParent = fixtures.nextId()
    const first = fixtures.thread()
    const sibling = fixtures.thread({ parent_id: otherParent })
    for (const thread of [first, sibling]) await api.emit("THREAD_CREATE", thread)
    await api.idle()

    const second = fixtures.thread()
    await api.emit("THREAD_LIST_SYNC", {
        guild_id: guildId,
        channel_ids: [fixtures.ids.channel],
        threads: [second],
        members: [api.ownMember(second.id)],
    })
    await api.idle()
    expect(await api.channel(first.id)).toBeUndefined()
    expect(await api.channel(second.id)).toMatchObject({ membership: { joinedAt: joined.join_timestamp, flags: 2 } })
    expect(await api.channel(sibling.id)).toBeDefined()

    const only = fixtures.thread({ parent_id: otherParent })
    await api.emit("THREAD_LIST_SYNC", { guild_id: guildId, threads: [only], members: [] })
    await api.idle()
    expect(await api.channel(second.id)).toBeUndefined()
    expect(await api.channel(sibling.id)).toBeUndefined()
    expect(await api.channel(only.id)).toBeDefined()
})

test.each(modes)("%s evicts a thread when the bot's membership in it changes", async (mode) => {
    const api = await open(mode, { cache: { channels: true } })
    const { fixtures } = api
    const guildId = fixtures.ids.guild
    await api.ready()
    const thread = fixtures.thread({ member: { ...joined } })
    const store = async () => {
        await api.emit("THREAD_CREATE", thread)
        await api.idle()
        expect(await api.channel(thread.id)).toBeDefined()
    }

    await store()
    await api.emit("THREAD_MEMBER_UPDATE", { ...api.ownMember(thread.id), flags: 8, guild_id: guildId })
    await api.idle()
    expect(await api.channel(thread.id)).toBeUndefined()

    // Another account's change leaves the cached thread, including its memberCount, as observed
    await store()
    await api.emit("THREAD_MEMBERS_UPDATE", {
        id: thread.id,
        guild_id: guildId,
        member_count: 7,
        added_members: [{ id: thread.id, user_id: fixtures.ids.user, ...joined, member: null, presence: null }],
    })
    await api.idle()
    expect(await api.channel(thread.id)).toMatchObject({ memberCount: 1 })

    await api.emit("THREAD_MEMBERS_UPDATE", {
        id: thread.id,
        guild_id: guildId,
        member_count: 0,
        removed_member_ids: [fixtures.ids.bot],
    })
    await api.idle()
    expect(await api.channel(thread.id)).toBeUndefined()

    await store()
    await api.emit("THREAD_MEMBERS_UPDATE", {
        id: thread.id,
        guild_id: guildId,
        member_count: 2,
        added_members: [{ id: thread.id, user_id: fixtures.ids.bot, ...joined, member: null, presence: null }],
    })
    await api.idle()
    expect(await api.channel(thread.id)).toBeUndefined()
})

test.each(modes)(
    "%s evicts a deleted parent's threads and every message the channel cache cannot place elsewhere",
    async (mode) => {
        const api = await open(mode, { cache: { channels: true, messages: true } })
        const { fixtures } = api
        await api.ready()
        const other = fixtures.channel({ id: fixtures.nextId(), name: "other" })
        const voice = fixtures.channel({ id: fixtures.nextId(), type: 2, name: "voice" })
        const child = fixtures.thread()
        const cousin = fixtures.thread({ parent_id: other.id })
        await api.emit(
            "GUILD_CREATE",
            fixtures.guildCreate({ channels: [fixtures.channel(), other, voice], threads: [child, cousin] }),
        )
        const unplaced = fixtures.nextId()
        const otherGuild = fixtures.nextId()
        const removed = [api.post(fixtures.ids.channel), api.post(child.id), api.post(unplaced)]
        const kept = [api.post(other.id), api.post(cousin.id), api.post(unplaced, otherGuild)]
        // A REST read carries no community, so it may sit in one of the deleted threads
        const read = fixtures.message({ channel_id: unplaced, guild_id: undefined })
        api.rest.respond(`GET /channels/${unplaced}/messages/${read.id}`, { body: read })
        await cacheMessages(api, [...removed, ...kept])
        await api.fetchMessage(reference(read))

        // A voice channel holds no threads, so its deletion takes only its own messages
        await api.emit("CHANNEL_DELETE", voice)
        await api.idle()
        for (const message of [...removed, ...kept, read]) expect(await api.message(reference(message))).toBeDefined()

        // Fluxer deletes the parent's threads without THREAD_DELETE
        await api.emit("CHANNEL_DELETE", fixtures.channel())
        await api.idle()
        expect(await api.channel(child.id)).toBeUndefined()
        expect(await api.channel(cousin.id)).toBeDefined()
        expect(await api.channel(other.id)).toBeDefined()
        for (const message of [...removed, read]) expect(await api.message(reference(message))).toBeUndefined()
        for (const message of kept) expect(await api.message(reference(message))).toBeDefined()
    },
)

test.each(modes)(
    "%s evicts every message of the community on a parent deletion without the channel cache",
    async (mode) => {
        const api = await open(mode, { cache: { messages: true } })
        const { fixtures } = api
        await api.ready()
        const otherGuild = fixtures.nextId()
        const inCommunity = [api.post(fixtures.ids.channel), api.post(fixtures.nextId())]
        const outside = api.post(fixtures.nextId(), otherGuild)
        await cacheMessages(api, [...inCommunity, outside])

        await api.emit("CHANNEL_DELETE", fixtures.forumChannel())
        await api.idle()
        for (const message of inCommunity) expect(await api.message(reference(message))).toBeUndefined()
        expect(await api.message(reference(outside))).toBeDefined()
    },
)

test.each(modes)("%s keeps cached threads when a full channel list replaces the community's channels", async (mode) => {
    const api = await open(mode, { cache: { channels: true } })
    const { fixtures } = api
    await api.ready()
    const gone = fixtures.channel({ id: fixtures.nextId(), name: "gone" })
    const thread = fixtures.thread()
    await api.emit("GUILD_CREATE", fixtures.guildCreate({ channels: [fixtures.channel(), gone], threads: [thread] }))
    api.rest.respond(`GET /guilds/${fixtures.ids.guild}/channels`, { body: [fixtures.channel()] })

    await api.fetchAll(fixtures.ids.guild)
    expect(await api.channel(gone.id)).toBeUndefined()
    expect(await api.channel(fixtures.ids.channel)).toBeDefined()
    expect(await api.channel(thread.id)).toBeDefined()
})

test.each(modes)("%s drops a resumed shard's cached threads and keeps its channels", async (mode) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
    const api = await open(mode, { cache: { channels: true } })
    const { fixtures } = api
    await api.ready()
    const thread = fixtures.thread()
    await api.emit("GUILD_CREATE", fixtures.guildCreate({ threads: [thread] }))
    // Real event-loop turns, because these fake timers would stop idle. The limit only bounds a hung test
    for (let count = 0; count < 1_000 && (await api.channel(thread.id)) === undefined; count++) await turn()
    expect(await api.channel(thread.id)).toBeDefined()

    await api.disconnect()
    // Recovery waits on the SDK clock, which these fake timers drive. The step limit only bounds a hung test
    for (let step = 0; step < 20 && !(api.counters().resumes === 1 && api.state() === "Connected"); step++) {
        await turn()
        await vi.advanceTimersByTimeAsync(1_000)
        await turn()
    }
    expect(api.counters().resumes).toBe(1)
    expect(api.state()).toBe("Connected")
    expect(await api.channel(thread.id)).toBeUndefined()
    expect(await api.channel(fixtures.ids.channel)).toBeDefined()
})

test.each(modes)("%s keeps a channel read begun before a completed Resume out of the cache", async (mode) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
    const api = await open(mode, { cache: { channels: true } })
    const { fixtures } = api
    await api.ready()
    const thread = fixtures.thread()
    let answer: ((response: TestResponse) => void) | undefined
    const arrived = new Promise<void>((started) => {
        api.rest.respond(
            `GET /channels/${thread.id}`,
            () =>
                new Promise<TestResponse>((resolve) => {
                    answer = resolve
                    started()
                }),
        )
    })

    await api.disconnect()
    // The lost connection pauses only reads already in flight, so this read starts after it. The limit bounds a hung test
    for (let count = 0; count < 1_000 && api.state() === "Connected"; count++) await turn()
    expect(api.state()).not.toBe("Connected")
    const fetched = api.fetchChannel(thread.id)
    await arrived
    for (let step = 0; step < 20 && !(api.counters().resumes === 1 && api.state() === "Connected"); step++) {
        await turn()
        await vi.advanceTimersByTimeAsync(1_000)
        await turn()
    }
    expect(api.counters().resumes).toBe(1)
    expect(api.state()).toBe("Connected")

    // The answer can predate replayed events, so the caller receives it but the cache does not keep it
    answer!({ body: thread })
    expect(await fetched).toMatchObject({ id: thread.id })
    expect(await api.channel(thread.id)).toBeUndefined()
})

test.each(modes)(
    "%s automatic event filtering keeps the thread dispatches enabled caches and handlers need",
    async (mode) => {
        const threadTypes = [
            "THREAD_CREATE",
            "THREAD_UPDATE",
            "THREAD_DELETE",
            "THREAD_LIST_SYNC",
            "THREAD_MEMBERS_UPDATE",
        ]
        const ignored = async (options: TestClientOptions, register?: EventName) => {
            const api = await open(mode, { ...options, gateway: { ignoredEvents: "auto" } })
            if (register) await api.collect(register)
            await api.ready()
            const identify = api.commands().find((command) => command.op === 2)?.d as
                { readonly ignored_events?: readonly string[] } | undefined
            const list = identify?.ignored_events ?? []
            return [...threadTypes, "THREAD_MEMBER_UPDATE"].filter((type) => list.includes(type))
        }
        expect(await ignored({})).toEqual(threadTypes)
        expect(await ignored({ cache: { channels: true } })).toEqual([])
        expect(await ignored({ cache: { messages: true } })).toEqual(
            threadTypes.filter((type) => type !== "THREAD_DELETE"),
        )
        expect(await ignored({}, "threadMembersUpdate")).toEqual(
            threadTypes.filter((type) => type !== "THREAD_MEMBERS_UPDATE"),
        )
    },
)

test("an explicit ignored list cannot drop a thread dispatch the channel cache needs", () => {
    for (const type of ["THREAD_LIST_SYNC", "THREAD_MEMBER_UPDATE"])
        expect(() =>
            createDefaultTestClient({ cache: { channels: true }, gateway: { ignoredEvents: [type] } }),
        ).toThrow(ConfigurationError)
})

test("the channel partition orders one thread's member changes while other threads' changes run beside them", async () => {
    const test = createDefaultTestClient()
    onTestFinished(() => test.shutdown())
    const pending = new Map<string, PromiseWithResolvers<void>>()
    const gate = (key: string) => {
        if (!pending.has(key)) pending.set(key, Promise.withResolvers<void>())
        return pending.get(key)!
    }
    const started: string[] = []
    test.client.on(
        "threadMembersUpdate",
        async (update) => {
            const key = `${update.threadId}:${update.memberCount}`
            started.push(key)
            await gate(key).promise
        },
        { partition: "channel" },
    )
    await test.ready()
    const guildId = test.fixtures.ids.guild
    const [first, second] = [test.fixtures.nextId(), test.fixtures.nextId()]
    const update = (id: string, memberCount: number) => ({ id, guild_id: guildId, member_count: memberCount })
    test.emit("THREAD_MEMBERS_UPDATE", update(first, 1))
    test.emit("THREAD_MEMBERS_UPDATE", update(first, 2))
    test.emit("THREAD_MEMBERS_UPDATE", update(second, 1))
    // Both threads share one community, so only a thread key lets the second thread start beside the first
    await vi.waitFor(() => expect(started).toEqual([`${first}:1`, `${second}:1`]))
    gate(`${first}:1`).resolve()
    await vi.waitFor(() => expect(started).toEqual([`${first}:1`, `${second}:1`, `${first}:2`]))
    gate(`${second}:1`).resolve()
    gate(`${first}:2`).resolve()
})
