/*
 * Seeded linearizability and invariant model tests for MessageCache, GuildCache, ChannelCache, UserCache and ExpiryQueue.
 * Drives random interleavings of overlapping reads, mutations, gateway observations, deletions, gaps, clears, lookups
 * and clock advances, asserting stale reads never overwrite newer snapshots, entry/byte bounds hold, byte accounting
 * equals the exact sum of retained entries and ExpiryQueue stays bounded
 */
import { expect, test } from "vitest"
import type { GuildChannel } from "../../../src/channels.js"
import type { Guild, GuildRole } from "../../../src/guilds.js"
import type { MessageCore } from "../../../src/messages.js"
import type { DirectMessageChannel, User } from "../../../src/users.js"
import { MessageCache, type CacheRequest } from "../../../src/internal/cache.js"
import { ChannelCache, type ChannelCacheGuard } from "../../../src/internal/channel-cache.js"
import { ExpiryQueue } from "../../../src/internal/expiry-queue.js"
import { GuildCache, type ResourceGuard, type ResourceKind } from "../../../src/internal/guild-cache.js"
import { UserCache, type UserCacheGuard } from "../../../src/internal/user-cache.js"

const baseSeed = Number(process.env.FLUXERLY_MODEL_SEED ?? 1) >>> 0

function prng(seed: number) {
    let state = seed >>> 0
    const next = () => {
        state = (state + 0x6d2b79f5) >>> 0
        let value = state
        value = Math.imul(value ^ (value >>> 15), value | 1)
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
    }
    const below = (count: number) => Math.floor(next() * count)
    return {
        below,
        chance: (probability: number) => next() < probability,
        pick: <T>(items: readonly T[]): T => items[below(items.length)]!,
    }
}

function jsonBytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value))
}

function bigIntJsonBytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item)))
}

function makeMessage(channelId: string, id: string, version: number, guildId?: string): MessageCore {
    return Object.freeze({
        id,
        channelId,
        ...(guildId === undefined ? {} : { guildId }),
        content: `v${version}:${"x".repeat(version % 17)}`,
        author: Object.freeze({ id: `author-${(version % 3) + 1}`, username: `u${version}`, isBot: false }),
        createdAt: new Date(1_700_000_000_000 + version * 1_000),
    }) as MessageCore
}

function makeGuild(id: string, version: number): Guild {
    return Object.freeze({
        id,
        name: `guild-${id}-v${version}-${"g".repeat(version % 13)}`,
        icon: null,
        banner: null,
        splash: null,
        ownerId: "1",
        features: Object.freeze([]),
    }) as unknown as Guild
}

function makeRole(guildId: string, id: string, version: number): GuildRole {
    return Object.freeze({
        id,
        guildId,
        name: `role-${id}-v${version}`,
        color: version % 256,
        position: version % 10,
        permissions: BigInt(version + 1),
        hoist: false,
        mentionable: false,
    }) as unknown as GuildRole
}

function makeChannel(guildId: string, id: string, version: number, type = 0): GuildChannel {
    return Object.freeze({
        id,
        guildId,
        type,
        name: `ch-${id}-v${version}-${"c".repeat(version % 11)}`,
        permissionOverwrites: Object.freeze([
            Object.freeze({ id: "50", type: "role" as const, allow: BigInt(version), deny: 0n }),
        ]),
    }) as unknown as GuildChannel
}

function makeUser(id: string, version: number): User {
    return Object.freeze({
        id,
        username: `user-${id}-v${version}-${"u".repeat(version % 9)}`,
        discriminator: "0001",
        displayName: null,
        avatar: null,
        avatarColor: null,
        isBot: false,
        isSystem: false,
        flags: 0,
    })
}

function makeDm(id: string, version: number): DirectMessageChannel {
    return Object.freeze({
        id,
        type: "dm",
        recipients: Object.freeze([makeUser("99", version)]),
        name: null,
        icon: null,
        ownerId: null,
        nicknames: Object.freeze({}),
        lastMessageId: null,
    })
}

