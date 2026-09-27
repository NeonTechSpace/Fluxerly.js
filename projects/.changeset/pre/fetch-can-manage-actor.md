---
"@neontechspace/fluxerly": minor
---

The `members.fetchCanManage` method accepts `actorUserId` to check whether another member, such as the moderator who ran a command, outranks the target instead of the bot. It reads that member in place of the bot's own membership, and an invalid ID fails with reason `input` before any request. The option types are `CanManageOptions` and `DefaultCanManageOptions`
