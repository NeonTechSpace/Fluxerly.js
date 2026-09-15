# Releasing

This guide is for maintainers preparing an SDK release from reviewed source.
It covers local packaging, Changesets authoring, immutable candidates and publication.
Use [npm registry metadata](https://registry.npmjs.org/@neontechspace%2ffluxerly) for published versions and distribution tags

## Registry publication contract

The canonical SDK manifest remains `private` before, during and after release preparation.
`stageRelease` creates the separately staged public npm package directory and its `sdk.tgz` tarball.
Never publish directly from the SDK checkout

The staged npm manifest receives the reviewed release version and retains Effect as an exact required peer.
[The prerequisite check](/projects/release/support.mjs) requires that exact Effect version to match the SDK development dependency and rejects an optional peer.
It does not authenticate an npm account or grant permission to publish

Candidate schema 1 binds the npm package inventory, the staged manifest and tarball checksums, the source commit and the checked documentation snapshot checksum.
Candidate validation reads the staged directory and tarball again before publication.
The candidate checksum identifies the reviewed immutable candidate, not an uploaded package

Code, comments, declarations, source maps, package metadata and the file inventory participate in the unchanged-content comparison.
Published npm metadata establishes version availability, not uploaded file-content identity

## Available local work

Use the pinned development runtime and run commands from [projects/](/projects/).
Use [the repository checks](/docs/REPOSITORY.md#development-checks) for package and website validation.
The [Check workflow](/.github/workflows/ci.yml) runs on pull requests, pushes to `main` and `codex/**`, and manual dispatch.
It checks the workspace, npm package installation and rendered documentation without publishing

For an SDK change, author a fragment with `pnpm changeset` and select the public package and its compatibility bump.
Write caller-relevant release notes, not a list of edited files.
Website-only changes need no SDK fragment.
The wrapper permits fragment authoring and status, not direct Changesets versioning or publication

Inspect a source-only proposal with `pnpm release:plan --channel canary`.
Planning does not compare published npm package bytes or prove that a release is publishable.
A version in the source manifest does not establish publication

## Version and content rules

[Epoch Semantic Versioning](/docs/TECHNOLOGY.md#versioning-and-release-stages) defines compatibility and readiness separately.
The planner reads the current version from the [SDK source manifest](/projects/sdk/package.json).
Canary, RC and Stable are the only release channels.
The planner starts a new prerelease counter at zero.
An explicit higher epoch is a multiple of 1000 and requires a major fragment.
There are no permanent readiness branches.
Normal development and release review are main-first, with occasional explicitly selected source branches for another release line

The release guard selects the previous published npm version on the same readiness channel and `major.minor` line.
An absent baseline requires explicit bootstrap, and bootstrap is forbidden when a baseline exists.
Registry inventory failures are not permission to bootstrap

[Content fingerprints](/projects/release/content.mjs) ignore package-version fields and changelog bookkeeping, not arbitrary SDK bytes.
An unchanged fingerprint skips version preparation without consuming fragments or creating a version PR.
Candidate preparation also skips unchanged content without retaining a candidate artifact.
On the same channel, changed publishable bytes require a pending Changesets fragment rather than an undocumented version bump.
Readiness promotion must advance SemVer order, and Canary must pass through RC before Stable.
Promotion alone does not bypass the unchanged-content guard

Changesets creates and owns `projects/sdk/CHANGELOG.md` once the first version is prepared.
The website renders that changelog and GitHub release notes use its exact version section.
Do not maintain another manual changelog or invent a release entry before version preparation

For the first release, Release version creates the initial-canary Changeset only when the source manifest is `0.0.0`, the selected channel is `canary`, and no pending notes exist.
Its text is `Initial canary release of Fluxerly.js for testing and feedback`.
The action passes that Changeset to Changesets, which consumes it and generates the initial changelog automatically

## Gated manual workflow

Configure the protected environment and npm authentication before an authorized publication.
No push or tag automatically publishes a package

### Choose a workflow

In GitHub, open Actions, select the workflow and choose Run workflow for a manual run.
Use a workflow branch containing the reviewed tooling.
The `source_ref` input selects the SDK source independently of that workflow branch

| Workflow | When to use it | Inputs and result |
| --- | --- | --- |
| [Check](/.github/workflows/ci.yml) | Validate a pull request or selected branch without publishing | No extra inputs, runs workspace checks, browser checks and a two-version Node consumer matrix in parallel |
| [Release version PR](/.github/workflows/release-version.yml) | Prepare a reviewable version change | `source_ref` is a branch and `channel` is canary, rc or stable, producing a version and changelog PR unless content is unchanged |
| [Release prepare](/.github/workflows/release-prepare.yml) | Validate merged release source and retain its exact candidate | `source_ref` is the reviewed merged ref or commit, producing the candidate artifact, preparation run ID and review checksum |
| [Release publish](/.github/workflows/release-publish.yml) | Publish or reconcile the already reviewed candidate | Supply `preparation_run_id`, `candidate_checksum` and `operation`, which is `publish` by default or `reconcile` |
| [Docs preview](/.github/workflows/docs-preview.yml) | Deploy the temporary documentation after Preview setup | No extra inputs, always reads `main`, imports released snapshots and deploys only the configured Preview target |

`publish` uses npm OIDC publishing. The release App authenticates the GitHub tag and release only. Docs preview follows successful reconciliation
`reconcile` skips npm publishing and verifies the npm version exists. The release App authenticates the GitHub tag and release only. Docs preview follows successful reconciliation
Use `reconcile` only for the same immutable candidate after npm has already published

Check also runs automatically on pull requests and pushes to `main` or `codex/**`.
Release version PR and Release prepare accept optional `line` and `bootstrap` inputs.
Only Release version PR accepts `epoch`.
Leave these unset unless the [version and content rules](/docs/RELEASING.md#version-and-content-rules) require them

### Parallel checks and cancellation

Check runs the aggregate `pnpm check` in one job.
Browser checks build their own SDK and website on a separate runner.
The consumer matrix checks packed and npm-installed packages on the pinned development Node version and the declared Node minimum.
Both matrix entries run even if one fails, with at most two consumer jobs running at once.
The final `check` job requires success from the workspace, browser and consumer jobs, including both matrix entries.
Failed, cancelled, skipped or missing results cannot produce a passing gate.
The existing `SDK consumers on the declared Node floor` result name is retained

A newer automatic Check run cancels the previous run for the same event and ref.
Push and pull-request runs remain separate because they check different Git states.
Manual Check runs are independent and are not cancelled by newer automatic runs.
Version PRs use `GITHUB_TOKEN`, so their pull-request checks require approval in the PR merge box before they run

Release version PR serializes repository-wide because its version branch names are shared across source branches.
Release prepare serializes matching source, line and bootstrap inputs, keeping validation and candidate creation in one checkout.
Release publish serializes npm publication and GitHub reconciliation in separate queues.
The reconciliation job runs after the publish job, or directly for `operation: reconcile`.
Its subsequent Docs preview does not hold the npm publication lock.
Docs preview has its own serialized queue shared by manual and called runs

These release and Preview queues do not automatically cancel running work.
They use [GitHub's extended concurrency queue](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) to retain up to 100 pending requests per group rather than replacing an older pending request.
Queue order follows arrival at the lock, not necessarily manual dispatch order.
Inspect cancelled overflow runs and partial external effects before retrying.
Do not cancel an active publication to advance the queue

### Read the result

Open the run's Summary tab for custom reports of the checked surfaces, step outcomes and next action.
Candidate reports include their source, version, checksum and artifact identity when available.
Publication and Preview reports distinguish successful readback from failed or skipped effects.
The called Docs preview job supplies its own report.
An unchanged-content result is a deliberate no-op, not a prepared release

The reconciliation summary records the operation, npm availability and completion state.
An npm value of `missing` is an explicit unannounced state, so the release App does not create a tag or GitHub release and Docs preview does not run.
Registry read failures are failures, not missing versions

Raw output remains in each step's log for diagnosis.
Summaries run after failed steps too, but cannot guarantee a report when GitHub terminates the runner.
If checkout does not provide the summary helper, the fallback directs you to checkout and setup logs rather than claiming checks passed

### Release sequence

For releases after npm trusted publishing is configured:

1. Run [Release version PR](/.github/workflows/release-version.yml) with a reviewed source branch and readiness channel.
   Supply an expected `major.minor` line when needed, an epoch only for an approved epoch transition, and bootstrap only for a verified absent baseline
2. Review the SDK manifest version, Changesets changelog, consumed fragments and lockfile, then merge the version PR.
   For a PR created by GitHub's automatic token, approve any pending workflow runs in the PR's merge box before relying on its checks
3. Run [Release prepare](/.github/workflows/release-prepare.yml) with the exact reviewed merged ref or commit.
   It checks packages and documentation, snapshots the checked docs, and stages a new immutable candidate without publishing
4. Review the preparation run ID, source commit, version, channel, release notes and candidate SHA256 in the run summary.
   Preserve the named candidate artifact, which has a 90-day workflow retention period
5. Run [Release publish](/.github/workflows/release-publish.yml) with `operation: publish`, the successful preparation run ID and the externally reviewed SHA256.
   It checks out the candidate source commit and publishes the retained npm artifact without rebuilding it. The release App then authenticates the GitHub tag and release. Docs preview follows successful reconciliation

For the first release:

1. Run Release version PR with `channel: canary` and `bootstrap: true`.
   Under the initial-canary conditions, it creates and consumes the generated initial Changeset before opening the version PR
2. Merge the reviewed version PR, then run Release prepare with `bootstrap: true` for that exact merged source
3. Review and preserve the immutable candidate, then publish its retained npm tarball interactively outside GitHub Actions with your npm login and 2FA.
   Do not rebuild the reviewed artifact
4. Configure npm trusted publishing for `release-publish.yml` in the `package` environment, with direct publishing allowed
5. Run Release publish with `operation: reconcile`, the original preparation run ID and the reviewed checksum.
   It verifies npm availability. The release App authenticates the GitHub tag and release only. Docs preview follows successful reconciliation

`release:inspect CANDIDATE_DIRECTORY` checks only local candidate contents.
The status, verify and publish commands additionally require `--checksum REVIEWED_SHA256`.
Use `release:publish CANDIDATE_DIRECTORY --checksum REVIEWED_SHA256` to publish once through the automated path.
Use `release:verify CANDIDATE_DIRECTORY --checksum REVIEWED_SHA256` to require that the npm version exists without publishing.
Use `release:status CANDIDATE_DIRECTORY --checksum REVIEWED_SHA256` to report npm as `published` or `missing` and `complete` as the matching boolean.
Never treat a checksum taken only from an untrusted replacement candidate as external review

## Reconciliation and external setup

The npm publisher is serialized by its publication-job concurrency and local `.release-publish-npm.lock`.
Before removing a stale lock, verify that no publisher is active

Publication first reads npm version metadata and rejects a version that already exists.
It submits the retained tarball once, then reconciles an uncertain provider outcome by polling npm metadata and reading it again after publication appears.
This establishes version availability, not file-content identity

If the provider outcome is uncertain, preserve the same immutable candidate and inspect its npm status before any further action.
Do not rebuild a candidate or attempt publication for a version that metadata already reports as published

The npm channel tags are `canary`, `rc` and `latest` for Stable, and older release lines must not move them backward.
Older maintenance lines use a line-specific staging tag when the channel tag cannot advance.
These staging tags are not additional readiness channels

npm trusted publishing [requires the package to exist first](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites).
For the initial publication, publish the reviewed npm tarball interactively before configuring trusted publishing.
Subsequent npm releases publish through GitHub OIDC, not a token fallback

The protected `package` environment needs no npm token secret.
[Release authentication](/projects/release/authentication.mjs) requires GitHub OIDC, removes inherited registry tokens and supplies an isolated token-free npm configuration.
Missing or incomplete OIDC stops automated publication before npm requests or publication

The workflows use GitHub's automatic `GITHUB_TOKEN` for repository reads, version PRs and artifacts.
Do not add a separate `GH_TOKEN` or `GITHUB_TOKEN` secret.
Check requires no custom secrets and never uses a Fluxer bot token

Allow the version workflow to open pull requests.
GitHub tag and release reconciliation uses the dedicated release App described below, without changing npm OIDC

Tokens, credentials and private payloads must not appear in logs or release notes.
External configuration, actual publication and repository visibility changes are separate authorized operations

Use [documentation maintenance](/docs/DOCUMENTATION.md#preview-setup) for the independently required public Preview hostname, Cloudflare access and `website` environment.
Local tests establish the checked planning, staging and recovery boundaries, not live provider success

### Release App and tag controls

Create the private `Fluxerly Release` GitHub App under `NeonTechSpace`, with Contents write, mandatory Metadata read and no webhooks.
Install it only on `Fluxerly.js`.
In the `package` environment, set the `RELEASE_APP_CLIENT_ID` variable and `RELEASE_APP_PRIVATE_KEY` secret.
Keep the private key out of repository and organization secrets, source, artifacts and logs

Permit only the `main` branch to enter `package` and keep administrator approval bypass disabled.
The environment has no required-reviewer approval step.
Review the candidate's selected source before dispatching publication, because the workflow branch restriction does not constrain its independent source selection

The reconciliation job creates a short-lived, repository-scoped token with Contents write only after npm metadata confirms the candidate version exists.
The token authenticates only the GitHub announcement step, and the pinned token action revokes it when the job finishes.
The npm publisher retains OIDC and does not use the App key

For `v*` tags, use a creation-restriction ruleset whose only bypass actor is the release App.
Use a separate update and deletion ruleset with no bypass actors, including the App.
Verify App creation with an agreed disposable tag before activating restrictions, then check denied non-App creation and denied App update and deletion.
Remove test tags through exceptions scoped only to their exact names, and remove those exceptions after verifying cleanup

These rules constrain the credentials that perform tag operations, not one uniquely identifiable workflow.
Administrators who can edit rules, workflow source or environment access can change the boundary
