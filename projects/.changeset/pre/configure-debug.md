---
"@neontechspace/fluxerly": minor
---

The `client.logging.configure` method now accepts `debug` in both APIs, so Debug output can be changed while the client runs, including output turned on by `FLUXERLY_DEBUG`. A `debug` value replaces the current Debug categories: `true` for every category, a list for those categories, and `false` or an empty list for none. An omitted `debug` keeps the current categories, while an omitted `level` or `categories` still returns to its default. `LogLevelSettings` gains the `debug` setting
