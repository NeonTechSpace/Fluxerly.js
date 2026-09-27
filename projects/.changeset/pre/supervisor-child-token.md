---
"@neontechspace/fluxerly": minor
---

The `token` option of `supervisor.child.run` accepts `string | undefined` in both entry points, as `createClient` and `runBot` do, so `process.env.FLUXER_BOT_TOKEN` can be passed directly. A missing or blank token still fails `child.run` with `ConfigurationError` once the assignment arrives, and the parent then sees that child fail during configuration
