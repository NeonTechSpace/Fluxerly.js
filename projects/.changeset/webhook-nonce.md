---
"@neontechspace/fluxerly": minor
---

Webhook message sends, replies and forwards accept an optional `nonce` in both entry points. For five minutes, Fluxer then tries to suppress another send from the same webhook with the same nonce, which helps after a lost response but does not guarantee exactly-once delivery. Webhook sends without a nonce send none, and a forward that sets a nonce both on the message and on its source fails before the request
