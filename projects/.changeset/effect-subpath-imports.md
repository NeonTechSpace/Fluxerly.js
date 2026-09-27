---
"@neontechspace/fluxerly": patch
---

Start faster by importing each Effect module the SDK uses from its own `effect/<Module>` subpath instead of the `effect` package index, which loads every Effect module.
Importing `@neontechspace/fluxerly` now loads 87 Effect modules instead of 203, and `@neontechspace/fluxerly/effect` loads 133
