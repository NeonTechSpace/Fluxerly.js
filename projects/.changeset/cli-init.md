---
"@neontechspace/fluxerly": minor
---

Add `fluxerly init`, which writes a starter bot into the current folder: A `package.json` with `start` and `test` scripts, `bot.js` with the starter's `!ping` handler, `bot.test.js` using `@neontechspace/fluxerly/testing`, `.env.example`, a `.gitignore` for `.env` and `node_modules`, and the `AGENTS.md` that `fluxerly agents` creates.
It replaces no file. When any of these files exists, it lists them and writes nothing. It installs no dependencies and prints the install commands for npm, pnpm and Bun, followed by the test and start commands
