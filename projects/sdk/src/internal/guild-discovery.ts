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
import { InputValidationFailure, inputValidationFailure } from "#sdk/input-validation"
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

export function discoveryStatus(guildId: string): GuildRequest<DiscoveryStatus> | InputValidationFailure {
    if (!identifier(guildId)) return inputValidationFailure("guildId", "format", "Guild IDs must be decimal strings")
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
export function discoverySearch(
    query?: DiscoverySearchQuery,
): GuildRequest<DiscoverySearchPage> | InputValidationFailure {
    if (query !== undefined && !record(query))
        return inputValidationFailure("query", "type", "Discovery search query must be an object")
    const input = query as DiscoverySearchQuery | undefined
    if (
        input !== undefined &&
        Object.keys(input).some(
            (key) => !["query", "categoryId", "primaryLanguage", "tag", "sortBy", "limit", "offset"].includes(key),
        )
    )
        return inputValidationFailure(
            "query",
            "allowedFields",
            "Discovery search query may contain only documented search fields",
        )
    if (input?.query !== undefined && !text(input.query, 0, 100))
        return inputValidationFailure(
            "query.query",
            "length",
            "Discovery query must contain at most 100 UTF-16 code units",
        )
    if (input?.categoryId !== undefined && !integer(input.categoryId, 8))
        return inputValidationFailure(
            "query.categoryId",
            "range",
            "Discovery category ID must be an integer from 0 through 8",
        )
    if (
        input?.primaryLanguage !== undefined &&
        (!text(input.primaryLanguage, 2, 35) || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(input.primaryLanguage))
    )
        return inputValidationFailure(
            "query.primaryLanguage",
            "format",
            "Discovery primary language must be a 2 through 35 UTF-16 code unit language tag",
        )
    if (input?.tag !== undefined && !text(input.tag, 0, 30))
        return inputValidationFailure("query.tag", "length", "Discovery tag must contain at most 30 UTF-16 code units")
    if (input?.sortBy !== undefined && !["memberCount", "onlineCount", "relevance"].includes(input.sortBy))
        return inputValidationFailure(
            "query.sortBy",
            "allowedValue",
            "Discovery sortBy must be memberCount, onlineCount, or relevance",
        )
    if (input?.limit !== undefined && (!integer(input.limit, 48) || input.limit === 0))
        return inputValidationFailure("query.limit", "range", "Discovery limit must be an integer from 1 through 48")
    if (input?.offset !== undefined && !integer(input.offset))
        return inputValidationFailure("query.offset", "range", "Discovery offset must be a nonnegative safe integer")
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

function body(input: DiscoveryApplicationInput | DiscoveryApplicationEdit, patch: boolean) {
    if (!record(input)) return inputValidationFailure("input", "type", "Discovery application input must be an object")
    if (Object.keys(input).some((key) => !["description", "categoryId", "primaryLanguage", "tags"].includes(key)))
        return inputValidationFailure(
            "input",
            "allowedFields",
            "Discovery application input may contain only description, categoryId, primaryLanguage, and tags",
        )
    if ((!patch || input.description !== undefined) && !text(input.description, 10, 300))
        return inputValidationFailure(
            "description",
            "length",
            "Discovery description must contain 10 through 300 characters",
        )
    if ((!patch || input.categoryId !== undefined) && !integer(input.categoryId, 8))
        return inputValidationFailure("categoryId", "range", "Discovery categoryId must be an integer from 0 through 8")
    if (
        input.primaryLanguage !== undefined &&
        (!text(input.primaryLanguage, 2, 35) || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(input.primaryLanguage))
    )
        return inputValidationFailure("primaryLanguage", "format", "Primary language must be a valid language tag")
    let tags: string[] | undefined
    if (input.tags !== undefined) {
        if (!Array.isArray(input.tags) || input.tags.length > 10)
            return inputValidationFailure("tags", "length", "Discovery tags must be an array with at most ten entries")
        tags = []
        for (const tag of input.tags) {
            if (!text(tag, 2, 30))
                return inputValidationFailure("tags[]", "length", "Discovery tags must contain 2 through 30 characters")
            const normalized = tag.trim().toLowerCase().replace(/\s+/g, " ")
            if (!text(normalized, 2, 30) || !/^[\p{L}\p{N}][\p{L}\p{N} \-_+&]*$/u.test(normalized))
                return inputValidationFailure(
                    "tags[]",
                    "format",
                    "Discovery tags must use supported letters, numbers, and separators",
                )
            if (!tags.includes(normalized)) tags.push(normalized)
        }
    }
    const json = JSON.stringify({
        description: input.description,
        category_type: input.categoryId,
        primary_language: input.primaryLanguage,
        custom_tags: tags,
    })
    return json === "{}"
        ? inputValidationFailure("input", "required", "Discovery application edit must contain a change")
        : json
}

export function discoveryWrite(
    guildId: string,
    input: DiscoveryApplicationInput | DiscoveryApplicationEdit,
    patch = false,
): GuildRequest<DiscoveryApplication> | InputValidationFailure {
    const base = discoveryStatus(guildId),
        json = body(input, patch)
    if (base instanceof InputValidationFailure) return base
    if (json instanceof InputValidationFailure) return json
    return {
        ...base,
        bucket: "guild:discovery:update",
        method: patch ? "PATCH" : "POST",
        json,
        cache: { selection: { kind: "guilds", guildId }, mutation: true },
        decode: (value) => application(value, guildId),
    }
}

export function discoveryWithdraw(guildId: string): GuildRequest<void> | InputValidationFailure {
    const base = discoveryStatus(guildId)
    if (base instanceof InputValidationFailure) return base
    return {
        ...base,
        bucket: "guild:discovery:update",
        method: "DELETE",
        status: 204,
        cache: { selection: { kind: "guilds", guildId }, mutation: true },
        decode: () => undefined,
    }
}
