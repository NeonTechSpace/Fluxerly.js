# @neontechspace/fluxerly

## 1000.0.0-rc.2

### Major Changes

- 2d263aa: Fluxerly needs Node.js 24.15 or newer, up from 24.11, because that is the oldest Node 24 release npm 12 supports

### Minor Changes

- a47b104: The package installs a `fluxerly` command. Running `npx fluxerly agents`, `pnpm exec fluxerly agents` or `bunx fluxerly agents` in an application's folder copies the SDK's rules for coding agents into its `AGENTS.md`, which coding agents read automatically, and records the installed SDK version. Running it again replaces only that section, and a broken section marker stops the command without changing the file

    The consumer guide at `consumer/AGENTS.md` starts with those rules, includes the starter bot and a Result check, and lists the differences from discord.js. The package's entry points name the guide in their overview

## 1000.0.0-rc.1

### Major Changes

- 7733b23: Make request errors say what to change. Rejections carry a `hint` for missing permissions or access, naming what a message send or a moderation action needs, unknown IDs, rejected tokens, invalid form fields, refused direct messages, two-factor requirements, slowmode, resource limits and temporary Fluxer failures, with a fallback by HTTP status for 401, 403 and 404.
  A rejected credential gets a hint for the credential the request sent: The webhook ID and token for a webhook client, the OAuth client ID and secret for an `invalid_client` error or a 401 from a code exchange, refresh, revocation or introspection, and the user's access token for a 401 from `fetchIdentity`, `fetchGuilds` or `fetchConnections`.
  Operation error messages lead with the failed operation and Fluxer's answer, for example `Message send failed: Fluxer reports that the bot lacks a required permission (MISSING_PERMISSIONS, HTTP 403)`, and explanations name Fluxer instead of "the provider"

    Keep Fluxer error codes that this SDK version does not describe yet. An uppercase code of up to 64 characters is recorded as `details.providerCode` and named in the message while `apiError` stays `null`, and an unrecognized validation code stays in `apiError.validationErrors` with its field path and a generic explanation. `OAuthOperationError` and `MessageCleanupError` keep unrecognized codes the same way.
    A response that does not match the expected shape names the failing field or check, such as `type` or `channelMismatch`, in `details.responseField` and logs a `rest.responseRejected` Warn. A message cleanup that fails in a history read or batch request copies that step's `details.responseField`. A `client.rest.request` route has no expected shape, so its unusable response is only returned in the Result.
    The `members.fetchCanManage` and `permissions.fetch` checks keep these facts and the failed step's error as `cause` when they report a failure under their own operation name.
    `OperationErrorOptions` and the `MessageError` and `MessageCleanupError` constructors accept `providerCode` and `responseField`, and the `OAuthOperationError` constructor accepts `providerCode`

    Log HTTP 401 and 403 rejections as a `rest.rejected` Warn with the Fluxer code and hint, even when the application handles the Result. When an event handler or command fails with the rejection and no `onError` hook receives the failure, the handler's failure record reports it instead, so one failed reply is logged once. Webhook clients and OAuth clients accept the same `logging` option as a client, so their rejected webhook tokens and OAuth client credentials are logged the same way. A rejected OAuth user access token concerns one user and is only returned. Like other Warn records, identical repeats within one minute are printed once by default, so a rejection that keeps happening shows about once a minute with a repeat count. Other client rejections are logged at Debug, and `rest.request` Debug records carry the Fluxer code in `fields.apiError`

    A `ConfigurationError` thrown by the default `createClient` or `runBot` points at the caller's line

    Migration: `ApiValidationErrorDetail.providerCode` is now `ApiValidationCode | (string & {})`, so code that assigns it to an `ApiValidationCode` must narrow it first.
    Operation error message text changed, so match on `code`, `reason` and `apiError` rather than on messages

- 7733b23: Ban durations are milliseconds, like member timeouts, command cooldowns and the `duration` command argument. The `BanInput` fields are now `durationMs`, 0 for a permanent ban or 60,000 through 63,072,000,000 for a temporary one, and `deleteMessagesMs`, 0 through 604,800,000. Both must be whole seconds and are sent to Fluxer in seconds. A rejected ban input names the failing field, such as `input.durationMs`, and states its whole-second range

    Audit-log entries report the message deletion of a member ban in milliseconds too, so the `AuditLogOptions` field `deleteMessageSeconds` is now `deleteMessagesMs`, in both API styles and in `guildAuditLogEntryCreate` events

    A `duration` command argument accepts `wholeSeconds: true`, which rejects a value with a millisecond part such as `1m500ms` and adds "in whole seconds" to the rejection reply. With `wholeSeconds: true`, `min: 60_000` and `max: 63_072_000_000`, the argument's value can be passed to `durationMs` unchanged, and a moderator's out-of-range value gets the usage reply instead of a failed ban

    Migration:

    - Replace `durationSeconds: n` with `durationMs: n * 1000` and `deleteMessageSeconds: n` with `deleteMessagesMs: n * 1000` in ban input
    - Replace `options.deleteMessageSeconds` with `options.deleteMessagesMs` on audit-log entries, and divide by 1000 where seconds are still needed

- 7733b23: The command argument types that pick from a fixed list are renamed to `userChoice`, `channelChoice` and `roleChoice`, next to `choice`, so the names `user`, `channel` and `role` no longer suggest a lookup in the message's community. They still select one of up to 100 `candidates` given at registration.
  The old names now fail registration with `ConfigurationError`, whose hint names `{ type: "id", mention }` for any ID or mention, `{ type: "member" }` for a member of the message's community when the old type was `user`, and the new list form

    Migration: Replace `type: "user"`, `"channel"` and `"role"` with `"userChoice"`, `"channelChoice"` and `"roleChoice"` in argument schemas, and in code that reads `CommandArgumentMetadata.type`

- 7733b23: Rename client members so each name states what it does and each concept uses one word across both entry points.
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

- 7733b23: The `EmbedBuilder.field` method takes its display setting as a named option, following the rule that settings are option objects rather than boolean positionals. The new `EmbedFieldOptions` type describes it

    Migration: Replace `field(name, value, true)` with `field(name, value, { inline: true })`, and drop a `false` third argument. A leftover boolean or other non-object third argument throws `ConfigurationError` with a hint naming `{ inline: true }`

- 7733b23: Base every SDK error on the exported `FluxerlyError` with a stable `code`, an optional fix `hint`, frozen `details`, a standard `cause` and `toJSON()`.
  Errors now keep the application or transport failure that caused them. A network failure is kept as a cause that records only the transport error code, such as `ECONNRESET`, never the transport message. API validation failures include the sanitized field path with each error code.
  Messages and `toJSON()` output mask credential patterns, including application text quoted by `ApplicationError` and `SdkDefect`, while `cause` keeps the original value.
  Masking applies to error text, `describeError` output and log records. It covers bare Fluxer bot tokens of the form `<application_id>.<secret>`, keeping the application ID. It also covers the value after an assignment to a key ending in `token` or `secret`, such as `FLUXER_BOT_TOKEN=`, the value after a quoted key such as `"botToken":`, and a credential-shaped value after an unquoted key and a colon, so prose such as `Missing token: check the configuration` stays readable

    Add `describeError(error)` for readable output with the code, hint, safe details and cause chain. It collapses stack frames inside the SDK and Effect into one line and prints no frames for expected SDK errors other than `ConfigurationError` and `SdkDefect`. It also accepts an Effect Cause and describes each failure, defect and interruption, so native programs can pass `exit.cause` directly. A thrown value that is not an Error is named `Non-Error value (string)` and similar.
    Add `errors` with `apiCode`, `isRetryable` and `match`. The `errors.apiCode(error)` helper returns the recognized Fluxer rejection category of an operation error, such as `"missingPermissions"` or `"twoFactorRequired"`, and undefined for every other value, so `errors.apiCode(result.error) === "missingPermissions"` works on any error of an operation's Result without checking its `_tag` first.
    A read that failed after it was sent records `details.read`, so `errors.isRetryable` treats it as safe to repeat, unlike a write with an unknown outcome.
    Add `ApplicationError` for failures raised by application callbacks such as a `runBot` `setup` or `commands` callback or a `keepTyping` task

    Migration: `MessageOperationError`, `ChannelOperationError`, `GuildOperationError`, `UserOperationError`, `WebhookOperationError`, `BotApplicationOperationError`, `AttachmentRefreshError`, `MessageCleanupError`, `MessageError` and `OAuthOperationError` now take one options object, described by `OperationErrorOptions` for the resource operation errors.
    Replace `new AttachmentDownloadError(reason, status, inputValidation)` with `new AttachmentDownloadError({ reason, status, inputValidation, cause })`. `CountOperationError`, `MemberChunkError`, `PaginationError` and `PresenceError` change the same way, taking `{ operation, reason, inputValidation, cause }`, `{ reason, retryAfterMs, inputValidation, cause }`, `{ operation, reason, inputValidation, cause }` and `{ reason, inputValidation, cause }`. `PresenceError` no longer defaults its reason to `input`, and omitted status, retry and input detail values still default to null.
    `ConfigurationError`, `ConnectionError`, `HelperError`, `AssetUrlError`, `CollectorError`, `EventWaitError`, `SupervisorError` and `SupervisorChildError` accept a trailing options object with `cause`. `ConfigurationError` also accepts `hint` there, and `ConnectionError` accepts `hint` and `details`

