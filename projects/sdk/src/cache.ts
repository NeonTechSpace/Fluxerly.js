import type { Message } from "./messages.js"

/** Optional non-message resource retention, independently bounded across the entire client for each enabled resource.
 * Off by default. True or an options object enables the resource. REST calls and event delivery never require caching.
 * Retains encountered frozen projections, not a complete remote replica. No persistence, preload or background refresh.
 * LRU capacity eviction favors repeated lookups. Expiry, conflicting observations and connection gaps can cause misses.
 * Gaps clear snapshots even after resume. Pre-gap requests cannot repopulate them. Shutdown releases SDK-held references.
 * Reads stay remote and writes are never suppressed by cached state
 */
export interface ResourceCacheSettings {
    /** Retained entries per resource across all guilds, a positive safe integer. Defaults to 1,000 */
    readonly maxEntries?: number
    /** Accounted UTF-8 JSON bytes per resource, a positive safe integer. Defaults to 4,194,304.
     * Permission bitfields are counted as decimal strings. Excludes keys, runtime overhead and caller-held references.
     * This is not an exact heap or process-memory limit. Message-cache budgets remain separate
     */
    readonly maxBytes?: number
    /** Nonnegative safe-integer milliseconds from observation, not last lookup. Null/default disables time expiry.
     * Zero retains nothing. Expiry runs without lookups and never refreshes remotely.
     * Unlike message policies, this setting accepts no callback
     */
    readonly maxAgeMs?: number | null
}

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
 *
 * Channel deletion or visibility loss removes that channel's snapshots and blocks already-started response admission.
 * Other retained channels remain, although their pending responses may also skip cache admission
 *
 * Dispatched batch deletion evicts selected messages even on rejection and blocks already-started response admission.
 * Other retained messages remain, although overlapping or older responses may skip cache admission
 *
 * Banning with message deletion deliberately evicts the author's messages across all guilds, including known unrelated scope, because projections need not carry guild IDs.
 * That server job is asynchronous. Later observations may precede its completion and are not proof a message survived
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
