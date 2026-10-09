import type { CacheChange, CacheObserverOptions } from "#sdk/cache"
import type { CacheEntriesOptions, CachedResources, CacheKind } from "#sdk/client"
import type { Message, MessageCore } from "#sdk/messages"

/**
 * Stop receiving cache changes from client.cache.onChange.
 * Use `using` to close the observer when the enclosing block ends
 *
 * @category Caching
 */
export interface CacheObserver {
    /** Identifier of this observer, such as cacheChange#3, used in its log records */
    readonly id: string
    /** Stop delivering changes, including changes recorded or waiting but not yet delivered. Listener work already started is not cancelled. Repeated calls do nothing */
    close(): void
    /** Close this observer, as `using` does at the end of a block */
    [Symbol.dispose](): void
}

/**
 * Inspect, clear or remove data already held in this client's caches.
 * These methods do not fetch, refresh or change remote resources
 *
 * @category Caching
 */
export interface ClientCache<M extends MessageCore = Message> {
    /**
     * Return frozen snapshots from one configured cache category, ordered least to most recently used.
     * The limit option defaults to 100 and accepts a positive safe integer from 1 through 1,000. It is read once, so the
     * validated limit is the one applied.
     * Expired entries are released first.
     * Enumeration neither refreshes them nor changes eviction order, while local lookups do promote recency.
     * Unlike diagnostics, the array contains actual cached resource data, and no network request or remote completeness claim is made.
     * It may be partial because cache limits, expiry, conflicts, gateway gaps, clear or shutdown can discard entries.
     * A closed client produces an empty array.
     * Invalid kind or limit is misuse: The default API throws ConfigurationError without exposing the rejected value, and the native API dies with it
     *
     * @remarks
     * Returns the array synchronously and takes no signal. Misuse throws ConfigurationError, and a throwing limit getter
     * throws SdkDefect with code application.defect and the thrown value as its cause
     */
    entries<K extends CacheKind>(kind: K, options?: CacheEntriesOptions): readonly CachedResources<M>[K][]
    /**
     * Release data held by this client's caches without changing which caches are enabled.
     * Pass a kind to release only that category, or omit it to release every category.
     * Objects already returned to the caller, requests and remote resources stay unchanged.
     * Older in-flight reads cannot refill the cleared entries and may skip caching their results, while later reads can cache normally.
     * Existing write-related invalidation remains in effect.
     * Each category that held entries reports one clear change to cache.onChange listeners, and a disabled category is left as is.
     * This runs immediately, takes no signal and can be repeated, including after closure.
     * An invalid kind is misuse: Both APIs throw ConfigurationError without exposing the rejected value
     */
    clear(kind?: CacheKind): void
    /**
     * Remove one entry from a cache category by its key, without fetching, refreshing or changing the remote resource.
     * The key uses the format described on CacheChange: `channelId:messageId` for messages, `guildId:userId` for members,
     * `guildId:id` for roles, emojis and stickers, and the resource ID alone for communities, channels, users and direct messages.
     * Objects already returned to the caller stay unchanged.
     * Reads of this category already in flight cannot restore the removed entry and some may skip caching their other results,
     * while later reads and events can cache it again.
     * A removed entry reports one delete change to cache.onChange listeners, and a missing entry or disabled category is left as is.
     * This runs immediately, takes no signal and can be repeated, including after closure.
     * An invalid kind or key is misuse: Both APIs throw ConfigurationError without exposing the rejected value
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export function forgetMember(client: Client, guildId: string, userId: string) {
     *     client.cache.delete("members", `${guildId}:${userId}`)
     * }
     * ```
     */
    delete(kind: CacheKind, key: string): void
    /**
     * Observe every later change to this client's local caches: Stored or replaced entries, removed entries and whole-category clears.
     * Changes are delivered in the order they were applied, from a microtask after the cache work that produced them, so a listener never runs inside a cache operation and can read or clear the cache itself.
     * Lookups, enumeration and diagnostics are not changes, and a clear is reported only for a category that held at least one entry.
     * No change is recorded while no listener is registered, and a new listener receives no earlier changes or current contents.
     * Delivery has no ordering relative to event handlers, and listener work never changes a cache result, a REST outcome or event delivery.
     * A failing listener is reported as a cache failure to the client-level onError, or logged at Error, and keeps receiving later changes.
     * Client shutdown records its final clears, then closes every observer without waiting for unfinished listener calls.
     * A listener with a free call receives those clears, and changes still waiting for a busy listener are dropped with a cache.changesDropped Warn.
     * Registering after shutdown returns an observer that never receives a change.
     * A listener that is not a function, or invalid options, is misuse: The default API throws ConfigurationError, and the native API dies with it
     *
     * @remarks
     * Returns the observer synchronously.
     * The listener runs once per change. It fails when it throws, rejects, or returns or resolves an Err result.
     * A returned promise is not awaited, so asynchronous listener calls overlap, up to options.concurrency unfinished calls, 256 by default.
     * Later changes then wait in order, up to options.maxPendingChanges, 256 by default, and a change arriving at that limit
     * drops the oldest waiting change with a cache.changesDropped Warn.
     * Waiting changes are discarded when the observer closes.
     * A throwing options getter throws SdkDefect with code application.defect and the thrown value as its cause
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export function cacheChangesExample(client: Client, forget: (key: string) => void) {
     *     return client.cache.onChange((change) => {
     *         if (change.kind === "members" && change.op === "delete" && change.key !== null) forget(change.key)
     *     })
     * }
     * ```
     */
    onChange(listener: (change: CacheChange) => unknown, options?: CacheObserverOptions): CacheObserver
}
