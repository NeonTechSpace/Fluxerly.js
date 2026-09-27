---
"@neontechspace/fluxerly": minor
---

Provide a native client as an Effect service with `FluxerClient` from the Effect entry point.
`FluxerClient.layer(options)` creates the client in the layer's scope and shuts it down when that scope closes.
`FluxerClient.layerConfig({ token: Config.Redacted("FLUXER_BOT_TOKEN") })` reads the token, and optionally any other top-level setting, from Effect `Config`. The token stays redacted until the client receives it.
A missing Config value fails the layer with `ConfigError`, while a blank token or another invalid setting dies with `ConfigurationError`.
Building either layer does not connect. Register handlers, then call `client.connect()` or `client.run()`
