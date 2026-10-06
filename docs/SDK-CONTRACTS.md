# SDK contracts

This document defines implementation constraints that span SDK modules.
A rule that one module owns lives in that module's header comment, which links back to the section it implements.
Member signatures, defaults and caller-visible behavior belong in public source comments.
See [technology choices](/docs/TECHNOLOGY.md) for tooling and [the repository guide](/docs/REPOSITORY.md) for code and checks

## Public API model

The [default](/projects/sdk/src/index.ts) and [Effect](/projects/sdk/src/effect.ts) entry points are barrels over one Effect implementation.
Public signatures and member documentation live in the hand-written interfaces under [src/api/default/](/projects/sdk/src/api/default/) and [src/api/effect/](/projects/sdk/src/api/effect/), with paired members documented identically.
The [operation table](/projects/sdk/src/internal/binding/operations.ts) defines every client namespace member once, and the [default](/projects/sdk/src/internal/binding/default.ts) and [native](/projects/sdk/src/internal/binding/native.ts) binders adapt it by kind. A rename or signature change goes through the table and both interface sets.
The default API converts results to neverthrow, so consumers do not manage an Effect runtime.
The Effect API runs in the caller's context and scope and preserves interruption without starting a detached SDK runtime.
The [testing](/projects/sdk/src/testing.ts) and [Effect testing](/projects/sdk/src/effect-testing.ts) entry points create real clients over an in-memory protocol-v1 gateway and HTTP transport supplied through the `transport` option, and the default testing declarations stay free of Effect types. The test gateway owns filtering per Identify session, retains it across Resume and rejects emissions that upstream would suppress before consuming a sequence.
Add a high-level helper only for a concrete use case, with clear cleanup responsibility and a reasonable maintenance cost

## Results and failures

Return a Result or a failing Effect only where the failure is a real runtime outcome: Network and other I/O operations, gateway commands, event waits and a collector's result.
Misuse is not an outcome. Invalid creation options, registrations, event names and cache-lookup input throw `ConfigurationError` or the domain error in the default API and are defects in the native API.
Invalid input to an operation that already returns a Result or Effect stays in that failure channel, because such input often comes from runtime data.
Pure helpers and cache lookups return plain values in both APIs, with `try` variants returning a Result or Effect for untrusted text.
An Err result returned by any application callback is reported like a throw of its error

Both entry points share expected-error definitions, classified by one readonly `_tag`.
Every SDK error extends the [error base](/projects/sdk/src/errors.ts) with a stable `code`, an optional `hint`, frozen `details` and a standard `cause`. The code refines the tag for readers and must not become a second classification that callers branch on.
The default API distinguishes expected failures and cancellation from SDK defects.
If cleanup also fails, callers still observe the original failure or interruption, and the cleanup defect is neither reported as an expected error nor left only in logs.
Both APIs keep a cleanup defect's original value, as the `SdkDefect` cause and reason or as the native Cause defect, and SDK error text such as messages, `toJSON` and `describeError` masks credential patterns in it.
Preserve native Effect causes. A default-API `SdkDefect` carries every failure and defect value, including application-thrown values, and marks which side raised it.
A throw while reading caller-supplied options or input, such as from a property getter or a caller AbortSignal listener method, is application-raised. Mark it where the SDK reads that input, through the [defect helpers](/projects/sdk/src/internal/defects.ts), rather than inferring the origin from the thrown value. Where SDK work runs in the same step, mark only the reads, so a fault in that work stays an SDK fault.
SDK-generated details stay allowlisted, provider error bodies keep only sanitized codes, messages and field paths, transport causes keep only an error code, and no error, detail or cause the SDK creates contains credentials

## Connection and recovery

Creation validates local configuration without opening sockets or starting background work.
The [client](/projects/sdk/src/internal/client.ts) owns its credential reference, per-shard sessions and recovery loops, and one retained lifetime outcome. Readiness requires authentication and READY processing, not an open socket.
Starting, running and observing the outcome are separate operations. A competing start or run is rejected without disturbing the one in progress, a failed standalone startup permits reuse only after cleanup, and an accepted managed run owns one permanent lifetime.
Cancelling one outcome observer never consumes the retained outcome, and public state observation stays bounded rather than a lossless transition log

