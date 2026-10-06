---
"@neontechspace/fluxerly": minor
---

Add `fileSessionStore(directory)` to both entry points, a built-in `SessionStore` for `sharding.sessions` that keeps one JSON file per shard. Saves write a temporary file with mode 0600, flush it and rename it over the shard's file, so a crash never leaves a partial snapshot. A missing file loads as no snapshot, and a corrupt file rejects without quoting its contents, so the session ID never appears in logs
