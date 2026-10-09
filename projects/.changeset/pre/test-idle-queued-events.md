---
"@neontechspace/fluxerly": patch
---

The `idle()` and `say` waits of both testing entry points now also wait for received events whose handler has not started yet. Previously they counted only handlers that were running, so a wait could settle between two invocations while emitted events still waited in a handler's queue, and a test then asserted before its handler ran. This happened mostly with Effect API handlers, which run on the registering caller's scheduler