test("MessageCache maintains linearizability, exact byte accounting and bounds under random interleavings", () => {
    // Each message snowflake belongs permanently to one channel, as in Fluxer
    const targets = [
        { channelId: "10", id: "100", guildId: "40" },
        { channelId: "10", id: "101", guildId: "40" },
        { channelId: "11", id: "102", guildId: "40" },
        { channelId: "11", id: "103", guildId: "40" },
        { channelId: "12", id: "104", guildId: undefined },
        { channelId: "12", id: "105", guildId: undefined },
        { channelId: "12", id: "106", guildId: undefined },
    ] as const
    const maxEntries = 5
    const maxBytes = 1_500

    for (let trial = 0; trial < 15; trial++) {
        const seed = (baseSeed + trial * 97) >>> 0
        const rng = prng(seed)
        let now = 1_000
        let version = 1
        const cache = new MessageCache<MessageCore>(
            { maxEntries, maxBytes, maxAgeMs: 250 },
            () => {},
            () => now,
        )

        // Track the newest authoritative version written/invalidated per message id
        const authoritative = new Map<string, number>()
        type OpenRead = {
            readonly guard: CacheRequest
            readonly channelId: string
            readonly snapshot: MessageCore
            readonly snapshotVersion: number
        }
        const openReads: OpenRead[] = []
        const openMutations: CacheRequest[] = []

        const assertInvariants = (step: number) => {
            const tag = `MessageCache seed=${seed} trial=${trial} step=${step}`
            const diag = cache.diagnostics()
            const retained = cache.entries(maxEntries + 10)
            const exactBytes = retained.reduce((sum, message) => sum + jsonBytes(message), 0)
            expect(diag.retainedEntries, `${tag}: retainedEntries`).toBe(retained.length)
            expect(diag.retainedEntries, `${tag}: maxEntries`).toBeLessThanOrEqual(maxEntries)
            expect(diag.accountedBytes, `${tag}: exact bytes`).toBe(exactBytes)
            expect(diag.accountedBytes, `${tag}: maxBytes`).toBeLessThanOrEqual(maxBytes)
            expect(diag.accountedBytes, `${tag}: non-negative bytes`).toBeGreaterThanOrEqual(0)
        }

        for (let step = 0; step < 250; step++) {
            const action = rng.below(100)
            if (action < 22) {
                // Begin a read capturing a snapshot at current version
                const target = rng.pick(targets)
                const readVersion = ++version
                const guard = cache.begin(
                    target.channelId,
                    rng.chance(0.7) ? target.id : undefined,
                    false,
                    cache.generation,
                )
                const snapshot = makeMessage(target.channelId, target.id, readVersion, target.guildId)
                openReads.push({ guard, channelId: target.channelId, snapshot, snapshotVersion: readVersion })
            } else if (action < 44 && openReads.length > 0) {
                // Complete a random open read (possibly stale!)
                const index = rng.below(openReads.length)
                const [read] = openReads.splice(index, 1)
                const latestAuth = authoritative.get(read!.snapshot.id) ?? 0
                cache.complete(read!.guard, [read!.snapshot])
                cache.end(read!.guard)
                if (latestAuth > read!.snapshotVersion) {
                    const current = cache.peek({ channelId: read!.channelId, id: read!.snapshot.id })
                    expect(current?.content, `stale read overwrote newer state at step ${step}`).not.toBe(
                        read!.snapshot.content,
                    )
                }
            } else if (action < 56) {
                // Begin or end a mutation guard
                if (openMutations.length > 0 && rng.chance(0.5)) {
                    const index = rng.below(openMutations.length)
                    const [guard] = openMutations.splice(index, 1)
                    cache.end(guard!)
                } else {
                    const target = rng.pick(targets)
                    const guard = cache.begin(target.channelId, target.id, true, cache.generation)
                    openMutations.push(guard)
                    authoritative.set(target.id, ++version)
                }
            } else if (action < 72) {
                // Direct gateway observe with a newer version
                const target = rng.pick(targets)
                const nextVersion = ++version
                authoritative.set(target.id, nextVersion)
                cache.observe(makeMessage(target.channelId, target.id, nextVersion, target.guildId))
            } else if (action < 80) {
                const target = rng.pick(targets)
                authoritative.set(target.id, ++version)
                cache.delete({ channelId: target.channelId, id: target.id })
            } else if (action < 85) {
                const channelId = rng.pick(["10", "11", "12"] as const)
                const channelTargets = targets.filter((item) => item.channelId === channelId)
                const batch = channelTargets.map((item) => item.id)
                for (const id of batch) authoritative.set(id, ++version)
                cache.deleteMany(channelId, batch)
            } else if (action < 90) {
                if (rng.chance(0.5)) {
                    for (const item of targets) authoritative.set(item.id, ++version)
                    cache.gap()
                } else {
                    // Scoped gap affecting guild "40" and unknown guildId (undefined)
                    for (const item of targets) {
                        if (item.guildId === "40" || item.guildId === undefined) authoritative.set(item.id, ++version)
                    }
                    cache.gap((guildId) => guildId === "40" || guildId === undefined)
                }
            } else if (action < 94) {
                for (const item of targets) authoritative.set(item.id, ++version)
                cache.clear()
            } else if (action < 97) {
                const target = rng.pick(targets)
                if (rng.chance(0.5)) cache.get({ channelId: target.channelId, id: target.id })
                else cache.peek({ channelId: target.channelId, id: target.id })
            } else {
                now += rng.pick([10, 80, 260])
            }
            assertInvariants(step)
        }
        cache.close()
    }
})

