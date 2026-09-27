---
"@neontechspace/fluxerly": major
---

Make public types describe what Fluxer actually sends and what builders accept.
`GuildChannel` is a union of `GuildTextChannel`, `GuildVoiceChannel`, `GuildCategoryChannel`, `GuildLinkChannel` and `GuildUnknownChannel`. Comparing `channel.type` with a `ChannelType` constant narrows it to exactly that shape, so `if (channel.type === ChannelType.Voice)` yields a `GuildVoiceChannel`. A channel type this SDK version does not know arrives as a `GuildUnknownChannel` whose `type` is `"unknown"` and whose `rawType` holds the number Fluxer sent, so a `switch` on `type` that also handles `"unknown"` is exhaustive.
`PresenceUpdate.status` is an `ObservedPresenceStatus`, and an unrecognized status from Fluxer becomes `"unknown"` instead of an arbitrary string.
`EmbedBuilder.color` accepts any `ColorInput`, such as `"#ff8800"` or an RGB tuple, and `EmbedBuilder.timestamp` accepts a `Date`, epoch milliseconds or an ISO string. An invalid color, or an invalid `Date` or number, throws `HelperError` with operation `embed.color` or `embed.timestamp`.
The type error from calling `build()` on an empty `MessageBuilder` now names the missing body, through the exported `MissingMessageBody` type.
Default clients, OAuth clients, webhook clients, subscriptions and collectors support `await using`, which shuts a client down or closes a subscription or collector and waits for its cleanup

Migration:

- Narrow a `GuildChannel` on `type`, for example with `ChannelType.Voice`, before reading `bitrate`, `userLimit` or other fields that belong to one channel type
- Handle channel types outside `ChannelType` by checking `channel.type === "unknown"` and reading the Fluxer number from `channel.rawType`. A numeric `type` no longer carries an unknown type
- Compare `PresenceUpdate.status` against the listed values and handle `"unknown"` instead of Fluxer strings outside that list
- `EmbedBuilder.color(value)` converts its input, so pass the color directly rather than converting it first. A number outside the 24-bit range now throws
- `EmbedBuilder.timestamp(value)` converts a `Date` or number with `toISOString()`. An invalid `Date` or number now throws instead of producing an invalid embed
