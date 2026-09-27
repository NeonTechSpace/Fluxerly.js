---
"@neontechspace/fluxerly": patch
---

Large sharded bots now start within the default startup deadline. When a client owns several shards and has no `sharding.identify` coordinator, the SDK spaces new-session Identify commands by one second, as before, and now adds one second to the startup deadline for each shard after the first, so this spacing alone never fails startup. An Info record with code `lifecycle.startupDeadline` states the extended deadline
