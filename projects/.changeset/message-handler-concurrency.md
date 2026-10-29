---
"@neontechspace/fluxerly": minor
---

`client.on("messageCreate", ...)` handlers now run up to eight messages at a time by default in both the default and Effect APIs, matching `runBot` and the command router. Before, a `createClient` bot ran them one at a time, so one slow message handler stalled every later message, while a `runBot` bot did not. Handlers of other events still run one at a time unless `partition` is set, which also allows eight. Messages can now finish out of order, so a handler that must see them in order passes `{ concurrency: 1 }` for strict order or `{ partition: "channel" }` to keep each channel in order
