---
"@neontechspace/fluxerly": minor
---

Add `client.cache.onChange(listener)` to observe changes to the client's local caches as `{ kind, op, key }` records, where `op` is `set`, `delete` or `clear`.
Every cache kind reports stored and replaced entries, removals including expiry and capacity eviction, and whole-kind clears from `cache.clear()`, connection gaps of unknown scope and shutdown.
Keys use decimal IDs, such as `channelId:messageId` for messages and `guildId:userId` for members.
Changes are delivered in applied order after the cache work that produced them, a failing listener is reported as a cache failure, and no change is recorded while no listener is registered
