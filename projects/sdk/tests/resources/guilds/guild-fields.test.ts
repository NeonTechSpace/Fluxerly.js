import { Effect, Exit, Scope } from "effect"
import { expect, onTestFinished, test } from "vitest"
import { GuildNsfwLevels, type GuildMember } from "../../../src/index.js"
import { GuildNsfwLevels as NativeGuildNsfwLevels } from "../../../src/effect.js"
import { createTestClient as createDefaultTestClient } from "../../../src/testing.js"
import { createTestClient as createNativeTestClient } from "../../../src/effect-testing.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { settle } from "../../support/settle.js"

// Fluxer 5f3fc0b1: mapGuildToGuildResponse sends rules_channel_id, vanity_url_code, nsfw_level and badge_ids, and
// mapMemberFields sends the account as the full partial user, with global_name and avatar
const guild = (overrides: Record<string, unknown> = {}) => ({
    id: "20",
    owner_id: "30",
    name: "fixture",
    features: [],
    rules_channel_id: "21",
    vanity_url_code: "fixture",
    nsfw_level: 3,
    badge_ids: ["7", "8"],
    ...overrides,
})

const account = {
    id: "40",
    username: "ada",
    discriminator: "0001",
    global_name: "Ada",
    avatar: "a1b2",
    avatar_color: 255,
    flags: 0,
}

const member = (user: Record<string, unknown>) => ({
    user,
    nick: "Ada here",
    avatar: null,
    roles: [],
    joined_at: "2026-10-08T12:00:00.000Z",
})

async function setup(mode: Mode) {
    const options = { cache: { guilds: true, members: true }, gateway: { ignoredEvents: [] } } as const
    if (mode === "default") {
        const test = createDefaultTestClient(options)
        onTestFinished(() => test.shutdown())
        return { ...test, emit: async (type: string, value: unknown) => test.emit(type, value) }
    }
    const scope = Scope.makeUnsafe()
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    const test = await Effect.runPromise(createNativeTestClient(options).pipe(Scope.provide(scope)))
    return {
        ...test,
        ready: () => Effect.runPromise(test.ready()),
        idle: () => Effect.runPromise(test.idle()),
        emit: (type: string, value: unknown) => Effect.runPromise(test.emit(type, value)),
    }
}

test("both entry points export the guild NSFW levels with Fluxer's wire values", () => {
    expect(GuildNsfwLevels).toEqual({ Safe: 0, AgeRestricted: 3 })
    expect(NativeGuildNsfwLevels).toBe(GuildNsfwLevels)
    expect(Object.isFrozen(GuildNsfwLevels)).toBe(true)
})

test.each(modes)("%s reads rules channel, vanity code, NSFW level and badges from fetches and events", async (mode) => {
    const api = await setup(mode)
    api.rest.respond("GET /guilds/20", { body: guild() })
    const fetched = await settle(api.client.guilds.fetch("20"))
    expect(fetched).toMatchObject({
        rulesChannelId: "21",
        vanityUrlCode: "fixture",
        nsfwLevel: GuildNsfwLevels.AgeRestricted,
        badgeIds: ["7", "8"],
    })
    expect(Object.isFrozen(fetched.badgeIds)).toBe(true)

    await api.ready()
    // Null keeps meaning none is set, and the retired level 2 follows Fluxer's normalization to Safe
    await api.emit(
        "GUILD_UPDATE",
        guild({ rules_channel_id: null, vanity_url_code: null, nsfw_level: 2, badge_ids: [] }),
    )
    await api.idle()
    expect(await settle(api.client.guilds.get("20"))).toMatchObject({
        rulesChannelId: null,
        vanityUrlCode: null,
        nsfwLevel: GuildNsfwLevels.Safe,
        badgeIds: [],
    })
})

test.each(modes)("%s treats an unknown NSFW level or a malformed badge list as a malformed guild", async (mode) => {
    const api = await setup(mode)
    let body = guild({ nsfw_level: 4 })
    api.rest.respond("GET /guilds/20", () => ({ body }))
    for (const invalid of [guild({ nsfw_level: 4 }), guild({ badge_ids: ["badge"] }), guild({ rules_channel_id: 1 })]) {
        body = invalid
        await expect(settle(api.client.guilds.fetch("20"))).rejects.toMatchObject({
            operation: "guilds.fetch",
            reason: "response",
        })
    }
})

test.each(modes)("%s keeps the member's account from fetches and member events", async (mode) => {
    const api = await setup(mode)
    api.rest.respond("GET /guilds/20/members/40", { body: member(account) })
    const fetched = await settle(api.client.members.fetch({ guildId: "20", userId: "40" }))
    expect(fetched).toMatchObject({ userId: "40", username: "ada", nickname: "Ada here" })
    expect(fetched.user).toEqual({
        id: "40",
        username: "ada",
        discriminator: "0001",
        displayName: "Ada",
        avatar: "a1b2",
        avatarColor: 255,
        isBot: false,
        isSystem: false,
        flags: 0,
    })

    await api.ready()
    await api.emit("GUILD_MEMBER_ADD", { ...member({ ...account, global_name: "Ada L" }), guild_id: "20" })
    await api.idle()
    const cached = (await settle(api.client.members.get({ guildId: "20", userId: "40" }))) as GuildMember | undefined
    expect(cached?.user?.displayName).toBe("Ada L")
})

test.each(modes)("%s leaves the account out when Fluxer sends only part of it", async (mode) => {
    const api = await setup(mode)
    api.rest.respond("GET /guilds/20/members/40", { body: member({ id: "40", username: "ada" }) })
    const fetched = await settle(api.client.members.fetch({ guildId: "20", userId: "40" }))
    expect(fetched).toMatchObject({ userId: "40", username: "ada" })
    expect(fetched).not.toHaveProperty("user")
})

test.each(modes)("%s completes a message author's member with the author's account", async (mode) => {
    const api = await setup(mode)
    await api.ready()
    const { user: _user, ...decoration } = member(account)
    await api.emit(
        "MESSAGE_CREATE",
        api.fixtures.message({ guild_id: "20", author: account, member: decoration } as never),
    )
    await api.idle()
    const cached = (await settle(api.client.members.get({ guildId: "20", userId: "40" }))) as GuildMember | undefined
    expect(cached?.user).toMatchObject({ id: "40", displayName: "Ada", avatar: "a1b2" })
})
