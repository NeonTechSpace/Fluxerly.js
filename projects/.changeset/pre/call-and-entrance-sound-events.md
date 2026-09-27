---
"@neontechspace/fluxerly": minor
---

Add the `callCreate`, `callUpdate`, `callDelete` and `entranceSoundPlay` events for Fluxer's CALL_CREATE, CALL_UPDATE, CALL_DELETE and ENTRANCE_SOUND_PLAY dispatches, with frozen `CallCreate`, `CallUpdate`, `CallDelete` and `EntranceSoundPlay` payloads.
Call participants use `CallVoiceState`, which omits Fluxer's internal voice routing fields.
A malformed dispatch of these types is skipped and counted like other malformed events, without clearing any cache
