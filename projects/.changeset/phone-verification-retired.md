---
"@neontechspace/fluxerly": major
---

Remove the retired phone-verification level. The `GuildVerificationLevels.VeryHigh` constant is gone and guild edits reject level 4 before the request. Level 4 received from older instances decodes as `High` (3), matching Fluxer. Other out-of-range levels still fail decoding. The `ApiProviderCode` type drops `GUILD_PHONE_VERIFICATION_REQUIRED`, and an unrecognized code stays in `details.providerCode`