Each assigned shard has its own recovery loop, session, sequence, heartbeat and backoff, while REST scheduling, subscription limits and cache limits apply across the client.
The [shard plan](/projects/sdk/src/internal/sharding.ts) decides guild ownership, never cache contents or discovery hints. An explicit plan never changes.
Cross-process assignment stays application-owned, except that the [local supervisor](/projects/sdk/src/internal/supervisor.ts) splits a plan across the children it forks. A restarted child keeps its assignment, and only a reshard replaces the assignments. Identify commands across processes are coordinated only by an application-supplied identify coordinator or by that supervisor for its children, which consults such a coordinator when one is supplied.
An automatic plan is sized at the first connect from the bot's guild count, never from `GET /gateway/bot`. When Fluxer closes a shard with 4011 (sharding required), the client releases the old sessions' guild-scoped observations, counts again and moves every shard to a larger plan with new sessions, a bounded number of times per hour.
The supervisor with `totalShards: "auto"` answers a child's 4011 the same way: It stops every child, counts again and starts children for a larger plan, at most 3 moves an hour, and fails beyond that limit.
Outbound commands share one session-owned pacing history below Fluxer's payload limits, retained across in-process Resume and reset for Identify, while each socket attempt owns its bounded waiting queue. Cancellation or expiry withdraws unsent request commands and releases queue capacity exactly once, and disconnect abandons that attempt's queue. Presence retains one unsent status update per shard and measures spacing from actual transmission. Heartbeat, Identify and Resume are never delayed behind other commands.
Saved sessions are written only at shutdown after sockets close, and are resumed only within Fluxer's retention window and only against the discovered gateway endpoint. If partial restored replay falls back to Identify, the shard clears guild-scoped observations and dependent resources at fallback and again at READY, including reads cached during the outage. Successful Resume retains those observations.
Invalid data from the server retries with a new session, bounded by a limit of consecutive protocol failures, while local receive rejections end the shard

Shutdown stops startup and recovery, shares cleanup across concurrent callers and awaits actual resource release, never reporting completion while abandoning an owned socket.
A [draining shutdown](/projects/sdk/src/internal/client/drain.ts) first stops event intake and only waits, up to its deadline, for running and queued handler work and in-flight REST requests. The ordinary shutdown that follows cancels what is left. The bot runner drains on a requested stop, and a supervised child drains when its parent stops it, keeping one second of the parent's grace period to close.
All network I/O goes through one [transport seam](/projects/sdk/src/internal/transport/index.ts). A caller transport replaces only the fetch and WebSocket implementations, while the SDK keeps its redirect, deadline, cancellation, size and rate-limit policies, and every HTTP request and gateway handshake carries one User-Agent.
Importing the SDK never installs process-signal handlers or terminates the process. Only the [bot runner](/projects/sdk/src/internal/bot-runner.ts) handles signals, by default in the default API and on explicit opt-in in the Effect API, whose launcher may already handle them, removes its listeners when the run ends and sets `process.exitCode` after a failed run unless the application opts out. Only the supervisor terminates processes, limited to its own unresponsive children

## User-handler failures

Isolate application failures from unrelated work and SDK defects, and never automatically retry a handler that may have performed an external action.
Errors are never silent. Every application failure without a returned result, including handlers, commands, collector callbacks and filters, cleanup progress, cache callbacks, state observers and overflow, reaches exactly one destination: The subscription's `onError` hook, then the client's `onError` hook, then an Error record from the [failure reporter](/projects/sdk/src/internal/failures.ts).
A callback that returns or resolves an Err result fails with its error, through [throwIfErr](/projects/sdk/src/internal/failures.ts), so returning a failed Result cannot hide a failure.
A report carries the original thrown value unchanged with its stack and cause chain, plus event, command, subscription and message identifiers. Native reports also keep the Effect cause.
Reporting never throws and never alters handler scheduling, subscription lifetime or operation outcomes.
A rejection is logged once unless the handler fails more than one second later. A `rest.rejected` Warn raised inside a handler invocation waits in that invocation's [rejection scope](/projects/sdk/src/internal/rejection-scope.ts) until the invocation ends or for at most one second. A handler failure logged at Error replaces only the held record for that rejection's identity, directly or in its bounded cause chain. Domain error conversions retain a private weak identity link without changing the public cause. A later handler failure also logs its own record, because the Warn has already been emitted. A rejection the application handles or passes to an `onError` hook still logs the Warn.
Any intentional discard in SDK source carries an `allow-silent:` comment naming where the failure is observed, enforced by the [silent-discard check](/projects/sdk/scripts/silent-discards.js), which runs with SDK lint

## Delivery, requests and caches

