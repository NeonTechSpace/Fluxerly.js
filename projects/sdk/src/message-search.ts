import type { OperationOptions } from "./client.js"
import type { MessageOperationOptions, Message } from "./messages.js"
import type { PaginationQuery } from "./pagination.js"

/** Context required for bot message search. At least one decimal guild or channel ID is required and Fluxerly always uses Fluxer's current scope */
export type MessageSearchContext =
    | { readonly guildId: string; readonly channelId?: string }
    | { readonly guildId?: string; readonly channelId: string }

/** Indexed message-author classifications accepted by Fluxer */
export type MessageSearchAuthorType = "user" | "bot" | "webhook"

/** Indexed message-content classifications accepted by Fluxer */
export type MessageSearchContentType =
    "image" | "sound" | "video" | "file" | "sticker" | "embed" | "link" | "poll" | "snapshot"

/** Indexed rich-embed classifications accepted by Fluxer */
export type MessageSearchEmbedType = "image" | "video" | "sound" | "article"

/** One explicit indexed-message search page. This is not a history query, cache lookup or stable snapshot */
export interface MessageSearchQuery {
    /** Results requested in this page, from 1 through 25. Defaults to 25 */
    readonly limit?: number
    /** One-based provider result page, from 1 through 400. Defaults to 1 and cannot be combined with cursor */
    readonly page?: number
    /** Opaque cursor returned by an earlier search page. Do not derive, reorder or combine it with page */
    readonly cursor?: readonly string[]
    /** Include messages at or below this decimal message ID */
    readonly maxId?: string
    /** Include messages at or above this decimal message ID */
    readonly minId?: string
    /** Text query, from 1 through 1,024 UTF-16 code units */
    readonly content?: string
    /** Multiple text queries, at most 100 values of 1 through 1,024 UTF-16 code units each */
    readonly contents?: readonly string[]
    /** Exact contiguous phrases, at most 10 values of 1 through 1,024 UTF-16 code units each */
    readonly exactPhrases?: readonly string[]
    /** Channel IDs to include, at most 500 */
    readonly channelIds?: readonly string[]
    /** Channel IDs to exclude, at most 500 */
    readonly excludeChannelIds?: readonly string[]
    /** Author classifications to include, at most 20 */
    readonly authorTypes?: readonly MessageSearchAuthorType[]
    /** Author classifications to exclude, at most 20 */
    readonly excludeAuthorTypes?: readonly MessageSearchAuthorType[]
    /** Author IDs to include, at most 100 */
    readonly authorIds?: readonly string[]
    /** Author IDs to exclude, at most 100 */
    readonly excludeAuthorIds?: readonly string[]
    /** Mentioned account IDs to require, at most 100 */
    readonly mentions?: readonly string[]
    /** Mentioned account IDs to exclude, at most 100 */
    readonly excludeMentions?: readonly string[]
    /** Filter by @everyone/@here notification state */
    readonly mentionedEveryone?: boolean
    /** Filter by pin state */
    readonly pinned?: boolean
    /** Content classifications to require, at most 20 */
    readonly has?: readonly MessageSearchContentType[]
    /** Content classifications to exclude, at most 20 */
    readonly excludeHas?: readonly MessageSearchContentType[]
    /** Generated or supplied embed types to require, at most 20 */
    readonly embedTypes?: readonly MessageSearchEmbedType[]
    /** Generated or supplied embed types to exclude, at most 20 */
    readonly excludeEmbedTypes?: readonly MessageSearchEmbedType[]
    /** Embed providers to require, at most 50 values of 1 through 256 UTF-16 code units each */
    readonly embedProviders?: readonly string[]
    /** Embed providers to exclude, at most 50 values of 1 through 256 UTF-16 code units each */
    readonly excludeEmbedProviders?: readonly string[]
    /** Link hostnames to require, at most 100 values of 1 through 255 UTF-16 code units each */
    readonly linkHostnames?: readonly string[]
    /** Link hostnames to exclude, at most 100 values of 1 through 255 UTF-16 code units each */
    readonly excludeLinkHostnames?: readonly string[]
    /** Attachment filenames to require, at most 100 values of 1 through 1,024 UTF-16 code units each */
    readonly attachmentFilenames?: readonly string[]
    /** Attachment filenames to exclude, at most 100 values of 1 through 1,024 UTF-16 code units each */
    readonly excludeAttachmentFilenames?: readonly string[]
    /** Attachment extensions to require, at most 50 values of 1 through 32 UTF-16 code units each */
    readonly attachmentExtensions?: readonly string[]
    /** Attachment extensions to exclude, at most 50 values of 1 through 32 UTF-16 code units each */
    readonly excludeAttachmentExtensions?: readonly string[]
    /** Order by indexed timestamp or relevance. Defaults to timestamp */
    readonly sortBy?: "timestamp" | "relevance"
    /** Result direction. Defaults to descending */
    readonly sortOrder?: "asc" | "desc"
    /** Include results from channels Fluxer classifies as NSFW. Defaults to false */
    readonly includeNsfw?: boolean
}

/** Minimal frozen channel context returned beside indexed messages, never a hydrated channel or cache entry */
export interface MessageSearchChannel {
    /** Decimal channel ID */
    readonly id: string
    /** Decimal guild ID when Fluxer includes one */
    readonly guildId?: string
    /** Channel name when Fluxer includes one */
    readonly name?: string
    /** Numeric Fluxer channel type */
    readonly type: number
}

/** Fluxer accepted a search request but is still building one or more indexes. Issue a later explicit page request to retry */
export interface MessageSearchIndexingPage {
    readonly indexing: true
}

/** Frozen indexed page. Its cursor is opaque and pages can change while the index updates */
export interface MessageSearchResultsPage {
    readonly indexing: false
    /** Indexed message snapshots without cache admission or hydration */
    readonly messages: readonly Message[]
    /** Frozen minimal channel context returned by Fluxer, without recipient or permission data */
    readonly channels: readonly MessageSearchChannel[]
    /** Indexed match count observed for this page, not a stable total */
    readonly total: number
    /** Provider page capacity used for this response */
    readonly hitsPerPage: number
    /** One-based provider page number. It may be ignored after an opaque cursor is supplied */
    readonly page: number
    /** Opaque continuation cursor, omitted when Fluxer supplied no continuation */
    readonly cursor?: readonly string[]
}

/** One explicit outcome from Fluxer's indexed message search */
export type MessageSearchPage = MessageSearchIndexingPage | MessageSearchResultsPage

/** Bounds for lazy indexed-message traversal. Each consumption starts at the first contextual page and follows only provider cursors */
export interface MessageSearchIterationLimits extends PaginationQuery {
    /** Indexed messages requested per page, from 1 through 25 and defaulting to 25 */
    readonly pageSize?: number
}

/** Per-call indexed-message search deadline */
export interface MessageSearchOptions extends MessageOperationOptions {}

/** Default cancellation affects only this explicit page request or iterator pull */
export interface DefaultMessageSearchOptions extends MessageSearchOptions, OperationOptions {}
