---
"@neontechspace/fluxerly": patch
---

When `client.shutdown()` cancels a running message or reaction collector callback whose cleanup fails, that failure now reaches the shutdown outcome, as an event handler's cleanup failure already did. It previously appeared only in the collector's own result
