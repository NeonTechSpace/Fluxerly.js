---
"@neontechspace/fluxerly": minor
---

Each category in `client.diagnostics().caches` now keeps running totals since the client was created, in both APIs. The `hits` and `misses` values count local lookups such as `client.messages.get`, including lookups the SDK makes itself, and the `evictions` value counts entries the cache removed on its own, with `capacity` for room within `maxEntries` or `maxBytes` and `expiry` for entries older than `maxAgeMs`. Removal by events, writes, `cache.delete`, clears, connection gaps or shutdown is not counted, and a disabled category reports zero
