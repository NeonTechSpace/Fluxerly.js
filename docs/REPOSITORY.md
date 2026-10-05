# Repository guide

This guide covers contributor setup, the code map and checks.
The SDK is a prerelease with no stable version yet

Contribution policy is in [Contributing](/CONTRIBUTING.md). Maintainer access
preparation and permission commands are in
[contribution administration](/docs/CONTRIBUTIONS.md)

## Quick start

1. Install the Node.js version recorded in [projects/.node-version](/projects/.node-version)
2. Install pnpm through its [official installation guide](https://pnpm.io/installation). The workspace's `devEngines` setting then downloads and switches to the recorded pnpm 12 release automatically
3. From [projects/](/projects/), run `pnpm install --frozen-lockfile`
4. Run `pnpm check` from the same directory to validate contribution tooling, the SDK, release tooling and website
5. Find code through the [project areas](/docs/REPOSITORY.md#project-areas), with public API documentation in SDK source comments and user guides in `projects/web/content/guides/`

## Project areas

| Location | Purpose |
| --- | --- |
| [SDK](/projects/sdk/) | The Fluxer-native JavaScript SDK, with the package identity in its [manifest](/projects/sdk/package.json) |
| Website (`projects/web/`) | The documentation website, combining handwritten guides with a generated public API reference, and its own manifest (`projects/web/package.json`) |
| [Release tooling](/projects/release/) | Changesets planning, immutable candidates, registry reconciliation and exact-source GitHub announcements |
| [Documentation](/docs/) | Repository Markdown documents, including the public [README](/docs/README.md) and this guide |

| Area | Entry points and ownership |
| --- | --- |
| Public API | The [default](/projects/sdk/src/index.ts) and [Effect](/projects/sdk/src/effect.ts) entry points re-export the public surface. Client interfaces and their member documentation live in [default](/projects/sdk/src/api/default/) and [Effect](/projects/sdk/src/api/effect/) API modules, bound once through the [operation table](/projects/sdk/src/internal/binding/operations.ts). Public resource modules define their types and operation errors. The [default testing](/projects/sdk/src/testing.ts) and [Effect testing](/projects/sdk/src/effect-testing.ts) entry points expose test clients and fixtures, implemented over an in-memory transport in [internal/testing/](/projects/sdk/src/internal/testing/) |
| Client and transport | [Client](/projects/sdk/src/internal/client.ts), [gateway](/projects/sdk/src/internal/gateway.ts), [REST](/projects/sdk/src/internal/rest.ts) and [instance discovery](/projects/sdk/src/internal/instance.ts) own lifetime, recovery, admission and endpoint trust. Their parts live in the matching `client/`, `gateway/` and `rest/` folders. [Transports](/projects/sdk/src/internal/transport/) are the only network seam, and [decoders](/projects/sdk/src/internal/decode/) and [protocol codes](/projects/sdk/src/internal/protocol/gateway.ts) are shared. [Rate limits](/projects/sdk/src/internal/rate-limits.ts) use [resource-partition metadata](/projects/sdk/src/internal/rate-limit-templates.ts), not fixed provider limits |
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
Use [SDK tests](/projects/sdk/tests/) for behavior checks and [packed consumers](/projects/sdk/tests/packaging/consumers/) for package-boundary checks.
SDK tests are grouped by area: `support/` holds shared fixtures, `unit/` local helpers, `client/` lifetime, transport, sharding and supervision, `resources/` one folder per client namespace, `events/` delivery and collectors, `logging/` diagnostics, `contract/` the public API shape baseline, runtime export inventory and public-client contract, `packaging/` packed and npm consumer checks, `perf/` opt-in measurements and `live/` sandbox harnesses and their local tests.
The standalone [bot examples](/projects/sdk/examples/starter/) ship with the package and supply the website's runnable first-bot examples. They use the public SDK runner without companion files. The other folders under [examples](/projects/sdk/examples/) are repository-only examples that do not ship with the package. The packed-consumer check compiles them and requires each `bot.js` to match its `bot.ts`
The build emits ignored files under `projects/sdk/dist/`, which must not be edited by hand

For shared error changes, start at [REST classification](/projects/sdk/src/internal/rest/classify.ts) and [cause preservation](/projects/sdk/src/internal/effect-failures.ts).
Operation error constructors live with their public resource types, not only in errors.ts. Message failures have their own [module](/projects/sdk/src/message-errors.ts).
Use [local validation checks](/projects/sdk/tests/unit/input-validation.test.ts), [provider rejection checks](/projects/sdk/tests/resources/webhooks/webhooks.test.ts) and [combined cleanup failures](/projects/sdk/tests/client/cleanup-failures.test.ts) for their distinct boundaries.
For client lifetime changes, [network checks](/projects/sdk/tests/client/network.test.ts) cover startup and closure, [recovery checks](/projects/sdk/tests/client/recovery.test.ts) cover retry/resume, and [supervisor child failures](/projects/sdk/tests/client/supervisor/supervisor-child-failures.test.ts) cover process ownership

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
| [projects/.node-version](/projects/.node-version) | One development Node.js version source |
| [.editorconfig](/.editorconfig) | Shared editor formatting defaults |
| [.gitattributes](/.gitattributes) | Shared Git text and line-ending rules |
| [.github/CODEOWNERS](/.github/CODEOWNERS) | Review ownership for the repository, workflows and release tooling |
| [SECURITY.md](/SECURITY.md) | Supported versions and private vulnerability reporting |
| [LICENSE](/LICENSE) | Apache-2.0 license for the SDK, website code, and authored documentation |

See [technology choices](/docs/TECHNOLOGY.md#shared-development-tooling) for the development Node pin, pnpm selection and update procedure, and [consumer support](/docs/TECHNOLOGY.md#consumer-support) for the separate consumer Node floor and its [support policy](/docs/TECHNOLOGY.md#support-policy)

## Placement and scope

- Keep project-specific dependencies and tooling in the project that uses them
- Keep shared development tooling in projects/, not at the repository root
- Reserve the repository root for repository-wide documents and settings
- Place ignore rules where needed, preferring project scope without adding an ignore file to every internal module
- Add source, test, and output directories when their contents or tooling require them
- Update this guide when project responsibilities or navigation change

The workspace root, website and SDK manifests are private packages.
SDK releases publish a separately staged package under the public package identity, following the [registry publication contract](/docs/RELEASING.md#registry-publication-contract)

## Development checks

Run these commands from [projects/](/projects/) using the development Node version

| Command | Purpose |
| --- | --- |
| `pnpm install --frozen-lockfile` | Install the recorded dependency graph |
| `pnpm build` | Compile the SDK with TypeScript 7 and build its documentation website |
| `pnpm --filter @neontechspace/fluxerly format` | Format SDK source, tests and configuration with Prettier |
| `pnpm --filter @neontechspace/fluxerly format:check` | Check SDK formatting without writing files |
| `pnpm lint` | Lint SDK code and tests, release tooling and website scripts with Oxlint, report unused SDK files and exports with Knip and check spelling with CSpell. Warnings do not fail the check |
| `pnpm check` | Check SDK formatting, lint, build, public-client surface, types, runtime and packed consumers, then release tooling types, lint and tests, and website script lint, build, types and tests |
| `pnpm --filter @neontechspace/fluxerly test:public-contract` | Check paired client namespace names, runtime keys, structural parameter/result parity and JSDoc presence |
| `pnpm --filter @neontechspace/fluxerly test:npm` | Check npm installation of the packed SDK and required Effect peer |
| `pnpm docs:dev` | Build the SDK, generate its public reference and start local Astro development |
| `pnpm docs:dev:skip-build` | Generate the public reference from the existing SDK build and start local Astro development, without rebuilding the SDK |
| `pnpm --filter fluxerly-docs test:browser` | Check the rendered development documentation in Chromium |
| `pnpm --filter fluxerly-docs test:versions` | Check Stable history and rolling prerelease documentation using isolated release fixtures |
| `pnpm --filter fluxerly-docs test:snapshots` | Build every imported release snapshot and check its served pages |
| `node release/upstream.js` | Compare the reviewed [repository pin](/projects/release/upstream/manifest.json) with upstream API documents, gateway events and parameterized rate-limit buckets. Add `--update` to record a reviewed commit. The [daily drift workflow](/.github/workflows/upstream-drift.yml) instead uses `--baseline <file> --record <file>` to signal each newly observed commit and retain its hashes, falling back to the repository pin with a reported reason when the previous observation is unavailable or invalid |
| `pnpm --filter @neontechspace/fluxerly test:upstream:guild-features` | Opt-in current Fluxer toggle-set and cloning-guard source comparison, requiring authenticated `gh`. No provider requests or mutations |

Formatting runs only within the SDK and respects its [.gitignore](/projects/sdk/.gitignore), excluding build output and local sandbox files.
The website and repository documents are outside these formatting commands.
[Technology choices](/docs/TECHNOLOGY.md#shared-development-tooling) record the Prettier settings

Local networking checks use owned loopback fixtures, not Fluxer credentials or live sessions

Local SDK test runs use half the available threads, at most four, because they share the machine with other work. CI runners use every thread. Test files that start child processes run as a second stage with one worker fewer, so their child processes cannot saturate the host. An explicit `VITEST_MAX_WORKERS` value sets the limit for local investigation without skipping tests or changing their deadlines

When changing runtime compatibility, run the packed-consumer check on the SDK manifest's `engines.node` minimum as well as the development runtime.
Use `pnpm --filter @neontechspace/fluxerly test:package` after building with the development runtime.
The check reports its actual Node version and uses that executable for its isolated consumers.
The npm consumer check runs the exact SDK development-only npm CLI pin on that same Node executable.
It does not depend on npm being bundled with the Node installation or install npm for SDK users

Package and npm checks reuse pnpm's cache but may fetch missing public registry metadata or dependencies for their isolated consumers.
A frozen workspace install does not guarantee the metadata needed to resolve a standalone consumer is cached.
Dependency installation scripts are disabled for isolated SDK consumers, and the checks remove their own temporary packages after success or failure

The default SDK checks cover the socket transport through the SDK's own gateway tests and check that the built SDK lets the process exit naturally. Lint rules keep network access inside the [transport seam](/projects/sdk/src/internal/transport/)

The public-client contract compares every paired default/native surface, including clients, returned handles, namespaces and helper values, with one strict [type comparator](/projects/sdk/tests/contract/fixtures/public-client-parity/compare.ts) after normalizing the default signal option, local lookups and result wrappers. Explicit exceptions cover API-specific callback and lifetime contracts.
It also checks member names, direct runtime keys and paired comments. A mutation fixture runs the same comparator and verifies that a dropped optional option, a dropped result field and a dropped parameter fail.
The [binder check](/projects/sdk/tests/types/binding-parity.ts) uses the same comparator for members derived from the operation table.
It does not establish behavioral parity, assess comment accuracy, or cover every standalone client or type-only export

The [semantic baseline](/projects/sdk/tests/contract/conformance-fields-shapes.snapshot.txt) records, for both public entry points, every Client, OAuthClient and WebhookClient member and namespace operation read from source, with operation signatures, union variants, field types, optionality and nullability.
The [baseline test](/projects/sdk/tests/contract/conformance-fields-inventory.test.ts) also requires each `Default*Options` type to match its native options type apart from an optional `signal`.
After reviewing an intentional public shape change, update the baseline from the SDK directory with `pnpm exec vitest run tests/contract/conformance-fields-inventory.test.ts -u` and review the generated diff.
The [runtime export inventory](/projects/sdk/tests/contract/module-conformance-registry.js) checks the exact value exports of each public entry point, from source and from the packed package

The upstream guild-feature check pins one current Fluxer commit per run and fails on changed values or unrecognized source structure.
It detects source changes but does not verify hosted behavior. The live feature-toggle check verifies changes and restoration against the hosted service

Run `pnpm --filter @neontechspace/fluxerly test:rest:queue` to compare JSON queue-byte budgets through both built APIs.
The benchmark uses isolated processes and controlled HTTP responses. It varies only the public `rest.queuedJsonMaxBytes` client option.
It reports rejection, timeout, latency and process-memory observations. It does not measure hosted service limits or select a default automatically

After building the SDK, run `pnpm --filter @neontechspace/fluxerly exec node tests/perf/performance-logging.js` for logging-overhead measurements, or `pnpm --filter @neontechspace/fluxerly exec node tests/perf/performance-local.js` for cold import/client lifecycle, cache-workload and retention measurements.
Both are opt-in, use controlled responses without credentials and emit JSON Lines with input hashes, environment, raw samples and descriptive summaries.
Run them serially without concurrent builds or test workers. The optional `--smoke` flag checks harness correctness with reduced work, not performance.
These measurements are local evidence, not hosted throughput claims or mandatory CI speed thresholds

## Live sandbox checks

Opt-in checks against the designated Fluxer sandbox are excluded from `pnpm check` and CI.
The [live check guide](/projects/sdk/tests/live/README.md) covers their setup, authorization levels, outside effects and recovery after a failed run

## Release and documentation operations

Use [releasing](/docs/RELEASING.md) for registry verification, manual workflow inputs and external setup.
Release candidates stage the SDK through [package preparation](/projects/sdk/scripts/packages.js), under the [registry publication contract](/docs/RELEASING.md#registry-publication-contract).
Use [documentation maintenance](/docs/DOCUMENTATION.md) for generated reference ownership, published version channels and Preview delivery.
Each workflow job installs Node and pnpm with the pinned upstream `pnpm/setup` action from [projects/](/projects/), which reads `projects/.node-version`.
Jobs that check the SDK's Node floor pass the `engines.node` minimum from the SDK manifest as `runtime` instead, and a [workflow test](/projects/release/tests/workflows.test.js) keeps those copies equal to the manifest.
The action installs the locked dependencies unless a job that runs only dependency-free release tooling disables it.
There is no separate `setup-node` step
