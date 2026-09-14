/** Named category IDs for listing a guild in Fluxer's public server directory.
 * Pass a value as categoryId to discovery.apply, discovery.edit or discovery.search.
 * These categories concern public guild listings, not instance endpoint discovery
 */
export const DiscoveryCategories: Readonly<{
    /** Category for gaming communities */
    readonly Gaming: 0
    /** Category for music communities */
    readonly Music: 1
    /** Category for entertainment communities */
    readonly Entertainment: 2
    /** Category for educational communities */
    readonly Education: 3
    /** Category for science and technology communities */
    readonly ScienceAndTechnology: 4
    /** Category for communities centered on content creators */
    readonly ContentCreator: 5
    /** Category for anime and manga communities */
    readonly AnimeAndManga: 6
    /** Category for movie and television communities */
    readonly MoviesAndTv: 7
    /** Category for communities outside the named categories */
    readonly Other: 8
}> = Object.freeze({
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

/** A category returned by discovery.fetchCategories, with Fluxer's display name rather than an SDK-translated label */
export interface DiscoveryCategory {
    /** Numeric provider category ID to pass as categoryId when applying or editing */
    readonly id: number
    /** Provider-supplied display name */
    readonly name: string
}

/** Describe a guild for a public server-directory application.
 * Pass this input to discovery.apply after checking the guild's current status and eligibility.
 * An eligible verified or partnered server can become publicly listed immediately, without a later review step.
 * String lengths use JavaScript UTF-16 code units, so some characters count as two
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
    /** Primary language tag such as en-US, using the provider's case-sensitive supported BCP-47 codes.
     * Defaults to en-US on apply, with the supported set checked by Fluxer
     */
    readonly primaryLanguage?: string
    /** Up to ten tags, each 2–30 UTF-16 code units before and after normalization.
     * Start each tag with a letter or digit, followed by letters, digits, spaces, hyphens, underscores, plus or ampersand.
     * The SDK trims and lowercases tags, collapses whitespace and removes duplicates like Fluxer.
     * Omission on apply means an empty tag list
     */
    readonly tags?: readonly string[]
}

/** Change an existing directory application or listing with discovery.edit.
 * Supply at least one field, with the same validation as DiscoveryApplicationInput.
 * Omitted fields remain unchanged, tags replaces the entire list, and tags: [] clears it.
 * Null cannot clear the required description, category or language
 */
export type DiscoveryApplicationEdit = Partial<DiscoveryApplicationInput>

/** Current application or public listing returned by directory reads and writes.
 * This frozen observation is not cached and includes no reviewer identities.
 * Review and removal explanations are provider text, not fixed SDK diagnostics
 */
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
    /** Provider NSFW level when supplied, null when unspecified, or an omitted field when not returned.
     * This is not a client-computed content classification
     */
    readonly guildNsfwLevel?: number | null
}

/** Current directory eligibility and application state returned by discovery.fetchStatus.
 * Use this to inspect whether the guild currently qualifies, not to guarantee that a later submission will succeed
 */
export interface DiscoveryStatus {
    /** Current application or listing, null when no record exists */
    readonly application: DiscoveryApplication | null
    /** False when directory discovery is disabled or the guild fails current eligibility */
    readonly eligible: boolean
    /** Provider's current minimum member count, not a local configuration setting */
    readonly minMemberCount: number
}

/** Public guild listing returned by discovery.search.
 * It contains directory-visible details and approximate counts, not the full Guild object or an invitation to join.
 * The SDK does not retain this result in the guild cache
 */
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

/** Filter and choose one page of public guild listings with discovery.search.
 * Omit filters to use the provider's unfiltered directory and default ordering.
 * Pages use an offset, not a stable snapshot, so changing listings can produce skips or repeats between calls
 */
export interface DiscoverySearchQuery {
    /** Free-text query of at most 100 UTF-16 code units */
    readonly query?: string
    /** Provider category ID from 0 through 8 */
    readonly categoryId?: number
    /** Case-sensitive language tag such as en-US, 2–35 UTF-16 code units in the accepted BCP-47-style format */
    readonly primaryLanguage?: string
    /** Directory tag of at most 30 UTF-16 code units */
    readonly tag?: string
    /** Provider ordering. Omission uses Fluxer's default ordering */
    readonly sortBy?: "memberCount" | "onlineCount" | "relevance"
    /** Results per page from 1 through 48, defaulting to 24 */
    readonly limit?: number
    /** Zero-based result offset, a nonnegative safe integer defaulting to 0 */
    readonly offset?: number
}

/** Frozen category match count for the current directory filters, ignoring the selected category */
export interface DiscoveryCategoryCount {
    /** Provider category ID */
    readonly categoryId: number
    /** Current matching guild count */
    readonly count: number
}

/** One public directory page, including its effective offset, limit and current matching totals.
 * The directory can change between requests, so total does not establish stable traversal or a complete inventory
 */
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
