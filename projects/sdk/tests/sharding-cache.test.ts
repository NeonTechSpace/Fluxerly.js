import { afterEach, expect, test } from "vitest"
import type { Message } from "../src/messages.js"
import { MessageCache } from "../src/internal/cache.js"
import { ChannelCache } from "../src/internal/channel-cache.js"
import { GuildCache } from "../src/internal/guild-cache.js"
import { UserCache } from "../src/internal/user-cache.js"

const closable: { close(): void }[] = []
const settings = { maxEntries: 10, maxBytes: 100_000, maxAgeMs: null } as const
const affected = (guildId: string | null | undefined) => guildId === undefined || guildId === "affected"

afterEach(() => {
    for (const cache of closable) cache.close()
    closable.length = 0
})

function guild(id: string, name: string) {
    return { id, name, features: [] }
}

function channel(id: string, guildId: string, name: string) {
    return { id, guildId, name, type: 0, permissionOverwrites: [] }
}

test("scoped guild gaps retain healthy snapshots and discard affected pre-gap reads", () => {
    const cache = new GuildCache({ guilds: settings }, () => 0)
    closable.push(cache)
    const initialAffected = guild("affected", "initial")
    const initialHealthy = guild("healthy", "initial")
    const affectedSelection = { kind: "guilds" as const, guildId: initialAffected.id }
    const healthySelection = { kind: "guilds" as const, guildId: initialHealthy.id }

    for (const [selection, value] of [
        [affectedSelection, initialAffected],
        [healthySelection, initialHealthy],
    ] as const) {
        const guard = cache.begin({ selection })
        cache.complete(guard, value)
        cache.end(guard, false)
    }
    const staleAffected = cache.begin({ selection: affectedSelection })
    const missingAffected = cache.begin({ selection: affectedSelection })
    const freshHealthy = cache.begin({ selection: healthySelection })

    cache.gap(affected)
    const recoveredAffected = guild("affected", "recovered")
    const recovered = cache.begin({ selection: affectedSelection })
    cache.complete(recovered, recoveredAffected)
    cache.end(recovered, false)
    cache.complete(staleAffected, guild("affected", "stale"))
    cache.end(staleAffected, false)
    cache.missing(missingAffected)
    cache.end(missingAffected, false)
    cache.complete(freshHealthy, guild("healthy", "fresh"))
    cache.end(freshHealthy, false)

    expect(cache.get("guilds", "affected")).toBe(recoveredAffected)
    expect(cache.get("guilds", "healthy")).toMatchObject({ name: "fresh" })
})

test("scoped channel gaps keep healthy guild entries and discard unknown pre-gap reads", () => {
    const cache = new ChannelCache(settings, () => 0)
    closable.push(cache)
    const initialAffected = channel("affected-channel", "affected", "initial")
    const initialHealthy = channel("healthy-channel", "healthy", "initial")

    for (const value of [initialAffected, initialHealthy]) {
        const guard = cache.begin({ channelId: value.id, guildId: value.guildId })
        cache.complete(guard, value)
        cache.end(guard, false)
    }
    const staleAffected = cache.begin({ channelId: initialAffected.id, guildId: initialAffected.guildId })
    const freshHealthy = cache.begin({ channelId: initialHealthy.id, guildId: initialHealthy.guildId })
    const unknown = cache.begin({ channelId: "unknown-channel" })
    const missingUnknown = cache.begin({ channelId: "missing-channel" })

    cache.gap(affected)
    const recoveredAffected = channel(initialAffected.id, "affected", "recovered")
    const recoveredUnknown = channel("unknown-channel", "affected", "recovered")
    const recoveredMissing = channel("missing-channel", "affected", "recovered")
    cache.event("guildChannelUpdate", recoveredAffected as never)
    cache.event("guildChannelUpdate", recoveredUnknown as never)
    cache.event("guildChannelUpdate", recoveredMissing as never)
    cache.complete(staleAffected, channel(initialAffected.id, "affected", "stale"))
    cache.end(staleAffected, false)
    cache.complete(freshHealthy, channel(initialHealthy.id, "healthy", "fresh"))
    cache.end(freshHealthy, false)
    cache.complete(unknown, channel("unknown-channel", "healthy", "stale"))
    cache.end(unknown, false)
    cache.missing(missingUnknown)
    cache.end(missingUnknown, false)

    expect(cache.get(initialAffected.id)).toBe(recoveredAffected)
    expect(cache.get(initialHealthy.id)).toMatchObject({ name: "fresh" })
    expect(cache.get("unknown-channel")).toBe(recoveredUnknown)
    expect(cache.get("missing-channel")).toBe(recoveredMissing)
})

