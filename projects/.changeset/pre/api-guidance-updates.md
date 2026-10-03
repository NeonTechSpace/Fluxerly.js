---
"@neontechspace/fluxerly": patch
---

API comments now explain recent Fluxer behavior. Member search can fail with `twoFactorRequired` in a community that requires two-factor authentication for moderators, even without filters. The older `nsfw: false` channel field restores inheritance on create and edit, and `nsfwOverride: false` marks a channel as not adult-only. Message search in an age-restricted community can include adult content even when `includeNsfw` is false. Member queries over the gateway match the start of a nickname, global name or username. A rejected bot token or OAuth grant can come from the owning account's standing, which a new token does not fix
