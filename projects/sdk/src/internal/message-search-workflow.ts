/**
 * Message search traversal over search pages.
 * Invariant: Traversal uses the existing search operation with bounded work and never polls an index that is still preparing.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import * as Effect from "effect/Effect"
import type { Message, MessageCore, MessageOperationOptions } from "#sdk/messages"
import type { MessageSearchContext, MessageSearchIterationLimits, MessageSearchQuery } from "#sdk/message-search"
import { PaginationError } from "#sdk/pagination"
import type { ClientOwner } from "./client.js"
import { encodeMessageSearch } from "./message-search.js"
import { record } from "./decode/primitives.js"
import { Pagination } from "./pagination.js"
import { suspendInput } from "./defects.js"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"

const positive = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0

/** Build one lazy, bounded search traversal. Search indexing remains a terminal caller-visible state, never a hidden poll */
export function searchMessagePagination<M extends MessageCore = Message>(
    owner: ClientOwner<M>,
    context: MessageSearchContext,
    filters: Omit<MessageSearchQuery, "limit" | "page">,
    limits: MessageSearchIterationLimits,
    options?: MessageOperationOptions,
) {
    // Reading and validating the caller filters, limits and options is marked as application input
    return suspendInput(() => {
        const invalid = (failure: InputValidationFailure) =>
            Effect.fail(
                new PaginationError({
                    operation: "messages.iterateSearch",
                    reason: "input",
                    inputValidation: failure.detail,
                }),
            )
        if (!record(filters))
            return invalid(inputValidationFailure("filters", "type", "Message search filters must be an object"))
        if ("limit" in filters || "page" in filters)
            return invalid(
                inputValidationFailure(
                    "filters",
                    "allowedFields",
                    "Message search iteration filters cannot contain limit or page",
                ),
            )
        if (!record(limits))
            return invalid(inputValidationFailure("limits", "type", "Message search limits must be an object"))
        const unsupportedLimit = unsupportedKeyFailure(
            limits,
            ["maxItems", "maxPages", "pageSize"],
            "limits",
            "the message search limits",
        )
        if (unsupportedLimit) return invalid(unsupportedLimit)
        const maxItems = limits.maxItems
        const pageSizeInput = limits.pageSize
        const maxPagesInput = limits.maxPages
        if (!positive(maxItems))
            return invalid(
                inputValidationFailure(
                    "limits.maxItems",
                    "range",
                    "The limit maxItems is required and must be a positive safe integer",
                ),
            )
        if (options !== undefined && !record(options))
            return invalid(inputValidationFailure("options", "type", "Message search options must be an object"))
        // The native Effect API cancels by interruption, so its options have no signal
        const unsupportedOption = record(options)
            ? unsupportedKeyFailure(options, ["timeoutMs"], "options", "the message search options")
            : undefined
        if (unsupportedOption) return invalid(unsupportedOption)
        const timeoutMs = options?.timeoutMs
        const pageSize = pageSizeInput === undefined ? 25 : pageSizeInput
        const requestedMaxPages = maxPagesInput === undefined ? 100 : maxPagesInput
        if (!positive(pageSize) || pageSize > 25)
            return invalid(
                inputValidationFailure(
                    "limits.pageSize",
                    "range",
                    "The limit pageSize must be an integer from 1 through 25",
                ),
            )
        if (!positive(requestedMaxPages))
            return invalid(
                inputValidationFailure(
                    "limits.maxPages",
                    "range",
                    "The limit maxPages must be a positive safe integer",
                ),
            )
        if (timeoutMs !== undefined && (!positive(timeoutMs) || timeoutMs > 2_147_483_647))
            return invalid(
                inputValidationFailure(
                    "options.timeoutMs",
                    "range",
                    "Message search timeout must be an integer from 1 through 2,147,483,647 ms",
                ),
            )
        const validated = encodeMessageSearch(context, filters)
        if (validated instanceof InputValidationFailure) return invalid(validated)
        const copiedContext = validated.context
        const copiedFilters = validated.query
        const requestOptions = timeoutMs === undefined ? {} : { timeoutMs }
        const requestLimit = Math.min(pageSize, maxItems)
        const maxPages = Math.min(requestedMaxPages, 400)
        return Effect.succeed(
            () =>
                new Pagination(
                    owner,
                    "messages.iterateSearch",
                    {
                        maxItems,
                        maxPages,
                        pageSize,
                        cursor: "1",
                        options: requestOptions,
                    },
                    {
                        identity: (message: M) => message.id,
                        advances: (previous, next) => Number(next) > Number(previous),
                        load: (cursor) =>
                            Effect.gen(function* () {
                                const requestedPage = Number(cursor)
                                if (!Number.isSafeInteger(requestedPage) || requestedPage < 1 || requestedPage > 400)
                                    return yield* Effect.fail(
                                        new PaginationError({
                                            operation: "messages.iterateSearch",
                                            reason: "pageLimit",
                                        }),
                                    )
                                const page = yield* owner.searchMessages(
                                    copiedContext,
                                    {
                                        ...copiedFilters,
                                        limit: requestLimit,
                                        page: requestedPage,
                                    },
                                    requestOptions,
                                )
                                if (page.indexing)
                                    return yield* Effect.fail(
                                        new PaginationError({
                                            operation: "messages.iterateSearch",
                                            reason: "indexing",
                                        }),
                                    )
                                if (page.page !== requestedPage || page.hitsPerPage !== requestLimit)
                                    return yield* Effect.fail(
                                        new PaginationError({
                                            operation: "messages.iterateSearch",
                                            reason: "cursorStalled",
                                        }),
                                    )
                                return {
                                    items: page.messages,
                                    next: page.total > requestedPage * requestLimit ? String(requestedPage + 1) : null,
                                }
                            }),
                    },
                ),
        )
    }).pipe(Effect.map((create) => create()))
}
