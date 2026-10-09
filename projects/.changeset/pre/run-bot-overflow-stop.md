---
"@neontechspace/fluxerly": major
---

A `runBot` handler set to `overflow: "stop"` whose queue fills now stops the bot in both entry points. The bot previously kept running without that handler, as its API comments said, so the handler's events stopped arriving while the bot looked healthy. The run now fails with `CriticalWorkerStoppedError`, whose `details` hold the `event`, the exceeded `limit`, `messages` or `bytes`, and its `capacity`, and whose `cause` is the subscription's `EventOverflowError`. The overflow itself is still reported to `onError` or logged. A bot that should keep running sets `overflow` to `dropOldest` or `dropNewest`, which are unchanged
