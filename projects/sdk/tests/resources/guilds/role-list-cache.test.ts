import { afterEach, expect, test } from "vitest"
import type { ResourceCacheSettings } from "../../../src/cache.js"
import type { GuildRole } from "../../../src/guilds.js"
import type { User } from "../../../src/users.js"
import { GuildCache } from "../../../src/internal/guild-cache.js"
import { createFixtures } from "../../../src/testing.js"

const caches: GuildCache[] = []
afterEach(() => {
    for (const cache of caches) cache.close()
    caches.length = 0
})

const unbounded = { maxEntries: 100, maxBytes: 1_000_000, maxAgeMs: null }

function makeCache(roles: Required<ResourceCacheSettings> = unbounded, now = () => 0) {
    const cache = new GuildCache({ guilds: unbounded, members: unbounded, roles }, now)
    caches.push(cache)
    return cache
}

/** A GUILD_CREATE body with the everyone role and two more, whose role list the cache can fill */
function snapshot(guildId = "20") {
    const fixtures = createFixtures()
    return fixtures.guildCreate({
        guild: { id: guildId },
        roles: [
            fixtures.role({ id: guildId, name: "@everyone", position: 0 }),
            fixtures.role({ id: "31", name: "tied-later", position: 2 }),
            fixtures.role({ id: "30", name: "tied-earlier", position: 2 }),
            fixtures.role({ id: "32", name: "lower", position: 1 }),
        ],
    })
}

function role(id: string, position: number, guildId = "20"): GuildRole {
    return Object.freeze({ guildId, id, name: `role-${id}`, position, permissions: 0n }) as unknown as GuildRole
}

const ids = (roles: readonly GuildRole[] | undefined) => roles?.map((value) => value.id)

function filled(roles?: Required<ResourceCacheSettings>, now?: () => number) {
    const cache = makeCache(roles, now)
    cache.guildEvent("GUILD_CREATE", snapshot())
    return cache
}

function fetchAll(cache: GuildCache, roles: readonly GuildRole[], during?: () => void) {
    const guard = cache.begin({ selection: { kind: "roles", guildId: "20" }, replace: true })
    during?.()
    cache.complete(guard, roles)
    cache.end(guard, false)
}

test("a GUILD_CREATE fill gives the complete list, highest first, and role events keep it complete", () => {
    const cache = filled()
    const roles = cache.getRoles("20")
    // Larger positions rank higher, and the smaller ID ranks higher between equal positions, as Fluxer lists roles
    expect(ids(roles)).toEqual(["30", "31", "32", "20"])
    expect(Object.isFrozen(roles)).toBe(true)
    expect(cache.getRoles("21")).toBeUndefined()

    cache.event("guildRoleCreate", role("33", 5))
    cache.event("guildRoleUpdate", role("32", 6))
    cache.event("guildRoleUpdateBulk", { guildId: "20", roles: [role("31", 7)] } as never)
    expect(ids(cache.getRoles("20"))).toEqual(["31", "32", "33", "30", "20"])
})

