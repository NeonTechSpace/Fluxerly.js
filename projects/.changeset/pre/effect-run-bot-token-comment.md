---
"@neontechspace/fluxerly": patch
---

The comment on the Effect API's `BotOptions` no longer calls a missing or blank token misuse that dies with `ConfigurationError`. As `runBot` already behaved and documented, the bot fails with a typed `ConfigurationError` once the other options are valid
