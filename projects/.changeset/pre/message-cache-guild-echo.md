---
"@neontechspace/fluxerly": patch
---

Keep a sent message in the message cache when its gateway echo arrives before the HTTP response.
Fluxer omits the community ID, `guild_id`, from message HTTP responses, and the cache previously treated that difference as a conflict and dropped the message.
Other differences between overlapping observations still remove the cached message