test("GuildCache maintains linearizability, exact byte accounting and bounds under random interleavings", () => {
    const guildIds = ["20", "21", "22"] as const
    const roleIds = ["200", "201", "202", "203"] as const
    const kinds: readonly ResourceKind[] = ["guilds", "roles"]
    const maxEntries = 4
    const maxBytes = 1_200

    for (let trial = 0; trial < 15; trial++) {
        const seed = (baseSeed + 1_000 + trial * 131) >>> 0
        const rng = prng(seed)
        let now = 500
        let version = 1
        const cache = new GuildCache(
            {
                guilds: { maxEntries, maxBytes, maxAgeMs: 200 },
                roles: { maxEntries, maxBytes, maxAgeMs: 200 },
            },
            () => now,
        )

        const authoritative = new Map<string, number>()
        type OpenGuildRead = {
            readonly guard: ResourceGuard
            readonly kind: "guilds" | "roles"
            readonly guildId: string
            readonly id: string
            readonly value: Guild | GuildRole
            readonly snapshotVersion: number
        }
        const openReads: OpenGuildRead[] = []

        const assertInvariants = (step: number) => {
            const tag = `GuildCache seed=${seed} trial=${trial} step=${step}`
            for (const kind of kinds) {
                const diag = cache.diagnostics(kind)
                const retained = cache.entries(kind, maxEntries + 10)
                const exactBytes = retained.reduce((sum, item) => sum + bigIntJsonBytes(item), 0)
                expect(diag.retainedEntries, `${tag} ${kind}: count`).toBe(retained.length)
                expect(diag.retainedEntries, `${tag} ${kind}: maxEntries`).toBeLessThanOrEqual(maxEntries)
                expect(diag.accountedBytes, `${tag} ${kind}: exact bytes`).toBe(exactBytes)
                expect(diag.accountedBytes, `${tag} ${kind}: maxBytes`).toBeLessThanOrEqual(maxBytes)
            }
        }

        for (let step = 0; step < 220; step++) {
            const action = rng.below(100)
            if (action < 25) {
                const kind = rng.pick(["guilds", "roles"] as const)
                const guildId = rng.pick(guildIds)
                const id = kind === "guilds" ? guildId : rng.pick(roleIds)
                const v = ++version
                const guard = cache.begin({
                    selection: kind === "guilds" ? { kind, guildId } : { kind, guildId, id },
                })
                const value = kind === "guilds" ? makeGuild(guildId, v) : makeRole(guildId, id, v)
                openReads.push({ guard, kind, guildId, id, value, snapshotVersion: v })
            } else if (action < 50 && openReads.length > 0) {
                const index = rng.below(openReads.length)
                const [read] = openReads.splice(index, 1)
                const authKey = `${read!.kind}:${read!.guildId}:${read!.id}`
                const latestAuth = authoritative.get(authKey) ?? 0
                cache.complete(read!.guard, read!.value)
                cache.end(read!.guard, false)
                if (latestAuth > read!.snapshotVersion) {
                    const current = cache.peek(
                        read!.kind,
                        read!.guildId,
                        read!.kind === "guilds" ? undefined : read!.id,
                    )
                    expect(current?.name, `stale ${read!.kind} read overwrote newer state at step ${step}`).not.toBe(
                        read!.value.name,
                    )
                }
            } else if (action < 66) {
                // Mutation or gateway role event that bumps authoritative state
                const guildId = rng.pick(guildIds)
                const id = rng.pick(roleIds)
                const v = ++version
                authoritative.set(`roles:${guildId}:${id}`, v)
                if (rng.chance(0.5)) {
                    const guard = cache.begin({ selection: { kind: "roles", guildId, id }, mutation: true })
                    cache.complete(guard, makeRole(guildId, id, v))
                    cache.end(guard, false)
                } else {
                    cache.event("guildRoleUpdate", makeRole(guildId, id, v))
                }
            } else if (action < 78) {
                const kind = rng.pick(["guilds", "roles"] as const)
                const guildId = rng.pick(guildIds)
                const id = kind === "guilds" ? guildId : rng.pick(roleIds)
                authoritative.set(`${kind}:${guildId}:${id}`, ++version)
                cache.delete(kind, guildId, id)
            } else if (action < 86) {
                if (rng.chance(0.5)) {
                    for (const guildId of guildIds) {
                        authoritative.set(`guilds:${guildId}:${guildId}`, ++version)
                        for (const id of roleIds) authoritative.set(`roles:${guildId}:${id}`, ++version)
                    }
                    cache.gap()
                } else {
                    const targetGuild = rng.pick(guildIds)
                    authoritative.set(`guilds:${targetGuild}:${targetGuild}`, ++version)
                    for (const id of roleIds) authoritative.set(`roles:${targetGuild}:${id}`, ++version)
                    cache.gap((guildId) => guildId === targetGuild)
                }
            } else if (action < 92) {
                const kind = rng.pick(["guilds", "roles"] as const)
                for (const guildId of guildIds) {
                    if (kind === "guilds") authoritative.set(`guilds:${guildId}:${guildId}`, ++version)
                    else for (const id of roleIds) authoritative.set(`roles:${guildId}:${id}`, ++version)
                }
                cache.clearKind(kind)
            } else if (action < 96) {
                const guildId = rng.pick(guildIds)
                cache.get("guilds", guildId)
                cache.get("roles", guildId, rng.pick(roleIds))
                cache.getRoles(guildId)
            } else {
                now += rng.pick([15, 75, 220])
            }
            assertInvariants(step)
        }
        cache.close()
    }
})

