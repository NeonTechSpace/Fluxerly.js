/**
 * Reaction pages: One message whose page changes on ◀ and ▶ clicks, read through one reaction collector.
 * Invariant: Clicks are turned one at a time by the collector's callback, the SDK never removes reactions other than its
 * own arrows and, with removeClicks, the clicker's arrow, and the bot's arrows are removed once listening ends, however
 * it ends. A failure, cancellation or interruption wins over a later cleanup failure.
 * Implements [SDK contracts: Results and failures](/docs/SDK-CONTRACTS.md#results-and-failures)
 */
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import { ConfigurationError } from "#sdk/errors"
import type { EditMessageInput, MessageCore, MessageInput } from "#sdk/messages"
import type { MessageReaction } from "#sdk/reactions"
import type { PageInput, PageTurners, PaginateFailure, PaginateOptions, PaginateResult } from "#sdk/reaction-pages"
import type { ClientOwner } from "./client.js"
import { collectorBudgetMessage } from "./collector.js"
import { record } from "./decode/primitives.js"
import { readInput } from "./defects.js"
import { collectReactions, type ReactionCollector } from "./reaction-collector.js"
import { unsupportedKeyHint } from "./suggest.js"

/** The arrows the bot adds, previous first. Clicks also match the text-presentation forms without U+FE0F */
const arrows = ["◀️", "▶️"] as const

/** Page step for a clicked emoji name: -1 for previous, 1 for next and 0 for anything else */
function step(name: string): -1 | 0 | 1 {
    const plain = name.replace("️", "")
    return plain === "◀" ? -1 : plain === "▶" ? 1 : 0
}

type Page = string | { readonly content?: string; readonly embeds?: readonly unknown[] }

interface Settings {
    readonly pages: readonly Page[]
    readonly users: PageTurners
    readonly idleMs: number
    readonly timeoutMs: number
    readonly removeClicks: boolean
}

const optionKeys = ["users", "idleMs", "timeoutMs", "removeClicks", "signal"]

/** Copy and check the pages once. Page bodies are checked by send and edit, so only their shape is checked here */
function copyPages(pages: unknown): readonly Page[] | ConfigurationError {
    if (!Array.isArray(pages) || pages.length === 0)
        return new ConfigurationError("pages", "Pages must be a nonempty array of strings or page objects")
    const copied: Page[] = []
    for (const page of Array.from(pages as unknown[])) {
        if (typeof page === "string") {
            if (page.length === 0) return new ConfigurationError("pages", "A text page must not be empty")
            copied.push(page)
            continue
        }
        if (!record(page)) return new ConfigurationError("pages", "Each page must be a string or a page object")
        const unsupported = Object.keys(page).find((key) => key !== "content" && key !== "embeds")
        if (unsupported !== undefined)
            return new ConfigurationError("pages", `Unsupported page property ${JSON.stringify(unsupported)}`, {
                hint: unsupportedKeyHint(unsupported, ["content", "embeds"]),
            })
        const { content, embeds } = page
        if (content !== undefined && typeof content !== "string")
            return new ConfigurationError("pages", "Page content must be a string")
        if (embeds !== undefined && !Array.isArray(embeds))
            return new ConfigurationError("pages", "Page embeds must be an array")
        const list = embeds === undefined ? undefined : Object.freeze(Array.from(embeds as unknown[]))
        if (!content && !list?.length)
            return new ConfigurationError("pages", "Each page object needs nonempty content or at least one embed")
        copied.push(
            Object.freeze({
                ...(content === undefined ? {} : { content }),
                ...(list === undefined ? {} : { embeds: list }),
            }),
        )
    }
    return Object.freeze(copied)
}

