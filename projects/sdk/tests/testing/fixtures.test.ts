import { expect, test } from "vitest"
import { snowflakes } from "../../src/index.js"
import { createFixtures, fixtures } from "../../src/testing.js"
import { decodeChannelEvent } from "../../src/internal/channels.js"
import { decodeGuild, decodeGuildEvent, decodeGuildLifecycleEvent, decodeMember } from "../../src/internal/guilds.js"
import { decodeMessage } from "../../src/internal/message.js"
import { decodeUser } from "../../src/internal/users.js"

// Wire round trips through JSON, as the fake gateway and HTTP transport deliver them
const wire = <A>(value: A): unknown => JSON.parse(JSON.stringify(value))

test("every fixture builder produces a wire payload the SDK's real decoders accept", () => {
    const set = createFixtures()
    const { ids } = set
    expect(decodeUser(wire(set.user()))).toMatchObject({ id: ids.user, isBot: false })
    expect(decodeUser(wire(set.botUser()))).toMatchObject({ id: ids.bot, isBot: true })
    expect(decodeGuild(wire(set.guild()))).toMatchObject({
        id: ids.guild,
        ownerId: ids.user,
        systemChannelId: ids.channel,
    })
    expect(decodeGuildLifecycleEvent("GUILD_UPDATE", wire(set.guild({ name: "Renamed" })))).toMatchObject({
        name: "Renamed",
    })
    expect(decodeGuildLifecycleEvent("GUILD_CREATE", wire(set.guildCreate()))).toMatchObject({
        id: ids.guild,
        isNewJoin: false,
    })
    expect(decodeChannelEvent("CHANNEL_CREATE", wire(set.channel()))).toMatchObject({
        id: ids.channel,
        guildId: ids.guild,
        type: 0,
    })
    const role = set.role({ permissions: String(1n << 40n) })
    expect(decodeGuildEvent("GUILD_ROLE_CREATE", wire({ guild_id: ids.guild, role }))).toMatchObject({
        id: role.id,
        guildId: ids.guild,
        permissions: 1n << 40n,
    })
    expect(decodeGuildEvent("GUILD_MEMBER_ADD", wire(set.member({ roles: [role.id] })))).toMatchObject({
        guildId: ids.guild,
        userId: ids.user,
        roleIds: [role.id],
    })
    // Member reads carry no guild_id, and the membership in GUILD_CREATE drops it as Fluxer does
    const { guild_id: _, ...memberRead } = set.member()
    expect(decodeMember(wire(memberRead), ids.guild)).toMatchObject({ userId: ids.user })
    expect(set.guildCreate().members[0]).not.toHaveProperty("guild_id")
    const message = set.message({ content: "hello" })
    expect(decodeMessage(wire(message))).toMatchObject({
        id: message.id,
        channelId: ids.channel,
        guildId: ids.guild,
        content: "hello",
        author: { id: ids.user },
    })
})

test("fixture sets produce the same increasing snowflake IDs in the same call order", () => {
    const first = createFixtures()
    const second = createFixtures()
    const ids = [first.message().id, first.role().id, first.nextId()]
    expect([second.message().id, second.role().id, second.nextId()]).toEqual(ids)
    expect(second.ids).toEqual(first.ids)
    const all = [...Object.values(first.ids), ...ids]
    expect(new Set(all).size).toBe(all.length)
    expect(all.map(BigInt)).toEqual(all.map(BigInt).toSorted((left, right) => (left < right ? -1 : 1)))
    expect(all.every((id) => snowflakes.createdAt(id).toISOString() === "2026-01-01T00:00:00.000Z")).toBe(true)
    // The shared set continues its own sequence without affecting independent sets
    expect(fixtures.message().id).not.toBe(fixtures.message().id)
})

test("overrides replace wire fields, add fields the SDK does not model and leave out fields set to undefined", () => {
    const set = createFixtures()
    const direct = set.message({ guild_id: undefined, flags: 4, custom_field: "kept" })
    const payload = wire(direct) as Record<string, unknown>
    expect(payload).not.toHaveProperty("guild_id")
    expect(payload).toMatchObject({ flags: 4, custom_field: "kept" })
    expect(decodeMessage(payload)).not.toHaveProperty("guildId")
    const joined = wire(set.guildCreate({ guild: { id: "99", name: "Other" }, unavailable: undefined }))
    expect(joined).toMatchObject({ id: "99", properties: { id: "99", name: "Other" } })
    expect(decodeGuildLifecycleEvent("GUILD_CREATE", joined)).toMatchObject({ id: "99", isNewJoin: true })
    expect(() => set.user("not an object" as never)).toThrow(TypeError)
})
