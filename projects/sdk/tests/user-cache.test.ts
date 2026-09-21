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

function directMessage(id: string, extra: Partial<DirectMessageChannel> = {}): DirectMessageChannel {
    return Object.freeze({
        id,
        type: "dm",
        recipients: Object.freeze([user("30")]),
        name: null,
        icon: null,
        ownerId: null,
        nicknames: Object.freeze({}),
        lastMessageId: null,
        ...extra,
    })
}

function value<K extends Kind>(kind: K, id: string): UserResources[K] {
    return (kind === "users" ? user(id) : directMessage(id)) as UserResources[K]
}

function complete<K extends Kind>(cache: UserCache, kind: K, values: readonly UserResources[K][], replace = false) {
    cache.complete(cache.begin(kind, { replace }), values)
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

test.each(["users", "directMessages"] as const)("%s unrelated reads both populate the cache", (kind) => {
    const cache = new UserCache({ [kind]: settings }, () => 0)
    const first = value(kind, "10")
    const second = value(kind, "11")
    const firstGuard = cache.begin(kind, { id: first.id })
    const secondGuard = cache.begin(kind, { id: second.id })

    cache.complete(secondGuard, [second])
    cache.complete(firstGuard, [first])
    expect(cache.get(kind, first.id)).toBe(first)
    expect(cache.get(kind, second.id)).toBe(second)
    cache.close()
})

test.each(["users", "directMessages"] as const)(
    "%s same-ID completion and invalidation cannot restore a newer snapshot",
    (kind) => {
        const cache = new UserCache({ [kind]: settings }, () => 0)
        const stale = value(kind, "10")
        const current = value(kind, "10")
        const staleGuard = cache.begin(kind, { id: stale.id })
        const currentGuard = cache.begin(kind, { id: current.id })

        cache.complete(currentGuard, [current])
        cache.complete(staleGuard, [stale])
        expect(cache.get(kind, current.id)).toBe(current)

        cache.invalidate(kind)
        cache.complete(currentGuard, [current])
        expect(cache.get(kind, current.id)).toBeUndefined()
        cache.close()
    },
)

test("direct-message mutations invalidate only overlapping reads through completion and failure", () => {
    const cache = new UserCache({ directMessages: settings }, () => 0)
    const stale = directMessage("10")
    const current = directMessage("10", { name: "current" })
    const unrelated = directMessage("11")
    const mutationGuard = cache.begin("directMessages", { id: current.id, mutation: true })
    const unrelatedGuard = cache.begin("directMessages", { id: unrelated.id })

    const readGuard = cache.begin("directMessages", { id: stale.id })
    cache.complete(readGuard, [stale])
    cache.complete(unrelatedGuard, [unrelated])
    cache.complete(mutationGuard, [current])
    expect(cache.get("directMessages", current.id)).toBeUndefined()
    expect(cache.get("directMessages", unrelated.id)).toBe(unrelated)

    complete(cache, "directMessages", [current])
    const successGuard = cache.begin("directMessages", { id: current.id, mutation: true })
    cache.complete(successGuard, [current])
    expect(cache.get("directMessages", current.id)).toBe(current)

    const failedGuard = cache.begin("directMessages", { id: current.id, mutation: true })
    cache.failed(failedGuard)
    expect(cache.get("directMessages", current.id)).toBeUndefined()

    complete(cache, "directMessages", [current])
    expect(cache.get("directMessages", current.id)).toBe(current)
    cache.close()
})

test.each(["users", "directMessages"] as const)(
    "%s collection replacement orders targeted reads and observations without merging partial lists",
    (kind) => {
        const cache = new UserCache({ [kind]: settings }, () => 0)
        const listed = value(kind, "10")
        const targeted = value(kind, "11")

        const oldList = cache.begin(kind, { replace: true })
        const targetGuard = cache.begin(kind, { id: targeted.id })
        cache.complete(targetGuard, [targeted])
        cache.complete(oldList, [listed])
        expect(cache.get(kind, listed.id)).toBeUndefined()
        expect(cache.get(kind, targeted.id)).toBe(targeted)

        const oldTarget = cache.begin(kind, { id: targeted.id })
        const currentList = cache.begin(kind, { replace: true })
        cache.complete(currentList, [listed])
        cache.complete(oldTarget, [targeted])
        expect(cache.get(kind, listed.id)).toBe(listed)
        expect(cache.get(kind, targeted.id)).toBeUndefined()
        cache.close()
    },
)

test.each(["clear", "gap", "close"] as const)("%s fences stale targeted and collection completions", (operation) => {
    const cache = new UserCache({ users: settings }, () => 0)
    const targeted = user("10")
    const listed = user("11")
    const targetGuard = cache.begin("users", { id: targeted.id })
    const listGuard = cache.begin("users", { replace: true })

    cache[operation]()
    cache.complete(targetGuard, [targeted])
    cache.complete(listGuard, [listed])
    expect(cache.diagnostics("users")).toMatchObject({ retainedEntries: 0, accountedBytes: 0 })
    cache.close()
})

test("per-ID guard tracking falls back to a conservative collection fence at its bound", () => {
    const cache = new UserCache({ users: { ...settings, maxEntries: 300 } }, () => 0)
    const guards = Array.from({ length: 256 }, (_, index) => cache.begin("users", { id: String(index) }))
    const overflow = user("overflow")
    const overflowGuard = cache.begin("users", { id: overflow.id })

    cache.complete(guards[0]!, [user("0")])
    cache.complete(overflowGuard, [overflow])
    expect(cache.get("users", "0")).toBeUndefined()
    expect(cache.get("users", overflow.id)).toBe(overflow)
    cache.close()
})

test("incremental byte accounting stays exact across replacement, eviction, expiry, clear, and close", () => {
    let now = 0
    const cache = new UserCache({ users: { maxEntries: 2, maxBytes: 100_000, maxAgeMs: 10 } }, () => now)
    const first = user("10")
    const second = user("11")
    const replacement = Object.freeze({ ...first, username: "a longer replacement" })
    const bytes = (item: User) => Buffer.byteLength(JSON.stringify(item))

    cache.complete(cache.begin("users", { id: first.id }), [first])
    cache.complete(cache.begin("users", { id: second.id }), [second])
    expect(cache.diagnostics("users").accountedBytes).toBe(bytes(first) + bytes(second))

    cache.complete(cache.begin("users", { id: replacement.id }), [replacement])
    expect(cache.diagnostics("users").accountedBytes).toBe(bytes(second) + bytes(replacement))

    const third = user("12")
    cache.complete(cache.begin("users", { id: third.id }), [third])
    expect(cache.get("users", second.id)).toBeUndefined()
    expect(cache.diagnostics("users").accountedBytes).toBe(bytes(replacement) + bytes(third))

    now = 10
    expect(cache.diagnostics("users")).toMatchObject({ retainedEntries: 0, accountedBytes: 0 })
    cache.complete(cache.begin("users", { id: first.id }), [first])
    cache.clear()
    expect(cache.diagnostics("users")).toMatchObject({ retainedEntries: 0, accountedBytes: 0 })
    cache.complete(cache.begin("users", { id: first.id }), [first])
    cache.close()
    expect(cache.diagnostics("users")).toMatchObject({ retainedEntries: 0, accountedBytes: 0 })
})

test("an over-budget replacement removes the prior value without changing accounted bytes", () => {
    const first = user("10")
    const exactBytes = Buffer.byteLength(JSON.stringify(first))
    const cache = new UserCache({ users: { maxEntries: 2, maxBytes: exactBytes, maxAgeMs: null } }, () => 0)
    cache.complete(cache.begin("users", { id: first.id }), [first])
    expect(cache.diagnostics("users").accountedBytes).toBe(exactBytes)

    const oversized = Object.freeze({ ...first, username: `${first.username}-oversized` })
    cache.complete(cache.begin("users", { id: oversized.id }), [oversized])
    expect(cache.get("users", first.id)).toBeUndefined()
    expect(cache.diagnostics("users")).toMatchObject({ retainedEntries: 0, accountedBytes: 0 })
    cache.close()
})
