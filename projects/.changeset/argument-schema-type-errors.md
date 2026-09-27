---
"@neontechspace/fluxerly": patch
---

TypeScript now reports a mistake in one argument descriptor of `registerMany` or the keyed `commands` object of `runBot`, such as `{ type: "int" }`, on that descriptor with the list of valid types, and the other commands keep their inferred `values`. Previously the error named the whole schema and every command lost its value types
