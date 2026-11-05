---
"@neontechspace/fluxerly": major
---

IDs with surrounding whitespace are now accepted wherever the SDK takes an ID. Fluxer trims the IDs in REST paths, queries and bodies and then requires a decimal without leading zeros from 0 through 9223372036854775807. A few Fluxer inputs are not trimmed, such as gateway IDs, a webhook's thread ID and a reaction's custom emoji ID, and the gateway also refuses 0. The SDK now trims each ID once and sends the trimmed ID everywhere, including those inputs, and uses it for the result and the cache, so `client.channels.fetch(" 123 ")` reads `/channels/123` and `client.channels.get(" 123 ")` finds the cached channel. This covers IDs in arguments, in input objects and in ID lists, cache lookups and deletes, gateway requests such as member chunks and member presence, the `snowflakes` and `format` helpers, asset URL builders and command owner IDs. Gateway requests and local filters such as collectors also require a positive ID. An ID that is not such a decimal after trimming still fails before sending, with the same reason and path as before

- An ID above 9223372036854775807 now fails before sending with reason `input`, or with the configuration error an option uses for an invalid ID. Fluxer refuses such an ID, so it used to fail remotely in a REST call. The helpers and asset URL builders already refused it
  Affected: Code that passes IDs above the signed 64-bit maximum and handles Fluxer's refusal
  Migration: Pass IDs Fluxer issued, and match reason `input`
- `snowflakes.isValid` now returns true for an ID with surrounding whitespace, and `snowflakes.parse`, `format.userMention` and the other helpers accept it and use the trimmed ID
  Affected: Code that uses `snowflakes.isValid` to require an ID without whitespace
  Migration: Compare the value with its `trim()` as well when the exact form matters
