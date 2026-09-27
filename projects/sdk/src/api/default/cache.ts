import type { CacheChange } from "#sdk/cache"
import type { CacheEntriesOptions, CachedResources, CacheKind } from "#sdk/client"
import type { Message, MessageCore } from "#sdk/messages"

/**
 * Stop receiving cache changes from client.cache.onChange.
 * Use `using` to close the observer when the enclosing block ends
 *
 * @category Caching
 */
export interface CacheObserver {
    /** Stop delivering changes, including changes already recorded but not yet delivered. Listener work already started is not cancelled. Repeated calls do nothing */
    close(): void
    /** Close this observer, as `using` does at the end of a block */
    [Symbol.dispose](): void
}

/**
 * Inspect or clear data already held in this client's caches.
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
     * Objects already returned to the caller, requests and remote resources stay unchanged.
     * Older in-flight reads cannot refill the cleared entries, while later reads can cache normally.
     * Existing write-related invalidation remains in effect.
     * This runs immediately, takes no signal and can be repeated, including after closure
     */
    clear(): void
    /**
     * Observe every later change to this client's local caches: Stored or replaced entries, removed entries and whole-category clears.
     * Changes are delivered in the order they were applied, from a microtask after the cache work that produced them, so a listener never runs inside a cache operation and can read or clear the cache itself.
     * Lookups, enumeration and diagnostics are not changes, and a clear is reported only for a category that held at least one entry.
     * No change is recorded while no listener is registered, and a new listener receives no earlier changes or current contents.
     * Delivery has no ordering relative to event handlers, and listener work never changes a cache result, a REST outcome or event delivery.
     * A failing listener is reported as a cache failure to the client-level onError, or logged at Error, and keeps receiving later changes.
     * Client shutdown delivers the final clears and then closes every observer.
     * Registering after shutdown returns an observer that never receives a change.
     * A listener that is not a function is misuse: The default API throws ConfigurationError, and the native API dies with it
     *
     * @remarks
     * Returns the observer synchronously.
     * The listener runs once per change. It fails when it throws, rejects, or returns or resolves an Err result.
     * A returned promise is not awaited, so asynchronous listener work can overlap and cannot delay later changes
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
    onChange(listener: (change: CacheChange) => unknown): CacheObserver
}
