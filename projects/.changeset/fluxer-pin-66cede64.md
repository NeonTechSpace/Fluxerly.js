---
"@neontechspace/fluxerly": major
---

Align the SDK with Fluxer commit 66cede64. Breaking changes, each with the code it affects and how to migrate:

- `LinkChannelCreate.url` is now required and `ChannelEdit.url` no longer accepts `null` or an empty string, because Fluxer requires every link channel to carry a URL and refuses clearing it
  Affected: Code that creates a link channel without `url`, or edits a link channel with `url: null` or `url: ""`
  Migration: Pass a valid `http://` or `https://` `url` when creating a link channel, and omit `url` instead of clearing it on edit
- `Members` adds required `fetchBan(target, options?)` for reading one user's active ban record (`GET /guilds/{guildId}/bans/{userId}`), and `GuildOperation` adds `"members.fetchBan"`
  Affected: Code that implements or fakes the `Members` interface, or switches exhaustively over `GuildOperation`
  Migration: Implement `fetchBan` on custom `Members` fakes and handle `"members.fetchBan"` in `GuildOperation` switches
- `ResolvedInstance` adds required `proxyAttachmentsThroughApi: boolean` matching Fluxer's `features.proxy_attachments_through_api` discovery flag
  Affected: Code that constructs or fakes `ResolvedInstance` values
  Migration: Set `proxyAttachmentsThroughApi` on custom `ResolvedInstance` objects
- `OAuthConnection` adds required `providerId: string | null` and `url: string | null`, and accepts `"oauth"` connections alongside `"bsky"` and `"domain"`
  Affected: Code that constructs `OAuthConnection` fixtures or assumes `type` is only `"bsky"` or `"domain"`
  Migration: Include `providerId` and `url` on fixtures and handle `"oauth"` connections
- `X-Audit-Log-Reason` is now percent-encoded in UTF-8 instead of sending raw UTF-8 header bytes, matching Fluxer's header decoder
  Affected: Tests or proxies asserting raw unencoded `X-Audit-Log-Reason` bytes on the wire
  Migration: Decode `X-Audit-Log-Reason` with `decodeURIComponent` when inspecting outgoing requests
- Default Identify wait extension for `connection.startupTimeoutMs` and `connection.recovery.attemptTimeoutMs` is now 25,000 ms (55,000 ms total with the 30,000 ms default) instead of 135,000 ms, matching Fluxer's Gleam gateway session-start budget (`shard_permit_wait_ms` plus `manager_start_timeout`)
  Affected: Deployments on slow custom instances that relied on the implicit 135,000 ms extension without configuring a deadline
  Migration: Set `connection.startupTimeoutMs` and `connection.recovery.attemptTimeoutMs` explicitly when a custom instance needs a longer startup wait
- `GuildUnknownChannel.rawType` is now `number | null`, because Fluxer's gateway omits `type` on synthesized `CHANNEL_DELETE` dispatches when a session loses `ViewChannel`
  Affected: Code that reads `channel.rawType` as `number` without checking for `null`
  Migration: Handle `channel.rawType === null` when inspecting a `GuildUnknownChannel`
- New parity additions, which need no change: `MessageReactionBatch` entries now expose optional `member` and populate the member cache on community reaction batches, `attachments.download` and `attachments.stream` accept Fluxer's API-proxied attachment URLs under `endpoints.apiPublic` and send the bot `Authorization` header only to verified API attachment paths (never to `endpoints.media`, external URLs or redirects), `GuildFeatureToggles.MemberDmsDisabled` (`MEMBER_DMS_DISABLED`), API error codes `unknownBan` (`UNKNOWN_BAN`), `unknownConnectionProvider` (`UNKNOWN_CONNECTION_PROVIDER`) and `communityMemberDmsDisabled` (`COMMUNITY_MEMBER_DMS_DISABLED`), member profile `bio` up to 1,000 normalized UTF-16 code units, `GuildEdit.messageHistoryCutoff` preserving `±hh:mm` offsets directly, and updated REST route and raw gateway payload types for Fluxer commit 66cede64
