---
"@neontechspace/fluxerly": minor
---

Add the `guildHealthUpdate` event with a frozen `GuildHealthUpdate` payload, `{ guildId, degraded }`, in both entry points. Fluxer sends it when the server hosting a community starts or stops lagging. It does not mean that the bot is disconnected or that the community is unavailable, and the SDK neither reconnects nor clears caches because of it
