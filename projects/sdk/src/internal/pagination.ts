/**
 * Pagination: Default iterators and native streams over existing page operations.
 * Invariant: Traversal keeps the page operations' retries, rate limits and cache rules. Each consumption owns one buffered page
 * and bounded pin deduplication state, released on termination or client closure. The default iterator owns Result conversion,
 * while native streams keep request execution and cleanup in the caller's scope. Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { ClientClosedError } from "#sdk/errors"
import { PaginationError, type PaginationOperation } from "#sdk/pagination"
import type { Message, MessageCore, MessageOperationOptions } from "#sdk/messages"
import type { OperationOptions } from "#sdk/client"
import type { ClientOwner } from "./client.js"
import { encodeHistory, snapshotReference } from "./message.js"
import { fieldsOnce, record } from "./decode/primitives.js"
import { suspendInput } from "./defects.js"
import { memberPage } from "./guilds.js"
import { guildList } from "./guild-lifecycle.js"
import { auditLogPage } from "./audit-logs.js"
import { comparePinTimestamps, encodePinsQuery } from "./pins.js"
import { encodeReactionUsersQuery, resolveReactionEmoji } from "./reactions.js"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"

interface Page<A> {
    readonly items: readonly A[]
    readonly next: string | null
}
interface Settings {
    readonly maxItems: number
    readonly maxPages: number
    readonly pageSize: number
    readonly cursor: string | undefined
    readonly options: MessageOperationOptions
    readonly withCounts?: boolean
}
interface Source<A, E> {
    readonly load: (cursor: string | undefined, limit: number) => Effect.Effect<Page<A>, E>
    readonly identity?: (item: A) => string
    /** Opaque cursor sources provide their own progress relation instead of being coerced into a snowflake or timestamp */
    readonly advances?: (previous: string, next: string) => boolean
}
const positive = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0

/**
 * Validate default iteration options before executing the shared, signal-free request options. The signal is passed in
 * when the caller already read it, so each option field is read once
 */
export function iterationOptions(value: unknown, signal: unknown) {
    if (value === undefined) return { request: {}, signal: undefined }
    if (!record(value)) return inputValidationFailure("options", "type", "Iteration options must be an object")
    const unsupported = unsupportedKeyFailure(value, ["timeoutMs", "signal"], "options", "the iteration options")
    if (unsupported) return unsupported
    const timeoutMs = value.timeoutMs
    return {
        request: timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number },
        signal: signal as OperationOptions["signal"],
    }
}

/** One consumption owns its page and optional pin IDs, not credentials or retained result arrays */
export class Pagination<A, E> {
    #items: (A | undefined)[] = []
    #index = 0
    #seen = new Set<string>()
    #count = 0
    #pages = 0
    #cursor: string | undefined
    #exhausted = false
    #failure: PaginationError | undefined
    #unsubscribe: (() => void) | undefined
    done = false

