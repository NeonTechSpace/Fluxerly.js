# Review guide

Review changes by risk tier after local checks pass. Do not repeat formatting, spelling or lint checks that automated tools already enforce

## Risk tiers

| Tier | Paths | Required depth |
| --- | --- | --- |
| High | `projects/sdk/src/internal/{client*,gateway*,rest*,rate-limits*,supervisor*,masking*,effect-failures*,defects*}.ts`, `.github/workflows/`, `projects/release/` | Failure, cancellation, cleanup, concurrency, credential redaction and deterministic simulation or regression checks |
| Medium | `projects/sdk/src/api/**`, `projects/sdk/src/internal/{messages*,guilds*,channels*,threads*,users*,webhooks*,oauth*,commands*,cache*,binding*}.ts` | Default and Effect API parity, Fluxer server parity at the [pinned commit](/projects/release/upstream/manifest.json) and the [public API documentation gate](/docs/DOCUMENTATION.md#public-api-documentation-completion-gate) |
| Standard | `projects/sdk/tests/**`, `projects/sdk/examples/**`, `projects/web/**`, `docs/**` | Scoped behavior tests, rendered screen checks for website changes and link checks for repository Markdown |

## Bug hunting checklist

1. Dual-API parity: Default and Effect entry points agree on validation, cancellation, interruption, cleanup defect propagation and `readCaller` defect boundaries
2. Credential hygiene: Tokens, authorization headers, cookies and OAuth secrets stay masked in new error details, causes, logs and diagnostics
3. Cache safety: Failed, rejected or non-entity writes cannot poison or overwrite newer cache snapshots
4. Fluxer server parity: Limits, wire shapes and normalization match Fluxer's server code at the pinned commit, including lone surrogates and field rules
5. Natural exit: New timers, intervals, sockets, subscriptions and child processes close cleanly without holding Node.js open
6. Incident to invariant: Every bug fix adds a regression test and checks whether a type state, AST lint rule or property model can ban the whole bug class

## Fresh-context review

1. Run `pnpm verify:changed` from [projects/](/projects/) during work, then run the full relevant checks before opening a pull request
2. Review `git diff main...HEAD` in a clean context against this guide and [SDK contracts](/docs/SDK-CONTRACTS.md)
3. Limit review rounds to three cycles before revisiting the design
