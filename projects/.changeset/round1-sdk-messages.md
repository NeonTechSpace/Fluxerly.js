---
"@neontechspace/fluxerly": patch
---

Message and thread fixes:

- The `threads.iterateArchived` method no longer skips a thread archived in the same millisecond as others when `maxItems` leaves fewer threads to read than a page holds. Each later page of the `public` and `private` scopes now asks for a full page, so the last request can return up to `pageSize` minus one threads that the traversal does not deliver. The `joinedPrivate` scope still asks only for the threads that remain
- Message flags with a fraction or a bit above 32, such as `8192.5`, now fail locally on `flags` when `MessageFlags.VoiceMessage` is set. They used to pass, because removing the voice-note bit dropped the invalid part
- The `voiceWaveform` reference now decodes with `ffmpeg -i note.ogg -af 'pan=mono|c0=c0' -f f32le -`, which keeps only the first channel as Fluxer's apps read it. The earlier `-ac 1` mixed the channels. It also says that exact parity needs the same first-channel samples at the same sample rate, and that ordinary decoded PCM scales work
- The flags references say that an edit of the bot's own message replaces its sendable flags and clears `MessageFlags.VoiceMessage`, while on another author's message Fluxer requires Manage Messages in a community and changes only `SuppressEmbeds`
