---
"@neontechspace/fluxerly": minor
---

Add an optional `runBot` runner to both SDK entry points for critical subscriptions, graceful shutdown and opt-in process signal handling

Configure event handlers in one object, with automatic subscription registration, access to the full client and a message reply helper. Keep the explicit installer and low-level APIs for custom lifetime and subscription control

Keep native Effect context and Cause information while the default API returns expected failures as ResultAsync and sanitizes defects
