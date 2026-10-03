---
"@neontechspace/fluxerly": major
---

Received `message.messageReference` now has its own type, `MessageContextReference`, separate from the `MessageReference` that message operations take in both APIs. Its `channelId` is required and `id` is optional. Channel-follow notices, which have no message ID, now decode in events and REST reads, including minimal message field selections. A present but malformed ID still fails

This is a breaking type change: Check that the received context has an ID and build a `MessageReference` from both fields before passing it to fetch, reply or another message operation

Add `MessageType.ChannelFollowAdd` and the received-only flags `MessageFlags.Crossposted`, `MessageFlags.IsCrosspost` and `MessageFlags.SourceMessageDeleted`. Fluxer sets these publishing flags itself. Sending and editing continue to accept only `SuppressEmbeds` and `SuppressNotifications`, with other flags rejected before sending the request
