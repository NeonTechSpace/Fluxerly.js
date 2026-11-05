# SDK imports

- Prefer native package-private `#` imports for cross-area SDK imports and deep parent traversal, and keep short sibling imports relative with `.js` extensions
- Use the `#sdk/*` mapping in this package's `package.json` `imports`
- Keep default resolution on compiled output and enable `fluxerly-source` only for source-based tooling, not consumer or built-process checks
- Keep alias specifiers unchanged in emitted JavaScript and let Node resolve them through the shipped manifest. TypeScript-only `paths` are not a runtime solution
- Preserve the compiler-only build without adding an alias loader, post-build rewriter or bundler solely for aliases
- When changing the alias mapping, verify source resolution in the build, the test typecheck, Vitest and the documentation generator, then run the [aggregate development check](/docs/REPOSITORY.md#development-checks), including emitted declarations and packed default and native JavaScript and TypeScript consumers. Source tests must exercise current source rather than stale build output

# Feature review

Before adding or expanding a feature, review realistic caller workflows in both APIs, including repeated use, failures, recovery and cleanup

When a change adds or expands a resource API, assess optional caching and record why it's included or deferred in the pull request
