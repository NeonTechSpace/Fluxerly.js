---
"@neontechspace/fluxerly": major
---

Invalid data from the Fluxer gateway, such as a frame that is not JSON, a second HELLO or READY, or a sequence that goes backwards, no longer ends the client at once. The shard logs the failure with `fields.reason` set to `protocol` and reconnects with a new session. Three such failures in a row without a healthy connection between them end the shard with a protocol `ConnectionError` as before. Oversized frames, invalid UTF-8, binary frames and `gateway: { onMalformedDispatch: "terminate" }` still end the shard without retrying

Migration: A single invalid gateway message no longer ends `client.run`, because the shard reconnects. The protocol `ConnectionError` now arrives only after three such failures in a row
