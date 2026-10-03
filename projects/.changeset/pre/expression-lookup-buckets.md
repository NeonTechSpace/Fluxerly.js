---
"@neontechspace/fluxerly": patch
---

A successful emoji or sticker metadata or source lookup no longer pauses unrelated requests such as message sends. Fluxer limits these lookups in one bucket per bot across all emojis or stickers, and the SDK now tracks them that way, so running out of that bucket still delays the next lookup of any emoji or sticker
