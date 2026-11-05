---
"@neontechspace/fluxerly": major
---

Breaking changes, each with the code it affects and how to migrate:

- Embed URLs, in the embed, its author, its footer icon and its image and thumbnail, are now checked after Fluxer's text normalization, which removes form feeds and right-to-left overrides and trims surrounding whitespace. A URL that fits 2,048 characters only after trimming is now accepted and sent as given, and a blank URL still fails. A URL with credentials, such as `https://user:pass@example.com`, now fails with reason `input` and constraint `format` before sending. Fluxer refuses credentials, so it used to fail remotely with reason `rejected`
  Affected: Code that sends URLs with credentials and handles Fluxer's refusal
  Migration: Remove the credentials from the URL, and match reason `input`
- An `attachment://` reference in an embed image or thumbnail is now read after the same normalization and compared with the name Fluxer stores for each new upload. Fluxer turns spaces into underscores, a slash into an underscore, runs of dots into one dot, and drops characters outside letters, marks, numbers, underscores, dots and hyphens. An upload named `my photo.png` is now referenced as `attachment://my_photo.png`, and the reference `attachment://my photo.png` fails with reason `input` before sending. A reference with two dots in a row, such as `attachment://a..png`, no longer matches an upload with that name, which Fluxer stores as `a.png`
  Affected: Code that references uploads whose names Fluxer changes
  Migration: Reference the stored name, such as `attachment://my_photo.png`, and match reason `input`
