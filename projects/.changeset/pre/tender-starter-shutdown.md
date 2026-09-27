---
"@neontechspace/fluxerly": patch
---

Treat runner-initiated client closure as normal when stopping a bot, while preserving run and cleanup failures

Preserve combined native failures and default-API `SdkDefect` reasons when an operation and cleanup both fail
