---
"@neontechspace/fluxerly": patch
---

Log deduplication now keeps records about different shards or subscriptions apart. The same malformed dispatch on two shards previously collapsed into one record within the dedupe window, so the second shard's fault appeared only as a repeat count with the first shard's ID
