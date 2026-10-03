---
"@neontechspace/fluxerly": patch
---

When the SDK plans to resume a gateway session, it now closes the connection with code 4000 instead of 1000, in both entry points. Fluxer ends a session when the client closes with 1000 or 1001, so a reconnect after a missed heartbeat or a restart from a `SessionStore` had to identify again and lost the events sent in between. A final shutdown without a `SessionStore` still closes with 1000
