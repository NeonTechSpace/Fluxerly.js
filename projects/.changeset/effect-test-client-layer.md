---
"@neontechspace/fluxerly": minor
---

Add `FluxerTestClient` to `@neontechspace/fluxerly/effect/testing` for applications that read their client from the `FluxerClient` service.
`FluxerTestClient.layer(options)` creates a test client with `createTestClient` and provides its client as `FluxerClient` and the whole test client, with its controls, as `FluxerTestClient`. Application code then runs against the in-memory Fluxer unchanged.
Closing the layer's Scope shuts the client down and dies with `UnhandledTestFailuresError` for a handler failure the test did not read
