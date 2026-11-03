---
"@neontechspace/fluxerly": major
---

Breaking changes, each with the code it affects and how to migrate:

- Effect 4.1.2 or a later Effect 4 release is required. The `effect` peer range is now `^4.1.2`, so bot projects get at least the Effect version with the fix for Node.js-only type checks. With Effect 4.1.0, a TypeScript project that imports Effect or `@neontechspace/fluxerly/effect` with `@types/node` 22 or 24, no `DOM` library and `skipLibCheck` off fails to compile, because Effect's crypto declarations name global `CryptoKey` and `JsonWebKey` types that only the `DOM` library declares. Effect 4.1.1 fixed this. Projects that include the `DOM` library, such as those from `fluxerly init`, which use TypeScript's default libraries, or that enable `skipLibCheck` were not affected by that error
  Affected: Projects on Effect 4.1.0 or 4.1.1, which now get a peer dependency conflict on install that npm 7 and later treat as an error
  Migration: Update Effect to 4.1.2 or a later Effect 4 release, for example with `npm install effect@4`, `pnpm add effect@4` or `bun add effect@4`. No code changes are needed

- The `client.on`, `client.subscribe` and command router `attach` methods now reject an option they do not support, such as a misspelled `maxPendingMesages`, with `ConfigurationError` for field `eventOptions` and a hint that names the closest supported option, as `runBot` and `waitFor` already did. An unsupported option used to fall back to its default without a word. A subscription accepts only `maxPendingMessages` and `maxPendingBytes`, and no longer honors `overflow` or `partition`
  Affected: Options objects passed in from JavaScript or held in a variable, such as `client.subscribe("typingStart", { overflow: "dropOldest" })`
  Migration: Remove unsupported keys, and pass `overflow`, `partition` and `concurrency` to a handler registered with `client.on`

- The test kit's `next`, `idle` and `say` waits now reject an option they do not support with `ConfigurationError` and a hint that names the closest option. A misspelled `timeOutMs` used to leave the wait without a deadline
  Affected: Tests that pass a misspelled or unsupported wait option
  Migration: Use only `timeoutMs`, plus `message` for `say`

- A failed `messages.cleanup` is no longer retryable. The `errors.isRetryable` helper returns false for it, because a preview plan works only once, and a cleanup stopped by a full queue, a rate limit, a network failure or its deadline now says to preview again for the rest instead of to retry
  Affected: Retry wrappers around `messages.cleanup` that rely on `errors.isRetryable`
  Migration: Call `messages.previewCleanup` again and clean up the new plan

- A message send, reply, webhook message or upload that read an attachment from a `ReadableStream` and was then rate-limited is no longer retryable. Its error sets `details.streamUsed`, and `errors.isRetryable` returns false for it, because repeating the call would send the used stream. A Blob, a File and a stream the upload never read stay retryable
  Affected: Retry wrappers that rely on `errors.isRetryable` around sends with stream attachments
  Migration: Wait the reported delay, then send again with a new stream or with the file as bytes

- Network failures and timeouts from `directMessages.fetchLatestMessages` and `messages.previewCleanup` now make `errors.isRetryable` return true after dispatch, because both operations only read data
  Affected: Retry wrappers that use `errors.isRetryable`, which may now repeat these calls where they previously stopped
  Migration: Check the wrapper's retry count and total deadline for these reads. The SDK does not add automatic network retries to the latest-message POST

- Using one attachment stream a second time now fails with reason `input` and `inputValidation.path` `stream`, which is not retryable, instead of reason `busy`. Overlapping `next` calls on one default API stream still fail with `busy`
  Affected: Code that matches reason `busy` around a second read of the same stream
  Migration: Call `attachments.stream` again for a new stream, and match reason `input`

- A REST request whose JSON body is larger than `rest.queuedJsonMaxBytes`, or whose attachments are larger than `uploads.maxBytes`, now fails with reason `input` and `inputValidation.path` `body` or `files` instead of `busy`. It can never be sent, so `errors.isRetryable` returns false for it, and its message names the limit, `uploadMaxBytes` for a webhook client. Reason `busy` again means only that the request queue or upload budget is full for now, so a later retry can succeed
  Affected: Code that treats reason `busy` as a full queue and retries later
  Migration: Match reason `input`, and make the body or files smaller or raise the limit

- Fluxer codes a bot can reach now have their own `apiError.code` and a hint instead of being called a code the SDK does not describe: `userNotInVoice` for a move or disconnect of a member who is not in voice, `nsfwContentAgeRestricted` for a forward of age-restricted content into a channel that is not age-restricted, `singleCommunityCannotLeave` for leaving the community of a single-community instance, and `discoveryDisabled`, `discoveryInsufficientMembers`, `discoveryAlreadyApplied`, `discoveryApplicationNotFound` and `discoveryApplicationAlreadyReviewed` for discovery applications. These codes now appear in `apiError` and `details.apiError` and leave `details.providerCode` unset
  Affected: Code that matches these codes in `details.providerCode`, such as `error.details.providerCode === "USER_NOT_IN_VOICE"`
  Migration: Match `error.apiError?.code` instead, such as `"userNotInVoice"`

- An HTTP 429 that does not identify its limit, with no `X-RateLimit-Bucket` or `X-RateLimit-Scope` header and no JSON body with a boolean `global` member, as when a proxy in front of the API answers, now pauses every API request of the client for its wait instead of only that route's bucket. After that pause one request goes first, and only that request's own answer ends the pause. Repeated unidentified 429s on it double the asked wait, up to a minute, with up to one second of jitter
  Affected: Requests on other routes whose deadline is shorter than the pause, such as `guilds.fetch(id, { timeoutMs: 5_000 })` while a proxy rate-limits a member read for 60 seconds, which now fail with reason `rateLimit`
  Migration: Allow for client-wide pauses in deadlines, or have the proxy send a header that names the limit