test("removing any role or failing to keep an observed one makes the list unknown", () => {
    const cases: [string, (cache: GuildCache) => void][] = [
        ["a role deletion event", (cache) => cache.event("guildRoleDelete", { guildId: "20", id: "31" })],
        ["cache.delete", (cache) => cache.delete("roles", "20", "32")],
        ["clearing the roles", (cache) => cache.clearKind("roles")],
        ["a whole-cache gap", (cache) => cache.gap()],
        ["a new session for its shard", (cache) => cache.gap((guildId) => guildId === "20")],
        ["community unavailability", (cache) => cache.guildEvent("GUILD_DELETE", { id: "20", unavailable: true })],
        [
            "a GUILD_CREATE whose role list is malformed",
            (cache) => cache.guildEvent("GUILD_CREATE", { ...snapshot(), roles: [{ id: "bad" }] }),
        ],
        [
            "a role write by the bot",
            (cache) => {
                const guard = cache.begin({ selection: { kind: "roles", guildId: "20" }, mutation: true })
                cache.complete(guard, role("33", 3))
                cache.end(guard, false)
            },
        ],
        [
            "a role write whose outcome is unknown",
            (cache) => cache.end(cache.begin({ selection: { kind: "roles", guildId: "20" }, mutation: true }), true),
        ],
    ]
    for (const [name, change] of cases) {
        const cache = filled()
        expect(cache.getRoles("20")).toBeDefined()
        change(cache)
        expect([name, cache.getRoles("20")]).toEqual([name, undefined])
    }

    // A role the cache cannot keep leaves the list incomplete even though nothing it held was removed
    const zeroAge = filled({ ...unbounded, maxAgeMs: (value: GuildRole) => (value.id === "33" ? 0 : null) } as never)
    expect(zeroAge.getRoles("20")).toBeDefined()
    zeroAge.event("guildRoleCreate", role("33", 3))
    expect(zeroAge.getRoles("20")).toBeUndefined()
    const failing = filled({
        ...unbounded,
        maxAgeMs: (value: GuildRole) => {
            if (value.id === "33") throw new Error("synthetic maxAgeMs failure")
            return null
        },
    } as never)
    expect(failing.getRoles("20")).toBeDefined()
    failing.event("guildRoleCreate", role("33", 3))
    expect(failing.getRoles("20")).toBeUndefined()
    const oversized = filled({ ...unbounded, maxBytes: 4_000 })
    expect(oversized.getRoles("20")).toBeDefined()
    oversized.event("guildRoleCreate", Object.freeze({ ...role("33", 3), name: "x".repeat(5_000) }))
    expect(oversized.getRoles("20")).toBeUndefined()
})

test("capacity eviction and expiry of one role make the list unknown, while another community's list stays", () => {
    const bounded = filled({ ...unbounded, maxEntries: 8 })
    bounded.guildEvent("GUILD_CREATE", snapshot("21"))
    expect(ids(bounded.getRoles("21"))).toHaveLength(4)
    bounded.event("guildRoleCreate", role("40", 1, "21"))
    // The new role evicted the least recently used role, which belongs to the first community
    expect(bounded.getRoles("20")).toBeUndefined()
    expect(ids(bounded.getRoles("21"))).toEqual(["30", "31", "32", "40", "21"])

    let now = 0
    const expiring = filled({ ...unbounded, maxAgeMs: 10 }, () => now)
    now = 5
    for (const value of [role("20", 0), role("30", 2), role("31", 2)]) expiring.event("guildRoleUpdate", value)
    now = 10
    // Role 32 expired, which getRoles finds before it answers
    expect(expiring.getRoles("20")).toBeUndefined()
    expect(expiring.diagnostics("roles").evictions.expiry).toBe(1)
})

test("an uncontested full role read makes the list complete, but not one that a role event overlapped", () => {
    const cache = makeCache()
    const roles = [role("30", 2), role("20", 0)]
    fetchAll(cache, roles, () => cache.event("guildRoleUpdate", role("30", 3)))
    expect(cache.getRoles("20")).toBeUndefined()

    fetchAll(cache, roles)
    expect(ids(cache.getRoles("20"))).toEqual(["30", "20"])

    // A read that a role write overlapped, or that a lost connection paused, proves nothing either
    cache.event("guildRoleDelete", { guildId: "20", id: "30" })
    fetchAll(cache, roles, () =>
        cache.end(cache.begin({ selection: { kind: "roles", guildId: "20", id: "30" }, mutation: true }), true),
    )
    expect(cache.getRoles("20")).toBeUndefined()
    fetchAll(cache, roles, () => cache.pause((guildId) => guildId === "20"))
    expect(cache.getRoles("20")).toBeUndefined()

    // A read whose roles the cache cannot all keep proves nothing
    const small = makeCache({ ...unbounded, maxEntries: 1 })
    fetchAll(small, roles)
    expect(small.getRoles("20")).toBeUndefined()
})

