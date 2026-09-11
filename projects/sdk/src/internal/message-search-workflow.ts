import { Effect } from "effect"
import type { MessageOperationOptions } from "#sdk/messages"
import type { MessageSearchContext, MessageSearchIterationLimits, MessageSearchQuery } from "#sdk/message-search"
import { PaginationError } from "#sdk/pagination"
import type { ClientOwner } from "./client.js"
import { encodeMessageSearch } from "./message-search.js"
import { record } from "./message.js"
import { Pagination } from "./pagination.js"
import { InputValidationFailure, inputValidationFailure } from "#sdk/input-validation"

const positive = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0

/** Build one lazy, bounded search traversal. Search indexing remains a terminal caller-visible state, never a hidden poll */
export function searchMessagePagination(
    owner: ClientOwner,
    context: MessageSearchContext,
    filters: Omit<MessageSearchQuery, "limit" | "page" | "cursor">,
    limits: MessageSearchIterationLimits,
    options?: MessageOperationOptions,
) {
    return Effect.suspend(() => {
        const invalid = (failure: InputValidationFailure) =>
            Effect.fail(new PaginationError("messages.iterateSearch", "input", failure.detail))
        if (!record(filters))
            return invalid(inputValidationFailure("filters", "type", "Message search filters must be an object"))
        if ("limit" in filters || "page" in filters || "cursor" in filters)
            return invalid(
                inputValidationFailure(
                    "filters",
                    "allowedFields",
                    "Message search iteration filters cannot contain limit, page, or cursor",
                ),
            )
        if (!record(limits))
            return invalid(inputValidationFailure("limits", "type", "Message search limits must be an object"))
        if (Object.keys(limits).some((key) => !["maxItems", "maxPages", "pageSize"].includes(key)))
            return invalid(
                inputValidationFailure(
                    "limits",
                    "allowedFields",
                    "Message search limits may contain only maxItems, maxPages, and pageSize",
                ),
            )
        if (!positive(limits.maxItems))
            return invalid(
                inputValidationFailure("limits.maxItems", "range", "maxItems must be a positive safe integer"),
            )
        if (options !== undefined && !record(options))
            return invalid(inputValidationFailure("options", "type", "Message search options must be an object"))
        if (record(options) && Object.keys(options).some((key) => key !== "timeoutMs"))
            return invalid(
                inputValidationFailure(
                    "options",
                    "allowedFields",
                    "Native message search options may contain only timeoutMs",
                ),
            )
        const pageSize = limits.pageSize === undefined ? 25 : limits.pageSize
        const maxPages = limits.maxPages === undefined ? 100 : limits.maxPages
        if (!positive(pageSize) || pageSize > 25)
            return invalid(
                inputValidationFailure(
                    "limits.pageSize",
                    "range",
                    "pageSize must be a positive safe integer no greater than 25",
                ),
            )
        if (!positive(maxPages))
            return invalid(
                inputValidationFailure("limits.maxPages", "range", "maxPages must be a positive safe integer"),
            )
        if (options?.timeoutMs !== undefined && (!positive(options.timeoutMs) || options.timeoutMs > 2_147_483_647))
            return invalid(
                inputValidationFailure(
                    "options.timeoutMs",
                    "range",
                    "Message search timeout must be a positive safe integer no greater than 2,147,483,647",
                ),
            )
        const validated = encodeMessageSearch(context, { ...filters, limit: pageSize, page: 1 })
        if (validated instanceof InputValidationFailure) return invalid(validated)
        const copiedContext = JSON.parse(JSON.stringify(context)) as MessageSearchContext
        const copiedFilters = JSON.parse(JSON.stringify(filters)) as Omit<
            MessageSearchQuery,
            "limit" | "page" | "cursor"
        >
        const requestOptions = options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }
        return Effect.succeed(
            new Pagination(
                owner,
                "messages.iterateSearch",
                {
                    maxItems: limits.maxItems,
                    maxPages,
                    pageSize,
                    cursor: undefined,
                    options: requestOptions,
                },
                {
                    identity: (message: import("#sdk/messages").Message) => message.id,
                    advances: (previous, next) => previous !== next,
                    load: (cursor, limit) =>
                        Effect.gen(function* () {
                            let pageCursor: readonly string[] | undefined
                            if (cursor !== undefined) {
                                try {
                                    const decoded: unknown = JSON.parse(cursor)
                                    if (!Array.isArray(decoded) || !decoded.every((item) => typeof item === "string"))
                                        return yield* Effect.fail(
                                            new PaginationError("messages.iterateSearch", "cursorStalled"),
                                        )
                                    pageCursor = decoded
                                } catch {
                                    return yield* Effect.fail(
                                        new PaginationError("messages.iterateSearch", "cursorStalled"),
                                    )
                                }
                            }
                            const page = yield* owner.searchMessages(
                                copiedContext,
                                {
                                    ...copiedFilters,
                                    limit,
                                    ...(pageCursor === undefined ? { page: 1 } : { cursor: pageCursor }),
                                },
                                requestOptions,
                            )
                            if (page.indexing)
                                return yield* Effect.fail(new PaginationError("messages.iterateSearch", "indexing"))
                            return {
                                items: page.messages,
                                next: page.cursor === undefined ? null : JSON.stringify(page.cursor),
                            }
                        }),
                },
            ),
        )
    })
}
