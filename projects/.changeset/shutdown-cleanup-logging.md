---
"@neontechspace/fluxerly": patch
---

An explicit `client.shutdown()` of a connected client now logs a failed cleanup step, such as a socket close that throws or an event handler or collector callback whose cancellation cleanup fails, at Error in the lifecycle category and counts it in `diagnostics().counters.cleanupFailures`. Its final record previously said the shutdown completed and the counter stayed at 0
