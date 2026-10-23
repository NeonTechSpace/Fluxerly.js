---
"@neontechspace/fluxerly": minor
---

`ResolvedInstance` has a new `discoveryEnabled` flag, in both APIs, that reports whether the instance has community directory discovery switched on. Fluxer documents a missing flag as enabled, so it reads `true` when the instance omits it. While it is `false`, the discovery namespace's `search`, `apply`, `edit` and `withdraw` fail with reason `rejected`, HTTP 400 and `details.providerCode` `DISCOVERY_DISABLED`, while `fetchStatus` and `fetchCategories` still answer, and `fetchStatus` then reports `eligible` as `false`. The value is read once when the client resolves the instance. Behavior change: A discovery document whose `features.discovery_enabled` is present but not a boolean is now rejected as a protocol failure, like a malformed `presigned_attachment_uploads`
