---
"@neontechspace/fluxerly": patch
---

A connection lost while a REST response body arrives now fails with reason `network`, keeping the sanitized transport code as the error's cause, and a read such as `messages.fetch` or a GET through `rest.request` retries it at most twice like any other network error. Previously the operation failed with reason `response`, as if Fluxer had sent malformed data, logged a misleading `rest.responseRejected` Warn and reported the raw transport error as an SDK defect, so the read was never retried. A write whose response is cut off still fails with outcome `unknown` and is never sent again
