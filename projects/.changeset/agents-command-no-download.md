---
"@neontechspace/fluxerly": patch
---

The `AGENTS.md` section that `fluxerly agents` writes now records `npx --no fluxerly agents` or `bunx --no-install fluxerly agents` as its refresh command, and pnpm projects keep `pnpm exec fluxerly agents`. These forms never install a package automatically, because the unscoped `fluxerly` name on npm is not this SDK, so the SDK must already be installed in the project. Run the command again to update an existing section
