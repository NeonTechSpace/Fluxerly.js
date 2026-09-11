import type {
    DiscoveryApplication,
    DiscoveryApplicationInput,
    DiscoveryApplicationEdit,
    DiscoveryCategory,
    DiscoveryStatus,
    DiscoveryCategoryCount,
    DiscoveryGuild,
    DiscoverySearchPage,
    DiscoverySearchQuery,
} from "#sdk/discovery"
import type { GuildRequest } from "./guilds.js"
import { identifier, record } from "./message.js"

const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max
const text = (value: unknown, min: number, max: number): value is string =>
    typeof value === "string" && value.length >= min && value.length <= max
const nullableText = (value: unknown): value is string | null => value === null || typeof value === "string"
const timestamp = (value: unknown): value is string =>
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
const nullableTime = (value: unknown): value is string | null => value === null || timestamp(value)

function application(value: unknown, guildId: string): DiscoveryApplication | undefined {
    if (
        !record(value) ||
        value.guild_id !== guildId ||
        !text(value.status, 1, 100) ||
        typeof value.description !== "string" ||
        !integer(value.category_type) ||
        !nullableText(value.primary_language) ||
        !Array.isArray(value.custom_tags) ||
        !Array.from(value.custom_tags).every((tag) => typeof tag === "string") ||
        !timestamp(value.applied_at) ||
        !nullableTime(value.reviewed_at) ||
        !nullableTime(value.removed_at) ||
        !nullableText(value.review_reason) ||
        !nullableText(value.removal_reason) ||
        (value.guild_nsfw_level !== undefined && value.guild_nsfw_level !== null && !integer(value.guild_nsfw_level, 3))
    )
        return undefined
    return Object.freeze({
        guildId,
        status: value.status,
        description: value.description,
        categoryId: value.category_type,
        primaryLanguage: value.primary_language,
        tags: Object.freeze([...value.custom_tags] as string[]),
        appliedAt: value.applied_at,
        reviewedAt: value.reviewed_at,
        reviewReason: value.review_reason,
        removedAt: value.removed_at,
        removalReason: value.removal_reason,
        ...(value.guild_nsfw_level === undefined ? {} : { guildNsfwLevel: value.guild_nsfw_level as number | null }),
    })
}

export function discoveryStatus(guildId: string): GuildRequest<DiscoveryStatus> | undefined {
    if (!identifier(guildId)) return undefined
    return {
        guildId,
        bucket: "guild:discovery:status",
        path: `/guilds/${guildId}/discovery`,
        method: "GET",
        status: 200,
        decode: (value) => {
            if (!record(value) || typeof value.eligible !== "boolean" || !integer(value.min_member_count))
                return undefined
            const item = value.application === null ? null : application(value.application, guildId)
            return item === undefined
                ? undefined
                : Object.freeze({ application: item, eligible: value.eligible, minMemberCount: value.min_member_count })
        },
    }
}

export function discoveryCategories(): GuildRequest<readonly DiscoveryCategory[]> {
    return {
        guildId: "discovery",
        bucket: "discovery:categories",
        path: "/discovery/categories",
        method: "GET",
        status: 200,
        decode: (value) => {
            if (!Array.isArray(value)) return undefined
            const ids = new Set<number>(),
                result: DiscoveryCategory[] = []
            for (const entry of value) {
                if (!record(entry) || !integer(entry.id) || !text(entry.name, 1, 200) || ids.has(entry.id))
                    return undefined
                ids.add(entry.id)
                result.push(Object.freeze({ id: entry.id, name: entry.name }))
            }
            return Object.freeze(result)
        },
    }
}

function discoveryGuild(value: unknown): DiscoveryGuild | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        typeof value.name !== "string" ||
        (value.icon !== undefined && !nullableText(value.icon)) ||
        (value.banner !== undefined && !nullableText(value.banner)) ||
        (value.description !== undefined && !nullableText(value.description)) ||
        !integer(value.category_type, 8) ||
        (value.primary_language !== undefined && !nullableText(value.primary_language)) ||
        !Array.isArray(value.custom_tags) ||
        !value.custom_tags.every((tag) => typeof tag === "string") ||
        !integer(value.member_count) ||
        !integer(value.online_count) ||
        !Array.isArray(value.features) ||
        !value.features.every((feature) => typeof feature === "string") ||
        !integer(value.verification_level)
    )
        return undefined
    return Object.freeze({
        id: value.id,
        name: value.name,
        icon: value.icon ?? null,
        banner: value.banner ?? null,
        description: value.description ?? null,
        categoryId: value.category_type,
        primaryLanguage: value.primary_language ?? null,
        tags: Object.freeze([...value.custom_tags] as string[]),
        memberCount: value.member_count,
        onlineCount: value.online_count,
        features: Object.freeze([...value.features] as string[]),
        verificationLevel: value.verification_level,
    })
}

