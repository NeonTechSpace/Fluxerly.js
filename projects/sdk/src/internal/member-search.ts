import {
    GuildMemberJoinSourceTypes,
    type GuildMemberJoinSourceType,
    type MemberSearchHit,
    type MemberSearchPage,
    type MemberSearchQuery,
} from "#sdk/member-search"
import type { GuildRequest } from "./guilds.js"
import { identifier, record } from "./message.js"
import { InputValidationFailure, inputValidationFailure } from "#sdk/input-validation"

const joinSourceTypeValues = new Set<number>(Object.values(GuildMemberJoinSourceTypes))
const queryKeys = new Set([
    "query",
    "limit",
    "offset",
    "roleIds",
    "joinedAtAfterSeconds",
    "joinedAtBeforeSeconds",
    "userCreatedAtAfterSeconds",
    "userCreatedAtBeforeSeconds",
    "joinSourceTypes",
    "sourceInviteCodes",
    "isBot",
    "sortBy",
    "sortOrder",
])

interface EncodedMemberSearchQuery {
    readonly limit: number
    readonly offset: number
    readonly json: string
    readonly query: MemberSearchQuery
}

const nonNegativeInteger = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0

const joinSourceType = (value: unknown): value is GuildMemberJoinSourceType =>
    typeof value === "number" && joinSourceTypeValues.has(value)

const nullableText = (value: unknown): value is string | null => value === null || typeof value === "string"
const nullableIdentifier = (value: unknown): value is string | null => value === null || identifier(value)

function identifiers(value: unknown, maximum: number): readonly string[] | undefined {
    if (!Array.isArray(value) || value.length > maximum) return undefined
    const items = Array.from(value)
    return items.every(identifier) && new Set(items).size === items.length ? Object.freeze(items) : undefined
}

function texts(value: unknown, maximum: number): readonly string[] | undefined {
    if (!Array.isArray(value) || value.length > maximum) return undefined
    const items = Array.from(value)
    return items.every((item) => typeof item === "string") && new Set(items).size === items.length
        ? Object.freeze(items)
        : undefined
}

function joinSourceTypes(value: unknown): readonly GuildMemberJoinSourceType[] | undefined {
    if (!Array.isArray(value) || value.length > 10) return undefined
    const items = Array.from(value)
    return items.every(joinSourceType) && new Set(items).size === items.length ? Object.freeze(items) : undefined
}

/** Validates and encodes one provider page request, preserving provider defaults without retaining caller input */
export function encodeMemberSearchQuery(query?: unknown): EncodedMemberSearchQuery | InputValidationFailure {
    const supplied = query === undefined ? {} : query
    if (!record(supplied)) return inputValidationFailure("query", "type", "Member search query must be an object")
    if (Object.keys(supplied).some((key) => !queryKeys.has(key)))
        return inputValidationFailure("query", "allowedFields", "Member search query contains an unsupported field")
    // Read recognized properties once, regardless of ownership or enumerability
    const input = Object.fromEntries(Array.from(queryKeys, (key) => [key, supplied[key]]))
    const limit = input.limit === undefined ? 25 : input.limit
    const offset = input.offset === undefined ? 0 : input.offset
    if (input.query !== undefined && (typeof input.query !== "string" || input.query.length > 100))
        return inputValidationFailure(
            "query.query",
            "length",
            "Member search text must contain at most 100 UTF-16 code units",
        )
    if (!nonNegativeInteger(offset))
        return inputValidationFailure(
            "query.offset",
            "range",
            "Member search offset must be a nonnegative safe integer",
        )
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        return inputValidationFailure(
            "query.limit",
            "range",
            "Member search limit must be an integer from 1 through 100",
        )
    const roleIds = input.roleIds === undefined ? undefined : identifiers(input.roleIds, 10)
    if (input.roleIds !== undefined && !roleIds)
        return inputValidationFailure(
            "query.roleIds[]",
            "format",
            "Member search role IDs must be an array of at most 10 unique decimal strings",
        )
    input.roleIds = roleIds
    if (input.joinedAtAfterSeconds !== undefined && !nonNegativeInteger(input.joinedAtAfterSeconds))
        return inputValidationFailure(
            "query.joinedAtAfterSeconds",
            "range",
            "Joined-after time must be a nonnegative safe integer",
        )
    if (input.joinedAtBeforeSeconds !== undefined && !nonNegativeInteger(input.joinedAtBeforeSeconds))
        return inputValidationFailure(
            "query.joinedAtBeforeSeconds",
            "range",
            "Joined-before time must be a nonnegative safe integer",
        )
    if (input.userCreatedAtAfterSeconds !== undefined && !nonNegativeInteger(input.userCreatedAtAfterSeconds))
        return inputValidationFailure(
            "query.userCreatedAtAfterSeconds",
            "range",
            "User-created-after time must be a nonnegative safe integer",
        )
    if (input.userCreatedAtBeforeSeconds !== undefined && !nonNegativeInteger(input.userCreatedAtBeforeSeconds))
        return inputValidationFailure(
            "query.userCreatedAtBeforeSeconds",
            "range",
            "User-created-before time must be a nonnegative safe integer",
        )
    const sourceTypes = input.joinSourceTypes === undefined ? undefined : joinSourceTypes(input.joinSourceTypes)
    if (input.joinSourceTypes !== undefined && !sourceTypes)
        return inputValidationFailure(
            "query.joinSourceTypes[]",
            "allowedValue",
            "Join source types must be an array of at most 10 unique supported values",
        )
    input.joinSourceTypes = sourceTypes
    const inviteCodes = input.sourceInviteCodes === undefined ? undefined : texts(input.sourceInviteCodes, 10)
    if (input.sourceInviteCodes !== undefined && !inviteCodes)
        return inputValidationFailure(
            "query.sourceInviteCodes[]",
            "unique",
            "Source invite codes must be an array of at most 10 unique strings",
        )
    input.sourceInviteCodes = inviteCodes
    if (input.isBot !== undefined && typeof input.isBot !== "boolean")
        return inputValidationFailure("query.isBot", "type", "isBot must be a boolean")
    if (input.sortBy !== undefined && input.sortBy !== "joinedAt" && input.sortBy !== "relevance")
        return inputValidationFailure("query.sortBy", "allowedValue", "sortBy must be joinedAt or relevance")
    if (input.sortOrder !== undefined && input.sortOrder !== "asc" && input.sortOrder !== "desc")
        return inputValidationFailure("query.sortOrder", "allowedValue", "sortOrder must be asc or desc")
    const body = {
        ...(input.query === undefined ? {} : { query: input.query }),
        limit,
        offset,
        ...(roleIds === undefined ? {} : { role_ids: roleIds }),
        ...(input.joinedAtAfterSeconds === undefined ? {} : { joined_at_gte: input.joinedAtAfterSeconds }),
        ...(input.joinedAtBeforeSeconds === undefined ? {} : { joined_at_lte: input.joinedAtBeforeSeconds }),
        ...(sourceTypes === undefined ? {} : { join_source_type: sourceTypes }),
        ...(inviteCodes === undefined ? {} : { source_invite_code: inviteCodes }),
        ...(input.isBot === undefined ? {} : { is_bot: input.isBot }),
        ...(input.userCreatedAtAfterSeconds === undefined
            ? {}
            : { user_created_at_gte: input.userCreatedAtAfterSeconds }),
        ...(input.userCreatedAtBeforeSeconds === undefined
            ? {}
            : { user_created_at_lte: input.userCreatedAtBeforeSeconds }),
        ...(input.sortBy === undefined ? {} : { sort_by: input.sortBy }),
        ...(input.sortOrder === undefined ? {} : { sort_order: input.sortOrder }),
    }
    return Object.freeze({
        limit,
        offset,
        json: JSON.stringify(body),
        query: Object.freeze(input) as MemberSearchQuery,
    })
}

