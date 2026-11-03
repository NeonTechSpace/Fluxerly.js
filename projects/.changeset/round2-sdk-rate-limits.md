---
"@neontechspace/fluxerly": patch
---

Rate-limit recovery and wording:

- After a 429 that named no limit, such as one from a proxy, only an API request now probes whether the limit has passed. A signed upload PUT to a storage host still waits for the pause, but its answer no longer releases every waiting API request at once or resets the growing pause
- The `ratelimit.queueHeld` record for a global or client pause names the longest known wait of the held requests in its own sentence, since one request's route limit can outlast the pause itself
- Rate-limit hints and messages no longer say that Fluxer refused the request, because the 429 can come from a storage host or a proxy. They now read, for example, `The request was rate-limited. Wait at least 5000 ms before retrying`, and the upload hint still names a new stream or the file as bytes
