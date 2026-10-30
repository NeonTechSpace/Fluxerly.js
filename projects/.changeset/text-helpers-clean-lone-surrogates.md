---
"@neontechspace/fluxerly": minor
---

The `text.truncate` and `text.split` helpers now replace each lone surrogate with U+FFFD (�) instead of throwing `HelperError`. Ordinary code can create one, for example `slice` can cut an emoji in half, and Fluxer refuses a message that contains one, so a bot's text helper no longer fails on it. The replacement has the same length, so `maxLength` still holds, and `text.split` pieces join to `content.toWellFormed()`. A code path that relied on the error can check `content.isWellFormed()` first. A suffix that is not well-formed still throws, and so does text that is not a string
