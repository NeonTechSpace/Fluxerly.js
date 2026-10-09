import { FluxerlyError, operationDetails } from "./errors.js"
import { operationErrorMessage, operationFailureHint } from "./api-errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"

/** Read a Fluxer list one page at a time through an iterator or Effect Stream. Set item and page limits.
 * Set maxItems to limit the number of delivered items. The SDK requests the next page only after the current one is consumed
 *
 * Each consumption of the iterator or Stream starts independently and copies the inputs then, not at creation
 *
 * Early exit, failure, interruption and client shutdown release that consumption's buffered page and tracking state.
 * Already-delivered items remain with the caller
 *
 * The SDK does not fetch ahead, persist results or remove duplicates across separate consumptions
 *
 * Each page uses its own request deadline. The item and page caps do not provide a total elapsed-time deadline.
 * Changes on Fluxer during traversal can cause the pages to differ from a single complete snapshot
 *
 * @category Options
 */
export interface PaginationQuery {
    /** Maximum items to deliver, a required positive safe integer. Reaching this cap finishes normally, without proving remote exhaustion */
    readonly maxItems: number
    /** Maximum items to request per page, reduced when fewer items remain under maxItems.
     * History defaults to 50 with a range of 1 through 100, members to 100 with 1 through 1,000.
     * Community memberships default to 200 with 1 through 200, reaction users to 25 with 1 through 100.
     * Pins default to 50 with 1 through 50, audit logs to 50 with 1 through 100.
     * Member search defaults to 100 with 1 through 100, message search to 25 with 1 through 25
     */
    readonly pageSize?: number
    /** Maximum page requests, a positive safe integer, default 100.
     * Retrying a request for the same page does not use another page allowance. Duplicate-only pin pages do count.
     * Needing a further page after this allowance fails with PaginationError reason pageLimit, preserving already-delivered items
     */
    readonly maxPages?: number
}

/** Limits and starting point for messages.iterateHistory, reading newest messages first.
 * For newer-than or centered windows, use messages.fetchHistory with after or around instead
 *
 * @category Messages
 */
export interface HistoryIterationQuery extends PaginationQuery {
    /** Start with messages older than this decimal message ID, excluding it. Omit to start with the latest visible messages */
    readonly before?: string
}

/** Limits and starting point for ascending member or reaction-user traversal.
 * Ordering follows user IDs, not join dates or reaction times
 *
 * @category Guilds and members
 */
export interface UserIterationQuery extends PaginationQuery {
    /** Start with decimal user IDs greater than this ID, excluding it. Omit to start from the first page */
    readonly after?: string
}

/**
 * Limits and starting point for guilds.iterate, reading the bot's community memberships in ascending community-ID order
 *
 * @category Guilds and members
 */
export interface GuildIterationQuery extends PaginationQuery {
    /** Start after this decimal community ID, excluding it. Omit for the first page.
     * Repeated results caused by a removed cursor fail with PaginationError reason cursorStalled
     */
    readonly after?: string
    /** Ask Fluxer to include approximate member and presence counts on each page, default false.
     * Counts and permissions can still be omitted. An omitted summary field remains unavailable, not zero
     */
    readonly withCounts?: boolean
}

/** Limits and starting point for messages.iteratePins, reading newest pin times first.
 * Each message ID is delivered at most once per consumption. Its first observed pin wins, even if it is later repinned.
 * Timestamp ties or concurrent changes can prevent complete enumeration.
 * If the next timestamp does not become older, traversal fails with cursorStalled after delivering newly observed IDs from that page
 *
 * @category Messages
 */
export interface PinIterationQuery extends PaginationQuery {
    /** Start with older pin times than this ISO 8601 timestamp with a timezone. Omit to use Fluxer's current-time default */
    readonly before?: string
}

/**
 * Operation name included in a PaginationError or default-API SDK defect to identify the traversal
 *
 * @category Errors
 */
export type PaginationOperation =
    | "iterateHistory"
    | "messages.iterateSearch"
    | "members.iterate"
    | "guilds.iterate"
    | "members.iterateSearch"
    | "iterateReactionUsers"
    | "iteratePins"
    | "auditLogs.iterate"
    | "threads.iterateMembers"

/** What each non-input pagination failure means, for the error message */
const paginationExplanations: Readonly<Record<PaginationError["reason"], string>> = {
    input: "The iteration settings are invalid",
    cursorStalled: "The next page did not move past the previous one, so iteration stopped to avoid repeating items",
    pageLimit: "Reading another page would exceed maxPages",
    indexing: "Fluxer is still building the search index, so iteration stopped without polling",
}

/** Suggested next step for each non-input pagination failure */
const paginationHints: Readonly<Record<Exclude<PaginationError["reason"], "input">, string>> = {
    cursorStalled: "Retry later, because concurrent changes or equal timestamps can repeat a cursor",
    pageLimit: "Raise maxPages, or lower maxItems or raise pageSize so fewer pages are needed",
    indexing: "Retry the search after a short wait",
}

/** Reading multiple pages failed because of invalid settings, a page limit, a stalled cursor or search readiness.
 * Contains no resource IDs, response bodies or accumulated partial result.
 * Items returned before the failure remain available to the application. A remote request failure keeps the underlying page-operation error instead of becoming PaginationError.
 * Default-API cancellation uses CancelledError, while native interruption stays in Effect Cause. Unexpected defects remain separate
 *
 * @category Errors
 */
export class PaginationError extends FluxerlyError {
    /** Literal error tag for identifying PaginationError */
    readonly _tag = "PaginationError"
    /** Frozen local validation detail for reason input, otherwise null */
    readonly inputValidation: InputValidationDetail | null
    /** Traversal that failed. Its presence does not establish that any page request was sent */
    readonly operation: PaginationOperation
    /** Failure category.
     * The reason input means invalid settings, cursorStalled means no cursor progress, and pageLimit means another page would exceed maxPages.
     * The reason indexing means message search is preparing an index and traversal will not poll it
     */
    readonly reason: "input" | "cursorStalled" | "pageLimit" | "indexing"
    /** Identify the failed traversal and its local failure reason.
     * Validation detail is copied and frozen when supplied, otherwise null. Construction does not start or resume traversal
     */
    constructor(options: {
        /** Traversal that failed */
        readonly operation: PaginationOperation
        /** Failure category, as described on the reason field */
        readonly reason: PaginationError["reason"]
        /** Safe local validation detail copied into inputValidation. Defaults to null */
        readonly inputValidation?: InputValidationDetail | null | undefined
        /** Underlying failure retained as the error's cause */
        readonly cause?: unknown
    }) {
        const { operation, reason, inputValidation = null } = options
        super(
            operationErrorMessage({
                subject: "Pagination",
                operation,
                reason,
                outcome: "notDispatched",
                inputExplanation: inputValidation?.explanation ?? paginationExplanations[reason],
            }),
            {
                code: `pagination.${reason}`,
                hint:
                    reason === "input"
                        ? operationFailureHint({ reason, outcome: "notDispatched", inputPath: inputValidation?.path })
                        : paginationHints[reason],
                cause: options.cause,
                details: operationDetails({ operation, reason }),
            },
        )
        this.name = this._tag
        this.inputValidation = freezeInputValidationDetail(inputValidation)
        this.operation = operation
        this.reason = reason
    }
}
