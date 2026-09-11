import type { GuildListQuery, GuildListSummary } from "#sdk/guilds"
import { decodeGuild, type GuildRequest } from "./guilds.js"
import { identifier, record } from "./message.js"
import { InputValidationFailure, inputValidationFailure } from "#sdk/input-validation"

const unsigned64 = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length <= 20 &&
    /^(0|[1-9][0-9]*)$/.test(value) &&
    BigInt(value) <= (1n << 64n) - 1n

const count = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647

function decodeGuildListSummary(value: unknown): GuildListSummary | undefined {
    const guild = decodeGuild(value)
    if (!guild || !record(value)) return undefined
    if (value.permissions !== undefined && !unsigned64(value.permissions)) return undefined
    if (value.approximate_member_count !== undefined && !count(value.approximate_member_count)) return undefined
    if (value.approximate_presence_count !== undefined && !count(value.approximate_presence_count)) return undefined
    return Object.freeze({
        ...guild,
        ...(value.permissions === undefined ? {} : { permissions: BigInt(value.permissions) }),
        ...(value.approximate_member_count === undefined
            ? {}
            : { approximateMemberCount: value.approximate_member_count }),
        ...(value.approximate_presence_count === undefined
            ? {}
            : { approximatePresenceCount: value.approximate_presence_count }),
    })
}

export function guildList(
    query: GuildListQuery = {},
): GuildRequest<readonly GuildListSummary[]> | InputValidationFailure {
    if (!record(query)) return inputValidationFailure("query", "type", "Guild list query must be an object")
    if (Object.keys(query).some((key) => !["limit", "before", "after", "withCounts"].includes(key)))
        return inputValidationFailure(
            "query",
            "allowedFields",
            "Guild list query may contain only limit, before, after, and withCounts",
        )
    if (
        (query.before !== undefined && !identifier(query.before)) ||
        (query.after !== undefined && !identifier(query.after)) ||
        (query.before !== undefined && query.after !== undefined) ||
        (query.withCounts !== undefined && typeof query.withCounts !== "boolean")
    )
        return inputValidationFailure(
            "query",
            "format",
            "Guild list cursors must be decimal IDs, only one cursor may be set, and withCounts must be boolean",
        )
    const limit = query.limit === undefined ? 200 : query.limit
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200)
        return inputValidationFailure("query.limit", "range", "Guild list limit must be an integer from 1 through 200")
    const params = new URLSearchParams({ limit: String(limit), with_counts: String(query.withCounts === true) })
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
            const guilds: GuildListSummary[] = []
            let previous: bigint | undefined
            for (const item of value) {
                const guild = decodeGuildListSummary(item)
                if (!guild || (previous !== undefined && BigInt(guild.id) <= previous)) return undefined
                previous = BigInt(guild.id)
                guilds.push(guild)
            }
            return Object.freeze(guilds)
        },
    }
}

export function guildLeave(guildId: string): GuildRequest<void> | InputValidationFailure {
    if (!identifier(guildId)) return inputValidationFailure("guildId", "format", "Guild IDs must be decimal strings")
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
