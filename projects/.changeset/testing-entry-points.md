---
"@neontechspace/fluxerly": minor
---

Add `@neontechspace/fluxerly/testing` and `@neontechspace/fluxerly/effect/testing` for application tests that need no network, token or Fluxer account.
The `createTestClient` function returns a real client wired through the `transport` option to an in-memory Fluxer, together with controls: The `ready()` control connects through a protocol-v1 fake gateway, `emit(type, payload, { shardId })` delivers a wire dispatch such as `MESSAGE_CREATE` through the SDK's own decoders, caches and handlers, and `disconnect({ shardId, code })` closes a shard's connection so the client resumes, or stops for a fatal close code.
The `user` and `heartbeatIntervalMs` settings choose the bot account reported in READY and the HELLO heartbeat interval.
The `rest.respond(matcher, response | handler)` control answers HTTP requests matched by a `"METHOD /path/:param"` pattern, a RegExp or a `{ method, path }` object, `requests()` and `commands()` record what the client sent without its token or Authorization header, `logs()` captures log records at the configured level while still calling application sinks, and `counters()` reads the diagnostics counters.
Unmatched requests receive a Fluxer-shaped 404 and a `testing.unmatchedRequest` Warn record.
The native `createTestClient` is scoped: Closing its Scope shuts the client down and closes the transport, while the default client uses `shutdown()` or `await using`.
Both entry points share `fixtures`, `createFixtures` and `fixtureToken`: Deterministic snake_case wire builders for users, the bot user, communities, GUILD_CREATE bodies, channels, roles, members and messages whose defaults refer to one community, channel and author

The `createTestBot` function tests a bot written for `runBot` as written. It takes the bot's own options object, registers its `events` and `commands` with the same handler contexts, delivery defaults and command router as `runBot`, and runs `setup` once in `ready` before connecting. The `signal`, `processSignals`, `reportFailure` and `drainMs` settings are accepted and ignored, and an undefined `token` uses the fixture token.
A misspelled or unsupported option key throws `ConfigurationError` with a hint naming the closest key that `createTestClient` or `createTestBot` accepts, as `createClient` does. A failed setup rejects `ready` with `ApplicationError`. The result is the usual test client, typed `TestBot` in the Effect entry point

Tests wait without building their own promises or sleeping.
The `TestRoute.next()` control returns the next request a registered response answered, in order, including one that arrived before the call.
The `idle()` control waits until no handler or command is running and no request is pending, which confirms that the bot did nothing after an emitted event.
Both fail with `TestTimeoutError` after `timeoutMs`, default 2,000 ms, and the native entry point returns them as Effects.
Their timers stay real when a test fakes timers, for example with `vi.useFakeTimers()`. The SDK runs on `setImmediate`, so fake timers must leave it real, and `idle()` rejects with `ConfigurationError`, or dies with it in the native entry point, instead of settling while no handler can run

A test client fails the test when application code failed without a handler, such as an event handler or command that threw, or returned a failed Result such as a rejected reply, while no `onError` hook was registered.
The default `shutdown()` and `await using` disposal reject with `UnhandledTestFailuresError`, which lists the Error records of those failures.
The native `shutdown()` fails with it, and closing the scope that created the test client dies with it.
Each failure is reported once, so a later shutdown succeeds.
A test that makes application code fail on purpose reads the failure from the `failures()` control, which marks it as expected, or handles it with `onError`
