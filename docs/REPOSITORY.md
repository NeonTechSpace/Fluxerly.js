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
| [client.ts](/projects/sdk/src/internal/client.ts) | Client lifetime and recovery ownership |
| [discovery.ts](/projects/sdk/src/internal/discovery.ts) | Hosted service discovery |
| [gateway.ts](/projects/sdk/src/internal/gateway.ts) | Gateway transport and protocol |
| [events.ts](/projects/sdk/src/internal/events.ts) | Subscription scheduling and bounded event intake |
| [rest.ts](/projects/sdk/src/internal/rest.ts) | REST admission, deadlines and rate state |
| [message.ts](/projects/sdk/src/internal/message.ts) | Wire-message validation and projection |
| [embeds.ts](/projects/sdk/src/internal/embeds.ts) | Rich-embed input validation and frozen received embed projection |
| [attachments.ts](/projects/sdk/src/internal/attachments.ts) | File validation and metadata projection |
| [uploads.ts](/projects/sdk/src/internal/uploads.ts) | Presigned plan validation, upload destination boundary and bounded file streams; REST owns scheduling and message completion |
| [cache.ts](/projects/sdk/src/internal/cache.ts) | Cache retention and conflicting observations |
| [cache-reports.ts](/projects/sdk/src/internal/cache-reports.ts) | Cache reporting lifetime |
| [collector.ts](/projects/sdk/src/internal/collector.ts) | Collector budgets, deadlines and cleanup |
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
Node 24 is the selected minimum consumer major, but the exact minimum minor and patch remain undecided

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

| Script | Purpose | Outside effects |
| --- | --- | --- |
| `test:live` | Hosted protocol discovery, readiness and heartbeats | No server-content changes |
| `test:live:sdk` | Built default/native client connection and shutdown | No server-content changes |
| `test:live:messages` | SDK receive/reply with independent readback | Temporary channel and messages |
| `test:live:recovery` | Forced socket loss, resume, diagnostics and subsequent receive/reply | Temporary channel/messages and test-socket termination |
| `test:live:recovery:cancel` | Managed cancellation during recovery and socket cleanup | Test-socket termination, no server-content changes |
| `test:live:management` | Remote fetch, edit and deletion | Temporary channel/messages and test-message edits/deletions |
| `test:live:events` | Gateway delivery after raw API mutations | Temporary channel/messages and test-message edits/deletions |
| `test:live:history` | Explicit history pages checked against API readback | Temporary channel and messages |
| `test:live:cache` | Cache intake, expiry and recovery invalidation | Temporary channel/messages and test-socket termination |
| `test:live:collectors` | Collector completion, gap failure and use after recovery | Temporary channel/messages and test-socket termination |
| `test:live:embeds` | Embed send/reply/edit, readback, events, cache and collectors | Temporary channel/messages and test-message edits |
| `test:live:attachments` | Uploads, binary readback, file edits, events/cache/collectors and recovery | Temporary channel/messages, 50 MiB file upload/download, file replacements and test-socket termination |

The shared `.env.test.local.lock` prevents concurrent runs through these harnesses, not sessions started by other tools.
After a crash, verify that the recorded process has stopped before removing its stale lock.
Do not stop unrelated processes or bypass a live owner's lock

Message checks create a uniquely named test channel and verify deletion of that channel and its messages.
The ignored `.env.test.messages.local` recovery journal records the server ID, unique channel marker and returned channel ID, never credentials or message bodies.
It is written before channel creation so a lost response can be reconciled by the marker rather than blindly retried.
A later run reconciles the journal before creating resources.
Journal writes and remote creation are not atomic

Corrupt or unresolved journal state fails closed and must be inspected, not deleted merely to make a check pass.
Keep the journal until test-owned cleanup is verified

Use [live harness source](/projects/sdk/tests/live/) for assertions and bounded execution details.
A passing run establishes only its checked scenarios, not complete replay, prolonged-outage recovery or production readiness

Release and deployment commands are not configured yet
