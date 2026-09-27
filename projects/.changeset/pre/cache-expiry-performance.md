---
"@neontechspace/fluxerly": patch
---

Expire entries in every cache category through an expiry heap and reschedule the expiry timer only when the next deadline changes, so timed cache writes no longer scan every retained entry
