import { afterEach, describe, expect, test } from "vitest"
import type { ResourceCacheSettings } from "../../../src/cache.js"
import type { GuildChannel } from "../../../src/channels.js"
import type { CacheChangeHub } from "../../../src/internal/cache-changes.js"
import { ChannelCache, type ChannelCacheRequest } from "../../../src/internal/channel-cache.js"

const caches: ChannelCache[] = []

afterEach(() => {
    for (const cache of caches) cache.close()
    caches.length = 0
})

function makeCache(settings: Required<ResourceCacheSettings>, now = () => 0, changes?: CacheChangeHub) {
    const cache = new ChannelCache(settings, now, undefined, changes)
    caches.push(cache)
    return cache
}

function channel(id: string, extra: Partial<GuildChannel> = {}): GuildChannel {
    const overwrites = Object.freeze([
        Object.freeze({ id: "50", type: "role" as const, allow: 1n << 63n, deny: (1n << 64n) - 1n }),
    ])
    // Fixtures override arbitrary fields, including type, so the merged shape is asserted rather than inferred
    return Object.freeze({ id, guildId: "20", type: 0, permissionOverwrites: overwrites, ...extra }) as GuildChannel
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

test("a mutation confined to one thread evicts only that thread", () => {
    const cache = makeCache({ maxEntries: 4, maxBytes: 100_000, maxAgeMs: null })
    const parent = channel("10")
    const thread = channel("30", { type: 11, parentId: "10" } as Partial<GuildChannel>)
    const fill = () => {
        complete(cache, parent, { channelId: parent.id, guildId: parent.guildId })
        complete(cache, thread, { channelId: thread.id, guildId: thread.guildId })
    }

    fill()
    const edit = cache.begin({ channelId: thread.id, mutation: true, thread: true })
    cache.complete(edit, undefined)
    cache.end(edit, true)
    expect(cache.get(thread.id)).toBeUndefined()
    expect(cache.get(parent.id)).toBe(parent)

    // A dispatched thread mutation that fails can still have applied, so it evicts the same single thread
    fill()
    const failed = cache.begin({ channelId: thread.id, mutation: true, thread: true })
    cache.end(failed, true)
    expect(cache.get(thread.id)).toBeUndefined()
    expect(cache.get(parent.id)).toBe(parent)
})

describe("a channel write evicts only the channels it can affect", () => {
    const text = channel("10")
    const sibling = channel("11")
    const category = channel("12", { type: 4 })
    const child = channel("13", { parentId: "12" } as Partial<GuildChannel>)
    const thread = channel("30", { type: 11, parentId: "10" } as Partial<GuildChannel>)
    const otherThread = channel("31", { type: 11, parentId: "11" } as Partial<GuildChannel>)
    const elsewhere = channel("40", { guildId: "21" })
    const all = [text, sibling, category, child, thread, otherThread, elsewhere]

    function filled() {
        const records: string[] = []
        const changes = {
            active: true,
            record: (_kind: string, op: string, key: string | null) => records.push(`${op} ${key}`),
        }
        const cache = makeCache(
            { maxEntries: 20, maxBytes: 100_000, maxAgeMs: null },
            () => 0,
            changes as unknown as CacheChangeHub,
        )
        for (const value of all) complete(cache, value, { channelId: value.id, guildId: value.guildId })
        records.length = 0
        return { cache, records }
    }
    const held = (cache: ChannelCache) => all.filter((value) => cache.holds(value.id)).map((value) => value.id)
    // Both a confirmed write and one whose outcome is unknown after dispatch affect the same channels
    const outcomes = [
        [
            "a confirmed write",
            (cache: ChannelCache, request: ChannelCacheRequest) => {
                const guard = cache.begin(request)
                cache.complete(guard, undefined)
                cache.end(guard, true)
            },
        ],
        [
            "a write with an unknown outcome",
            (cache: ChannelCache, request: ChannelCacheRequest) => {
                cache.end(cache.begin(request), true)
            },
        ],
    ] as const

    test.each(outcomes)("%s to a non-category keeps every other channel and stops a read of the target", (_, write) => {
        const { cache, records } = filled()
        const read = cache.begin({ channelId: text.id })
        const otherRead = cache.begin({ channelId: sibling.id })
        write(cache, { channelId: text.id, mutation: true })
        expect(held(cache)).toEqual(all.filter((value) => value !== text).map((value) => value.id))
        // onChange reports the one removal, never a clear
        expect(records).toEqual([`delete ${text.id}`])

        cache.complete(read, channel(text.id, { name: "before the write" }))
        cache.end(read, false)
        expect(cache.holds(text.id)).toBe(false)
        const renamed = channel(sibling.id, { name: "renamed" })
        cache.complete(otherRead, renamed)
        cache.end(otherRead, false)
        expect(cache.get(sibling.id)).toBe(renamed)
    })

    test.each(outcomes)("%s that deletes a channel also removes its threads and stops a read of one", (_, write) => {
        const { cache, records } = filled()
        const threadRead = cache.begin({ channelId: thread.id })
        write(cache, { channelId: text.id, mutation: true, changesThreads: true })
        expect(held(cache)).toEqual([sibling, category, child, otherThread, elsewhere].map((value) => value.id))
        expect(records).toEqual([`delete ${text.id}`, `delete ${thread.id}`])

        cache.complete(threadRead, thread)
        cache.end(threadRead, false)
        expect(cache.holds(thread.id)).toBe(false)
    })

    test.each(outcomes)("%s to a category removes only its community's channels", (_, write) => {
        const { cache, records } = filled()
        const otherRead = cache.begin({ channelId: elsewhere.id, guildId: elsewhere.guildId })
        write(cache, { channelId: category.id, mutation: true })
        expect(held(cache)).toEqual([elsewhere.id])
        expect(records).toEqual(all.filter((value) => value !== elsewhere).map((value) => `delete ${value.id}`))

        const renamed = channel(elsewhere.id, { guildId: "21", name: "renamed" })
        cache.complete(otherRead, renamed)
        cache.end(otherRead, false)
        expect(cache.get(elsewhere.id)).toBe(renamed)
    })

    test.each(outcomes)(
        "%s that names a community, as create and reorder do, removes only its channels",
        (_, write) => {
            const { cache } = filled()
            // An ID-only read cannot prove that it belongs to another community
            const idRead = cache.begin({ channelId: elsewhere.id })
            write(cache, { guildId: "20", mutation: true })
            expect(held(cache)).toEqual([elsewhere.id])

            // The invalidated read stores nothing, and a differing answer evicts the older observation
            cache.complete(idRead, channel(elsewhere.id, { guildId: "21", name: "renamed" }))
            cache.end(idRead, false)
            expect(cache.get(elsewhere.id)).toBeUndefined()
        },
    )

    test.each(outcomes)("%s to a channel the cache does not hold clears every channel", (_, write) => {
        const { cache, records } = filled()
        write(cache, { channelId: "99", mutation: true })
        expect(held(cache)).toEqual([])
        expect(records).toEqual(["clear null"])
    })

    test("a write keeps the target's place observed when it began, even after the entry is gone", () => {
        const { cache } = filled()
        const guard = cache.begin({ channelId: category.id, mutation: true })
        cache.delete(category.id)
        cache.complete(guard, undefined)
        cache.end(guard, true)
        expect(held(cache)).toEqual([elsewhere.id])

        // An entry observed after the write began places it as well
        const late = filled()
        const lateGuard = late.cache.begin({ channelId: "50", mutation: true })
        const added = channel("50")
        late.cache.event("guildChannelCreate", added)
        late.cache.complete(lateGuard, undefined)
        late.cache.end(lateGuard, true)
        expect(held(late.cache)).toEqual(all.map((value) => value.id))
        expect(late.cache.holds(added.id)).toBe(false)
    })

    test("an expired target still places the write without counting an expiry", () => {
        let now = 0
        const cache = makeCache({ maxEntries: 20, maxBytes: 100_000, maxAgeMs: 10 }, () => now)
        for (const value of [text, sibling, elsewhere])
            complete(cache, value, { channelId: value.id, guildId: value.guildId })
        now = 5
        complete(cache, sibling, { channelId: sibling.id, guildId: sibling.guildId })
        complete(cache, elsewhere, { channelId: elsewhere.id, guildId: elsewhere.guildId })
        now = 12
        const guard = cache.begin({ channelId: text.id, mutation: true })
        cache.complete(guard, undefined)
        cache.end(guard, true)
        expect(cache.holds(sibling.id)).toBe(true)
        expect(cache.holds(elsewhere.id)).toBe(true)
        expect(cache.diagnostics().evictions.expiry).toBe(0)
    })
})

// Fluxer removes a forum tag through a channel update alone and drops it from posts on read, and retypes a converted
// channel's threads without thread events (ThreadParentConversion)
describe("a channel update drops the cached threads it changes", () => {
    const tag = (id: string) =>
        Object.freeze({ id, name: `tag ${id}`, moderated: false, emojiId: null, emojiName: null })
    const forum = (type: number, ...tags: string[]) =>
        channel("15", { type, availableTags: Object.freeze(tags.map(tag)) } as Partial<GuildChannel>)
    const post = (id: string, ...tags: string[]) =>
        channel(id, { type: 11, parentId: "15", appliedTagIds: Object.freeze(tags) } as Partial<GuildChannel>)
    const tagged = post("30", "1")
    const kept = post("32", "2")
    const text = channel("10")
    const textThread = channel("31", { type: 11, parentId: "10" } as Partial<GuildChannel>)

    function filled(type: number, cachedForum = true) {
        const cache = makeCache({ maxEntries: 20, maxBytes: 100_000, maxAgeMs: null })
        const values = [...(cachedForum ? [forum(type, "1", "2")] : []), tagged, kept, text, textThread]
        for (const value of values) complete(cache, value, { channelId: value.id, guildId: value.guildId })
        return cache
    }

    /** Begin an ID-only read, returning a step that answers it with a changed copy and tells whether the cache kept it */
    function pending(cache: ChannelCache, value: GuildChannel) {
        const read = cache.begin({ channelId: value.id })
        return () => {
            const answer = Object.freeze({ ...value, name: "answered" }) as GuildChannel
            cache.complete(read, answer)
            cache.end(read, false)
            return cache.get(value.id) === answer
        }
    }

    test.each([
        ["forum", 15],
        ["media", 16],
    ])("a %s update drops only the posts applying a removed tag and stops reads that can store one", (_, type) => {
        const cache = filled(type)
        const reads = [tagged, kept, post("40", "1"), text].map((value) => pending(cache, value))
        cache.event("guildChannelUpdate", forum(type, "2", "3"))
        expect([tagged, kept, textThread].map((value) => cache.holds(value.id))).toEqual([false, true, true])
        expect(cache.get("15")).toMatchObject({ availableTags: [{ id: "2" }, { id: "3" }] })
        // Reads of the forum's posts and of a channel the cache does not hold can answer with the removed tag, while a
        // read of another channel of the community cannot
        expect(reads.map((finish) => finish())).toEqual([false, false, false, true])
    })

    test.each([
        ["text", channel("10", { topic: "edited" } as Partial<GuildChannel>)],
        ["forum", forum(15, "2")],
    ])("a %s update still lets pending reads store channels other than its threads", (_, update) => {
        const cache = filled(15)
        const uncached = [
            channel("99", { guildId: "21" }),
            channel("98"),
            channel("35", { type: 11, parentId: "11" } as Partial<GuildChannel>),
        ]
        // ID-only reads of channels the cache does not hold, in another community and in the updated one
        const reads = uncached.map((value) => pending(cache, value))
        const activeElsewhere = cache.begin({ guildId: "21" })
        const activeThread = channel("36", { guildId: "21", type: 11, parentId: "41" } as Partial<GuildChannel>)
        cache.event("guildChannelUpdate", update)
        // A community read finishes first, because storing a channel of its community stops it
        cache.complete(activeElsewhere, [activeThread])
        cache.end(activeElsewhere, false)
        expect(cache.get(activeThread.id)).toBe(activeThread)
        expect(reads.map((finish) => finish())).toEqual([true, true, true])
    })

    test("a write removing a tag stops pending reads of the forum's posts but not of other channels", () => {
        const cache = filled(15)
        const reads = [post("40", "1"), channel("98"), channel("99", { guildId: "21" })].map((value) =>
            pending(cache, value),
        )
        const write = cache.begin({ channelId: "15", mutation: true, removesTag: (tagId) => tagId === "1" })
        cache.complete(write, undefined)
        cache.end(write, true)
        expect([tagged, kept].map((value) => cache.holds(value.id))).toEqual([false, true])
        expect(reads.map((finish) => finish())).toEqual([false, true, true])
    })

    test("an update that keeps every tag keeps the posts but stops reads of them", () => {
        const cache = filled(15)
        const read = pending(cache, tagged)
        cache.event("guildChannelUpdate", forum(15, "1", "2", "3"))
        expect(cache.holds(tagged.id)).toBe(true)
        // A read of the forum can have stored its tags after a removal, so the update cannot show the read is current
        expect(read()).toBe(false)
    })

    test.each([
        ["cached", true],
        ["not cached", false],
    ])(
        "a forum %s and read again after a removal cannot let an earlier read of a post keep the tag",
        (_, cachedForum) => {
            const cache = filled(15, cachedForum)
            const reads = [tagged, post("40", "1")].map((value) => pending(cache, value))
            // The forum is read through the API after the removal and before its update arrives
            complete(cache, forum(15, "2"), { channelId: "15" })
            expect(cache.holds(tagged.id)).toBe(true)
            cache.event("guildChannelUpdate", forum(15, "2"))
            expect(cache.holds(tagged.id)).toBe(false)
            expect(reads.map((finish) => finish())).toEqual([false, false])
        },
    )

    test("an update of a forum the cache does not hold drops only posts applying a tag it lacks", () => {
        const cache = filled(15, false)
        const reads = [kept, text].map((value) => pending(cache, value))
        cache.event("guildChannelUpdate", forum(15, "2"))
        expect([tagged, kept, textThread].map((value) => cache.holds(value.id))).toEqual([false, true, true])
        // Without the earlier tags, a read of a post may predate a removal
        expect(reads.map((finish) => finish())).toEqual([false, true])
    })

    test("an update that changes a cached channel's type drops its threads, unlike a rename", () => {
        const cache = filled(15)
        cache.event("guildChannelUpdate", channel("10", { name: "renamed" }))
        expect(cache.holds(textThread.id)).toBe(true)
        cache.event("guildChannelUpdate", channel("10", { type: 5 } as Partial<GuildChannel>))
        expect([textThread, tagged, kept].map((value) => cache.holds(value.id))).toEqual([false, true, true])
        expect(cache.get("10")).toMatchObject({ type: 5 })
    })

    test.each([
        ["text to announcement", 0, 5, 11],
        ["announcement to text", 5, 0, 10],
    ])("a conversion from %s drops the threads its new type cannot hold", (_, from, to, threadType) => {
        const cache = makeCache({ maxEntries: 20, maxBytes: 100_000, maxAgeMs: null })
        const parent = channel("10", { type: from } as Partial<GuildChannel>)
        const thread = channel("31", { type: threadType, parentId: "10" } as Partial<GuildChannel>)
        const other = channel("33", { type: threadType, parentId: "11" } as Partial<GuildChannel>)
        for (const value of [parent, thread, other]) complete(cache, value, { channelId: value.id })
        cache.event("guildChannelUpdate", channel("10", { type: to } as Partial<GuildChannel>))
        expect([thread, other].map((value) => cache.holds(value.id))).toEqual([false, true])
    })

    test("a conversion drops the threads and stops their reads when the parent is not cached", () => {
        const cache = filled(15)
        cache.delete(text.id)
        const reads = [textThread, channel("34", { type: 11, parentId: "10" } as Partial<GuildChannel>), kept].map(
            (value) => pending(cache, value),
        )
        cache.event("guildChannelUpdate", channel("10", { type: 5 } as Partial<GuildChannel>))
        expect(cache.holds(textThread.id)).toBe(false)
        // An archived thread gets no thread update, so a read of it may still answer with the earlier type
        expect(reads.map((finish) => finish())).toEqual([false, false, true])
    })

    test("a conversion drops the threads and stops their reads after the parent was read again", () => {
        const cache = filled(15)
        const reads = [textThread, channel("34", { type: 11, parentId: "10" } as Partial<GuildChannel>)].map((value) =>
            pending(cache, value),
        )
        // The converted parent is read through the API before its update arrives
        complete(cache, channel("10", { type: 5 } as Partial<GuildChannel>), { channelId: "10" })
        cache.event("guildChannelUpdate", channel("10", { type: 5 } as Partial<GuildChannel>))
        expect(cache.holds(textThread.id)).toBe(false)
        expect(reads.map((finish) => finish())).toEqual([false, false])
    })
})