[Event intake](/projects/sdk/src/internal/events.ts) owns per-subscription scheduling and bounded delivery. Overflow affects only its own subscription, which drops waiting events or ends by its overflow policy, rather than restarting the gateway, and shutdown discards pending delivery unless a draining shutdown first lets queued handler events run.
A partitioned subscription starts events in receive order per key and runs at most one invocation per key, selecting from its own bounded queue.
[REST](/projects/sdk/src/internal/rest.ts) coordinates requests and rate state within one client only. Mutations retry only after a confirmed rate-limit rejection, and eligible reads use their documented bounded retries. Cancellation or a lost response after dispatch cannot establish non-delivery or rollback, and multi-step workflows are not transactions.
Caller-described requests share the same admission, rate learning and retry rules, accept only relative API paths that cannot change the origin or carry a webhook credential, and appear in logs only as masked route templates.
Byte budgets bound accounted data, not heap or process memory. No path adds background traversal, prefetch, retained rosters or a distributed coordinator.
Fluxer is the source of truth. Optional client-owned caches bound what they retain and apply gateway intake before subscribers see an event. A connection gap invalidates older observations, so a pre-gap request can neither repopulate a snapshot nor evict a newer one. Guild-scoped snapshots stay while a shard resumes, because Fluxer's Resume replays every missed dispatch or refuses the session, and are released when the shard starts a new session. Cache and reporting failures never change a successful REST result or event delivery

## Logging

The [client logger](/projects/sdk/src/internal/logging.ts) emits one record shape with a level, category, stable code, message and safe fields.
Clients log lifecycle, reconnects, long rate-limit waits, drops, shutdown and application failures by default, and Debug records per category through settings or `FLUXERLY_DEBUG`.
Every drop is recorded and counted in client diagnostics. Only Debug records may cover expected, high-volume outcomes such as unmatched commands.
Native execution logs through the caller's Effect logger with `fluxerly.*` annotations and carries a Cause of masked copies, never the original failure values. Advanced logger integration stays in the Effect entry point, keeping default public declarations free of Effect types.
Application errors appear in full, provider data is sanitized, and credentials are never logged. Message content and raw payloads appear only with the explicit unsafe payload settings, and no customization bypasses credential masking.
Log lifecycle events where connections are managed rather than reconstructing them from coalesced state. Logging adds no persistence ownership and never alters operation outcomes.
The [observer](/projects/sdk/src/internal/observer.ts) set by the `observe` client option belongs to the client logger. It receives frozen measurements of REST attempts, rate-limit waits, reconnects, resumes and handler invocations, carrying only route templates, names, codes, counts and durations. An observer fault is counted like a log sink fault and never changes SDK work.
HTTP 401 and 403 rejections, which persist until someone changes the token or permissions, log one deduplicated Warn per route and code even when the application handles the Result.
Every record code and error code has an entry in the [code catalogue](/projects/sdk/src/internal/code-catalogue.ts), which the website's error and log codes page is generated from

## Naming

Use concrete verbs with the containing object as subject, as in `client.connect`, and the same names in both entry points without an Effect suffix.
Use `create` for construction without background work, `connect` for readiness, `run` for owned execution, `waitFor` for observation, `fetch` for remote retrieval, `get` for local lookup and `shutdown` for permanent, awaited cleanup.
Subscriptions, collectors and observers end with `close`, which returns at once. Subscriptions expose `waitForClose` and collectors expose `result` to await cleanup and the final outcome.
Name units explicitly, such as `timeoutMs`, and use `is`, `has` or `can` for boolean conditions.
Pass settings as named option objects rather than boolean positionals, and require an explicit `confirm: true` for irreversible bulk deletion

Lists follow one convention. Members named `fetchAll`, `fetchFor<Owner>` or `fetchBans` return a complete list from one response.
A `fetchPage` or `fetch<List>` member returns one page, and the matching `iterate` or `iterate<List>` member lazily traverses all pages of the same list with explicit bounds. A `search` member returns one page and pairs with `iterateSearch`

## Validation requirements

Validate both APIs, their execution differences and packed consumer imports of every public entry point.
Cover admission races, readiness, retry limits and server waits, cancellation ownership, retained outcomes, awaited cleanup, combined failures, handler isolation, diagnostic privacy, native context preservation, bounded state delivery, late observers and unavailable or reset latency values.
Compare provider projections with a pinned producer schema and implementation, account for omitted fields explicitly, and trace referenced validators to their definitions.
Test values flowing between public operations and equivalent default and native workflows, including malformed JavaScript structures at documented validation boundaries. A fixture copied from the SDK's own shape cannot establish provider completeness.
Use separate runtime and consumer type checks, including natural process exit where resource ownership matters.
Use [development checks](/docs/REPOSITORY.md#development-checks) for commands and public source comments for the behavior under test
