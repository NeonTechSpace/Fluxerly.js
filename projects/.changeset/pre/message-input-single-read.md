---
"@neontechspace/fluxerly": patch
---

Read each message input field once when sending, replying, editing, forwarding, sending direct messages or executing webhooks, so the validated value is the one sent.
A getter on `content`, `flags`, `embeds`, `stickerIds`, `messageReference`, an `allowedMentions` switch or an attachment field can no longer pass validation with one value and send another.
Other operations read caller arrays and options once too. The `messages.deleteMany`, `guilds.fetchCounts`, `channels.fetchMemberCounts` and `presence.setMembers` methods copy their IDs once and use the validated copy.
Cache entry limits, event wait options, presence input, pagination, search, member chunk, message cleanup, permission, instance resolution and attachment download options, webhook client options, supervisor options and client cache and upload settings read each field once