test("ChannelCache maintains linearizability, exact byte accounting and bounds under random interleavings", () => {
    // Each channel ID belongs permanently to one community, as in Fluxer
    const channelPool = [
        { guildId: "20", id: "300" },
        { guildId: "20", id: "301" },
        { guildId: "20", id: "302" },
        { guildId: "21", id: "303" },
        { guildId: "21", id: "304" },
        { guildId: "21", id: "305" },
    ] as const
    const maxEntries = 4
    const maxBytes = 1_400

    for (let trial = 0; trial < 15; trial++) {
        const seed = (baseSeed + 2_000 + trial * 173) >>> 0
        const rng = prng(seed)
        let now = 200
        let version = 1
        const cache = new ChannelCache({ maxEntries, maxBytes, maxAgeMs: 180 }, () => now)

        const authoritative = new Map<string, number>()
        type OpenChannelRead = {
            readonly guard: ChannelCacheGuard
            readonly value: GuildChannel
            readonly snapshotVersion: number
        }
        const openReads: OpenChannelRead[] = []

        const assertInvariants = (step: number) => {
            const tag = `ChannelCache seed=${seed} trial=${trial} step=${step}`
            const diag = cache.diagnostics()
            const retained = cache.entries(maxEntries + 10)
            const exactBytes = retained.reduce((sum, item) => sum + bigIntJsonBytes(item), 0)
            expect(diag.retainedEntries, `${tag}: count`).toBe(retained.length)
            expect(diag.retainedEntries, `${tag}: maxEntries`).toBeLessThanOrEqual(maxEntries)
            expect(diag.accountedBytes, `${tag}: exact bytes`).toBe(exactBytes)
            expect(diag.accountedBytes, `${tag}: maxBytes`).toBeLessThanOrEqual(maxBytes)
        }

        for (let step = 0; step < 220; step++) {
            const action = rng.below(100)
            if (action < 26) {
                const target = rng.pick(channelPool)
                const v = ++version
                const guard = cache.begin({ channelId: target.id, guildId: target.guildId })
                openReads.push({ guard, value: makeChannel(target.guildId, target.id, v), snapshotVersion: v })
            } else if (action < 52 && openReads.length > 0) {
                const index = rng.below(openReads.length)
                const [read] = openReads.splice(index, 1)
                const latestAuth = authoritative.get(read!.value.id) ?? 0
                cache.complete(read!.guard, read!.value)
                cache.end(read!.guard, false)
                if (latestAuth > read!.snapshotVersion) {
                    const current = cache.peek(read!.value.id)
                    expect(current?.name, `stale channel read overwrote newer state at step ${step}`).not.toBe(
                        read!.value.name,
                    )
                }
            } else if (action < 68) {
                const target = rng.pick(channelPool)
                const v = ++version
                authoritative.set(target.id, v)
                if (rng.chance(0.5)) {
                    cache.event("guildChannelUpdate", makeChannel(target.guildId, target.id, v))
                } else {
                    const guard = cache.begin({ channelId: target.id, guildId: target.guildId, mutation: true })
                    cache.complete(guard, undefined)
                    cache.end(guard, true)
                }
            } else if (action < 78) {
                const target = rng.pick(channelPool)
                authoritative.set(target.id, ++version)
                cache.delete(target.id)
            } else if (action < 88) {
                for (const item of channelPool) authoritative.set(item.id, ++version)
                if (rng.chance(0.5)) cache.gap()
                else cache.clear()
            } else if (action < 95) {
                const target = rng.pick(channelPool)
                if (rng.chance(0.5)) cache.get(target.id)
                else cache.peek(target.id)
            } else {
                now += rng.pick([10, 60, 200])
            }
            assertInvariants(step)
        }
        cache.close()
    }
})

