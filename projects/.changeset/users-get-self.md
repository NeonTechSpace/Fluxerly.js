---
"@neontechspace/fluxerly": minor
---

Add `client.users.getSelf()` to both entry points, a local lookup of the bot's own public account as the gateway's READY reported it, without a request. It returns the `User` directly in the default API and a never-failing Effect in the Effect API, like `users.get`.
The result is undefined until the client's first READY, and also while no READY has carried a complete account. A later READY replaces it only when it carries a complete account, and the value remains available after the client stops. Other user updates do not change it, so use `users.fetchSelf` for a current remote snapshot
