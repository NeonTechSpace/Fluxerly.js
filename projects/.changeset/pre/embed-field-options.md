---
"@neontechspace/fluxerly": major
---

The `EmbedBuilder.field` method takes its display setting as a named option, following the rule that settings are option objects rather than boolean positionals. The new `EmbedFieldOptions` type describes it

Migration: Replace `field(name, value, true)` with `field(name, value, { inline: true })`, and drop a `false` third argument. A leftover boolean or other non-object third argument throws `ConfigurationError` with a hint naming `{ inline: true }`
