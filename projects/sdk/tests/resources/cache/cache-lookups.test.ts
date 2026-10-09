import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import type { CacheKind, Client, ClientOptions } from "../../../src/index.js"
import type { Client as NativeClient } from "../../../src/effect.js"
import { createTestClient as createDefaultTestClient } from "../../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../../src/effect-testing.js"
import { defaultApi, describeBothApis, nativeApi, type Mode } from "../../support/both-apis.js"
import { monotonicClock } from "../../support/clock.js"
import { expectDefect, expectThrown } from "../defects.js"

const cache = {
    users: true,
    directMessages: true,
    emojis: true,
    stickers: true,
    guilds: true,
    channels: true,
    members: true,
    roles: true,
    messages: true,
} as const

/** One lookup per cache, with a valid reference that is not cached and a malformed one */
const lookups = [
    {
        kind: "users",
        error: "UserOperationError",
        operation: "users.get",
        run: (client: Client | NativeClient, bad: boolean) => client.users.get(bad ? "bad" : "1"),
    },
    {
        kind: "directMessages",
        error: "UserOperationError",
        operation: "directMessages.get",
        run: (client: Client | NativeClient, bad: boolean) => client.directMessages.get(bad ? "bad" : "1"),
    },
    {
        kind: "emojis",
        error: "GuildOperationError",
        operation: "emojis.get",
        run: (client: Client | NativeClient, bad: boolean) =>
            client.emojis.get({ guildId: "1", id: bad ? "bad" : "2" }),
    },
    {
        kind: "stickers",
        error: "GuildOperationError",
        operation: "stickers.get",
        run: (client: Client | NativeClient, bad: boolean) =>
            client.stickers.get({ guildId: "1", id: bad ? "bad" : "2" }),
    },
    {
        kind: "guilds",
        error: "GuildOperationError",
        operation: "guilds.get",
        run: (client: Client | NativeClient, bad: boolean) => client.guilds.get(bad ? "bad" : "1"),
    },
    {
        kind: "channels",
        error: "ChannelOperationError",
        operation: "channels.get",
        run: (client: Client | NativeClient, bad: boolean) => client.channels.get(bad ? "bad" : "1"),
    },
    {
        kind: "members",
        error: "GuildOperationError",
        operation: "members.get",
        run: (client: Client | NativeClient, bad: boolean) =>
            client.members.get({ guildId: "1", userId: bad ? "bad" : "2" }),
    },
    {
        kind: "roles",
        error: "GuildOperationError",
        operation: "roles.get",
        run: (client: Client | NativeClient, bad: boolean) => client.roles.get({ guildId: "1", id: bad ? "bad" : "2" }),
    },
    {
        kind: "messages",
        error: "MessageOperationError",
        operation: "messages.get",
        run: (client: Client | NativeClient, bad: boolean) =>
            client.messages.get({ channelId: "1", id: bad ? "bad" : "2" }),
    },
] as const

test.each(lookups)(
    "default $kind.get returns undefined on a miss or after shutdown and throws $error for a malformed reference",
    async ({ error, operation, run }) => {
        const client = defaultApi({ cache })
        expect(run(client, false)).toBeUndefined()
        expect(expectThrown(() => run(client, true))).toMatchObject({
            _tag: error,
            operation,
            reason: "input",
            outcome: "notDispatched",
        })
        const closed = await client.shutdown()
        expect(closed.isOk()).toBe(true)
        // A closed client reads nothing instead of reporting ClientClosedError
        expect(run(client, false)).toBeUndefined()
    },
)

test.each(lookups)(
    "native $kind.get succeeds with undefined on a miss or after shutdown and dies with $error for a malformed reference",
    async ({ error, operation, run }) => {
        const client = await nativeApi({ cache })
        const miss = run(client, false) as Effect.Effect<unknown>
        expect(Effect.isEffect(miss)).toBe(true)
        expect(await Effect.runPromise(miss)).toBeUndefined()
        expect(await expectDefect(run(client, true) as Effect.Effect<unknown>)).toMatchObject({
            _tag: error,
            operation,
            reason: "input",
            outcome: "notDispatched",
        })
        await Effect.runPromise(client.shutdown())
        expect(await Effect.runPromise(run(client, false) as Effect.Effect<unknown>)).toBeUndefined()
    },
)

