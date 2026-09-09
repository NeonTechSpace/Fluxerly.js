import type { Guild, GuildListQuery } from "#sdk/guilds"
import { decodeGuild, type GuildRequest } from "./guilds.js"
import { identifier, record } from "./message.js"

export function guildList(query: GuildListQuery = {}): GuildRequest<readonly Guild[]> | undefined {
    if (
        !record(query) ||
        Object.keys(query).some((key) => !["limit", "before", "after"].includes(key)) ||
        (query.before !== undefined && !identifier(query.before)) ||
        (query.after !== undefined && !identifier(query.after)) ||
        (query.before !== undefined && query.after !== undefined)
    )
        return undefined
    const limit = query.limit === undefined ? 200 : query.limit
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200) return undefined
    const params = new URLSearchParams({ limit: String(limit), with_counts: "false" })
    if (query.before !== undefined) params.set("before", query.before)
    if (query.after !== undefined) params.set("after", query.after)
    return {
        guildId: "@me",
        bucket: "user:guilds:list",
        path: `/users/@me/guilds?${params}`,
        method: "GET",
        status: 200,
        decode: (value) => {
            if (!Array.isArray(value) || value.length > limit) return undefined
            const guilds: Guild[] = []
            let previous: bigint | undefined
            for (const item of value) {
                const guild = decodeGuild(item)
                if (!guild || (previous !== undefined && BigInt(guild.id) <= previous)) return undefined
                previous = BigInt(guild.id)
                guilds.push(guild)
            }
            return Object.freeze(guilds)
        },
    }
}

export function guildLeave(guildId: string): GuildRequest<void> | undefined {
    if (!identifier(guildId)) return undefined
    return {
        guildId,
        bucket: "user:guilds:leave",
        path: `/users/@me/guilds/${guildId}?delete_messages=false`,
        method: "DELETE",
        status: 204,
        cache: { selection: { kind: "guilds", guildId }, mutation: true, wholeGuild: true },
        channelCache: { guildId, mutation: true },
        invalidateMessages: true,
        decode: () => undefined,
    }
}
