---
"@neontechspace/fluxerly": major
---

Skip a known gateway event that fails validation instead of ending the client. The SDK logs `gateway.dispatchRejected` with the event type and failing field path, clears cache entries the event could have changed and counts it.
Set `gateway: { onMalformedDispatch: "terminate" }` to end the shard with a protocol `ConnectionError` instead

Add an `overflow` handler option with `stop`, `dropOldest` and `dropNewest` policies. Every dropped event is logged at Warn and counted in `diagnostics().counters.eventsDropped`.
Handlers registered with `client.on` drop the oldest waiting event by default when their queue is full, as `runBot` handlers and command routers do, and the handler keeps running.
An unknown event name fails with `ConfigurationError` whose hint suggests the closest valid name when one is similar

Migration: A full `client.on` queue no longer ends the subscription. To keep that behavior, where `waitForClose` returns `EventOverflowError`, pass `{ overflow: "stop" }` to `client.on`. The `subscribe` streams, event waits and collectors still end on overflow.
Event handlers passed to `runBot` now run `messageCreate` up to eight at a time and drop the oldest waiting event when their queue is full instead of stopping the bot.
Pass `{ handler, concurrency, overflow, maxPendingMessages, maxPendingBytes, onError }` instead of a function to change this per event. Command routers attached without options, or with undefined settings, also run up to eight commands at a time and drop the oldest waiting message
