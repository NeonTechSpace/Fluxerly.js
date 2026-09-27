---
"@neontechspace/fluxerly": major
---

Return a Result or a failing Effect only where a failure can happen at runtime, such as a request, a gateway command, an event wait or a collector's outcome.
Local setup returns its value directly: Creating clients, registering handlers, creating command routers and reading caches.
Misuse of that setup, such as invalid options, a missing token or an unknown event name, throws `ConfigurationError` in the default API and is a defect in the native API, so a misconfigured bot fails at startup instead of returning an easily ignored Err.
An Err returned or resolved by an application callback, including event and command handlers, guards, middleware, collector callbacks, `onError` hooks, state observers and supervisor configuration, is now reported like a throw of its error

The default API exports `orThrow`, which returns a Result's value or throws its error and also accepts a Promise of a Result, and re-exports the `Result` and `ResultAsync` types.
Callback return types accept `unknown`, and handler, collector and supervisor signals are typed as `AbortSignal`.
A missing or blank `token` is accepted by the types as `string | undefined` and throws `ConfigurationError` with a hint that the environment variable holding it is probably unset

Migration:

- Default `createClient(options)`, `createWebhookClient(options)`, `oauth.create(config)` and `supervisor.create(options)` return the client or supervisor directly. Drop `isErr()`, `value` and `_unsafeUnwrap()` handling and catch `ConfigurationError` only where options come from untrusted input
- Native `createClient`, `createWebhookClient`, `oauth.create` and `supervisor.create` no longer fail with `ConfigurationError`. Invalid options become a defect, so handlers for that typed failure can be removed
- Default `client.on(event, handler)` returns the `Subscription`, `client.subscribe(event)` returns the `EventSubscription`, and `messages.collect(...)` and `messages.collectReactions(...)` return the collector directly. A gateway that is not ready or an aborted signal now appears in the collector's `result()` instead of the creation result. Native `on`, `collect` and `collectReactions` no longer fail, and a native `subscribe` stream fails only with `EventOverflowError`
- Cache lookups such as `client.messages.get(reference)` return the cached value or `undefined` directly, and return `undefined` after shutdown instead of `ClientClosedError`. A malformed ID throws the namespace's operation error with reason `input` in the default API and is a defect in the native API. Native lookups otherwise return an Effect that never fails
- The default `client.cache.entries(kind)` returns the array directly, and native `cache.entries` never fails
- The `client.permissions.calculate(input)` method returns the `bigint` directly in both entry points and throws `GuildOperationError` with reason `input` for inconsistent data
- Command routers return values directly in both entry points. The `commands.create`, `register`, `registerMany`, `registerGroup`, `help` and `commands.memoryCooldowns()` calls throw `ConfigurationError` for invalid definitions, and the default `attach` returns the `Subscription`. Drop `yield*` in front of those calls in native code, where `attach` remains an Effect
- A default cooldown store's `claim` returns the claim or a Promise of it rather than a Result
- Callbacks that returned an Err to signal an ignored outcome now report a failure. Return nothing, or handle the Result inside the callback, when the failure is expected
- The `RegistrationError` and `CollectorRegistrationError` exports are removed, because registration misuse now throws `ConfigurationError` and a registration during shutdown returns a closed handle
- TypeScript consumers that read handler signals or use `await using` need `AbortSignal` and `AsyncDisposable` from the Node.js types, for example `"types": ["node"]`
