import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import type { ClientOptions, GuildMember, GuildRole } from "../../../src/index.js"
import { createTestClient as createDefaultTestClient } from "../../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../../src/effect-testing.js"
import { describeBothApis, type Mode } from "../../support/both-apis.js"
import { expectDefect, expectThrown } from "../defects.js"

/** One in-memory test client in either API style, with the cache lookups under test read synchronously */
async function open(mode: Mode, cache: NonNullable<ClientOptions["cache"]>) {
    if (mode === "default") {
        const test = createDefaultTestClient({ cache })
        onTestFinished(() => test.shutdown())
        const client = test.client
        return {
            test,
            client,
            ready: () => test.ready(),
            emit: (type: string, payload: unknown) => test.emit(type, payload),
            roles: (guildId: string) => client.roles.getAll(guildId),
            role: (guildId: string, id: string) => client.roles.get({ guildId, id }),
            member: (guildId: string, userId: string) => client.members.get({ guildId, userId }),
            self: (guildId: string) => client.members.getSelf(guildId),
            fetchSelf: async (guildId: string) => (await client.members.fetchSelf(guildId))._unsafeUnwrap(),
            fetchAll: async (guildId: string) => (await client.roles.fetchAll(guildId))._unsafeUnwrap(),
            misuse: () => [
                expectThrown(() => client.roles.getAll("bad")),
                expectThrown(() => client.members.getSelf("bad")),
            ],
            shutdown: async () => void (await client.shutdown()),
        }
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const test = await Effect.runPromise(createNativeTestClient({ cache }).pipe(Scope.provide(scope)))
    const client = test.client
    return {
        test,
        client,
        ready: () => Effect.runPromise(test.ready()),
        emit: (type: string, payload: unknown) => Effect.runSync(test.emit(type, payload)),
        roles: (guildId: string) => Effect.runSync(client.roles.getAll(guildId)),
        role: (guildId: string, id: string) => Effect.runSync(client.roles.get({ guildId, id })),
        member: (guildId: string, userId: string) => Effect.runSync(client.members.get({ guildId, userId })),
        self: (guildId: string) => Effect.runSync(client.members.getSelf(guildId)),
        fetchSelf: (guildId: string) => Effect.runPromise(client.members.fetchSelf(guildId)),
        fetchAll: (guildId: string) => Effect.runPromise(client.roles.fetchAll(guildId)),
        misuse: () =>
            Promise.all([expectDefect(client.roles.getAll("bad")), expectDefect(client.members.getSelf("bad"))]),
        shutdown: () => Effect.runPromise(client.shutdown()),
    }
}

const ids = (roles: readonly GuildRole[] | undefined) => roles?.map((role) => role.id)

describeBothApis("cached role lists and the bot's own member", (mode) => {
    test("answer from a guildCreate and from fetches, highest role first, without requests", async () => {
        const driver = await open(mode, { roles: true, members: true })
        await driver.ready()
        const { fixtures } = driver.test
        const guildId = fixtures.ids.guild
        expect(driver.roles(guildId)).toBeUndefined()
        expect(driver.self(guildId)).toBeUndefined()

        const higher = fixtures.role({ position: 3 })
        driver.emit("GUILD_CREATE", fixtures.guildCreate({ roles: [...fixtures.guildCreate().roles, higher] }))
        const roles = driver.roles(guildId)
        expect(ids(roles)).toEqual([higher.id, guildId])
        expect(Object.isFrozen(roles)).toBe(true)
        expect(driver.self(guildId)).toMatchObject({ guildId, userId: fixtures.ids.bot } satisfies Partial<GuildMember>)

        const created = fixtures.role({ position: 1 })
        driver.emit("GUILD_ROLE_CREATE", { guild_id: guildId, role: created })
        expect(ids(driver.roles(guildId))).toEqual([higher.id, created.id, guildId])
        driver.emit("GUILD_ROLE_DELETE", { guild_id: guildId, role_id: created.id })
        expect(driver.roles(guildId)).toBeUndefined()
        expect(driver.test.requests()).toEqual([])

        // A full read restores the list, and a self read fills the bot's member in a community without a snapshot
        driver.test.rest.respond("GET /guilds/:id/roles", {
            body: [fixtures.role({ id: guildId, name: "@everyone", position: 0 }), higher],
        })
        await driver.fetchAll(guildId)
        expect(ids(driver.roles(guildId))).toEqual([higher.id, guildId])
        const otherGuildId = fixtures.nextId()
        driver.test.rest.respond("GET /guilds/:id/members/@me", {
            body: fixtures.member({ guild_id: otherGuildId, user: fixtures.botUser() }),
        })
        await driver.fetchSelf(otherGuildId)
        expect(driver.self(otherGuildId)).toMatchObject({ guildId: otherGuildId, userId: fixtures.ids.bot })
    })

    test("members.getSelf is undefined while the member cache is off, and both lookups reject malformed IDs", async () => {
        const driver = await open(mode, { roles: true })
        await driver.ready()
        const { fixtures } = driver.test
        driver.emit("GUILD_CREATE", fixtures.guildCreate())
        expect(driver.self(fixtures.ids.guild)).toBeUndefined()
        expect(driver.roles(fixtures.ids.guild)).toBeDefined()

        for (const [failure, operation] of (await driver.misuse()).map(
            (failure, index) => [failure, ["roles.getAll", "members.getSelf"][index]] as const,
        ))
            expect(failure).toMatchObject({
                _tag: "GuildOperationError",
                operation,
                reason: "input",
                outcome: "notDispatched",
            })
        await driver.shutdown()
        // A closed client has no cache, so its lookups answer undefined
        expect(driver.roles(fixtures.ids.guild)).toBeUndefined()
        expect(driver.self(fixtures.ids.guild)).toBeUndefined()
    })

    test("a startup guildCreate, whose members carry only user IDs, stores the bot's own member from READY", async () => {
        const driver = await open(mode, { members: true })
        await driver.ready()
        const { fixtures } = driver.test
        const guildId = fixtures.ids.guild
        // Fluxer strips each member's user to its ID in the guildCreate events that follow READY
        const snapshot = fixtures.guildCreate()
        const { guild_id: _, ...other } = fixtures.member({ user: fixtures.user({ id: fixtures.nextId() }) })
        const listed = [...(snapshot.members as { readonly user: { readonly id: string } }[]), other]
        const members = listed.map((member) => ({ ...member, user: { id: member.user.id } }))
        driver.emit("GUILD_CREATE", { ...snapshot, members })

        expect(driver.self(guildId)).toMatchObject({
            guildId,
            userId: fixtures.ids.bot,
            username: fixtures.botUser().username,
            isBot: true,
        } satisfies Partial<GuildMember>)
        // READY lists no other users for a bot, so another stripped member is left out rather than guessed
        expect(driver.member(guildId, other.user.id)).toBeUndefined()
    })

    test("before a session, a full role read is never complete, and the first session releases earlier reads", async () => {
        const driver = await open(mode, { roles: true, members: true })
        const { fixtures } = driver.test
        const guildId = fixtures.ids.guild
        const everyone = fixtures.role({ id: guildId, name: "@everyone", position: 0 })
        const higher = fixtures.role({ position: 2 })
        driver.test.rest.respond("GET /guilds/:id/roles", { body: [everyone, higher] })
        // Nothing keeps a list read without a connection current, so it stays unknown
        await driver.fetchAll(guildId)
        expect(driver.roles(guildId)).toBeUndefined()
        expect(driver.role(guildId, higher.id)).toBeDefined()

        // A members.fetchSelf result supplies the bot's account ID before READY does
        driver.test.rest.respond("GET /guilds/:id/members/@me", {
            body: fixtures.member({ guild_id: guildId, user: fixtures.botUser() }),
        })
        await driver.fetchSelf(guildId)
        expect(driver.self(guildId)).toMatchObject({ guildId, userId: fixtures.ids.bot })

        // A read still pending when the first session starts must not store its answer either
        let release!: () => void
        const answered = new Promise<void>((resolve) => (release = resolve))
        const pending = driver.test.rest.respond("GET /guilds/:id/roles", async () => {
            await answered
            return { body: [everyone, higher] }
        })
        const read = driver.fetchAll(guildId)
        await pending.next()
        await driver.ready()
        expect(driver.role(guildId, higher.id)).toBeUndefined()
        expect(driver.self(guildId)).toBeUndefined()
        release()
        expect(ids(await read)).toEqual([guildId, higher.id])
        expect(driver.role(guildId, higher.id)).toBeUndefined()
        expect(driver.roles(guildId)).toBeUndefined()

        // While connected, a full read makes the list complete
        pending.remove()
        await driver.fetchAll(guildId)
        expect(ids(driver.roles(guildId))).toEqual([higher.id, guildId])
    })
})
