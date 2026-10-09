---
"@neontechspace/fluxerly": patch
---

API comments now warn where Fluxer applies one operation as several separate writes. A failed `roles.delete` can leave the role in place after some members already lost it, and a failed `channels.delete` can leave a channel that already lost its invites, webhooks, attachments and messages. A failed overwrite change on a category, through `channels.edit`, `channels.setPermissionOverwrite` or `channels.removePermissionOverwrite`, can leave some of its channels with the old overwrites, and a retry may not reach them. The `channels.reorder` comment now says its error does not list the moves that finished, and the communities guide shows how to keep the failure while reading the actual order and parents. The announcement guide's publish helpers log the sent message's ID when publishing fails, and the guide notes that a failed publish can still leave the message published
