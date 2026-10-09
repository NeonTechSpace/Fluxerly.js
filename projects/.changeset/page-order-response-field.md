---
"@neontechspace/fluxerly": patch
---

A page read whose items arrive out of ID order now fails with `details.responseField` set to `order`, as message history already did. This covers `members.fetchPage`, `guilds.fetchPage`, `messages.fetchReactionUsers` and `auditLogs.fetchPage`. Previously the error named the last field read from a valid item, such as `1.deaf`, which pointed at the wrong cause
