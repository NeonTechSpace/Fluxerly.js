---
"@neontechspace/fluxerly": patch
---

The TypeScript and Effect starters from `fluxerly init` now typecheck. Node.js runs a `.ts` file by removing its types without checking them, so a type error in a generated project went unnoticed. Init now installs TypeScript 7, the version the SDK documents as required, together with the Node.js types, adds a `check` script that runs the compiler and prints the command to run it in its next steps, such as `npm run check`, `pnpm run check` or `bun run check`. The JavaScript starter is unchanged
