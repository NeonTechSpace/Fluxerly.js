---
"@neontechspace/fluxerly": patch
---

Fluxer refuses stickers and new reactions with custom emoji from an age-restricted community outside that community, whatever the bot's permissions, and they then fail with an `apiError` with code `missingPermissions`. Adding to a reaction already on the message still works. Such an emoji in message text sent or edited outside its community becomes plain `:name:` text. The references of `messages.addReaction`, `stickerIds` and `format.customEmoji`, and the emoji and stickers guide, say so, and the missing-permission hints of sends and reactions mention it
