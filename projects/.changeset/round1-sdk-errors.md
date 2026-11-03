---
"@neontechspace/fluxerly": patch
---

Errors, masking and the test kit:

- Masking now hides a PKCE `code_verifier` and a `set_cookie` value written in text, such as `code_verifier=…` in a form body, `codeVerifier: '…'` or `SET_COOKIE=…`, in every separator and letter case. Payload keys of those names were already hidden
- The `EventOverflowError` hint and the `events.overflow` codes no longer suggest an `overflow` option for `client.subscribe`, which refuses it. To drop events instead of stopping, they now point to a handler registered with `client.on` and its `overflow` setting
- The codes reference says that `details.responseField` names the failing field or check when the SDK identifies one, since some response failures have none
- The test clients now refuse `logging: []` with `ConfigurationError`, as `createClient` does. They used to accept it
- The packaged agent guide says that local work returns plain values in the default API, and points native Effect applications to their own section