/** A ready in-memory test client in either API style, with synchronous lookups and gateway emission */
async function readyTestClient(mode: Mode, cache: NonNullable<ClientOptions["cache"]>) {
    if (mode === "default") {
        const test = createDefaultTestClient({ cache })
        onTestFinished(() => test.shutdown())
        await test.ready()
        const client = test.client
        return {
            test,
            client,
            emit: (type: string, payload: unknown) => test.emit(type, payload),
            fetchUser: async (id: string) => expect((await client.users.fetch(id)).isOk()).toBe(true),
            lookups: {
                messages: (channelId: string, id: string) => client.messages.get({ channelId, id }),
                guilds: (id: string) => client.guilds.get(id),
                channels: (id: string) => client.channels.get(id),
                users: (id: string) => client.users.get(id),
                roles: (guildId: string, id: string) => client.roles.get({ guildId, id }),
            },
        }
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const test = await Effect.runPromise(createNativeTestClient({ cache }).pipe(Scope.provide(scope)))
    await Effect.runPromise(test.ready())
    const client = test.client
    return {
        test,
        client,
        emit: (type: string, payload: unknown) => Effect.runSync(test.emit(type, payload)),
        fetchUser: (id: string) => Effect.runPromise(Effect.asVoid(client.users.fetch(id))),
        lookups: {
            messages: (channelId: string, id: string) => Effect.runSync(client.messages.get({ channelId, id })),
            guilds: (id: string) => Effect.runSync(client.guilds.get(id)),
            channels: (id: string) => Effect.runSync(client.channels.get(id)),
            users: (id: string) => Effect.runSync(client.users.get(id)),
            roles: (guildId: string, id: string) => Effect.runSync(client.roles.get({ guildId, id })),
        },
    }
}

describeBothApis("cache diagnostics totals", (mode) => {
    // Without these totals, cache budgets can only be tuned by guessing how often lookups miss and why entries go
    test("count hits, misses, capacity evictions and expiry for each enabled category, and nothing for a disabled one", async () => {
        const clock = monotonicClock()
        const bounded = { maxEntries: 1, maxAgeMs: 60_000 }
        const api = await readyTestClient(mode, {
            messages: bounded,
            guilds: bounded,
            channels: bounded,
            users: bounded,
        })
        const fixtures = api.test.fixtures
        api.test.rest.respond("GET /users/:id", (request) => ({
            body: fixtures.user({ id: request.path.split("/").at(-1)! }),
        }))
        // Each category receives two entries, so its first one is evicted for capacity
        const firstGuild = fixtures.guildCreate()
        const secondGuildId = fixtures.nextId()
        const secondChannel = fixtures.channel({ id: fixtures.nextId(), guild_id: secondGuildId })
        api.emit("GUILD_CREATE", firstGuild)
        api.emit("GUILD_CREATE", fixtures.guildCreate({ guild: { id: secondGuildId }, channels: [secondChannel] }))
        const messages = [fixtures.message(), fixtures.message()]
        for (const message of messages) api.emit("MESSAGE_CREATE", message)
        const userIds = [fixtures.nextId(), fixtures.nextId()]
        for (const id of userIds) await api.fetchUser(id)

        const first = {
            messages: () => api.lookups.messages(messages[0]!.channel_id, messages[0]!.id),
            guilds: () => api.lookups.guilds(firstGuild.id),
            channels: () => api.lookups.channels(firstGuild.channels[0]!.id),
            users: () => api.lookups.users(userIds[0]!),
        }
        const second = {
            messages: () => api.lookups.messages(messages[1]!.channel_id, messages[1]!.id),
            guilds: () => api.lookups.guilds(secondGuildId),
            channels: () => api.lookups.channels(secondChannel.id),
            users: () => api.lookups.users(userIds[1]!),
        }
        const kinds = ["messages", "guilds", "channels", "users"] as const
        for (const kind of kinds) {
            expect(first[kind]()).toBeUndefined()
            expect(second[kind]()).toBeDefined()
        }
        // The second entries expire, so their next lookups miss
        clock.advance(60_000)
        for (const kind of kinds) expect(second[kind]()).toBeUndefined()
        // Roles were not enabled, so their lookups count nothing
        expect(api.lookups.roles(secondGuildId, fixtures.nextId())).toBeUndefined()

        const caches = api.client.diagnostics().caches
        const totals = (kind: CacheKind) => {
            const { hits, misses, evictions } = caches[kind]
            return { hits, misses, evictions }
        }
        for (const kind of kinds)
            expect([kind, totals(kind)]).toEqual([kind, { hits: 1, misses: 2, evictions: { capacity: 1, expiry: 1 } }])
        expect(totals("roles")).toEqual({ hits: 0, misses: 0, evictions: { capacity: 0, expiry: 0 } })
        expect(Object.isFrozen(caches.messages.evictions)).toBe(true)
    })
})
