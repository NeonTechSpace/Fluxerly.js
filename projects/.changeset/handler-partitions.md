---
"@neontechspace/fluxerly": minor
---

Add the `partition` handler option to `client.on` and `runBot` events, in both entry points, to keep related events in order while unrelated events run side by side.
Events with the same key run one at a time in receive order, and events with different keys run in parallel up to `concurrency`, which defaults to 8 when a partition is set.
The value `"guild"` keys each event by its community, which the API calls a guild, and a direct message by its channel. The value `"channel"` keys each event by its channel, or by its community when it has no channel. A function receives the event and returns its own key.
Waiting events still count toward the queue limits. A partition function that throws or returns a value other than a string or undefined is reported as a failure of that event's handler, which then does not run
