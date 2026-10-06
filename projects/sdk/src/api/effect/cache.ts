import type * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type { CacheChange } from "#sdk/cache"
import type { CacheEntriesOptions, CachedResources, CacheKind } from "#sdk/client"
import type { Message, MessageCore } from "#sdk/messages"

/**
 * Stop receiving cache changes from client.cache.onChange before its registration Scope closes
 *
 * @category Caching
 */
export interface CacheObserver {
    /** Stop delivering changes, including changes already recorded but not yet delivered, and interrupt running listener work without waiting for it. Repeated calls do nothing */
    close(): Effect.Effect<void>
}

/** Inspect, clear or remove entries of this client's optional in-memory caches.
 * These controls do not request fresh data, change remote resources or retain Effect services
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
     * Captures no service or scope.
     * Interruption before execution leaves cache state unchanged, and once started it completes synchronously
     */
    entries<K extends CacheKind>(
        kind: K,
        options?: CacheEntriesOptions,
    ): Effect.Effect<readonly CachedResources<M>[K][]>
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
     * import { Effect } from "effect"
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export function forgetMember(client: Client, guildId: string, userId: string) {
     *     return Effect.sync(() => client.cache.delete("members", `${guildId}:${userId}`))
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
     * Client shutdown delivers the final clears and then closes every observer.
     * Registering after shutdown returns an observer that never receives a change.
     * A listener that is not a function is misuse: The default API throws ConfigurationError, and the native API dies with it
     *
     * @remarks
     * Registration runs when this Effect executes and lasts until observer close, client shutdown or the closing of the executing Scope.
     * Each change starts the listener's Effect in its own fiber with the services available at registration, without awaiting it,
     * so asynchronous listener work can overlap and cannot delay later changes. Synchronous Effects finish before the next change starts.
     * A failed or defective listener Effect is reported with its full Cause. Closing the observer interrupts listener fibers still running
     *
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export function cacheChangesExample(client: Client) {
     *     return client.cache.onChange((change) => Effect.logDebug(`${change.kind} ${change.op}`))
     * }
     * ```
     */
    onChange<E = never, R = never>(
        listener: (change: CacheChange) => Effect.Effect<unknown, E, R>,
    ): Effect.Effect<CacheObserver, never, R | Scope.Scope>
}
