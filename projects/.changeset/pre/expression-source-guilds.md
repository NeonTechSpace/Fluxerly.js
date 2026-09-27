---
"@neontechspace/fluxerly": minor
---

Read the community that owns a custom emoji or sticker with `emojis.fetchSource(id)` and `stickers.fetchSource(id)` in both entry points. Fluxer calls a community a guild.
The result is a frozen `ExpressionSourceGuild` with the community's `id`, `name`, `icon` hash and badge `features`.
Fluxer answers when the source community is discoverable or the bot is a member of it. A private or unavailable source community fails with `GuildOperationError` whose `apiError.code` is `unknownResource`.
Badge names added by Fluxer later are kept rather than failing the read, and a response missing any documented field fails with reason `response`
