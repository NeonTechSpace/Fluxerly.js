---
"@neontechspace/fluxerly": major
---

Cache entries for communities, which Fluxer calls guilds, and for members, roles, emojis, stickers and channels now survive a successful Resume, because Fluxer replays every missed event on Resume or refuses the session. They are cleared when a shard has to start a new session. Users, direct messages and messages are still cleared on every lost connection

A `guildCreate` event now fills the enabled role, emoji, sticker and channel caches from its snapshot and replaces that community's earlier entries, so a new session rebuilds them without REST requests. Members are not filled, because the snapshot lists only a few

Migration: Code that relied on community caches being empty after a reconnect should call `guilds.fetch` and the other fetch methods when it needs current state, since a cached entry now stays across a Resume
