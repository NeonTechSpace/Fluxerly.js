import type { PaginationQuery } from "./pagination.js"

/** Fluxer's known sources for a guild membership recorded by the indexed member-search service */
export const GuildMemberJoinSourceTypes: Readonly<{
    /** The member created the guild */
    Creator: 0
    /** The member joined through a regular invitation code */
    InstantInvite: 1
    /** The member joined through the guild's custom invitation code */
    VanityUrl: 2
    /** The bot was added through a bot installation invitation */
    BotInvite: 3
    /** The member was added by an administrator */
    AdminForceAdd: 4
    /** The member joined through the public server directory */
    Discovery: 6
}> = Object.freeze({
    Creator: 0,
    InstantInvite: 1,
    VanityUrl: 2,
    BotInvite: 3,
    AdminForceAdd: 4,
    Discovery: 6,
})

/** One known Fluxer guild-member join source */
export type GuildMemberJoinSourceType = (typeof GuildMemberJoinSourceTypes)[keyof typeof GuildMemberJoinSourceTypes]

/**
 * Find guild members by text, roles, join dates or membership source using Fluxer's search index.
 * The search index can lag behind current membership and profile changes. Search results are partial
 * records, not the SDK cache or complete GuildMember snapshots.
 * Fluxer requires a member-management permission for every search.
 * Join-source and source-invite filters require ManageGuild. The SDK checks that permission before sending these
 * filters, which Fluxer would otherwise silently ignore. Filter arrays are copied by index when the operation starts.
 * Timestamps use whole Unix seconds. Unknown keys and values outside the documented
 * bounds fail locally before the POST. The provider can return an empty, non-indexing page when its search service is
 * unavailable
 *
 * @example
 * ```ts
 * import type { Client } from "@neontechspace/fluxerly"
 *
 * export function memberSearchExample(client: Client, guildId: string) {
 *     const page = client.members.search(guildId, { query: "alex", roleIds: ["10"] })
 *     const hits = client.members.iterateSearch(guildId, { isBot: false }, { maxItems: 100 })
 *     return { page, hits }
 * }
 * ```
 */
export interface MemberSearchQuery {
    /** Text matched by Fluxer against indexed usernames, display names, nicknames, discriminators and user IDs. At most 100 UTF-16 code units */
    readonly query?: string
    /** Results in this offset page, 1–100, default 25 */
    readonly limit?: number
    /** Zero-based indexed-result offset, a nonnegative safe integer, default 0. It is not a durable cursor or snapshot token */
    readonly offset?: number
    /** Require every supplied role ID. At most 10 distinct decimal role IDs. An empty list has no filtering effect */
    readonly roleIds?: readonly string[]
    /** Include members whose indexed guild-join time is at or after this nonnegative whole Unix-second value */
    readonly joinedAtAfterSeconds?: number
    /** Include members whose indexed guild-join time is at or before this nonnegative whole Unix-second value */
    readonly joinedAtBeforeSeconds?: number
    /** Include members whose indexed account-creation time is at or after this nonnegative whole Unix-second value */
    readonly userCreatedAtAfterSeconds?: number
    /** Include members whose indexed account-creation time is at or before this nonnegative whole Unix-second value */
    readonly userCreatedAtBeforeSeconds?: number
    /** Require one of these indexed membership sources. At most 10 distinct values and requires ManageGuild */
    readonly joinSourceTypes?: readonly GuildMemberJoinSourceType[]
    /** Require one of these indexed invite codes. At most 10 distinct values and requires ManageGuild. Codes are never included in SDK diagnostics */
    readonly sourceInviteCodes?: readonly string[]
    /** Include only bot or only non-bot indexed members */
    readonly isBot?: boolean
    /** Fluxer relevance or indexed join-time ordering. Omission uses indexed join time */
    readonly sortBy?: "joinedAt" | "relevance"
    /** Indexed join-time direction. Omission uses descending. Fluxer ignores this when sorting by relevance */
    readonly sortOrder?: "asc" | "desc"
}

/** A member matched by the search index, with indexed identity, roles and available membership-source details.
 * Use guildId and userId with members.fetch when you need a fresh GuildMember. This frozen hit does not populate
 * the member cache and cannot establish current membership or permissions
 */
export interface MemberSearchHit {
    /** Decimal guild ID, equal to the requested guild */
    readonly guildId: string
    /** Decimal member user ID */
    readonly userId: string
    /** Indexed account username */
    readonly username: string
    /** Indexed four-digit account discriminator */
    readonly discriminator: string
    /** Indexed global display name, null when absent */
    readonly globalName: string | null
    /** Indexed guild nickname, null when absent */
    readonly nickname: string | null
    /** Explicit indexed role IDs, not effective permissions or the implicit everyone role */
    readonly roleIds: readonly string[]
    /** Indexed guild-join time as a nonnegative whole Unix-second value */
    readonly joinedAtSeconds: number
    /** Indexed bot classification */
    readonly isBot: boolean
    /** Indexed membership source, or null when absent or redacted because the caller lacks ManageGuild */
    readonly joinSourceType: GuildMemberJoinSourceType | null
    /** Indexed invite code, or null when absent or redacted because the caller lacks ManageGuild */
    readonly sourceInviteCode: string | null
    /** Decimal inviter user ID, or null when absent or redacted because the caller lacks ManageGuild */
    readonly inviterId: string | null
}

/**
 * Matching indexed members and counts from one search request.
 * Counts and order describe a changing index, not a complete membership snapshot.
 * When indexing is true, Fluxer accepted the request but is building the guild index.
 * Wait and issue a new page request rather than treating that empty page as completion
 */
export interface MemberSearchPage {
    /** Decimal guild ID, equal to the requested guild */
    readonly guildId: string
    /** Frozen indexed hit observations. This does not admit or replace member-cache entries */
    readonly members: readonly MemberSearchHit[]
    /** Number of returned members in this page */
    readonly pageResultCount: number
    /** Indexed matches observed for this request, which can change before a later offset page */
    readonly totalResultCount: number
    /** Whether Fluxer reported that it is currently building this guild's member index */
    readonly indexing: boolean
}

/** Limit how much work members.iterateSearch may perform while reading matching indexed members.
 * maxItems is required through PaginationQuery. Each consumption requests pages only as needed and yields each user
 * at most once, but concurrent index changes can skip members. Index-building pages fail with PaginationError/indexing,
 * and an empty page that cannot advance fails with cursorStalled rather than silently reporting completion
 */
export interface MemberSearchIterationLimits extends PaginationQuery {
    /** Indexed hits requested per POST, 1–100 and default 100 */
    readonly pageSize?: number
}
