---
"@neontechspace/fluxerly": minor
---

Add `client.logging.configure({ level, categories })`, which changes a running client's log level and per-category levels with the same validation as the creation settings. Omitted settings return to their defaults, and the `debug` setting and `FLUXERLY_DEBUG` still apply. The Effect API has the same member, because its clients apply these levels before records reach the Effect logger and the two clients keep the same members. The new `LogLevelSettings` type describes the accepted settings