/** Copy and check pages and options once, before anything is sent */
function settings(pages: unknown, options: unknown): Settings | ConfigurationError {
    const copied = copyPages(pages)
    if (copied instanceof ConfigurationError) return copied
    const input = options === undefined ? {} : options
    if (!record(input)) return new ConfigurationError("paginateOptions", "Page options must be an object")
    const unsupported = Object.keys(input).find((key) => !optionKeys.includes(key))
    if (unsupported !== undefined)
        return new ConfigurationError("paginateOptions", `Unsupported page option ${JSON.stringify(unsupported)}`, {
            hint: unsupportedKeyHint(unsupported, optionKeys),
        })
    const { users, idleMs = 60_000, timeoutMs = 300_000 } = input
    const removeClicks = input.removeClicks ?? false
    if (!milliseconds(idleMs)) return new ConfigurationError("idleMs", collectorBudgetMessage("idleMs"))
    if (!milliseconds(timeoutMs)) return new ConfigurationError("timeoutMs", collectorBudgetMessage("timeoutMs"))
    if (typeof removeClicks !== "boolean")
        return new ConfigurationError("removeClicks", 'The page option "removeClicks" must be true or false')
    let turners: PageTurners
    if (typeof users === "function") turners = users as PageTurners
    else if (
        Array.isArray(users) &&
        users.every((id: unknown) => typeof id === "string" && /^[1-9][0-9]{0,19}$/.test(id))
    )
        turners = Object.freeze([...(users as string[])])
    else
        return new ConfigurationError(
            "users",
            users === undefined
                ? 'The page option "users" is required, as a list of user IDs or a check such as () => true'
                : 'The page option "users" must be a list of decimal user IDs or a function',
        )
    return { pages: copied, users: turners, idleMs, timeoutMs, removeClicks }
}

const milliseconds = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647

const sendInput = (page: Page) => page as MessageInput | string

/** A page change replaces both text and embeds, so nothing from the previous page stays */
const editInput = (page: Page) =>
    (typeof page === "string"
        ? { content: page, embeds: [] }
        : { content: page.content ?? "", embeds: page.embeds ?? [] }) as EditMessageInput

/**
 * Send the first page to a channel, add the arrows and turn pages on clicks until idle, timeout, failure or
 * interruption. Command contexts supply their author as users through askerPageOptions
 */
export function paginate<M extends MessageCore>(
    owner: ClientOwner<M>,
    channelId: string,
    pages: readonly PageInput[],
    options: PaginateOptions | undefined,
): Effect.Effect<PaginateResult<M>, PaginateFailure> {
    return Effect.gen(function* () {
        const config = yield* readInput(() => settings(pages, options))
        if (config instanceof ConfigurationError) return yield* Effect.fail(config)
        const first = yield* owner.send(channelId, sendInput(config.pages[0]!))
        if (config.pages.length === 1) return Object.freeze({ message: first, page: 0, reason: "singlePage" as const })
        return yield* listen(owner, first, config)
    })
}

