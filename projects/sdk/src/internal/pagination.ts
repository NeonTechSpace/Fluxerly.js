import { Effect, Stream } from "effect"
import { ClientClosedError } from "#sdk/errors"
import { PaginationError, type PaginationOperation } from "#sdk/pagination"
import type { MessageOperationOptions } from "#sdk/messages"
import type { OperationOptions } from "#sdk/client"
import type { ClientOwner } from "./client.js"
import { encodeHistory, record, reference } from "./message.js"
import { memberPage } from "./guilds.js"
import { auditLogPage } from "./audit-logs.js"
import { encodePinsQuery } from "./pins.js"
import { encodeReactionEmoji, encodeReactionUsersQuery } from "./reactions.js"

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
}
interface Source<A, E> {
    readonly load: (cursor: string | undefined, limit: number) => Effect.Effect<Page<A>, E>
    readonly identity?: (item: A) => string
}
const positive = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0

// Default signal validation happens before executing the shared, signal-free request options
export function iterationOptions(value: unknown) {
    if (value === undefined) return { request: {}, signal: undefined }
    if (!record(value) || Object.keys(value).some((key) => key !== "timeoutMs" && key !== "signal")) return undefined
    const signal = value.signal as OperationOptions["signal"]
    if (
        signal !== undefined &&
        (!signal ||
            typeof signal.aborted !== "boolean" ||
            typeof signal.addEventListener !== "function" ||
            typeof signal.removeEventListener !== "function")
    )
        return undefined
    return { request: { ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs as number }) }, signal }
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
        private readonly owner: ClientOwner,
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
                    return yield* Effect.fail(new PaginationError(this.operation, "pageLimit"))
                this.#pages++
                const page = yield* this.source.load(
                    this.#cursor,
                    Math.min(this.settings.pageSize, this.settings.maxItems - this.#count),
                )
                this.#items = [...page.items]
                this.#exhausted = page.next === null
                if (page.next !== null && this.#cursor !== undefined) {
                    const advances =
                        this.operation === "iteratePins"
                            ? Date.parse(page.next) < Date.parse(this.#cursor)
                            : this.operation === "iterateHistory" || this.operation === "auditLogs.iterate"
                              ? BigInt(page.next) < BigInt(this.#cursor)
                              : BigInt(page.next) > BigInt(this.#cursor)
                    if (!advances) this.#failure = new PaginationError(this.operation, "cursorStalled")
                }
                this.#cursor = page.next ?? undefined
            }
        },
    )
}

function prepare<A, E>(
    owner: ClientOwner,
    operation: PaginationOperation,
    query: unknown,
    options: unknown,
    cursorKey: "before" | "after",
    defaultSize: number,
    maximumSize: number,
    build: (settings: Settings) => Source<A, E> | undefined,
): Effect.Effect<Pagination<A, E>, PaginationError> {
    return Effect.suspend(() => {
        const invalid = () => Effect.fail(new PaginationError(operation, "input"))
        if (
            !record(query) ||
            Object.keys(query).some((key) => !["maxItems", "maxPages", "pageSize", cursorKey].includes(key))
        )
            return invalid()
        const maxItems = query.maxItems,
            maxPages = query.maxPages === undefined ? 100 : query.maxPages,
            pageSize = query.pageSize === undefined ? defaultSize : query.pageSize
        if (!positive(maxItems) || !positive(maxPages) || !positive(pageSize) || pageSize > maximumSize)
            return invalid()
        const input = options === undefined ? {} : options
        if (!record(input) || Object.keys(input).some((key) => key !== "timeoutMs")) return invalid()
        const timeout = input.timeoutMs
        if (timeout !== undefined && (!positive(timeout) || timeout > 2_147_483_647)) return invalid()
        const cursor = query[cursorKey]
        if (cursor !== undefined && typeof cursor !== "string") return invalid()
        const settings = {
            maxItems,
            maxPages,
            pageSize,
            cursor,
            options: timeout === undefined ? {} : { timeoutMs: timeout },
        }
        const source = build(settings)
        return source ? Effect.succeed(new Pagination(owner, operation, settings, source)) : invalid()
    })
}

