---
"@neontechspace/fluxerly": major
---

Breaking changes, each with the code it affects and how to migrate:

- Allowing `everyone` together with a nonempty `users` or `roles` list in `allowedMentions` now fails with reason `input`, constraint `relationship` and path `allowedMentions` before sending, for channel message edits and for sends, replies and webhook sends that have content or reply to a message. Fluxer reads the mention settings there and refuses that combination, so it used to fail remotely with reason `rejected` and an `apiError` with code `invalidFormBody`. A send with only embeds or files, and a webhook message edit, still send it, as Fluxer does not read the settings there
  Affected: Code that matches reason `rejected` for this mistake
  Migration: Allow `everyone` alone, or list user and role IDs without it, and match reason `input`
- A webhook message `avatarUrl` may now hold at most 2,048 characters after Fluxer's normalization, the limit Fluxer applies, instead of 8,192. A longer URL now fails with reason `input` before sending instead of being refused by Fluxer
  Affected: Code that sends avatar URLs longer than 2,048 characters and handles Fluxer's refusal
  Migration: Use a shorter avatar URL, and match reason `input`
- An image whose base64 has nonzero bits before its `=` padding now fails with reason `input` and constraint `format` before sending, with an explanation that names the padding. Fluxer refuses such base64, so it used to fail remotely with reason `rejected`. Buffer and other standard encoders never write it
  Affected: Code that builds base64 by hand and handles Fluxer's refusal
  Migration: Encode image bytes with `Buffer.from(bytes).toString("base64")` and match reason `input`
- In a webhook message edit, an embed whose values are all empty strings, such as `{}` or `{ title: "" }`, now fails with reason `input`, constraint `required` and path `embeds[]` before sending. On that route Fluxer reads empty strings as absent and refuses an embed left with nothing, so it used to fail remotely with reason `rejected`. Sends, replies, channel message edits and webhook sends still accept such an embed, as Fluxer does there
  Affected: Code that edits webhook messages with embeds built from values that can be empty and handles Fluxer's refusal
  Migration: Leave such an embed out of the edit, and match reason `input`
- A message edit without flags now fails with reason `input`, constraint `required` and path `input` before sending when it has no visible content, no embed and no attachment, such as `{ content: "" }` or `{ embeds: [] }` alone. This covers `messages.edit` and the webhook client's `editMessage`, where Fluxer reads empty content as null first. Fluxer checks the edit itself rather than the message it leaves, so such an edit used to fail remotely with reason `rejected` and an `apiError` with code `cannotSendEmptyMessage`. Content that is blank or only invisible characters, such as a zero-width space, counts as none, as in Fluxer
  Affected: Code that clears the text or the embeds of a message alone, and code that matches reason `rejected` for it
  Migration: Send the text or embeds that should stay, or include the message's current `flags` in the same edit, which Fluxer accepts with empty content, and match reason `input`
- A message send, reply or webhook send whose content is blank or only invisible characters, with no embed, attachment or sticker, now fails with reason `input` before sending. Fluxer refuses it, so it used to fail remotely with reason `rejected`
  Affected: Code that sends whitespace as a message and handles Fluxer's refusal
  Migration: Send visible text or another part, and match reason `input`
- An empty string in `sourceInviteCodes` of a member search, and an empty URL in `attachments.refreshUrls`, now fail with reason `input` before sending. Fluxer reads them as null and refuses the request, so they used to fail remotely with reason `rejected`
  Affected: Code that passes such lists unfiltered and handles Fluxer's refusal
  Migration: Leave empty entries out, and match reason `input`
