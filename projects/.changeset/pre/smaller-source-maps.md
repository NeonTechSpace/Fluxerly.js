---
"@neontechspace/fluxerly": patch
---

Ship JavaScript source maps that point to the package's `src/` files instead of embedding a second copy of every source file, which reduces the installed size.
Stack traces with `--enable-source-maps`, debuggers and go-to-source still resolve to the original TypeScript
