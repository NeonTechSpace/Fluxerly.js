---
"@neontechspace/fluxerly": minor
---

Add `defineBot` to the default and Effect entry points. It returns a bot's `runBot` options without the token unchanged, and keeps the types of command arguments and, in the Effect API, of handler errors and services. A module can then export the options for both `runBot` and `createTestBot`

The starter bot in `examples/starter` now exports its options as `bot` with `defineBot`, answers `!ping` through the `commands` option instead of matching the message text, and starts only when Node.js runs the file. It now also answers `!ping` followed by more text or in other letter cases. The `fluxerly init` command writes these shipped files instead of its own copies, so the generated bot is the one the documentation shows, and its generated test imports `bot`. The repository examples, the quick start, the testing guide and the README use the same shape