- 7733b23: Report every failure that has no returned result, including throwing event handlers, failed commands, collector callbacks and filters, cleanup progress callbacks, message cache callbacks, state observers and overflowing subscriptions.
  Each failure goes to the subscription's `onError`, then the client's new `onError` option, or is logged at Error with its full message, stack and cause chain.
  A `FailureReport` carries the original thrown value unchanged, its kind, and the event, command, subscription and message IDs involved, and `describe()` returns readable text. Native reports also keep the Effect cause

    A failure only queues its report. Each client, subscription and command router hook receives reports one at a time in order through its own bounded queue, so a slow hook never holds up handlers.
    Later reports are logged and counted instead, and a failing hook is logged together with the original failure without being retried.
    Shutdown interrupts running hooks without waiting for one that never finishes, and logs the interrupted and queued reports.
    Command routers now report failures with the command name, including failed `onUnmatched` callbacks and parsers, and rejected or unmatched commands are logged at Debug and counted

    Migration: `HandlerErrorReport` is replaced by `FailureReport`, and the message cache `onError` option and `CachePolicyErrorReport` are removed in favour of the client's `onError`.
    A message cleanup `onProgress` callback that throws, rejects or returns an Err is now reported to `onError` with kind `progress` instead of being ignored, and cleanup continues. The callback stays synchronous, so a returned Effect is not run and is reported as a `TypeError`.
    `SdkDefect` now keeps each fault's original value in `reasons` and its first fault as `cause`. A fault from an application callback, or a throw while the SDK reads caller-supplied options or input, such as a property getter or a caller AbortSignal's `aborted` getter or listener methods, has origin `application` and code `application.defect`. Other faults, including faults in SDK work around those reads, have code `sdk.defect`

- 7733b23: Invalid data from the Fluxer gateway, such as a frame that is not JSON, a second HELLO or READY, or a sequence that goes backwards, no longer ends the client at once. The shard logs the failure with `fields.reason` set to `protocol` and reconnects with a new session. Three such failures in a row without a healthy connection between them end the shard with a protocol `ConnectionError` as before. Oversized frames, invalid UTF-8, binary frames and `gateway: { onMalformedDispatch: "terminate" }` still end the shard without retrying

    Migration: A single invalid gateway message no longer ends `client.run`, because the shard reconnects. The protocol `ConnectionError` now arrives only after three such failures in a row

- 7733b23: The `runBot` function lets running work finish before it stops, in both entry points.
  When its `signal` aborts, or SIGINT or SIGTERM arrives with `processSignals: true`, the bot stops accepting new events and gives running handlers and commands, events already waiting for them and their REST requests up to 5,000 ms to finish. Then it shuts down as before and cancels whatever is left. The new `drainMs` option changes that time. A stop caused by a failure still shuts down at once. Sending the same process signal again ends the process at once with the default Node.js behavior

    Add `ShutdownOptions` with `drainMs` to `client.shutdown(options)` in both entry points for the same drain outside `runBot`. Without options, `shutdown()` still cancels running handlers at once.
    During a drain the connection state stays as it was, new subscriptions and event waits start closed, and handlers can still send requests. The drain ends as soon as no work is left, logging `lifecycle.drained`. When the time runs out, a `lifecycle.drainTimedOut` Warn record names how many handlers, events and requests were cut off. A `lifecycle.draining` Info record marks the start.
    An invalid `drainMs` throws `ConfigurationError` in the default API and dies with it in the Effect API

    Supervised children drain the same way when the supervisor stops them, for up to the supervisor's `shutdownTimeoutMs` minus one second, which keeps that second for closing the connection. A child whose client stopped on its own is not drained

    Migration: To keep cancelling running handlers as soon as the bot is asked to stop, pass `drainMs: 0` to `runBot`

- 7733b23: Cache entries for communities, which Fluxer calls guilds, and for members, roles, emojis, stickers and channels now survive a successful Resume, because Fluxer replays every missed event on Resume or refuses the session. They are cleared when a shard has to start a new session. Users, direct messages and messages are still cleared on every lost connection

    A `guildCreate` event now fills the enabled role, emoji, sticker and channel caches from its snapshot and replaces that community's earlier entries, so a new session rebuilds them without REST requests. Members are not filled, because the snapshot lists only a few

    Migration: Code that relied on community caches being empty after a reconnect should call `guilds.fetch` and the other fetch methods when it needs current state, since a cached entry now stays across a Resume

- 7733b23: Skip a known gateway event that fails validation instead of ending the client. The SDK logs `gateway.dispatchRejected` with the event type and failing field path, clears cache entries the event could have changed and counts it.
  Set `gateway: { onMalformedDispatch: "terminate" }` to end the shard with a protocol `ConnectionError` instead

    Add an `overflow` handler option with `stop`, `dropOldest` and `dropNewest` policies. Every dropped event is logged at Warn and counted in `diagnostics().counters.eventsDropped`.
    Handlers registered with `client.on` drop the oldest waiting event by default when their queue is full, as `runBot` handlers and command routers do, and the handler keeps running.
    An unknown event name fails with `ConfigurationError` whose hint suggests the closest valid name when one is similar

    Migration: A full `client.on` queue no longer ends the subscription. To keep that behavior, where `waitForClose` returns `EventOverflowError`, pass `{ overflow: "stop" }` to `client.on`. The `subscribe` streams, event waits and collectors still end on overflow.
    Event handlers passed to `runBot` now run `messageCreate` up to eight at a time and drop the oldest waiting event when their queue is full instead of stopping the bot.
    Pass `{ handler, concurrency, overflow, maxPendingMessages, maxPendingBytes, onError }` instead of a function to change this per event. Command routers attached without options, or with undefined settings, also run up to eight commands at a time and drop the oldest waiting message

- 7733b23: Each helper has one public name, and the role hierarchy helpers join the other pure helpers in a namespace:

    - The top-level `createPkce` export is removed. Use `oauth.createPkce`, which is unchanged
    - The `hierarchy` namespace replaces `canManageHierarchy`, `compareHierarchy` and `isAboveInHierarchy` with `hierarchy.canManage`, `hierarchy.compare` and `hierarchy.isAbove`. The `HierarchyHelpers` type describes it

    Migration: Replace `createPkce()` with `oauth.createPkce()`, and each loose hierarchy function with its `hierarchy` method

- 7733b23: Reject misspelled and unsupported top-level option keys in `createClient`, `runBot` and `supervisor.create` in both entry points with `ConfigurationError`, whose hint names the closest supported key, such as `events` for `event`.
  The `clientOptions` of `supervisor.child.run` are checked the same way, where an unknown key was silently dropped before, so the child client ran without it.
  Unsupported keys in the nested `logging`, `cache`, `cache.messages`, `cache.<kind>`, `connection`, `connection.recovery`, `uploads`, `gateway`, `sharding`, `instance` and supervisor `restart` settings are named in the message with the same suggestion, and a removed logging setting names its replacement

    Normalize the configured token: Surrounding whitespace and one pair of matching quotes, which `.env` files often add, are removed.
    A token that starts with a `Bot` or `Bearer` scheme is rejected with `ConfigurationError`, since the SDK adds the `Bot` scheme itself.
    The `auth.rejected` hint suggests checking the configured value before regenerating the token

    Migration: Remove option keys that `createClient`, `runBot`, `supervisor.create` or the `clientOptions` of `supervisor.child.run` do not support, including unknown nested keys such as a `connection` key other than `startupTimeoutMs`, `maxStartupAttempts` and `recovery`, and pass the bare token without a `Bot ` or `Bearer ` prefix

- 7733b23: Return plain values from the local helpers in both entry points, and throw their existing error for invalid input, which indicates a programming mistake.
  This covers `format`, `snowflakes`, `permissionBits`, `colors`, `text.split`, `links`, `assets`, the role hierarchy helpers in `hierarchy` and the `assets` and `links` helpers returned by `client.instance.resolve()`.
  Invalid input throws the same `HelperError`, `AssetUrlError` or `GuildOperationError` with the same `operation` and `reason` that the Result or Effect previously carried.
  In the native API such a throw inside Effect code becomes a defect rather than a typed failure

    Add `format.tryParseMention`, `format.tryParseTimestamp`, `format.tryParseCustomEmoji`, `snowflakes.tryParse` and `colors.tryParse` for text received from users.
    They apply the same rules as their plain counterparts without throwing, returning a Result in the default API and an Effect that fails with `HelperError` in the native API

    Migration:

    - In the default API, helpers such as `format.userMention(id)` now return plain values directly, so drop `isOk()`, `value` and `_unsafeUnwrap()` handling from helper calls, and catch `HelperError` only where invalid input is possible
    - In the native API, helpers are no longer Effects, so drop `yield*` and `Effect.runPromise` around calls such as `format.userMention(id)`, `links.installation(id)`, `assets.displayAvatar(user)`, `hierarchy.canManage(input)` and `resolved.links.channel(target)`
    - Parse untrusted text with `format.tryParseMention(text)`, `format.tryParseTimestamp(text)`, `format.tryParseCustomEmoji(text)`, `snowflakes.tryParse(text)` or `colors.tryParse(input)` instead of `parseMention`, `parseTimestamp`, `parseCustomEmoji`, `snowflakes.parse` or `colors.parse`, which now throw
    - Native code that deferred validation by building a helper Effect before its input changed now reads the input when the helper is called

- 7733b23: Make public types describe what Fluxer actually sends and what builders accept.
  `GuildChannel` is a union of `GuildTextChannel`, `GuildVoiceChannel`, `GuildCategoryChannel`, `GuildLinkChannel` and `GuildUnknownChannel`. Comparing `channel.type` with a `ChannelType` constant narrows it to exactly that shape, so `if (channel.type === ChannelType.Voice)` yields a `GuildVoiceChannel`. A channel type this SDK version does not know arrives as a `GuildUnknownChannel` whose `type` is `"unknown"` and whose `rawType` holds the number Fluxer sent, so a `switch` on `type` that also handles `"unknown"` is exhaustive.
  `PresenceUpdate.status` is an `ObservedPresenceStatus`, and an unrecognized status from Fluxer becomes `"unknown"` instead of an arbitrary string.
  `EmbedBuilder.color` accepts any `ColorInput`, such as `"#ff8800"` or an RGB tuple, and `EmbedBuilder.timestamp` accepts a `Date`, epoch milliseconds or an ISO string. An invalid color, or an invalid `Date` or number, throws `HelperError` with operation `embed.color` or `embed.timestamp`.
  The type error from calling `build()` on an empty `MessageBuilder` now names the missing body, through the exported `MissingMessageBody` type.
  Default clients, OAuth clients, webhook clients, subscriptions and collectors support `await using`, which shuts a client down or closes a subscription or collector and waits for its cleanup

    Migration:

    - Narrow a `GuildChannel` on `type`, for example with `ChannelType.Voice`, before reading `bitrate`, `userLimit` or other fields that belong to one channel type
    - Handle channel types outside `ChannelType` by checking `channel.type === "unknown"` and reading the Fluxer number from `channel.rawType`. A numeric `type` no longer carries an unknown type
    - Compare `PresenceUpdate.status` against the listed values and handle `"unknown"` instead of Fluxer strings outside that list
    - `EmbedBuilder.color(value)` converts its input, so pass the color directly rather than converting it first. A number outside the 24-bit range now throws
    - `EmbedBuilder.timestamp(value)` converts a `Date` or number with `toISOString()`. An invalid `Date` or number now throws instead of producing an invalid embed

