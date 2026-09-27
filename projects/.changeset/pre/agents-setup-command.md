---
"@neontechspace/fluxerly": minor
---

The package installs a `fluxerly` command. Running `npx fluxerly agents`, `pnpm exec fluxerly agents` or `bunx fluxerly agents` in an application's folder copies the SDK's rules for coding agents into its `AGENTS.md`, which coding agents read automatically, and records the installed SDK version. Running it again replaces only that section, and a broken section marker stops the command without changing the file

The consumer guide at `consumer/AGENTS.md` starts with those rules, includes the starter bot and a Result check, and lists the differences from discord.js. The package's entry points name the guide in their overview
