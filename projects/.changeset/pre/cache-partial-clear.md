---
"@neontechspace/fluxerly": minor
---

The `client.cache.clear(kind)` method now releases a single cache kind, and the new `client.cache.delete(kind, key)` removes one entry by the key format that `cache.onChange` reports, such as `guildId:userId` for members or `channelId:messageId` for messages. Both work in the default and Effect APIs, run synchronously and report a `clear` or `delete` change to `cache.onChange` listeners. Reads already in flight cannot restore what was removed. An invalid kind or key throws `ConfigurationError`, whose `field` is `kind` or the new value `key`
