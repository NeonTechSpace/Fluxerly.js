import { expect, test } from "vitest"
import type { ResourceCacheSettings } from "../src/cache.js"
import { UserCache, type UserResources } from "../src/internal/user-cache.js"
import type { DirectMessageChannel, User } from "../src/users.js"

type Kind = keyof UserResources

const settings: Required<ResourceCacheSettings> = { maxEntries: 2, maxBytes: 100_000, maxAgeMs: null }

function user(id: string): User {
    return Object.freeze({
        id,
        username: `user-${id}`,
        discriminator: "0001",
        displayName: null,
        avatar: null,
        avatarColor: null,
        isBot: false,
        isSystem: false,
        flags: 0,
    })
}

function directMessage(id: string): DirectMessageChannel {
    return Object.freeze({
        id,
        type: "dm",
        recipients: Object.freeze([user("30")]),
        name: null,
        icon: null,
        ownerId: null,
        nicknames: Object.freeze({}),
        lastMessageId: null,
    })
}

function value<K extends Kind>(kind: K, id: string): UserResources[K] {
    return (kind === "users" ? user(id) : directMessage(id)) as UserResources[K]
}

function complete<K extends Kind>(cache: UserCache, kind: K, values: readonly UserResources[K][], replace = false) {
    cache.complete(kind, cache.begin(kind, false), values, replace)
}

test.each(["users", "directMessages"] as const)(
    "%s lookup promotes LRU recency without changing count or byte bounds",
    (kind) => {
        const cache = new UserCache({ [kind]: settings }, () => 0)
        const first = value(kind, "10")
        const second = value(kind, "11")
        const third = value(kind, "12")

        complete(cache, kind, [first, second])
        const before = cache.diagnostics(kind)
        expect(cache.get(kind, first.id)).toBe(first)
        complete(cache, kind, [third])

        expect(cache.get(kind, second.id)).toBeUndefined()
        expect(cache.get(kind, first.id)).toBe(first)
        expect(cache.get(kind, third.id)).toBe(third)
        expect(cache.diagnostics(kind)).toMatchObject({
            retainedEntries: 2,
            accountedBytes: before.accountedBytes,
            maxEntries: 2,
            maxBytes: 100_000,
        })
        cache.close()
    },
)

test.each(["users", "directMessages"] as const)(
    "%s enumeration and diagnostics leave LRU recency and observation age unchanged",
    (kind) => {
        let now = 100
        const cache = new UserCache({ [kind]: { ...settings, maxAgeMs: 10 } }, () => now)
        const first = value(kind, "10")
        const second = value(kind, "11")
        const third = value(kind, "12")

        complete(cache, kind, [first, second])
        expect(cache.entries(kind, 2)).toEqual([first, second])
        expect(cache.diagnostics(kind).retainedEntries).toBe(2)
        complete(cache, kind, [third])
        expect(cache.get(kind, first.id)).toBeUndefined()
        expect(cache.get(kind, second.id)).toBe(second)

        now = 109
        expect(cache.get(kind, third.id)).toBe(third)
        now = 110
        expect(cache.get(kind, third.id)).toBeUndefined()
        cache.close()
    },
)

test.each(["users", "directMessages"] as const)(
    "%s stale completion and invalidation cannot restore a newer snapshot",
    (kind) => {
        const cache = new UserCache({ [kind]: settings }, () => 0)
        const stale = value(kind, "10")
        const current = value(kind, "11")
        const staleGeneration = cache.begin(kind, false)
        const currentGeneration = cache.begin(kind, false)

        cache.complete(kind, currentGeneration, [current])
        cache.complete(kind, staleGeneration, [stale])
        expect(cache.get(kind, current.id)).toBe(current)
        expect(cache.get(kind, stale.id)).toBeUndefined()

        cache.invalidate(kind)
        cache.complete(kind, currentGeneration, [current])
        expect(cache.get(kind, current.id)).toBeUndefined()
        cache.close()
    },
)
