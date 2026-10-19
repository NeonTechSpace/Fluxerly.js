---
"@neontechspace/fluxerly": minor
---

The member that Fluxer attaches to community events now reaches handlers. The `member` field of `messageCreate` and `messageUpdate` messages, of `messageReactionAdd` and `messageReactionRemove` reactions, and of `typingStart` notices carries the author's or actor's `GuildMember`, read from the community's current state when Fluxer sends the event. A message's member is completed with the author's username and bot flag. The field is absent on REST reads, direct messages, webhook messages, users who left the community, `messageDelete` events (Fluxer sends no username there) and batch or clear events. The `messageFields` option now accepts `member`, and the message cache keeps messages without it, so read it in the handler

A member that Fluxer sends in a form the SDK cannot read, including a reaction or typing member without the user's name, is left off the event and the event still arrives. This differs from voice states, which reject the whole voice state

Behavior change: With `cache.members` enabled, these events also store their member in the member cache, whichever `messageFields` the client selects, so `members.get` answers for an author without a REST read. A member that cannot be read removes the account's cached member and logs `gateway.memberSkipped`, because the cached copy may now be stale. An event rejected as malformed that carried a member removes the account's cached member too, or the community's cached members when the event does not identify the account, or every cached member when it does not identify the community either. The exception is that a reaction or typing member without the user's name is completed from the member already cached. The cache still requests no extra gateway dispatches, and a voice state's member is still never stored because it can lag behind role edits

The testing entry points' `WireMessage` accepts an optional `member` without its user and guild ID, so `fixtures.message({ member })` emits a decorated message in tests
