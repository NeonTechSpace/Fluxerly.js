# Repository guide

Use this guide to locate implementation owners, configure the workspace and run contributor checks.
The SDK is in development and is not released for supported public use.
The documentation website remains a scaffold

## Project areas

| Location | Purpose |
| --- | --- |
| [SDK](/projects/sdk/) | The Fluxer-native JavaScript SDK, with the package identity in its [manifest](/projects/sdk/package.json) |
| [Website](/projects/web/) | The documentation website, with its own [manifest](/projects/web/package.json) |
| [Documentation](/docs/) | Repository Markdown documents, including the public [README](/docs/README.md) and this guide |

| Owner | Responsibility |
| --- | --- |
| [index.ts](/projects/sdk/src/index.ts) | Default public API and member documentation |
| [effect.ts](/projects/sdk/src/effect.ts) | Effect-native public API and member documentation |
| [client.ts](/projects/sdk/src/internal/client.ts) | Client lifetime, per-shard recovery supervision and shared Identify pacing |
| [sharding.ts](/projects/sdk/src/internal/sharding.ts) | Immutable local shard-plan validation and guild ownership calculation |
| [application.ts](/projects/sdk/src/internal/application.ts) | Current bot-token application allowlist projection, using shared REST without retention or application management |
| [discovery.ts](/projects/sdk/src/internal/discovery.ts) | Hosted service discovery |
| [effect-failures.ts](/projects/sdk/src/internal/effect-failures.ts) | REST/discovery cause-preserving error translation and deadlines, including cleanup defects during interruption |
| [gateway.ts](/projects/sdk/src/internal/gateway.ts) | Gateway transport and protocol |
| [events.ts](/projects/sdk/src/internal/events.ts) | Subscription scheduling and bounded event intake |
| [rest.ts](/projects/sdk/src/internal/rest.ts) | REST admission, deadlines and rate state |
| [message.ts](/projects/sdk/src/internal/message.ts) | Wire-message validation and projection |
| [reactions.ts](/projects/sdk/src/internal/reactions.ts) | Reaction emoji/query encoding and user-page/gateway projection; REST owns request scheduling |
| [pins.ts](/projects/sdk/src/internal/pins.ts) | Pin-page query validation and page/event projection, with REST owning mutation and request scheduling |
| [guilds.ts](/projects/sdk/src/internal/guilds.ts) | Guild/member/role request validation and response/event projection; shared REST owns admission and client-global rate state |
| [guild-lifecycle.ts](/projects/sdk/src/internal/guild-lifecycle.ts) | Bot membership pages and explicit leave requests; shared REST and cache owners handle admission and observation invalidation |
| [moderation.ts](/projects/sdk/src/internal/moderation.ts) | Timeout, kick and ban request validation and ban-list projection, using shared REST scheduling and resource invalidation |
| [webhooks.ts](/projects/sdk/src/internal/webhooks.ts) | Webhook request/projection validation and token-only client lifetime, with shared REST admission and no webhook cache |
| [users.ts](/projects/sdk/src/internal/users.ts) | Public account and private-conversation projection/request validation, with shared REST scheduling |
| [expressions.ts](/projects/sdk/src/internal/expressions.ts) | Emoji/sticker lifecycle validation and projection, using shared REST admission and guild-resource cache guards |
| [invites.ts](/projects/sdk/src/internal/invites.ts) | Invite inspection and management validation/projection, using shared REST without invite retention |
| [audit-logs.ts](/projects/sdk/src/internal/audit-logs.ts) | Filtered audit-page validation and projection; the pagination owner handles bounded traversal without audit retention |
| [guild-settings.ts](/projects/sdk/src/internal/guild-settings.ts) | Bot-permitted server-setting validation and patch encoding, using shared REST and resource-cache guards |
| [vanity-url.ts](/projects/sdk/src/internal/vanity-url.ts) | Custom-invite reads and explicit replacement, without retained codes or hidden use-count reads |
| [guild-discovery.ts](/projects/sdk/src/internal/guild-discovery.ts) | Public server-directory eligibility, categories and application lifecycle; distinct from hosted service discovery |
| [member-search.ts](/projects/sdk/src/internal/member-search.ts) | Indexed member-search validation and projection, separate from full member observations |
| [member-search-workflow.ts](/projects/sdk/src/internal/member-search-workflow.ts) | Invite-sensitive permission preflight and bounded offset search traversal |
| [message-search.ts](/projects/sdk/src/internal/message-search.ts) | Contextual indexed message-search validation and immutable page projection without cache admission |
| [message-search-workflow.ts](/projects/sdk/src/internal/message-search-workflow.ts) | Bounded opaque-cursor message-search traversal, including explicit indexing and progress failures |
| [permissions.ts](/projects/sdk/src/internal/permissions.ts) | Local permission-bit calculation and explicit fresh-resource composition, not action authorization |
| [user-cache.ts](/projects/sdk/src/internal/user-cache.ts) | Optional account/private-conversation retention, conflicting reads and lifecycle invalidation |
| [presence.ts](/projects/sdk/src/internal/presence.ts) | Bot presence intent, bounded member selections, reconnect restoration and incoming presence projection without a cache |
| [counts.ts](/projects/sdk/src/internal/counts.ts) | Fresh guild/channel count requests, shard scatter/gather, private nonce correlation and interruption/gap cleanup without count retention |
| [member-chunks.ts](/projects/sdk/src/internal/member-chunks.ts) | One on-demand member stream, chunk validation, bounded buffering, deadline and interruption/gap cleanup without roster retention |
| [gateway-requests.ts](/projects/sdk/src/internal/gateway-requests.ts) | Shared four-slot local admission for member and count requests, distinct from provider-side worker state |
| [multipart.ts](/projects/sdk/src/internal/multipart.ts) | Bounded webhook multipart body streaming over admitted file snapshots |
| [channels.ts](/projects/sdk/src/internal/channels.ts) | Guild channel request validation and REST/event projection, with scheduling owned by shared REST |
| [embeds.ts](/projects/sdk/src/internal/embeds.ts) | Rich-embed input validation and frozen received embed projection |
| [attachments.ts](/projects/sdk/src/internal/attachments.ts) | File validation and metadata projection |
| [uploads.ts](/projects/sdk/src/internal/uploads.ts) | Presigned plan validation, upload destination boundary and bounded file streams; REST owns scheduling and message completion |
| [cache.ts](/projects/sdk/src/internal/cache.ts) | Cache retention and conflicting observations |
| [guild-cache.ts](/projects/sdk/src/internal/guild-cache.ts) | Optional guild/member/role retention, related-resource invalidation and request conflicts |
| [channel-cache.ts](/projects/sdk/src/internal/channel-cache.ts) | Optional guild channel retention, mutation/event invalidation and request conflicts |
| [pagination.ts](/projects/sdk/src/internal/pagination.ts) | Demand-driven page traversal, cursor progress, limits and per-consumption cleanup |
| [cache-reports.ts](/projects/sdk/src/internal/cache-reports.ts) | Cache reporting lifetime |
| [collector.ts](/projects/sdk/src/internal/collector.ts) | Collector budgets, deadlines and cleanup |
| [reaction-collector.ts](/projects/sdk/src/internal/reaction-collector.ts) | Message-targeted reaction collection, batch intake, budgets and cleanup |
| [logging.ts](/projects/sdk/src/internal/logging.ts) | Per-client logging configuration, Effect adapter and safe lifecycle diagnostics |

