# SDK imports

- Prefer native package-private `#` imports for cross-area SDK imports and deep parent traversal; keep short sibling imports relative with `.js` extensions
- Use the `#sdk/*` mapping in this package's `package.json` `imports`
- Keep default resolution on compiled output and enable `fluxerly-source` only for source-based tooling, not consumer or built-process checks
- Keep alias specifiers unchanged in emitted JavaScript and let Node resolve them through the shipped manifest; TypeScript-only `paths` are not a runtime solution
- Preserve the compiler-only build without adding an alias loader, post-build rewriter or bundler solely for aliases
- Before using an alias, configure and verify source resolution in the build, test typecheck and Vitest; source tests must exercise current source rather than stale build output
- Validate alias changes with the [aggregate development check](/docs/REPOSITORY.md#development-checks), including emitted declarations and packed default/native JavaScript and TypeScript consumers
- Verify that the documentation generator resolves the aliases before claiming compatibility

Import changes remain scoped to the authorized work
