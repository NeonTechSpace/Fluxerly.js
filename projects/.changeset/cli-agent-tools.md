---
"@neontechspace/fluxerly": minor
---

Expand the `fluxerly` CLI for bot setup and coding agents:

- Add `fluxerly doctor` (`--json`) to check Node.js, ESM, TypeScript, Effect, `AGENTS.md` and `.gitignore` offline
- Add `fluxerly invite <applicationId>` (`--permissions`) to build a Fluxer bot installation URL offline
- Add `--target agents|skill|cursor|claude|gemini|all`, `--check` and `--print` to `fluxerly agents`
- Add `--dir <folder>` and `--pm npm|pnpm|bun` to `fluxerly init`, and refresh an existing `AGENTS.md` in place instead of refusing the folder
