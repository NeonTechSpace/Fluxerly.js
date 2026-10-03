---
"@neontechspace/fluxerly": major
---

Message search no longer fails when a result comes from an unnamed group DM, in both entry points. Fluxer now sends `name: null` for such channels, so `MessageSearchChannel.name` is now `string | null` when present, and code that reads it must handle null
