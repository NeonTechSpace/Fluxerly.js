---
"@neontechspace/fluxerly": patch
---

A `members.iterateChunks` request that would be the client's 13th member request in 11 seconds now fails at once with `MemberChunkError` reason `rateLimit` and a `retryAfterMs` wait, without being sent. Fluxer accepts 12 member requests per account in 10 seconds and drops the rest without an answer, so such a request previously waited out its whole timeout and failed with reason `timeout`. The count covers one client, so separate processes with the same token, such as supervisor children, need to keep their combined rate under Fluxer's limit. Member requests sent with `gateway.send` count toward the same window from the moment the socket takes them, but are never refused