Keep public API signatures and caller documentation in source, and user guides/reference in the website.
Use [SDK tests](/projects/sdk/tests/) for behavior checks and [packed consumers](/projects/sdk/tests/consumers/) for package-boundary checks.
The build emits ignored files under `projects/sdk/dist/`, which must not be edited by hand

The [SDK import rule](/projects/sdk/AGENTS.md) uses package-private `#sdk/*` aliases across source areas, with short sibling imports kept relative.
The SDK manifest maps these aliases to compiled output by default; TypeScript's NodeNext build resolves that output mapping back to source.
The [test compiler configuration](/projects/sdk/tsconfig.test.json) and [Vitest configuration](/projects/sdk/vitest.config.ts) enable the `fluxerly-source` condition to select source directly.
Built-process and packed-consumer checks use default resolution, without that condition.
Source-module identity tests guard against accidentally testing stale output; packed checks verify the shipped mapping, runtime target and public declaration preservation

See [technology choices](/docs/TECHNOLOGY.md) for tooling and support policy, and [SDK contracts](/docs/SDK-CONTRACTS.md) for cross-cutting implementation constraints

## Shared files

The development workspace root is [projects/](/projects/), separate from the repository root.
Run shared pnpm commands from that directory

| File | Purpose |
| --- | --- |
| [AGENTS.md](/AGENTS.md) | Repository-specific instructions for coding agents |
| [projects/package.json](/projects/package.json) | Private workspace root and accepted pnpm major |
| [projects/pnpm-workspace.yaml](/projects/pnpm-workspace.yaml) | Includes the SDK and website in one workspace |
| [projects/pnpm-lock.yaml](/projects/pnpm-lock.yaml) | Shared, generated dependency lockfile for the workspace |
| [projects/.node-version](/projects/.node-version) | Single development Node version source, populated from `fnm current` |
| [.editorconfig](/.editorconfig) | Shared editor formatting defaults |
| [.gitattributes](/.gitattributes) | Shared Git text and line-ending rules |
| [LICENSE](/LICENSE) | Apache-2.0 license for the SDK, website code, and authored documentation |

