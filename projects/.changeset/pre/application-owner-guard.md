---
"@neontechspace/fluxerly": minor
---

Add `ownerId` to the result of `client.application.fetch()` in both entry points, the decimal user ID of the account that owns the bot's application. The result keeps no other owner details, and a response without a valid owner ID now fails with `BotApplicationOperationError` and reason `"response"`.
`guards.ownerOnly()` called without IDs now allows only that owner. The first invocation reads the owner with `application.fetch`, and the guard keeps the ID for the client's lifetime. A failed read keeps nothing and fails the command, and the next invocation reads again. Explicit owner IDs work as before, and an `undefined` argument still throws `ConfigurationError`
