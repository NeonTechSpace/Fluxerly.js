---
"@neontechspace/fluxerly": major
---

Breaking change for code that builds `ShardState` objects by hand, such as test doubles of `client.shards`: The new `sessionEpoch` field is required. Add `sessionEpoch: 0` to such objects. The same applies to code that builds `EventContext` objects by hand, such as tests that call handlers or middleware directly, which must now set `sessionEpoch`, and to code that builds `BotEventContext` objects by hand to call `runBot` handlers directly, which must now set `context`