The development Node pin is separate from the SDK's consumer compatibility policy.
The consumer minimum is Node.js 24.11.0, the first LTS release of the Node 24 line.
The SDK manifest declares that floor independently of the development pin

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
The SDK manifest also remains private to prevent npm publication before release setup is ready.
This temporary safeguard does not change the intended public package identity

## Development checks

Run these commands from [projects/](/projects/) using the development Node version

| Command | Purpose |
| --- | --- |
| `pnpm install --frozen-lockfile` | Install the recorded dependency graph |
| `pnpm build` | Compile the SDK with TypeScript 7 |
| `pnpm --filter @neontechspace/fluxerly format` | Format SDK source, tests and configuration with Prettier |
| `pnpm --filter @neontechspace/fluxerly format:check` | Check SDK formatting without writing files |
| `pnpm check` | Check SDK formatting, build, typecheck source/tests, run Vitest and check isolated packed JavaScript/TypeScript consumers |

The SDK's [Prettier configuration](/projects/sdk/.prettierrc.json) sets a 120-column target and omits optional semicolons.
Prettier reads 4-space indentation and LF endings from the shared [EditorConfig](/.editorconfig).
Formatting runs only within the SDK and respects its [.gitignore](/projects/sdk/.gitignore), excluding build output and local sandbox files.
The website and repository documents are outside these formatting commands

Local networking checks use owned loopback fixtures, not Fluxer credentials or live sessions

Run the packed-consumer check with Node.js 24.11.0 as well as the development runtime when changing runtime compatibility.
Use `pnpm --filter @neontechspace/fluxerly test:package` after building with the development runtime.
The check reports its actual Node version and uses that executable for its isolated consumers

Run `pnpm --filter @neontechspace/fluxerly test:cache:memory` for isolated GC-enabled retention checks.
Run `pnpm --filter @neontechspace/fluxerly test:cache:workload` for local cache workloads.
Both build first and use controlled responses, not Fluxer credentials or production workloads

Run `pnpm --filter @neontechspace/fluxerly test:rest:queue` to compare JSON queue-byte budgets through both built APIs.
The benchmark uses isolated processes and controlled HTTP responses, changing only the loaded queue constant without editing source or build output.
It reports rejection, timeout, latency and process-memory observations; it does not measure hosted service limits or select a default automatically

