import type { ReactionEmoji, ReactionEmojiInput, ReactionTarget, ReactionUser, ReactionUsersPage } from "#sdk/reactions"
import { identifier, record } from "./message.js"

export function encodeReactionUsersQuery(query: unknown) {
    const input = query === undefined ? {} : query
    if (!record(input) || Object.keys(input).some((key) => key !== "limit" && key !== "after")) return undefined
    const limit = input.limit === undefined ? 25 : input.limit
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) return undefined
    if (input.after !== undefined && !identifier(input.after)) return undefined
    const after = input.after as string | undefined
    const params = new URLSearchParams({ limit: String(limit) })
    if (after !== undefined) params.set("after", after)
    return { limit, after, params }
}

export function decodeReactionUsersPage(
    value: unknown,
    query: NonNullable<ReturnType<typeof encodeReactionUsersQuery>>,
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
        if (
            !record(item) ||
            !identifier(item.id) ||
            typeof item.username !== "string" ||
            (item.bot !== undefined && typeof item.bot !== "boolean")
        )
            return undefined
        const id = BigInt(item.id)
        if (previous !== undefined && id <= previous) return undefined
        previous = id
        items.push(Object.freeze({ id: item.id, username: item.username, isBot: item.bot === true }))
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
    !/[\x00-\x20\x7f]/.test(value)

export function encodeReactionEmoji(value: ReactionEmojiInput): string | undefined {
    if (typeof value === "string") return name(value) && !/[%/:<>]/.test(value) ? encodeURIComponent(value) : undefined
    if (!record(value)) return undefined
    const snapshot =
        "guildId" in value && "animated" in value && identifier(value.guildId) && typeof value.animated === "boolean"
    if (Object.keys(value).some((key) => !["name", "id", ...(snapshot ? ["guildId", "animated"] : [])].includes(key)))
        return undefined
    return typeof value.name === "string" && /^[A-Za-z0-9_]{1,32}$/.test(value.name) && identifier(value.id)
        ? encodeURIComponent(`${value.name}:${value.id}`)
        : undefined
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
    return Object.freeze({ ...target, emoji: decoded, userId: value.user_id })
}