test("UserCache maintains linearizability, exact byte accounting and bounds under random interleavings", () => {
    const ids = ["500", "501", "502", "503", "504", "505"] as const
    const kinds = ["users", "directMessages"] as const
    const maxEntries = 4
    const maxBytes = 1_400

    for (let trial = 0; trial < 15; trial++) {
        const seed = (baseSeed + 3_000 + trial * 199) >>> 0
        const rng = prng(seed)
        let now = 300
        let version = 1
        const cache = new UserCache(
            {
                users: { maxEntries, maxBytes, maxAgeMs: 150 },
                directMessages: { maxEntries, maxBytes, maxAgeMs: 150 },
            },
            () => now,
        )

        const authoritative = new Map<string, number>()
        type OpenUserRead = {
            readonly guard: UserCacheGuard
            readonly kind: "users" | "directMessages"
            readonly id: string
            readonly value: User | DirectMessageChannel
            readonly snapshotVersion: number
        }
        const openReads: OpenUserRead[] = []

        const assertInvariants = (step: number) => {
            const tag = `UserCache seed=${seed} trial=${trial} step=${step}`
            for (const kind of kinds) {
                const diag = cache.diagnostics(kind)
                const retained = cache.entries(kind, maxEntries + 10)
                const exactBytes = retained.reduce((sum, item) => sum + jsonBytes(item), 0)
                expect(diag.retainedEntries, `${tag} ${kind}: count`).toBe(retained.length)
                expect(diag.retainedEntries, `${tag} ${kind}: maxEntries`).toBeLessThanOrEqual(maxEntries)
                expect(diag.accountedBytes, `${tag} ${kind}: exact bytes`).toBe(exactBytes)
                expect(diag.accountedBytes, `${tag} ${kind}: maxBytes`).toBeLessThanOrEqual(maxBytes)
            }
        }

        for (let step = 0; step < 220; step++) {
            const action = rng.below(100)
            if (action < 28) {
                const kind = rng.pick(kinds)
                const id = rng.pick(ids)
                const v = ++version
                const guard = cache.begin(kind, { id })
                const value = kind === "users" ? makeUser(id, v) : makeDm(id, v)
                openReads.push({ guard, kind, id, value, snapshotVersion: v })
            } else if (action < 56 && openReads.length > 0) {
                const index = rng.below(openReads.length)
                const [read] = openReads.splice(index, 1)
                const authKey = `${read!.kind}:${read!.id}`
                const latestAuth = authoritative.get(authKey) ?? 0
                cache.complete(read!.guard, [read!.value])
                if (latestAuth > read!.snapshotVersion) {
                    const current = cache.get(read!.kind, read!.id)
                    expect(current, `stale ${read!.kind} read overwrote newer state at step ${step}`).not.toEqual(
                        read!.value,
                    )
                }
            } else if (action < 72) {
                const kind = rng.pick(kinds)
                const id = rng.pick(ids)
                const v = ++version
                authoritative.set(`${kind}:${id}`, v)
                const guard = cache.begin(kind, { id, mutation: true })
                const value = kind === "users" ? makeUser(id, v) : makeDm(id, v)
                cache.complete(guard, [value])
            } else if (action < 84) {
                const kind = rng.pick(kinds)
                const id = rng.chance(0.75) ? rng.pick(ids) : undefined
                if (id === undefined) {
                    for (const each of ids) authoritative.set(`${kind}:${each}`, ++version)
                } else authoritative.set(`${kind}:${id}`, ++version)
                cache.invalidate(kind, id)
            } else if (action < 90) {
                for (const kind of kinds) {
                    for (const id of ids) authoritative.set(`${kind}:${id}`, ++version)
                }
                if (rng.chance(0.5)) cache.gap()
                else cache.clear()
            } else if (action < 96) {
                cache.get(rng.pick(kinds), rng.pick(ids))
            } else {
                now += rng.pick([10, 50, 160])
            }
            assertInvariants(step)
        }
        cache.close()
    }
})