function listen<M extends MessageCore>(
    owner: ClientOwner<M>,
    first: M,
    config: Settings,
): Effect.Effect<PaginateResult<M>, PaginateFailure> {
    const target = { id: first.id, channelId: first.channelId }
    const botId = first.author.id
    const { pages, users } = config
    let page = 0
    let message = first
    let failure: PaginateFailure | undefined
    let collector: ReactionCollector | undefined
    // The users check is application code, so the collector reports its throws and non-boolean returns as filter failures
    const filter = (reaction: MessageReaction) =>
        reaction.userId !== botId &&
        reaction.emoji.id === undefined &&
        step(reaction.emoji.name) !== 0 &&
        (typeof users === "function" ? users(reaction) : users.includes(reaction.userId))
    // SDK requests fail the pages rather than the collector callback, so they are not reported as application failures
    const turn = (reaction: MessageReaction) =>
        Effect.gen(function* () {
            const next = (page + step(reaction.emoji.name) + pages.length) % pages.length
            message = yield* owner.edit(target, editInput(pages[next]!))
            page = next
            if (config.removeClicks)
                yield* owner.reaction("removeUserReaction", target, reaction.emoji, undefined, reaction.userId)
        }).pipe(
            Effect.catch((error: PaginateFailure) =>
                Effect.sync(() => {
                    failure ??= error
                    collector?.stop()
                }),
            ),
        )
    return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
            const registered = yield* collectReactions(
                owner,
                target,
                {
                    maxReactions: Number.MAX_SAFE_INTEGER,
                    idleMs: config.idleMs,
                    timeoutMs: config.timeoutMs,
                    filter,
                    ...(first.guildId === undefined ? {} : { guildId: first.guildId }),
                },
                false,
                turn,
                !config.removeClicks,
            )
            collector = registered
            const exit = yield* Effect.exit(
                restore(
                    Effect.gen(function* () {
                        for (const arrow of arrows) yield* owner.reaction("addReaction", target, arrow)
                        const ended = yield* Deferred.await(registered.closed)
                        if (failure !== undefined) return yield* Effect.fail(failure)
                        return Object.freeze({ message, page, reason: ended.reason === "idle" ? "idle" : "timeout" })
                    }),
                ),
            )
            registered.stop()
            // Wait for an active page change to finish, so it cannot run after the arrows are gone
            yield* Effect.exit(Deferred.await(registered.closed))
            let removal: PaginateFailure | undefined
            let defects: Cause.Cause<never> = Cause.empty
            for (const arrow of arrows) {
                const removed = yield* Effect.exit(owner.reaction("removeReaction", target, arrow))
                if (Exit.isSuccess(removed)) continue
                const failed = removed.cause.reasons.find((reason) => reason._tag === "Fail")
                if (failed?._tag === "Fail") removal ??= failed.error
                defects = Cause.combine(
                    defects,
                    Cause.fromReasons<never>(removed.cause.reasons.filter((reason) => reason._tag === "Die")),
                )
            }
            if (Exit.isFailure(exit)) return yield* Effect.failCause(Cause.combine(exit.cause, defects))
            if (defects.reasons.length) return yield* Effect.failCause(defects)
            if (removal !== undefined) return yield* Effect.fail(removal)
            return exit.value as PaginateResult<M>
        }),
    )
}

/**
 * Options for a command context's paginate: The users option defaults to the command's author, and a default-API
 * handler signal is combined with any supplied signal. Getters defer each read to the operation, so a throwing caller
 * getter is still marked as application input there, and malformed options pass through to be rejected there
 */
export function askerPageOptions<O extends object>(
    options: O | undefined,
    asker: string,
    signal?: AbortSignal,
): O & { readonly users: PageTurners } {
    if (options === undefined) return { users: [asker], ...(signal === undefined ? {} : { signal }) } as never
    if (typeof options !== "object" || options === null || Array.isArray(options)) return options as never
    let combined: unknown
    const read = (property: string | symbol): unknown => {
        if (property === "users") return Reflect.get(options, "users", options) ?? [asker]
        if (property !== "signal" || signal === undefined) return Reflect.get(options, property, options)
        if (combined !== undefined) return combined
        const own: unknown = Reflect.get(options, "signal", options)
        // An invalid caller signal passes through unchanged, so the operation rejects it with ConfigurationError
        return (combined =
            own === undefined ? signal : own instanceof AbortSignal ? AbortSignal.any([signal, own]) : own)
    }
    const added = signal === undefined ? ["users"] : ["users", "signal"]
    return new Proxy(Object.create(null) as O & { readonly users: PageTurners }, {
        get: (_target, property) => read(property),
        ownKeys: () => [...new Set([...Reflect.ownKeys(options), ...added])],
        getOwnPropertyDescriptor: (_target, property) => {
            if (added.includes(property as string))
                return { value: read(property), enumerable: true, configurable: true, writable: false }
            const descriptor = Reflect.getOwnPropertyDescriptor(options, property)
            return descriptor === undefined ? undefined : { ...descriptor, configurable: true }
        },
    })
}
