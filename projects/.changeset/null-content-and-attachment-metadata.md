---
"@neontechspace/fluxerly": minor
---

Null now works where Fluxer accepts it in messages:

- Message sends, replies, forum posts, webhook sends, message edits and webhook message edits accept `content: null`, as Fluxer does. A send then has no text and needs an embed, a file or a sticker, and an edit clears the text, as an empty string does, so an edit without flags needs an embed or a file. On sends, replies and channel message edits Fluxer still reads `allowedMentions` when content is null, so the rule against `everyone` with listed users or roles applies there as it does with text. The types of `MessageContent`, `MessageBody` and `WebhookMessageEdit` now allow null
- A new attachment accepts null for `title`, `description`, `duration` and `waveform`, which Fluxer stores as none, where it used to fail with reason `input`. A voice note still needs a waveform and a duration, so null for either fails as omitting it does. A webhook send accepts null only for `title`, because Fluxer's multipart webhook schema refuses null for the others, so those still fail with reason `input`
- Webhook sends accept null for `username` and `avatarUrl`, which keeps the webhook's own name and avatar, as Fluxer does, where they used to fail with reason `input`
- A webhook forward accepts `everyone` together with listed users or roles in `allowedMentions`, as Fluxer reads no mention settings on a forward, where it used to fail with reason `input`
- An embed image or thumbnail `attachment://` reference may name a stored filename that several new uploads share, as Fluxer accepts, where it used to fail with reason `input`. Fluxer puts the last of those uploads into the embed
