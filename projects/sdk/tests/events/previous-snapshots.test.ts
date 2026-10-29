import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import type { EventContext, EventName } from "../../src/index.js"
import { createTestClient as createDefaultTestClient, type TestClientOptions } from "../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../src/effect-testing.js"
import { modes, type Mode } from "../support/both-apis.js"
import { settle } from "../support/settle.js"

/** Every cache category that supplies a previous snapshot */
const cached: TestClientOptions["cache"] = { messages: true, guilds: true, members: true, roles: true, channels: true }

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
    const client = test.client
    return {
        fixtures: test.fixtures,
        client,
        ready: () => (defaultTest ? defaultTest.ready() : Effect.runPromise(nativeTest!.ready())),
        idle: () => (defaultTest ? defaultTest.idle() : Effect.runPromise(nativeTest!.idle())),
        emit: async (type: string, value: unknown) =>
            defaultTest ? defaultTest.emit(type, value) : Effect.runPromise(nativeTest!.emit(type, value)),
        /**
         * Record the context of every event of one name from a handler registered now. A handler with a gate holds its
         * first invocation until the gate resolves, so later events wait in its queue
         */
        record: async (event: EventName, gate?: Promise<void>) => {
            const contexts: EventContext[] = []
            let held = gate
            const hold = () => {
                const wait = held
                held = undefined
                return wait
            }
            if (defaultTest)
                defaultTest.client.on(event, (_value, _signal, context) => {
                    contexts.push(context)
                    return hold()
                })
            else
                await Effect.runPromise(
                    nativeTest!.client
                        .on(event, (_value, context) =>
                            Effect.suspend(() => {
                                contexts.push(context)
                                const wait = hold()
                                return wait === undefined ? Effect.void : Effect.promise(() => wait)
                            }),
                        )
                        .pipe(Scope.provide(scope)),
                )
            return contexts
        },
        /** Record the context each middleware invocation receives */
        middleware: async () => {
            const contexts: EventContext[] = []
            if (defaultTest)
                defaultTest.client.use(async (invocation, next) => {
                    contexts.push(invocation.context)
                    await next()
                })
            else
                await Effect.runPromise(
                    nativeTest!.client
                        .use((invocation, next) =>
                            Effect.suspend(() => {
                                contexts.push(invocation.context)
                                return next
                            }),
                        )
                        .pipe(Scope.provide(scope)),
                )
            return contexts
        },
        lookup: {
            message: (id: string, channelId: string) => settle(client.messages.get({ id, channelId })),
            member: (guildId: string, userId: string) => settle(client.members.get({ guildId, userId })),
            role: (guildId: string, id: string) => settle(client.roles.get({ guildId, id })),
            channel: (id: string) => settle(client.channels.get(id)),
            guild: (id: string) => settle(client.guilds.get(id)),
        },
    }
}

type Api = Awaited<ReturnType<typeof open>>

/** The previous snapshot of each recorded event, in delivery order */
const previous = (contexts: readonly EventContext[]) => contexts.map((context) => context.previous)

/**
 * Emit a change and a removal for each kind of cached entity, after filling the caches. Returns, per event, the
 * snapshot a cache lookup returned just before the event, and the previous snapshots its handler received
 */
