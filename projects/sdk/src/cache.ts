import type { Message, MessageCore } from "./messages.js"

/** Set memory-only cache bounds for a resource category such as users, guilds or channels.
 * Use true or an options object in ClientOptions.cache to enable that category, which is otherwise disabled.
 * The SDK stores frozen resources encountered through supported reads and events, not a complete copy of remote state.
 * Fetches still contact Fluxer, writes still execute, and the SDK does no preload, persistence or background refresh.
 * When capacity is full, the least recently used snapshot is removed first.
 * Expiry, conflicting reads and lost gateway connections can cause misses.
 * Connection gaps clear affected snapshots even after resume and block older requests from refilling them.
 * Shutdown releases the SDK's references, not copies still held by your application
 */
export interface ResourceCacheSettings {
    /** Maximum snapshots kept for this category across the client, as a positive safe integer.
     * Defaults to 1,000, not a limit per guild
     */
    readonly maxEntries?: number
    /** Maximum accounted UTF-8 JSON bytes kept for this category, as a positive safe integer.
     * Defaults to 4,194,304 (4 MiB), separate from the message-cache byte budget.
     * Permission bitfields are counted as decimal strings.
     * Cache keys, runtime overhead and caller-held copies are excluded, so this is not an exact heap or process-memory limit
     */
    readonly maxBytes?: number
    /** How long to keep a snapshot after observation, in nonnegative safe-integer milliseconds.
     * Null or omission disables time expiry, while zero retains nothing.
     * Local lookups do not renew age, and expiry removes SDK references without fetching a replacement.
     * Expiry runs without a lookup and can be delayed by an event-loop stall.
     * Unlike message caching, this setting accepts no duration callback
     */
    readonly maxAgeMs?: number | null
}

/** A message age-policy failure reported without the message, rejected return value or thrown exception */
export interface CachePolicyErrorReport {
    /** threw means the duration callback threw, while invalidReturn means it returned neither null nor a nonnegative safe integer */
    readonly reason: "threw" | "invalidReturn"
}

/**
 * Bound the message snapshots kept for local lookups in either API style.
 * Enable the cache in ClientOptions.cache.messages before using these settings.
 * Eligible fetch, send, reply, edit and history results, plus gateway create and update events, supply snapshots.
 * Entry and byte limits apply across this client, not separately per channel or server.
 * Capacity eviction removes the least recently used snapshot first.
 * An oversized or zero-age replacement removes the older copy without retaining the new one
 *
 * A cache hit is a past observation, not proof of current server state or complete channel history
 *
 * Connection gaps prevent older responses from refilling affected snapshots, even after resume.
 * Conflicting reads or mutations can make a pending response ineligible to insert or renew a snapshot.
 * Such a response removes a different retained copy but may leave an identical one
 *
 * Channel deletion or visibility loss removes that channel's snapshots.
 * Batch deletion evicts selected messages after dispatch even on rejection.
 * These operations also prevent older responses from entering the cache, including some pending reads of unaffected resources
 *
 * A ban that requests message deletion evicts this author's cached messages across guilds because some messages lack guild context.
 * The server deletion job is asynchronous, so later observations do not establish whether the job has finished
 */
export interface MessageCacheSettings<M extends MessageCore = Message> {
    /** Maximum messages kept across this client, as a positive safe integer.
     * Defaults to 1,000, not a separate allowance per channel
     */
    readonly maxEntries?: number
    /** Maximum UTF-8 JSON bytes of retained messages with this client's selected fields, as a positive safe integer.
     * Defaults to 8,388,608 (8 MiB), excluding runtime overhead and caller-held copies rather than measuring exact process memory
     */
    readonly maxBytes?: number
    /**
     * How long to keep each accepted snapshot, in milliseconds, or a synchronous function that chooses that duration.
     * Use a nonnegative safe integer, zero to skip retention, or null to disable age expiry.
     * Omitting this setting also disables age expiry
     *
     * The function receives the frozen message with this client's selected fields and must return a duration or null.
     * A throw, undefined, Promise, thenable or invalid number removes the older copy and reports a policy failure.
     * Message delivery and successful REST results still succeed when the policy fails.
     * The SDK does not await or cancel invalid promises and thenables, and does not report their rejection values
     *
     * Each eligible replacement starts a new age, even when values are unchanged.
     * Local lookups change eviction order but do not renew age.
     * Expiry removes SDK references without a lookup, although event-loop stalls can delay cleanup and garbage collection is not immediate.
     * Capacity limits can remove a snapshot before its age limit
     *
     * Keep the function nonblocking and side-effect-free, since it runs while the SDK accepts an observation.
     * Changing state captured by the function affects later observations only
     *
     * Cache removal is neither persistence management nor secure erasure
     */
    readonly maxAgeMs?: number | null | ((message: M) => number | null)
}

/** Configure the default API's message cache and optionally handle age-policy failures.
 * An options object enables caching with defaults for omitted settings
 */
export interface MessageCacheOptions<M extends MessageCore = Message> extends MessageCacheSettings<M> {
    /**
     * Handle a message duration callback that throws or returns an invalid value.
     * Omission sends safe reports to this client's operational logger instead.
     * The SDK allows one unfinished custom report per client and logs later failures while that report is busy.
     * A reporter failure attempts one safe fallback log without rerunning the duration policy.
     * The SDK does not await a reporter Promise before delivering messages or returning successful REST results.
     * Keep synchronous reporter work nonblocking because it shares the application's event loop.
     * Shutdown does not await or cancel reporter Promises, which remain application-owned.
     * Reports contain no message references
     */
    readonly onError?: (report: CachePolicyErrorReport) => void | Promise<void>
}
