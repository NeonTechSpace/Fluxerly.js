---
"@neontechspace/fluxerly": minor
---

Add the `rest` client option to tune REST scheduling: The `concurrency` setting for Fluxer API requests that run at once (1 through 64), `mediaConcurrency` for attachment downloads (1 through 64, default 4), `maxQueued` (1 through 65,536, default 256), `queuedJsonMaxBytes` (64 KiB through 256 MiB, default 4 MiB) and `defaultTimeoutMs` (default 30,000).
By default a client runs 4 API requests at once for each of its shards, up to 64, instead of 4 in total, and the limit follows the shard plan when `sharding: "auto"` sizes or enlarges it. An explicit `concurrency` is used as given.
The `defaultTimeoutMs` setting replaces the fixed 30,000 ms deadline of REST operations and attachment downloads that omit `timeoutMs`.
Invalid values throw `ConfigurationError` naming the field in the default API and are defects in the Effect API, and `client.diagnostics().rest` reports the configured capacities

A request that fails with reason `busy` because the REST queue or the upload byte budget is full now logs `rest.busy` at Warn, at most once a minute, naming the full limit. Every such failure is counted in the new `diagnostics().counters.restBusy` counter
