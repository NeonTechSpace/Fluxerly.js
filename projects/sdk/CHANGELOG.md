# @neontechspace/fluxerly

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
