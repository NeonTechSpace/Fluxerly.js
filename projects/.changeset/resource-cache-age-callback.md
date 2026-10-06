---
"@neontechspace/fluxerly": minor
---

Every resource cache kind now accepts a `maxAgeMs` callback, as the `messages` cache already did, so an application can choose per community, channel or other snapshot what gets cached. The callback receives the frozen snapshot and returns a duration in milliseconds, `null` for no age limit or `0` to skip retention, for example `channels: { maxAgeMs: (channel) => (watched.has(channel.guildId) ? null : 0) }`. A callback that throws or returns an invalid value removes the older copy and is reported as a `cache` failure to the client-level `onError`, or logged at Error, without changing the event or REST result. `ResourceCacheSettings` now takes the snapshot type as a type parameter, and `ClientOptions.cache` passes the matching type for each kind