test("a late affected mutation still invalidates a recovered snapshot", () => {
    const channelCache = new ChannelCache(settings, () => 0)
    const guildCache = new GuildCache({ guilds: settings }, () => 0)
    closable.push(channelCache, guildCache)

    const affectedChannel = channel("affected-channel", "affected", "recovered")
    const affectedGuild = guild("affected", "recovered")
    const channelWrite = channelCache.begin({ channelId: affectedChannel.id, guildId: "affected", mutation: true })
    const guildWrite = guildCache.begin({ selection: { kind: "guilds", guildId: "affected" }, mutation: true })

    channelCache.gap(affected)
    guildCache.gap(affected)
    channelCache.event("guildChannelUpdate", affectedChannel as never)
    const recoveredGuild = guildCache.begin({ selection: { kind: "guilds", guildId: "affected" } })
    guildCache.complete(recoveredGuild, affectedGuild)
    guildCache.end(recoveredGuild, false)
    channelCache.missing(channelWrite)
    guildCache.missing(guildWrite)
    channelCache.end(channelWrite, false)
    guildCache.end(guildWrite, false)

    expect(channelCache.get(affectedChannel.id)).toBeUndefined()
    expect(guildCache.get("guilds", "affected")).toBeUndefined()
})

function message(id: string, channelId: string, guildId?: string): Message {
    return { id, channelId, author: { id: "author" }, ...(guildId === undefined ? {} : { guildId }) } as Message
}

function completeMessage(cache: MessageCache, value: Message) {
    const guard = cache.begin(value.channelId, value.id, false, cache.generation)
    cache.complete(guard, [value])
    cache.end(guard)
}

test("scoped message gaps retain healthy guild snapshots and reject unknown pre-gap responses", () => {
    const cache = new MessageCache(
        { ...settings, onError: undefined },
        () => undefined,
        () => 0,
    )
    closable.push(cache)
    const healthy = message("healthy-message", "healthy-channel", "healthy")
    const affectedMessage = message("affected-message", "affected-channel", "affected")
    const unknown = message("unknown-message", "unknown-channel")
    completeMessage(cache, healthy)
    completeMessage(cache, affectedMessage)
    completeMessage(cache, unknown)
    const preGapHealthy = cache.begin(healthy.channelId, healthy.id, false, cache.generation)
    const preGapUnknown = cache.begin(unknown.channelId, unknown.id, false, cache.generation)

    cache.gap(affected)
    cache.complete(preGapHealthy, [message(healthy.id, healthy.channelId, "healthy")])
    cache.end(preGapHealthy)
    cache.complete(preGapUnknown, [message(unknown.id, unknown.channelId)])
    cache.end(preGapUnknown)

    expect(cache.get(healthy)).toBe(healthy)
    expect(cache.get(affectedMessage)).toBeUndefined()
    expect(cache.get(unknown)).toBeUndefined()

    const refreshedHealthy = message(healthy.id, healthy.channelId, "healthy")
    completeMessage(cache, refreshedHealthy)
    expect(cache.get(healthy)).toBe(refreshedHealthy)
})

test("unscoped message gaps retain global invalidation", () => {
    const cache = new MessageCache(
        { ...settings, onError: undefined },
        () => undefined,
        () => 0,
    )
    closable.push(cache)
    const healthy = message("healthy-message", "healthy-channel", "healthy")
    const unknown = message("unknown-message", "unknown-channel")
    completeMessage(cache, healthy)
    completeMessage(cache, unknown)

    cache.gap()

    expect(cache.get(healthy)).toBeUndefined()
    expect(cache.get(unknown)).toBeUndefined()
})

test("user snapshots are unknown while private conversations retain their null scope", () => {
    const cache = new UserCache({ users: settings, directMessages: settings }, () => 0)
    closable.push(cache)
    const userId = "user"
    const directMessageId = "direct-message"
    const user = { id: userId, username: "initial" } as never
    const directMessage = { id: directMessageId, type: "direct" } as never
    const userInitial = cache.begin("users", false)
    const directMessageInitial = cache.begin("directMessages", false)
    cache.complete("users", userInitial, [user])
    cache.complete("directMessages", directMessageInitial, [directMessage])
    const staleUser = cache.begin("users", false)
    const freshDirectMessage = cache.begin("directMessages", false)

    cache.gap(affected)
    expect(cache.get("users", userId)).toBeUndefined()
    expect(cache.get("directMessages", directMessageId)).toBe(directMessage)
    cache.complete("users", staleUser, [{ id: "user", username: "stale" } as never])
    const updatedDirectMessage = { id: directMessageId, type: "direct", name: "updated" } as never
    cache.complete("directMessages", freshDirectMessage, [updatedDirectMessage])

    expect(cache.get("users", userId)).toBeUndefined()
    expect(cache.get("directMessages", directMessageId)).toBe(updatedDirectMessage)

    const stalePrivate = cache.begin("directMessages", false)
    cache.gap((guildId) => guildId === undefined || guildId === null)
    cache.complete("directMessages", stalePrivate, [{ id: "later", type: "direct" } as never])

    expect(cache.get("directMessages", directMessageId)).toBeUndefined()
    expect(cache.get("directMessages", "later")).toBeUndefined()
})
