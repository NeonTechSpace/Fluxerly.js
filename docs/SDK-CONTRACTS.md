# SDK contracts

This document defines cross-cutting implementation constraints for SDK contributors.
These requirements do not imply that every planned API is implemented.
Member signatures, defaults and caller-visible behavior belong in public source comments and the website reference.
See [technology choices](/docs/TECHNOLOGY.md) for tooling and [the repository guide](/docs/REPOSITORY.md) for code and checks

The [default](/projects/sdk/src/index.ts) and [Effect-native](/projects/sdk/src/effect.ts) interfaces own the public API documentation

## Public API model

Both public entry points share one Effect implementation.
The default boundary owns execution and neverthrow conversion, without requiring a consumer-managed Effect runtime.
Native operations preserve caller context, interruption and scope ownership without a detached SDK runtime.
High-level helpers compose supported lower-level operations rather than exposing private modules.
Add conveniences only for concrete use cases, with explicit ownership and proportionate maintenance cost

## Results and failures

Share expected-error definitions across both entry points, using one readonly `_tag` classification rather than a duplicate error code.
Keep expected failures and cancellation distinct from SDK defects at the default boundary.
An operation failure or interruption must remain observable when cleanup also defects.
Do not overwrite either failure, downgrade a cleanup defect to a default expected error, or only log it.
Preserve native Effect cause information, but expose only allowlisted, SDK-owned diagnostic details through the default boundary.
Never include credentials, private payloads or arbitrary upstream errors in default diagnostic output

## Connection and recovery

Creation validates local configuration without opening sockets or starting background work.
The client owns its credential reference, session, recovery loop and retained lifetime outcome.
Connection readiness requires authentication and the required READY processing, not merely an open socket

Startup, a managed run and an outcome observer have distinct ownership.
Reject competing ownership without cancelling or cleaning up the accepted operation.
An expected standalone startup failure permits reuse only after cleanup, while an accepted managed run owns one permanent client lifetime

Cancellation of one outcome observer must not consume the retained outcome or stop other observers.
Coordinate initial state delivery with subscription setup, and keep public state observation bounded rather than treating it as a lossless transition log

Use separate startup and established-session retry policies, with one recovery loop rather than nested startup loops.
Respect server-required waits and stop on permanent failures, cancellation or SDK defects.
Do not count socket-cleanup time as healthy connected time when resetting recovery backoff.
Attempt session resumption before fresh identification when the protocol permits it, without treating successful replay as lossless delivery

Shutdown stops startup and recovery, shares cleanup across concurrent callers and awaits actual resource release.
Do not report timeout or cancellation completion while abandoning an owned socket

The SDK must not install process-signal handlers or terminate the consumer process

Allow bounded graceful socket closure, then force termination and await closure, with immediate termination for pending handshakes

## User-handler failures

Isolate user-handler failure from unrelated work and internal SDK defects.
Do not automatically retry a handler that may already have performed an external action.
Report through the configured hook or shared operational logger, without private payloads.
If the hook fails, attempt one safe fallback report without recursively invoking the hook.
Reporting cannot guarantee delivery when the fallback logger also fails

## Message event and send boundaries

[Event intake](/projects/sdk/src/internal/events.ts) owns per-subscription scheduling and bounded pending delivery.
[REST admission](/projects/sdk/src/internal/rest.ts) coordinates requests and rate state within one client, not across processes sharing a credential

Overflow terminates the affected subscription rather than restarting the gateway.
Shutdown discards pending delivery rather than draining external actions.
Default callback promises remain application-owned, while native cleanup is cooperative and awaited.
When a native handler requests shutdown, the client scope owns it to avoid the handler joining itself.
Only confirmed rate-limit rejection permits automatic REST retry within the original deadline.
Cancellation or a lost response after dispatch cannot establish non-delivery or rollback

Byte budgets bound the accounted data, not total JavaScript heap or process memory

## Message-management boundaries

Fetch, edit and delete reuse [REST admission](/projects/sdk/src/internal/rest.ts), with method/channel rate state and shared global limits.
Keep management failures separate from the send/reply delivery contract.
Repeated deletion or a missing target does not prove a prior operation succeeded

## Message-history boundary

[REST admission](/projects/sdk/src/internal/rest.ts) owns explicit history pages independently of cache reads and gateway events.
Keep history's channel rate bucket separate from single-message fetches while sharing global admission.
Do not introduce background traversal or prefetch through this path

## Message-cache boundary

Fluxer is the source of truth, not the optional client-owned memory cache.
[Cache intake](/projects/sdk/src/internal/cache.ts) integrates REST and gateway observations before subscriber dispatch.
Bound retained data and conflict metadata, and clear pre-gap observations even after session resumption

[Cache reporting](/projects/sdk/src/internal/cache-reports.ts) owns native context and one active custom report per client.
Neither retention nor reporting failure may change a successful REST result or event delivery

## Message-collector boundary

The [collector owner](/projects/sdk/src/internal/collector.ts) selects the channel before buffering and runs synchronous filters outside gateway decoding.
It owns separate pending-input and retained-result budgets, without REST or cache reads

Observe internal lifecycle transitions rather than the coalescing public state stream so a brief gap cannot be missed.
Terminal cleanup releases intake, state and signal listeners, timers, queued payloads and filter references.
Application-held successful results may outlive collector cleanup

Do not change existing subscription recovery behavior or imply atomic registration and remote sending

## Logging

Use the shared Effect logger rather than a second logging implementation.
Keep explicit SDK development-log opt-in separate from operational handler-error reporting and consumer Debug settings.
The default runtime owns its logging configuration, while native execution preserves caller logger and tracing context

No customization may bypass private-data exclusion.
Keep default public declarations free of Effect types by exposing advanced logger integration through the Effect entry point

Emit safe lifecycle diagnostics at the connection owner, not by reconstructing history from coalescing state observations.
Logging adds no queue or persistence ownership, and sink failures must not alter operation outcomes or recurse

## Naming

Use concrete verbs and let the containing object supply the subject, as in `client.connect`.
Use the same operation names across both public entry points, without an Effect suffix.
Use `create` for construction without background work, `connect` for readiness, `run` for owned execution and `waitFor` for observation.
Reserve `fetch` for remote retrieval and `get` for local lookup.
Use `shutdown` for permanent, awaited cleanup.
Name units explicitly, such as `timeoutMs`, and use `is`, `has` or `can` for boolean conditions

## Validation requirements

Validate both public entry points, their execution differences and packed consumer imports.
Cover admission races, readiness, retry limits and server waits, cancellation ownership, retained outcomes and awaited cleanup.
Check combined failures, handler isolation, diagnostic privacy and native context preservation.
Verify bounded state delivery, late observers and unavailable/reset latency values

Use separate runtime and consumer type checks, including natural process exit where resource ownership matters.
Tests must establish the affected behavior rather than merely succeed against fixtures

Use [development checks](/docs/REPOSITORY.md#development-checks) for commands and public source comments for the behavior under test
