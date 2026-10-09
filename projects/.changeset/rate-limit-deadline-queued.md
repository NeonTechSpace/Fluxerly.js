---
"@neontechspace/fluxerly": patch
---

A REST request that would wait behind a known rate-limit pause past its deadline now fails at once with reason `rateLimit` and the remaining wait in `retryAfterMs`, and logs `ratelimit.deadline`, at Warn for the first such request on a route each minute when the wait is a second or longer, and at Debug for every other such request. Previously it waited until its timeout and failed with reason `timeout`, so a long global 429 held every later request on the client for its whole deadline without saying why. The pause itself still lasts as long as Fluxer asked and ends on time, so requests sent after it go out normally
