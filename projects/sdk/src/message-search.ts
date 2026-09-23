import type { OperationOptions } from "./client.js"
import type { MessageOperationOptions, Message, MessageCore } from "./messages.js"
import type { PaginationQuery } from "./pagination.js"

/** Server or channel in which to search messages visible to the bot.
 * Supply at least guildId or channelId, as decimal strings. You may supply both.
 * Search uses the bot's current access permissions, not another account's permissions or access the bot had earlier.
 * The SDK captures the supplied IDs once when the request or traversal starts
 */
export type MessageSearchContext =
    | {
          /** Server ID defining the search context, as a decimal string */
          readonly guildId: string
          /** Optional channel context supplied alongside the server ID, as a decimal string */
          readonly channelId?: string
      }
    | {
          /** Optional server ID supplied with this channel context, as a decimal string */
          readonly guildId?: string
          /** Channel ID defining the search context, as a decimal string */
          readonly channelId: string
      }

/** Author category used by Fluxer's message search: A user, bot or webhook sender */
export type MessageSearchAuthorType = "user" | "bot" | "webhook"

/** Kind of content to require or exclude in Fluxer's message search.
 * snapshot identifies copied content in a forwarded message
 */
export type MessageSearchContentType =
    "image" | "sound" | "video" | "file" | "sticker" | "embed" | "link" | "poll" | "snapshot"

/** Embed category to require or exclude in Fluxer's message search */
export type MessageSearchEmbedType = "image" | "video" | "sound" | "article"

/** Filters and paging settings for one messages.search request.
 * Fluxer searches an index that may not yet include recent edits or deletions.
 * Search does not read message history or the local cache. Results are not added to the message cache.
 * Omit a filter to leave that criterion unspecified. Fluxer combines and interprets the supplied search criteria.
 * Unknown properties, invalid values and lists exceeding the documented limits are rejected locally.
 * The SDK copies each filter array when the operation starts, so later changes to the array do not affect this request.
 * All ID filters use decimal strings. Text limits count UTF-16 code units, the units used by JavaScript string.length
 */
export interface MessageSearchQuery {
    /** Maximum indexed messages requested, an integer from 1 through 25, default 25 */
    readonly limit?: number
    /** Numbered result page, an integer from 1 through 400 with 1 meaning the first page. Defaults to 1 */
    readonly page?: number
    /** Include message IDs smaller than this decimal ID */
    readonly maxId?: string
    /** Include message IDs greater than this decimal ID */
    readonly minId?: string
    /** Text for Fluxer to search, from 1 through 1,024 UTF-16 code units, without local trimming */
    readonly content?: string
    /** Multiple search texts, at most 100 strings, each from 1 through 1,024 UTF-16 code units */
    readonly contents?: readonly string[]
    /** Contiguous phrases to match, at most 10 strings, each from 1 through 1,024 UTF-16 code units */
    readonly exactPhrases?: readonly string[]
    /** Limit matches to these channel IDs, at most 500 decimal strings */
    readonly channelIds?: readonly string[]
    /** Exclude matches from these channels, at most 500 decimal ID strings */
    readonly excludeChannelIds?: readonly string[]
    /** Author categories to include, at most 20 entries */
    readonly authorTypes?: readonly MessageSearchAuthorType[]
    /** Author categories to exclude, at most 20 entries */
    readonly excludeAuthorTypes?: readonly MessageSearchAuthorType[]
    /** Match messages from these author IDs, at most 100 decimal strings */
    readonly authorIds?: readonly string[]
    /** Exclude messages from these author IDs, at most 100 decimal strings */
    readonly excludeAuthorIds?: readonly string[]
    /** Match account mentions using these IDs, at most 100 decimal strings */
    readonly mentions?: readonly string[]
    /** Exclude matches mentioning these accounts, at most 100 decimal ID strings */
    readonly excludeMentions?: readonly string[]
    /** Require or exclude messages that Fluxer's index marks as mentioning @everyone or @here */
    readonly mentionedEveryone?: boolean
    /** Require pinned messages with true, or unpinned messages with false, according to the index */
    readonly pinned?: boolean
    /** Content categories to require, at most 20 entries */
    readonly has?: readonly MessageSearchContentType[]
    /** Content categories to exclude, at most 20 entries */
    readonly excludeHas?: readonly MessageSearchContentType[]
    /** Embed categories to require, at most 20 entries, including generated and explicitly supplied embeds */
    readonly embedTypes?: readonly MessageSearchEmbedType[]
    /** Embed categories to exclude, at most 20 entries, including generated and explicitly supplied embeds */
    readonly excludeEmbedTypes?: readonly MessageSearchEmbedType[]
    /** Embed provider names to match, at most 50 strings of 1 through 256 UTF-16 code units each */
    readonly embedProviders?: readonly string[]
    /** Embed provider names to exclude, at most 50 strings of 1 through 256 UTF-16 code units each */
    readonly excludeEmbedProviders?: readonly string[]
    /** Link hostnames to match, at most 100 strings of 1 through 255 UTF-16 code units each */
    readonly linkHostnames?: readonly string[]
    /** Link hostnames to exclude, at most 100 strings of 1 through 255 UTF-16 code units each */
    readonly excludeLinkHostnames?: readonly string[]
    /** Attached file names to match, at most 100 strings of 1 through 1,024 UTF-16 code units each */
    readonly attachmentFilenames?: readonly string[]
    /** Attached file names to exclude, at most 100 strings of 1 through 1,024 UTF-16 code units each */
    readonly excludeAttachmentFilenames?: readonly string[]
    /** Attached file extensions to match, at most 50 strings of 1 through 32 UTF-16 code units each */
    readonly attachmentExtensions?: readonly string[]
    /** Attached file extensions to exclude, at most 50 strings of 1 through 32 UTF-16 code units each */
    readonly excludeAttachmentExtensions?: readonly string[]
    /** Rank results by timestamp or relevance, default timestamp */
    readonly sortBy?: "timestamp" | "relevance"
    /** Ascending or descending result order, default desc */
    readonly sortOrder?: "asc" | "desc"
    /** Permit results from channels Fluxer marks NSFW. Defaults to false and does not bypass channel access checks */
    readonly includeNsfw?: boolean
}

