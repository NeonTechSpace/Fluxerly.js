---
"@neontechspace/fluxerly": minor
---

A client created without `sharding` settings now keeps running when the bot outgrows one shard. Fluxer refuses a new session with close code 4011 (sharding required) once one shard would hold more than 2,500 communities, and such a client previously ended with a `ConnectionError`, so a restart or a lost session took the bot down until its configuration changed. The client now counts the bot's communities and moves to a larger plan as `sharding: "auto"` does, with the same limit of 3 moves within an hour, and logs `lifecycle.resharded` at Warn with the old and new totals. Every shard starts a new session for the move, so events sent during it are missed. While the bot stays above the limit, each start first opens a session that Fluxer refuses, which `sharding: "auto"` avoids. An explicit `totalShards`, including 1, still ends the client on 4011, and supervised children are unchanged because the supervisor always assigns an explicit plan
