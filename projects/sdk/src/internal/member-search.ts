import {
    GuildMemberJoinSourceTypes,
    type GuildMemberJoinSourceType,
    type MemberSearchHit,
    type MemberSearchPage,
    type MemberSearchQuery,
} from "#sdk/member-search"
import type { GuildRequest } from "./guilds.js"
import { identifier, record } from "./message.js"

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
}

const nonNegativeInteger = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0

const joinSourceType = (value: unknown): value is GuildMemberJoinSourceType =>
    typeof value === "number" && joinSourceTypeValues.has(value)

const nullableText = (value: unknown): value is string | null => value === null || typeof value === "string"
const nullableIdentifier = (value: unknown): value is string | null => value === null || identifier(value)

function identifiers(value: unknown, maximum: number): value is readonly string[] {
    if (!Array.isArray(value) || value.length > maximum) return false
    const items = Array.from(value)
    return items.every(identifier) && new Set(items).size === items.length
}

function texts(value: unknown, maximum: number): value is readonly string[] {
    if (!Array.isArray(value) || value.length > maximum) return false
    const items = Array.from(value)
    return items.every((item) => typeof item === "string") && new Set(items).size === items.length
}

function joinSourceTypes(value: unknown): value is readonly GuildMemberJoinSourceType[] {
    if (!Array.isArray(value) || value.length > 10) return false
    const items = Array.from(value)
    return items.every(joinSourceType) && new Set(items).size === items.length
}

/** Validates and encodes one provider page request, preserving provider defaults without retaining caller input */
export function encodeMemberSearchQuery(query?: unknown): EncodedMemberSearchQuery | undefined {
    const input = query === undefined ? {} : query
    if (!record(input) || Object.keys(input).some((key) => !queryKeys.has(key))) return undefined
    const limit = input.limit === undefined ? 25 : input.limit
    const offset = input.offset === undefined ? 0 : input.offset
    if (
        (input.query !== undefined && (typeof input.query !== "string" || input.query.length > 100)) ||
        !nonNegativeInteger(offset) ||
        typeof limit !== "number" ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (input.roleIds !== undefined && !identifiers(input.roleIds, 10)) ||
        (input.joinedAtAfterSeconds !== undefined && !nonNegativeInteger(input.joinedAtAfterSeconds)) ||
        (input.joinedAtBeforeSeconds !== undefined && !nonNegativeInteger(input.joinedAtBeforeSeconds)) ||
        (input.userCreatedAtAfterSeconds !== undefined && !nonNegativeInteger(input.userCreatedAtAfterSeconds)) ||
        (input.userCreatedAtBeforeSeconds !== undefined && !nonNegativeInteger(input.userCreatedAtBeforeSeconds)) ||
        (input.joinSourceTypes !== undefined && !joinSourceTypes(input.joinSourceTypes)) ||
        (input.sourceInviteCodes !== undefined && !texts(input.sourceInviteCodes, 10)) ||
        (input.isBot !== undefined && typeof input.isBot !== "boolean") ||
        (input.sortBy !== undefined && input.sortBy !== "joinedAt" && input.sortBy !== "relevance") ||
        (input.sortOrder !== undefined && input.sortOrder !== "asc" && input.sortOrder !== "desc")
    )
        return undefined
    const sourceTypes = input.joinSourceTypes === undefined ? undefined : [...input.joinSourceTypes]
    const inviteCodes = input.sourceInviteCodes === undefined ? undefined : [...input.sourceInviteCodes]
    const body = {
        ...(input.query === undefined ? {} : { query: input.query }),
        limit,
        offset,
        ...(input.roleIds === undefined ? {} : { role_ids: [...input.roleIds] }),
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
    })
}

function hit(value: unknown, guildId: string): MemberSearchHit | undefined {
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
        !identifiers(value.role_ids, Number.MAX_SAFE_INTEGER) ||
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
        roleIds: Object.freeze([...value.role_ids]),
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
export function memberSearch(guildId: string, query?: MemberSearchQuery): GuildRequest<MemberSearchPage> | undefined {
    const encoded = encodeMemberSearchQuery(query)
    if (!identifier(guildId) || !encoded) return undefined
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