- 7733b23: Public types now use one name per concept, and API rejection details are readable in the reference, in both entry points

    - `MemberSearchHit.globalName` and `OAuthIdentity.globalName` are now `displayName`, the name `User` and `MessageUser` already use for the account-wide display name. The `display.name` helper therefore reads it from member-search hits and OAuth identities too
    - The deprecated `MessageMention` alias is removed. `MessageUser` is the only name for the partial-user shape in mentions and references
    - `ApiErrorDetail` and `ApiValidationErrorDetail` are plain interfaces. The new `ApiErrorCode`, `ApiProviderCode` and `ApiValidationCode` unions list every recognized category and server code to branch on. The `explanation` fields are typed `string`, and `validationErrors` is present only when `code` is `invalidFormBody`
    - The `@neontechspace/fluxerly/effect` entry point no longer exports the ten default-API option types `DefaultMemberChunkOptions`, `DefaultCountOperationOptions`, `DefaultBotApplicationOperationOptions`, `DefaultExpressionDeleteOptions`, `DefaultUserOperationOptions`, `DefaultWebhookOperationOptions`, `DefaultAttachmentDownloadOptions`, `DefaultAttachmentRefreshOptions`, `DefaultAttachmentStreamOptions` and `DefaultMessageCleanupOptions`. No Effect member accepts them

    Migration:

    - Read `displayName` instead of `globalName` on `MemberSearchHit` and `OAuthIdentity`
    - Replace `MessageMention` with `MessageUser`
    - Use `ApiErrorCode`, `ApiProviderCode` or `ApiValidationCode` to branch on codes. Code that compared `explanation` against literal types compares strings instead
    - Effect code that imported a `Default*` option type imports it from `@neontechspace/fluxerly`, or uses the Effect option type of the same operation

- 7733b23: Return a Result or a failing Effect only where a failure can happen at runtime, such as a request, a gateway command, an event wait or a collector's outcome.
  Local setup returns its value directly: Creating clients, registering handlers, creating command routers and reading caches.
  Misuse of that setup, such as invalid options, a missing token or an unknown event name, throws `ConfigurationError` in the default API and is a defect in the native API, so a misconfigured bot fails at startup instead of returning an easily ignored Err.
  An Err returned or resolved by an application callback, including event and command handlers, guards, middleware, collector callbacks, `onError` hooks, state observers and supervisor configuration, is now reported like a throw of its error

    The default API exports `orThrow`, which returns a Result's value or throws its error and also accepts a Promise of a Result, and re-exports the `Result` and `ResultAsync` types.
    Callback return types accept `unknown`, and handler, collector and supervisor signals are typed as `AbortSignal`.
    A missing or blank `token` is accepted by the types as `string | undefined` and throws `ConfigurationError` with a hint that the environment variable holding it is probably unset

    Migration:

    - Default `createClient(options)`, `createWebhookClient(options)`, `oauth.create(config)` and `supervisor.create(options)` return the client or supervisor directly. Drop `isErr()`, `value` and `_unsafeUnwrap()` handling and catch `ConfigurationError` only where options come from untrusted input
    - Native `createClient`, `createWebhookClient`, `oauth.create` and `supervisor.create` no longer fail with `ConfigurationError`. Invalid options become a defect, so handlers for that typed failure can be removed
    - Default `client.on(event, handler)` returns the `Subscription`, `client.subscribe(event)` returns the `EventSubscription`, and `messages.collect(...)` and `messages.collectReactions(...)` return the collector directly. A gateway that is not ready or an aborted signal now appears in the collector's `result()` instead of the creation result. Native `on`, `collect` and `collectReactions` no longer fail, and a native `subscribe` stream fails only with `EventOverflowError`
    - Cache lookups such as `client.messages.get(reference)` return the cached value or `undefined` directly, and return `undefined` after shutdown instead of `ClientClosedError`. A malformed ID throws the namespace's operation error with reason `input` in the default API and is a defect in the native API. Native lookups otherwise return an Effect that never fails
    - The default `client.cache.entries(kind)` returns the array directly, and native `cache.entries` never fails
    - The `client.permissions.calculate(input)` method returns the `bigint` directly in both entry points and throws `GuildOperationError` with reason `input` for inconsistent data
    - Command routers return values directly in both entry points. The `commands.create`, `register`, `registerMany`, `registerGroup`, `help` and `commands.memoryCooldowns()` calls throw `ConfigurationError` for invalid definitions, and the default `attach` returns the `Subscription`. Drop `yield*` in front of those calls in native code, where `attach` remains an Effect
    - A default cooldown store's `claim` returns the claim or a Promise of it rather than a Result
    - Callbacks that returned an Err to signal an ignored outcome now report a failure. Return nothing, or handle the Result inside the callback, when the failure is expected
    - The `RegistrationError` and `CollectorRegistrationError` exports are removed, because registration misuse now throws `ConfigurationError` and a registration during shutdown returns a closed handle
    - TypeScript consumers that read handler signals or use `await using` need `AbortSignal` and `AsyncDisposable` from the Node.js types, for example `"types": ["node"]`

- 7733b23: Command `id` arguments now accept only IDs in the 64-bit ID range, in both entry points. A valid ID is a nonzero decimal without leading zeroes, up to `9223372036854775807`.
  The same limit applies to IDs inside the accepted mention forms.
  The value `0` and longer or larger values are now rejected as `Invalid` before the command runs.
  Commands that relied on `0` or out-of-range tokens reaching the handler need a `custom` argument instead
- 7733b23: Command cooldowns no longer turn users away because a memory store is full, and commands can be hidden from help and suggestions, in both entry points

    - A memory cooldown store never refuses a new key. When it is full, it removes expired keys first, then the reservation that expires soonest, which lets that key run again early. This applies to `commands.memoryCooldowns()` and to each router's own store
    - The default limit rises from 1,024 to 10,000 keys, and the router option `cooldowns: { maxEntries }` sizes a router's own store, for example `commands.create({ prefix: "!", cooldowns: { maxEntries: 50_000 } })`
    - Commands and groups accept `hidden: true`. Generated help leaves them out, along with everything inside a hidden group, and selecting a hidden group in `help` throws `ConfigurationError` as for a missing one. Hidden commands still run when invoked, so guard the ones that need it

    Migration:

    - The `CooldownCapacity` claim and the `CommandCooldownCapacity` rejection are removed, because a built-in store no longer refuses a key. A custom store returns only `CooldownAcquired` or `CooldownActive`, and any other claim fails the command with `ConfigurationError`. Code that handled either removed tag can drop that branch
    - Code that relied on the old limit of 1,024 keys, for example to cap memory, passes `maxEntries` to `commands.memoryCooldowns` or the router's `cooldowns` option
    - Owner-only and other private commands that must not appear in help set `hidden: true` instead of filtering them in every `help` call's `include`

- 7733b23: Registering a subscription or collector after client shutdown has begun no longer fails with `ClientClosedError` at registration, in both entry points. A handler that is still running when shutdown starts can register, which is a runtime race rather than misuse

    - A `client.on` or `client.subscribe` registration, including a command router's `attach`, returns an already-closed subscription. Its handler never runs, `waitForClose` succeeds and the default `next` returns `Ok(null)`. The native `subscribe` Stream ends without events. Each such registration writes a Warn log record with code `events.registeredAfterShutdown`
    - A `messages.collect` or `messages.collectReactions` registration returns a collector whose `result` fails with `ClientClosedError`, as it does for a collector already running when shutdown starts
    - Invalid arguments are misuse and throw or die with `ConfigurationError`, whatever the client state. Registering middleware with `client.use` on a closing client throws or dies with `ClientClosedError`

    Migration:

    - Code that handled `ClientClosedError` from these registrations reads the handle instead. Check `client.state`, or read the collector's `result` for `ClientClosedError`

