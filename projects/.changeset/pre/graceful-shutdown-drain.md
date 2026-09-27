---
"@neontechspace/fluxerly": major
---

The `runBot` function lets running work finish before it stops, in both entry points.
When its `signal` aborts, or SIGINT or SIGTERM arrives with `processSignals: true`, the bot stops accepting new events and gives running handlers and commands, events already waiting for them and their REST requests up to 5,000 ms to finish. Then it shuts down as before and cancels whatever is left. The new `drainMs` option changes that time. A stop caused by a failure still shuts down at once. Sending the same process signal again ends the process at once with the default Node.js behavior

Add `ShutdownOptions` with `drainMs` to `client.shutdown(options)` in both entry points for the same drain outside `runBot`. Without options, `shutdown()` still cancels running handlers at once.
During a drain the connection state stays as it was, new subscriptions and event waits start closed, and handlers can still send requests. The drain ends as soon as no work is left, logging `lifecycle.drained`. When the time runs out, a `lifecycle.drainTimedOut` Warn record names how many handlers, events and requests were cut off. A `lifecycle.draining` Info record marks the start.
An invalid `drainMs` throws `ConfigurationError` in the default API and dies with it in the Effect API

Supervised children drain the same way when the supervisor stops them, for up to the supervisor's `shutdownTimeoutMs` minus one second, which keeps that second for closing the connection. A child whose client stopped on its own is not drained

Migration: To keep cancelling running handlers as soon as the bot is asked to stop, pass `drainMs: 0` to `runBot`
