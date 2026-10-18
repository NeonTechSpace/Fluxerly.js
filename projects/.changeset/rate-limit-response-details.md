---
"@neontechspace/fluxerly": minor
---

The `ratelimit.wait` and `ratelimit.deadline` log records and the `rateLimit` observation now repeat what a 429 response sent about the limiter that answered it. Log records carry these values in `fields`, and `RateLimitObservation` has them as optional members: `scope`, `bucket`, `limit`, `remaining` and `resetAfterSeconds` from the `X-RateLimit-Scope`, `X-RateLimit-Bucket`, `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset-After` headers, `retryAfterHeaderSeconds` from a numeric `Retry-After` header, and `retryAfterSeconds` and `bodyGlobal` from the body's `retry_after` and `global` members. Each value is present only when the response sent it in the expected form. A `ratelimit.deadline` record for a request refused before sending, behind a known pause, has none. Waits, retries and the existing `global` value are unchanged
