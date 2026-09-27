---
"@neontechspace/fluxerly": major
---

Every operation that takes an input, query or options object rejects a key it does not support before sending anything, in both API styles. The failure is the operation's own error with reason `input` and an `inputValidation` constraint of `allowedFields`. Its explanation names the key, suggests the closest supported key and lists the supported keys, for example `Unsupported option "timeout" in the operation options. Did you mean "timeoutMs"? Supported options are timeoutMs, signal`

Operations that sent the request and ignored an unknown key before now reject it: The options of message sends, replies, forwards, edits, deletions, fetches, searches, pins and reactions, the OAuth `authorizationUrl`, `exchangeCode` and `revoke` inputs, and the default API `gateway.send` options. Channel position entries and permission overwrites report an unsupported key separately instead of as a general format failure. The `instance.resolve` and `cache.entries` options name an unsupported key and suggest the closest one in their `ConfigurationError`

Migration: Remove keys that an operation does not support from its input, query and options objects. Each failure names the first unsupported key it finds