- 7733b23: Configure a whole bot with one `runBot` options object in both entry points.
  A `commands` option routes prefix commands, `setup` runs after every handler is registered and before the connection starts, and `onError` and `processSignals` sit beside them.
  The `runBot` function checks every option, including event names, event delivery settings and client settings, before any client, process signal listener or request exists, even when the `signal` is already aborted. Invalid configuration throws `ConfigurationError` at the call, or is a defect in the native API.
  It then creates the client and registers every event and command synchronously. An aborted `signal` with valid options returns success without creating a client.
  A failed `setup` or an application error thrown by a `commands` register callback is an application failure, reported as `ApplicationError` with the original value as `cause`. In the default API, a `setup` callback that throws, rejects or returns an Err gives `source` `"runBot setup"`, and in the native API a failed `setup` Effect gives the same. A register callback that throws gives `source` `"runBot commands"` in both APIs. A failed `setup` stops the bot before connecting and shuts down its client, and a failed register callback stops it before any client exists. Misuse inside the register callback is `ConfigurationError`, and an `SdkDefect` or a native defect keeps its original cause

    Commands gain features for common bot needs:

    - The `guard` option accepts one guard or an array, and a guard can return `{ deny: "reason" }`. The exported `guards` provide `guildOnly()`, `dmOnly()`, `ownerOnly(ids)` and `requirePermissions(names)`
    - The `guildOnly()` guard allows a message sent in a community, which Fluxer calls a guild, and denies every other message without a request. The `dmOnly()` guard allows only a confirmed one-to-one or group conversation: It checks the direct-message cache, then the channel cache, and otherwise reads the channel once with `directMessages.fetch`, which also fills an enabled direct-message cache. A community channel is denied, and any other failed read fails the command and is reported with the command name. In the Effect API, its error type is `UserOperationFailure`
    - The `requirePermissions(names)` guard reads cached community, member, role and channel data first. It reads a cached channel that lacks its overwrite list again, and evaluates a channel that Fluxer returns without one from the member's role permissions
    - The `cooldown` option accepts `{ durationMs, per }` with `per` set to `"user"`, `"channel"` or `"guild"`, and uses a memory store owned by the router when `store` is omitted
    - The router's `use` option adds middleware that wraps every command and can stop it by not calling `next`. In both APIs, `next` fails with the command's own error, and each middleware stage and the command run at most once per message, even when `next` is called again or evaluated concurrently. A command failure is reported once with its command name, whatever the middleware does with it. Middleware that fails with a different error adds its own report after the command's failure
    - Setting `onReject: "reply"` sends a short explanation, such as `Missing name. Usage: !greet <name>`, the guard's reason or the cooldown's remaining time. The commands of `runBot` use it by default, while a router from `commands.create` gives no feedback unless `onReject` is set. Setting `onReject: "silent"`, on a router or on one command, sends nothing, and the rejection is still counted and logged at Debug as `commands.rejected`. An active cooldown key is answered once until its retry time, and a guard denial once per user and command every 5 seconds, while argument rejections are answered each time. A skipped reply still counts as a rejection and is logged at Debug with `feedbackSuppressed`. An `onReject` function receives every rejection. Native replies measure the remaining time with the handler's Effect Clock
    - Setting `mentionPrefix: true` accepts a mention of the bot, `<@id>` or `<@!id>`, as a prefix, and the `prefix` option can be resolved asynchronously. The bot's ID comes from the user in the gateway's READY. When READY lacks it, one shared `users.fetchSelf` read supplies it, and a failed read is logged at Warn and retried after a backoff that starts at 5 seconds and doubles up to 5 minutes
    - An unknown command name passed to `onUnmatched` and its Debug `commands.unmatched` log record carry `suggestion`, the closest registered command or group name when one is similar. Two swapped adjacent characters count as one edit, so `pnig` suggests `ping`. Hidden commands and everything inside a hidden group are never suggested
    - The bound `reply` accepts a plain string
    - Argument descriptors add `min`, `max` and `default` for integers and numbers, and new `duration`, `member` and `custom` types. A `member` argument accepts only IDs in the 64-bit ID range, as `id` does. A `custom` parse function is synchronous: A returned Err fails the command like a throw, and a returned Promise or Effect is not run as the value but fails the command with `ConfigurationError` for field `command`, without an unhandled rejection

    Migration:

    - The `runBot(options, install, runOptions)` form is removed. Move event handlers into `events`, commands into `commands`, other startup work into `setup(client)`, and `runOptions` settings such as `signal` and `processSignals` into the options object
    - Code that checked `runBot`'s Result for configuration failures catches the thrown `ConfigurationError` instead. The Result reports connection failures, cancellation and stopped workers as before, and a failed `setup` or `commands` callback as `ApplicationError`. A handler set to `overflow: "stop"` that overflows is reported and the bot keeps running without it, so `EventOverflowError` is no longer part of the `runBot` error type in either API. Remove its case from code that matches on `runBot` failures
    - `CriticalWorkerStoppedError.workerIndex` counts event subscriptions in configuration order, followed by the command router
    - A cooldown without `store` no longer requires one. Pass `per` instead of building the key from the message when the default key fits
    - Keyed `registerMany` entries may omit `arguments` for unrestricted raw args. TypeScript projects with `exactOptionalPropertyTypes` omit it rather than pass `arguments: undefined`
    - The commands of `runBot` now answer a rejected command. Set `onReject: "silent"` in the `commands` option of `runBot` to keep rejected commands unanswered. Unmatched commands, and rejected commands of a router from `commands.create`, still get no reply unless `onUnmatched` or `onReject` asks for one

- 7733b23: The `runBot` function reports a failed run for the process by default, in both entry points.
  When the bot stops because of a failure, it logs that failure once as an Error record with code `lifecycle.botFailed` and sets `process.exitCode` to 1. It skips the record when the client already logged the same error, such as the `lifecycle.connectionEnded` record of a rejected token, so the failure appears once. The failure is still returned, and a normal stop or an interruption reports nothing. The native API also reports a defect this way, including misuse found before any client exists, such as a missing token or a misspelled option key. In the default API, misuse throws `ConfigurationError` and a defect rejects with `SdkDefect`, which Node.js prints before it exits with a failing code.
  A bot entry point therefore needs no try/catch: `await runBot({ ... })` is complete in the default API, and so is `await Effect.runPromiseExit(runBot({ ... }))` in the native API

    Migration: Code that already logs the returned failure and sets the exit code can drop that handling. To keep full control of the failure output and exit status, pass `reportFailure: false`

- 7733b23: Forward each supervised child's output in the supervisor's console format by default, and add the `childOutput` supervisor option with `prefix`, `inherit` and `ignore`.
  Readable output labels each line with its shard or child ID. JSON output stays valid JSON Lines: A child's SDK record gains `fields.child`, another JSON object passes through unchanged and other text becomes a `supervisor.childOutput` record.
  With `prefix`, children receive the supervisor's format and color through `FLUXERLY_LOG_FORMAT` and `FLUXERLY_LOG_COLOR` unless those variables are already set. Very long lines are truncated with a marker, forwarding respects output backpressure, and exit handling waits briefly for a child's final output, such as a crash stack trace.
  The supervisor now logs child start, exit, crash, restart and spawn failures, and spawn errors keep their original cause. The new `logging` supervisor option accepts the client logging settings for these records

    Migration: Supervised child output was previously discarded. Set `childOutput: "ignore"` to keep discarding it

- 7733b23: Supervisors now restart a crashed child by default, with the documented defaults of `SupervisorRestartOptions`: Up to 3 restarts in a row, delays from 1,000 ms doubling up to 30,000 ms, and a fresh budget after 60,000 ms of healthy running. Previously an omitted `restart` option meant that one crashed child stopped the whole supervisor and took every shard offline. The `restart` option now also accepts `false`, and the `supervisor.crash` record names that setting when it stops the supervisor

    Restart budgets now count consecutive crashes instead of every crash over a child's lifetime. A child that runs for the new `restart.healthyResetMs` (default 60,000 ms) after finishing configuration gets its full budget and the first delay back at its next exit. When that restores used restarts, the `supervisor.restart` record has `fields.budgetReset` set to true. A crash loop still exhausts `maxAttempts` and stops the supervisor

    Migration:

    - To keep the previous behavior, where one unexpected child exit stops the supervisor, set `restart: false`
    - To keep a lifetime-wide budget in practice, set `restart.healthyResetMs` to a period longer than the expected process lifetime, up to 2,147,483,647 ms. The `restarts` count in `status()` child snapshots also starts again after such a reset

- 7733b23: Check every validated timestamp, whether received from Fluxer or supplied as a pin cursor, community history cutoff or embed time, with one ISO 8601 grammar: A date, `T`, hours, minutes and seconds, an optional fraction of any length and a `Z` or `±hh:mm` offset, on a real calendar day.
  Accepted values stay exactly as received or supplied. Custom status expiry inputs keep their own rules, which also allow omitting seconds, and attachment expiry times remain unchecked text.
  `GuildEdit.messageHistoryCutoff` now accepts an offset instead of only UTC, discovery times and community history cutoffs from Fluxer accept offsets, and pin cursors and message, pin and community times accept fractions longer than nine digits

    Migration: Member join and timeout times, invite times, ban times and channel last-pin times received in any other form, such as without seconds or a zone, are now rejected. Before, only the date was checked and `Date.parse` had to accept the value

- 7733b23: Every operation that takes an input, query or options object rejects a key it does not support before sending anything, in both API styles. The failure is the operation's own error with reason `input` and an `inputValidation` constraint of `allowedFields`. Its explanation names the key, suggests the closest supported key and lists the supported keys, for example `Unsupported option "timeout" in the operation options. Did you mean "timeoutMs"? Supported options are timeoutMs, signal`

    Operations that sent the request and ignored an unknown key before now reject it: The options of message sends, replies, forwards, edits, deletions, fetches, searches, pins and reactions, the OAuth `authorizationUrl`, `exchangeCode` and `revoke` inputs, and the default API `gateway.send` options. Channel position entries and permission overwrites report an unsupported key separately instead of as a general format failure. The `instance.resolve` and `cache.entries` options name an unsupported key and suggest the closest one in their `ConfigurationError`

    Migration: Remove keys that an operation does not support from its input, query and options objects. Each failure names the first unsupported key it finds

