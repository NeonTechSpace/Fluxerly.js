---
"@neontechspace/fluxerly": patch
---

Match a handler's failed HTTP 401 or 403 request by error identity, including wrapped causes, rather than status and Fluxer code. Unknown codes no longer cause duplicate rejection logs, and a handled request keeps its Warn when a different request with the same code fails the handler. A rejection is logged once unless the handler fails more than one second later, after its Warn has already appeared

Keep credential-key values masked in unsafe REST payload logging when a response exceeds the 65,536-byte read limit, including passwords and cookies in truncated JSON text. Invite-shaped objects in truncated lists also keep their access codes masked, while unrelated diagnostic and provider codes stay readable

Mask credential patterns in application error names and string codes in log records, failure descriptions, describeError and native Effect log causes and annotations. SDK error JSON also masks names in summarized causes, without changing the original error or its cause

List Debug for handled failure reports in the error and log code catalogue, alongside the existing unhandled failure levels
