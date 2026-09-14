# SDK contracts

This document defines cross-cutting implementation constraints for SDK contributors.
These contracts define implementation requirements, not an API inventory.
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
Do not overwrite either failure, downgrade a cleanup defect to an expected error, or only log it.
Preserve native Effect cause information, but expose only allowlisted, SDK-owned diagnostic details through the default boundary.
Never include credentials, private payloads or arbitrary upstream errors in default diagnostic output

## Connection and recovery

The [instance resolver](/projects/sdk/src/internal/instance.ts) owns one immutable endpoint map per client, including webhook-only clients.
Discovery is lazy, unauthenticated and shared by concurrent REST, gateway and explicit resolution callers.
Each caller keeps its own deadline and cancellation, and the last departing caller awaits shared request cleanup

An explicitly selected instance is trusted to advertise service origins that receive its credential.
Require HTTPS and WSS unless that instance explicitly permits plaintext, validate bootstrap redirects and reject credentialed service redirects

Pure instance-bound URLs use the advertised bases without refreshing discovery or performing requests

Creation validates local configuration without opening sockets or starting background work.
The client owns its credential reference, per-shard sessions and recovery loops, and one retained lifetime outcome.
Connection readiness requires authentication and the required READY processing, not merely an open socket

Startup, a managed run and an outcome observer have distinct ownership.
Reject competing ownership without cancelling or cleaning up the accepted operation.
An expected standalone startup failure permits reuse only after cleanup, while an accepted managed run owns one permanent client lifetime

Cancellation of one outcome observer must not consume the retained outcome or stop other observers.
Coordinate initial state delivery with subscription setup, and keep public state observation bounded rather than treating it as a lossless transition log

Use separate startup and established-session retry policies, with one recovery loop per assigned shard rather than nested startup loops.
Respect server-required waits and stop on permanent failures, cancellation or SDK defects.
Do not count socket-cleanup time as healthy connected time when resetting recovery backoff.
Attempt session resumption before fresh identification when the protocol permits it, without treating successful replay as lossless delivery

The [client owner](/projects/sdk/src/internal/client.ts) supervises assigned sessions as one lifetime and paces actual Identify sends within that client.
The immutable [shard plan](/projects/sdk/src/internal/sharding.ts) owns guild routing; do not infer ownership from cache contents or discovery sizing hints.
Session state, sequence, heartbeat timing and reconnect backoff belong to one shard; REST admission, event-subscription budgets and cache limits belong to the client

Keep a healthy shard's work independent of another shard's transient gap, while awaiting every assigned shard for initial readiness.
Group startup has one deadline, including Identify waits, and terminal supervision must preserve sibling cleanup failures

Cross-process assignment and Identify coordination remain application-owned unless callers opt into the local supervisor.
The optional supervisor coordinates only fixed assignments and fresh Identify sends among child processes that it forked itself. It does not coordinate another process or host, discover shard counts, preserve sessions across replacement, or manage distributed REST limits

Shutdown stops startup and recovery, shares cleanup across concurrent callers and awaits actual resource release.
Do not report timeout or cancellation completion while abandoning an owned socket

The SDK must not install process-signal handlers or terminate the consumer process.
The local supervisor may terminate only an unresponsive child process that it forked itself after its graceful deadline, and still awaits that child’s exit

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
When a native handler requests shutdown, the client scope owns it to avoid the handler joining itself

Mutations retry only confirmed rate-limit rejection; eligible reads use the bounded transient-retry policy documented on their public operation groups.
Cancellation or a lost response after dispatch cannot establish non-delivery or rollback

Byte budgets bound the accounted data, not total JavaScript heap or process memory

Attachment byte inputs are copied before waiting, while sized files and finite streams remain caller-owned until readers are acquired.
The [transfer source](/projects/sdk/src/internal/transfer-source.ts) verifies exact byte counts and awaits acquired reader cleanup without buffering unknown-length streams

Presigned upload plans authorize individual destinations without sending bot credentials to them.
Inline fallback is limited to a disabled presigned-upload feature or its explicit planning rejection, not a failed PUT or uncertain message request.
Only copied byte sources may replay after an inline rate-limit rejection.
Failed operations may leave provider-owned temporary uploads, and cancellation cannot roll back a dispatched message

Downloads accept only the selected instance's media attachment URLs, enforce a caller-provided output limit and send no credential or cookie

## Message-management boundaries

Fetch, edit and delete reuse [REST admission](/projects/sdk/src/internal/rest.ts), with method/channel rate state and shared global limits.
Keep management failures separate from the send/reply delivery contract.
Repeated deletion or a missing target does not prove a prior operation succeeded

## Message-history boundary

