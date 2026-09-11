/** Provider category IDs for public server-directory applications */
export const DiscoveryCategories = Object.freeze({
    Gaming: 0,
    Music: 1,
    Entertainment: 2,
    Education: 3,
    ScienceAndTechnology: 4,
    ContentCreator: 5,
    AnimeAndManga: 6,
    MoviesAndTv: 7,
    Other: 8,
} as const)

/** A directory category returned by Fluxer, not a localised SDK label */
export interface DiscoveryCategory {
    /** Numeric provider category ID; pass this as categoryId when applying or editing */
    readonly id: number
    /** Provider-supplied display name */
    readonly name: string
}

/** Submit a server-directory application, potentially making an eligible verified/partnered server public immediately
 * @example
 * ```ts
 * import { DiscoveryCategories, type Client } from "@neontechspace/fluxerly"
 * export function discoveryExample(client: Client, guildId: string) {
 *     return client.discovery.fetchStatus(guildId)
 * }
 * export function discoveryCategoriesExample(client: Client) {
 *     return client.discovery.fetchCategories()
 * }
 * export function submitDirectoryApplication(client: Client, guildId: string) {
 *     return client.discovery.apply(guildId, {
 *         description: "A community for discussing software development",
 *         categoryId: DiscoveryCategories.ScienceAndTechnology,
 *         primaryLanguage: "en-US",
 *         tags: ["programming"],
 *     })
 * }
 * export function editDirectoryTags(client: Client, guildId: string) {
 *     return client.discovery.edit(guildId, { tags: ["programming", "typescript"] })
 * }
 * export function withdrawDirectoryApplication(client: Client, guildId: string) {
 *     return client.discovery.withdraw(guildId)
 * }
 * ```
 */
export interface DiscoveryApplicationInput {
    /** Listing description, 10–300 UTF-16 code units. Fluxer may reject moderated content */
    readonly description: string
    /** Integer 0–8, selected using DiscoveryCategories or fetchCategories */
    readonly categoryId: number
    /** Case-sensitive provider-supported BCP-47 code, default en-US on apply. Fluxer validates the supported set */
    readonly primaryLanguage?: string
    /** Up to ten tags, each 2–30 UTF-16 code units before and after normalization.
     * Letters/digits first, then letters/digits/spaces/hyphens/underscores/plus/ampersand.
     * Trimmed, lowercased, whitespace-collapsed and deduplicated like Fluxer. Omitted on apply means []
     */
    readonly tags?: readonly string[]
}

/** Nonempty directory patch. Omitted fields remain unchanged; tags replace the list and [] clears it.
 * Uses DiscoveryApplicationInput's validation. Null cannot clear required description/category/language
 */
export type DiscoveryApplicationEdit = Partial<DiscoveryApplicationInput>

/** Frozen directory application/listing observation, without SDK retention or reviewer identities */
export interface DiscoveryApplication {
    /** Decimal guild ID whose application was observed */
    readonly guildId: string
    /** Provider state, currently pending, approved, rejected or removed. Future states are preserved */
    readonly status: string
    /** Observed directory description */
    readonly description: string
    /** Observed provider category ID */
    readonly categoryId: number
    /** Observed primary language, null if absent */
    readonly primaryLanguage: string | null
    /** Frozen provider tags, not a mutable copy of submitted input */
    readonly tags: readonly string[]
    /** ISO 8601 application time */
    readonly appliedAt: string
    /** ISO 8601 review time, null if not reviewed */
    readonly reviewedAt: string | null
    /** Provider review explanation, null if absent */
    readonly reviewReason: string | null
    /** ISO 8601 removal time, null if not removed */
    readonly removedAt: string | null
    /** Provider removal explanation, null if absent */
    readonly removalReason: string | null
    /** Provider NSFW level, when supplied. Not a client-computed content classification */
    readonly guildNsfwLevel?: number | null
}

/** Remote eligibility and application status, not a promise that a later submission will succeed */
export interface DiscoveryStatus {
    /** Current application or listing, null when no record exists */
    readonly application: DiscoveryApplication | null
    /** False when directory discovery is disabled or the guild fails current eligibility */
    readonly eligible: boolean
    /** Provider's current minimum member count, not a local configuration setting */
    readonly minMemberCount: number
}

/** One volatile public directory result, not a full guild observation or a join invitation */
export interface DiscoveryGuild {
    /** Decimal guild ID */
    readonly id: string
    /** Directory-visible guild name */
    readonly name: string
    /** Icon hash, or null when the directory has none */
    readonly icon: string | null
    /** Banner hash, or null when the directory has none */
    readonly banner: string | null
    /** Directory description, or null when absent */
    readonly description: string | null
    /** Provider directory category ID */
    readonly categoryId: number
    /** Provider primary language, or null when absent */
    readonly primaryLanguage: string | null
    /** Frozen provider directory tags */
    readonly tags: readonly string[]
    /** Approximate directory member count */
    readonly memberCount: number
    /** Approximate directory online-member count */
    readonly onlineCount: number
    /** Provider feature names */
    readonly features: readonly string[]
    /** Provider verification level */
    readonly verificationLevel: number
}

/** Filters and explicit offset page controls for one public directory read */
export interface DiscoverySearchQuery {
    /** Free-text query of at most 100 UTF-16 code units */
    readonly query?: string
    /** Provider category ID from 0 through 8 */
    readonly categoryId?: number
    /** Case-sensitive BCP-47 primary-language filter */
    readonly primaryLanguage?: string
    /** Directory tag of at most 30 UTF-16 code units */
    readonly tag?: string
    /** Provider ordering. Omission uses Fluxer's default ordering */
    readonly sortBy?: "memberCount" | "onlineCount" | "relevance"
    /** Results per page from 1 through 48, defaulting to 24 */
    readonly limit?: number
    /** Zero-based result offset, defaulting to 0 */
    readonly offset?: number
}

/** Frozen category match count for the current directory filters, ignoring the selected category */
export interface DiscoveryCategoryCount {
    /** Provider category ID */
    readonly categoryId: number
    /** Current matching guild count */
    readonly count: number
}

/** One explicit, non-snapshot-stable directory page with the effective offset and limit */
export interface DiscoverySearchPage {
    /** Frozen directory results in provider order */
    readonly guilds: readonly DiscoveryGuild[]
    /** Provider-reported matching guild count, which can change immediately */
    readonly total: number
    /** Frozen current-filter category counts, ignoring DiscoverySearchQuery.categoryId */
    readonly categoryCounts: readonly DiscoveryCategoryCount[]
    /** Effective zero-based request offset */
    readonly offset: number
    /** Effective request page limit */
    readonly limit: number
}
