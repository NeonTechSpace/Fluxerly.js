# @neontechspace/fluxerly

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
