---
"@neontechspace/fluxerly": patch
---

Classify failures from OAuth identity, community and connection reads and token introspection as reads in their messages, hints and details, so `errors.isRetryable` can identify eligible transient failures. Code exchange, refresh and revoke calls with unknown outcomes remain unsafe to repeat, and OAuth requests are not retried automatically

Preserve sanitized transport causes, including safe codes such as `ECONNRESET`, when discovery failures become resource errors and during OAuth calls and buffered or streamed attachment downloads. Raw transport errors and their private text are not retained

Retain unknown uppercase Fluxer error codes in `details.providerCode` for HTTP 429 failures, including when the required wait exceeds the operation deadline

Reject raw REST paths whose reserved `/v1` prefix or token-authenticated webhook route names use percent-encoded unreserved characters. Keep route checks case-sensitive and do not decode reserved characters

Compare pin page ordering and pagination progress at full fractional timestamp precision, with timezone offsets normalized by instant. Equal timestamps still remain equal

Reject audit message-deletion durations whose milliseconds fall outside the safe integer range, rather than projecting an overflowed value such as `Infinity`, and round other durations to whole milliseconds. The same validation applies to REST audit pages and gateway audit events
