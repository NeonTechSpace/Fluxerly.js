import type { Message } from "./messages.js"

/** One explicit remote pin page, without automatic traversal */
export interface MessagePinsQuery {
    /** Integer from 1 through 50, default 50 */
    readonly limit?: number
    /** ISO 8601 timestamp with timezone, selecting older pin times. Omission uses the server's current time */
    readonly before?: string
}

/** Frozen message snapshot paired with the server's pin time */
export interface MessagePin {
    /** Message as observed by this request, not a live pin or cache entry */
    readonly message: Message
    /** ISO 8601 pin timestamp, preserved as received */
    readonly pinnedAt: string
}

/** Frozen descending pin-time page. Concurrent changes and timestamp ties prevent snapshot traversal guarantees */
export interface MessagePinsPage {
    /** Frozen entries in server order. The same message may recur on subsequent timestamp pages */
    readonly items: readonly MessagePin[]
    /** Whether the server reports older visible pins */
    readonly hasMore: boolean
    /** Last pin time when hasMore, otherwise null. Pass as before, deduplicate IDs and stop if the cursor makes no progress */
    readonly nextBefore: string | null
}

/** Frozen channel-level notification, not the identity of the pin or a complete pin list */
export interface ChannelPinsUpdate {
    /** Decimal ID of the affected channel */
    readonly channelId: string
    /** Last-pin timestamp supplied by Fluxer, or null. It can remain unchanged after an unpin */
    readonly lastPinTimestamp: string | null
}
