# Repository guide

Use this guide to locate implementation owners, configure the workspace and run contributor checks.
The SDK is in development and is not released for supported public use.
The documentation website remains a scaffold

## Project areas

| Location | Purpose |
| --- | --- |
| [SDK](/projects/sdk) | The Fluxer-native JavaScript SDK, with the package identity in its [manifest](/projects/sdk/package.json) |
| [Website](/projects/web) | The documentation website, with its own [manifest](/projects/web/package.json) |
| [Documentation](/docs) | Repository Markdown documents, including the public [README](/docs/README.md) and this guide |

See [technology choices](/docs/TECHNOLOGY.md) for tooling and support policy, and [SDK contracts](/docs/SDK-CONTRACTS.md) for cross-cutting implementation constraints

## Shared files

The development workspace root is [projects/](/projects), separate from the repository root.
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

Build, test, release and deployment commands are not configured yet
