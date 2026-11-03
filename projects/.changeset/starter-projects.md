---
"@neontechspace/fluxerly": patch
---

Projects from `fluxerly init` changed. Existing projects are not changed:

- New projects include a `dev` script, `node --watch --env-file-if-exists=.env bot.js`, or `bot.ts` for the TypeScript and Effect templates. It restarts the bot after each saved change. Each restart stops the running bot as Ctrl+C does, which ends its Fluxer session before the next one starts
- New projects stop a test that never settles. The generated test script runs `node --test --test-timeout=30000 --test-force-exit`, because Node.js has no default test timeout and a timed-out test otherwise keeps the process running. The generated JavaScript and TypeScript tests also check `failures()` before the reply, so a command that throws shows its own error instead of only `SuppressedError`
- The `fluxerly init` command now adds `.env` or `node_modules` to an existing `.gitignore` when a later negation such as `!.env`, `!\.env` or `!*` would re-include it, or when the rule is written with a leading space, which Git treats as another pattern. A negation of another path, such as `!.env.example`, adds nothing
- The refresh command in a new project's `AGENTS.md` now uses the project's package manager, such as `pnpm exec fluxerly agents` for a project made with pnpm. A new project has no lockfile yet, so the command follows the package manager that ran `fluxerly init`. It used to be `npx --no fluxerly agents` in every project without a pnpm or Bun lockfile
