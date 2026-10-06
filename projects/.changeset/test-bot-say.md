---
"@neontechspace/fluxerly": minor
---

Add `say(content, options?)` to the test bot of both testing entry points. It delivers a message from a human user, waits until the bot settles as `idle` does, and returns the messages the bot sent in response in wire shape, or an empty list when it sent nothing. The default `createTestBot` now returns the new `TestBot` type, and the new `TestSayOptions` type adds message overrides to the wait options
