---
"@neontechspace/fluxerly": minor
---

Preserve provider-supplied guild context as optional `guildId` on `messageDelete`, `messageDeleteBulk` and `channelPinsUpdate` payloads through both APIs. No channel lookup or cache inference is added, and omission does not establish that the event came from a private channel
