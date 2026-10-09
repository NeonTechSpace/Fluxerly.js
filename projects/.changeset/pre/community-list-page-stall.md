---
"@neontechspace/fluxerly": patch
---

Reading the bot's community list page by page no longer repeats one page when Fluxer returns a page that does not move past the previous one. Automatic sharding now fails at once with a discovery `ConnectionError` that says so, and the supervisor's count for `totalShards: "auto"` reports that error as the cause of its `shardCount` failure. The count previously requested the same full page again until `connection.startupTimeoutMs` passed and then failed with a `ConnectionTimeoutError`. The cache refill after restored sessions now stops at such a page and logs `lifecycle.cacheRefill` at Warn, where it previously requested the same page until the client closed without logging the refill
