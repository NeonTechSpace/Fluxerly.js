---
"@neontechspace/fluxerly": minor
---

Fields that Fluxer documents on gateway events and the SDK used to drop now reach handlers, in both APIs

A `messageCreate` event carries `mentionedHere`, `channelType` and `nicknames`, and the `messageFields` option accepts them. They are set only on a created message, so `messageUpdate` events, REST reads and the message cache never carry them, and a cached message never mixes them with a later update. Fluxer sends the here mention only as `true`. The channel type is Fluxer's number, kept as received, with 1 for a direct message and 3 for a group direct message. The nicknames of a group direct message are a frozen object keyed by user ID, like `DirectMessageChannel.nicknames`. A value of the wrong type rejects the created message, like `mentionedEveryone`

A `messageDelete` event carries `member`, a new frozen `DeletedMessageMember` that is a `GuildMember` without `username` and `isBot`, because Fluxer removes the member's user. It is left off when Fluxer sends none, when the deletion names no community or author, and when it cannot be read, which never costs the event and logs nothing because no cache is involved. The member cache does not store it

Voice states from `voiceStateUpdate`, `voiceStateSnapshot` and the call events carry `isE2eeCapable` and `isPeerToPeer`, which read `false` when omitted, and `version`, which is absent when Fluxer sends none. Behavior change: A voice state whose `e2ee_capable` or `p2p` is not a boolean, or whose `version` is not a non-negative integer, is now rejected like the other malformed voice state fields

A `guildCreate` event carries `memberCount`, `onlineCount` and `joinedAt` as Fluxer reported them when it delivered the event. They are optional because the SDK keeps accepting a body without them, and a value of the wrong type rejects the event. The guild cache does not store them, so `guilds.fetchCounts` remains the way to read current totals

The testing entry points' `WireMessage` accepts optional `channel_type`, `nicks` and `mention_here`, so `fixtures.message({ channel_type: 3 })` emits a created message in full
