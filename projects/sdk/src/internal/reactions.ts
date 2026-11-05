/**
 * Reaction operations, reaction user pages and reaction gateway projections.
 * Invariant: Reaction events never change cached message snapshots.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import type { ReactionEmoji, ReactionEmojiInput, ReactionTarget, ReactionUser, ReactionUsersPage } from "#sdk/reactions"
import { inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"
import { format } from "#sdk/helpers"
import { identifier, inputId, record } from "./decode/primitives.js"
import { rejectCheck } from "./decode/trace.js"
import { decodeDispatchMember } from "./guilds.js"
import { normalizeText } from "./field-text.js"
import { decodeMessageUser } from "./message.js"

export function encodeReactionUsersQuery(query: unknown) {
    const input = query === undefined ? {} : query
    if (!record(input)) return inputValidationFailure("query", "type", "Reaction user query must be an object")
    const unsupported = unsupportedKeyFailure(input, ["limit", "after"], "query", "the reaction user query")
    if (unsupported) return unsupported
    const limitInput = input.limit
    const suppliedAfter = input.after
    const limit = limitInput === undefined ? 25 : limitInput
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100)
        return inputValidationFailure(
            "query.limit",
            "range",
            "Reaction user limit must be an integer from 1 through 100",
        )
    const after = suppliedAfter === undefined ? undefined : inputId(suppliedAfter)
    if (suppliedAfter !== undefined && after === undefined)
        return inputValidationFailure(
            "query.after",
            "format",
            "Reaction user cursor must be a decimal ID string, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    const params = new URLSearchParams({ limit: String(limit) })
    if (after !== undefined) params.set("after", after)
    return { limit, after, params }
}

export function decodeReactionUsersPage(
    value: unknown,
    query: { readonly limit: number; readonly after: string | undefined; readonly params: URLSearchParams },
): ReactionUsersPage | undefined {
    if (
        !record(value) ||
        !Array.isArray(value.items) ||
        value.items.length > query.limit ||
        typeof value.has_more !== "boolean"
    )
        return undefined
    const items: ReactionUser[] = []
    let previous = query.after === undefined ? undefined : BigInt(query.after)
    for (const item of value.items) {
        const user = decodeMessageUser(item)
        if (user === undefined || user === true) return undefined
        const id = BigInt(user.id)
        if (previous !== undefined && id <= previous) return rejectCheck("order")
        previous = id
        items.push(user)
    }
    if (value.has_more) {
        if (items.length === 0 || value.next_after !== items.at(-1)!.id) return undefined
    } else if (value.next_after !== null) return undefined
    return Object.freeze({
        items: Object.freeze(items),
        hasMore: value.has_more,
        nextAfter: value.next_after as string | null,
    })
}

const name = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    value.isWellFormed() &&
    // oxlint-disable-next-line no-control-regex -- rejects control characters and spaces in emoji names
    !/[\x00-\x20\x7f]/.test(value)

// A reaction route reads the emoji path segment as createStringType(1, 64), which removes U+000C and U+202E and trims
// the emoji before its value must hold 1 through 64 UTF-16 code units (packages/schema/src/domains/common/
// CommonParamSchemas.ts:147-149 and packages/schema/src/primitives/SchemaPrimitives.ts:15-22 and 176-182 at 0098958f,
// applied by fluxer_api/src/api/channel/controllers/MessageInteractionController.ts:202-364). Fluxer then stores that
// normalized value as the emoji name (fluxer_api/src/api/channel/services/interaction/MessageReactionService.ts:397-431),
// so the normalized emoji is the request identity and the collector match. Received emoji keep the wider bound
const unicodeName = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined
    const normalized = normalizeText(value)
    return name(normalized) && normalized.length <= 64 && !/[%/:<>]/.test(normalized) ? normalized : undefined
}

export function resolveReactionEmoji(
    value: ReactionEmojiInput,
): string | { readonly name: string; readonly id: string } | undefined {
    if (typeof value === "string") {
        if (!value.startsWith("<")) return unicodeName(value)
        const parsed = format.tryParseCustomEmoji(value)
        if (parsed.isErr()) return undefined
        value = parsed.value
    }
    if (!record(value)) return undefined
    const hasGuildId = "guildId" in value
    const hasAnimated = "animated" in value
    const guildId = hasGuildId ? value.guildId : undefined
    const animated = hasAnimated ? value.animated : undefined
    const snapshot = hasGuildId && hasAnimated && inputId(guildId) !== undefined && typeof animated === "boolean"
    const allowCloning = snapshot ? value.allowCloning : undefined
    const metadata = snapshot && typeof allowCloning === "boolean"
    if (
        Object.keys(value).some(
            (key) =>
                ![
                    "name",
                    "id",
                    "animated",
                    ...(snapshot ? ["guildId", "creatorId"] : []),
                    ...(metadata ? ["allowCloning"] : []),
                ].includes(key),
        )
    )
        return undefined
    const rawId = value.id
    if (animated !== undefined && (typeof animated !== "boolean" || rawId === undefined)) return undefined
    const nameValue = value.name
    if (rawId === undefined) return unicodeName(nameValue)
    // The ID is trimmed as every caller ID is, so the name:id path segment holds the form Fluxer stores
    const id = inputId(rawId)
    return typeof nameValue === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(nameValue) && id !== undefined
        ? { name: nameValue, id }
        : undefined
}

export function encodeReactionEmoji(value: ReactionEmojiInput): string | undefined {
    const emoji = resolveReactionEmoji(value)
    return emoji === undefined
        ? undefined
        : encodeURIComponent(typeof emoji === "string" ? emoji : `${emoji.name}:${emoji.id}`)
}

function emoji(value: unknown): ReactionEmoji | undefined {
    if (!record(value) || !name(value.name)) return undefined
    if (value.id !== undefined && !identifier(value.id)) return undefined
    if (value.animated !== undefined && (typeof value.animated !== "boolean" || value.id === undefined))
        return undefined
    return Object.freeze({
        name: value.name,
        ...(value.id === undefined ? {} : { id: value.id as string }),
        ...(value.animated === undefined ? {} : { animated: value.animated as boolean }),
    })
}

export const reactionEvents = {
    MESSAGE_REACTION_ADD: "messageReactionAdd",
    MESSAGE_REACTION_ADD_MANY: "messageReactionAddMany",
    MESSAGE_REACTION_REMOVE: "messageReactionRemove",
    MESSAGE_REACTION_REMOVE_ALL: "messageReactionRemoveAll",
    MESSAGE_REACTION_REMOVE_EMOJI: "messageReactionRemoveEmoji",
} as const

export function decodeReaction(event: keyof typeof reactionEvents, value: unknown) {
    if (
        !record(value) ||
        !identifier(value.channel_id) ||
        !identifier(value.message_id) ||
        (value.guild_id !== undefined && !identifier(value.guild_id))
    )
        return undefined
    const target: ReactionTarget = {
        id: value.message_id,
        channelId: value.channel_id,
        ...(value.guild_id === undefined ? {} : { guildId: value.guild_id as string }),
    }
    if (event === "MESSAGE_REACTION_REMOVE_ALL") return Object.freeze(target)
    if (event === "MESSAGE_REACTION_ADD_MANY") {
        if (!Array.isArray(value.reactions) || value.reactions.length === 0 || value.reactions.length > 512)
            return undefined
        const reactions = []
        for (const item of value.reactions) {
            if (!record(item) || !identifier(item.user_id)) return undefined
            const decoded = emoji(item.emoji)
            if (!decoded) return undefined
            reactions.push(Object.freeze({ userId: item.user_id, emoji: decoded }))
        }
        return Object.freeze({ ...target, reactions: Object.freeze(reactions) })
    }
    const decoded = emoji(value.emoji)
    if (!decoded) return undefined
    if (event === "MESSAGE_REACTION_REMOVE_EMOJI") return Object.freeze({ ...target, emoji: decoded })
    if (!identifier(value.user_id)) return undefined
    const member = decodeDispatchMember(event, value)
    return Object.freeze({
        ...target,
        emoji: decoded,
        userId: value.user_id,
        ...(member === undefined ? {} : { member }),
    })
}