- 7733b23: Log startup, readiness, lost connections with the close-code meaning and the real next step, session resets, long rate-limit waits, event drops, shutdown and every application failure by default.
  Records share one shape with a level, category, stable code, message and safe fields, and never contain the token, authorization values, client secrets, webhook tokens or invite codes

    Configure output through `logging` with `level`, per-category `categories`, `debug`, `format`, `sink`, `dedupe` and `unsafe` settings, or set `FLUXERLY_DEBUG=1` or a list of categories for Debug records.
    The default API prints readable lines in a terminal and JSON lines otherwise, deciding separately for standard output and standard error. Readable lines show the record code after the category, print safe details for every error in the cause chain and collapse stack frames inside the SDK and Effect into one line. The `FLUXERLY_LOG_FORMAT` and `FLUXERLY_LOG_COLOR` environment variables choose the format and color for a client without `format`. The color variable accepts `1`, `true`, `yes` or `on` to force color and `0`, `false`, `no` or `off` to disable it, and an unrecognized value of either variable logs one `sdk.unknownEnvironmentValue` Warn.
    Without `sink` or `format`, the native Effect API logs through the caller's Effect logger with `fluxerly.*` annotations, including `fluxerly.error.code`, `fluxerly.error.hint` and `fluxerly.error.*` details for a failure. Each error in the cause chain adds its own annotations under `fluxerly.error.cause.`, then `fluxerly.error.cause.cause.` and so on. Its records carry masked copies of failures that show their code, so Effect's cause printer never shows credentials or extra error properties.
    Repeated Warn and Error records are collapsed with a repeat count, and `diagnostics().counters` counts failures, drops, retries, rate-limit waits, reconnects and resumes.
    A rate limit whose wait would pass the request deadline fails the request at once, logs `ratelimit.deadline` and is not counted as a wait.
    Failure reports logged instead of reaching an `onError` hook carry `fields.reportOutcome` (`queueFull`, `interrupted`, `clientClosed` or `subscriptionClosed`), and collapsed records carry the suppressed count in `fields.repeated`.
    The `lifecycle.retry` and `lifecycle.connectionLost` records carry `fields.next`, which is `resume` or `identify` and names the next handshake

    Unsafe payload logging prints its Warn banner once before the first payload record at any level, prints nothing for a `silent` category and reads at most the first 64 KiB of each received REST body

    The native API also records `fluxerly.*` tracing spans for gateway connection, REST requests, event handling and command execution, plus REST duration, rate-limit wait, reconnect, drop and handler-failure metrics

    Migration: The `development`, `measurements`, `minimumLevel` and `logger` logging settings, `fromStructuredLogger` and `fromEffectLogger` are removed.
    Use `level` and `categories` for levels, `debug` or `FLUXERLY_DEBUG` for Debug records, and `sink` to forward records to another logger.
    The types `DefaultLogger`, `DefaultLoggingOptions`, `StructuredLogger`, `SdkLifecycleEvent`, `SdkLifecycleLogRecord`, `SdkOperationalLogRecord`, `SdkMeasurementLogRecord`, `SdkMeasurementOperation` and `SdkMeasurementStage` are removed. `SdkLogLevel` is renamed to `LogLevel` and its values are now lowercase, such as `"info"`. The `All` and `None` values are removed, and `level: "silent"` replaces `None`. `SdkLogRecord` is renamed to `LogRecord`, which has a new shape.
    Clients now print startup, readiness, connection loss and shutdown at Info by default. Set `level: "warn"` to print only problems.
    The Effect API's `MessageCacheOptions<E, R, M>` is now `MessageCacheOptions<M>`, because cache callback failures go to the client's `onError` rather than a cache-specific hook

### Minor Changes

- 7733b23: A client logs one `lifecycle.connected` record once every shard it owns is connected, such as `Connected to Fluxer as MyBot in 3 communities`. When the bot owns every shard and is in no community, the record is a Warn that includes the bot's installation link

    Loading any entry point on a Node.js version older than 24.11 throws an error that names the required and the found version, instead of failing later with an unrelated error

    Several configuration errors explain the likely fix:

    - An event named `ready`, `clientReady`, `onReady` or `connected` points to the connected record, the `setup` option of `runBot` and `client.connect()`
    - An unsupported command argument type suggests the supported type it most likely meant, such as `text` for `string`, and lists every supported type
    - A missing bot token mentions `node --env-file=.env bot.js`, the current folder and a `.env` file saved as `.env.txt`
    - A command definition placed next to `prefix` in the `commands` option of `runBot` is explained as belonging in the inner `commands` object, an unknown key there lists `commands` and `onError` among the supported keys, and a missing `prefix` is reported as required

- 7733b23: Add `client.cache.onChange(listener)` to observe changes to the client's local caches as `{ kind, op, key }` records, where `op` is `set`, `delete` or `clear`.
  Every cache kind reports stored and replaced entries, removals including expiry and capacity eviction, and whole-kind clears from `cache.clear()`, connection gaps of unknown scope and shutdown.
  Keys use decimal IDs, such as `channelId:messageId` for messages and `guildId:userId` for members.
  Changes are delivered in applied order after the cache work that produced them, a failing listener is reported as a cache failure, and no change is recorded while no listener is registered
- 7733b23: Add the `callCreate`, `callUpdate`, `callDelete` and `entranceSoundPlay` events for Fluxer's CALL_CREATE, CALL_UPDATE, CALL_DELETE and ENTRANCE_SOUND_PLAY dispatches, with frozen `CallCreate`, `CallUpdate`, `CallDelete` and `EntranceSoundPlay` payloads.
  Call participants use `CallVoiceState`, which omits Fluxer's internal voice routing fields.
  A malformed dispatch of these types is skipped and counted like other malformed events, without clearing any cache
- 7733b23: Add the `observe` client option to export metrics and traces from either entry point to any monitoring system.
  The observer receives one frozen `Observation` for each finished REST request attempt, with its method, route template, status, duration and attempt number, each rate-limit wait, each reconnection attempt, each resumed session, and each finished handler or command invocation, with its duration, outcome and the error name and code of a failure.
  Observations never contain tokens, payloads or message content, and route templates replace IDs with placeholders.
  The observer runs synchronously and independently of the logging settings. An observer that throws is counted in `diagnostics().counters.sinkFailures` without changing SDK work. The Effect API keeps its Effect metrics and spans and calls the same observer
- 7733b23: Command contexts in both entry points gain `help(options?)`, which builds help pages from the router that matched the command, so a `help` command works in the keyed `commands` object of `runBot` without a reference to the router.
  The prefix defaults to the one the invoking message used and the page length to 2,000 UTF-16 code units. The other settings match `router.help`, and the new `CommandContextHelpOptions` type describes them. For example: `help: { execute: ({ help, reply }) => reply(help()[0] ?? "No commands") }`
- 7733b23: Make errors and log records say what went wrong and what is accepted. `HelperError` and `AssetUrlError` messages name the helper and the accepted form, for example `Helper operation format.userMention failed: IDs must be decimal strings from 0 through 9,223,372,036,854,775,807`, instead of `Invalid input for format.userMention`.
  `PaginationError` messages include the input explanation or what stopped the iteration, and the error carries a `hint`: The rejected path for invalid settings, raising `maxPages` for `pageLimit`, and retrying later for `cursorStalled` and `indexing`

    Input validation explanations name the field in words and state the accepted range with its unit, such as `ms`, `bytes` or `seconds`. Presence explanations name the field they describe, unsupported-field explanations list the accepted fields or the type that defines them, timeouts state their `ms` unit, and ban and timeout durations state their range in `ms` with the matching days or years.
    Connection, startup and shutdown records use full sentences, such as `Shard 1 lost its connection. Close code 4000 (UNKNOWN_ERROR): The gateway reported an unspecified error. Reconnecting and resuming the session in 486 ms`, and configuration errors name the full option path, such as `connection.startupTimeoutMs`. `SupervisorError` and `SupervisorChildError` messages describe the failure and carry a hint. An instance discovery failure keeps its transport error code and says what was wrong with the response.
    `CancelledError` accepts an optional operation, which is recorded as `details.operation` and named in the message, and its hint explains that signals the SDK passes to handlers abort when the client shuts down

    The `inputValidation.path` and `constraint` values are unchanged. Messages remain changeable text, so match on `code`, `reason`, `field` and `inputValidation` and on log record codes instead

- 7733b23: Provide a native client as an Effect service with `FluxerClient` from the Effect entry point.
  `FluxerClient.layer(options)` creates the client in the layer's scope and shuts it down when that scope closes.
  `FluxerClient.layerConfig({ token: Config.Redacted("FLUXER_BOT_TOKEN") })` reads the token, and optionally any other top-level setting, from Effect `Config`. The token stays redacted until the client receives it.
  A missing Config value fails the layer with `ConfigError`, while a blank token or another invalid setting dies with `ConfigurationError`.
  Building either layer does not connect. Register handlers, then call `client.connect()` or `client.run()`
- 7733b23: Add `FluxerTestClient` to `@neontechspace/fluxerly/effect/testing` for applications that read their client from the `FluxerClient` service.
  `FluxerTestClient.layer(options)` creates a test client with `createTestClient` and provides its client as `FluxerClient` and the whole test client, with its controls, as `FluxerTestClient`. Application code then runs against the in-memory Fluxer unchanged.
  Closing the layer's Scope shuts the client down and dies with `UnhandledTestFailuresError` for a handler failure the test did not read
- 7733b23: Read the community that owns a custom emoji or sticker with `emojis.fetchSource(id)` and `stickers.fetchSource(id)` in both entry points. Fluxer calls a community a guild.
  The result is a frozen `ExpressionSourceGuild` with the community's `id`, `name`, `icon` hash and badge `features`.
  Fluxer answers when the source community is discoverable or the bot is a member of it. A private or unavailable source community fails with `GuildOperationError` whose `apiError.code` is `unknownResource`.
  Badge names added by Fluxer later are kept rather than failing the read, and a response missing any documented field fails with reason `response`
- 7733b23: The `members.fetchCanManage` method accepts `actorUserId` to check whether another member, such as the moderator who ran a command, outranks the target instead of the bot. It reads that member in place of the bot's own membership, and an invalid ID fails with reason `input` before any request. The option types are `CanManageOptions` and `DefaultCanManageOptions`
- 7733b23: Recognize Fluxer's `TWO_FACTOR_REQUIRED` rejection in both entry points. A kick, ban, timeout or other action that needs a moderation permission in a community that requires two-factor authentication now fails with `apiError.code` set to `twoFactorRequired` and `apiError.providerCode` set to `TWO_FACTOR_REQUIRED`, instead of `apiError` set to `null`. Fluxer returns it when the account that owns the bot's application has no two-factor authentication enabled and the bot does not own the community.
  Communities, which Fluxer calls guilds, gain an optional `mfaLevel` field with the new `GuildMfaLevels` constants `None` and `Elevated`, so a bot can see this requirement before it sends a moderation request. The field appears on fetched communities, community list entries and `guildCreate` and `guildUpdate` events. A community whose `mfa_level` is present but not 0 or 1 is treated as malformed, like other malformed community fields

    The moderation and message deletion references describe this requirement, and the `messages.deleteMany` reference states that it requires `ManageMessages` even for the bot's own messages

