import type { ChannelPinsUpdate, MessagePinsPage, MessagePin } from "#sdk/pins"
import { inputValidationFailure } from "#sdk/input-validation"
import { decodeMessage, identifier, record } from "./message.js"

const timestamp = (value: unknown): value is string =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))

export function encodePinsQuery(channel: unknown, query: unknown) {
    const input = query === undefined ? {} : query
    if (!identifier(channel))
        return inputValidationFailure("channelId", "format", "Channel IDs must be decimal strings")
    if (!record(input)) return inputValidationFailure("query", "type", "Pin query must be an object")
    if (Object.keys(input).some((key) => key !== "limit" && key !== "before"))
        return inputValidationFailure("query", "allowedFields", "Pin query may contain only limit and before")
    const limit = input.limit === undefined ? 50 : input.limit
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50)
        return inputValidationFailure("query.limit", "range", "Pin limit must be an integer from 1 through 50")
    if (input.before !== undefined && !timestamp(input.before))
        return inputValidationFailure(
            "query.before",
            "format",
            "Pin cursor must be an ISO 8601 timestamp with timezone",
        )
    const params = new URLSearchParams({ limit: String(limit) })
    if (input.before !== undefined) params.set("before", input.before as string)
    return { limit, params }
}

export function decodePinsPage(
    value: unknown,
    channel: string,
    query: { readonly limit: number; readonly params: URLSearchParams },
): MessagePinsPage | undefined {
    if (
        !record(value) ||
        !Array.isArray(value.items) ||
        value.items.length > query.limit ||
        typeof value.has_more !== "boolean" ||
        (value.has_more && !value.items.length)
    )
        return undefined
    const items: MessagePin[] = []
    const ids = new Set<string>()
    const before = query.params.get("before")
    let previous = before === null ? Infinity : Date.parse(before)
    for (const item of value.items) {
        if (!record(item) || !timestamp(item.pinned_at)) return undefined
        const message = decodeMessage(item.message)
        const time = Date.parse(item.pinned_at)
        if (
            !message ||
            message.channelId !== channel ||
            message.pinned === false ||
            ids.has(message.id) ||
            time > previous
        )
            return undefined
        previous = time
        ids.add(message.id)
        items.push(Object.freeze({ message, pinnedAt: item.pinned_at }))
    }
    return Object.freeze({
        items: Object.freeze(items),
        hasMore: value.has_more,
        nextBefore: value.has_more ? items.at(-1)!.pinnedAt : null,
    })
}

export function decodePinsUpdate(value: unknown): ChannelPinsUpdate | undefined {
    if (
        !record(value) ||
        !identifier(value.channel_id) ||
        (value.last_pin_timestamp !== null && !timestamp(value.last_pin_timestamp))
    )
        return undefined
    return Object.freeze({ channelId: value.channel_id, lastPinTimestamp: value.last_pin_timestamp })
}
