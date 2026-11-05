---
"@neontechspace/fluxerly": major
---

Message nonces, message search text and attachment content types are now checked the way Fluxer checks them: After removing form feeds and U+202E and trimming surrounding whitespace. The SDK still sends the value as given. Breaking changes, each with the code it affects and how to migrate:

- A blank message nonce, such as `" "`, now fails with reason `input`, constraint `length` and path `nonce` before sending, for message sends, replies, forwards and webhook sends. Fluxer refuses it after trimming, so it used to fail remotely with reason `rejected`. A nonce whose surrounding whitespace takes it over 32 UTF-16 code units is now sent, as Fluxer accepts it and keeps the trimmed form
  Affected: Code that sends nonces built from values that can be blank and handles Fluxer's refusal
  Migration: Send a nonce with at least one visible character, or omit it for the SDK's own, and match reason `input`
- Blank text in a message search, in `content`, `contents`, `exactPhrases`, the embed provider, link hostname and attachment filename and extension filters and their exclusions, now fails with reason `input` before sending. Fluxer refuses it after trimming, so it used to fail remotely with reason `rejected`. Text whose surrounding whitespace takes it over the limit is now sent, as Fluxer accepts it
  Affected: Code that searches with text that can be blank and handles Fluxer's refusal
  Migration: Leave blank filters out of the query, and match reason `input`
- A blank attachment `contentType`, such as `" "`, now fails with reason `input` and path `attachments[].contentType` before sending. Fluxer refuses it after trimming, so it used to fail remotely with reason `rejected`. A content type whose surrounding whitespace takes it over 255 characters is now sent
  Affected: Code that sets content types from values that can be blank
  Migration: Omit `contentType` when there is none, and match reason `input`