### Opt-in live sandbox check

Run live checks only against the authorized test bot and server, from [projects/](/projects/).
The SDK-local, Git-ignored `.env.test.local` must provide `FLUXER_TEST_GUILD_ID`, `FLUXER_TEST_APPLICATION_ID` and `FLUXER_TEST_BOT_TOKEN`.
The checks verify bot/application/server identity and do not use a client secret.
Never print credentials or private payloads when diagnosing a failure

Run a table entry as `pnpm --filter @neontechspace/fluxerly <script>`.
These checks are opt-in and excluded from `pnpm check`

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

`test:live:expressions` checks emoji/sticker lifecycle, gateway updates, partial batches and sticker messages through both built APIs.
It creates temporary expressions and a channel, deletes test-owned resources without media purging, and preserves a recovery journal on unresolved outcomes

| Script | Purpose | Outside effects |
| --- | --- | --- |
| `test:live` | Hosted protocol discovery, readiness and heartbeats | No server-content changes |
| `test:live:sdk` | Built default/native client connection and shutdown | No server-content changes |
| `test:live:application` | Built default/native current-bot application allowlist and hosted installation-link construction | Read-only; no navigation, authorization, or server-content changes |
| `test:live:consumer-operations` | Account-banner URLs, attachment deletion, exact bot-role replacement and fresh gateway counts through both built APIs | Temporary channel/messages and one zero-permission role assigned only to the test bot, plus test-owned response loss and socket interruption |
| `test:live:member-chunks` | Streamed member selection, optional presence, full-list readback and failure/recovery through both built APIs | Read-only guild/member requests, test-owned reply drops and one socket interruption per mode, no server-content changes |
| `test:live:sharding` | Two-shard readiness, member routing, isolated recovery and partial-startup cancellation through both built APIs | Read-only sandbox requests, one test-owned shard-socket interruption and one cancelled startup per mode, no content or account-presence changes |
| `test:live:presence` | Interactive selected-guild member presence delivery, Op14 restore after a test-owned socket interruption and cleanup through both built APIs | No account-state changes by the harness; the authorized participant performs visible status transitions and the harness interrupts only its own socket |
| `test:live:messages` | SDK receive/reply with independent readback | Temporary channel and messages |
| `test:live:consumer-features` | Forward snapshots, attachment-backed embeds, retained file metadata, non-voice flags, bot profile reads and lost-response reconciliation through both APIs | Journaled temporary channel/messages and uploads, test-owned response loss; profile GET may trigger provider expired-premium cleanup |
| `test:live:typing` | One-shot typing, scoped refresh and completion/cancellation cleanup through both APIs | Temporary channel/messages and ephemeral typing notices; does not prove inbound typing delivery |
| `test:live:typing:interactive` | Human-visible outgoing typing and selected-member inbound events through both APIs | Temporary channel and typing notices, with awaited refresh shutdown and verified channel removal |
| `test:live:roles:reset` | Guild-wide role-display reset and lost-response reconciliation through both APIs | Two temporary zero-permission roles and whole-guild display reset, with existing display assignments required to be null |
| `test:live:recovery` | Forced socket loss, resume, diagnostics and subsequent receive/reply | Temporary channel/messages and test-socket termination |
| `test:live:recovery:cancel` | Managed cancellation during recovery and socket cleanup | Test-socket termination, no server-content changes |
| `test:live:management` | Remote fetch, edit and deletion | Temporary channel/messages and test-message edits/deletions |
| `test:live:batch-delete` | Explicit message batches, events/cache, missing IDs and lost-response reconciliation | Temporary channel/messages and test-owned response loss |
| `test:live:moderation:default`, `test:live:moderation:effect` | Timeout/clear, kick, ban expiry/unban, events and lost-response reconciliation | Authorized disposable member moderation, temporary channel/messages, test-owned response loss |
| `test:live:webhooks` | Webhook management, webhook-set notices, destination moves, message/file readback, lost-response reconciliation and credential revocation through both APIs | Temporary webhooks, channels/messages, file uploads and test-owned response loss |
| `test:live:invites` | Invite creation, create/delete notices, inspection, lists, revocation and lost-response reconciliation through both APIs | Temporary channel and invites; no invite acceptance or membership changes |
| `test:live:administration` | Server-setting edits, live audit-entry notices and filtered audit reads/traversal through both APIs | Temporary sandbox server renaming, restoration, audit records and test-owned response loss |
| `test:live:vanity` | Custom-invite reads, read recovery and disabled-feature rejection through both APIs | No intended successful mutation, uses a reserved code for rejection checks |
| `test:live:vanity:mutate:default`, `test:live:vanity:mutate:effect` | Manual custom-invite lifecycle and lost-response reconciliation | Opt-in temporary custom codes on an eligible sandbox with no existing code |
| `test:live:discovery` | Directory categories, eligibility/status and read recovery through both APIs | Read-only, never submits an application |
| `test:live:member-search` | Indexed member search and local/remote permission calculation through both APIs | Resource reads and search requests, which can trigger provider lazy indexing; no member moderation or role/channel edits |
| `test:live:members` | Authorized target-member nickname set, independent readback and restoration through both APIs | Temporary nickname change for one currently authorized non-owner member |
| `test:live:guild-lifecycle` | Bot membership pages and bounded traversal through both APIs | Read-only unless the harness is invoked separately with `--leave` |
| `test:live:discovery:mutate:default`, `test:live:discovery:mutate:effect` | Manual directory application lifecycle and lost-response reconciliation | Real review-queue submission or immediate public listing, then test-owned withdrawal |
| `test:live:users:default`, `test:live:users:effect` | Public user reads, private conversations, bot server-profile edits and message failure reconciliation | Test DMs, authorized group messages/renaming, bot profile changes and test-owned response loss |
| `test:live:events` | Gateway delivery after raw API mutations | Temporary channel/messages and test-message edits/deletions |
| `test:live:reactions` | Unicode/custom reactions, collectors, reactor readback, clear events and recovery | Temporary channel/messages, reactions and guild emoji, plus test-socket termination |
| `test:live:pins` | Pin/unpin, explicit pages, pin status/events and recovery | Temporary channel/messages and pins, server-created pin notices, plus test-socket termination |
| `test:live:guilds` | Guild/member reads, reaction-driven role assignment, role management/events, optional caches and recovery | Temporary channel/messages, two zero-permission test roles with assignment only to the designated bot, plus test-socket termination and test-owned response loss |
| `test:live:guild-events` | Bot-session guild create delivery after READY | Read-only gateway connection to the existing sandbox guild; fails when it is unavailable or the bounded event wait expires |
| `test:live:channels` | Guild channel management, permission overwrites, inheritance, events/cache and recovery | Temporary channels/categories, overwrites targeting only the bot and test guild's everyone role, test-socket termination and test-owned response loss |
| `test:live:history` | Explicit history pages checked against API readback | Temporary channel and messages |
| `test:live:search` | Bounded contextual indexed-message search, explicit indexing and cache exclusion | Temporary channel/messages; may report a hosted indexing timeout |
| `test:live:pagination` | History/member/reactor/pin traversal, early exit, read recovery and cancellation cleanup | Temporary channel/messages, reactions and pins, plus test-owned transient read failure and delayed response delivery |
| `test:live:cache` | Cache intake, expiry and recovery invalidation | Temporary channel/messages and test-socket termination |
| `test:live:collectors` | Collector completion, gap failure and use after recovery | Temporary channel/messages and test-socket termination |
| `test:live:embeds` | Embed send/reply/edit, readback, events, cache and collectors | Temporary channel/messages and test-message edits |
| `test:live:attachments` | Uploads, binary readback, file edits, events/cache/collectors and recovery | Temporary channel/messages, 50 MiB file upload/download, file replacements and test-socket termination |

