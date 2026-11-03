---
"@neontechspace/fluxerly": patch
---

Masking hides more credentials written into error and log text:

- A cookie list in an assignment, such as `cookies=sid=…; refresh=…`, `Cookie=…` or `set_cookie=…`, is now hidden whole. Only its first cookie used to be hidden. A quoted cookie value, an `Expires` date and a `Set-Cookie` array joined into text with commas are hidden with it, while a query after the list, such as `&state=…`, and the text after it stay readable
- A cookie list in an assignment stays hidden when an earlier cookie holds `&`, `'`, `}` or a backtick, which cookie names and values allow. Such a character used to end the hidden part and leave later cookies readable
- The `verifier` of an `oauth.createPkce()` result is now hidden in error causes, log records and payloads, also when written into text as `verifier=…`. Its `challenge` stays readable
