---
"@neontechspace/fluxerly": minor
---

Command contexts in both entry points gain `help(options?)`, which builds help pages from the router that matched the command, so a `help` command works in the keyed `commands` object of `runBot` without a reference to the router.
The prefix defaults to the one the invoking message used and the page length to 2,000 UTF-16 code units. The other settings match `router.help`, and the new `CommandContextHelpOptions` type describes them. For example: `help: { execute: ({ help, reply }) => reply(help()[0] ?? "No commands") }`
