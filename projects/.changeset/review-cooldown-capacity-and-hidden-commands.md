---
"@neontechspace/fluxerly": major
---

Command cooldowns no longer turn users away because a memory store is full, and commands can be hidden from help and suggestions, in both entry points

- A memory cooldown store never refuses a new key. When it is full, it removes expired keys first, then the reservation that expires soonest, which lets that key run again early. This applies to `commands.memoryCooldowns()` and to each router's own store
- The default limit rises from 1,024 to 10,000 keys, and the router option `cooldowns: { maxEntries }` sizes a router's own store, for example `commands.create({ prefix: "!", cooldowns: { maxEntries: 50_000 } })`
- Commands and groups accept `hidden: true`. Generated help leaves them out, along with everything inside a hidden group, and selecting a hidden group in `help` throws `ConfigurationError` as for a missing one. Hidden commands still run when invoked, so guard the ones that need it

Migration:

- The `CooldownCapacity` claim and the `CommandCooldownCapacity` rejection are removed, because a built-in store no longer refuses a key. A custom store returns only `CooldownAcquired` or `CooldownActive`, and any other claim fails the command with `ConfigurationError`. Code that handled either removed tag can drop that branch
- Code that relied on the old limit of 1,024 keys, for example to cap memory, passes `maxEntries` to `commands.memoryCooldowns` or the router's `cooldowns` option
- Owner-only and other private commands that must not appear in help set `hidden: true` instead of filtering them in every `help` call's `include`
