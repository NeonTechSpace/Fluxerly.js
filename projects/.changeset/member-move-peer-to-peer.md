---
"@neontechspace/fluxerly": patch
---

The `members.move` comments now explain a refusal Fluxer added. Moving a member into an occupied voice channel whose participants all use peer-to-peer voice leaves the member in its current channel and fails with reason `rejected`, HTTP 400 and `details.providerCode` `USER_NOT_IN_VOICE`, even though the member is in voice. A retry fails the same way while the destination stays in peer-to-peer mode