/** Build one volatile directory search page. Offset pagination has no snapshot or traversal guarantee */
export function discoverySearch(query?: DiscoverySearchQuery): GuildRequest<DiscoverySearchPage> | undefined {
    if (query !== undefined && !record(query)) return undefined
    const input = query as DiscoverySearchQuery | undefined
    if (
        input !== undefined &&
        (Object.keys(input).some(
            (key) => !["query", "categoryId", "primaryLanguage", "tag", "sortBy", "limit", "offset"].includes(key),
        ) ||
            (input.query !== undefined && !text(input.query, 0, 100)) ||
            (input.categoryId !== undefined && !integer(input.categoryId, 8)) ||
            (input.primaryLanguage !== undefined &&
                (!text(input.primaryLanguage, 2, 35) ||
                    !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(input.primaryLanguage))) ||
            (input.tag !== undefined && !text(input.tag, 0, 30)) ||
            (input.sortBy !== undefined && !["memberCount", "onlineCount", "relevance"].includes(input.sortBy)) ||
            (input.limit !== undefined && (!integer(input.limit, 48) || input.limit === 0)) ||
            (input.offset !== undefined && !integer(input.offset)))
    )
        return undefined
    const limit = input?.limit ?? 24
    const offset = input?.offset ?? 0
    const parameters = new URLSearchParams({ limit: String(limit), offset: String(offset) })
    if (input?.query !== undefined) parameters.set("query", input.query)
    if (input?.categoryId !== undefined) parameters.set("category", String(input.categoryId))
    if (input?.primaryLanguage !== undefined) parameters.set("language", input.primaryLanguage)
    if (input?.tag !== undefined) parameters.set("tag", input.tag)
    if (input?.sortBy !== undefined)
        parameters.set(
            "sort_by",
            { memberCount: "member_count", onlineCount: "online_count", relevance: "relevance" }[input.sortBy],
        )
    return {
        guildId: "discovery",
        bucket: "discovery:search",
        path: `/discovery/guilds?${parameters}`,
        method: "GET",
        status: 200,
        decode: (value) => {
            if (
                !record(value) ||
                !Array.isArray(value.guilds) ||
                !integer(value.total) ||
                !Array.isArray(value.category_counts)
            )
                return undefined
            const guilds = value.guilds.map(discoveryGuild)
            if (guilds.length > limit || guilds.some((guild) => guild === undefined)) return undefined
            const guildIds = new Set<string>()
            if (guilds.some((guild) => !guild || guildIds.has(guild.id) || (guildIds.add(guild.id), false)))
                return undefined
            const categoryIds = new Set<number>()
            const categoryCounts: DiscoveryCategoryCount[] = []
            for (const item of value.category_counts) {
                if (
                    !record(item) ||
                    !integer(item.category_type, 8) ||
                    !integer(item.count) ||
                    categoryIds.has(item.category_type)
                )
                    return undefined
                categoryIds.add(item.category_type)
                categoryCounts.push(Object.freeze({ categoryId: item.category_type, count: item.count }))
            }
            return Object.freeze({
                guilds: Object.freeze(guilds as DiscoveryGuild[]),
                total: value.total,
                categoryCounts: Object.freeze(categoryCounts),
                offset,
                limit,
            })
        },
    }
}

function body(input: DiscoveryApplicationInput | DiscoveryApplicationEdit, patch: boolean): string | undefined {
    if (
        !record(input) ||
        Object.keys(input).some((key) => !["description", "categoryId", "primaryLanguage", "tags"].includes(key))
    )
        return undefined
    if ((!patch || input.description !== undefined) && !text(input.description, 10, 300)) return undefined
    if ((!patch || input.categoryId !== undefined) && !integer(input.categoryId, 8)) return undefined
    if (
        input.primaryLanguage !== undefined &&
        (!text(input.primaryLanguage, 2, 35) || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(input.primaryLanguage))
    )
        return undefined
    let tags: string[] | undefined
    if (input.tags !== undefined) {
        if (!Array.isArray(input.tags) || input.tags.length > 10) return undefined
        tags = []
        for (const tag of input.tags) {
            if (!text(tag, 2, 30)) return undefined
            const normalized = tag.trim().toLowerCase().replace(/\s+/g, " ")
            if (!text(normalized, 2, 30) || !/^[\p{L}\p{N}][\p{L}\p{N} \-_+&]*$/u.test(normalized)) return undefined
            if (!tags.includes(normalized)) tags.push(normalized)
        }
    }
    const json = JSON.stringify({
        description: input.description,
        category_type: input.categoryId,
        primary_language: input.primaryLanguage,
        custom_tags: tags,
    })
    return json === "{}" ? undefined : json
}

export function discoveryWrite(
    guildId: string,
    input: DiscoveryApplicationInput | DiscoveryApplicationEdit,
    patch = false,
): GuildRequest<DiscoveryApplication> | undefined {
    const base = discoveryStatus(guildId),
        json = body(input, patch)
    if (!base || json === undefined) return undefined
    return {
        ...base,
        bucket: "guild:discovery:update",
        method: patch ? "PATCH" : "POST",
        json,
        cache: { selection: { kind: "guilds", guildId }, mutation: true },
        decode: (value) => application(value, guildId),
    }
}

export function discoveryWithdraw(guildId: string): GuildRequest<void> | undefined {
    const base = discoveryStatus(guildId)
    if (!base) return undefined
    return {
        ...base,
        bucket: "guild:discovery:update",
        method: "DELETE",
        status: 204,
        cache: { selection: { kind: "guilds", guildId }, mutation: true },
        decode: () => undefined,
    }
}
