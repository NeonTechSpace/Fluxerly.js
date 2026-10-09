import type { CacheKind } from "./client.js"
import type { Message, MessageCore } from "./messages.js"

/**
 * One change applied to a client-owned cache, delivered to cache.onChange listeners after it happened.
 * A change describes the SDK's local copy, not a remote create, update or delete, and carries no snapshot:
 * Look the entry up with the matching get method when its value matters
 *
 * The key identifies the entry within its kind, using decimal IDs:
 * Messages use `channelId:messageId`, members use `guildId:userId`, and roles, emojis and stickers use `guildId:id`.
 * Communities, channels, users and direct messages use the resource ID alone. A clear has a null key.
 * The cache.delete() method accepts the same keys
 *
 * @example
 * ```ts
 * import type { Client } from "@neontechspace/fluxerly"
 * // A set can replace an entry and a clear releases a whole kind, so track keys rather than counting events
 * export function trackCachedKeys(client: Client, keys: Map<string, Set<string>>) {
 *     return client.cache.onChange((change) => {
 *         const kindKeys = keys.get(change.kind) ?? new Set<string>()
 *         keys.set(change.kind, kindKeys)
 *         if (change.op === "clear") kindKeys.clear()
 *         else if (change.key !== null && change.op === "set") kindKeys.add(change.key)
 *         else if (change.key !== null) kindKeys.delete(change.key)
 *     })
 * }
 * ```
 *
 * @category Caching
 */
export interface CacheChange {
    /** Cache category whose local copy changed */
    readonly kind: CacheKind
    /**
     * What happened to the local copy.
     * The value set means an entry was stored or replaced, even with identical content.
     * The value delete means one entry was removed, including removal by cache.delete(), expiry, capacity eviction, an event, a write or a connection gap limited to known communities.
     * The value clear means every entry of this kind was released at once, as by cache.clear() with or without this kind, shutdown, a connection gap of unknown scope
     * or an event or write whose effect cannot be narrowed to single entries.
     * No delete is reported for the entries a clear released
     */
    readonly op: "set" | "delete" | "clear"
    /** Entry key in the format described for this kind, or null for a clear */
    readonly key: string | null
}

/**
 * Bound the work one cache.onChange listener can hold, so a listener that falls behind or never finishes cannot grow memory without limit.
 * A listener call is unfinished while its returned Promise or Effect is still running. A synchronous listener finishes each
 * call before the next change, so these bounds never delay or drop its changes.
 * Invalid values are misuse: The default API throws ConfigurationError, and the native API dies with it
 *
 * @example
 * ```ts
 * import type { Client } from "@neontechspace/fluxerly"
 * // One call at a time, so asynchronous work sees the changes in the order they were applied
 * export function saveChangesInOrder(client: Client, save: (key: string | null) => Promise<void>) {
 *     return client.cache.onChange((change) => save(change.key), { concurrency: 1, maxPendingChanges: 1_000 })
 * }
 * ```
 *
 * @category Caching
 */
export interface CacheObserverOptions {
    /** Maximum unfinished listener calls, a positive safe integer, default 256.
     * Later changes wait in the order they were applied until a call finishes
     */
    readonly concurrency?: number
    /** Maximum changes waiting for an unfinished call, a positive safe integer, default 256.
     * A change that arrives while this many wait drops the oldest waiting change, logs a cache.changesDropped Warn with the
     * observer's id and how many changes it has dropped, and counts the drop in diagnostics().counters.cacheChangesDropped
     */
    readonly maxPendingChanges?: number
}

/** Set memory-only cache bounds for a resource category such as users, communities (the guilds category) or channels.
 * The type parameter is the category's snapshot type, which a maxAgeMs callback receives.
 * Use true or an options object in ClientOptions.cache to enable that category, which is otherwise disabled.
 * The SDK keeps frozen copies of resources encountered through supported reads and events, not every remote resource.
 * Fetches still contact Fluxer, writes still execute, and the SDK does no persistence or background refresh.
 * It preloads nothing, except that a shard resuming a stored session refills enabled community, role and channel caches
 * through REST unless sharding.refillCaches is false.
 * When capacity is full, the least recently used snapshot is removed first.
 * Expired entries, overlapping reads and lost gateway connections can make a lookup miss.
 * A connection gap clears affected users and direct messages even if the session resumes. Community-scoped snapshots stay
 * while the session resumes and are cleared when a new session starts, except cached threads, which a completed Resume
 * clears. Responses started before the gap are not stored.
 * Shutdown releases the SDK's copies, not copies still held by the application
 *
 * @category Caching
 */