function hit(value: unknown, guildId: string): MemberSearchHit | undefined {
    const roleIds = record(value) ? identifiers(value.role_ids, Number.MAX_SAFE_INTEGER) : undefined
    if (
        !record(value) ||
        !identifier(value.guild_id) ||
        value.guild_id !== guildId ||
        !identifier(value.user_id) ||
        typeof value.username !== "string" ||
        typeof value.discriminator !== "string" ||
        !/^\d{4}$/.test(value.discriminator) ||
        !nullableText(value.global_name) ||
        !nullableText(value.nickname) ||
        !roleIds ||
        !nonNegativeInteger(value.joined_at) ||
        typeof value.is_bot !== "boolean" ||
        !record(value.supplemental) ||
        (value.supplemental.join_source_type !== undefined &&
            value.supplemental.join_source_type !== null &&
            !joinSourceType(value.supplemental.join_source_type)) ||
        !nullableText(value.supplemental.source_invite_code) ||
        !nullableIdentifier(value.supplemental.inviter_id)
    )
        return undefined
    return Object.freeze({
        guildId: value.guild_id,
        userId: value.user_id,
        username: value.username,
        discriminator: value.discriminator,
        globalName: value.global_name,
        nickname: value.nickname,
        roleIds,
        joinedAtSeconds: value.joined_at,
        isBot: value.is_bot,
        joinSourceType: value.supplemental.join_source_type ?? null,
        sourceInviteCode: value.supplemental.source_invite_code,
        inviterId: value.supplemental.inviter_id,
    })
}

/** Decodes a complete provider page without admitting its partial indexed hits to the guild-member cache */
export function decodeMemberSearchPage(
    value: unknown,
    guildId: string,
    query: Pick<EncodedMemberSearchQuery, "limit">,
): MemberSearchPage | undefined {
    if (
        !record(value) ||
        !identifier(value.guild_id) ||
        value.guild_id !== guildId ||
        !Array.isArray(value.members) ||
        value.members.length > query.limit ||
        !nonNegativeInteger(value.page_result_count) ||
        value.page_result_count !== value.members.length ||
        !nonNegativeInteger(value.total_result_count) ||
        value.total_result_count < value.page_result_count ||
        typeof value.indexing !== "boolean"
    )
        return undefined
    const members: MemberSearchHit[] = []
    const userIds = new Set<string>()
    for (const source of value.members) {
        const member = hit(source, guildId)
        if (!member || userIds.has(member.userId)) return undefined
        userIds.add(member.userId)
        members.push(member)
    }
    return Object.freeze({
        guildId,
        members: Object.freeze(members),
        pageResultCount: value.page_result_count,
        totalResultCount: value.total_result_count,
        indexing: value.indexing,
    })
}

/** Builds a remote-only POST page request. It omits cache admission and therefore cannot populate partial indexed hits */
export function memberSearch(
    guildId: string,
    query?: MemberSearchQuery,
): GuildRequest<MemberSearchPage> | InputValidationFailure {
    const encoded = encodeMemberSearchQuery(query)
    if (!identifier(guildId)) return inputValidationFailure("guildId", "format", "Guild IDs must be decimal strings")
    if (encoded instanceof InputValidationFailure) return encoded
    return {
        guildId,
        bucket: "guild:members",
        path: `/guilds/${guildId}/members-search`,
        method: "POST",
        status: 200,
        json: encoded.json,
        decode: (value) => decodeMemberSearchPage(value, guildId, encoded),
    }
}