- 7733b23: Add `snowflakes.shardFor(guildId, totalShards)`, which returns the shard Fluxer routes a community's events to, and `client.shardIdForGuild(guildId)`, which returns this client's shard for a community or `undefined` when another process owns it. Fluxer calls a community a guild. Both APIs provide them

    For an invalid ID, the helper throws `HelperError` with reason `id`, and for a total outside 1 through 16,384 with the new reason `shardCount`. The client method throws `ConfigurationError` for an invalid ID

- 7733b23: Pass an `EventContext` with `shardId` and `receivedBytes` to every `client.on` handler, as the third argument in the default API and the second in the Effect API.
  The context names the local shard that received the event and the byte length of the gateway frame that carried it

    Add `client.use(middleware)` to run event middleware around every later `on` handler invocation, including those of existing subscriptions, command routers and `runBot` handlers.
    Middleware runs in registration order, receives the event name, payload, context and subscription ID, and can skip the handler by not calling `next`.
    Failures of middleware and of the handler inside it are reported like handler failures, so middleware cannot hide a handler failure.
    Both APIs return a `MiddlewareRegistration` with `close()`. The default registration also works with `using`, and the Effect API ends the registration when the executing Scope closes and runs middleware with the services available at registration

- 7733b23: Add the `partition` handler option to `client.on` and `runBot` events, in both entry points, to keep related events in order while unrelated events run side by side.
  Events with the same key run one at a time in receive order, and events with different keys run in parallel up to `concurrency`, which defaults to 8 when a partition is set.
  The value `"guild"` keys each event by its community, which the API calls a guild, and a direct message by its channel. The value `"channel"` keys each event by its channel, or by its community when it has no channel. A function receives the event and returns its own key.
  Waiting events still count toward the queue limits. A partition function that throws or returns a value other than a string or undefined is reported as a failure of that event's handler, which then does not run
- 7733b23: Add `gateway.ignoredEvents`, `gateway.flags` and `gateway.presence`, sent in each new session's Identify.
  The `ignoredEvents` option lists dispatch names Fluxer should not send, or `"auto"` to suppress every type no registered event, enabled cache category or SDK feature needs, computed at each new session. A handler registered after a session started receives suppressed types only from that shard's next new session, and a `raw` subscriber disables automatic suppression.
  Setting `flags: { debounceMessageReactions: true }` turns on Fluxer's `DEBOUNCE_MESSAGE_REACTIONS` flag, merging direct-message reaction runs into `messageReactionAddMany`.
  The `presence` option sets the initial presence, which Identify carries and the SDK publishes after READY as if `presence.set` had been called before connecting.
  An explicit `ignoredEvents` list that names a type the SDK or an enabled cache needs fails client creation with `ConfigurationError`. `GatewayOptions` is a new public type
- 7733b23: Expose the instance's advertised web domain migration as `domainMigration` on `ResolvedInstance`, typed as the new `InstanceDomainMigration`, and log an Info record when a migration is enabled
- 7733b23: Message operations accept a plain string as the whole message and an `EmbedBuilder` wherever they accept embeds, in both entry points.
  A string such as `client.messages.send(channelId, "Hello")` is shorthand for `{ content: "Hello" }` in `messages.send`, `messages.reply`, `messages.edit`, `directMessages.send` and a webhook client's `send` and `editMessage`.
  An `EmbedBuilder` in `embeds` is built once when the operation reads its input, so `client.messages.reply(message, { embeds: [builders.embed().title("Status")] })` needs no `build()` call and later changes to the builder do not affect that operation
- 7733b23: Send text-to-speech messages with `tts: true` on `messages.send`, `messages.reply`, `directMessages.send` and the `runBot` reply helpers.
  A non-boolean value fails with reason `input` before any request. In a community, Fluxer sends a normal message without an error when the bot lacks the Send TTS Messages permission.
  Webhook messages do not accept `tts`, because Fluxer never sends a webhook message as text-to-speech. Webhook sends, replies and forwards with `tts` fail with reason `input` before any request.
  Messages gain an optional `tts` field, selectable through `messageFields`. Fluxer does not store the value, so it is meaningful only on the message returned by a send and on `messageCreate` events. Fetches, history pages and other later reads always report `false`. A message whose `tts` is present but not a boolean is treated as malformed, like other malformed message fields
- 7733b23: Add `MessageType` constants to both entry points, naming the values of `Message.type`, for example `message.type === MessageType.UserJoin`. They cover every message type in Fluxer's message schema: Default, RecipientAdd, RecipientRemove, Call, ChannelNameChange, ChannelIconChange, ChannelPinnedMessage, UserJoin and Reply.
  `Message` stays one shape rather than a union by type, because Fluxer returns the same message fields for every type. A value Fluxer adds later is still kept in `Message.type`
- 7733b23: Add the `raw` event, which delivers every gateway dispatch a shard accepts as `{ shardId, t, s, d }`, including `READY`, `RESUMED` and types this SDK version does not decode. The body is Fluxer's unvalidated wire data and is not part of the SDK's compatibility contract. Delivery is logged at Trace with code `events.raw`, and nothing is built while no `raw` subscriber exists. Types listed in `gateway.ignoredEvents` never arrive

    Add `client.gateway.send(shardId, op, d)` for gateway commands without an SDK method. It fails with `GatewaySendError` whose `reason` is `input` for invalid arguments or frames above Fluxer's 4,096-byte limit, `reserved` for heartbeat, Identify, Resume and server-only opcodes, `notOwned`, `notReady` or `busy`, and with `ClientClosedError` after shutdown. A throw from a getter or `toJSON` in the command data rejects with `SdkDefect` code `application.defect`, and cycles, BigInt values and overly deep data fail with reason `input`. Completion means the frame was handed to the connection. Each sent command is logged at Debug with code `gateway.commandSent`

- 7733b23: Export the types that public signatures already referenced, so they can be named in application code and appear in the reference.
  Both entry points now export `FormatHelpers`, `SnowflakeHelpers`, `DisplayHelpers`, `PermissionBitHelpers`, `ColorHelpers`, `TextHelpers`, `LinkHelpers` and `AssetHelpers` for the helper objects, whose `tryParse` methods return a Result in the default entry point and an Effect in the Effect entry point, and `Operation`, `MessageContent`, `EditMessageOptions`, `WebhookMessageOptions`, `AuditLogFilter`, `AuditLogQueryBase`, `AuditLogIterationQueryBase`, `CommandArgumentOptionalValue` and `ErrorMatchHandlers`.
  The default entry point adds `DefaultCommands` and `DefaultPrefixCommandBatch`, and the Effect entry point adds `NativeCommands`, `NativePrefixCommandBatch`, `NativeBatchRequirements`, `NativeCommandRequirements`, `NativeEffectRequirements`, `BotEventServices` and `HandlerServices`

    Every public export now has a reference category, and each client method has one description shared by both entry points, with the differences between them stated separately

- 7733b23: Add `client.rest.request({ method, path, query?, body?, files?, auditReason?, timeoutMs? })` for Fluxer API routes without an SDK method.
  Default calls return a `ResultAsync` and accept `signal`, and Effect calls return an Effect. Both resolve with `{ status, headers, body }`, where header names are lower case and `body` is the parsed JSON body or `undefined` for an empty response.
  Requests use the client's credential, queue, learned rate-limit buckets, 429 waits, deadline, logging and bounded GET retries. Other methods are sent again only after a confirmed 429, never after an uncertain outcome.
  Paths must be relative API paths such as `/users/@me`, without a scheme, host, query, fragment, dot segments or the `/v1` prefix. Token-authenticated webhook routes are rejected because their credential is part of the path.
  Invalid input fails with `RestRequestError` reason `input` before any request, a non-2xx status fails with `RestRequestError` carrying the status and sanitized `apiError`, and a request after shutdown fails with `ClientClosedError`. Logs, metrics and spans show only a route template in which IDs, codes and other non-word segments are placeholders.
  The `files` field accepts the message attachment inputs and sends them inline as multipart form data with their metadata in `payload_json`
- 7733b23: Add the `rest` client option to tune REST scheduling: The `concurrency` setting for Fluxer API requests that run at once (1 through 64), `mediaConcurrency` for attachment downloads (1 through 64, default 4), `maxQueued` (1 through 65,536, default 256), `queuedJsonMaxBytes` (64 KiB through 256 MiB, default 4 MiB) and `defaultTimeoutMs` (default 30,000).
  By default a client runs 4 API requests at once for each of its shards, up to 64, instead of 4 in total, and the limit follows the shard plan when `sharding: "auto"` sizes or enlarges it. An explicit `concurrency` is used as given.
  The `defaultTimeoutMs` setting replaces the fixed 30,000 ms deadline of REST operations and attachment downloads that omit `timeoutMs`.
  Invalid values throw `ConfigurationError` naming the field in the default API and are defects in the Effect API, and `client.diagnostics().rest` reports the configured capacities

    A request that fails with reason `busy` because the REST queue or the upload byte budget is full now logs `rest.busy` at Warn, at most once a minute, naming the full limit. Every such failure is counted in the new `diagnostics().counters.restBusy` counter

- 7733b23: A shard that resumes a session from the `sharding.sessions` store now refills the enabled community, role and channel caches through REST, because a resumed session receives no community data. Fluxer calls a community a guild. Once every shard is ready, the SDK lists the bot's communities and fetches each one on a resumed shard, one request at a time, so application requests keep the other REST slots and rate limits apply as usual. The refill is logged with code `lifecycle.cacheRefill`, at Info when it succeeds and at Warn when some communities fail or it stops after 10 failures

    Set `sharding.refillCaches` to `false` to skip the refill

