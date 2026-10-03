---
"@neontechspace/fluxerly": major
---

Add `WebhookType` and the `IncomingWebhook`, `ChannelFollowerWebhook` and `UnknownWebhook` shapes to both APIs. Received metadata now requires a kind and preserves future numeric kinds as `type: "unknown"` with `rawType`

Bot clients can rename, move or delete follower webhooks but cannot change their avatars. Deleting a follower webhook stops its channel following the source. Optional frozen `sourceGuild` and `sourceChannel` snapshots reflect source visibility to the original creator, and their absence does not prove deletion

Webhook metadata no longer carries tokens. The `CreatedWebhook.webhook` field and webhook-client `fetch` and `edit` results now use `IncomingWebhook`, and creation requires a valid incoming token before returning credentials
