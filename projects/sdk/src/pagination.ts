import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"

/** Bounds for one demand-driven remote traversal, not a request to download a complete snapshot.
 * Each consumption starts independently and copies its inputs when consumption begins.
 * No background prefetch, persistence or cross-run deduplication. Existing page methods remain unchanged
 */
export interface PaginationQuery {
    /** Maximum emitted items, a required positive safe integer. Reaching it is normal completion, not remote exhaustion */
    readonly maxItems: number
    /** Maximum items requested per page, reduced to the remaining item allowance.
     * Defaults/ranges match the underlying endpoint: History 50/1–100, members 100/1–1000,
     * reaction users 25/1–100, pins 50/1–50, audit logs 50/1–100 and member search 100/1–100
     */
    readonly pageSize?: number
    /** Maximum logical page requests, a positive safe integer, default 100.
     * Retries within a page use the existing bounded REST policy and do not count as additional pages.
     * Needing another page after this allowance fails with PaginationError pageLimit
     */
    readonly maxPages?: number
}

/** Newest-to-oldest message traversal. Use fetchHistory for after/around windows */
export interface HistoryIterationQuery extends PaginationQuery {
    /** Exclusive decimal message-ID starting cursor. Omission starts with the latest visible messages */
    readonly before?: string
}

/** Ascending user-ID traversal for members or reaction users */
export interface UserIterationQuery extends PaginationQuery {
    /** Exclusive decimal user-ID starting cursor, not a timestamp */
    readonly after?: string
}

/** Ascending guild-ID traversal of the authenticated bot's memberships */
export interface GuildIterationQuery extends PaginationQuery {
    /** Exclusive starting guild ID. A removed cursor that causes repeated results fails with cursorStalled */
    readonly after?: string
    /** Request provider-supplied approximate member and presence counts for every page. Defaults to false.
     * Fluxer can omit requested counts and permissions, so each omitted summary field remains unavailable
     */
    readonly withCounts?: boolean
}

/** Descending pin-time traversal, emitting each message ID at most once per consumption.
 * Timestamp ties and concurrent changes can prevent complete enumeration. A stalled cursor is an error.
 * The first observed pin for an ID wins, even if that message is repinned during traversal
 */
export interface PinIterationQuery extends PaginationQuery {
    /** ISO 8601 timestamp with timezone, selecting older pin times. Omission uses the endpoint default */
    readonly before?: string
}

/** Traversal identified by a pagination failure or a default SDK defect */
export type PaginationOperation =
    | "iterateHistory"
    | "messages.iterateSearch"
    | "members.iterate"
    | "guilds.iterate"
    | "members.iterateSearch"
    | "iterateReactionUsers"
    | "iteratePins"
    | "auditLogs.iterate"

/** Local traversal failure without identifiers, response bodies or partial results.
 * Items already delivered remain caller-owned. Remote failures retain their underlying page-operation error
 */
export class PaginationError extends Error {
    /** Stable failure discriminator */
    readonly _tag = "PaginationError"
    /** Frozen SDK-owned validation facts for local input failures, otherwise null */
    readonly inputValidation: InputValidationDetail | null
    constructor(
        /** The traversal that failed, not proof that a page request was dispatched */
        readonly operation: PaginationOperation,
        /** Invalid input, no forward cursor progress, a further page exceeding maxPages, or a search index not ready */
        readonly reason: "input" | "cursorStalled" | "pageLimit" | "indexing",
        inputValidation: InputValidationDetail | null = null,
    ) {
        super(`Pagination failed (${operation}, ${reason})`)
        this.name = this._tag
        this.inputValidation = freezeInputValidationDetail(inputValidation)
    }
}
