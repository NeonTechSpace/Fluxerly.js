---
"@neontechspace/fluxerly": minor
---

A shard that resumes a session from the `sharding.sessions` store now refills the enabled community, role and channel caches through REST, because a resumed session receives no community data. Fluxer calls a community a guild. Once every shard is ready, the SDK lists the bot's communities and fetches each one on a resumed shard, one request at a time, so application requests keep the other REST slots and rate limits apply as usual. The refill is logged with code `lifecycle.cacheRefill`, at Info when it succeeds and at Warn when some communities fail or it stops after 10 failures

Set `sharding.refillCaches` to `false` to skip the refill
