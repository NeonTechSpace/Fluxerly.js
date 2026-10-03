---
"@neontechspace/fluxerly": major
---

Add `ChannelType.Announcement` (5), `GuildAnnouncementChannel`, `GuildTextChannelBase` and `AnnouncementChannelCreate` to both APIs. Announcement channels now decode into their own shape instead of `GuildUnknownChannel`, so exhaustive channel-type switches need an announcement case

Allow `ChannelEdit.type` to convert between text (0) and announcement (5), including a type-only patch. A text channel that follows an announcement channel cannot become one. Delete its follower webhooks first. Conversion to text queues asynchronous follower webhook removal, and a `channelUpdate` event replaces the cached channel with its new type
