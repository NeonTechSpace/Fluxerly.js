---
"@neontechspace/fluxerly": major
---

Registering a subscription or collector after client shutdown has begun no longer fails with `ClientClosedError` at registration, in both entry points. A handler that is still running when shutdown starts can register, which is a runtime race rather than misuse

- A `client.on` or `client.subscribe` registration, including a command router's `attach`, returns an already-closed subscription. Its handler never runs, `waitForClose` succeeds and the default `next` returns `Ok(null)`. The native `subscribe` Stream ends without events. Each such registration writes a Warn log record with code `events.registeredAfterShutdown`
- A `messages.collect` or `messages.collectReactions` registration returns a collector whose `result` fails with `ClientClosedError`, as it does for a collector already running when shutdown starts
- Invalid arguments are misuse and throw or die with `ConfigurationError`, whatever the client state. Registering middleware with `client.use` on a closing client throws or dies with `ClientClosedError`

Migration:

- Code that handled `ClientClosedError` from these registrations reads the handle instead. Check `client.state`, or read the collector's `result` for `ClientClosedError`
