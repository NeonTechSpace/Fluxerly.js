---
"@neontechspace/fluxerly": minor
---

The default API's `runBot` passes its `setup` callback a second argument, `{ signal }`. The `AbortSignal` aborts when the bot begins stopping for any reason, including a requested stop before its drain, a failure and a stop while setup is still running. Pass it to SDK operations, or clear timers and end other background work started in `setup` when it aborts, so that work ends with the bot. The runner does not track or await such work.
In the default `createTestBot`, the signal aborts when the test bot's shutdown starts

The Effect API's `setup` is unchanged. It already runs in the bot's Scope, so its finalizers run and fibers it forks into that Scope are interrupted when the bot stops
