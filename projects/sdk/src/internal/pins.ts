/**
 * Pin pages, pin updates and pin queries.
 * Invariant: Pin times and cursors are preserved as received or supplied, and pages must be in descending pin-time order.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import type { ChannelPinsUpdate, MessagePinsPage, MessagePin } from "#sdk/pins"
import type { MessageCore } from "#sdk/messages"
import type { MessageDecoder } from "./message-fields.js"
import { inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"
import { decodeMessage } from "./message.js"
import { identifier, record } from "./decode/primitives.js"
import { timestamp } from "./decode/timestamp.js"

/** Compare validated pin timestamps by instant, retaining every fractional digit and normalizing timezone offsets */
export function comparePinTimestamps(left: string, right: string): number {
    const fraction = /\.(\d+)/
    const leftFraction = fraction.exec(left)?.[1] ?? ""
    const rightFraction = fraction.exec(right)?.[1] ?? ""
    const seconds = Date.parse(left.replace(fraction, "")) - Date.parse(right.replace(fraction, ""))
    if (seconds !== 0) return seconds
    const length = Math.max(leftFraction.length, rightFraction.length)
    const first = leftFraction.padEnd(length, "0")
    const second = rightFraction.padEnd(length, "0")
    return first < second ? -1 : first > second ? 1 : 0
}

export function encodePinsQuery(channel: unknown, query: unknown) {
    const input = query === undefined ? {} : query
    if (!identifier(channel))
        return inputValidationFailure("channelId", "format", "Channel IDs must be decimal strings")
    if (!record(input)) return inputValidationFailure("query", "type", "Pin query must be an object")
    const unsupported = unsupportedKeyFailure(input, ["limit", "before"], "query", "the pin query")
    if (unsupported) return unsupported
    const limitInput = input.limit
    const before = input.before
    const limit = limitInput === undefined ? 50 : limitInput
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50)
        return inputValidationFailure("query.limit", "range", "Pin limit must be an integer from 1 through 50")
    if (before !== undefined && !timestamp(before))
        return inputValidationFailure(
            "query.before",
            "format",
            "Pin cursor must be an ISO 8601 timestamp with timezone",
        )
    const params = new URLSearchParams({ limit: String(limit) })
    if (before !== undefined) params.set("before", before)
    return { limit, params }
}

export function decodePinsPage(
    value: unknown,
    channel: string,
    query: { readonly limit: number; readonly params: URLSearchParams },
): MessagePinsPage | undefined
export function decodePinsPage<M extends MessageCore>(
    value: unknown,
    channel: string,
    query: { readonly limit: number; readonly params: URLSearchParams },
    decode: MessageDecoder<M>,
): MessagePinsPage<M> | undefined
export function decodePinsPage(
    value: unknown,
    channel: string,
    query: { readonly limit: number; readonly params: URLSearchParams },
    decode: MessageDecoder<MessageCore> = decodeMessage,
): MessagePinsPage<MessageCore> | undefined {
    if (
        !record(value) ||
        !Array.isArray(value.items) ||
        value.items.length > query.limit ||
        typeof value.has_more !== "boolean" ||
        (value.has_more && !value.items.length)
    )
        return undefined
    const items: MessagePin<MessageCore>[] = []
    const ids = new Set<string>()
    const before = query.params.get("before")
    let previous = before
    for (const item of value.items) {
        if (!record(item) || !timestamp(item.pinned_at)) return undefined
        const message = decode(item.message)
        const time = item.pinned_at
        if (
            !message ||
            message.channelId !== channel ||
            (record(item.message) && item.message.pinned === false) ||
            ids.has(message.id) ||
            (previous !== null && comparePinTimestamps(time, previous) > 0)
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
        (value.guild_id !== undefined && !identifier(value.guild_id)) ||
        (value.last_pin_timestamp !== null && !timestamp(value.last_pin_timestamp))
    )
        return undefined
    return Object.freeze({
        channelId: value.channel_id,
        lastPinTimestamp: value.last_pin_timestamp,
        ...(value.guild_id === undefined ? {} : { guildId: value.guild_id as string }),
    })
}
