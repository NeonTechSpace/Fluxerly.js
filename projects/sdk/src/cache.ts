import type { CacheKind } from "./client.js"
import type { Message, MessageCore } from "./messages.js"

/**
 * One change applied to a client-owned cache, delivered to cache.onChange listeners after it happened.
 * A change describes the SDK's local copy, not a remote create, update or delete, and carries no snapshot:
 * Look the entry up with the matching get method when its value matters
 *
 * The key identifies the entry within its kind, using decimal IDs:
 * Messages use `channelId:messageId`, members use `guildId:userId`, and roles, emojis and stickers use `guildId:id`.
 * Communities, channels, users and direct messages use the resource ID alone. A clear has a null key
 *
 * @example
 * ```ts
 * import type { Client } from "@neontechspace/fluxerly"
 * export function cacheSizeExample(client: Client, record: (kind: string, delta: number) => void) {
 *     return client.cache.onChange((change) => {
 *         if (change.op === "set") record(change.kind, 1)
 *         if (change.op === "delete") record(change.kind, -1)
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
     * The value delete means one entry was removed, including removal by expiry, capacity eviction, an event, a write or a connection gap limited to known communities.
     * The value clear means every entry of this kind was released at once, as by cache.clear(), shutdown, a connection gap of unknown scope
     * or an event or write whose effect cannot be narrowed to single entries.
     * No delete is reported for the entries a clear released
     */
    readonly op: "set" | "delete" | "clear"
    /** Entry key in the format described for this kind, or null for a clear */
    readonly key: string | null
}

/** Set memory-only cache bounds for a resource category such as users, communities (the guilds category) or channels.
 * Use true or an options object in ClientOptions.cache to enable that category, which is otherwise disabled.
 * The SDK keeps frozen copies of resources encountered through supported reads and events, not every remote resource.
 * Fetches still contact Fluxer, writes still execute, and the SDK does no preload, persistence or background refresh.
 * When capacity is full, the least recently used snapshot is removed first.
 * Expired entries, overlapping reads and lost gateway connections can make a lookup miss.
 * A connection gap clears affected users and direct messages even if the session resumes. Community-scoped snapshots stay
 * while the session resumes and are cleared when a new session starts. Responses started before the gap are not stored.
 * Shutdown releases the SDK's copies, not copies still held by the application
 *
 * @category Caching
 */
export interface ResourceCacheSettings {
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
    /** How long to keep a snapshot after observation, in nonnegative safe-integer milliseconds.
     * Null or omission disables time expiry, while zero retains nothing.
     * Local lookups do not renew age, and expiry removes SDK references without fetching a replacement.
     * Expiry runs without a lookup and can be delayed by an event-loop stall.
     * Unlike message caching, this setting accepts no duration callback
     */
    readonly maxAgeMs?: number | null
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
 * Channel deletion or visibility loss removes that channel's snapshots.
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
