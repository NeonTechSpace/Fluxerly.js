---
"@neontechspace/fluxerly": minor
---

Voice notes in more places:

- A forum or media post's first message can now be a voice note. Set `MessageFlags.VoiceMessage` on the message passed to `threads.createPost`, with one audio attachment that has `duration` and `waveform`, under the same rules as `messages.send`
- Webhook sends and webhook replies now accept voice notes. Webhook files always go as multipart, where Fluxer reads a waveform of at most 256 characters, so a longer waveform fails locally on `attachments[].waveform` with reason `input`. A `voiceWaveform` result fits for audio up to 19.2 seconds. Webhook forwards still refuse `MessageFlags.VoiceMessage`
- A webhook send with `MessageFlags.VoiceMessage` and content now fails on `content`, as `messages.send` does, instead of on `flags`