- 7733b23: Add scaling options for large bots.
  The setting `sharding: "auto"`, or `totalShards: "auto"`, counts the bot's communities at the first connect and uses one shard per 2,000 communities. Fluxer calls a community a guild. Fluxer rejects a new session with close code 4011 (sharding required) when one shard holds more than 2,500 communities, and community IDs do not split evenly across shards, so the lower target keeps every shard below that ceiling and leaves room to grow. Counting the communities has its own `connection.startupTimeoutMs` deadline, so a slow count does not shorten the time the shards get to connect. Until the count completes, `client.shards` is empty. Automatic sizing assigns every shard to the client, so processes that split the shards need an explicit total.
  When the bot outgrows its plan while the client runs and Fluxer closes a shard with close code 4011, the client keeps running. The SDK counts the communities again and moves every shard to the plan for the new count, or to one more shard when the count still fits the old total. Every shard then starts a new session under the new total, so events sent during the move are missed, and the community caches refill from the new sessions. The move is logged once at Warn with code `lifecycle.resharded` and the old and new totals. After 3 moves within an hour, or at 16,384 shards, a further 4011 closure ends the client with a `ConnectionError`, and the `lifecycle.connectionEnded` record says why. An explicit `totalShards` still ends the client on the first 4011 closure.
  An application can pass `sharding.identify.permit(shardId, totalShards, signal)` to coordinate new-session Identify commands across processes, and a refused permit is logged at Error and retried like a connection failure. The coordinator owns Identify pacing, so the SDK adds no spacing of its own before a permit. A coordinator should space its permits, for example by one second, to stay within Fluxer's budget of 300 Identify commands per source IP address in each 60-second window.
  A `sharding.sessions` store loads a saved `{ sessionId, sequence, resumeUrl, savedAt, totalShards }` snapshot at startup and saves one at shutdown, so a restart within Fluxer's 60-second window resumes instead of starting a new session. Stale, malformed or foreign snapshots, snapshots saved under a different shard total and store failures are logged and never fail startup.
  The `connection.recovery` option sets `minDelayMs`, `maxDelayMs`, `attemptTimeoutMs` and `healthyResetMs` for established-session recovery, with the previous 1,000, 30,000, 30,000 and 60,000 ms as defaults, and the Effect API also accepts a `schedule` that decides recovery delays and ends recovery when it completes.
  `ConnectionRecoveryOptions`, `IdentifyCoordinator`, `SessionStore` and `SessionSnapshot` are new public types
- 7733b23: The `token` option of `supervisor.child.run` accepts `string | undefined` in both entry points, as `createClient` and `runBot` do, so `process.env.FLUXER_BOT_TOKEN` can be passed directly. A missing or blank token still fails `child.run` with `ConfigurationError` once the assignment arrives, and the parent then sees that child fail during configuration
- 7733b23: Add scaling options to the supervisor in both APIs.
  As an alternative to hand-written `assignments`, the new `processes` and `shardsPerProcess` options split every shard into contiguous blocks, one per child, named `process-0`, `process-1` and so on. With `totalShards: "auto"` the supervisor counts the communities the bot is in, which the API calls guilds, when it starts and uses one shard per 2,000 communities, as a client with `sharding: "auto"` does. The count needs the new `token` supervisor option and accepts `instance` and `transport` for a self-hosted instance or a proxy. It logs `supervisor.automaticSharding`, and a failed count fails `start` with the new `SupervisorError` reason `shardCount`, whose cause is the count's error. When Fluxer later closes a child's shard with close code 4011 because the bot outgrew the plan, the supervisor stops every child, counts again and starts children for a larger plan, logging a `supervisor.resharded` Warn. After 3 such moves within an hour, or at 16,384 shards, it fails with reason `closed` instead.
  The `identify.coordinator` supervisor option accepts the same `IdentifyCoordinator` a client accepts in `sharding.identify`, so supervisors on several hosts can share Fluxer's Identify budget. The parent asks it before every grant and adds no spacing of its own, and a refused permit is logged at Error with code `supervisor.identifyPermitFailed` while the child retries like after a network failure.
  Supervised children can keep resumable sessions across a deploy with `clientOptions.sharding.sessions` in `supervisor.child.run`. A shard plan or identify coordinator in that `sharding` object is rejected with `ConfigurationError`, because the parent assigns shards and paces Identify.
  Each child now sends its client diagnostics (gateway latency, shard states, REST queue, cache use and counters) to the parent when it finishes configuration and then every `diagnosticsIntervalMs`, 5,000 ms by default. The `status()` method shows the latest snapshot in the new `diagnostics` field of each child.
  `SupervisorChildDiagnostics` and `SupervisorChildSharding` are new public types. `ConfigurationError` can name the new fields `processes`, `shardsPerProcess` and `diagnosticsIntervalMs`, and code that switches over every `SupervisorError` reason needs a case for `shardCount`
- 7733b23: Add `@neontechspace/fluxerly/testing` and `@neontechspace/fluxerly/effect/testing` for application tests that need no network, token or Fluxer account.
  The `createTestClient` function returns a real client wired through the `transport` option to an in-memory Fluxer, together with controls: The `ready()` control connects through a protocol-v1 fake gateway, `emit(type, payload, { shardId })` delivers a wire dispatch such as `MESSAGE_CREATE` through the SDK's own decoders, caches and handlers, and `disconnect({ shardId, code })` closes a shard's connection so the client resumes, or stops for a fatal close code.
  The `user` and `heartbeatIntervalMs` settings choose the bot account reported in READY and the HELLO heartbeat interval.
  The `rest.respond(matcher, response | handler)` control answers HTTP requests matched by a `"METHOD /path/:param"` pattern, a RegExp or a `{ method, path }` object, `requests()` and `commands()` record what the client sent without its token or Authorization header, `logs()` captures log records at the configured level while still calling application sinks, and `counters()` reads the diagnostics counters.
  Unmatched requests receive a Fluxer-shaped 404 and a `testing.unmatchedRequest` Warn record.
  The native `createTestClient` is scoped: Closing its Scope shuts the client down and closes the transport, while the default client uses `shutdown()` or `await using`.
  Both entry points share `fixtures`, `createFixtures` and `fixtureToken`: Deterministic snake_case wire builders for users, the bot user, communities, GUILD_CREATE bodies, channels, roles, members and messages whose defaults refer to one community, channel and author

    The `createTestBot` function tests a bot written for `runBot` as written. It takes the bot's own options object, registers its `events` and `commands` with the same handler contexts, delivery defaults and command router as `runBot`, and runs `setup` once in `ready` before connecting. The `signal`, `processSignals`, `reportFailure` and `drainMs` settings are accepted and ignored, and an undefined `token` uses the fixture token.
    A misspelled or unsupported option key throws `ConfigurationError` with a hint naming the closest key that `createTestClient` or `createTestBot` accepts, as `createClient` does. A failed setup rejects `ready` with `ApplicationError`. The result is the usual test client, typed `TestBot` in the Effect entry point

    Tests wait without building their own promises or sleeping.
    The `TestRoute.next()` control returns the next request a registered response answered, in order, including one that arrived before the call.
    The `idle()` control waits until no handler or command is running and no request is pending, which confirms that the bot did nothing after an emitted event.
    Both fail with `TestTimeoutError` after `timeoutMs`, default 2,000 ms, and the native entry point returns them as Effects.
    Their timers stay real when a test fakes timers, for example with `vi.useFakeTimers()`. The SDK runs on `setImmediate`, so fake timers must leave it real, and `idle()` rejects with `ConfigurationError`, or dies with it in the native entry point, instead of settling while no handler can run

    A test client fails the test when application code failed without a handler, such as an event handler or command that threw, or returned a failed Result such as a rejected reply, while no `onError` hook was registered.
    The default `shutdown()` and `await using` disposal reject with `UnhandledTestFailuresError`, which lists the Error records of those failures.
    The native `shutdown()` fails with it, and closing the scope that created the test client dies with it.
    Each failure is reported once, so a later shutdown succeeds.
    A test that makes application code fail on purpose reads the failure from the `failures()` control, which marks it as expected, or handles it with `onError`

- 7733b23: Add the advanced `transport` client option. Its `fetch` and `webSocket` settings replace the HTTP and WebSocket implementations, for example for proxies, instrumentation or tests, and `userAgent` replaces the User-Agent header.
  Replacements receive every client request, including instance discovery, REST, signed upload parts, attachment downloads and gateway connections. Invalid values throw `ConfigurationError` naming the field in the default API and are defects in the Effect API.
  Bot, webhook and OAuth clients now send `User-Agent: Fluxerly.js/<version> (+https://fluxerly.neontechspace.com)` with every HTTP request and gateway handshake. A configured `transport.userAgent` replaces it for a bot client.
  Custom WebSocket factories receive the handshake headers, including the User-Agent, in `WebSocketOptions.headers`

### Patch Changes

- 7733b23: TypeScript now reports a mistake in one argument descriptor of `registerMany` or the keyed `commands` object of `runBot`, such as `{ type: "int" }`, on that descriptor with the list of valid types, and the other commands keep their inferred `values`. Previously the error named the whole schema and every command lost its value types
- 7733b23: Expire entries in every cache category through an expiry heap and reschedule the expiry timer only when the next deadline changes, so timed cache writes no longer scan every retained entry
- 7733b23: A caller AbortSignal whose `addEventListener` throws no longer leaves the `runBot` SIGINT and SIGTERM listeners installed. The `runBot` function now registers the caller signal listener before its process signal listeners and removes it after them
- 7733b23: The `display.name` helper accepts a message author directly. Its user parameter now allows an absent `displayName`, as on received message authors, and falls back to the username
- 7733b23: Start faster by importing each Effect module the SDK uses from its own `effect/<Module>` subpath instead of the `effect` package index, which loads every Effect module.
  Importing `@neontechspace/fluxerly` now loads 87 Effect modules instead of 203, and `@neontechspace/fluxerly/effect` loads 133
- 7733b23: Loading the package with `require()` now fails with an error explaining that the SDK is ESM-only and how to switch the project to `import`
- 7733b23: Pace presence, member-subscription, member-chunk, count and `gateway.send` commands on each gateway connection to at most 500 in any 60-second window, sent in order, so they stay within Fluxer's budget of 600 payloads per connection instead of closing it with 4008. Heartbeats, Identify and Resume are never delayed behind them
- 7733b23: Event handlers use much less CPU while a backlog waits for a free handler slot
- 7733b23: Keep a sent message in the message cache when its gateway echo arrives before the HTTP response.
  Fluxer omits the community ID, `guild_id`, from message HTTP responses, and the cache previously treated that difference as a conflict and dropped the message.
  Other differences between overlapping observations still remove the cached message
