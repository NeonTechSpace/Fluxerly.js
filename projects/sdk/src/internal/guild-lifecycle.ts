/**
 * Guild list, leave and bulk own-message deletion requests, including the required deletion confirmation.
 * Invariant: Requests are validated locally, and list summaries keep only decoded public fields.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import type { GuildListQuery, GuildListSummary } from "#sdk/guilds"
import { decodeGuild, type GuildRequest } from "./guilds.js"
import { count, identifier, record } from "./decode/primitives.js"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"

const unsigned64 = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length <= 20 &&
    /^(0|[1-9][0-9]*)$/.test(value) &&
    BigInt(value) <= (1n << 64n) - 1n

function decodeGuildListSummary(value: unknown): GuildListSummary | undefined {
    const guild = decodeGuild(value)
    if (!guild || !record(value)) return undefined
    if (value.permissions !== undefined && !unsigned64(value.permissions)) return undefined
    if (value.approximate_member_count !== undefined && !count(value.approximate_member_count)) return undefined
    if (value.approximate_presence_count !== undefined && !count(value.approximate_presence_count)) return undefined
    // Fluxer sends threads_active only as true, on communities where the caller can use threads
    if (value.threads_active !== undefined && typeof value.threads_active !== "boolean") return undefined
    return Object.freeze({
        ...guild,
        threadsActive: value.threads_active === true,
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
    const unsupported = unsupportedKeyFailure(
        query,
        ["limit", "before", "after", "withCounts"],
        "query",
        "the guild list query",
    )
    if (unsupported) return unsupported
    if (query.before !== undefined && !identifier(query.before))
        return inputValidationFailure("query", "format", "Guild list cursor IDs must be decimal strings")
    if (query.after !== undefined && !identifier(query.after))
        return inputValidationFailure("query", "format", "Guild list cursor IDs must be decimal strings")
    if (query.before !== undefined && query.after !== undefined)
        return inputValidationFailure("query", "format", "Guild list query cannot combine before and after")
    if (query.withCounts !== undefined && typeof query.withCounts !== "boolean")
        return inputValidationFailure("query", "format", "Guild list withCounts must be a boolean")
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

/**
 * Check the required own-history deletion confirmation and return the remaining deadline and signal settings.
 * The confirm field is removed so the shared option checks accept the rest unchanged
 */
export function ownDeletionOptions<O extends object>(options: unknown): O | InputValidationFailure {
    if (!record(options) || options.confirm !== true)
        return inputValidationFailure(
            "options.confirm",
            "required",
            "Own-history deletion requires options with confirm: true",
        )
    const { confirm: _confirm, ...rest } = options
    return rest as O
}

/** Builds the authenticated member's whole-guild message deletion request without changing membership or roles */
export function guildDeleteOwnMessages(guildId: string): GuildRequest<void> | InputValidationFailure {
    if (!identifier(guildId)) return inputValidationFailure("guildId", "format", "Guild IDs must be decimal strings")
    return {
        guildId,
        bucket: "user:guilds:bulk-delete-mine",
        path: `/users/@me/guilds/${guildId}/messages/bulk-delete-mine`,
        method: "POST",
        status: 202,
        invalidateMessages: true,
        decode: () => undefined,
    }
}
