---
"@neontechspace/fluxerly": major
---

Return plain values from the local helpers in both entry points, and throw their existing error for invalid input, which indicates a programming mistake.
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
