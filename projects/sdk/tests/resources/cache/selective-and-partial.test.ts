import { setImmediate as turn } from "node:timers/promises"
import { Effect, Exit, Scope } from "effect"
import { describe, expect, onTestFinished, test } from "vitest"
import { ConfigurationError, type CacheChange, type CacheKind } from "../../../src/index.js"
import {
    createTestClient as createDefaultTestClient,
    type TestClient as DefaultTestClient,
    type TestClientOptions,
} from "../../../src/testing.js"
import {
    createTestClient as createNativeTestClient,
    type TestClient as NativeTestClient,
} from "../../../src/effect-testing.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { settle } from "../../support/settle.js"

type TestClient = DefaultTestClient | NativeTestClient

/** A ready test client in either API style, shut down when the test finishes */
async function open(mode: Mode, options: TestClientOptions): Promise<TestClient> {
    if (mode === "default") {
        const client = createDefaultTestClient(options)
        onTestFinished(() => client.shutdown())
        await client.ready()
        return client
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const client = await Effect.runPromise(createNativeTestClient(options as never).pipe(Scope.provide(scope)))
    await Effect.runPromise(client.ready())
    return client
}

async function emit(mode: Mode, test: TestClient, type: string, payload: unknown) {
    if (mode === "default") await (test as DefaultTestClient).emit(type, payload)
    else await Effect.runPromise((test as NativeTestClient).emit(type, payload))
}

/** Record cache changes in either API style, closing native registrations with the test */
async function recordChanges(mode: Mode, test: TestClient): Promise<CacheChange[]> {
    const changes: CacheChange[] = []
    if (mode === "default") {
        ;(test as DefaultTestClient).client.cache.onChange((change) => void changes.push(change))
        return changes
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    await Effect.runPromise(
        (test as NativeTestClient).client.cache
            .onChange((change) => Effect.sync(() => void changes.push(change)))
            .pipe(Scope.provide(scope)),
    )
    return changes
}

const thrown = (run: () => unknown) => {
    try {
        run()
    } catch (error) {
        return error
    }
    return expect.fail("Expected the call to throw")
}

describe.each(modes)("%s resource cache selection and partial clearing", (mode) => {
    test("a maxAgeMs callback chooses per snapshot which communities, channels and users each category keeps", async () => {
        let skippedGuild = ""
        const test = await open(mode, {
            cache: {
                guilds: { maxAgeMs: (guild) => (guild.id === skippedGuild ? 0 : null) },
                channels: { maxAgeMs: (channel) => (channel.guildId === skippedGuild ? 0 : null) },
                users: { maxAgeMs: (user) => (user.username === "skipped" ? 0 : null) },
            },
        })
        const { client, fixtures, rest } = test
        skippedGuild = fixtures.nextId()
        const skippedChannel = fixtures.nextId()
        await emit(mode, test, "GUILD_CREATE", fixtures.guildCreate())
        await emit(
            mode,
            test,
            "GUILD_CREATE",
            fixtures.guildCreate({
                guild: { id: skippedGuild },
                channels: [fixtures.channel({ id: skippedChannel, guild_id: skippedGuild })],
            }),
        )
        const skippedUser = fixtures.nextId()
        rest.respond("GET /users/:id", (request) =>
            request.path.endsWith(skippedUser)
                ? { body: fixtures.user({ id: skippedUser, username: "skipped" }) }
                : { body: fixtures.user() },
        )
        await settle(client.users.fetch(fixtures.ids.user))
        await settle(client.users.fetch(skippedUser))

        expect(await settle(client.guilds.get(fixtures.ids.guild))).toMatchObject({ id: fixtures.ids.guild })
        expect(await settle(client.guilds.get(skippedGuild))).toBeUndefined()
        expect(await settle(client.channels.get(fixtures.ids.channel))).toMatchObject({ id: fixtures.ids.channel })
        expect(await settle(client.channels.get(skippedChannel))).toBeUndefined()
        expect(await settle(client.users.get(fixtures.ids.user))).toMatchObject({ id: fixtures.ids.user })
        expect(await settle(client.users.get(skippedUser))).toBeUndefined()
    })

    test("a throwing or invalid callback removes the older copy, reports a cache failure and keeps the REST result", async () => {
        let policy: "keep" | "throw" | "invalid" = "keep"
        const test = await open(mode, {
            cache: {
                users: {
                    maxAgeMs: () => {
                        if (policy === "throw") throw new Error("policy broke")
                        return policy === "invalid" ? (-1 as never) : null
                    },
                },
            },
        })
        const { client, fixtures, rest } = test
        rest.respond("GET /users/:id", { body: fixtures.user() })
        const id = fixtures.ids.user

        for (const failing of ["throw", "invalid"] as const) {
            policy = "keep"
            await settle(client.users.fetch(id))
            expect(await settle(client.users.get(id))).toMatchObject({ id })
            policy = failing
            expect(await settle(client.users.fetch(id))).toMatchObject({ id })
            expect(await settle(client.users.get(id))).toBeUndefined()
        }
        expect(test.failures()).toEqual([
            expect.objectContaining({
                code: "cache.policyFailed",
                error: expect.objectContaining({ origin: "application", message: "policy broke" }),
            }),
            expect.objectContaining({
                code: "cache.policyFailed",
                error: expect.objectContaining({ message: expect.stringContaining("maxAgeMs callback returned -1") }),
            }),
        ])
    })

    test("clear with a kind releases only that category and reports one clear", async () => {
        const test = await open(mode, { cache: { users: true, channels: true } })
        const { client, fixtures, rest } = test
        await emit(mode, test, "GUILD_CREATE", fixtures.guildCreate())
        rest.respond("GET /users/:id", { body: fixtures.user() })
        await settle(client.users.fetch(fixtures.ids.user))
        const changes = await recordChanges(mode, test)

        client.cache.clear("users")
        client.cache.clear("users")
        client.cache.clear("members")

        expect(await settle(client.users.get(fixtures.ids.user))).toBeUndefined()
        expect(await settle(client.channels.get(fixtures.ids.channel))).toMatchObject({ id: fixtures.ids.channel })
        await turn()
        expect(changes).toEqual([{ kind: "users", op: "clear", key: null }])
    })

    test("delete removes one entry by its CacheChange key and reports it", async () => {
        const test = await open(mode, { cache: { guilds: true, members: true, messages: true } })
        const { client, fixtures } = test
        const { guild, user, channel } = fixtures.ids
        const otherUser = fixtures.nextId()
        await emit(mode, test, "GUILD_CREATE", fixtures.guildCreate())
        await emit(mode, test, "GUILD_MEMBER_ADD", fixtures.member())
        await emit(mode, test, "GUILD_MEMBER_ADD", fixtures.member({ user: fixtures.user({ id: otherUser }) }))
        const message = fixtures.message()
        await emit(mode, test, "MESSAGE_CREATE", message)
        const changes = await recordChanges(mode, test)

        client.cache.delete("members", `${guild}:${user}`)
        client.cache.delete("messages", `${channel}:${message.id}`)
        client.cache.delete("guilds", guild)
        client.cache.delete("guilds", guild)

        expect(await settle(client.members.get({ guildId: guild, userId: user }))).toBeUndefined()
        expect(await settle(client.members.get({ guildId: guild, userId: otherUser }))).toMatchObject({
            userId: otherUser,
        })
        expect(await settle(client.messages.get({ channelId: channel, id: message.id }))).toBeUndefined()
        expect(await settle(client.guilds.get(guild))).toBeUndefined()
        await turn()
        expect(changes).toEqual([
            { kind: "members", op: "delete", key: `${guild}:${user}` },
            { kind: "messages", op: "delete", key: `${channel}:${message.id}` },
            { kind: "guilds", op: "delete", key: guild },
        ])
    })

    test.each([
        { kind: "users", route: "GET /users/:id", action: "delete" },
        { kind: "messages", route: "GET /channels/:channelId/messages/:messageId", action: "delete" },
        { kind: "channels", route: "GET /channels/:id", action: "delete" },
        { kind: "members", route: "GET /guilds/:guildId/members/:userId", action: "clear" },
    ] as const)(
        "a $kind read in flight cannot restore an entry removed by $action",
        async ({ kind, route, action }) => {
            const test = await open(mode, { cache: { [kind]: true } })
            const { client, fixtures, rest } = test
            const { guild, user, channel } = fixtures.ids
            const message = fixtures.message()
            const reads = {
                users: {
                    key: user,
                    body: fixtures.user(),
                    fetch: () => client.users.fetch(user),
                    get: () => client.users.get(user),
                },
                messages: {
                    key: `${channel}:${message.id}`,
                    body: message,
                    fetch: () => client.messages.fetch({ channelId: channel, id: message.id }),
                    get: () => client.messages.get({ channelId: channel, id: message.id }),
                },
                channels: {
                    key: channel,
                    body: fixtures.channel(),
                    fetch: () => client.channels.fetch(channel),
                    get: () => client.channels.get(channel),
                },
                members: {
                    key: `${guild}:${user}`,
                    body: fixtures.member(),
                    fetch: () => client.members.fetch({ guildId: guild, userId: user }),
                    get: () => client.members.get({ guildId: guild, userId: user }),
                },
            }[kind]
            let hold: { arrived: () => void; release: Promise<void> } | undefined
            rest.respond(route, async () => {
                if (hold) {
                    hold.arrived()
                    await hold.release
                }
                return { body: reads.body }
            })
            await settle(reads.fetch())
            expect(await settle(reads.get())).toBeDefined()

            const arrived = Promise.withResolvers<void>()
            const release = Promise.withResolvers<void>()
            hold = { arrived: arrived.resolve, release: release.promise }
            const pending = settle(reads.fetch())
            await arrived.promise
            if (action === "delete") client.cache.delete(kind, reads.key)
            else client.cache.clear(kind)
            expect(await settle(reads.get())).toBeUndefined()
            release.resolve()
            await pending

            expect(await settle(reads.get())).toBeUndefined()
            hold = undefined
            await settle(reads.fetch())
            expect(await settle(reads.get())).toBeDefined()
        },
    )

    test("an invalid kind or key is misuse that throws ConfigurationError", async () => {
        const test = await open(mode, { cache: { users: true, members: true } })
        const cache = test.client.cache
        const misuse: [() => void, "kind" | "key"][] = [
            [() => cache.clear("nope" as CacheKind), "kind"],
            [() => cache.delete("nope" as CacheKind, "1"), "kind"],
            [() => cache.delete("members", "1"), "key"],
            [() => cache.delete("members", "1:2:3"), "key"],
            [() => cache.delete("users", "1:2"), "key"],
            [() => cache.delete("users", "01"), "key"],
            [() => cache.delete("users", 1 as never), "key"],
        ]
        for (const [run, field] of misuse) {
            const error = thrown(run)
            expect(error).toBeInstanceOf(ConfigurationError)
            expect(error).toMatchObject({ field })
        }
    })
})
