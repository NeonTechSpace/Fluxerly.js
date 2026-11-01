---
"@neontechspace/fluxerly": patch
---

Contain accidentally returned Promise and thenable rejections in the default API's Effect logger adapter and in structured logging callbacks, without changing SDK operation outcomes or adding asynchronous delivery or flushing guarantees