The shared `.env.test.local.lock` prevents concurrent runs through these harnesses, not sessions started by other tools

Sharding checks use that lock and the same sandbox identity verification, without a recovery journal or remote resource creation.
The harness explicitly skips owning-shard count replies while the provider fix remains undeployed; a passing run does not establish that path.
Recheck deployment before enabling that stage. Local transport tests cover the GitHub reply contract in the meantime

Member-chunk checks require a sandbox with fewer than 1,000 members and compare the response with one fresh REST member page.
The harness can wait once for a confirmed full-list rate limit left by a prior mode, then make a new request.
It reports whether the hosted gateway actually rejects an immediate repeat; acceptance does not verify live rate-limit handling.
It creates no resources or recovery journal and does not change account presence.
Multi-batch arrival, missing-batch and slow-reader behavior use local transport tests rather than claiming a large live-guild run

Consumer-operation checks preserve the designated bot's original roles in `.env.test.consumer-operations.local`, alongside test-role and channel markers.
Recovery restores only the recorded baseline plus the unchanged zero-permission test role, verifies restoration and resource removal, then deletes the journal.
An unexpected role assignment or altered test resource retains the journal for reconciliation.
Fresh reads detect existing conflicts, but Fluxer's role PATCH has no conditional precondition and cannot make the read-and-write sequence atomic

