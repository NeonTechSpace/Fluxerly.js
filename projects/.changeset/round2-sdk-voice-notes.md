---
"@neontechspace/fluxerly": minor
---

Voice notes and webhook edits:

- `voiceWaveform` takes an optional third argument, `{ maxPoints }`, an integer from 1 through 256. With `{ maxPoints: 192 }` the waveform fits a webhook send or reply for audio of any length. Without it, the result keeps Fluxer's 256 points as before. Other options fail with `HelperError` and reason `limit`. Both entry points export the new `VoiceWaveformOptions` type
- The comments of `WebhookMessageEdit.flags` and `WebhookClient.editMessage` now say that supplied flags, including 0, also clear `MessageFlags.VoiceMessage`, so an edit through the webhook that omits `flags` keeps a voice note
