---
"@neontechspace/fluxerly": patch
---

Cache kinds with a `maxAgeMs` expiry now release a replaced or removed snapshot as soon as the cache drops it. Previously the expiry schedule kept such snapshots in memory until their original deadline came up or enough replacements accumulated to rebuild the schedule, so frequently updated entries of every cache kind, from `messages` to `emojis` and `stickers`, could hold more memory than the cache limits suggested