- 7733b23: Read each message input field once when sending, replying, editing, forwarding, sending direct messages or executing webhooks, so the validated value is the one sent.
  A getter on `content`, `flags`, `embeds`, `stickerIds`, `messageReference`, an `allowedMentions` switch or an attachment field can no longer pass validation with one value and send another.
  Other operations read caller arrays and options once too. The `messages.deleteMany`, `guilds.fetchCounts`, `channels.fetchMemberCounts` and `presence.setMembers` methods copy their IDs once and use the validated copy.
  Cache entry limits, event wait options, presence input, pagination, search, member chunk, message cleanup, permission, instance resolution and attachment download options, webhook client options, supervisor options and client cache and upload settings read each field once
- 7733b23: Keep the original OAuth response cleanup failure when reader cancellation or release fails, as REST and discovery cleanup already do. The native Cause holds it as the defect, the default API's `SdkDefect` holds it as its cause, and several failures arrive as one `AggregateError`. Response bodies never become part of it
- 7733b23: Return the received failure at once when a GET retry after a network error or HTTP 500, 502, 503 or 504 could not start before the operation deadline, such as a long `Retry-After`. Such a read previously waited for the whole deadline and failed with reason `timeout`
- 7733b23: Ship JavaScript source maps that point to the package's `src/` files instead of embedding a second copy of every source file, which reduces the installed size.
  Stack traces with `--enable-source-maps`, debuggers and go-to-source still resolve to the original TypeScript
- 7733b23: Large sharded bots now start within the default startup deadline. When a client owns several shards and has no `sharding.identify` coordinator, the SDK spaces new-session Identify commands by one second, as before, and now adds one second to the startup deadline for each shard after the first, so this spacing alone never fails startup. An Info record with code `lifecycle.startupDeadline` states the extended deadline
- 7733b23: Keep the original thrown value of an attachment stream cleanup failure that no caller observed. Client shutdown reports up to 64 retained failures with their values, and later ones are counted without their values
- 7733b23: In the default API, a `configure` callback of `supervisor.child.run` that throws or rejects makes `child.run` reject with `SdkDefect` code `application.defect`. Its cause is an `ApplicationError` with source `supervisor child configure`, whose own cause is the original value

## 1000.0.0-rc.0

### Major Changes

- 6eaecbf: Require the exact Effect peer `4.0.0-rc.117` instead of `4.0.0-rc.115`. Update the application's Effect dependency and lockfile together with the SDK, including applications using only the default API

    Expand received message context with immutable partial-user metadata, non-notifying referenced users, explicit-emoji classifications and one resolved reply level without hidden requests. The `referencedMessage` type is now `ReferencedMessage`, not an address-only `MessageReference`. Hand-authored message fixtures must supply the resolved message shape or omit the optional field. Address-only operations can continue to use `MessageReference`. Additional retained context counts toward configured cache and collector byte budgets

    Add explicit attachment URL refresh and endpoint-specific audit reasons through both APIs. Refresh preserves exact signed strings and does not download attachments. OAuth preflight now rejects overlong or noncanonical opaque values rather than changing them and bounds supplied scope arrays to 256 entries before deduplication. Member-role replacement enforces provider signed-identifier bounds

    Add a plain JavaScript structured logger adapter, opt-in bounded stage measurements and aggregate event-work diagnostics. Measurements remain off by default, native Effect retains caller logging context, and applications retain responsibility for asynchronous sink delivery and aggregate admission policy

    Improve resource-aware refill pacing, unrelated user and DM cache reads, incremental cache byte accounting and concurrent member-search preflight without replaying ambiguous writes. Scope logical scheduling to the owning Effect clock while retaining separate host-safety watchdogs

    Native owner-backed gateway, REST, collector, member-stream, cache and presence timing now follows the Clock supplied when the client is created. Applications overriding logical time must create the client under that Clock rather than replacing it only around a later operation. Ownerless utilities retain their documented executing-clock behavior

### Minor Changes

- 139f4dc: Add atomic keyed command batches with per-command argument inference, plus command-context reply helpers that bind the incoming message and handler cancellation
- ada1d09: Add an optional `runBot` runner to both SDK entry points for critical subscriptions, graceful shutdown and opt-in process signal handling

    Configure event handlers in one object, with automatic subscription registration, access to the full client and a message reply helper. Keep the explicit installer and low-level APIs for custom lifetime and subscription control

    Keep native Effect context and Cause information while the default API returns expected failures as ResultAsync and sanitizes defects

### Patch Changes

- 139f4dc: Include standalone JavaScript, TypeScript and native Effect bot starters using the public SDK runner for critical subscriptions and awaited cleanup

    Clarify ordinary handler Promise ownership and add checked-JavaScript consumer coverage and symptom-based troubleshooting using existing diagnostics

- 5f6b6dd: Refresh the package README with matching JavaScript, TypeScript and Effect-native starter setup, explicit lifecycle ownership and installed Effect version guidance
- 01caebf: Contain accidentally returned Promise and thenable rejections in the default API's Effect logger adapter, matching the structured adapter and documented synchronous logging contract without adding asynchronous delivery or flushing guarantees
- 139f4dc: Contain accidentally returned rejected promises and thenables from structured logging callbacks without changing SDK operation outcomes
- 01caebf: Preserve inherited and non-enumerable command fields during batch registration in both APIs, so supplied guards, argument schemas, cooldowns and rejection callbacks cannot silently disappear

    Snapshot recognized command and cooldown fields before validation and retain those same values, preserving atomic registration and preventing changing getters from replacing validated policies

- 6eaecbf: Align request text validation with Fluxer's field-specific normalization and UTF-16 limits without rewriting accepted input

    Preserve global rate-limit pauses when error bodies are unavailable and learn server rate-limit buckets with bounded, resource-aware tracking

    Bound complete gateway messages before decoding, including fragmented frames, and reject invalid UTF-8 through the transport

    Keep attachment reads responsive to cancellation and deadlines when sources repeatedly yield empty chunks

    Use ordinary JavaScript and TypeScript extensions inside ESM package scopes while retaining the existing public package entry points

- 01caebf: Treat runner-initiated client closure as normal when stopping a bot, while preserving run and cleanup failures

    Preserve combined native failures and sanitized default-API failure reasons when an operation and cleanup both fail

## 1000.0.0-canary.1

### Minor Changes

- 1afd073: Preserve provider-supplied guild context as optional `guildId` on `messageDelete`, `messageDeleteBulk` and `channelPinsUpdate` payloads through both APIs. No channel lookup or cache inference is added, and omission does not establish that the event came from a private channel
- 1afd073: Add `GuildCreate.isNewJoin` to distinguish provider-reported joins from startup and recovery availability snapshots through both APIs. Existing `guildCreate` delivery and `connect()` readiness remain unchanged

    Classification requires a bot gateway that supplies Fluxer's availability marker. Legacy instances that omit it for startup snapshots cannot be classified reliably, and a join dispatch may replay during Resume

### Patch Changes

- 1afd073: Reject malformed array entries using their indexed values while preserving documented local bounds

    Reject impossible calendar dates in embed timestamps, pin cursors, guild history cutoffs and status expiry before dispatch or retention. Apply the same calendar validation to received message, pin, channel, guild, member, invite, ban and discovery timestamps while preserving each field's existing timezone and precision rules

- 1afd073: Expose Fluxer's recorded positive member-ban message-deletion duration through audit-log REST reads and gateway events
- 1afd073: Honor inherited and non-enumerable audit-log iterator bounds, preserving requested cursors and enforcing page limits through both APIs
- 1afd073: Keep malformed nested allowed-mention selections and embed values intact when building message inputs so message-operation validation rejects them before a request starts
- 1afd073: Preserve inherited and non-enumerable supported structural properties when builders snapshot embeds, attachments, message references and allowed mentions. Builders retain unknown own enumerable fields for message-operation validation and attachment source references
- 1afd073: Accept voice-channel bitrate requests through 384,000 bits per second and return the value applied by Fluxer
- 1afd073: Identify affected generic event subscriptions in safe fallback diagnostics
- 1afd073: Remove unsupported message-search cursor inputs and result cursors. Traverse numbered pages with a fixed page size, report the provider's page ceiling explicitly and reject results with missing or unrelated channel context
- 1afd073: Reject array-valued OAuth operation options before discovery or request dispatch
- 1afd073: Preserve unexpected OAuth construction failures as defects attributed to oauth.create, with configuration details kept private
- 1afd073: Keep OAuth consent, code exchange and revocation requests aligned with the values that passed local validation
- 1afd073: Reject role and channel permission writes above Fluxer's signed 64-bit maximum while preserving unsigned 64-bit response values
- 1afd073: Prevent stale private-conversation snapshots from surviving overlapping direct-message mutations
- 1afd073: Accept static and animated custom-emoji markup in reaction requests and collectors. Parsed custom emoji, guild emoji snapshots and received reaction emoji now share the same input normalization across both APIs, including Unicode event values. Custom collectors continue matching by emoji ID after a rename
- 1afd073: Validate bounded resource input arrays from one indexed snapshot before encoding or dispatching requests
- 1afd073: Preserve HTTP rejection status and cleanup defects when releasing an error-response reader fails, instead of reporting an ordinary network error
- 1afd073: Preserve native shutdown interruption and cleanup-defect reasons without exposing a connection failure through shutdown. Keep both classifications in sanitized default-API defects
- 1afd073: Preserve inherited and non-enumerable client settings in both supervisor child APIs, so an explicitly selected instance is not silently replaced by hosted Fluxer. Reject inherited token and sharding overrides as well as own-property overrides
- 1afd073: Capture message targets, search scopes and traversal bounds, pin and reaction-user cursors, and reaction emoji identities once before validation and dispatch, preventing later caller-controlled property reads from changing an accepted request
- 1afd073: Keep webhook create and edit requests aligned with the settings that passed local validation

## 1000.0.0-canary.0

### Patch Changes

- Initial canary release of Fluxerly.js for testing and feedback
