---
"@neontechspace/fluxerly": major
---

Breaking changes, each with the code it affects and how to migrate:

- A multipart request with files, as inline uploads and webhook messages send, that Fluxer answers with HTTP 503, code `SERVICE_UNAVAILABLE` and `Retry-After: 5` now fails with outcome `rejected` instead of `unknown`, sets `details.uploadSlotsBusy`, and `errors.isRetryable` returns true for it. Fluxer gives this answer when its file upload slots stay busy for 10 seconds, while it reads the files and before it applies anything, so sending the message, edit or webhook message again after `retryAfterMs` cannot duplicate it. A call that read a stream source sets `details.streamUsed` and stays not retryable, because it needs a fresh stream. Fluxer's other 503 answers keep outcome `unknown`
  Affected: Retry wrappers that use `errors.isRetryable`, which now repeat such an upload where they used to stop, and code that treats this answer as possibly applied
  Migration: Wait `retryAfterMs` before repeating the call, and pass a new stream when `details.streamUsed` is set
