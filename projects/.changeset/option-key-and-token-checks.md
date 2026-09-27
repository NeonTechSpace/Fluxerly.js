---
"@neontechspace/fluxerly": major
---

Reject misspelled and unsupported top-level option keys in `createClient`, `runBot` and `supervisor.create` in both entry points with `ConfigurationError`, whose hint names the closest supported key, such as `events` for `event`.
The `clientOptions` of `supervisor.child.run` are checked the same way, where an unknown key was silently dropped before, so the child client ran without it.
Unsupported keys in the nested `logging`, `cache`, `cache.messages`, `cache.<kind>`, `connection`, `connection.recovery`, `uploads`, `gateway`, `sharding`, `instance` and supervisor `restart` settings are named in the message with the same suggestion, and a removed logging setting names its replacement

Normalize the configured token: Surrounding whitespace and one pair of matching quotes, which `.env` files often add, are removed.
A token that starts with a `Bot` or `Bearer` scheme is rejected with `ConfigurationError`, since the SDK adds the `Bot` scheme itself.
The `auth.rejected` hint suggests checking the configured value before regenerating the token

Migration: Remove option keys that `createClient`, `runBot`, `supervisor.create` or the `clientOptions` of `supervisor.child.run` do not support, including unknown nested keys such as a `connection` key other than `startupTimeoutMs`, `maxStartupAttempts` and `recovery`, and pass the bare token without a `Bot ` or `Bearer ` prefix