    constructor(
        private readonly owner: Pick<ClientOwner<MessageCore>, "subscribe" | "state">,
        private readonly operation: PaginationOperation,
        private readonly settings: Settings,
        private readonly source: Source<A, E>,
    ) {
        this.#cursor = settings.cursor
        this.#unsubscribe = owner.subscribe((state) => {
            if (state === "Closing" || state === "Closed") this.#release()
        })
    }

    #release() {
        this.#items.length = 0
        this.#seen.clear()
        this.#unsubscribe?.()
        this.#unsubscribe = undefined
    }

    close = () => {
        this.done = true
        this.#release()
    }

    next: Effect.Effect<A | undefined, E | PaginationError | ClientClosedError> = Effect.gen(
        { self: this },
        function* () {
            if (this.done) return undefined
            while (true) {
                if (this.owner.state === "Closing" || this.owner.state === "Closed")
                    return yield* Effect.fail(new ClientClosedError())
                while (this.#index < this.#items.length) {
                    const item = this.#items[this.#index]!
                    this.#items[this.#index++] = undefined
                    if (this.source.identity) {
                        const id = this.source.identity(item)
                        if (this.#seen.has(id)) continue
                        this.#seen.add(id)
                    }
                    this.#count++
                    if (
                        this.#count === this.settings.maxItems ||
                        (this.#exhausted && this.#index === this.#items.length)
                    )
                        this.close()
                    return item
                }
                this.#items.length = 0
                this.#index = 0
                if (this.#exhausted) {
                    this.close()
                    return undefined
                }
                if (this.#failure) return yield* Effect.fail(this.#failure)
                if (this.#pages === this.settings.maxPages)
                    return yield* Effect.fail(new PaginationError({ operation: this.operation, reason: "pageLimit" }))
                this.#pages++
                const page = yield* this.source.load(
                    this.#cursor,
                    Math.min(this.settings.pageSize, this.settings.maxItems - this.#count),
                )
                this.#items = [...page.items]
                this.#exhausted = page.next === null
                if (page.next !== null && this.#cursor !== undefined) {
                    const advances = this.source.advances
                        ? this.source.advances(this.#cursor, page.next)
                        : this.operation === "iteratePins"
                          ? comparePinTimestamps(page.next, this.#cursor) < 0
                          : this.operation === "iterateHistory" || this.operation === "auditLogs.iterate"
                            ? BigInt(page.next) < BigInt(this.#cursor)
                            : BigInt(page.next) > BigInt(this.#cursor)
                    if (!advances)
                        this.#failure = new PaginationError({ operation: this.operation, reason: "cursorStalled" })
                }
                this.#cursor = page.next ?? undefined
            }
        },
    )
}

function prepare<A, E>(
    owner: Pick<ClientOwner<MessageCore>, "subscribe" | "state">,
    operation: PaginationOperation,
    query: unknown,
    options: unknown,
    cursorKey: "before" | "after",
    defaultSize: number,
    maximumSize: number,
    build: (settings: Settings) => Source<A, E> | InputValidationFailure,
    supportsCounts = false,
): Effect.Effect<Pagination<A, E>, PaginationError> {
    // Only reading and validating the caller query, options and page arguments is marked as application input
    return suspendInput((): Effect.Effect<readonly [Settings, Source<A, E>], PaginationError> => {
        const invalid = (detail: InputValidationFailure) =>
            Effect.fail(new PaginationError({ operation, reason: "input", inputValidation: detail.detail }))
        if (!record(query)) return invalid(inputValidationFailure("query", "type", "Iteration query must be an object"))
        const field = fieldsOnce(query)
        const unsupportedQuery = unsupportedKeyFailure(
            query,
            ["maxItems", "maxPages", "pageSize", cursorKey, ...(supportsCounts ? ["withCounts"] : [])],
            "query",
            "the iteration query",
        )
        if (unsupportedQuery) return invalid(unsupportedQuery)
        const maxItemsInput = field("maxItems"),
            maxPagesInput = field("maxPages"),
            pageSizeInput = field("pageSize")
        const maxItems = maxItemsInput,
            maxPages = maxPagesInput === undefined ? 100 : maxPagesInput,
            pageSize = pageSizeInput === undefined ? defaultSize : pageSizeInput
        if (!positive(maxItems))
            return invalid(
                inputValidationFailure(
                    "query.maxItems",
                    "range",
                    "The limit maxItems is required and must be a positive safe integer",
                ),
            )
        if (!positive(maxPages))
            return invalid(
                inputValidationFailure("query.maxPages", "range", "The limit maxPages must be a positive safe integer"),
            )
        if (!positive(pageSize) || pageSize > maximumSize)
            return invalid(
                inputValidationFailure(
                    "query.pageSize",
                    "range",
                    `The limit pageSize must be an integer from 1 through ${maximumSize.toLocaleString("en-US")}`,
                ),
            )
        const input = options === undefined ? {} : options
        if (!record(input))
            return invalid(inputValidationFailure("options", "type", "Iteration options must be an object"))
        // The native Effect API cancels by interruption, so its options have no signal
        const unsupportedOption = unsupportedKeyFailure(input, ["timeoutMs"], "options", "the iteration options")
        if (unsupportedOption) return invalid(unsupportedOption)
        const timeout = input.timeoutMs
        if (timeout !== undefined && (!positive(timeout) || timeout > 2_147_483_647))
            return invalid(
                inputValidationFailure(
                    "options.timeoutMs",
                    "range",
                    "Iteration timeout must be an integer from 1 through 2,147,483,647 ms",
                ),
            )
        const cursor = field(cursorKey)
        if (cursor !== undefined && typeof cursor !== "string")
            return invalid(
                inputValidationFailure(`query.${cursorKey}`, "type", `Iteration ${cursorKey} cursor must be a string`),
            )
        const withCounts = supportsCounts ? field("withCounts") : undefined
        if (withCounts !== undefined && typeof withCounts !== "boolean")
            return invalid(
                inputValidationFailure("query.withCounts", "type", "The query option withCounts must be a boolean"),
            )
        const settings = {
            maxItems,
            maxPages,
            pageSize,
            cursor,
            options: timeout === undefined ? {} : { timeoutMs: timeout },
            ...(supportsCounts ? { withCounts: withCounts === true } : {}),
        }
        const source = build(settings)
        return source instanceof InputValidationFailure ? invalid(source) : Effect.succeed([settings, source] as const)
    }).pipe(Effect.map(([settings, source]) => new Pagination<A, E>(owner, operation, settings, source)))
}

const cursorQuery = (key: "before" | "after", cursor: string | undefined, limit: number) => ({
    limit,
    ...(cursor === undefined ? {} : { [key]: cursor }),
})

export const historyPagination = <M extends MessageCore = Message>(
    owner: ClientOwner<M>,
    channelId: string,
    query: unknown,
    options?: MessageOperationOptions,
) =>
    prepare(owner, "iterateHistory", query, options, "before", 50, 100, (settings) => {
        const validated = encodeHistory(channelId, cursorQuery("before", settings.cursor, settings.pageSize))
        if (validated instanceof InputValidationFailure) return validated
        return {
            load: (cursor, limit) =>
                owner
                    .fetchHistory(channelId, cursorQuery("before", cursor, limit), settings.options)
                    .pipe(Effect.map((items) => ({ items, next: items.at(-1)?.id ?? null }))),
        }
    })

export const memberPagination = <M extends MessageCore = Message>(
    owner: ClientOwner<M>,
    guildId: string,
    query: unknown,
    options?: MessageOperationOptions,
) =>
    prepare(owner, "members.iterate", query, options, "after", 100, 1000, (settings) => {
        const validated = memberPage(guildId, cursorQuery("after", settings.cursor, settings.pageSize))
        if (validated instanceof InputValidationFailure) return validated
        return {
            load: (cursor, limit) =>
                owner
                    .guild(
                        "members.fetchPage",
                        () => memberPage(guildId, cursorQuery("after", cursor, limit)),
                        settings.options,
                    )
                    .pipe(Effect.map((items) => ({ items, next: items.at(-1)?.userId ?? null }))),
        }
    })

export const guildPagination = <M extends MessageCore = Message>(
    owner: ClientOwner<M>,
    query: unknown,
    options?: MessageOperationOptions,
) =>
    prepare(
        owner,
        "guilds.iterate",
        query,
        options,
        "after",
        200,
        200,
        (settings) => {
            const pageQuery = (cursor: string | undefined, limit: number) => ({
                ...cursorQuery("after", cursor, limit),
                ...(settings.withCounts ? { withCounts: true } : {}),
            })
            const validated = guildList(pageQuery(settings.cursor, settings.pageSize))
            if (validated instanceof InputValidationFailure) return validated
            return {
                load: (cursor, limit) =>
                    owner
                        .guild("guilds.fetchPage", () => guildList(pageQuery(cursor, limit)), settings.options)
                        .pipe(
                            Effect.flatMap((items) =>
                                cursor !== undefined && items.some((guild) => BigInt(guild.id) <= BigInt(cursor))
                                    ? Effect.fail(
                                          new PaginationError({ operation: "guilds.iterate", reason: "cursorStalled" }),
                                      )
                                    : Effect.succeed({ items, next: items.at(-1)?.id ?? null }),
                            ),
                        ),
            }
        },
        true,
    )

export const reactionUserPagination = <M extends MessageCore = Message>(
    owner: ClientOwner<M>,
    target: unknown,
    emoji: unknown,
    query: unknown,
    options?: MessageOperationOptions,
) =>
    prepare(owner, "iterateReactionUsers", query, options, "after", 25, 100, (settings) => {
        const message = snapshotReference(target)
        const selected = resolveReactionEmoji(emoji as import("#sdk/reactions").ReactionEmojiInput)
        if (message === undefined || selected === undefined)
            return inputValidationFailure(
                message === undefined ? "target" : "emoji",
                "format",
                message === undefined
                    ? "Message target requires decimal channelId and message id strings"
                    : "Reaction emoji must be a Unicode emoji string or a valid custom emoji",
            )
        const validated = encodeReactionUsersQuery(cursorQuery("after", settings.cursor, settings.pageSize))
        if (validated instanceof InputValidationFailure) return validated
        return {
            load: (cursor, limit) =>
                owner
                    .fetchReactionUsers(message, selected, cursorQuery("after", cursor, limit), settings.options)
                    .pipe(Effect.map((page) => ({ items: page.items, next: page.nextAfter }))),
        }
    })

export const pinPagination = <M extends MessageCore = Message>(
    owner: ClientOwner<M>,
    channelId: string,
    query: unknown,
    options?: MessageOperationOptions,
) =>
    prepare(owner, "iteratePins", query, options, "before", 50, 50, (settings) => {
        const validated = encodePinsQuery(channelId, cursorQuery("before", settings.cursor, settings.pageSize))
        if (validated instanceof InputValidationFailure) return validated
        return {
            identity: (item: import("#sdk/pins").MessagePin<M>) => item.message.id,
            load: (cursor, limit) =>
                owner
                    .fetchPins(channelId, cursorQuery("before", cursor, limit), settings.options)
                    .pipe(Effect.map((page) => ({ items: page.items, next: page.nextBefore }))),
        }
    })

export const auditLogPagination = <M extends MessageCore = Message>(
    owner: ClientOwner<M>,
    guildId: string,
    query: unknown,
    options?: MessageOperationOptions,
) =>
    suspendInput(() => {
        if (!record(query))
            return Effect.fail(
                new PaginationError({
                    operation: "auditLogs.iterate",
                    reason: "input",
                    inputValidation: inputValidationFailure(
                        "query",
                        "type",
                        "Audit log iteration query must be an object",
                    ).detail,
                }),
            )
        const unsupported = unsupportedKeyFailure(
            query,
            ["maxItems", "maxPages", "pageSize", "before", "userId", "actionType"],
            "query",
            "the audit log iteration query",
        )
        if (unsupported)
            return Effect.fail(
                new PaginationError({
                    operation: "auditLogs.iterate",
                    reason: "input",
                    inputValidation: unsupported.detail,
                }),
            )
        const field = fieldsOnce(query)
        const userId = field("userId")
        const actionType = field("actionType")
        if (userId === undefined && actionType === undefined)
            return Effect.fail(
                new PaginationError({
                    operation: "auditLogs.iterate",
                    reason: "input",
                    inputValidation: inputValidationFailure(
                        "query",
                        "required",
                        "Audit log iteration query must select userId or actionType",
                    ).detail,
                }),
            )
        const bounds: Record<string, unknown> = {}
        for (const key of ["maxItems", "maxPages", "pageSize", "before"]) {
            const value = field(key)
            if (value !== undefined) bounds[key] = value
        }
        const filters = {
            ...(userId === undefined ? {} : { userId: userId as string }),
            ...(actionType === undefined ? {} : { actionType: actionType as number }),
        }
        return prepare(owner, "auditLogs.iterate", bounds, options, "before", 50, 100, (settings) => {
            const pageQuery = (cursor: string | undefined, limit: number) => ({
                ...filters,
                ...cursorQuery("before", cursor, limit),
            })
            const validated = auditLogPage(guildId, pageQuery(settings.cursor, settings.pageSize))
            if (validated instanceof InputValidationFailure) return validated
            return {
                load: (cursor, limit) =>
                    owner
                        .guild(
                            "auditLogs.fetchPage",
                            () => auditLogPage(guildId, pageQuery(cursor, limit)),
                            settings.options,
                        )
                        .pipe(Effect.map((page) => ({ items: page.entries, next: page.entries.at(-1)?.id ?? null }))),
            }
        })
    })

export const paginationStream = <A, E>(create: Effect.Effect<Pagination<A, E>, PaginationError>) =>
    Stream.unwrap(
        Effect.gen(function* () {
            const source = yield* Effect.acquireRelease(create, (source) => Effect.sync(source.close))
            return Stream.unfold(undefined, () =>
                source.next.pipe(Effect.map((item) => (item === undefined ? undefined : ([item, undefined] as const)))),
            )
        }),
    )
