---
"@neontechspace/fluxerly": patch
---

Preserve inherited and non-enumerable command fields during batch registration in both APIs, so supplied guards, argument schemas, cooldowns and rejection callbacks cannot silently disappear

Snapshot recognized command and cooldown fields before validation and retain those same values, preserving atomic registration and preventing changing getters from replacing validated policies
