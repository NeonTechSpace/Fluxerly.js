---
"@neontechspace/fluxerly": minor
---

Pass an `EventContext` with `shardId` and `receivedBytes` to every `client.on` handler, as the third argument in the default API and the second in the Effect API.
The context names the local shard that received the event and the byte length of the gateway frame that carried it

Add `client.use(middleware)` to run event middleware around every later `on` handler invocation, including those of existing subscriptions, command routers and `runBot` handlers.
Middleware runs in registration order, receives the event name, payload, context and subscription ID, and can skip the handler by not calling `next`.
Failures of middleware and of the handler inside it are reported like handler failures, so middleware cannot hide a handler failure.
Both APIs return a `MiddlewareRegistration` with `close()`. The default registration also works with `using`, and the Effect API ends the registration when the executing Scope closes and runs middleware with the services available at registration
