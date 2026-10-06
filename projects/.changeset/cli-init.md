---
"@neontechspace/fluxerly": minor
---

Add `fluxerly init`, which writes a JavaScript, TypeScript or Effect starter bot into the current folder. In a terminal it asks which starter to write, with JavaScript as the default. The `--template js|ts|effect` option chooses without asking, and without a terminal or the option it writes the JavaScript starter. An unknown template prints the usage, writes nothing and exits with status 1.
Each starter writes a `package.json` with `start` and `test` scripts that run without a build step, the bot with the starter's `!ping` handler, a test that talks to the bot through `say` from `@neontechspace/fluxerly/testing` or, for Effect, `@neontechspace/fluxerly/effect/testing`, `.env.example`, a `.gitignore` for `.env` and `node_modules`, and the `AGENTS.md` that `fluxerly agents` creates. The TypeScript and Effect starters write `bot.ts` and `bot.test.ts`, which Node.js runs directly, and a strict `tsconfig.json` for editors.
It replaces no file. When any of these files exists, it lists them and writes nothing. It installs no dependencies and prints the install commands for npm, pnpm and Bun, including Effect for the Effect starter and the Node.js types for the TypeScript starters, followed by the test and start commands
