# Repository guide

Use this guide to find the code responsible for each SDK feature, configure the workspace and run contributor checks.
The SDK is in development and is not released for supported public use.
The documentation website builds locally with a handwritten quickstart and generated public API reference.
Registry release commands enforce the [registry publication contract](/docs/RELEASING.md#registry-publication-contract)

## Project areas

| Location | Purpose |
| --- | --- |
| [SDK](/projects/sdk/) | The Fluxer-native JavaScript SDK, with the package identity in its [manifest](/projects/sdk/package.json) |
| Website (`projects/web/`) | The documentation website, with its own manifest (`projects/web/package.json`) |
| [Release tooling](/projects/release/) | Changesets planning, immutable candidates, registry reconciliation and exact-source GitHub announcements |
| [Documentation](/docs/) | Repository Markdown documents, including the public [README](/docs/README.md) and this guide |

| Area | Entry points and ownership |
| --- | --- |
| Public API | The [default](/projects/sdk/src/index.ts) and [Effect-native](/projects/sdk/src/effect.ts) entry points define signatures and member documentation. Public resource modules define their types and operation errors |
| Client and transport | [Client](/projects/sdk/src/internal/client.ts), [gateway](/projects/sdk/src/internal/gateway.ts), [REST](/projects/sdk/src/internal/rest.ts) and [instance discovery](/projects/sdk/src/internal/instance.ts) own lifetime, recovery, admission and endpoint trust. [Rate limits](/projects/sdk/src/internal/rate-limits.ts) use [resource-partition metadata](/projects/sdk/src/internal/rate-limit-templates.ts), not fixed provider limits |
| Sharding and processes | [Shard planning](/projects/sdk/src/internal/sharding.ts) assigns guilds to shards. [Supervisor](/projects/sdk/src/internal/supervisor.ts) manages its child processes and coordinates Identify requests across them |
| Resource operations | Resource-named modules in [internal/](/projects/sdk/src/internal/) validate requests and project REST/gateway data. Shared REST owns scheduling. [Application](/projects/sdk/src/internal/application.ts) is bot-token read-only, while [OAuth](/projects/sdk/src/internal/oauth.ts) owns explicit token operations with application-owned consent, storage and refresh coordination |
| Validation and failures | [API errors](/projects/sdk/src/api-errors.ts), [input validation](/projects/sdk/src/input-validation.ts), [field text](/projects/sdk/src/internal/field-text.ts) and [Effect failures](/projects/sdk/src/internal/effect-failures.ts) own rejection classification, safe metadata, request-only text normalization and cause preservation |
| Events and gateway requests | [Events](/projects/sdk/src/internal/events.ts), [presence](/projects/sdk/src/internal/presence.ts), [counts](/projects/sdk/src/internal/counts.ts) and [member chunks](/projects/sdk/src/internal/member-chunks.ts) own bounded delivery and cleanup. [Gateway requests](/projects/sdk/src/internal/gateway-requests.ts) shares local admission between count and member requests, without retaining rosters or counts |
| Retention and traversal | [Cache](/projects/sdk/src/internal/cache.ts) and resource-specific cache modules control what is kept, resolve conflicting updates and invalidate stale values. [Pagination](/projects/sdk/src/internal/pagination.ts), [collectors](/projects/sdk/src/internal/collector.ts) and [reaction collectors](/projects/sdk/src/internal/reaction-collector.ts) limit retained data and clean up after use |
| Resource workflows | [Member search](/projects/sdk/src/internal/member-search-workflow.ts), [message search](/projects/sdk/src/internal/message-search-workflow.ts) and [message cleanup](/projects/sdk/src/internal/message-cleanup.ts) combine operations with bounded work. [Permissions](/projects/sdk/src/internal/permissions.ts) and [role hierarchy](/projects/sdk/src/internal/role-hierarchy-workflow.ts) provide checks, not action authorization |
| Files and transfers | [Multipart](/projects/sdk/src/internal/multipart.ts), [transfer sources](/projects/sdk/src/internal/transfer-source.ts), [uploads](/projects/sdk/src/internal/uploads.ts), [attachment refresh](/projects/sdk/src/internal/attachment-refresh.ts) and [response JSON](/projects/sdk/src/internal/response-json.ts) own framing, byte validation, plans and bounded reads. REST owns scheduling, credentials and transfer execution |
| Optional local tools | [Helpers](/projects/sdk/src/helpers.ts), [colors](/projects/sdk/src/colors.ts), [text](/projects/sdk/src/text.ts) and [builders](/projects/sdk/src/builders.ts) produce local values. [Commands](/projects/sdk/src/internal/commands.ts), [arguments](/projects/sdk/src/command-arguments.ts) and [help](/projects/sdk/src/internal/command-help.ts) use existing subscriptions, without owning delivery |
| Diagnostics and timers | [Logging](/projects/sdk/src/internal/logging.ts) provides safe diagnostics and opt-in measurements. [Logical scheduling](/projects/sdk/src/internal/logical-scheduler.ts) manages timers tied to SDK work, separate from host watchdogs and protocol wall time |

Keep public API signatures and caller documentation in source, and user guides/reference in the website.
Use [SDK tests](/projects/sdk/tests/) for behavior checks and [packed consumers](/projects/sdk/tests/consumers/) for package-boundary checks.
The standalone [bot examples](/projects/sdk/examples/starter/) ship with the package and supply the website's runnable first-bot examples. They use the public SDK runner without companion files.
The build emits ignored files under `projects/sdk/dist/`, which must not be edited by hand

For shared error changes, start at [REST translation](/projects/sdk/src/internal/rest.ts) and [cause preservation](/projects/sdk/src/internal/effect-failures.ts).
Operation error constructors live with their public resource types, not only in errors.ts. Message failures have their own [module](/projects/sdk/src/message-errors.ts).
Use [local validation checks](/projects/sdk/tests/input-validation.test.ts), [provider rejection checks](/projects/sdk/tests/webhooks.test.ts) and [combined cleanup failures](/projects/sdk/tests/cleanup-failures.test.ts) for their distinct boundaries.
For client lifetime changes, [network checks](/projects/sdk/tests/network.test.ts) cover startup and closure, [recovery checks](/projects/sdk/tests/recovery.test.ts) cover retry/resume, and [supervisor child failures](/projects/sdk/tests/supervisor-child-failures.test.ts) cover process ownership

The [SDK import rule](/projects/sdk/AGENTS.md) uses package-private `#sdk/*` aliases across source areas, with short sibling imports kept relative.
The SDK manifest maps these aliases to compiled output by default. TypeScript's NodeNext build resolves that output mapping back to source.
The [test compiler configuration](/projects/sdk/tsconfig.test.json) and [Vitest configuration](/projects/sdk/vitest.config.ts) enable the `fluxerly-source` condition to select source directly.
Built-process and packed-consumer checks use default resolution, without that condition.
Source-module identity tests guard against accidentally testing stale output. Packed checks verify the shipped mapping, runtime target and public declaration preservation

See [technology choices](/docs/TECHNOLOGY.md) for tooling and support policy, and [SDK contracts](/docs/SDK-CONTRACTS.md) for cross-cutting implementation constraints

## Shared files

The development workspace root is [projects/](/projects/), separate from the repository root.
Run shared pnpm commands from that directory

| File | Purpose |
| --- | --- |
| [AGENTS.md](/AGENTS.md) | Repository-specific instructions for coding agents |
| [projects/package.json](/projects/package.json) | Private workspace root and accepted pnpm major |
| [projects/pnpm-workspace.yaml](/projects/pnpm-workspace.yaml) | Includes the SDK, release tooling and website in one workspace |
| [projects/pnpm-lock.yaml](/projects/pnpm-lock.yaml) | Shared, generated dependency lockfile for the workspace |
| [projects/.node-version](/projects/.node-version) | Single development Node version source, populated from `fnm current` |
| [.editorconfig](/.editorconfig) | Shared editor formatting defaults |
| [.gitattributes](/.gitattributes) | Shared Git text and line-ending rules |
| [LICENSE](/LICENSE) | Apache-2.0 license for the SDK, website code, and authored documentation |

The development Node pin is separate from the SDK's consumer compatibility policy.
The consumer minimum is Node.js 24.11.0, the first LTS release of the Node 24 line.
The SDK manifest declares that floor independently of the development pin.
The current development pin is Node.js 24.21.0

The workspace manifest selects pnpm 12 through `devEngines.packageManager`, with the exact resolved version recorded in the shared lockfile.
See [technology choices](/docs/TECHNOLOGY.md#shared-development-tooling) for the update procedure

## Placement and scope

- Keep project-specific dependencies and tooling in the project that uses them
- Keep shared development tooling in projects/, not at the repository root
- Reserve the repository root for repository-wide documents and settings
- Place ignore rules where needed, preferring project scope without adding an ignore file to every internal module
- Add source, test, and output directories when their contents or tooling require them
- Update this guide when project responsibilities or navigation change

The workspace root and website are private packages.
The SDK manifest also remains private, with publication designed to use a separately staged candidate.
This temporary safeguard does not change the intended public package identity

## Development checks

Run these commands from [projects/](/projects/) using the development Node version

| Command | Purpose |
| --- | --- |
| `pnpm install --frozen-lockfile` | Install the recorded dependency graph |
| `pnpm build` | Compile the SDK with TypeScript 7 and build its documentation website |
| `pnpm --filter @neontechspace/fluxerly format` | Format SDK source, tests and configuration with Prettier |
| `pnpm --filter @neontechspace/fluxerly format:check` | Check SDK formatting without writing files |
| `pnpm check` | Check SDK formatting, build, public-client surface, types, runtime and packed consumers, then release tooling tests and website build, types and tests |
| `pnpm --filter @neontechspace/fluxerly test:public-contract` | Check paired client namespace names, runtime keys, structural parameter/result parity and JSDoc presence |
| `pnpm --filter @neontechspace/fluxerly test:npm` | Check npm installation of the packed SDK and required Effect peer |
| `pnpm docs:dev` | Build the SDK, generate its public reference and start local Astro development |
| `pnpm --filter fluxerly-docs test:browser` | Check the rendered development documentation in Chromium |
| `pnpm --filter fluxerly-docs test:versions` | Check exact-version documentation using isolated release fixtures |
| `pnpm --filter @neontechspace/fluxerly test:upstream:guild-features` | Opt-in current Fluxer toggle-set and cloning-guard source comparison, requiring authenticated `gh`. No provider requests or mutations |
| `pnpm --filter @neontechspace/fluxerly test:experiment:effect-transport` | Run the rejected Effect unstable HTTP/socket transport characterization outside the default SDK check |

The SDK's [Prettier configuration](/projects/sdk/.prettierrc.json) sets a 120-column target and omits optional semicolons.
Prettier reads 4-space indentation and LF endings from the shared [EditorConfig](/.editorconfig).
Formatting runs only within the SDK and respects its [.gitignore](/projects/sdk/.gitignore), excluding build output and local sandbox files.
The website and repository documents are outside these formatting commands

Local networking checks use owned loopback fixtures, not Fluxer credentials or live sessions

Run the packed-consumer check with Node.js 24.11.0 as well as the development runtime when changing runtime compatibility.
Use `pnpm --filter @neontechspace/fluxerly test:package` after building with the development runtime.
The check reports its actual Node version and uses that executable for its isolated consumers.
The npm consumer check runs the exact SDK development-only npm CLI pin on that same Node executable.
It does not depend on npm being bundled with the Node installation or install npm for SDK users

The Effect unstable HTTP/socket transport characterization remains opt-in because it demonstrates an adapter cleanup limitation, not a production transport choice.
The default SDK checks retain selected `ws` transport coverage and built SDK natural-exit checks

The public-client contract covers its inventoried default/native client namespace interfaces, direct runtime keys and structural parameter/result parity, with explicit exceptions for API-specific lifetime and effect contracts.
Mutation fixtures verify that dropped options and projected fields fail the comparison.
It does not establish behavioral parity, assess comment accuracy, or cover every standalone client or type-only export

The [conformance registry](/projects/sdk/tests/conformance-registry.ts) and [standalone/lifecycle inventory](/projects/sdk/tests/standalone-conformance-registry.ts) record provider contracts, local exclusions and existing test owners.
The [inventory gate](/projects/sdk/tests/conformance-registry.test.ts) checks both public entry points, including standalone OAuth/Webhook clients and Client top-level members, and rejects missing or unregistered members.
The [runtime export inventory](/projects/sdk/tests/module-conformance-registry.js) also checks exact value exports and intentional entrypoint differences.
The [field coverage gate](/projects/sdk/tests/conformance-fields-coverage.test.ts) matches source-derived request, response and event fields to authored rules or explicit local exclusions.
The [semantic baseline](/projects/sdk/tests/conformance-fields-shapes.snapshot.txt) records operation signatures, union variants, field types, optionality and nullability.
After reviewing an intentional public shape change, update it from the SDK directory with `pnpm exec vitest run -u tests/conformance-fields-inventory.test.ts`, and review the generated diff with the affected field rules and behavioral tests.
Shared reference cases run against source and packed exports for selected member-role, OAuth, webhook and local shutdown behavior, plus [gateway lifecycle replay](/projects/sdk/tests/gateway-conformance-fixture.js).
This is bounded behavioral evidence, not exhaustive provider-schema parity or live OAuth consent qualification

The upstream guild-feature check pins one current Fluxer commit per run and fails on changed values or unrecognized source structure.
It detects source changes but does not verify hosted behavior. The live feature-toggle check verifies changes and restoration against the hosted service

Run `pnpm --filter @neontechspace/fluxerly test:cache:memory` for isolated GC-enabled retention checks.
Run `pnpm --filter @neontechspace/fluxerly test:cache:workload` for local cache workloads.
Both build first and use controlled responses, not Fluxer credentials or production workloads

Run `pnpm --filter @neontechspace/fluxerly test:rest:queue` to compare JSON queue-byte budgets through both built APIs.
The benchmark uses isolated processes and controlled HTTP responses. It changes only the loaded queue constant without editing source or build output.
It reports rejection, timeout, latency and process-memory observations. It does not measure hosted service limits or select a default automatically

After building the SDK, run `pnpm --filter @neontechspace/fluxerly exec node tests/performance-logging.js` for logging-overhead measurements
or `pnpm --filter @neontechspace/fluxerly exec node tests/performance-local.js` for cold import/client lifecycle, cache-workload and retention measurements.
Both are opt-in, use controlled responses without credentials and emit JSON Lines with input hashes, environment, raw samples and descriptive summaries.
Run them serially without concurrent builds or test workers. The optional `--smoke` flag checks harness correctness with reduced work, not performance.
These measurements are local evidence, not hosted throughput claims or mandatory CI speed thresholds

### Package preparation

Package and npm checks reuse pnpm's cache but may fetch missing public registry metadata or dependencies for their isolated consumers.
A frozen workspace install does not guarantee the metadata needed to resolve a standalone consumer is cached.
Dependency installation scripts are disabled for isolated SDK consumers, and the checks remove their own temporary packages after success or failure

[Package preparation](/projects/sdk/scripts/packages.js) copies compiled JavaScript, declarations, maps, sources, license and consumer guidance into a new directory.
It creates a public npm package directory and verifies the matching `sdk.tgz` inventory.
The canonical SDK manifest remains `private`, while the staged npm manifest receives the reviewed release version.
Read the [registry publication contract](/docs/RELEASING.md#registry-publication-contract) before any release operation.
Do not run publication directly from the SDK checkout

### Opt-in live sandbox check

Run live checks only against the authorized test bot and server, from [projects/](/projects/).
The SDK-local, Git-ignored `.env.test.local` must provide `FLUXER_TEST_GUILD_ID`, `FLUXER_TEST_APPLICATION_ID` and `FLUXER_TEST_BOT_TOKEN`.
The checks verify bot/application/server identity.
OAuth checks also use the application client secret.
Never print credentials or private payloads when diagnosing a failure

Run a table entry as `pnpm --filter @neontechspace/fluxerly <script>`.
These checks are opt-in and excluded from `pnpm check`

#### Shared safety and recovery

The shared `.env.test.local.lock` excludes concurrent harness runs, not sessions started by other tools.
After a crash, verify that the recorded process has stopped before removing its stale lock. Never bypass a live owner's lock or stop unrelated processes

For journaled mutations, record test-owned markers before dispatch and returned IDs when available, then verify restoration or removal before deleting the journal.
Journal writes and remote operations are not atomic. Reconcile lost responses through recorded identity rather than blindly retrying writes.
Corrupt, conflicting or unresolved state fails closed. Retain and inspect the journal instead of deleting it to make a check pass.
Recovery-only invocations require a separate fresh invocation after verified cleanup. Per-harness target, restoration and consent requirements follow below

#### Interactive and additional commands

After building, run `node sdk/tests/live/bot-runner.js default` and then `node sdk/tests/live/bot-runner.js effect` from `projects/` to verify the public runner against the sandbox.
These read-only checks interrupt only their own gateway connection, cancel during recovery and close a test-owned subscription. They verify client, socket and signal-listener cleanup without creating remote resources

`test:live:presence` requires process-only `FLUXER_TEST_PRESENCE_USER_ID`, an authorized non-bot sandbox guild member.
It is an interactive check: After a selected guild presence baseline, it reports bounded stages for that participant's visible DND and online transitions, including one test-owned socket interruption and resumed-session observation.
The harness does not change account state. The authorized participant makes the visible status changes, and the harness sends an unacknowledged empty selection during cleanup.
For the final invocation, process-only `FLUXER_TEST_PRESENCE_RESTORE_STATUS` can request a verified return to the participant's original observed `online`, `idle`, `dnd` or `offline` status (`offline` means selecting Invisible while connected)

`test:live:typing:interactive` requires process-only `FLUXER_TEST_TYPING_USER_ID` for an authorized non-bot sandbox member.
Open the reported temporary channel, observe the bot indicator and type without sending a message.
Enter `visible default` or `visible effect` in the running terminal only after observing that mode's indicator, or `stop` to end the check.
An authorized browser operator can enter `browser default` or `browser effect` after checking the rendered indicator, recording browser observation separately from human confirmation.
Each mode waits up to three minutes for both that confirmation and the selected member's SDK typing event.
Cleanup deletes only the journaled test channel, retaining `.env.test.typing.local` if its removal cannot be verified

`test:live:roles:reset` requires process-only `FLUXER_TEST_ROLE_RESET_GUILD_ID` matching the authorized sandbox and permission to reset guild-wide role display positions.
It refuses existing non-null display assignments, then uses two journaled zero-permission roles for successful and lost-response resets through both APIs.
No member assignments are changed.
Cleanup verifies test-role deletion and retains `.env.test.role-reset.local` on unresolved cleanup

After building the SDK, run `pnpm --filter @neontechspace/fluxerly exec node tests/live/text-validation.js default`
and then the same command with `effect` for the bounded text-validation check.
Each mode creates one journaled zero-permission role in the designated sandbox, checks local rejection and normalized
UTF-16 boundary writes, and reconciles an intentionally lost edit response without replaying the write.
No human membership or existing role is changed. Cleanup verifies test-role absence, retaining
`.env.test.text-validation.local` if ownership or cleanup cannot be established

After building the SDK, run `pnpm --filter @neontechspace/fluxerly exec node tests/live/recovery-window.js default`
and then the same command with `effect` for a bounded gateway recovery window.
Each mode observes at least 165 seconds and interrupts only its own authenticated sockets, including one locally delayed Hello frame.
The check uses the shared live-test lock and makes no server mutations. Cleanup closes the client and its sockets before releasing the lock

`test:live:expressions` checks emoji/sticker lifecycle, gateway updates, partial batches and sticker messages through both built APIs.
It creates temporary expressions and a channel, deletes test-owned resources without media purging, and preserves a recovery journal on unresolved outcomes

| Script | Purpose | Outside effects |
| --- | --- | --- |
| `test:live` | Hosted protocol discovery, readiness and heartbeats | No server-content changes |
| `test:live:sdk` | Built default/native client connection and shutdown | No server-content changes |
| `test:live:application` | Current-bot application and installation links | Read-only. No navigation, authorization, or server-content changes |
| `test:live:oauth:default`, `test:live:oauth:effect` | Manual authorization-code exchange, bearer reads, introspection, refresh and revocation | Interactive identity, guild-list and connections consent, temporary tokens and an owned localhost callback listener. No bot installation or permission changes |
| `test:live:oauth:no-consent` | OAuth URL construction and rejection without consent | Shared sandbox lock and read-only application, bot, guild, OAuth and connection checks. No browser navigation, consent, callback listener, token issuance, refresh or revocation |
| `test:live:instance` | Instance discovery and bot-self read | Read-only unauthenticated bootstrap and bot-self REST requests. No server-content changes |
| `test:live:diagnostics` | Diagnostics and cache clearing | Read-only with the shared sandbox lock, no gateway connection or remote mutation |
| `test:live:rate-limits` | Global and learned-bucket waiting and recovery | Verifies sandbox identity and uses the shared lock. One synthetic 429 and three scheduling-header overrides per API, with read-only bot-self and guild requests. No deliberate hosted throttling or remote mutation |
| `test:live:consumer-operations` | Banner URLs, attachment deletion, bot roles and counts | Temporary channel/messages and one zero-permission role assigned only to the test bot, plus test-owned response loss and socket interruption |
| `test:live:member-chunks` | Member selection and streamed failure/recovery | Read-only guild/member requests, test-owned reply drops and one socket interruption per mode, no server-content changes |
| `test:live:sharding` | Two-shard routing, recovery and cancellation | Read-only sandbox requests, one test-owned shard-socket interruption and one cancelled startup per mode, no content or account-presence changes |
| `test:live:supervisor` | Child assignments, connections and shutdown | Read-only sandbox API and gateway requests plus an owned loopback proof endpoint. No content or account-state changes |
| `test:live:presence` | Interactive presence and reconnect restoration | No account-state changes by the harness. The authorized participant performs visible status transitions and the harness interrupts only its own socket |
| `test:live:messages` | SDK receive/reply with independent readback | Temporary channel and messages |
| `test:live:nonce` | Nonce defaults, suppression and reconciliation | Journaled temporary channel/messages and one test-owned response loss per API. Cleanup verifies channel deletion |
| `test:live:optional-tools` | Builders and prefix-command lifecycle | Temporary channel and test-bot command/reply messages. No human or member actions |
| `test:live:event-waits` | Filtered event waits and failure cleanup | One journaled temporary channel and bot messages, with raw readback and verified channel removal |
| `test:live:command-arguments` | Typed commands and invalid-input recovery | One journaled temporary channel and bot messages, with raw reply readback and verified channel removal |
| `test:live:command-help` | Help pagination and delivery | One journaled temporary channel and bot messages, with raw page readback and verified channel removal |
| `test:live:command-groups` | Nested commands and scoped help | One journaled temporary channel and bot messages/replies, with raw readback and verified channel removal |
| `test:live:message-fields` | Message projections | One journaled temporary channel, bot messages and a small attachment, with reply/edit/pin operations, raw readback and verified channel removal |
| `test:live:consumer-features` | Forwarding, embeds, file metadata, flags and profiles | Journaled temporary channel/messages and uploads, test-owned response loss. Profile GET may trigger provider expired-premium cleanup |
| `test:live:typing` | One-shot typing, scoped refresh and completion/cancellation cleanup through both APIs | Temporary channel/messages and ephemeral typing notices. Does not prove inbound typing delivery |
| `test:live:typing:interactive` | Human-visible outgoing typing and selected-member inbound events through both APIs | Temporary channel and typing notices, with awaited refresh shutdown and verified channel removal |
| `test:live:roles:reset` | Guild-wide role-display reset and lost-response reconciliation through both APIs | Two temporary zero-permission roles and whole-guild display reset, with existing display assignments required to be null |
| `test:live:recovery` | Forced socket loss, resume, diagnostics and subsequent receive/reply | Temporary channel/messages and test-socket termination |
| `test:live:recovery:cancel` | Managed cancellation during recovery and socket cleanup | Test-socket termination, no server-content changes |
| `test:live:management` | Remote fetch, edit and deletion | Temporary channel/messages and test-message edits/deletions |
| `test:live:batch-delete` | Explicit message batches, events/cache, missing IDs and lost-response reconciliation | Temporary channel/messages and test-owned response loss |
| `test:live:moderation:default`, `test:live:moderation:effect` | Timeout/clear, kick, ban expiry/unban, events and lost-response reconciliation | Authorized disposable member moderation, temporary channel/messages, test-owned response loss |
| `test:live:webhooks` | Webhook management, delivery and credential revocation | Temporary webhooks, channels/messages, file uploads and test-owned response loss |
| `test:live:expressions` | Emoji/sticker lifecycle and messages | Journaled temporary expressions and a channel, with verified test-owned removal and no media purging |
| `test:live:invites` | Invite lifecycle and recovery | Temporary channel and invites. No invite acceptance or membership changes |
| `test:live:administration` | Server settings and filtered audit logs | Temporary sandbox server renaming, restoration, audit records and test-owned response loss |
| `test:live:guild-features` | Clone opt-ins and feature restoration | Temporary sandbox cloning permissions and owner-crown visibility, audit records and verified restoration |
| `test:live:vanity` | Custom-invite reads, read recovery and disabled-feature rejection through both APIs | No intended successful mutation, uses a reserved code for rejection checks |
| `test:live:vanity:mutate:default`, `test:live:vanity:mutate:effect` | Manual custom-invite lifecycle and lost-response reconciliation | Opt-in temporary custom codes on an eligible sandbox with no existing code |
| `test:live:discovery` | Directory search, categories, eligibility/status and read recovery through both APIs | Read-only, never submits an application |
| `test:live:member-search` | Indexed member search and permissions | Resource reads and search requests, which can trigger provider lazy indexing. No member moderation or role/channel edits |
| `test:live:members` | Authorized target-member nickname set, independent readback and restoration through both APIs | Temporary nickname change for one currently authorized non-owner member |
| `test:live:guild-lifecycle` | Bot membership pages and bounded traversal through both APIs | Read-only unless the harness is invoked separately with `--leave` |
| `test:live:discovery:mutate:default`, `test:live:discovery:mutate:effect` | Manual directory application lifecycle and lost-response reconciliation | Real review-queue submission or immediate public listing, then test-owned withdrawal |
| `test:live:users:default`, `test:live:users:effect` | Public user reads, private conversations, bot server-profile edits and message failure reconciliation | Test DMs, authorized group messages/renaming, bot profile changes and test-owned response loss |
| `test:live:events` | Gateway delivery after raw API mutations | Temporary channel/messages and test-message edits/deletions |
| `test:live:reactions` | Reactions, collectors and recovery | Temporary channel/messages, reactions and guild emoji, plus test-socket termination |
| `test:live:pins` | Pin/unpin, explicit pages, pin status/events and recovery | Temporary channel/messages and pins, server-created pin notices, plus test-socket termination |
| `test:live:guilds` | Guild/member reads, role lifecycle, caches and recovery | Temporary channel/messages, two zero-permission test roles with assignment only to the designated bot, plus test-socket termination and test-owned response loss |
| `test:live:guild-events` | Bot-session guild create delivery after READY | Read-only gateway connection to the existing sandbox guild. Fails when it is unavailable or the bounded event wait expires |
| `test:live:voice` | Initial voice snapshots and member mute/deaf flags through both built APIs | Read-only sandbox gateway/member observations. No participant moderation, joining or media |
| `test:live:voice-controls:default`, `test:live:voice-controls:effect` | Manual selected-participant move/disconnect and mute/deafen controls, with snapshots, events and REST readback | Temporary voice channel and participant state changes, followed by participant rejoin, baseline restoration and verified channel removal |
| `test:live:channels` | Channel lifecycle, overwrites, audit logs and recovery | Temporary channels/categories, overwrites targeting only the bot and test guild's everyone role, test-socket termination and test-owned response loss |
| `test:live:history` | Explicit history pages checked against API readback | Temporary channel and messages |
| `test:live:cleanup` | Guild summaries, hierarchy and bounded message cleanup | Temporary channel and test-bot messages, with one lost batch response. Uses the existing channel recovery journal and verifies test-owned cleanup |
| `test:live:own-history` | Channel-wide own-history deletion, lost-response and cancellation reconciliation through both APIs | Two journaled temporary channels and bot messages, with verified channel removal. Guild-wide deletion requires a separate authorized invocation |
| `test:live:search` | Bounded contextual indexed-message search, explicit indexing and cache exclusion | Temporary channel/messages. May report a hosted indexing timeout |
| `test:live:pagination` | History/member/reactor/pin traversal and cleanup | Temporary channel/messages, reactions and pins, plus test-owned transient read failure and delayed response delivery |
| `test:live:cache` | Cache intake, expiry and recovery invalidation | Temporary channel/messages and test-socket termination |
| `test:live:collectors` | Collector completion, gap failure and use after recovery | Temporary channel/messages and test-socket termination |
| `test:live:embeds` | Embed send/reply/edit, readback, events, cache and collectors | Temporary channel/messages and test-message edits |
| `test:live:attachments` | Uploads, binary readback, file edits, events/cache/collectors and recovery | Temporary channel/messages, 50 MiB file upload/download, file replacements and test-socket termination |
| `test:live:attachment-sources` | File/stream uploads, URL refresh and bounded download recovery | Temporary channel/messages, one test-owned temporary file and delayed-EOF wrapper. The injected 403 targets only the current channel's unique attachment plan and does not change provider configuration |

#### OAuth consent

OAuth checks require `FLUXER_TEST_CLIENT_SECRET` and `FLUXER_TEST_OAUTH_REDIRECT_URI=http://localhost:3000/auth/fluxer/callback` in the ignored SDK env file.
Register that exact redirect on the sandbox bot's application and leave localhost port 3000 free

Run one OAuth mode at a time, with fresh consent and the account owner's current permission for identity, guild-list and connections reads.
The URL requests only `identify guilds connections`. Do not include `bot`, because Fluxer rejects adding the existing sandbox bot again.
Keep the bot's membership and permissions unchanged. Installation URL construction is covered separately by the no-consent check

Open the printed authorization URL and approve within five minutes, without sharing the callback URL or code.
The harness retains issued tokens only in memory and revokes known tokens before closing its callback listener and SDK lifetime

If the process crashes or reports uncertain issuance or unconfirmed revocation, the consenting user must revoke this sandbox application's authorization in Fluxer settings.
Open personal settings, then Account → Security → Account access → Authorized apps → Manage, and revoke only the sandbox app.
Tokens cannot be recovered from a journal, and successful token revocation does not remove the provider's saved consent record

These checks are excluded from `pnpm check`, CI, schedules and unattended runs

#### Whole-history deletion

Whole-own-history guild checks require current authorization to erase all messages authored by the designated bot in the sandbox server.
This deletion is irreversible and cannot be limited to messages created by the test

After building, run `node tests/live/own-history.js default --guild` and then the `effect` mode from the SDK directory.
Supply process-only `FLUXER_TEST_DELETE_MINE_GUILD_ID` matching the configured sandbox, never another server

The harness verifies bot/application/server identity and membership, uses the shared lock and journals test-owned channels in `.env.test.own-history.local`.
An existing journal triggers recovery only, without repeating whole-history deletion

After a crash, reconcile that journal and the shared lock before a separately authorized fresh run.
Cleanup removes only the journaled channels and cannot restore deleted history.
Other-author readback covers only a reported sample, not a complete inventory

#### Voice controls

Voice-control checks require process-only `FLUXER_TEST_VOICE_USER_ID` for a currently consenting sandbox member connected to one voice session.
The bot needs ManageChannels, Connect, MoveMembers, MuteMembers and DeafenMembers, plus a successful hierarchy check for that participant

Run each mode separately. Keep the participant available to rejoin the original channel within 90 seconds after disconnection.
The harness cannot make a disconnected participant join and never joins the bot or handles media

It journals the baseline, test-channel marker and pending operation in `.env.test.voice-controls.local` before mutations.
Recovery uses fresh gateway and REST observations, refuses unexpected state and retains the journal if restoration or resource removal is uncertain.
When a journal exists, the next invocation performs recovery only. Start a fresh test in a separate invocation after verified cleanup

Use `node tests/live/voice-controls.js default --flags-only` (or `effect`) from the SDK directory to isolate mute/deafen checks without moving or disconnecting the participant.
Use `--no-move` instead to include disconnect and participant rejoin without creating a channel or testing move handoff.
Run `node tests/live/voice-controls.js --self-test` from the SDK directory for the local journal-state check. This is not live recovery proof

#### Scoped checks and restoration

The command-convenience harness records its channel in `.env.test.command-conveniences.local`. An existing journal triggers cleanup-only recovery

For the scoped latest-private-message batch check, run `node tests/live/users.js default --latest-only` and then the `effect` mode from the built SDK directory.
Set process-only `FLUXER_TEST_DM_USER_ID` to a currently authorized sandbox member.
This mode verifies membership, creates marker-owned test DMs, checks batch failure/recovery and deletes the test messages, without profile, presence or group changes.
It restores whether the bot had the conversation open and retains the users recovery journal if cleanup cannot be verified

For read-only local-validation and user/private-channel cache checks, run `node tests/live/sdk.js default --quality` and then the `effect` mode from the built SDK directory.
Supply currently authorized targets through process-only `FLUXER_TEST_DM_USER_ID` and `FLUXER_TEST_GROUP_DM_ID`. The selected group must be owned by that member.
This mode uses the shared lock, verifies identity, rejects invalid inputs without dispatch and then reads the authorized account and existing group without sending messages or changing remote state

Sharding checks create no remote resources or recovery journal.
The harness explicitly skips owning-shard count replies while the provider fix remains undeployed. A passing run does not establish that path.
Recheck deployment before enabling that stage. Local transport tests cover the GitHub reply contract in the meantime

Member-chunk checks require a sandbox with fewer than 1,000 members and compare the response with one fresh REST member page.
The harness can wait once for a confirmed full-list rate limit left by a prior mode, then make a new request.
It reports whether the hosted gateway actually rejects an immediate repeat. Acceptance does not verify live rate-limit handling.
It creates no resources or recovery journal and does not change account presence.
Multi-batch arrival, missing-batch and slow-reader behavior use local transport tests rather than claiming a large live-guild run

Consumer-operation checks preserve the designated bot's original roles in `.env.test.consumer-operations.local`, alongside test-role and channel markers.
Recovery restores only the recorded baseline plus the unchanged zero-permission test role, verifies restoration and resource removal, then deletes the journal.
An unexpected role assignment or altered test resource retains the journal for reconciliation.
Fresh reads detect existing conflicts, but Fluxer's role PATCH has no conditional precondition and cannot make the read-and-write sequence atomic

Consumer-feature checks record their channel marker in `.env.test.consumer-features.local`.
Profile reads target only the designated bot, with and without the designated guild context. No human profile changes or private conversations are part of this check

Invite checks record only test-channel identity in `.env.test.invites.local`, never invite codes.
Cleanup reconciles the owned channel, verifies invite destination and creator before revocation, then removes the channel

Administration checks record sandbox identity, a unique marker and the original server name in `.env.test.administration.local`.
Restoration refuses to overwrite an unexpected concurrent name change and retains its journal on conflict

Guild-feature checks preserve the original feature set in `.env.test.guild-features.local`.
They modify only the clone opt-ins and owner-crown visibility, refuse unexpected feature changes and verify full feature restoration.
The provider has no conditional PATCH, so conflict checks are not atomic. The journal remains if restoration is uncertain.
Disabling cloning again cannot revoke copies another caller made during the temporary opt-in

Audit queries always include a user or action filter. No unfiltered read is used because Fluxer may rewrite deletion records during that request

#### Custom invites and public discovery

Custom-invite mutation checks are manual, excluded from `pnpm check`, CI and unattended runs

Use a specifically authorized disposable server with `VANITY_URL`, ManageGuild permission and no existing custom code.
Supply two distinct, available lowercase codes through `FLUXER_TEST_VANITY_CODE` and `FLUXER_TEST_VANITY_SECOND_CODE`, plus `FLUXER_TEST_VANITY_MUTATIONS=1`.
Process environment takes precedence over ignored `.env.test.local`. Stored values are not authorization.
Run each mutation mode separately. Successful invite inspection also needs a channel visible to everyone

The ignored `.env.test.vanity.local` journal stores sandbox identity and code hashes, never the codes themselves.
Recovery removes only a matching test-owned code and refuses concurrent replacements.
An uncertain provider-side partial write retains the journal for operator reconciliation, even if the guild's custom-code slot is empty

Changing an existing code cannot guarantee reclaiming it, so the harness refuses that scenario.
Read/rejection checks do not establish successful setting, replacement, removal or lost-response recovery.
Include executed scenarios and untested mutation paths in the test report

Discovery mutation checks require specific permission for real directory submission and possible immediate public listing.
Use an eligible disposable sandbox with no existing application or listing, and set `FLUXER_TEST_DISCOVERY_MUTATIONS=1` for that manual invocation.
Optionally select `FLUXER_TEST_DISCOVERY_CATEGORY_ID`. The default is the provider's Other category.
Run the default and Effect mutation scripts separately, never in CI or unattended runs.
The ignored `.env.test.discovery.local` journal retains only target identity, synthetic test marker and application timestamp.
Cleanup refuses unrelated descriptions or replacement applications and verifies the test record and discoverable guild feature are removed.
Partial provider writes can require operator reconciliation. Search-index removal and reviewer notifications are not reversible guarantees.
Read-only script success is not live application-lifecycle proof

#### Webhooks and private conversations

Webhook checks record test-owned resource IDs and unique names in `.env.test.webhooks.local`, never webhook tokens.
Recovery verifies the webhook creator and destination against the designated bot and owned channels before deletion.
The shared lock recovery rules apply after a crash

User/private-conversation checks are manual and require current authorization for the recipient supplied through `FLUXER_TEST_DM_USER_ID`.
The process environment takes precedence over ignored `.env.test.local`. A stored ID is not authorization

The checks verify the recipient's membership in the designated sandbox, preserve pre-existing open DMs and remove test-owned messages.
The ignored `.env.test.users.local` journal records test-owned markers/IDs and temporary bot-profile restoration data, never credentials

Existing-group checks additionally require current permission to rename and send messages in the channel supplied through `FLUXER_TEST_GROUP_DM_ID`.
Use a named temporary group owned by the authorized recipient, containing only that account and the sandbox bot

An explicitly authorized additional account can be supplied through `FLUXER_TEST_GROUP_EXTRA_USER_ID`.
The harness preserves membership, restores the original group name and deletes only test-owned messages

Without a selected group, or with `--without-group`, the script reports group checks as skipped. That run is not group verification

#### Member changes and leaving a guild

Member nickname checks are manual, excluded from `pnpm check`, CI, schedules and unattended runs.
Supply the currently authorized non-bot, non-owner target through `FLUXER_TEST_MEMBER_ID` in the process environment. The ignored env file is never read for this ID

The ignored `.env.test.members.local` journal contains only sandbox/bot/authorized-member identity, a test marker and that member's original nickname for restoration, never credentials.
It is written before the mutation. Recovery requires the same currently supplied member ID, restores only the exact test marker and refuses an unexpected observed concurrent nickname change

The harness rereads the nickname immediately before the write, but Fluxer's PATCH has no conditional precondition, so it cannot make the read-and-write sequence atomic.
It deliberately loses one response after the marker write, verifies the SDK reports an unknown outcome and evicts its member cache, then reconciles raw state before restoration

Member-moderation scripts are manual opt-in checks, never part of `pnpm check`, CI, schedules or unattended reruns

Guild leave checks are also manual: Coordinate with the person who can re-add the bot before each invocation.
After building, run `node tests/live/guild-lifecycle.js default --leave` or the `effect` mode from the SDK directory with the currently authorized `FLUXER_TEST_LEAVE_GUILD_ID` in the process environment.
The optional `--lose-response` flag discards a successful leave response to verify reconciliation without replay

The harness explicitly preserves authored messages and checks independent membership-list removal, but cannot re-add the bot or prove continued access to its former messages.
It creates no remote resources. If interrupted after dispatch, inspect bot membership and re-add it before further checks in that server

Each moderation invocation requires current authorization for its disposable account and a human available to handle rejoining

Supply the account ID through `FLUXER_TEST_MODERATION_USER_ID` in the process environment or ignored `.env.test.local`.
The process environment takes precedence, and a missing or invalid ID fails before live requests.
Never hardcode a real account ID or treat a saved ID as authorization to run a test

The account must be a current non-owner, non-administrator member without an existing timeout or ban

Run each moderation mode separately and re-add the account between runs.
The checks never delete its messages and leave it unbanned, but cannot restore its membership or previous roles

Recovery uses the journaled target and exact test-owned timeout/ban marker, refusing to remove unrelated moderation state

#### Resource cleanup

Message checks record the server ID, unique channel marker and returned channel ID in `.env.test.messages.local`, never credentials or message bodies.
A later run reconciles that channel and its messages before creating resources

Reaction checks also journal a unique emoji name, uploader and returned ID before using a test-owned guild emoji.
Cleanup verifies its identity and absence from the guild emoji list. This does not prove physical image-blob erasure

Guild checks also journal unique role names and returned IDs before assigning a zero-permission role to the test bot.
Cleanup reconciles only those markers/IDs, verifies remaining roles still have zero permissions and confirms absence after deletion.
The role check preserves existing bot roles and does not edit human memberships or existing roles

Channel checks journal each additional category and child marker before creation and reconcile returned IDs against those markers.
Cleanup removes test-owned children before categories and verifies absence before releasing the journal.
Permission checks target only the test bot and the guild's everyone role inside these test-owned channels

Use [live harness source](/projects/sdk/tests/live/) for assertions and bounded execution details.
A passing run establishes only its checked scenarios, not complete replay, prolonged-outage recovery or production readiness

## Release and documentation operations

Use [releasing](/docs/RELEASING.md) for registry verification, manual workflow inputs and external setup.
Use [documentation maintenance](/docs/DOCUMENTATION.md) for generated reference ownership, version archives and Preview delivery.
The workflows share [.github/actions/setup](/.github/actions/setup/action.yml), which reads `projects/.node-version` and uses the pinned upstream `pnpm/setup` action to install Node, pnpm and locked dependencies.
There is no separate `setup-node` step or second authored Node version
