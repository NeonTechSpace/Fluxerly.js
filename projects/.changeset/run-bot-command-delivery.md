---
"@neontechspace/fluxerly": minor
---

The `runBot` `commands` option now accepts the delivery settings of the router's `attach` in both entry points: `concurrency`, `partition`, `overflow`, `maxPendingMessages` and `maxPendingBytes`. They reach the router unchanged and are checked before any client exists, so an invalid value throws `ConfigurationError` in the default API and dies with it in the Effect API. Previously `runBot` passed only `onError`, so its commands always ran eight at a time and dropped the oldest waiting message when 256 were waiting. A command router set to `overflow: "stop"` stops the bot when its queue fills, like a handler. The commands guide shows the settings
