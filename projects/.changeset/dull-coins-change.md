---
"@neontechspace/fluxerly": major
---

Require the exact Effect peer `4.0.0-rc.117` instead of `4.0.0-rc.115`. Update the application's Effect dependency and lockfile together with the SDK, including applications using only the default API

Expand received message context with immutable partial-user metadata, non-notifying referenced users, explicit-emoji classifications and one resolved reply level without hidden requests. The `referencedMessage` type is now `ReferencedMessage`, not an address-only `MessageReference`. Hand-authored message fixtures must supply the resolved message shape or omit the optional field. Address-only operations can continue to use `MessageReference`. Additional retained context counts toward configured cache and collector byte budgets

Add explicit attachment URL refresh and endpoint-specific audit reasons through both APIs. Refresh preserves exact signed strings and does not download attachments. OAuth preflight now rejects overlong or noncanonical opaque values rather than changing them and bounds supplied scope arrays to 256 entries before deduplication. Member-role replacement enforces provider signed-identifier bounds

Add a plain JavaScript structured logger adapter, opt-in bounded stage measurements and aggregate event-work diagnostics. Measurements remain off by default, native Effect retains caller logging context, and applications retain responsibility for asynchronous sink delivery and aggregate admission policy

Improve resource-aware refill pacing, unrelated user and DM cache reads, incremental cache byte accounting and concurrent member-search preflight without replaying ambiguous writes. Scope logical scheduling to the owning Effect clock while retaining separate host-safety watchdogs

Native owner-backed gateway, REST, collector, member-stream, cache and presence timing now follows the Clock supplied when the client is created. Applications overriding logical time must create the client under that Clock rather than replacing it only around a later operation. Ownerless utilities retain their documented executing-clock behavior