test("ExpiryQueue stays bounded under churn and purges live entries in exact deadline order", () => {
    type Item = { readonly id: string; readonly expires: number }
    const keys = Array.from({ length: 20 }, (_, index) => `k${index}`)

    for (let trial = 0; trial < 10; trial++) {
        const seed = (baseSeed + 4_000 + trial * 211) >>> 0
        const rng = prng(seed)
        const live = new Map<string, Item>()
        const queue = new ExpiryQueue<Item>((entry) => live.get(entry.id) === entry)
        let now = 0

        for (let step = 0; step < 500; step++) {
            const action = rng.below(100)
            if (action < 55) {
                const id = rng.pick(keys)
                const item: Item = { id, expires: now + 1 + rng.below(100) }
                live.set(id, item)
                queue.push(item)
            } else if (action < 75) {
                live.delete(rng.pick(keys))
            } else {
                now += rng.pick([1, 10, 40])
                const purged: Item[] = []
                queue.purge(now, (entry) => {
                    expect(entry.expires).toBeLessThanOrEqual(now)
                    expect(live.get(entry.id)).toBe(entry)
                    live.delete(entry.id)
                    purged.push(entry)
                })
                // Purged entries must be in non-decreasing deadline order
                for (let index = 1; index < purged.length; index++) {
                    expect(purged[index]!.expires).toBeGreaterThanOrEqual(purged[index - 1]!.expires)
                }
                // No live entry may remain expired after purge
                for (const entry of live.values()) expect(entry.expires).toBeGreaterThan(now)
            }

            queue.compact(live.size)
            expect(queue.size).toBeLessThanOrEqual(live.size * 2 + 64)

            const expectedNext =
                live.size === 0 ? undefined : Math.min(...[...live.values()].map((entry) => entry.expires))
            expect(queue.next()).toBe(expectedNext)
        }
        queue.clear()
        expect(queue.size).toBe(0)
    }
})
