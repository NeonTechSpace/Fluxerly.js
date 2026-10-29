---
"@neontechspace/fluxerly": patch
---

A native `on`, `messages.collect` or `messages.collectReactions` registered in an already closed scope closes at once again. With Effect 4.0.6 or newer, the subscription or collector stayed open and client shutdown waited for it forever
