---
"@neontechspace/fluxerly": minor
---

Add `GuildCreate.isNewJoin` to distinguish provider-reported joins from startup and recovery availability snapshots through both APIs. Existing `guildCreate` delivery and `connect()` readiness remain unchanged

Classification requires a bot gateway that supplies Fluxer's availability marker. Legacy instances that omit it for startup snapshots cannot be classified reliably, and a join dispatch may replay during Resume