const cursorQuery = (key: "before" | "after", cursor: string | undefined, limit: number) => ({
    limit,
    ...(cursor === undefined ? {} : { [key]: cursor }),
})

export const historyPagination = (
    owner: ClientOwner,
    channelId: string,
    query: unknown,
    options?: MessageOperationOptions,
) =>
    prepare(owner, "iterateHistory", query, options, "before", 50, 100, (settings) => {
        if (!encodeHistory(channelId, cursorQuery("before", settings.cursor, settings.pageSize))) return undefined
        return {
            load: (cursor, limit) =>
                owner
                    .fetchHistory(channelId, cursorQuery("before", cursor, limit), settings.options)
                    .pipe(Effect.map((items) => ({ items, next: items.at(-1)?.id ?? null }))),
        }
    })

export const memberPagination = (
    owner: ClientOwner,
    guildId: string,
    query: unknown,
    options?: MessageOperationOptions,
) =>
    prepare(owner, "members.iterate", query, options, "after", 100, 1000, (settings) => {
        if (!memberPage(guildId, cursorQuery("after", settings.cursor, settings.pageSize))) return undefined
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

export const reactionUserPagination = (
    owner: ClientOwner,
    target: unknown,
    emoji: unknown,
    query: unknown,
    options?: MessageOperationOptions,
) =>
    prepare(owner, "iterateReactionUsers", query, options, "after", 25, 100, (settings) => {
        if (
            !reference(target) ||
            encodeReactionEmoji(emoji as import("#sdk/reactions").ReactionEmojiInput) === undefined ||
            !encodeReactionUsersQuery(cursorQuery("after", settings.cursor, settings.pageSize))
        )
            return undefined
        const message = { channelId: target.channelId, id: target.id }
        const selected =
            typeof emoji === "string"
                ? emoji
                : { name: (emoji as { name: string }).name, id: (emoji as { id: string }).id }
        return {
            load: (cursor, limit) =>
                owner
                    .fetchReactionUsers(message, selected, cursorQuery("after", cursor, limit), settings.options)
                    .pipe(Effect.map((page) => ({ items: page.items, next: page.nextAfter }))),
        }
    })

export const pinPagination = (
    owner: ClientOwner,
    channelId: string,
    query: unknown,
    options?: MessageOperationOptions,
) =>
    prepare(owner, "iteratePins", query, options, "before", 50, 50, (settings) => {
        if (!encodePinsQuery(channelId, cursorQuery("before", settings.cursor, settings.pageSize))) return undefined
        return {
            identity: (item: import("#sdk/pins").MessagePin) => item.message.id,
            load: (cursor, limit) =>
                owner
                    .fetchPins(channelId, cursorQuery("before", cursor, limit), settings.options)
                    .pipe(Effect.map((page) => ({ items: page.items, next: page.nextBefore }))),
        }
    })

export const auditLogPagination = (
    owner: ClientOwner,
    guildId: string,
    query: unknown,
    options?: MessageOperationOptions,
) =>
    Effect.suspend(() => {
        if (
            !record(query) ||
            Object.keys(query).some(
                (key) => !["maxItems", "maxPages", "pageSize", "before", "userId", "actionType"].includes(key),
            ) ||
            (query.userId === undefined && query.actionType === undefined)
        )
            return Effect.fail(new PaginationError("auditLogs.iterate", "input"))
        const { userId, actionType, ...bounds } = query
        const filters = {
            ...(userId === undefined ? {} : { userId: userId as string }),
            ...(actionType === undefined ? {} : { actionType: actionType as number }),
        }
        return prepare(owner, "auditLogs.iterate", bounds, options, "before", 50, 100, (settings) => {
            const pageQuery = (cursor: string | undefined, limit: number) => ({
                ...filters,
                ...cursorQuery("before", cursor, limit),
            })
            if (!auditLogPage(guildId, pageQuery(settings.cursor, settings.pageSize))) return undefined
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
