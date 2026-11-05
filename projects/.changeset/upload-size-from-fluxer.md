---
"@neontechspace/fluxerly": major
---

Breaking changes, each with the code it affects and how to migrate:

- Attachments larger than 50 MiB are no longer refused locally, because Fluxer now lets an instance give a bot a higher limit. Fluxer decides how large each file may be: A bot gets the lower of the instance's attachment limit and its bot attachment limit, which is 50 MiB unless the instance raises it for that bot or community, and a webhook gets the limits of the user who created it. Message sends, replies and edits and webhook messages now send such a file, and a file Fluxer refuses as too large fails with reason `rejected` and an `apiError` with code `fileSizeTooLarge`. An inline multipart upload more than 64 MiB over the limit may instead end with Fluxer closing the connection, which fails with reason `network`. File and stream sources accept any nonnegative safe integer size, and signed upload plans accept parts larger than 50 MiB, which Fluxer plans for files over 1,000 MiB. The client's `uploads.maxBytes` budget and a webhook client's `uploadMaxBytes`, 100 MiB by default, still apply
  Affected: Code that relies on a file over 50 MiB failing with reason `input` before any request, for example to tell users a file is too large
  Migration: Match an `apiError` with code `fileSizeTooLarge` for a file Fluxer refuses, and raise `uploads.maxBytes` or `uploadMaxBytes` to send files larger than 100 MiB
