---
"@neontechspace/fluxerly": minor
---

Add `gateway.ignoredEvents`, `gateway.flags` and `gateway.presence`, sent in each new session's Identify.
The `ignoredEvents` option lists dispatch names Fluxer should not send, or `"auto"` to suppress every type no registered event, enabled cache category or SDK feature needs, computed at each new session. A handler registered after a session started receives suppressed types only from that shard's next new session, and a `raw` subscriber disables automatic suppression.
Setting `flags: { debounceMessageReactions: true }` turns on Fluxer's `DEBOUNCE_MESSAGE_REACTIONS` flag, merging direct-message reaction runs into `messageReactionAddMany`.
The `presence` option sets the initial presence, which Identify carries and the SDK publishes after READY as if `presence.set` had been called before connecting.
An explicit `ignoredEvents` list that names a type the SDK or an enabled cache needs fails client creation with `ConfigurationError`. `GatewayOptions` is a new public type
