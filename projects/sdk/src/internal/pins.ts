import type { ChannelPinsUpdate, MessagePinsPage, MessagePin } from "#sdk/pins"
import { decodeMessage, identifier, record } from "./message.js"

const timestamp = (value: unknown): value is string =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))

export function encodePinsQuery(channel: unknown, query: unknown) {
    const input = query === undefined ? {} : query
    if (!identifier(channel) || !record(input) || Object.keys(input).some((key) => key !== "limit" && key !== "before"))
        return undefined
    const limit = input.limit === undefined ? 50 : input.limit
    if (
        typeof limit !== "number" ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 50 ||
        (input.before !== undefined && !timestamp(input.before))
    )
        return undefined
    const params = new URLSearchParams({ limit: String(limit) })
    if (input.before !== undefined) params.set("before", input.before as string)
    return { limit, params }
}

export function decodePinsPage(
    value: unknown,
    channel: string,
    query: NonNullable<ReturnType<typeof encodePinsQuery>>,
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
