import type { Message } from "./messages.js"

/** Safe policy diagnostic, never the rejected value, original exception or message payload */
export interface CachePolicyErrorReport {
    /** The retention function threw or returned something other than null or a nonnegative safe integer */
    readonly reason: "threw" | "invalidReturn"
}

/**
 * Client-wide message retention settings shared by both API styles.
 * Enabled caches observe REST fetch/send/reply/edit/history results and gateway create/update events
 *
 * Both budgets apply globally using least-recently-used eviction, never separately per channel or server.
 * Oversized or zero-age candidates remove a superseded copy without retaining the replacement
 *
 * Responses crossing a gateway gap cannot repopulate the cache, even when the session resumes.
 * An overlapping mutation or observation can invalidate a pending response's cache admission.
 * That response cannot insert or renew age. It evicts a different retained snapshot but may leave an identical one.
 * These guards do not establish a global server revision order or complete channel history
 */
export interface MessageCacheSettings {
    /** Global retained snapshot count, a positive safe integer. Defaults to 1,000, not a per-channel allowance */
    readonly maxEntries?: number
    /** UTF-8 JSON bytes of canonical Message projections, a positive safe integer. Defaults to 8,388,608, not exact heap/RSS */
    readonly maxBytes?: number
    /**
     * Elapsed milliseconds per accepted observation, or a fast synchronous policy receiving its frozen snapshot.
     * Nonnegative safe integers only: Zero skips retention, null or an omitted setting disables age expiry.
     * Returning undefined, a Promise or an invalid number is a policy failure, not unlimited retention
     *
     * Eligible REST/event replacements reset age even if values are unchanged. Local reads only update LRU recency.
     * Expired references are actively removed, but event-loop stalls can delay cleanup and GC is not immediate.
     * A hit never proves current server state. Count/byte eviction can remove entries before their age limit
     *
     * Policy failures remove the superseded copy, report safely and preserve delivery and successful REST results.
     * Changes to application state captured by the function affect subsequent observations only.
     * Keep policy functions side-effect-free and nonblocking. Retention is not persistence or secure erasure
     */
    readonly maxAgeMs?: number | null | ((message: Message) => number | null)
}

/** Optional default message-cache controls. An options object enables caching with defaults for omitted fields */
export interface MessageCacheOptions extends MessageCacheSettings {
    /**
     * Report safe retention-policy failures. Without a hook, the shared operational logger reports them.
     * At most one custom report is outstanding per client. Further failures use the logger while it is busy.
     * Reporter failure attempts one safe fallback log. No policy retry and no delay to message delivery.
     * Reporter promises remain application-owned after shutdown. Reports contain no message references
     */
    readonly onError?: (report: CachePolicyErrorReport) => void | Promise<void>
}
