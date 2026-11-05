---
"@neontechspace/fluxerly": major
---

Breaking changes, each with the code it affects and how to migrate:

- Emoji and sticker images larger than 512 KiB decoded are no longer refused locally, because Fluxer resolves the size limit per community and an instance may raise it. `emojis.create`, `stickers.create` and both `createMany` methods now send such an image, and an image Fluxer refuses as too large fails with reason `rejected` and an `apiError` with code `invalidFormBody` whose validation entry for the image has provider code `IMAGE_SIZE_EXCEEDS_LIMIT`. Base64 checks still run locally. The request body is now checked against Fluxer's fixed route limits instead: 15,029,592 encoded bytes for one upload and 36,001,112 for a batch, which fail with reason `input` and constraint `size` on `input` or `inputs`
  Affected: Code that relies on an image over 512 KiB failing with reason `input` and constraint `size` on `image` before any request
  Migration: Match an `apiError` with code `invalidFormBody` for an image Fluxer refuses as too large, and split a batch whose body exceeds 36,001,112 bytes
