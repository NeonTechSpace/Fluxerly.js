---
"@neontechspace/fluxerly": patch
---

Embed fields now accept an empty `name`, as Fluxer does. A field name may hold 0 to 256 UTF-16 code units and a value 0 to 1,024, both measured after Fluxer's normalization, so a blank name counts as empty. An empty or blank field name used to fail with reason `input` before sending. Fluxer's documentation still says field names hold 1 to 256 characters, but its server accepts and stores empty names, and the SDK follows the server
