---
"@neontechspace/fluxerly": minor
---

Recognize Fluxer's `TWO_FACTOR_REQUIRED` rejection in both entry points. A kick, ban, timeout or other action that needs a moderation permission in a community that requires two-factor authentication now fails with `apiError.code` set to `twoFactorRequired` and `apiError.providerCode` set to `TWO_FACTOR_REQUIRED`, instead of `apiError` set to `null`. Fluxer returns it when the account that owns the bot's application has no two-factor authentication enabled and the bot does not own the community.
Communities, which Fluxer calls guilds, gain an optional `mfaLevel` field with the new `GuildMfaLevels` constants `None` and `Elevated`, so a bot can see this requirement before it sends a moderation request. The field appears on fetched communities, community list entries and `guildCreate` and `guildUpdate` events. A community whose `mfa_level` is present but not 0 or 1 is treated as malformed, like other malformed community fields

The moderation and message deletion references describe this requirement, and the `messages.deleteMany` reference states that it requires `ManageMessages` even for the bot's own messages
