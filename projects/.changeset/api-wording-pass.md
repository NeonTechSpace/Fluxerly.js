---
"@neontechspace/fluxerly": patch
---

API comments now state several limits precisely. By default a client runs four REST or upload requests per local shard, up to 64, and four attachment downloads, and the `rest.concurrency` and `rest.mediaConcurrency` options change these numbers. Effect API users, direct messages, webhooks and application calls use the client's `rest.defaultTimeoutMs`, not a fixed 30 seconds. The `client.shutdown` comments say that a failed socket close is not logged or counted. The `users.fetchSelf` and `directMessages.open` comments explain when a result is not cached, and the `users.fetch` and `directMessages.fetch` comments state the 256-ID exception
