---
"@neontechspace/fluxerly": patch
---

Rate-limit and startup fixes:

- Automatic sharding and a supervisor's `totalShards: "auto"` now wait out a rate-limited instance discovery or community page when the wait ends before the startup deadline, then read the same page again. The wait counts toward the deadline and is not a startup attempt, and shutdown stops it. A longer or unknown wait still fails with `RateLimitError`. Startup used to fail at once with `RateLimitError`
- A global pause relayed by a supervisor from another child now fails a queued request at once with `retryAfterMs` when the pause outlasts the request's deadline. The request used to wait out its deadline and time out without the wait
- The `ratelimit.queueHeld` log now reports a global or client pause that starts while a route hold is already reported, and reports a hold while every request slot is busy. Each reason is still logged at most once a minute
- The `diagnostics()` references say that a rate-limit hold may name a method and route template with IDs replaced, and that the report has no raw request path
