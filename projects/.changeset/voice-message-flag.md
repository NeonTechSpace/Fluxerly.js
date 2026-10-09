---
"@neontechspace/fluxerly": minor
---

`MessageFlags` gains `VoiceMessage` (8192), which marks a voice message in Fluxer. Message and webhook send and edit operations still reject this bit before dispatch, because only `SuppressEmbeds` and `SuppressNotifications` are writable in this SDK
