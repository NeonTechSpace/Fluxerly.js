# Releasing

This guide covers Changesets authoring, immutable candidates and publication from reviewed SDK source. Use [npm registry metadata](https://registry.npmjs.org/@neontechspace%2ffluxerly) for published versions and distribution tags

## Registry publication contract

The canonical SDK manifest remains `private`. `stageRelease` creates a separate public npm package directory and `sdk.tgz` tarball. Never publish from the SDK checkout

The staged npm manifest receives the reviewed release version and retains Effect as an exact required peer.
[The prerequisite check](/projects/release/support.js) requires that exact Effect version to match the SDK development dependency and rejects an optional peer.
It does not authenticate an npm account or grant permission to publish

Candidate schema 1 binds the package inventory, staged manifest and tarball checksums, source commit and checked documentation snapshot checksum into one reviewed candidate. Validation rereads the staged directory and tarball before publication. The candidate checksum identifies that candidate, not uploaded content

Code, comments, declarations, source maps, package metadata and the file inventory participate in the unchanged-content comparison.
Published npm metadata establishes version availability, not uploaded file-content identity

## Available local work

Use the pinned runtime and run commands from [projects/](/projects/). [Repository checks](/docs/REPOSITORY.md#development-checks) cover package and website validation. [Check](/.github/workflows/ci.yml) validates pull requests, pushes to `main` or `codex/**`, and manual runs without publishing

For an SDK change, run `pnpm changeset` and select the public package and compatibility bump. Write caller-relevant notes, not an edited-file list. In later prerelease cycles, classify compatibility against the stable starting version. Breaking only a new preview API still requires migration notes, but does not itself break the stable API. Website, test and release-tooling changes that do not alter the published SDK need no SDK fragment. The wrapper permits fragment authoring and status, not direct versioning or publication

Inspect a source-only proposal with `pnpm release:plan --channel canary`.
Planning does not compare published npm package bytes or prove that a release is publishable.
A version in the source manifest does not establish publication

## Version and content rules

[Epoch Semantic Versioning](/docs/TECHNOLOGY.md#versioning-and-release-stages) defines compatibility and readiness separately.
The planner reads the [SDK source manifest](/projects/sdk/package.json). Canary, RC and Stable are the only channels, and each new prerelease counter starts at zero.
The release wrapper retains the cycle's stable starting version in `projects/.changeset/pre.json` as `releaseBase`, with `null` for the initial `1000.0.0` cycle.
Pending and archived Changesets together determine the target's compatibility impact, while only pending notes enter a new preview's changelog. Stable collects the complete cycle's notes.
Repeated previews keep the target unless increased compatibility impact requires a higher one. A changed target must receive an RC before Stable

The wrapper preserves `releaseBase` through Canary and RC, then removes prerelease state through Changesets on Stable. Missing or invalid state fails closed. For an older checkout lacking the field, restore the reviewed stable starting version before versioning. Use `null` only for the initial `1000.0.0` cycle, not an inferred registry baseline. Source versioning is not atomic. After interruption, reconcile the manifest, prerelease state, archived notes and changelog before retrying

An explicit higher epoch is a multiple of 1000 and requires a major fragment.
There are no permanent readiness branches.
Normal development and release review are main-first, with occasional explicitly selected source branches for another release line

The publication check compares against the previous npm version on the same channel and `major.minor` line. If none exists, the first release on that line requires explicit bootstrap. Do not use bootstrap when an earlier version exists or the registry lookup fails

[Content fingerprints](/projects/release/content.js) ignore package-version fields and changelog bookkeeping, not arbitrary SDK bytes.
If the package content has not changed, version preparation leaves Changesets fragments untouched and creates no version PR.
Candidate preparation also creates no candidate artifact for unchanged content.
On the same channel, changed publishable bytes require a pending Changesets fragment rather than an undocumented version bump.
Readiness promotion must advance SemVer order, and Canary must pass through RC before Stable.
Promotion alone does not bypass the unchanged-content guard

Changesets owns `projects/sdk/CHANGELOG.md` from first version preparation. The website renders it, and GitHub uses its exact version section for release notes. Do not keep another manual changelog or invent an entry before preparation

For the first release, Release version creates the initial-canary Changeset only when the source manifest is `0.0.0`, the selected channel is `canary`, and no pending notes exist.
Its text is `Initial canary release of Fluxerly.js for testing and feedback`.
The action passes that Changeset to Changesets, which consumes it and generates the initial changelog automatically

## Gated manual workflow

Configure the protected environment and npm authentication before an authorized publication.
No push or tag automatically publishes a package

### Choose a workflow

For a manual run, open GitHub Actions and select Run workflow. Choose a branch with reviewed tooling. The `source_ref` input selects SDK source independently of the workflow branch

| Workflow | When to use it | Inputs and result |
| --- | --- | --- |
| [Check](/.github/workflows/ci.yml) | Validate a pull request or selected branch without publishing | No extra inputs, runs workspace checks, browser checks and a two-version Node consumer matrix in parallel |
| [Release version PR](/.github/workflows/release-version.yml) | Prepare a reviewable version change | `source_ref` is a branch and `channel` is canary, rc or stable, producing a version and changelog PR unless content is unchanged |
| [Release prepare](/.github/workflows/release-prepare.yml) | Validate merged release source and retain its exact candidate | `source_ref` is the reviewed merged ref or commit, producing the candidate artifact, preparation run ID and review checksum |
| [Release publish](/.github/workflows/release-publish.yml) | Publish or reconcile the already reviewed candidate | Supply `preparation_run_id`, `candidate_checksum` and `operation`, which is `publish` by default or `reconcile` |
| [Docs preview](/.github/workflows/docs-preview.yml) | Deploy the temporary documentation after Preview setup | No extra inputs, always reads `main`, imports verified release snapshots and deploys only the configured Preview target. The public build serves the newest Canary and RC under rolling channel paths and retains published Stable exact-version pages |

`publish` uses npm OIDC. `reconcile` skips npm publication and verifies version availability for the same immutable candidate after npm has published. The release App authenticates only the GitHub tag and release, and Docs preview follows successful reconciliation

Check also runs automatically on pull requests and pushes to `main` or `codex/**`.
Release version PR and Release prepare accept optional `line` and `bootstrap` inputs.
Only Release version PR accepts `epoch`.
Leave these unset unless the [version and content rules](/docs/RELEASING.md#version-and-content-rules) require them

### Parallel checks and cancellation

Check runs `pnpm check`, browser checks and a packed and npm-installed consumer matrix on the pinned Node version and declared minimum. Browser checks use a separate runner. Both matrix entries run despite one failure, with at most two consumer jobs at once. The final gate requires success from every job. Failed, cancelled, skipped or missing results cannot pass. The `SDK consumers on the declared Node floor` result name remains

New automatic Check runs cancel older runs for the same event and ref. Push and pull-request checks remain separate Git states, and manual checks are independent. Version PRs use `GITHUB_TOKEN`, so approve their checks in the PR merge box before relying on them

Release prepare reuses the newest successful main-push Check for the exact source commit, including its current attempt. A running check is awaited, while failed, cancelled, mismatched or unreadable evidence blocks preparation. Only a verified absence of matching runs falls back to full workspace, browser and declared-minimum-Node consumer checks.
Reusing source checks does not reuse built artifacts. Preparation builds fresh SDK and documentation output, validates the exact-version snapshot and candidate checksums, then installs the candidate's actual tarball through npm and checks both public entry points before retaining it

Release version PR serializes repository-wide because version branch names are shared. Release prepare serializes matching source, line and bootstrap inputs. Release publish uses separate npm publication and GitHub reconciliation queues. Reconciliation follows publication or runs directly for `operation: reconcile`. Docs preview has a separate queue shared by manual and called runs, without holding the npm lock

Release and Preview queues do not cancel running work. [GitHub's extended queue](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) retains up to 100 pending requests per group. Lock arrival, not dispatch, determines order. Inspect cancelled overflow runs and partial external effects before retrying. Do not cancel active publication to advance the queue

### Read the result

Read the run's Summary for the checks performed, their results and the next action. Candidate reports identify source, version, checksum and artifact when available. Publication and Preview reports separate confirmed npm or hosting results from actions that failed or were skipped. Called Docs preview results are reported separately. Unchanged content does not produce a prepared release

The reconciliation summary records the operation, npm availability and completion state. With npm `missing`, the release App creates no tag or release and Docs preview does not run. Registry read failures are not missing versions

Step logs retain diagnostic output. Summaries also run after failures but may be absent if GitHub terminates the runner. If checkout lacks the summary helper, the fallback points to checkout and setup logs without claiming success

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

Publication-job concurrency and `.release-publish-npm.lock` serialize npm publishing. Verify that no publisher is active before removing a stale lock

Publication stops if the npm version already exists. Otherwise it submits the retained tarball once and waits up to 20 minutes for registry availability, reporting progress without repeating the upload. Transient metadata failures use the same deadline. A final metadata read confirms that the version exists, but not that npm serves the reviewed file bytes

GitHub reconciliation retains a newly created release's ID and polls delayed release, asset, tag and latest visibility for one minute per check. Individual provider requests have separate timeouts. Lost create, upload or update responses lead to readback, not repeated writes. Source, release notes and asset-content conflicts still stop reconciliation

If the provider outcome is uncertain, preserve the same immutable candidate and inspect its npm status before any further action.
Do not rebuild a candidate or attempt publication for a version that metadata already reports as published

The npm channel tags are `canary`, `rc` and `latest` for Stable, and older release lines must not move them backward.
Older maintenance lines use a line-specific staging tag when the channel tag cannot advance.
These staging tags are not additional readiness channels

npm trusted publishing [requires the package to exist first](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites).
For the initial publication, publish the reviewed npm tarball interactively before configuring trusted publishing.
Subsequent npm releases publish through GitHub OIDC, not a token fallback

The protected `package` environment needs no npm token secret. [Release authentication](/projects/release/authentication.js) requires GitHub OIDC and strips inherited registry tokens with an isolated token-free npm configuration. Missing or incomplete OIDC stops publication before npm requests

Workflows use automatic `GITHUB_TOKEN` for repository reads, version PRs and artifacts. Do not add a `GH_TOKEN` or `GITHUB_TOKEN` secret. Check needs no custom secret or Fluxer bot token

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
