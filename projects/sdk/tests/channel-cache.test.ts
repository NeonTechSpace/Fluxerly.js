import { afterEach, expect, test } from "vitest"
import type { ResourceCacheSettings } from "../src/cache.js"
import type { GuildChannel } from "../src/channels.js"
import { ChannelCache, type ChannelCacheRequest } from "../src/internal/channel-cache.js"

const caches: ChannelCache[] = []

afterEach(() => {
    for (const cache of caches) cache.close()
    caches.length = 0
})

function makeCache(settings: Required<ResourceCacheSettings>, now = () => 0) {
    const cache = new ChannelCache(settings, now)
    caches.push(cache)
    return cache
}

function channel(id: string, extra: Partial<GuildChannel> = {}): GuildChannel {
    const overwrites = Object.freeze([
        Object.freeze({ id: "50", type: "role" as const, allow: 1n << 63n, deny: (1n << 64n) - 1n }),
    ])
    return Object.freeze({ id, guildId: "20", type: 0, permissionOverwrites: overwrites, ...extra })
}

function complete(
    cache: ChannelCache,
    value: GuildChannel | readonly GuildChannel[],
    request: ChannelCacheRequest = {},
) {
    const guard = cache.begin(request)
    cache.complete(guard, value)
    cache.end(guard, false)
}

test("bounds global channel retention by LRU count and BigInt-aware JSON bytes", () => {
    const first = channel("10")
    const bytes = Buffer.byteLength(
        JSON.stringify(first, (_, value) => (typeof value === "bigint" ? value.toString() : value)),
    )
    const cache = makeCache({ maxEntries: 2, maxBytes: bytes * 2, maxAgeMs: null })

    complete(cache, first, { channelId: first.id, guildId: first.guildId })
    const second = channel("11")
    complete(cache, second, { channelId: second.id, guildId: second.guildId })
    expect(cache.get(first.id)).toBe(first)

    const third = channel("12")
    complete(cache, third, { channelId: third.id, guildId: third.guildId })
    expect(cache.get(second.id)).toBeUndefined()
    expect(cache.get(first.id)).toBe(first)
    expect(cache.get(third.id)).toBe(third)

    const byteBounded = makeCache({ maxEntries: 10, maxBytes: bytes, maxAgeMs: null })
    complete(byteBounded, first, { channelId: first.id, guildId: first.guildId })
    complete(byteBounded, second, { channelId: second.id, guildId: second.guildId })
    expect(byteBounded.get(first.id)).toBeUndefined()
    expect(byteBounded.get(second.id)).toBe(second)
})

test("expires snapshots at their observation age without renewing on lookup", () => {
    let now = 100
    const cache = makeCache({ maxEntries: 2, maxBytes: 100_000, maxAgeMs: 20 }, () => now)
    const value = channel("10")
    complete(cache, value, { channelId: value.id, guildId: value.guildId })

    now = 119
    expect(cache.get(value.id)).toBe(value)
    now = 120
    expect(cache.get(value.id)).toBeUndefined()
})

test("gaps and overlapping reads cannot repopulate a newer channel observation", () => {
    const cache = makeCache({ maxEntries: 2, maxBytes: 100_000, maxAgeMs: null })
    const initial = channel("10", { name: "initial" })
    const stale = channel("10", { name: "stale" })
    const current = channel("10", { name: "current" })

    const preGap = cache.begin({ channelId: initial.id, guildId: initial.guildId })
    cache.gap()
    cache.complete(preGap, initial)
    cache.end(preGap, false)
    expect(cache.get(initial.id)).toBeUndefined()

    const olderRead = cache.begin({ channelId: stale.id, guildId: stale.guildId })
    const newerRead = cache.begin({ channelId: current.id, guildId: current.guildId })
    cache.complete(newerRead, current)
    cache.end(newerRead, false)
    cache.complete(olderRead, stale)
    cache.end(olderRead, false)
    expect(cache.get(current.id)).toBeUndefined()
})

test("clears channel snapshots after a failed dispatched mutation but not a pre-dispatch rejection", () => {
    const cache = makeCache({ maxEntries: 2, maxBytes: 100_000, maxAgeMs: null })
    const value = channel("10")
    complete(cache, value, { channelId: value.id, guildId: value.guildId })

    const rejectedBeforeDispatch = cache.begin({ channelId: value.id, mutation: true })
    cache.end(rejectedBeforeDispatch, false)
    expect(cache.get(value.id)).toBe(value)

    const rejectedAfterDispatch = cache.begin({ channelId: value.id, mutation: true })
    cache.end(rejectedAfterDispatch, true)
    expect(cache.get(value.id)).toBeUndefined()
})

test("only an uncontested authoritative guild list reconciles absent channel snapshots", () => {
    const cache = makeCache({ maxEntries: 4, maxBytes: 100_000, maxAgeMs: null })
    const old = channel("10", { name: "old" })
    const retained = channel("11")
    complete(cache, old, { channelId: old.id, guildId: old.guildId })
    complete(cache, retained, { channelId: retained.id, guildId: retained.guildId })

    const list = cache.begin({ guildId: "20", replace: true })
    const update = channel("10", { name: "updated" })
    cache.event("guildChannelUpdate", update)
    cache.complete(list, [old])
    cache.end(list, false)

    expect(cache.get(old.id)).toBeUndefined()
    expect(cache.get(retained.id)).toBe(retained)

    const authoritative = cache.begin({ guildId: "20", replace: true })
    cache.complete(authoritative, [update])
    cache.end(authoritative, false)
    expect(cache.get(retained.id)).toBeUndefined()
    expect(cache.get(update.id)).toBe(update)
})
