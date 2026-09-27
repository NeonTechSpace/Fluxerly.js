---
"@neontechspace/fluxerly": minor
---

Add `snowflakes.shardFor(guildId, totalShards)`, which returns the shard Fluxer routes a community's events to, and `client.shardIdForGuild(guildId)`, which returns this client's shard for a community or `undefined` when another process owns it. Fluxer calls a community a guild. Both APIs provide them

For an invalid ID, the helper throws `HelperError` with reason `id`, and for a total outside 1 through 16,384 with the new reason `shardCount`. The client method throws `ConfigurationError` for an invalid ID
