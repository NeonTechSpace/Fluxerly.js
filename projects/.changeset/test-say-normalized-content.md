---
"@neontechspace/fluxerly": patch
---

The test kit now normalizes message content as Fluxer does. Fluxer removes form feed (U+000C) and U+202E from sent message text and trims surrounding whitespace before it stores and delivers the message, so a user who types `!ping ` reaches the bot as `!ping`. Before, `say` delivered the content unchanged, so a test could ignore input that a live bot answers, or the other way round. Now `say` delivers the normalized content, and the automatic reply to an unregistered message send or edit echoes the normalized content too. A test that expected a bot to ignore content with surrounding whitespace through `say` now sees the bot answer it, as it would on Fluxer. Delivering `fixtures.message` through `emit` still passes content unchanged
