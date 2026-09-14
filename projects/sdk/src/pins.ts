import type { Message, MessageCore } from "./messages.js"

/** Choose one page of pins for messages.fetchPins.
 * Pages follow pin times, not message creation times. Use iteratePins for bounded multi-page traversal.
 * Invalid timestamps, limits and unknown properties are rejected before the request
 */
export interface MessagePinsQuery {
    /** Maximum pins requested in this page, an integer from 1 through 50, default 50 */
    readonly limit?: number
    /** Pin-time cursor as an ISO 8601 timestamp with a timezone, such as "2026-01-01T00:00:00Z".
     * Select older pin times. Omit to use Fluxer's current-time default
     */
    readonly before?: string
}

/** One pin observed by a request, pairing a message snapshot with the time it was pinned.
 * Later unpins, repins and message edits do not update this frozen object
 */
export interface MessagePin<M extends MessageCore = Message> {
    /** Message as returned by this page, using the client's messageFields selection */
    readonly message: M
    /** Time Fluxer pinned the message, preserved as an ISO 8601 string with a timezone */
    readonly pinnedAt: string
}

/** One frozen page of pins, ordered newest pin time first.
 * Concurrent changes and tied timestamps can make multi-page enumeration incomplete.
 * A message can recur on later timestamp pages, even though IDs are unique within one page
 */
export interface MessagePinsPage<M extends MessageCore = Message> {
    /** Pins in Fluxer's received order, with no more entries than the requested limit */
    readonly items: readonly MessagePin<M>[]
    /** True when Fluxer reports more visible pins after this page */
    readonly hasMore: boolean
    /** Timestamp to pass as before, using the last pin time when hasMore is true, otherwise null.
     * In a manual loop, deduplicate message IDs and stop if this cursor fails to move to an older time
     */
    readonly nextBefore: string | null
}

/** Notice that a channel's pins changed, without identifying the pinned or unpinned message.
 * Fetch pins explicitly when you need the current list. No automatic fetch follows this event
 */
export interface ChannelPinsUpdate {
    /** Affected channel ID as a decimal string */
    readonly channelId: string
    /** Last-pin time supplied by Fluxer as an ISO 8601 string, or null.
     * This value can stay unchanged after an unpin, so it is not a unique change cursor
     */
    readonly lastPinTimestamp: string | null
}