[REST admission](/projects/sdk/src/internal/rest.ts) owns explicit history pages independently of cache reads and gateway events.
Keep history's channel rate bucket separate from single-message fetches while sharing global admission.
Do not introduce background traversal or prefetch through this path

The [pagination owner](/projects/sdk/src/internal/pagination.ts) composes existing remote page operations without changing their retries, rate state or cache admission.
Each consumption owns one buffered page and bounded pin-deduplication state, released on termination or client closure.
The default iterator owns Result conversion, while native streams keep request execution and cleanup in the caller's scope

## Guild resource boundary

[Guild projection](/projects/sdk/src/internal/guilds.ts) validates request inputs and maps REST/gateway observations without retaining resource state.
Guild operations share the existing REST owner and client-global admission limits, with guild-major route buckets separate from message routes.
They never enter the message cache or synthesize gateway events after HTTP responses

The optional [guild cache owner](/projects/sdk/src/internal/guild-cache.ts) retains projected observations separately, with per-resource client-wide limits.
REST registers resource conflict guards before admission waits and retains them through retries and cleanup.
Gateway intake updates or invalidates caches before subscriber delivery, including related memberships after role deletion.
Connection gaps prevent old requests from repopulating snapshots, while late writes still invalidate potentially affected newer observations

Fluxer remains authoritative for membership, permissions and role hierarchy; an earlier observation cannot suppress a targeted role request.
Multi-step resource workflows are not transactions, and uncertain writes must not be replayed as if they were reads

## Guild channel boundary

[Channel projection](/projects/sdk/src/internal/channels.ts) validates guild-channel requests and maps REST/gateway observations.
The shared REST owner keeps guild-major and channel-major routes separate while sharing client-global admission and cleanup

The optional [channel cache](/projects/sdk/src/internal/channel-cache.ts) owns ID-keyed observations with client-wide limits, never effective permission decisions

Dispatched mutations invalidate channel snapshots and pending channel reads because category and ordering changes can affect descendants.
Rejection of a multi-entry reorder does not establish rollback of its earlier entries

Bulk gateway observations invalidate their guild rather than retaining permissions that Fluxer may still be copying.
Channel create/delete events can represent visibility changes, so they do not prove remote creation/deletion.
Channel deletion or visibility loss evicts related cached messages without synthesizing message events or changing collector completion contracts

Preserve omitted permission overwrites separately from an explicit empty list throughout input encoding

## Message-cache boundary

Fluxer is the source of truth, not the optional client-owned memory cache.
[Cache intake](/projects/sdk/src/internal/cache.ts) integrates REST and gateway observations before subscriber dispatch.
Bound retained data and conflict metadata, and clear pre-gap observations even after session resumption

Known guild ownership scopes gap invalidation to its shard; known private-conversation observations belong to shard zero.
Unknown ownership remains conservative, including channel-only in-flight reads, without adding an unbounded channel-to-guild index.
Pre-gap requests must neither repopulate invalid snapshots nor evict healthy post-gap observations on late completion

[Cache reporting](/projects/sdk/src/internal/cache-reports.ts) owns native context and one active custom report per client.
Neither retention nor reporting failure may change a successful REST result or event delivery

## Message-collector boundary

The [collector owner](/projects/sdk/src/internal/collector.ts) selects the channel before buffering and runs synchronous filters outside gateway decoding.
It owns separate pending-input and retained-result budgets, without REST or cache reads

Observe internal lifecycle transitions rather than the coalescing public state stream so a brief gap cannot be missed.
Caller-supplied guild context selects the owning shard's lifecycle and source-filtered event intake; channel-only collectors retain aggregate gap handling.
Validate that context locally without hidden REST or cache reads, and discard conflicting source events before buffering

Optional progress work runs in a collector-owned fiber under the client scope, with the registration context.
Client shutdown and registration-scope closure wait for that work, while stopping intake prevents later callbacks

Terminal cleanup releases intake, state and signal listeners, timers, queued payloads and filter/handler references.
Application-held successful results may outlive collector cleanup

Do not change existing subscription recovery behavior or imply atomic registration and remote sending

## Gateway request ownership

The [gateway request budget](/projects/sdk/src/internal/gateway-requests.ts) is client-wide, not multiplied by local shard count.
The [count owner](/projects/sdk/src/internal/counts.ts) holds one logical admission lease across shard fragments and releases every fragment on terminal failure or interruption.
Provider omissions are result data, not a substitute for local routing, readiness or transport failures

The [member-chunk owner](/projects/sdk/src/internal/member-chunks.ts) permits one active stream per client and fails it only for its owning shard's gap or client closure

The [presence owner](/projects/sdk/src/internal/presence.ts) retains shared caller intent and bounded member selections, with per-shard transports and write pacing.
No gateway request path retains a roster or adds a distributed coordinator

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
