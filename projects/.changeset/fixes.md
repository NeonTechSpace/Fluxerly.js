---
"@neontechspace/fluxerly": patch
---

Fixes:

- The `oauth.revoke` method without `tokenTypeHint` now sends the `refresh_token` hint. Fluxer looks up refresh tokens only for that hint and then falls back to access tokens, so a refresh token revoked without a hint used to stay valid while the call succeeded. A revoke also ends every access and refresh token of the same user and application, which the method's documentation now says
- A connection reset while reading an OAuth response body now fails with `OAuthOperationError` reason `network` and outcome `unknown`, keeping the received status, instead of an `SdkDefect` from cancelling the already failed stream. A rejected reply whose body breaks keeps reason `rejected` and its status
- Instance discovery has the same fix: A body reset fails with `ConnectionError` reason `network`, and a rate-limited discovery whose body breaks returns `RateLimitError` and holds later discovery for its `Retry-After`, which it used to skip. When Fluxer rate-limits instance discovery during startup with a wait, startup waits at least that long and tries again without using up `connection.maxStartupAttempts`, until the startup deadline, and no further discovery request is sent during the wait
- A rate-limited signed upload part now reports the longer wait of its `Retry-After` header and its body in `retryAfterMs`, including a header given as an HTTP date. Storage or a proxy that answered with only the header used to leave `retryAfterMs` null, or shorter than the wait it asked for
- Calls to `gateway.send` now fail with reason `reserved` for opcode 12, Gateway Error, which only Fluxer sends, and for opcode 5, Voice Server Ping, which Fluxer reserves. Fluxer used to close the connection with 4001 after such a send, which stopped the client
- Webhook sends now keep message fields that come from getters or non-enumerable properties, as `messages.send` does. Such a `content`, `flags` or `allowedMentions` used to be dropped before sending
- A webhook avatar now accepts an image data URI with media type parameters, such as `data:image/png;charset=utf-8;base64,...`, like the community and user image fields, and refuses a badly padded Base64 body
- An embed image or thumbnail that references an upload with two dots in a row, such as `plot..png`, or a Windows device name such as `CON.png`, now fails with reason `input` before any upload. Fluxer renames such files, so the reference failed after the upload
- A supervisor child's `diagnostics` is now null once its IPC channel closes, as documented, instead of keeping its last snapshot
- A user update skipped as malformed now also clears cached direct messages, whose recipients it could have changed
- The test gateway now sends a `GUILD_CREATE`, `GUILD_UPDATE` or `GUILD_DELETE` payload without a `guild_id` to the shard its `id` routes to, as Fluxer does, instead of to shard 0
- The `MessageBuilder` methods `addEmbeds`, `addAttachments` and `addStickers` now declare their arguments as a plain rest tuple, so the reference shows that they take one or more values. Calls compile as before
- A channel whose content-warning level this SDK version does not name, such as 2, no longer fails the whole read with reason `response`. Channel reads, channel lists, community snapshots and channel events now accept any 32-bit integer and return it unchanged in `contentWarningLevel`
