import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import type { EventName, GuildMember, Message, MessageFields } from "../../../src/index.js"
import { createTestClient as createDefaultTestClient } from "../../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../../src/effect-testing.js"
import { describeBothApis, type Mode } from "../../support/both-apis.js"

type Cache = NonNullable<Parameters<typeof createDefaultTestClient>[0]>["cache"]

/**
 * One in-memory test client in either API style that listens to the decorated events and reads the member and message
 * caches synchronously. Listening matters, because Fluxer is only asked for dispatches that something uses
 */
async function open(mode: Mode, cache: Cache, messageFields?: MessageFields) {
    const options = {
        ...(cache === undefined ? {} : { cache }),
        ...(messageFields === undefined ? {} : { messageFields }),
    }
    const names = [
        "messageCreate",
        "messageUpdate",
        "messageReactionAdd",
        "messageReactionRemove",
        "typingStart",
        "messageDelete",
    ] as const
    const events = Object.fromEntries(names.map((name) => [name, [] as unknown[]])) as Record<
        (typeof names)[number],
        unknown[]
    >
    if (mode === "default") {
        const test = createDefaultTestClient(options)
        onTestFinished(() => test.shutdown())
        for (const name of names) {
            test.client.on(name as EventName, ((value: unknown) => void events[name].push(value)) as never)
        }
        return {
            test,
            events,
            ready: () => test.ready(),
            emitNow: (type: string, payload: unknown) => test.emit(type, payload),
            emit: async (type: string, payload: unknown) => {
                test.emit(type, payload)
                await test.idle()
            },
            member: (guildId: string, userId: string) => test.client.members.get({ guildId, userId }),
            message: (id: string, channelId: string) => test.client.messages.get({ id, channelId }),
            fetchMember: async (guildId: string, userId: string) =>
                (await test.client.members.fetch({ guildId, userId }))._unsafeUnwrap(),
            fetchMessage: async (id: string, channelId: string) =>
                (await test.client.messages.fetch({ id, channelId }))._unsafeUnwrap() as Message,
        }
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const test = await Effect.runPromise(createNativeTestClient(options).pipe(Scope.provide(scope)))
    const on = test.client.on as unknown as (
        name: string,
        handler: (value: unknown) => Effect.Effect<void>,
    ) => Effect.Effect<unknown, never, Scope.Scope>
    for (const name of names)
        await Effect.runPromise(
            on(name, (value) => Effect.sync(() => void events[name].push(value))).pipe(Scope.provide(scope)),
        )
    return {
        test,
        events,
        ready: () => Effect.runPromise(test.ready()),
        emitNow: (type: string, payload: unknown) => Effect.runSync(test.emit(type, payload)),
        emit: async (type: string, payload: unknown) => {
            Effect.runSync(test.emit(type, payload))
            await Effect.runPromise(test.idle())
        },
        member: (guildId: string, userId: string) => Effect.runSync(test.client.members.get({ guildId, userId })),
        message: (id: string, channelId: string) => Effect.runSync(test.client.messages.get({ id, channelId })),
        fetchMember: (guildId: string, userId: string) =>
            Effect.runPromise(test.client.members.fetch({ guildId, userId })),
        fetchMessage: (id: string, channelId: string) =>
            Effect.runPromise(test.client.messages.fetch({ id, channelId })) as Promise<Message>,
    }
}
type Driver = Awaited<ReturnType<typeof open>>

/** A member as Fluxer attaches it to a message: Without its user and guild ID */
function strippedMember(driver: Driver, overrides: Record<string, unknown> = {}) {
    const {
        user: _user,
        guild_id: _guild,
        ...member
    } = driver.test.fixtures.member({
        roles: ["501", "502"],
        nick: "Speaker",
        joined_at: "2026-02-03T04:05:06.000Z",
        communication_disabled_until: "2099-01-01T00:00:00.000Z",
        ...overrides,
    })
    return member
}

const expected = (driver: Driver, overrides: Partial<GuildMember> = {}) => {
    const { fixtures } = driver.test
    return {
        guildId: fixtures.ids.guild,
        userId: fixtures.ids.user,
        username: fixtures.user().username,
        isBot: false,
        roleIds: ["501", "502"],
        nickname: "Speaker",
        joinedAt: "2026-02-03T04:05:06.000Z",
        communicationDisabledUntil: "2099-01-01T00:00:00.000Z",
        ...overrides,
    }
}

describeBothApis("member on message, reaction and typing events", (mode) => {
    test("a message delivers the author's member, completed from the author, and fills an empty member cache without a request", async () => {
        const driver = await open(mode, { members: true })
        await driver.ready()
        const { fixtures } = driver.test
        const guildId = fixtures.ids.guild
        expect(driver.member(guildId, fixtures.ids.user)).toBeUndefined()

        const created = fixtures.message({ member: strippedMember(driver) })
        await driver.emit("MESSAGE_CREATE", created)
        const [message] = driver.events.messageCreate as Message[]
        expect(message!.member).toMatchObject(expected(driver))
        expect(Object.isFrozen(message!.member)).toBe(true)
        expect(driver.member(guildId, fixtures.ids.user)).toEqual(message!.member)

        // An edit carries the member as it is by then, and replaces the cached one
        await driver.emit(
            "MESSAGE_UPDATE",
            fixtures.message({ id: created.id, member: strippedMember(driver, { roles: ["503"], nick: null }) }),
        )
        const [update] = driver.events.messageUpdate as Message[]
        expect(update!.member).toMatchObject(expected(driver, { roleIds: ["503"], nickname: null }))
        expect(driver.member(guildId, fixtures.ids.user)).toEqual(update!.member)
        expect(driver.test.requests()).toEqual([])
    })

    test("a bot author's flag comes from the author", async () => {
        const driver = await open(mode, { members: true })
        await driver.ready()
        const { fixtures } = driver.test
        await driver.emit(
            "MESSAGE_CREATE",
            fixtures.message({ author: fixtures.botUser(), member: strippedMember(driver) }),
        )
        const [message] = driver.events.messageCreate as Message[]
        expect(message!.member).toMatchObject({ userId: fixtures.ids.bot, isBot: true })
    })

    test("reactions and typing deliver the member Fluxer attached with its user, and store it", async () => {
        const driver = await open(mode, { members: true })
        await driver.ready()
        const { fixtures } = driver.test
        const guildId = fixtures.ids.guild
        const withUser = (overrides: Record<string, unknown> = {}) =>
            fixtures.member({
                roles: ["501", "502"],
                nick: "Speaker",
                joined_at: "2026-02-03T04:05:06.000Z",
                ...overrides,
            })
        const { guild_id: _, ...member } = withUser()
        const reaction = {
            channel_id: fixtures.ids.channel,
            message_id: "900",
            guild_id: guildId,
            user_id: fixtures.ids.user,
            emoji: { name: "👍" },
            member,
        }
        await driver.emit("MESSAGE_REACTION_ADD", reaction)
        const [added] = driver.events.messageReactionAdd as { member?: GuildMember }[]
        expect(added!.member).toMatchObject({ guildId, userId: fixtures.ids.user, roleIds: ["501", "502"] })
        expect(driver.member(guildId, fixtures.ids.user)).toEqual(added!.member)

        const { guild_id: __, ...changed } = withUser({ roles: ["504"] })
        await driver.emit("MESSAGE_REACTION_REMOVE", { ...reaction, member: changed })
        const [removed] = driver.events.messageReactionRemove as { member?: GuildMember }[]
        expect(removed!.member).toMatchObject({ roleIds: ["504"] })
        expect(driver.member(guildId, fixtures.ids.user)?.roleIds).toEqual(["504"])

        const other = fixtures.user({ id: fixtures.nextId() })
        const { guild_id: ___, ...typist } = withUser({ user: other, roles: ["505"] })
        await driver.emit("TYPING_START", {
            channel_id: fixtures.ids.channel,
            user_id: other.id,
            guild_id: guildId,
            timestamp: 1_800_000_000,
            member: typist,
        })
        const [typing] = driver.events.typingStart as { member?: GuildMember }[]
        expect(typing!.member).toMatchObject({ userId: other.id, username: other.username, roleIds: ["505"] })
        expect(driver.member(guildId, other.id)).toEqual(typing!.member)
        expect(driver.test.requests()).toEqual([])
    })

    test("with the member cache off the event still carries the member and nothing is stored", async () => {
        const driver = await open(mode, { roles: true })
        await driver.ready()
        const { fixtures } = driver.test
        await driver.emit("MESSAGE_CREATE", fixtures.message({ member: strippedMember(driver) }))
        expect((driver.events.messageCreate[0] as Message).member).toMatchObject(expected(driver))
        expect(driver.member(fixtures.ids.guild, fixtures.ids.user)).toBeUndefined()
    })

    test("a message cache keeps a frozen copy without the member and leaves the handler's message with it", async () => {
        const driver = await open(mode, { members: true, messages: true })
        await driver.ready()
        const { fixtures } = driver.test
        const created = fixtures.message({ member: strippedMember(driver) })
        await driver.emit("MESSAGE_CREATE", created)
        await driver.emit("MESSAGE_UPDATE", { ...created, content: "edited", member: strippedMember(driver) })
        const [message] = driver.events.messageCreate as Message[]
        const [update] = driver.events.messageUpdate as Message[]
        // The delivered objects keep their member after the cache stored its copy
        expect(message!.member).toMatchObject(expected(driver))
        expect(update!.member).toMatchObject(expected(driver))
        const cached = driver.message(created.id, created.channel_id)!
        expect(cached).not.toBe(update)
        expect(cached.content).toBe("edited")
        expect(Object.isFrozen(cached)).toBe(true)
        expect("member" in cached).toBe(false)
    })

    test("a selection without member or guildId still fills the member cache and omits the member from the message", async () => {
        const driver = await open(mode, { members: true }, [])
        await driver.ready()
        const { fixtures } = driver.test
        await driver.emit("MESSAGE_CREATE", fixtures.message({ member: strippedMember(driver) }))
        const [message] = driver.events.messageCreate as Message[]
        expect(message).toBeDefined()
        expect("member" in message!).toBe(false)
        expect("guildId" in message!).toBe(true)
        expect(driver.member(fixtures.ids.guild, fixtures.ids.user)).toMatchObject(expected(driver))
        expect(driver.test.requests()).toEqual([])
    })

    test("a selection naming member delivers it", async () => {
        const driver = await open(mode, undefined, ["member"])
        await driver.ready()
        await driver.emit("MESSAGE_CREATE", driver.test.fixtures.message({ member: strippedMember(driver) }))
        expect((driver.events.messageCreate[0] as Message).member).toMatchObject(expected(driver))
    })

    test("a malformed member is omitted, the event arrives, and the cached member is dropped with a warning", async () => {
        const driver = await open(mode, { members: true })
        await driver.ready()
        const { fixtures } = driver.test
        const guildId = fixtures.ids.guild
        await driver.emit("MESSAGE_CREATE", fixtures.message({ member: strippedMember(driver) }))
        expect(driver.member(guildId, fixtures.ids.user)).toBeDefined()

        await driver.emit("MESSAGE_CREATE", fixtures.message({ member: strippedMember(driver, { roles: "none" }) }))
        const messages = driver.events.messageCreate as Message[]
        expect(messages).toHaveLength(2)
        expect("member" in messages[1]!).toBe(false)
        expect(driver.member(guildId, fixtures.ids.user)).toBeUndefined()
        expect(driver.test.logs().filter((record) => record.code === "gateway.memberSkipped")).toHaveLength(1)

        // The same holds for a reaction whose member names a different user than the one who reacted
        await driver.emit("MESSAGE_CREATE", fixtures.message({ member: strippedMember(driver) }))
        expect(driver.member(guildId, fixtures.ids.user)).toBeDefined()
        const { guild_id: _, ...member } = fixtures.member({ user: fixtures.user({ id: fixtures.nextId() }) })
        await driver.emit("MESSAGE_REACTION_ADD", {
            channel_id: fixtures.ids.channel,
            message_id: "900",
            guild_id: guildId,
            user_id: fixtures.ids.user,
            emoji: { name: "👍" },
            member,
        })
        const [added] = driver.events.messageReactionAdd as { member?: GuildMember }[]
        expect(added).toBeDefined()
        expect("member" in added!).toBe(false)
        expect(driver.member(guildId, fixtures.ids.user)).toBeUndefined()
    })

    test("a reaction member without the user's name is omitted, and completes from the cached member for the cache", async () => {
        const driver = await open(mode, { members: true })
        await driver.ready()
        const { fixtures } = driver.test
        const guildId = fixtures.ids.guild
        const idOnly = (roles: string[]) => {
            const { guild_id: _, ...member } = fixtures.member({ roles })
            return {
                channel_id: fixtures.ids.channel,
                message_id: "900",
                guild_id: guildId,
                user_id: fixtures.ids.user,
                emoji: { name: "👍" },
                member: { ...member, user: { id: fixtures.ids.user } },
            }
        }
        // Without a held name nothing is invented
        await driver.emit("MESSAGE_REACTION_ADD", idOnly(["601"]))
        expect("member" in (driver.events.messageReactionAdd[0] as object)).toBe(false)
        expect(driver.member(guildId, fixtures.ids.user)).toBeUndefined()

        await driver.emit("MESSAGE_CREATE", fixtures.message({ member: strippedMember(driver) }))
        await driver.emit("MESSAGE_REACTION_ADD", idOnly(["602"]))
        expect("member" in (driver.events.messageReactionAdd[1] as object)).toBe(false)
        expect(driver.member(guildId, fixtures.ids.user)).toMatchObject({
            username: fixtures.user().username,
            roleIds: ["602"],
        })
        // Only the first, which had no name to borrow, was skipped
        expect(driver.test.logs().filter((record) => record.code === "gateway.memberSkipped")).toHaveLength(1)
    })

    test("direct, webhook and member-less messages carry no member and store nothing", async () => {
        const driver = await open(mode, { members: true })
        await driver.ready()
        const { fixtures } = driver.test
        const { guild_id: _, ...direct } = fixtures.message({ member: strippedMember(driver) })
        await driver.emit("MESSAGE_CREATE", direct)
        await driver.emit(
            "MESSAGE_CREATE",
            fixtures.message({ webhook_id: fixtures.nextId(), member: strippedMember(driver) }),
        )
        await driver.emit("MESSAGE_CREATE", fixtures.message())
        const messages = driver.events.messageCreate as Message[]
        expect(messages).toHaveLength(3)
        for (const message of messages) expect("member" in message).toBe(false)
        expect(driver.member(fixtures.ids.guild, fixtures.ids.user)).toBeUndefined()
        expect(driver.test.logs().filter((record) => record.code === "gateway.memberSkipped")).toHaveLength(0)
    })

    test("a member read in flight when an event stores the member is not allowed to overwrite it", async () => {
        const driver = await open(mode, { members: true })
        await driver.ready()
        const { fixtures } = driver.test
        const guildId = fixtures.ids.guild
        let release!: () => void
        const answered = new Promise<void>((resolve) => (release = resolve))
        const route = driver.test.rest.respond(`GET /guilds/${guildId}/members/${fixtures.ids.user}`, async () => {
            await answered
            return { body: fixtures.member({ roles: ["700"] }) }
        })
        const read = driver.fetchMember(guildId, fixtures.ids.user)
        await route.next()
        // Idle would wait for the pending read, and the cache is written before handlers run
        driver.emitNow("MESSAGE_CREATE", fixtures.message({ member: strippedMember(driver, { roles: ["701"] }) }))
        expect(driver.member(guildId, fixtures.ids.user)?.roleIds).toEqual(["701"])
        release()
        await read
        // The overlapping read was invalidated, so its answer is not stored. The cache's conservative rule evicts the
        // newer entry too, because it differs from that answer, and the next read starts clean
        expect(driver.member(guildId, fixtures.ids.user)).toBeUndefined()
    })

    test("a rejected message, reaction or typing dispatch drops the cached member it could have changed", async () => {
        const driver = await open(mode, { members: true })
        await driver.ready()
        const { fixtures } = driver.test
        const guildId = fixtures.ids.guild
        const userId = fixtures.ids.user
        const seed = async () => {
            await driver.emit("MESSAGE_CREATE", fixtures.message({ member: strippedMember(driver) }))
            expect(driver.member(guildId, userId)).toBeDefined()
        }
        const { guild_id: _, ...userMember } = fixtures.member({ roles: ["801"] })
        const reaction = {
            channel_id: fixtures.ids.channel,
            message_id: "900",
            guild_id: guildId,
            user_id: userId,
            emoji: { name: "👍" },
            member: userMember,
        }

        await seed()
        await driver.emit("MESSAGE_CREATE", fixtures.message({ content: 5 as never, member: strippedMember(driver) }))
        expect(driver.member(guildId, userId)).toBeUndefined()

        await seed()
        await driver.emit("MESSAGE_UPDATE", fixtures.message({ content: 5 as never, member: strippedMember(driver) }))
        expect(driver.member(guildId, userId)).toBeUndefined()

        await seed()
        await driver.emit("MESSAGE_REACTION_ADD", { ...reaction, emoji: { name: 5 } })
        expect(driver.member(guildId, userId)).toBeUndefined()

        await seed()
        await driver.emit("TYPING_START", {
            channel_id: fixtures.ids.channel,
            user_id: userId,
            guild_id: guildId,
            timestamp: "late",
            member: userMember,
        })
        expect(driver.member(guildId, userId)).toBeUndefined()
        expect(driver.events.messageCreate).toHaveLength(4)
        expect(driver.events.typingStart).toHaveLength(0)

        // A rejected dispatch without a member, or from a webhook, could not have changed the cache
        await seed()
        await driver.emit("MESSAGE_CREATE", fixtures.message({ content: 5 as never }))
        await driver.emit(
            "MESSAGE_CREATE",
            fixtures.message({ content: 5 as never, webhook_id: "1", member: strippedMember(driver) }),
        )
        expect(driver.member(guildId, userId)).toBeDefined()
    })

    test("a rejected message whose webhook ID is malformed still drops the cached member, and a valid webhook does not", async () => {
        const driver = await open(mode, { members: true })
        await driver.ready()
        const { fixtures } = driver.test
        const guildId = fixtures.ids.guild
        const userId = fixtures.ids.user
        for (const type of ["MESSAGE_CREATE", "MESSAGE_UPDATE"]) {
            await driver.emit("MESSAGE_CREATE", fixtures.message({ member: strippedMember(driver) }))
            expect(driver.member(guildId, userId)).toBeDefined()
            await driver.emit(
                type,
                fixtures.message({ content: 5 as never, webhook_id: "1", member: strippedMember(driver) }),
            )
            expect(driver.member(guildId, userId)).toBeDefined()
            await driver.emit(
                type,
                fixtures.message({ content: 5 as never, webhook_id: 5, member: strippedMember(driver) }),
            )
            expect(driver.member(guildId, userId)).toBeUndefined()
        }
    })

    test("a rejected dispatch with an unusable identity drops the community's members, or every member", async () => {
        const driver = await open(mode, { members: true })
        await driver.ready()
        const { fixtures } = driver.test
        const guildId = fixtures.ids.guild
        const otherId = fixtures.nextId()
        const other = fixtures.user({ id: otherId })
        const seed = async () => {
            await driver.emit("MESSAGE_CREATE", fixtures.message({ member: strippedMember(driver) }))
            await driver.emit("MESSAGE_CREATE", fixtures.message({ author: other, member: strippedMember(driver) }))
            expect(driver.member(guildId, otherId)).toBeDefined()
        }
        await seed()
        // The author is unusable, so no single account can be named
        await driver.emit("MESSAGE_CREATE", fixtures.message({ author: {} as never, member: strippedMember(driver) }))
        expect(driver.member(guildId, fixtures.ids.user)).toBeUndefined()
        expect(driver.member(guildId, otherId)).toBeUndefined()

        await seed()
        // The author is unusable but author_id names the account, as it does for Fluxer's own extraction
        await driver.emit(
            "MESSAGE_CREATE",
            fixtures.message({ author: {} as never, author_id: fixtures.ids.user, member: strippedMember(driver) }),
        )
        expect(driver.member(guildId, fixtures.ids.user)).toBeUndefined()
        expect(driver.member(guildId, otherId)).toBeDefined()

        await seed()
        // Neither is the community, so every cached member goes
        const { guild_id: _guild, ...noGuild } = fixtures.message({
            content: 5 as never,
            member: strippedMember(driver),
        })
        await driver.emit("MESSAGE_CREATE", noGuild)
        expect(driver.member(guildId, fixtures.ids.user)).toBeUndefined()
        expect(driver.member(guildId, otherId)).toBeUndefined()
    })

    test("only an absent username or bot flag is completed, and one that is present and invalid is malformed", async () => {
        const driver = await open(mode, { members: true })
        await driver.ready()
        const { fixtures } = driver.test
        const botId = fixtures.ids.bot
        const reaction = (guildId: string, user: Record<string, unknown>) => {
            const { guild_id: _, ...member } = fixtures.member({ roles: ["602"] })
            return {
                channel_id: fixtures.ids.channel,
                message_id: "900",
                guild_id: guildId,
                user_id: botId,
                emoji: { name: "👍" },
                member: { ...member, user },
            }
        }
        const seed = async (guildId: string) =>
            driver.emit(
                "MESSAGE_CREATE",
                fixtures.message({ guild_id: guildId, author: fixtures.botUser(), member: strippedMember(driver) }),
            )
        // Identical records collapse, so each case runs in a community of its own and asserts its own record
        const warnings = (guildId: string) =>
            driver.test
                .logs()
                .filter((record) => record.code === "gateway.memberSkipped" && record.fields?.guildId === guildId)
                .length

        // Absent name and bot flag come from the cached member, so the cache refreshes and nothing is logged
        const completed = fixtures.nextId()
        await seed(completed)
        await driver.emit("MESSAGE_REACTION_ADD", reaction(completed, { id: botId }))
        expect(driver.member(completed, botId)).toMatchObject({ roleIds: ["602"], isBot: true })
        expect(warnings(completed)).toBe(0)

        for (const [index, user] of [
            { id: botId, username: 123 },
            { id: botId, username: null },
            { id: botId, username: "fixture-bot", bot: null },
            { id: botId, bot: "yes" },
        ].entries()) {
            const guildId = fixtures.nextId()
            await seed(guildId)
            await driver.emit("MESSAGE_REACTION_ADD", reaction(guildId, user))
            expect("member" in (driver.events.messageReactionAdd[index + 1] as object)).toBe(false)
            expect(driver.member(guildId, botId)).toBeUndefined()
            expect(warnings(guildId)).toBe(1)
        }
    })

    test("a nameless typing member is omitted from the event, and completes from the cached member for the cache", async () => {
        const driver = await open(mode, { members: true })
        await driver.ready()
        const { fixtures } = driver.test
        const guildId = fixtures.ids.guild
        const userId = fixtures.ids.user
        const typing = (roles: string[]) => {
            const { guild_id: _, ...member } = fixtures.member({ roles })
            return {
                channel_id: fixtures.ids.channel,
                user_id: userId,
                guild_id: guildId,
                timestamp: 1_800_000_000,
                member: { ...member, user: { id: userId } },
            }
        }
        const warnings = () => driver.test.logs().filter((record) => record.code === "gateway.memberSkipped").length
        await driver.emit("TYPING_START", typing(["611"]))
        expect(driver.member(guildId, userId)).toBeUndefined()
        // Nothing was held to borrow the name from, so the member was skipped
        expect(warnings()).toBe(1)
        await driver.emit("MESSAGE_CREATE", fixtures.message({ member: strippedMember(driver) }))
        await driver.emit("TYPING_START", typing(["612"]))
        expect(driver.member(guildId, userId)).toMatchObject({ username: fixtures.user().username, roleIds: ["612"] })
        // Completed from the cache, so nothing more was logged
        expect(warnings()).toBe(1)
        for (const notice of driver.events.typingStart) expect("member" in (notice as object)).toBe(false)
        expect(driver.events.typingStart).toHaveLength(2)
    })

    test("a REST message never carries a member, and a deletion's member is neither delivered nor stored", async () => {
        const driver = await open(mode, { members: true })
        await driver.ready()
        const { fixtures } = driver.test
        const guildId = fixtures.ids.guild
        const message = fixtures.message({ member: strippedMember(driver) })
        driver.test.rest.respond(`GET /channels/${message.channel_id}/messages/${message.id}`, { body: message })
        const fetched = await driver.fetchMessage(message.id, message.channel_id)
        expect(fetched.content).toBe(message.content)
        expect("member" in fetched).toBe(false)
        expect(driver.member(guildId, fixtures.ids.user)).toBeUndefined()

        await driver.emit("MESSAGE_DELETE", {
            id: message.id,
            channel_id: message.channel_id,
            guild_id: guildId,
            author_id: fixtures.ids.user,
            member: strippedMember(driver),
        })
        expect(driver.events.messageDelete).toHaveLength(1)
        expect("member" in (driver.events.messageDelete[0] as object)).toBe(false)
        expect(driver.member(guildId, fixtures.ids.user)).toBeUndefined()
    })
})

test("a voice state's member is never stored in the member cache", async () => {
    const test = createDefaultTestClient({ cache: { members: true } })
    onTestFinished(() => test.shutdown())
    test.client.on("voiceStateUpdate", () => undefined)
    await test.ready()
    const { fixtures } = test
    const { guild_id: _, ...member } = fixtures.member()
    test.emit("VOICE_STATE_UPDATE", {
        guild_id: fixtures.ids.guild,
        channel_id: fixtures.ids.channel,
        user_id: fixtures.ids.user,
        connection_id: "connection",
        session_id: "session",
        mute: false,
        deaf: false,
        self_mute: false,
        self_deaf: false,
        is_mobile: false,
        suppress: false,
        member,
    })
    await test.idle()
    expect(test.client.members.get({ guildId: fixtures.ids.guild, userId: fixtures.ids.user })).toBeUndefined()
})