Consumer-feature checks use the same sandbox identity checks and an ignored `.env.test.consumer-features.local` journal.
Recovery resolves only the journaled channel marker and verifies channel removal before deleting the journal.
Profile reads target only the designated bot, with and without the designated guild context; no human profile changes or private conversations are part of this check

Invite checks use the same lock and an ignored `.env.test.invites.local` recovery journal containing only test-channel identity, never invite codes.
Cleanup reconciles the owned channel, verifies invite destination and creator before revocation, then removes the channel

Administration checks use the shared lock and an ignored `.env.test.administration.local` journal containing sandbox identity, a unique marker and the original server name.
Restoration refuses to overwrite an unexpected concurrent name change and retains its journal on conflict

Audit queries always include a user or action filter; no unfiltered read is used because Fluxer may rewrite deletion records during that request

Custom-invite mutation checks are manual, excluded from `pnpm check`, CI and unattended runs

Use a specifically authorized disposable server with `VANITY_URL`, ManageGuild permission and no existing custom code.
Supply two distinct, available lowercase codes through `FLUXER_TEST_VANITY_CODE` and `FLUXER_TEST_VANITY_SECOND_CODE`, plus `FLUXER_TEST_VANITY_MUTATIONS=1`.
Process environment takes precedence over ignored `.env.test.local`; stored values are not authorization.
Run each mutation mode separately. Successful invite inspection also needs a channel visible to everyone

The ignored `.env.test.vanity.local` journal stores sandbox identity and code hashes, never the codes themselves.
Recovery removes only a matching test-owned code and refuses concurrent replacements.
An uncertain provider-side partial write retains the journal for operator reconciliation, even if the guild's custom-code slot is empty

Changing an existing code cannot guarantee reclaiming it, so the harness refuses that scenario.
Read/rejection checks do not establish successful setting, replacement, removal or lost-response recovery.
Include executed scenarios and untested mutation paths in the test report

Discovery mutation checks require specific permission for real directory submission and possible immediate public listing.
Use an eligible disposable sandbox with no existing application or listing, and set `FLUXER_TEST_DISCOVERY_MUTATIONS=1` for that manual invocation.
Optionally select `FLUXER_TEST_DISCOVERY_CATEGORY_ID`; the default is the provider's Other category.
Run the default and Effect mutation scripts separately, never in CI or unattended runs.
The ignored `.env.test.discovery.local` journal retains only target identity, synthetic test marker and application timestamp.
Cleanup refuses unrelated descriptions or replacement applications and verifies the test record and discoverable guild feature are removed.
Partial provider writes can require operator reconciliation; search-index removal and reviewer notifications are not reversible guarantees.
Read-only script success is not live application-lifecycle proof

