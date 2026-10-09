---
"@neontechspace/fluxerly": minor
---

Events that shutdown or a closed subscription discards are now logged instead of disappearing without a trace. When the client closes, each subscription that still had waiting events logs one `events.discarded` Info record with the count in `fields.discarded`. Closing a subscription with waiting events logs the same record at Debug. A draining shutdown that received events for open subscriptions or collectors logs one `events.refused` Info record with the count in `fields.refused`. All of these events are also counted in the new `diagnostics().counters.eventsDropped.closed` counter. A subscription stopped by `overflow: "stop"` keeps its existing `events.overflow` record