/** Channel information supplied beside message search results.
 * This frozen snapshot is not a complete channel, cached channel or permission check
 */
export interface MessageSearchChannel {
    /** Channel ID as a decimal string */
    readonly id: string
    /** Owning server ID, when Fluxer supplied it */
    readonly guildId?: string
    /** Observed channel name, when supplied. Private channels may omit it */
    readonly name?: string
    /** Fluxer's numeric channel type, including unrecognized future values */
    readonly type: number
}

/** Successful search response indicating that Fluxer is still preparing an index.
 * No messages or result total are available yet. Retry later with another explicit search request.
 * The SDK does not poll or retry indexing automatically
 */
export interface MessageSearchIndexingPage {
    /** True distinguishes this response from a MessageSearchResultsPage */
    readonly indexing: true
}

/** Search results returned once Fluxer's index can answer the request.
 * The page and its nested results are frozen. Later index updates can change later pages and totals.
 * Check indexing before reading results, since search can instead return MessageSearchIndexingPage
 */
export interface MessageSearchResultsPage<M extends MessageCore = Message> {
    /** False distinguishes this response from an index-preparation response */
    readonly indexing: false
    /** Indexed message snapshots using the client's messageFields selection, without extra fetches or cache writes */
    readonly messages: readonly M[]
    /** Exactly one channel snapshot per distinct channel in messages, without extras, private recipient lists or permission data */
    readonly channels: readonly MessageSearchChannel[]
    /** Indexed match count observed with this response, not a stable count for a multi-page run */
    readonly total: number
    /** Page capacity Fluxer reported for this response, not necessarily the number of returned messages */
    readonly hitsPerPage: number
    /** Page number Fluxer applied, starting at 1 */
    readonly page: number
}

/** Successful outcome of one messages.search request.
 * Branch on indexing before accessing result fields
 */
export type MessageSearchPage<M extends MessageCore = Message> = MessageSearchIndexingPage | MessageSearchResultsPage<M>

/** Limit how many messages and pages messages.iterateSearch can read.
 * Each consumption starts at page 1 for the given context and filters, then reads later numbered pages as Fluxer's total requires.
 * Limits are captured once when that consumption starts.
 * Fluxer supports at most 400 numbered pages. If more results remain after page 400, traversal fails with PaginationError reason pageLimit.
 * No background prefetch runs. An indexing response fails traversal with PaginationError reason indexing rather than polling
 */
export interface MessageSearchIterationLimits extends PaginationQuery {
    /** Maximum messages per request, an integer from 1 through 25, default 25.
     * Request capacity is the smaller of this value and maxItems, fixed throughout the scan to preserve page offsets
     */
    readonly pageSize?: number
}

/** Deadline for one explicit search request.
 * For iterateSearch, the deadline applies separately to each page request, not to the entire traversal
 */
export interface MessageSearchOptions extends MessageOperationOptions {}

/** Search settings for the Promise and Result API, including AbortSignal cancellation.
 * signal affects this explicit request or this consumption's iterator pulls, not other callers.
 * The Effect entry point uses interruption instead
 */
export interface DefaultMessageSearchOptions extends MessageSearchOptions, OperationOptions {}