test("a paused shard keeps the list, as a Resume does, and a disabled roles cache never has one", () => {
    const cache = filled()
    cache.pause((guildId) => guildId === "20")
    expect(ids(cache.getRoles("20"))).toHaveLength(4)

    const disabled = new GuildCache({ guilds: unbounded }, () => 0)
    caches.push(disabled)
    disabled.guildEvent("GUILD_CREATE", snapshot())
    const guard = disabled.begin({ selection: { kind: "roles", guildId: "20" }, replace: true })
    disabled.complete(guard, [])
    disabled.end(guard, false)
    expect(disabled.getRoles("20")).toBeUndefined()
    expect(disabled.diagnostics("roles")).toMatchObject({ hits: 0, misses: 0 })
})

test("a GUILD_CREATE stores the members it lists, one by one, only when the member cache is enabled", () => {
    const fixtures = createFixtures()
    const body = snapshot()
    const voice = fixtures.member({ user: fixtures.user({ id: "50" }) })
    const { guild_id: _, ...voiceMember } = voice
    const withMembers = { ...body, members: [...body.members, voiceMember, { user: { id: "bad" } }] }
    const cache = filled()
    const earlier = cache.begin({ selection: { kind: "members", guildId: "20", id: "51" } })
    cache.complete(earlier, { guildId: "20", userId: "51", roleIds: [] })
    cache.end(earlier, false)
    cache.guildEvent("GUILD_CREATE", withMembers)
    expect(cache.get("members", "20", fixtures.ids.bot)).toMatchObject({ guildId: "20", userId: fixtures.ids.bot })
    expect(cache.get("members", "20", "50")).toMatchObject({ userId: "50" })
    // The listed members are not the community's whole member list, so other cached members stay
    expect(cache.get("members", "20", "51")).toMatchObject({ userId: "51" })

    const disabled = new GuildCache({ roles: unbounded }, () => 0)
    caches.push(disabled)
    disabled.guildEvent("GUILD_CREATE", withMembers)
    expect(disabled.diagnostics("members").retainedEntries).toBe(0)
})

test("a startup GUILD_CREATE, whose member users are stripped to IDs, stores only the bot's own member", () => {
    const fixtures = createFixtures()
    const body = snapshot()
    const { guild_id: _, ...other } = fixtures.member({ user: fixtures.user({ id: "50" }) })
    // Fluxer sends the startup snapshots after READY with each member's user cut down to its ID
    const listed = [...(body.members as { readonly user: { readonly id: string } }[]), other]
    const members = listed.map((member) => ({ ...member, user: { id: member.user.id } }))
    const bot = Object.freeze({ id: fixtures.ids.bot, username: "fixture-bot", isBot: true }) as User
    const cache = makeCache()
    cache.guildEvent("GUILD_CREATE", { ...body, members }, bot)
    expect(cache.get("members", "20", fixtures.ids.bot)).toMatchObject({
        userId: fixtures.ids.bot,
        username: "fixture-bot",
        isBot: true,
    })
    expect(cache.get("members", "20", "50")).toBeUndefined()

    // Without the bot's account, such as before READY supplied a complete one, no stripped member is stored
    const unknown = makeCache()
    unknown.guildEvent("GUILD_CREATE", { ...body, members })
    expect(unknown.diagnostics("members").retainedEntries).toBe(0)
})

test("a full role read completes the list only while the guild's shard is connected", () => {
    let connected = false
    const cache = new GuildCache(
        { roles: unbounded },
        () => 0,
        undefined,
        undefined,
        undefined,
        (guildId) => {
            expect(guildId).toBe("20")
            return connected
        },
    )
    caches.push(cache)
    const roles = [role("30", 2), role("20", 0)]
    fetchAll(cache, roles)
    expect(cache.getRoles("20")).toBeUndefined()
    expect(cache.get("roles", "20", "30")).toBe(roles[0])

    connected = true
    fetchAll(cache, roles)
    expect(ids(cache.getRoles("20"))).toEqual(["30", "20"])
})
