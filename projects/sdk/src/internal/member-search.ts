/**
 * Member search requests and page projection.
 * Invariant: Queries are validated locally, and pages are decoded completely before any result is returned.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import {
    GuildMemberJoinSourceTypes,
    type GuildMemberJoinSourceType,
    type MemberSearchHit,
    type MemberSearchPage,
    type MemberSearchQuery,
} from "#sdk/member-search"
import type { GuildRequest } from "./guilds.js"
import { identifier, nonNegativeInteger, record, snapshotArray } from "./decode/primitives.js"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"
import {
    booleanField,
    checkFields,
    choiceField,
    distinct,
    type FieldRules,
    integerField,
    listField,
    textField,
    wireFields,
} from "./field-rules.js"

const joinSourceTypeValues = new Set<number>(Object.values(GuildMemberJoinSourceTypes))

interface EncodedMemberSearchQuery {
    readonly limit: number
    readonly offset: number
    readonly json: string
    readonly query: MemberSearchQuery
}

const joinSourceType = (value: unknown): value is GuildMemberJoinSourceType =>
    typeof value === "number" && joinSourceTypeValues.has(value)

const nullableText = (value: unknown): value is string | null => value === null || typeof value === "string"
const nullableIdentifier = (value: unknown): value is string | null => value === null || identifier(value)

function identifiers(value: unknown, maximum: number): readonly string[] | undefined {
    const items = snapshotArray(value, maximum)
    if (!items) return undefined
    return items.every(identifier) && new Set(items).size === items.length ? Object.freeze(items) : undefined
}

const seconds = (explanation: string) => integerField(0, Number.MAX_SAFE_INTEGER, explanation)

/** Query rules in the order Fluxerly checks them, with limit and offset already defaulted */
const queryRules: FieldRules = {
    query: textField(0, 100, "Member search text must contain at most 100 UTF-16 code units"),
    offset: integerField(0, Number.MAX_SAFE_INTEGER, "Member search offset must be a nonnegative safe integer"),
    limit: integerField(1, 100, "Member search limit must be an integer from 1 through 100"),
    roleIds: distinct(
        listField(
            10,
            identifier,
            "format",
            "Member search role IDs must be an array of at most 10 unique decimal strings",
        ),
    ),
    joinedAtAfterSeconds: seconds("Joined-after time must be a nonnegative safe integer in Unix seconds"),
    joinedAtBeforeSeconds: seconds("Joined-before time must be a nonnegative safe integer in Unix seconds"),
    userCreatedAtAfterSeconds: seconds("User-created-after time must be a nonnegative safe integer in Unix seconds"),
    userCreatedAtBeforeSeconds: seconds("User-created-before time must be a nonnegative safe integer in Unix seconds"),
    joinSourceTypes: distinct(
        listField(
            10,
            joinSourceType,
            "allowedValue",
            "Join source types must be an array of at most 10 unique supported values",
        ),
    ),
    sourceInviteCodes: distinct(
        listField(
            10,
            (value) => typeof value === "string",
            "unique",
            "Source invite codes must be an array of at most 10 unique strings",
        ),
    ),
    isBot: booleanField("Member search filter isBot must be a boolean"),
    sortBy: choiceField(["joinedAt", "relevance"], "Member search sortBy must be joinedAt or relevance"),
    sortOrder: choiceField(["asc", "desc"], "Member search sortOrder must be asc or desc"),
}
const queryKeys = [
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
]
/** Wire names in the order Fluxerly sends them */
const wireNames: Readonly<Record<string, string>> = {
    query: "query",
    limit: "limit",
    offset: "offset",
    roleIds: "role_ids",
    joinedAtAfterSeconds: "joined_at_gte",
    joinedAtBeforeSeconds: "joined_at_lte",
    joinSourceTypes: "join_source_type",
    sourceInviteCodes: "source_invite_code",
    isBot: "is_bot",
    userCreatedAtAfterSeconds: "user_created_at_gte",
    userCreatedAtBeforeSeconds: "user_created_at_lte",
    sortBy: "sort_by",
    sortOrder: "sort_order",
}

/** Validates and encodes one provider page request, preserving provider defaults without retaining caller input */
export function encodeMemberSearchQuery(query?: unknown): EncodedMemberSearchQuery | InputValidationFailure {
    const supplied = query === undefined ? {} : query
    if (!record(supplied)) return inputValidationFailure("query", "type", "Member search query must be an object")
    const unsupported = unsupportedKeyFailure(supplied, queryKeys, "query", "the member search query")
    if (unsupported) return unsupported
    // Read recognized properties once, regardless of ownership or enumerability
    const input = Object.fromEntries(queryKeys.map((key) => [key, supplied[key]]))
    const limit = input.limit === undefined ? 25 : input.limit
    const offset = input.offset === undefined ? 0 : input.offset
    const checked = checkFields({ ...input, limit, offset }, queryRules, "query.")
    if (checked instanceof InputValidationFailure) return checked
    // The copied query keeps the frozen list copies, and an omitted limit or offset stays omitted
    input.roleIds = checked.roleIds
    input.joinSourceTypes = checked.joinSourceTypes
    input.sourceInviteCodes = checked.sourceInviteCodes
    return Object.freeze({
        limit: limit as number,
        offset: offset as number,
        json: JSON.stringify(wireFields(checked, wireNames)),
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
        displayName: value.global_name,
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
function decodeMemberSearchPage(
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
        read: true,
        status: 200,
        json: encoded.json,
        decode: (value) => decodeMemberSearchPage(value, guildId, encoded),
    }
}
