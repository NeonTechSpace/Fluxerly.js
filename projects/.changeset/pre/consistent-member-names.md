---
"@neontechspace/fluxerly": major
---

Rename client members so each name states what it does and each concept uses one word across both entry points.
Deleting a bot's own history now requires an explicit `{ confirm: true }` option, checked by TypeScript and again at runtime, and a missing confirmation fails with reason `input` before any request.
Subscriptions, collectors and state observers all end with `close()`, and a collector's `result()` returns its final collection.
`MessageError` reports `outcome` with the same `notDispatched`, `rejected` and `unknown` values as other operation errors, so an API rejection is now distinguishable from a send that never started

Migration:

- Replace `guilds.deleteMine(guildId)` with `guilds.deleteOwnMessages(guildId, { confirm: true })`, and `messages.deleteMine(channelId)` with `messages.deleteOwnMessages(channelId, { confirm: true })`. The required `confirm` option joins the existing timeout and signal options. The operation IDs change from `guilds.deleteMine` and `deleteMine` to `guilds.deleteOwnMessages` and `deleteOwnMessages`
- Call `members.ban`, `members.unban` and `members.fetchBans` instead of `guilds.ban`, `guilds.unban` and `guilds.fetchBans`, with the same parameter order. Their operation IDs change from `guilds.ban`, `guilds.unban` and `guilds.fetchBans` to `members.ban`, `members.unban` and `members.fetchBans`
- Rename `invites.fetchChannel` and `invites.fetchGuild` to `invites.fetchForChannel` and `invites.fetchForGuild`, and `webhooks.fetchChannel` and `webhooks.fetchGuild` to `webhooks.fetchForChannel` and `webhooks.fetchForGuild`. Their operation IDs change to the same new names, so code matching `error.operation` on `invites.fetchChannel`, `invites.fetchGuild`, `webhooks.fetchChannel` or `webhooks.fetchGuild` needs updating
- Replace `application.fetchCurrent()` with `application.fetch()`. The operation ID changes from `application.fetchCurrent` to `application.fetch`
- Replace `members.fetchHierarchyCheck(target)` with `members.fetchCanManage(target)`. The operation ID changes from `members.fetchHierarchyCheck` to `members.fetchCanManage`
- Replace `members.setMute(target, true)` with `members.setMute(target, { muted: true })`, and `members.setDeaf(target, true)` with `members.setDeaf(target, { deafened: true })`. The exported `VoiceMuteInput` and `VoiceDeafenInput` types describe these inputs
- Call `close()` instead of `subscription.unsubscribe()` on subscriptions, and instead of `collector.stop()` on message and reaction collectors, in both entry points
- Call a collector's `result()` instead of its `waitForClose()`. The operation IDs change from `collector.waitForClose` and `reactionCollector.waitForClose` to `collector.result` and `reactionCollector.result`
- The default `client.observeState(listener)` returns a `StateObserver` instead of a function. Call `observer.close()` where the returned function was called
- A malformed target passed to `client.messages.get` throws `MessageOperationError` with operation `messages.get` instead of `get`, matching `users.get` and `channels.get`, and an `SdkDefect` from that lookup also names `messages.get`. Code that compared a lookup failure's `operation` with `"get"` compares it with `"messages.get"` instead
- Replace `client.events(event)` with `client.subscribe(event)`, which no longer shares a name with the `runBot` events option. The operation ID changes from `events` to `subscribe`
- Read `MessageError.outcome` instead of `MessageError.delivery`. Replace `"notSent"` checks with `outcome !== "unknown"`, or distinguish `"notDispatched"` from `"rejected"`, and pass `outcome` instead of `delivery` when constructing the error
