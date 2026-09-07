import type { Message, MessageInput, MessageReference, MessageDeletion, MessageBulkDeletion } from "#sdk/messages"
import { MessageError } from "#sdk/message-errors"

export const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
export const identifier = (value: unknown): value is string =>
    typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)

export function decodeMessage(value: unknown): Message | undefined {
    if (!record(value) || !identifier(value.id) || !identifier(value.channel_id) || typeof value.content !== "string")
        return undefined
    const author = value.author
    if (
        !record(author) ||
        !identifier(author.id) ||
        typeof author.username !== "string" ||
        (author.bot !== undefined && typeof author.bot !== "boolean")
    )
        return undefined
    return Object.freeze({
        id: value.id,
        channelId: value.channel_id,
        content: value.content,
        author: Object.freeze({ id: author.id, username: author.username, isBot: author.bot === true }),
    })
}

export function reference(value: unknown): value is MessageReference {
    return record(value) && identifier(value.id) && identifier(value.channelId)
}

export function encodeHistory(channelId: unknown, query: unknown) {
    if (!identifier(channelId)) return undefined
    const input = query === undefined ? {} : query
    if (!record(input) || Object.keys(input).some((key) => !["limit", "before", "after", "around"].includes(key)))
        return undefined
    const limit = input.limit === undefined ? 50 : input.limit
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) return undefined
    const cursors = ["before", "after", "around"].filter((key) => input[key] !== undefined)
    if (cursors.length > 1) return undefined
    const params = new URLSearchParams({ limit: String(limit) })
    for (const key of cursors) {
        const id = input[key]
        if (!identifier(id)) return undefined
        params.set(key, id)
    }
    return { limit, params }
}

export function decodeDeletion(value: unknown): MessageDeletion | undefined {
    if (!record(value) || !identifier(value.id) || !identifier(value.channel_id)) return undefined
    if ("content" in value && value.content !== null && typeof value.content !== "string") return undefined
    if ("author_id" in value && !identifier(value.author_id)) return undefined
    return Object.freeze({
        id: value.id,
        channelId: value.channel_id,
        ...(value.content === null || typeof value.content === "string" ? { content: value.content } : {}),
        ...(identifier(value.author_id) ? { authorId: value.author_id } : {}),
    })
}

export function decodeBulkDeletion(value: unknown): MessageBulkDeletion | undefined {
    if (!record(value) || !identifier(value.channel_id) || !Array.isArray(value.ids) || !value.ids.every(identifier))
        return undefined
    return Object.freeze({ channelId: value.channel_id, ids: Object.freeze([...value.ids]) })
}

/** Validates only this SDK's text slice; unknown wire response fields are not copied into public snapshots */
export function encodeMessage(channelId: unknown, input: unknown, nonce: string): string | MessageError {
    const invalid = () => new MessageError("input", "notSent")
    if (!identifier(channelId) || !record(input) || typeof input.content !== "string" || input.content.length === 0)
        return invalid()
    if (Object.keys(input).some((key) => !["content", "allowedMentions", "messageReference"].includes(key)))
        return invalid()
    const mentions = encodeAllowedMentions(input.allowedMentions)
    if (!mentions) return invalid()
    const ref = input.messageReference
    if (ref !== undefined && (!reference(ref) || ref.channelId !== channelId)) return invalid()
    return JSON.stringify({
        content: input.content,
        nonce,
        allowed_mentions: mentions,
        ...(ref === undefined ? {} : { message_reference: { message_id: ref.id, channel_id: ref.channelId, type: 0 } }),
    })
}

function encodeAllowedMentions(value: unknown) {
    const mentions = value === undefined ? {} : value
    if (
        !record(mentions) ||
        Object.keys(mentions).some((key) => !["users", "roles", "everyone", "repliedUser"].includes(key))
    )
        return undefined
    for (const key of ["users", "roles"]) {
        const list = mentions[key]
        if (list !== undefined && (!Array.isArray(list) || list.length > 100 || !list.every(identifier)))
            return undefined
    }
    for (const key of ["everyone", "repliedUser"])
        if (mentions[key] !== undefined && typeof mentions[key] !== "boolean") return undefined
    return {
        parse: mentions.everyone === true ? ["everyone"] : [],
        users: mentions.users ?? [],
        roles: mentions.roles ?? [],
        replied_user: mentions.repliedUser ?? false,
    }
}

export function encodeEdit(input: unknown): string | undefined {
    if (!record(input) || typeof input.content !== "string") return undefined
    if (Object.keys(input).some((key) => !["content", "allowedMentions"].includes(key))) return undefined
    const mentions = encodeAllowedMentions(input.allowedMentions)
    return mentions === undefined ? undefined : JSON.stringify({ content: input.content, allowed_mentions: mentions })
}

export function replyInput(target: unknown, input: unknown): MessageInput | MessageError {
    if (!reference(target) || !record(input) || typeof input.content !== "string" || "messageReference" in input)
        return new MessageError("input", "notSent")
    return { ...input, content: input.content, messageReference: target }
}
