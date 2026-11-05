---
"@neontechspace/fluxerly": minor
---

Empty strings now work where Fluxer accepts them. Routes that read their body through Fluxer's validator turn an empty string into null before checking it, so the SDK sends an empty string as given on a field that accepts null, where it used to fail with reason `input`:

- The `guilds.edit` method accepts an empty `systemChannelId` or `afkChannelId`, which turns that channel off, and an empty `messageHistoryCutoff`, which turns history access off. An empty `contentWarningText` was already sent, and its reference now says Fluxer stores it as null, which restores the default warning
- The `members.editSelf` method accepts an empty `nickname`, `bio` or `pronouns`, which clears it, and `members.setNickname` accepts an empty nickname, which clears it. A blank bio or pronouns still fails, as Fluxer refuses it
- The `members.timeout` method accepts an empty `timeoutReason`, which means no reason. The `members.move` method accepts an empty channel ID, which disconnects the member, and an empty `connectionId`, which targets every connection like an omitted one
- The `guilds.editVanityUrl` method accepts an empty code, which removes the vanity URL like null
- The `directMessages.editGroup` method accepts an empty `name`, which clears it, an empty `ownerId`, which Fluxer ignores, and empty nickname values, which clear them. Its reference now says that Fluxer reads a `nicknames` object whose values are all null or empty, or an empty object, as null for the whole field, which clears every nickname and needs ownership
- The `channels.create` method accepts an empty `topic`, `url` or `parentId`, which means none, and `channels.edit` accepts an empty `topic`, `url` or `rtcRegion`, which clears it, and an empty `name`, which Fluxer ignores. Forum tags and the default reaction accept an empty `emojiId` or `emojiName`, which means no emoji, and `channels.reorder` accepts an empty `parentId` or `precedingSiblingId`, which means the same as null
- Sticker creation accepts an empty `description`, which is sent as null, as sticker edits already did
- A message edit with flags no longer needs visible content, an embed or an attachment, as Fluxer accepts any edit with flags. So `{ attachments: [], flags }` clears the files where it used to fail with reason `input`. A voice note may have blank or invisible content, which Fluxer does not count as content