- A 429 whose body asks for less time than its `Retry-After` header now waits for the header. Fluxer rounds that header up to whole seconds, so an ordinary Fluxer 429 can wait up to about one second longer than its body's `retry_after`
  Affected: Rate-limited calls with a short deadline, such as `messages.fetch(target, { timeoutMs: 1_000 })`, which can now fail without waiting
  Migration: Give rate-limited calls at least the header's whole-second wait in `timeoutMs`

- The `RateLimitObservation` type gains the required `pause` field. It is `"client"` for a global limit or a client-wide pause after an unidentified 429, and `"bucket"` for a limit Fluxer identifies as a route limit. An unidentified 429 keeps `global: false`. The `ratelimit.wait`, `ratelimit.deadline` and `ratelimit.notResent` records produced from a received 429 carry the same `pause`, while a queued request rejected against an already known pause may omit it. The `rest` part of `ClientDiagnostics` gains the required `rateLimitHold` field in both APIs
  Affected: Code that builds these objects by hand, such as a test of an `observe` callback or a health check fed fake diagnostics
  Migration: Add `pause: "client"` to global-limit observations and observations of unidentified limits, or `pause: "bucket"` to route-limit observations. Add `rateLimitHold: null` to fake REST diagnostics when no request is held

- The gateway payload limit is now 16,384 bytes, as Fluxer allows, instead of 4,096. The `gateway.send` method, `members.iterateChunks` and presence member selections accept larger requests, and a presence selection with 19-digit IDs now holds about 740 members instead of about 180. Fluxer instances older than October 2026 still allow only 4,096 bytes and close the connection with 4002 for a larger message, which stops the shard
  Affected: Bots on such older self-hosted instances that relied on the SDK refusing a larger request before sending it
  Migration: Keep each gateway request at 4,096 bytes or less until every target instance is updated

- The Effect `CommandRequirements` and `registerMany` now count the services of a guard, `onReject` or cooldown store in an optional property, such as a guard that a command factory adds only when it is given. The Effect `runBot`, `defineBot` and `createTestBot` count them too. Such a command used to compile without its services and fail with "Service not found" when used
  Affected: Effect code that runs such commands without providing those services, which no longer compiles
  Migration: Provide the named services, such as with `Effect.provide(AuthLive)`

- The `webhooks.fetch`, `webhooks.fetchForChannel` and `webhooks.fetchForGuild` methods take `RequestOptions` instead of `AuditedRequestOptions`, so an `auditReason`, which these reads always rejected at runtime, no longer compiles
  Affected: Only calls that already failed at runtime
  Migration: Remove `auditReason` from webhook reads

- The `Instance` interface gains the required `fetchBadges` method, and a webhook client's `instance` is now typed as `Pick<Instance, "resolve">`, in both APIs
  Affected: Code that passes a webhook client's `instance` where an `Instance` is expected, and hand-written `Instance` fakes
  Migration: Type such parameters as `Pick<Instance, "resolve">`, and add `fetchBadges` to fakes

- The `Threads` interface gains the required `iterateArchived` and `fetchPostData` methods, and the `OAuthClient` interface gains the required `fetchAuthorization` method, in both APIs
  Affected: Hand-written `Threads` or `OAuthClient` fakes and wrapper classes that implement these interfaces
  Migration: Add the new methods, or type code that uses only some methods with `Pick`, such as `Pick<Threads, "create">`

- The default test kit's `TestClient` and `TestBot` interfaces gain the required `advance(ms)` method of the new manual clock
  Affected: Hand-written test doubles or wrapper classes that implement these interfaces
  Migration: Add `advance`, or derive the double from `createTestClient`

- The test kit records request URLs on the hosted API address `https://fluxer.com/api/v1/...` instead of `https://api.fluxer.app/v1/...`, since hosted Fluxer moved its API there. Request paths are unchanged
  Affected: Tests that compare the full URL of a recorded request
  Migration: Compare the request path, or expect `https://fluxer.com/api/v1/...`

May affect some code:

- Closed unions that the SDK returns gain members: `ApiErrorCode`, `ApiProviderCode` and `ApiValidationCode` for the new Fluxer codes, `ChannelOperation`, `GuildOperation`, `OAuthOperation` and `PaginationOperation` for the new methods, the `operation` and `reason` of `HelperError` for `voiceWaveform`, and `ConfigurationError.field` for a scheduled task's `name`. An exhaustive check such as `const unreachable: never = error.apiError.code` no longer compiles
  Migration: Handle the new members or add a default branch

- The hosted `links` helpers now build `https://fluxer.com` URLs, since hosted Fluxer moved its web app there. The `links.channel` and `links.message` helpers return `https://fluxer.com/channels/...`, and `links.installation` returns `https://fluxer.com/oauth2/authorize?...`, the installation page itself. The previous `fluxer.app` and `api.fluxer.app` URLs only reached these pages through a redirect. Links from `client.instance.resolve()` still use the instance's own web app
  Migration: Update code or tests that compare the exact URL string

- The SDK reads hosted Fluxer's instance information from `https://fluxer.com/.well-known/fluxer` instead of `https://fluxer.app/.well-known/fluxer`, which now only redirects. Startup needs one request fewer, and the startup log line and its `instance` field name `fluxer.com`. Saved sessions keep working
  Migration: Update log filters or network allowlists that name `fluxer.app`