async function changeEverything(api: Api) {
    const { fixtures } = api
    const guildId = fixtures.ids.guild
    const names = [
        "messageUpdate",
        "messageDelete",
        "guildMemberUpdate",
        "guildMemberRemove",
        "guildRoleUpdate",
        "guildRoleDelete",
        "guildChannelUpdate",
        "guildChannelDelete",
        "threadUpdate",
        "threadDelete",
        "guildUpdate",
        "guildDelete",
    ] as const
    const received = Object.fromEntries(
        await Promise.all(names.map(async (name) => [name, await api.record(name)] as const)),
    ) as Record<(typeof names)[number], EventContext[]>
    await api.ready()

    const message = fixtures.message({ content: "first" })
    const role = fixtures.role({ name: "helpers" })
    const thread = fixtures.thread({ name: "plans" })
    await api.emit("GUILD_CREATE", fixtures.guildCreate())
    await api.emit("MESSAGE_CREATE", message)
    await api.emit("GUILD_MEMBER_ADD", fixtures.member())
    await api.emit("GUILD_ROLE_CREATE", { guild_id: guildId, role })
    await api.emit("THREAD_CREATE", { ...thread, newly_created: true })
    await api.idle()

    const before: Record<string, unknown> = {}
    const step = async (name: (typeof names)[number], read: () => Promise<unknown>, type: string, body: unknown) => {
        before[name] = await read()
        await api.emit(type, body)
        await api.idle()
    }
    const { lookup } = api
    const userId = fixtures.ids.user
    const channel = fixtures.channel()
    await step("messageUpdate", () => lookup.message(message.id, message.channel_id), "MESSAGE_UPDATE", {
        ...message,
        content: "second",
    })
    await step("messageDelete", () => lookup.message(message.id, message.channel_id), "MESSAGE_DELETE", {
        id: message.id,
        channel_id: message.channel_id,
        guild_id: guildId,
    })
    await step("guildMemberUpdate", () => lookup.member(guildId, userId), "GUILD_MEMBER_UPDATE", {
        ...fixtures.member(),
        nick: "renamed",
    })
    await step("guildMemberRemove", () => lookup.member(guildId, userId), "GUILD_MEMBER_REMOVE", {
        guild_id: guildId,
        user: fixtures.user(),
    })
    await step("guildRoleUpdate", () => lookup.role(guildId, role.id), "GUILD_ROLE_UPDATE", {
        guild_id: guildId,
        role: { ...role, name: "moderators" },
    })
    await step("guildRoleDelete", () => lookup.role(guildId, role.id), "GUILD_ROLE_DELETE", {
        guild_id: guildId,
        role_id: role.id,
    })
    await step("threadUpdate", () => lookup.channel(thread.id), "THREAD_UPDATE", { ...thread, name: "renamed" })
    await step("threadDelete", () => lookup.channel(thread.id), "THREAD_DELETE", {
        id: thread.id,
        guild_id: guildId,
        parent_id: thread.parent_id,
        type: thread.type,
    })
    await step("guildChannelUpdate", () => lookup.channel(channel.id), "CHANNEL_UPDATE", {
        ...channel,
        name: "renamed",
    })
    await step("guildChannelDelete", () => lookup.channel(channel.id), "CHANNEL_DELETE", {
        ...channel,
        name: "renamed",
    })
    await step("guildUpdate", () => lookup.guild(guildId), "GUILD_UPDATE", fixtures.guild({ name: "Renamed" }))
    await step("guildDelete", () => lookup.guild(guildId), "GUILD_DELETE", { id: guildId })
    for (const name of names) expect(received[name], name).toHaveLength(1)
    return { names, before, received }
}

test.each(modes)("%s handlers receive the snapshot the enabled cache held before each change", async (mode) => {
    const api = await open(mode, { cache: cached })
    const { names, before, received } = await changeEverything(api)
    for (const name of names) {
        // The snapshot is the cache's own frozen value, not a copy
        expect(before[name], name).toBeDefined()
        expect(received[name]![0]!.previous, name).toBe(before[name])
        expect(Object.isFrozen(received[name]![0]!.previous), name).toBe(true)
    }
    expect(received.messageUpdate[0]!.previous).toMatchObject({ content: "first" })
    expect(received.messageDelete[0]!.previous).toMatchObject({ content: "second" })
    expect(received.guildMemberRemove[0]!.previous).toMatchObject({ nickname: "renamed" })
    expect(received.guildRoleDelete[0]!.previous).toMatchObject({ name: "moderators" })
    expect(received.threadDelete[0]!.previous).toMatchObject({ name: "renamed" })
    expect(received.guildChannelDelete[0]!.previous).toMatchObject({ name: "renamed" })
    expect(received.guildDelete[0]!.previous).toMatchObject({ name: "Renamed" })
})

test.each(modes)("%s handlers receive no previous snapshot when the caches are disabled", async (mode) => {
    const api = await open(mode)
    const { names, received } = await changeEverything(api)
    for (const name of names) {
        expect(received[name]![0]!.previous, name).toBeUndefined()
        expect(received[name]![0]!, name).toHaveProperty("previous")
    }
})

test.each(modes)("%s events without a cached entity carry no previous snapshot", async (mode) => {
    const api = await open(mode, { cache: cached })
    const created = await api.record("messageCreate")
    const typing = await api.record("typingStart")
    await api.ready()
    const message = api.fixtures.message()
    await api.emit("MESSAGE_CREATE", message)
    // A repeated creation finds the first one cached, but creation has no previous snapshot
    await api.emit("MESSAGE_CREATE", message)
    await api.emit("TYPING_START", { channel_id: "20", user_id: "30", timestamp: 1 })
    await api.idle()
    expect(previous(created)).toEqual([undefined, undefined])
    expect(previous(typing)).toEqual([undefined])
})

