---
"@neontechspace/fluxerly": minor
---

Send text-to-speech messages with `tts: true` on `messages.send`, `messages.reply`, `directMessages.send` and the `runBot` reply helpers.
A non-boolean value fails with reason `input` before any request. In a community, Fluxer sends a normal message without an error when the bot lacks the Send TTS Messages permission.
Webhook messages do not accept `tts`, because Fluxer never sends a webhook message as text-to-speech. Webhook sends, replies and forwards with `tts` fail with reason `input` before any request.
Messages gain an optional `tts` field, selectable through `messageFields`. Fluxer does not store the value, so it is meaningful only on the message returned by a send and on `messageCreate` events. Fetches, history pages and other later reads always report `false`. A message whose `tts` is present but not a boolean is treated as malformed, like other malformed message fields
