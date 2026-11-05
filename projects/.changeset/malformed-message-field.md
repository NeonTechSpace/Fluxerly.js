---
"@neontechspace/fluxerly": patch
---

A malformed response now names the field that failed in `responseField`, such as `embeds.0.timestamp`. A message with a bad embed, attachment or other nested part used to be reported as a later field the decoder went on to read, such as `stickers`. Forum post data now names a malformed owner instead of the first message, a discovery search names the result that failed instead of the last one, and a webhook names the nested field of a malformed source community or channel instead of the whole source