test.each(modes)("%s an evicted, cleared or invalidated snapshot gives undefined", async (mode) => {
    const api = await open(mode, { cache: { ...cached, messages: { maxEntries: 1 } } })
    const { fixtures, lookup } = api
    const guildId = fixtures.ids.guild
    const updates = await api.record("messageUpdate")
    const members = await api.record("guildMemberUpdate")
    const channels = await api.record("guildChannelUpdate")
    await api.ready()
    await api.emit("GUILD_CREATE", fixtures.guildCreate())
    const evicted = fixtures.message({ content: "evicted" })
    const kept = fixtures.message({ content: "kept" })
    await api.emit("MESSAGE_CREATE", evicted)
    // The one-entry message cache makes room for this one by removing the first
    await api.emit("MESSAGE_CREATE", kept)
    await api.emit("GUILD_MEMBER_ADD", fixtures.member())
    await api.idle()
    expect(await lookup.message(evicted.id, evicted.channel_id)).toBeUndefined()

    await api.emit("MESSAGE_UPDATE", { ...kept, content: "edited" })
    // Storing this edit removes the other message in turn, which the assertions do not depend on
    await api.emit("MESSAGE_UPDATE", { ...evicted, content: "edited" })
    // A role deletion clears the community's cached members, because assignments can change without member events
    await api.emit("GUILD_ROLE_DELETE", { guild_id: guildId, role_id: fixtures.nextId() })
    await api.emit("GUILD_MEMBER_UPDATE", { ...fixtures.member(), nick: "renamed" })
    api.client.cache.clear("channels")
    await api.emit("CHANNEL_UPDATE", { ...fixtures.channel(), name: "renamed" })
    await api.idle()
    expect(previous(updates)).toEqual([expect.objectContaining({ id: kept.id, content: "kept" }), undefined])
    expect(previous(members)).toEqual([undefined])
    expect(previous(channels)).toEqual([undefined])
})

test.each(modes)("%s a queued event keeps the snapshot from when the client accepted it", async (mode) => {
    const api = await open(mode, { cache: cached })
    const gate = Promise.withResolvers<void>()
    // The first invocation waits on the gate, so the second update waits in the queue of this one-at-a-time handler
    const updates = await api.record("messageUpdate", gate.promise)
    const invocations = await api.middleware()
    await api.ready()
    const message = api.fixtures.message({ content: "first" })
    await api.emit("MESSAGE_CREATE", message)
    await api.emit("MESSAGE_UPDATE", { ...message, content: "second" })
    await api.emit("MESSAGE_UPDATE", { ...message, content: "third" })
    await expect.poll(() => updates.length).toBe(1)
    // The cache already holds the newest edit while the second update still waits
    expect(await api.lookup.message(message.id, message.channel_id)).toMatchObject({ content: "third" })
    gate.resolve()
    await api.idle()
    expect(previous(updates)).toEqual([
        expect.objectContaining({ content: "first" }),
        expect.objectContaining({ content: "second" }),
    ])
    // Middleware sees the same context object as the handler
    expect(invocations.filter((context) => updates.includes(context))).toHaveLength(2)
})

test.each(modes)("%s lastReceipt reads the receipt of the most recently accepted event", async (mode) => {
    const api = await open(mode)
    const typing = await api.record("typingStart")
    expect(api.client.lastReceipt).toBe(0)
    await api.ready()
    expect(api.client.lastReceipt).toBe(0)
    const wire = { channel_id: "20", user_id: "30", timestamp: 1 }
    await api.emit("TYPING_START", wire)
    await api.idle()
    expect(typing.map((context) => context.receipt)).toEqual([1])
    expect(api.client.lastReceipt).toBe(1)
    // An event without a handler is accepted and numbered too
    await api.emit("MESSAGE_CREATE", api.fixtures.message())
    await api.idle()
    expect(api.client.lastReceipt).toBe(2)
    await api.emit("TYPING_START", wire)
    await api.idle()
    expect(typing.map((context) => context.receipt)).toEqual([1, 3])
    expect(api.client.lastReceipt).toBe(3)
})
