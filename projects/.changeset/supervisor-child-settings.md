---
"@neontechspace/fluxerly": patch
---

Preserve inherited and non-enumerable client settings in both supervisor child APIs, so an explicitly selected instance is not silently replaced by hosted Fluxer. Reject inherited token and sharding overrides as well as own-property overrides
