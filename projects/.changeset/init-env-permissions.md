---
"@neontechspace/fluxerly": patch
---

The `.env` file that `fluxerly init` creates for the bot token is now readable only by its owner on Linux and macOS, with mode 0600, so other local accounts cannot read the token. An existing `.env` keeps its content and permissions