export interface ResourceCacheSettings<T = unknown> {
    /** Maximum snapshots kept for this category across the client, as a positive safe integer.
     * Defaults to 1,000, not a limit per community
     */
    readonly maxEntries?: number
    /** Maximum accounted UTF-8 JSON bytes kept for this category, as a positive safe integer.
     * Defaults to 4,194,304 (4 MiB), separate from the message-cache byte budget.
     * Permission bitfields are counted as decimal strings.
     * Cache keys, runtime overhead and caller-held copies are excluded, so this is not an exact heap or process-memory limit
     */
    readonly maxBytes?: number
    /**
     * How long to keep each accepted snapshot, in milliseconds, or a synchronous function that chooses that duration.
     * Use a nonnegative safe integer, zero to skip retention, or null to disable age expiry.
     * Omitting this setting also disables age expiry
     *
     * The function receives the frozen snapshot and must return a duration or null, so it can cache selectively,
     * for example by returning zero for snapshots of communities or channels the application does not need.
     * A throw, undefined, Promise, thenable or invalid number removes the older copy and reports a cache failure with the thrown value or an explanation.
     * That failure goes to the client-level onError option as a cache FailureReport, or is logged at Error with the thrown value when no hook is set.
     * Event delivery and successful REST results still succeed when the policy fails.
     * The SDK does not await or cancel invalid promises and thenables
     *
     * Each eligible replacement starts a new age, even when values are unchanged.
     * Local lookups do not renew age, and expiry removes SDK references without fetching a replacement.
     * Expiry runs without a lookup and can be delayed by an event-loop stall.
     * Capacity limits can remove a snapshot before its age limit
     *
     * Keep the function nonblocking and side-effect-free, since it runs while the SDK accepts an observation.
     * Changing state captured by the function affects later observations only
     */
    readonly maxAgeMs?: number | null | ((resource: T) => number | null)
}

/**
 * Bound the message snapshots kept for local lookups in either API style.
 * Enable the cache in ClientOptions.cache.messages before using these settings.
 * Eligible fetch, send, reply, edit and history results, plus gateway create and update events, supply snapshots.
 * Entry and byte limits apply across this client, not separately per channel or community.
 * Capacity eviction removes the least recently used snapshot first.
 * An oversized or zero-age replacement removes the older copy without retaining the new one
 *
 * A cache hit is a past observation, not proof of current server state or complete channel history
 *
 * Connection gaps prevent older responses from refilling affected snapshots, even after resume.
 * If a newer read or change overlaps a pending response, that response cannot add or renew a snapshot.
 * It can remove a different saved copy but may leave an identical copy in place
 *
 * Channel deletion or visibility loss removes that channel's snapshots, and a thread deletion its thread's snapshots.
 * Fluxer deletes a text, announcement, forum or media channel's threads with it and sends no thread deletion events,
 * so that deletion also removes the snapshots of every channel in its community, or without community context, that
 * the channel cache does not hold, which without the channel cache means all of them.
 * Batch deletion evicts selected messages after dispatch even on rejection.
 * These operations also stop older responses from entering the cache, including some pending reads of other resources
 *
 * A ban that requests message deletion evicts this author's cached messages across communities because some messages lack community context.
 * The server deletion job is asynchronous, so later observations do not establish whether the job has finished
 *
 * @category Caching
 */
export interface MessageCacheSettings<M extends MessageCore = Message> {
    /** Maximum messages kept across this client, as a positive safe integer.
     * Defaults to 1,000, not a separate allowance per channel
     */
    readonly maxEntries?: number
    /** Maximum UTF-8 JSON bytes of retained messages with this client's selected fields, as a positive safe integer.
     * Defaults to 8,388,608 (8 MiB) and excludes runtime overhead and caller-held copies
     */
    readonly maxBytes?: number
    /**
     * How long to keep each accepted snapshot, in milliseconds, or a synchronous function that chooses that duration.
     * Use a nonnegative safe integer, zero to skip retention, or null to disable age expiry.
     * Omitting this setting also disables age expiry
     *
     * The function receives the frozen message with this client's selected fields and must return a duration or null.
     * A throw, undefined, Promise, thenable or invalid number removes the older copy and reports a cache failure with the thrown value or an explanation.
     * Message delivery and successful REST results still succeed when the policy fails.
     * The SDK does not await or cancel invalid promises and thenables
     *
     * Each eligible replacement starts a new age, even when values are unchanged.
     * Local lookups change eviction order but do not renew age.
     * Expiry removes SDK references without a lookup, although event-loop stalls can delay cleanup and garbage collection is not immediate.
     * Capacity limits can remove a snapshot before its age limit
     *
     * Keep the function nonblocking and side-effect-free, since it runs while the SDK accepts an observation.
     * Changing state captured by the function affects later observations only
     *
     * Removing a cache entry does not delete persistent data or securely erase memory
     */
    readonly maxAgeMs?: number | null | ((message: M) => number | null)
}

/** Configure the message cache in either API. An options object enables caching with defaults for omitted settings.
 * A throwing or invalid maxAgeMs callback is reported to the client-level onError option as a cache FailureReport,
 * or logged at Error with the thrown value when no hook is set
 *
 * @category Caching
 */
export interface MessageCacheOptions<M extends MessageCore = Message> extends MessageCacheSettings<M> {}
