---
"@neontechspace/fluxerly": minor
---

`VoiceState`, which `voiceStateUpdate` and `voiceStateSnapshot` deliver, now reports `isSelfVideoOn`, `isSelfStreaming`, `viewerStreamKeys` and `member`. The first three also appear on `CallVoiceState`, while `member` does not, because Fluxer attaches no community member in a private call. The `member` field is the same `GuildMember` shape that member events use and is omitted when Fluxer sends none. An omitted video or stream flag reads as false and omitted watched streams read as an empty list, so events from servers that do not send them still arrive. A voice state whose member data is present but malformed is rejected whole, like any other malformed field