Webhook checks use the same sandbox identity checks and lock, with their own ignored `.env.test.webhooks.local` recovery journal.
That journal stores test-owned resource IDs and unique names, never webhook tokens.
Recovery verifies the webhook creator and destination against the designated bot and owned channels before deletion.
After a crash, verify that the recorded process has stopped before removing its stale lock.
Do not stop unrelated processes or bypass a live owner's lock

User/private-conversation checks are manual and require current authorization for the recipient supplied through `FLUXER_TEST_DM_USER_ID`.
The process environment takes precedence over ignored `.env.test.local`; a stored ID is not authorization

The checks verify the recipient's membership in the designated sandbox, preserve pre-existing open DMs and remove test-owned messages.
The ignored `.env.test.users.local` journal records test-owned markers/IDs and temporary bot-profile restoration data, never credentials

Existing-group checks additionally require current permission to rename and send messages in the channel supplied through `FLUXER_TEST_GROUP_DM_ID`.
Use a named temporary group owned by the authorized recipient, containing only that account and the sandbox bot

An explicitly authorized additional account can be supplied through `FLUXER_TEST_GROUP_EXTRA_USER_ID`.
The harness preserves membership, restores the original group name and deletes only test-owned messages

Without a selected group, or with `--without-group`, the script reports group checks as skipped. That run is not group verification

Member nickname checks are manual, excluded from `pnpm check`, CI, schedules and unattended runs.
Supply the currently authorized non-bot, non-owner target through `FLUXER_TEST_MEMBER_ID` in the process environment; the ignored env file is never read for this ID

The ignored `.env.test.members.local` journal contains only sandbox/bot/authorized-member identity, a test marker and that member's original nickname for restoration, never credentials.
It is written before the mutation; recovery requires the same currently supplied member ID, restores only the exact test marker and refuses an unexpected observed concurrent nickname change

The harness rereads the nickname immediately before the write, but Fluxer's PATCH has no conditional precondition, so it cannot make the read-and-write sequence atomic.
It deliberately loses one response after the marker write, verifies the SDK reports an unknown outcome and evicts its member cache, then reconciles raw state before restoration

Member-moderation scripts are manual opt-in checks, never part of `pnpm check`, CI, schedules or unattended reruns

Guild leave checks are also manual: Coordinate with the person who can re-add the bot before each invocation.
After building, run `node tests/live/guild-lifecycle.mjs default --leave` or the `effect` mode from the SDK directory with the currently authorized `FLUXER_TEST_LEAVE_GUILD_ID` in the process environment.
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

Message checks create a uniquely named test channel and verify deletion of that channel and its messages.
The ignored `.env.test.messages.local` recovery journal records the server ID, unique channel marker and returned channel ID, never credentials or message bodies.
It is written before channel creation so a lost response can be reconciled by the marker rather than blindly retried.
A later run reconciles the journal before creating resources.
Journal writes and remote creation are not atomic

Reaction checks also journal a unique emoji name, uploader and returned ID before using a test-owned guild emoji.
Cleanup verifies its identity and absence from the guild emoji list; this does not prove physical image-blob erasure

Corrupt or unresolved journal state fails closed and must be inspected, not deleted merely to make a check pass

Guild checks also journal unique role names and returned IDs before assigning a zero-permission role to the test bot.
Two test roles exercise SDK creation, editing, relative reordering and deletion after recovery.
Cleanup reconciles only those markers/IDs, verifies remaining roles still have zero permissions and confirms absence after deletion.
The role check preserves existing bot roles and does not edit human memberships or existing roles

Channel checks journal each additional category and child marker before creation and reconcile returned IDs against those markers.
Cleanup removes test-owned children before categories and verifies absence before releasing the journal.
Permission checks target only the test bot and the guild's everyone role inside these test-owned channels.
Keep the journal until test-owned cleanup is verified

Use [live harness source](/projects/sdk/tests/live/) for assertions and bounded execution details.
A passing run establishes only its checked scenarios, not complete replay, prolonged-outage recovery or production readiness

Release and deployment commands are not configured yet
