# Releasing

This guide covers cutting an SDK release from reviewed `main` source, recovering from failures and the rules the release tooling enforces.
Use [npm registry metadata](https://registry.npmjs.org/@neontechspace%2ffluxerly) for published versions and distribution tags

## Cut a release

1. Record SDK changes with `pnpm changeset` from [projects/](/projects/) while developing them.
   Select the public package and compatibility bump, and write caller-relevant notes rather than an edited-file list
2. Run [Release version PR](/.github/workflows/release-version.yml) with `source_ref: main` and the readiness `channel`.
   It opens a `release/version-VERSION` pull request and dispatches [Check](/.github/workflows/ci.yml) on that branch.
   Review the SDK version, changelog and consumed fragments, then merge after Check passes
3. After the merge, Check runs on `main`. When it passes and the push changed the SDK version to one npm lacks, it dispatches [Release prepare](/.github/workflows/release-prepare.yml) for that exact commit.
   Review the version, channel, release notes and candidate SHA256 in the preparation summary
4. Run the `gh workflow run release-publish.yml` command printed in that summary, or dispatch [Release publish](/.github/workflows/release-publish.yml) from `main` with the same preparation run ID and checksum.
   It publishes the retained tarball, installs it from npm on both supported Node versions, announces the GitHub release and deploys the Docs preview
5. Confirm the result in the run summaries.
   For a downloaded candidate, `pnpm release:status` reports whether npm serves the reviewed bytes and the current distribution tags

Every step can be rerun with the same inputs. Publication reads npm before uploading and never uploads a version twice

## When a step fails

| Message | Meaning | Action |
| --- | --- | --- |
| `npm publication is unconfirmed` | The upload outcome is unknown | Rerun Release publish with the same inputs. It reads npm first |
| `npm serves different bytes for VERSION than the reviewed candidate` | npm already has this version with other content | Never republish. Inspect the registry version and release a new version through Changesets |
| `npm serves VERSION, but the TAG tag does not point to it` | The bytes are published, the distribution tag is not | Correct the tag with the [dist-tag runbook](/docs/RELEASING.md#npm-distribution-tags), then rerun Release publish |
| `npm could not install ... from the registry` | A registry install check failed after publication | Inspect the install log. The GitHub release stays unannounced until a rerun passes |
| `Published baseline changed since review` | Another version on the same channel and line was published after preparation | Prepare a new candidate from current `main` |
| `Candidate source is not reachable from main` | The candidate was prepared from unmerged source | Merge the source, then prepare from `main` |
| `Candidate does not match the externally reviewed checksum` | The checksum input differs from the candidate | Copy the checksum from the preparation summary |
| `Preparation is not a successful manual run of this repository's release-prepare workflow` | The run ID is wrong or the run failed | Use the ID of a successful Release prepare run |
| `GitHub rejected the OPERATION with HTTP 4xx` | GitHub refused the request, so nothing changed | Fix the cause, such as App permissions or tag rules, then rerun Release publish |
| `GitHub release creation is unconfirmed` or `asset contents are unconfirmed` | A network or server failure left the outcome uncertain | Rerun Release publish. Reconciliation reads back instead of writing twice |
| `Publish pending changes as a release candidate before stable` | Stable was selected from an RC source that has new changes | Run Release version PR with `channel: rc`, publish that RC, then select Stable |
| `VERSION is a new major version or epoch` | A big release was selected for Stable without a published RC | Run Release version PR with `channel: rc`, publish that RC, then select Stable. See [release stages](/docs/RELEASING.md#release-stages) |
| `Release candidate VERSION is pending` | An unreleased RC blocks every other Stable at or above its version | Publish that RC as Stable first, or release a fix below it |
| `Stable content differs from VERSION` | An RC of this version is published, and the source changed after the newest one | Publish the current content as a new RC first. See [release baselines](/docs/RELEASING.md#release-baselines) |
| `No pending Changesets fragments or readiness promotion` | Nothing describes a new release | Add a fragment or select a promoting channel |
| `The source branch moved after version preparation` | New commits arrived during Release version PR | Rerun Release version PR |
| `Check run N did not pass` or `The exact-source Check gate timed out` | Release prepare or Docs preview found no passing Check for the source | Fix or rerun Check, then rerun the blocked workflow |
| `GitHub OIDC configuration is incomplete, refusing token fallback` | The publisher has no OIDC token | Confirm `id-token: write`, the `package` environment and npm trusted publishing |

Unchanged publishable content on a Canary or RC is not a failure. Release version PR opens no pull request and Release prepare retains no candidate in that case

## Reference

### Registry publication contract

The canonical SDK manifest remains `private`. The `stageRelease` package script creates a separate public npm package directory and `sdk.tgz` tarball. Never publish from the SDK checkout

[Package preparation](/projects/sdk/scripts/packages.js) copies compiled JavaScript, declarations, maps, sources, license and consumer guidance into a new directory.
It creates the public npm package directory and verifies the matching `sdk.tgz` inventory

The staged npm manifest receives the reviewed release version and retains Effect as an exact required peer.
[The prerequisite check](/projects/release/support.js) requires that exact Effect version to match the SDK development dependency and rejects an optional peer.
Release commands that read or change registries enforce it, and the release tooling tests run it in `pnpm check`

Candidate schema 1 binds the package inventory, staged manifest and tarball checksums, source commit and checked documentation snapshot checksum into one reviewed candidate.
Validation rereads the staged directory and tarball before publication.
Publication, verification, status and the GitHub announcement download the tarball npm serves, check it against the registry's SHA-512 integrity and compare its SHA-256 with the candidate's `sdk.tgz`

### Version and content rules

[Epoch Semantic Versioning](/docs/TECHNOLOGY.md#versioning-and-release-stages) defines compatibility and readiness separately.
Canary, RC and Stable are the only channels, and each new prerelease counter starts at zero.
The release wrapper retains the cycle's stable starting version in `projects/.changeset/pre.json` as `releaseBase`, with `null` for the initial `1000.0.0` cycle.
Pending and archived Changesets together determine the target's compatibility impact, while only pending notes enter a new preview's changelog. Stable collects the complete cycle's notes.
Before the Stable version PR, edit or delete archived notes in `projects/.changeset/pre/` that later changes in the cycle superseded, so the Stable changelog never announces an API that the same release removes.
Make packaged text changes for a Stable that follows an RC, such as the README release status or the `homepage` URL, before the final RC

Source versioning is not atomic. After an interruption, reconcile the manifest, prerelease state, archived notes and changelog before retrying.
Missing or invalid prerelease state fails closed

An explicit higher epoch is a multiple of 1000 and requires a major fragment.
There are no permanent readiness branches. Occasional other release lines use an explicitly selected source branch

[Content fingerprints](/projects/release/content.js) ignore package-version fields and changelog bookkeeping, not arbitrary SDK bytes.
Changed publishable bytes on the same channel require a pending fragment. Promotion to RC alone does not bypass the unchanged-content guard. Stable instead follows the [release stages](/docs/RELEASING.md#release-stages)

Changesets owns `projects/sdk/CHANGELOG.md`. The website renders it, and GitHub uses its exact version section for release notes.
Website, test and release-tooling changes that do not alter the published SDK need no fragment

### Release stages

The size of a release decides whether Stable needs an RC first:

- **Small release:** A patch or minor release within the same epoch and major version.
  It can go straight to Stable from a Stable or Canary source version, with no RC
- **Big release:** A new major version, which is a breaking change, or a new epoch.
  It must be published as an RC first. Stable then promotes that RC from an RC source version with no pending notes

A pending RC is the newest published RC above the newest published Stable.
While one exists, the only Stable at or above its version that can be published is the RC's own version.
Stables below it stay free, such as a fix on an older line.
Whenever an RC of the same version is published, Stable must match the newest one byte for byte by content fingerprint

Canary releases are experimental and exempt from these rules.
A Canary needs no RC, is never blocked by a pending RC and has no content to match.
The usual Canary checks still apply. Each Canary version must be valid and higher than the previous one on its line, and it publishes under the `canary` tag without moving `latest` or `rc`

### Release baselines

Each Canary and RC compares against the previous npm version on the same channel and `major.minor` line.
The first one on a channel and line has none. The tooling reads that from the registry version list, so it needs no extra input.
Stable compares against the newest published RC of the same version and must match its content. A small Stable with no RC of its version has no baseline.
A failed registry lookup, including a missing package, always stops the release

### Workflows

| Workflow | Trigger | Inputs and result |
| --- | --- | --- |
| [Check](/.github/workflows/ci.yml) | Pull requests, pushes to `main`, manual and version-branch dispatches | Runs SDK, website and release tooling, workflow lint, browser and two-version consumer jobs in parallel. The `check` job requires all of them, or reuses an earlier passing run for identical content |
| [Release version PR](/.github/workflows/release-version.yml) | Manual | `source_ref`, `channel` and optional `epoch` and `line`. Opens the version pull request |
| [Release prepare](/.github/workflows/release-prepare.yml) | Dispatched by Check after a version change on `main`, or manual | `source_ref` and optional `line`. Retains the candidate artifact for 90 days and prints the publish command |
| [Release publish](/.github/workflows/release-publish.yml) | Manual only | `preparation_run_id` and `candidate_checksum`. Publishes, checks registry installs, announces and deploys the Preview |
| [Docs preview](/.github/workflows/docs-preview.yml) | Called by Release publish, or manual | Always builds `main` and deploys only the Preview target |

Only Release publish writes to npm, and no push or tag publishes a package.
Release publish checks out its own workflow commit, so its tooling never comes from the candidate source.
The candidate commit is only the tag target and must be reachable from `main`

Release version PR builds the version change in a read-only job, then a separate job opens the pull request.
Pull request events for pull requests created or updated with `GITHUB_TOKEN` are not guaranteed, so that job also dispatches Check on the version branch

Identical content needs one full Check. The first job of every Check run compares the checked-out git tree with earlier push and dispatched Check runs in this repository.
When the newest conclusive matching run passed, the check jobs are skipped and the required `check` job passes with a summary that links that run.
An unfinished matching run is awaited for up to 40 minutes rather than repeated, and a failed or uncertain lookup runs the full Check.
Pull request runs never serve as evidence, because they check a merge commit rather than the recorded branch head.
A release therefore runs the full Check once, in the Check dispatched on the version branch. The version pull request run and the `main` push run after merging reuse it while `main` has not moved

Release prepare reuses the newest successful main-push Check for the exact source, waiting while it runs. A main-push Check that reused identical content counts as successful.
Only a verified absence of such a run falls back to full workspace, browser and declared-minimum-Node checks.
Preparation always builds fresh output, snapshots the documentation and installs the candidate's actual tarball before retaining it

Check on `main` dispatches Release prepare only when its own run passes. A newer push cancels an older Check, so dispatch Release prepare manually if a version change was superseded

### Publication

Publication first reads npm. An existing version with the reviewed bytes succeeds without uploading, and one with other bytes fails.
Otherwise it verifies the published baseline, submits the tarball once with npm OIDC and polls for up to 20 minutes until npm serves the reviewed bytes and the expected distribution tag points to the version.
Transient registry failures during polling do not trigger another upload

Two registry install jobs then install the exact version from npm on the development Node version and the declared minimum, Node.js 24.11.0, and import every entry point the installed package exports.
Only after both pass does the release App create a short-lived, repository-scoped token for the GitHub announcement

GitHub reconciliation polls delayed release, asset, tag and latest visibility for one minute per check.
HTTP 4xx responses are definite rejections and stop reconciliation. Network failures and 5xx responses are uncertain and lead to readback, never a repeated write.
Source, release notes and asset-content conflicts stop reconciliation

Provider output is logged with token-like values redacted

### npm distribution tags

The channel tags are `canary`, `rc` and `latest` for Stable.
Older release lines never move a channel tag backward and publish under a line-specific staging tag, such as `canary-1000-0`

No stable version exists yet, so `latest` stays at `1000.0.0-rc.0`. Release publish never moves it for previews.
The first stable release moves it to `1000.0.0`

Trusted publishing cannot change tags, so tag corrections need an interactive npm login with two-factor authentication:

```sh
npm dist-tag ls @neontechspace/fluxerly
npm dist-tag add @neontechspace/fluxerly@VERSION TAG
npm dist-tag rm @neontechspace/fluxerly TAG
```

The `latest` tag cannot be removed, only pointed at another version.
Confirm the correction with `pnpm release:status`, then rerun Release publish if it stopped at the tag check

### Local commands

Run these from [projects/](/projects/). The status, verify and publish commands require `--checksum REVIEWED_SHA256`

| Command | Purpose |
| --- | --- |
| `pnpm release:plan --channel CHANNEL` | Show the source-only version proposal without comparing registry bytes |
| `pnpm release:inspect CANDIDATE_DIRECTORY` | Check local candidate contents only |
| `pnpm release:status CANDIDATE_DIRECTORY --checksum SHA256` | Report `published`, `missing` or `different` for the served bytes, plus the distribution tags |
| `pnpm release:verify CANDIDATE_DIRECTORY --checksum SHA256` | Fail unless npm serves the reviewed bytes |
| `pnpm release:publish CANDIDATE_DIRECTORY --checksum SHA256` | Publish through GitHub OIDC only, used by Release publish |

Never treat a checksum taken only from an untrusted replacement candidate as external review

### External setup

The protected `package` environment needs no npm token secret.
Configure npm trusted publishing for `release-publish.yml` in that environment.
[Release authentication](/projects/release/authentication.js) requires GitHub OIDC and strips inherited registry tokens with an isolated token-free npm configuration

Workflows use the automatic `GITHUB_TOKEN` for repository reads, version pull requests, Check dispatches and artifacts. Do not add a `GH_TOKEN` or `GITHUB_TOKEN` secret.
Allow GitHub Actions to create pull requests

Create the private `Fluxerly Release` GitHub App under `NeonTechSpace`, with Contents write, mandatory Metadata read and no webhooks, installed only on `Fluxerly.js`.
In the `package` environment, set the `RELEASE_APP_CLIENT_ID` variable and `RELEASE_APP_PRIVATE_KEY` secret. Keep the key out of repository secrets, source, artifacts and logs.
Permit only `main` to enter `package` and keep administrator bypass disabled

For `v*` tags, use a creation-restriction ruleset whose only bypass actor is the release App, and a separate update and deletion ruleset with no bypass actors.
These rules constrain credentials, not one workflow. Administrators who can edit rules, workflows or environments can change the boundary

Use [documentation maintenance](/docs/DOCUMENTATION.md#preview-setup) for the Preview hostname, Cloudflare access and `website` environment.
Local tests establish the checked planning, staging and recovery boundaries, not live provider success
