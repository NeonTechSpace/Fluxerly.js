---
"@neontechspace/fluxerly": patch
---

Contain accidentally returned Promise and thenable rejections in the default API's Effect logger adapter, matching the structured adapter and documented synchronous logging contract without adding asynchronous delivery or flushing guarantees
