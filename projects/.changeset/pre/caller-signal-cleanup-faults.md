---
"@neontechspace/fluxerly": patch
---

A caller AbortSignal whose `addEventListener` throws no longer leaves the `runBot` SIGINT and SIGTERM listeners installed. The `runBot` function now registers the caller signal listener before its process signal listeners and removes it after them
