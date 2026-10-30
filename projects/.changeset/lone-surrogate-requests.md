---
"@neontechspace/fluxerly": patch
---

Request text with a lone surrogate, half of a character such as an emoji left by `slice`, now fails locally with reason `input` and a message that explains the fix. Before, Fluxer answered it with an HTTP 503 error page and stored nothing, which looked like an outage. This covers every request the SDK encodes, such as message content, embeds and channel topics. The `text.truncate` and `text.split` helpers and `toWellFormed()` clean such text, and `client.rest.request` still sends its body as given
