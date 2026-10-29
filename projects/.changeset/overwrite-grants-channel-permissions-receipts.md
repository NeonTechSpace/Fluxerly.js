---
"@neontechspace/fluxerly": minor
---

Both entry points gain helpers for Fluxer's permission overwrite rules, one call for a member's permissions in every channel, error helpers for retry waits, and an arrival number on every event

The new `permissions.fetchChannels(target, options?)` method returns one member's permission bits in every channel of a community. Pass the bot's own ID from `client.users.getSelf()` as `userId` to see what the bot can do in each channel. It always reads fresh: The guild, the member, the roles and the channel list, once each and under one deadline. It then calculates each channel locally, the same way as `permissions.calculate` and `permissions.fetch`. The result is a frozen array of frozen `ChannelPermissions` entries (`{ channel, permissions }`), in the order Fluxer lists the channels

Fluxer lists only the channels the bot can view, and no threads, so call `permissions.fetch` with a thread's ID for one. The `options` are the plain `RequestOptions`, without `preferCache`, because no cache holds a complete channel list. Failures use `GuildOperationError` with the new operation `permissions.fetchChannels`, and errors from the reads keep their own type. A listed channel that arrives without its permission overwrites fails as it does in `permissions.fetch`, with reason `response`, outcome `"unknown"`, `details.read` and `details.channelId`

The new `permissionBits.refusedGrants(current, next, held)` helper returns, as a bigint, the bits Fluxer would refuse in an overwrite change. Unless the bot has Administrator, it can allow, or stop denying, only permissions it has in the channel, and Fluxer answers `missingPermissions` for the rest. Pass the overwrite's current `allow` and `deny` as `current` and the new ones as `next`, with `undefined` for no overwrite, so a removal passes `undefined` as `next`. Pass the bot's permission bits in that channel as `held`. The helper returns `0n` when `held` includes Administrator, and invalid input throws `HelperError` with operation `permissionBits.refusedGrants`

The documentation of `channels.create`, `edit`, `reorder`, `setPermissionOverwrite` and `removePermissionOverwrite` now states this rule for each method. Their missing-permission hints name the channel that Fluxer checks and point to the helper

The new `permissionBits.sameOverwrites(first, second)` helper compares two overwrite lists as Fluxer does: The same target IDs and, for each, the same type, allow and deny, in any order. Fluxer copies a category's overwrite change to every child whose overwrites equal the category's, with no way to opt out, so compare the children with the category before changing it. A list that is not valid, or that names a target ID twice, throws `HelperError` with operation `permissionBits.sameOverwrites`, because Fluxer rejects duplicate IDs on write

The new `errors.retryAfterMs(error)` function returns how many milliseconds an SDK error says to wait before a retry, read from the `retryAfterMs` of any operation error or `RateLimitError`. For a `ShardConnectionError` it returns the wait of the failure that stopped its shard, and for an Effect `Cause` the longest wait among its failures. It returns `undefined` for an error without a usable wait and for any other value, and never throws

The `errors.isRetryable(error)` function now also accepts an Effect `Cause`, as `errors.outcome` does. It is true only when the `Cause` has at least one reason and every reason is a retryable failure, so a defect, an interruption or an empty `Cause` gives `false`

`EventContext` has a new `receipt` field that tells which event arrived first. The client numbers each event when it accepts it, starting at 1 and counting across all of its shards in the order events arrive. Every handler of an event sees the same number, and events decoded from one frame, such as `guildCreate` and its `voiceStateSnapshot`, get consecutive numbers in dispatch order. Handlers of one community can run out of order because of concurrency, partitions or `partitionReady`, so compare receipts to tell which event came first. Under a supervisor each child process numbers its own events

A validation error with Fluxer's code `INVALID_URL_FORMAT` now has an SDK explanation in its details. Fluxer sends this code for a URL field it does not accept, such as text that is not an http or https URL, a URL with a user name or password, or a host without a top-level domain

`AuditLogActions.MemberRoleUpdate` now documents the shape Fluxer records: A change with the key `roles` whose `oldValue` and `newValue` are the member's full role ID lists, so the added roles are those in `newValue` that `oldValue` lacks. A `MemberUpdate` entry that changes roles carries the same change

`TestDisconnectOptions` has a new `endSession` option, default `false`, in both testing entry points. With `endSession: true`, the test gateway forgets the shard's session before `disconnect` closes the connection, so the client's Resume gets Invalid Session and the client identifies a new session. As after a real session loss, the shard's `sessionEpoch` increases, the next event's context shows the higher value, and the cache release and new-session handling run. Use it with a recoverable close code, because a fatal code still ends the client. A value that is not a boolean throws `ConfigurationError`, and the native `disconnect` dies with it

Without `endSession`, a disconnect resumes the same session after every recoverable close code, including 4007 (invalid sequence), because the SDK starts a new session after that code only when it closes a Resume attempt. `TestDisconnectOptions.code` now says this
