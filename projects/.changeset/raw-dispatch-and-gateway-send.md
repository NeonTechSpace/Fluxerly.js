---
"@neontechspace/fluxerly": minor
---

Add the `raw` event, which delivers every gateway dispatch a shard accepts as `{ shardId, t, s, d }`, including `READY`, `RESUMED` and types this SDK version does not decode. The body is Fluxer's unvalidated wire data and is not part of the SDK's compatibility contract. Delivery is logged at Trace with code `events.raw`, and nothing is built while no `raw` subscriber exists. Types listed in `gateway.ignoredEvents` never arrive

Add `client.gateway.send(shardId, op, d)` for gateway commands without an SDK method. It fails with `GatewaySendError` whose `reason` is `input` for invalid arguments or frames above Fluxer's 4,096-byte limit, `reserved` for heartbeat, Identify, Resume and server-only opcodes, `notOwned`, `notReady` or `busy`, and with `ClientClosedError` after shutdown. A throw from a getter or `toJSON` in the command data rejects with `SdkDefect` code `application.defect`, and cycles, BigInt values and overly deep data fail with reason `input`. Completion means the frame was handed to the connection. Each sent command is logged at Debug with code `gateway.commandSent`
