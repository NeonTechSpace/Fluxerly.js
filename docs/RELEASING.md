# Releasing

This guide covers cutting an SDK release from reviewed `main` source, recovering from failures and the rules the release tooling enforces.
Use [npm registry metadata](https://registry.npmjs.org/@neontechspace%2ffluxerly) for published versions and distribution tags

## Releases in short

There are two kinds of release: Nightly and Stable.

- **Nightly** happens by itself twice a day when the SDK changed. It's how new work reaches people first, and it can break things
- **Stable** is a nightly that's ready. You choose when, and it ships the same code that nightly already shipped

## Release a Stable version

Stable can only ship what a nightly already shipped. The tooling compares the two, and stops if the code differs or there's no nightly of that version.

1. Check that the newest nightly has what you want to ship. If `main` has changes the nightly lacks, [run a nightly](/docs/RELEASING.md#nightly-builds) first.
   Then run the live release run on a checkout of that source, as [release runs](/projects/sdk/tests/live/README.md#release-runs) describes, and fix any failure before going on.
   It reruns only the categories that have not passed on the same code within 14 days and lists the passes it reuses. Add `--fresh` to rerun everything
2. Run [Release version PR](/.github/workflows/release-version.yml) with `source_ref: main`.
   It opens a `release/version-VERSION` pull request with the new version and changelog, and starts [Check](/.github/workflows/ci.yml) on it. The version number comes from the release notes, so there's nothing to type
3. Review the version and changelog, then merge after Check passes. Merging is the release decision
4. Check runs again on `main`. When its `npm release checks` job passes, it starts [Release prepare](/.github/workflows/release-prepare.yml) for that commit, even while the website checks are still running or have failed.
   After successful preparation, it starts [Release publish](/.github/workflows/release-publish.yml) itself with its own run ID and the candidate SHA256 it computed
5. Follow Release publish. It publishes the retained package, installs it from npm on both supported Node versions, announces the GitHub release and starts the [Website](/.github/workflows/website.yml) deploy on `main` in its own run, which it doesn't wait for, so a website failure never fails the release
6. Confirm the result in the run summaries.
   For a downloaded candidate, `pnpm release:status` reports whether npm serves the reviewed bytes and the current tags

If new SDK code lands on `main` before you merge, don't merge. Close the pull request, let a nightly publish the new code, then run Release version PR again. If it's already merged, revert the new code before the next nightly, because that nightly would otherwise move on to the following version. Then start Release prepare from `main` by hand, because a revert doesn't start it.

Every step can be rerun with the same inputs. Publication reads npm before uploading and never uploads a version twice.
If publication fails or does not start, run the `gh workflow run release-publish.yml` command printed in the preparation summary, or start Release publish from `main` with that preparation run ID and candidate checksum

Keep `.github/workflows/` unchanged on `main` from preparation until Release publish has announced the GitHub release.
GitHub refuses to create a release whose source commit has workflow files that differ from `main` unless the token has the Workflows permission, and the release App does not have it

Record SDK changes with `pnpm changeset` from [projects/](/projects/) while developing them. Select the public package and the size of the change, and write what changes for callers, not a list of edited files

## Nightly builds

Nightly builds need no manual step, and they don't change the repository.
Twice a day, at midnight and midday Berlin time, [Release prepare](/.github/workflows/release-prepare.yml) builds `main` as the next nightly version and starts [Release publish](/.github/workflows/release-publish.yml) itself, without a checksum review.
Publication then runs the same checks as any release and announces a GitHub prerelease that carries the docs snapshot

A run whose SDK content matches the previous nightly publishes nothing.
It also publishes nothing when the content matches the Stable it follows and no nightly on that line was published after it.
Pending Changesets notes appear as unreleased changes in the nightly's release notes and docs changelog, and they stay pending for the next Stable.
To publish a nightly sooner, dispatch Release prepare from `main` with `nightly` selected. A nightly always builds the commit the workflow runs from and ignores `source_ref`

A nightly version is `CORE-nightly.YYYYMMDD.N`, such as `1000.0.0-nightly.20261019.16`.
The `YYYYMMDD` part is the UTC date of the Release prepare run's preparation step and `N` is that run's number.
The date comes first so builds sort by day, and the run number then keeps them from ever repeating.
Overlapping nightly runs get different versions, because each run number is different.
Nightly versions published before this format use `CORE-nightly.N`. They stay valid and sort below every dated nightly of the same core.
A nightly run is superseded when the newest nightly on its line, published after its preparation, has the same content. When a higher nightly on its line already exists, any nightly published after its preparation with the same content supersedes it, and the newest matching one is reported. The run's Release publish step succeeds without publishing, prints the superseding version and skips the registry install, announcement and website jobs. This covers overlapping runs on one commit, such as the scheduled run and a manual dispatch. The fingerprint reads share a one-minute budget that is checked between reads, and each read can take longer.
When no such nightly matches and a later one exists, the run fails with the newer version error. When only earlier ones exist, the run publishes. A candidate whose own version is already on npm is confirmed instead.
When a pending major or minor note is removed, the next nightly's version can drop below the newest nightly. It then publishes under a staging tag such as `nightly-1000-1`, while the `nightly` tag and `/docs/nightly/` keep the higher build until a later nightly passes it. The [dist-tag runbook](/docs/RELEASING.md#npm-distribution-tags) can point `nightly` at the newer build

## When a step fails

| Message | Meaning | Action |
| --- | --- | --- |
| `npm publication is unconfirmed` | The upload outcome is unknown | Rerun Release publish with the same inputs. It reads npm first |
| `npm serves different bytes for VERSION than the reviewed candidate` | npm already has this version with other content | Never republish. Inspect the registry version and release a new version through Changesets |
| `npm serves VERSION, but the TAG tag does not point to it` | The bytes are published, the distribution tag is not | Correct the tag with the [dist-tag runbook](/docs/RELEASING.md#npm-distribution-tags), then rerun Release publish |
| `npm could not install ... from the registry` | A registry install check failed after publication | Inspect the install log. The GitHub release stays unannounced until a rerun passes |
| `Published baseline changed since review` | Another version on the same channel and line was published after preparation. A nightly still publishes when that version is an earlier nightly with different content | Prepare a new candidate from current `main` |
| `Nightly content matches VERSION` | A nightly on the same line with the same content was published after preparation, at a lower or higher version. This is a successful no-op, not a failure, and the run's install, announcement and docs jobs are skipped | None. The next nightly publishes newer source |
| `Nightly fingerprint reads on line LINE ... exceeded 60 seconds` | Reading the content of the nightly builds published after preparation took longer than its one-minute budget | Rerun Release publish with the same candidate, or prepare a new nightly |
| `A newer version is already published` | A higher version with different content exists on the same channel and line, so this candidate is out of date | For a nightly, nothing is needed because the newer nightly already carries later source. Otherwise prepare a new candidate from current `main` |
| `Candidate source is not reachable from main` | The candidate was prepared from unmerged source | Merge the source, then prepare from `main` |
| `Candidate does not match the externally reviewed checksum` | The checksum input differs from the candidate | Copy the checksum from the preparation summary |
| `Preparation workflow commit is not reachable from main` | Release prepare ran from a branch | Run Release prepare from `main` |
| `Preparation is not a successful manual or scheduled run of this repository's release-prepare workflow` | The run ID is wrong, or the run failed or was still running after 5 minutes | Use the ID of a successful Release prepare run |
| `GitHub rejected the OPERATION with HTTP 4xx` | GitHub refused the request, so nothing changed. A 403 on release creation can also mean workflow files changed on `main` after preparation | Fix the cause, such as App permissions or tag rules, then rerun Release publish. For workflow changes, revert them on `main`, rerun Release publish, then push them again |
| `GitHub release creation is unconfirmed`, `asset deletion is unconfirmed` or `asset contents are unconfirmed` | A network or server failure left the outcome uncertain | Rerun Release publish. Reconciliation reads back after uncertain writes and replaces incomplete expected assets |
| `No nightly of VERSION is published` | No nightly of this version exists yet, so [run a nightly](/docs/RELEASING.md#nightly-builds) and rerun. If nothing changed since the last Stable, the nightly skips too, because there's nothing to release, so stop there | See the meaning |
| `Stable content differs from VERSION` | The code changed after the newest nightly of this version | [Run a nightly](/docs/RELEASING.md#nightly-builds), then run Release version PR again. If the version PR is already merged, see [Release a Stable version](/docs/RELEASING.md#release-a-stable-version) |
| `A public build needs at least one published version` | Website ran before any nightly with a current docs snapshot was published | Wait for the next nightly, or [run one](/docs/RELEASING.md#nightly-builds). It deploys the site itself |
| `The source holds a nightly target, not a release` | Release prepare was started before the Stable version PR was merged | Run Release version PR, merge it, then prepare |
| `No pending Changesets fragments or readiness promotion` or `Publishable SDK bytes changed` | Nothing describes this release | Add a release note |
| `The source branch moved after version preparation` | New commits arrived during Release version PR | Rerun Release version PR |
| `Check run N did not pass its JOB job`, `Check run N has no completed JOB job` or `The exact-source Check gate timed out` | Release prepare, which reads `npm release checks`, or Website, which reads `check`, found no passing certificate job in the Check run for the source. A run from before the certificate existed has none | Fix Check, or re-run all jobs of the named run when its latest attempt lacks the job, then rerun the blocked workflow. A source from before the certificates needs a reviewed descendant |
| `GitHub OIDC configuration is incomplete, refusing token fallback` | The publisher has no OIDC token | Confirm `id-token: write`, the `package` environment and npm trusted publishing |

Unchanged publishable content on a nightly is not a failure. Release prepare retains no candidate in that case

## Reference

### Dependency update notes

After Check passes for its current head, the [dependency release-note workflow](/.github/workflows/dependabot-changeset.yml) adds a patch Changeset to a same-repository Dependabot `sdk-runtime` pull request before merge, covering exact stable patch and minor upgrades of `ws` and `neverthrow`.
Development-only updates, existing release notes, mixed source changes, added or removed dependencies, major upgrades, zero-major minor upgrades, ranges and prereleases remain manual

Only reviewed default-branch code runs with write access. The completed Check is verified through the GitHub API, without consuming its artifacts or outputs. The dependency branch supplies manifest and file metadata through the API, with no checkout, dependency installation or execution.
The workflow adds only the release note through an atomic expected-head commit, refusing concurrent branch commits or rewinds, and dispatches Check for the resulting head. Reruns preserve edited or removed notes and do not repeat an existing Check dispatch, including failed runs.
A rerun can resume an interrupted Check dispatch only when the current head is the automatic note-only child of the checked commit and its note still matches the generated content

The resulting PR still requires review, passing checks and any workflow approval GitHub requests for automation-created updates.
For a routine runtime update, wait for the release-note workflow and verify its Changeset before approving or merging. A failed or missing release-note workflow leaves the note as a manual task.
The workflow does not version or publish the SDK

### Registry publication contract

The canonical SDK manifest remains `private`. The `packages:prepare` package script creates a separate public npm package directory and `sdk.tgz` tarball. Never publish from the SDK checkout

[Package preparation](/projects/sdk/scripts/packages.js) copies compiled JavaScript, declarations, maps, sources, license and consumer guidance into a new directory.
It creates the public npm package directory and verifies the matching `sdk.tgz` inventory

The staged npm manifest receives the reviewed release version and retains Effect as a required peer range.
[The prerequisite check](/projects/release/support.js) requires a caret range of a stable version and an exact stable development dependency in the same major, at or above the range's lowest version, and rejects an exact, prerelease or optional peer.
Versioning and preparation commands enforce it, and the release tooling tests run it in `pnpm check`. Publication, verification and status act on a prepared candidate, whose source preparation already checked, so they skip it

Candidate schema 1 binds the package inventory, staged manifest and tarball checksums, source commit and checked documentation snapshot checksum into one reviewed candidate.
Validation rereads the staged directory and tarball before publication.
Publication, verification, status and the GitHub announcement download the tarball npm serves, check it against the registry's SHA-512 integrity and compare its SHA-256 with the candidate's `sdk.tgz`

### Version and content rules

[Epoch Semantic Versioning](/docs/TECHNOLOGY.md#versioning-and-release-stages) sets the numbers. The release notes on `main` decide the next version:

| Notes since the last Stable | Next version after `1000.0.0` |
| --- | --- |
| Only patch notes | `1000.0.1` |
| A minor note | `1000.1.0` |
| A major note | `1001.0.0` |

Nightlies carry that next number, such as `1000.1.0-nightly.20261101.5`, and Stable then uses it without the suffix. Nightly versions exist only in their packages and are never committed. Only a Stable release changes the version stored in the repository.

A new epoch is a deliberate choice. Run Release version PR with `epoch`, such as `2000`, with a major release note. It stores a target like `2000.0.0-nightly.0` on `main`, and nightlies then build toward it. A target never drops, even if notes are removed later.

Between Stables, the stored version is the last Stable and `projects/.changeset/` holds the notes for the next one. A new epoch target also uses `projects/.changeset/pre/` and `projects/.changeset/pre.json`, which keeps the last Stable as `releaseBase`. Before the Stable version PR, edit or delete notes that later changes replaced, so the changelog never announces something the same release removes.

Also check the notes against the release's whole diff since the last Stable, because these changes are easy to miss:

- A required member added to an interface that callers implement or fake, such as `Threads` or `OAuthClient`, has a breaking note
- A change to what `errors.isRetryable` returns for a failure has a breaking note
- A change to the files or commands that `fluxerly init` writes has a note

Source versioning is not atomic. After an interruption, reconcile the manifest, release state, notes and changelog before retrying. Missing or invalid state fails closed

There are no permanent release branches. Occasional other release lines use an explicitly selected source branch

[Content fingerprints](/projects/release/content.js) compare the code two packages ship. They ignore the version fields and changelog bookkeeping, nothing else

Changesets owns `projects/sdk/CHANGELOG.md`. The website renders it, and GitHub uses its exact version section for Stable release notes. Nightly release notes list the pending notes instead.
Website, test and release-tooling changes that do not alter the published SDK need no fragment

### Stable and nightly

Any Stable, small or big, comes from a nightly. The newest published nightly of that version is its checkpoint: The two must ship the same code, or the release stops. You decide when a nightly is ready, and there is no waiting period.

Nightlies never wait for anything. A nightly must sort above every published nightly of its version. If a higher one publishes first, the lower run succeeds without publishing when a newer nightly has the same code, and otherwise fails with the newer version error. A nightly publishes under the `nightly` tag and never moves `latest`.

Each nightly compares against the previous nightly on the same `major.minor` line, and the first one on a line has nothing to compare against. A failed registry lookup, including a missing package, always stops the release.

### Workflows

| Workflow | Trigger | Inputs and result |
| --- | --- | --- |
| [Check](/.github/workflows/ci.yml) | Pull requests, pushes to `main`, manual and version-branch dispatches | Runs SDK, release tooling, website and contribution, workflow lint, browser and two-version consumer jobs in parallel. The browser job tests the parts and pages the changed files reach, compared with a pull request's base or the commit a push started from, and Screens tests every screen after pushes to `main`. The `npm release checks` job certifies the SDK, release tooling and consumer jobs alone. The `check` job requires that certificate and the website and contribution, workflow lint and browser jobs, reuses an earlier passing run for identical content, or for a [version-only change](/docs/RELEASING.md#version-only-changes) requires only the certificate and the website and contribution job |
| [Release version PR](/.github/workflows/release-version.yml) | Manual | `source_ref` and optional `line`. Opens the Stable version pull request, or with `epoch`, a pull request that sets a new epoch as the nightly target |
| [Release prepare](/.github/workflows/release-prepare.yml) | Twice a day for a nightly, dispatched by Check after a version change on `main` once its `npm release checks` passed, or manual | `source_ref`, optional `line` and `nightly`. Retains the candidate artifact for 90 days. Starts Release publish for any retained candidate and prints the command for recovery |
| [Release publish](/.github/workflows/release-publish.yml) | Started by a successful Release prepare, or manual for recovery | `preparation_run_id` and `candidate_checksum`. Publishes, checks registry installs, announces, then starts Website on `main` without waiting for it |
| [Website](/.github/workflows/website.yml) | Started on `main` by Release publish after the announcement, or manual | Always builds `main` from the published versions' snapshots and deploys it to `https://fluxerly.neontechspace.com` |
| [Screens](/.github/workflows/screens.yml) | Pushes to `main`, including merged pull requests, that change the website, the SDK source, examples, manifest or changelog the docs build from, Fluxer's pinned files or the dependencies, or manual | No inputs. Builds the site from that commit and runs the full screen check, `test:browser` on every screen, except after a [version-only](/docs/RELEASING.md#version-only-changes) push. Website doesn't wait for it |
| [Version PR closed](/.github/workflows/version-pr-closed.yml) | A merged or closed `release/version-*` pull request from this repository | No inputs. Cancels the Check runs still going for that version branch |
| [Effect drift](/.github/workflows/effect-drift.yml) | Daily, or manual | No inputs. Checks the SDK with the newest Effect release in its peer range and fails when the SDK breaks with it. It does not publish |
| [Upstream drift](/.github/workflows/upstream-drift.yml) | Monday, Wednesday and Friday, or manual | No inputs. Posts Fluxer's document and source changes as the GitHub Actions bot, in its open "Fluxer upstream changes to review" issue or in a new one that explains the review, and goes red only when the check itself breaks. It does not publish |

Only Release publish writes to npm. A merged Stable version PR starts the checked preparation and publication flow, and a tag never starts publication.
Release publish checks out its own workflow commit, so its tooling never comes from the candidate source.
The candidate commit is only the tag target and must be reachable from `main`

Release version PR builds the version change in a read-only job, then a separate job opens the pull request.
Pull request events for pull requests created or updated with `GITHUB_TOKEN` are not guaranteed, so that job also dispatches Check on the version branch

Check reports its result in two certificate jobs.
The `npm release checks` job passes only when the SDK checks, the release tooling checks and the SDK consumers on both Node versions passed. The website and contribution checks, workflow lint, the browser job and the release trigger feed nothing into it.
The `check` job is the required status. It requires that certificate and the website and contribution, workflow lint and browser jobs

Identical content needs each certificate once. Every Check run starts two lookup jobs, one for `check` and one for `npm release checks`, and each compares the checked-out git tree with other push and dispatched Check runs in this repository.
A lookup reads only its own certificate job, from the latest attempt of each matching run, so a run counts as soon as that job has passed, while the rest of the run is still going or has failed. The npm lookup never waits for website jobs. A run from before a certificate existed has none and never counts.
The newest conclusive certificate by completion time decides, regardless of its run ID, and a failed certificate blocks an older pass. When it passed, the jobs behind it are skipped and the certificate passes with a summary that links that run.
An unfinished certificate is awaited for up to 40 minutes only when its run started before the current attempt, so matching runs never wait for each other. A failed or uncertain lookup runs the checks behind that certificate.
A reuse counts only from a lookup job that succeeded and returned a numeric run, its attempt and that run's URL, so outputs left behind by a failed lookup never skip a check.
Pull request runs never serve as evidence, because they check a merge commit rather than the recorded branch head.
Any run that reuses a passing certificate, including a manual one, tests nothing new. Every screen is tested only by Screens, after each push to `main` that changes what the website builds from

#### Version-only changes

A version pull request changes only what Release version PR writes, so Check skips most of its jobs for it.
When a run reuses no earlier result, each lookup job compares the commit with its first parent, which is the pull request's base for a pull request run and the previous `main` commit for a squash-merged push.
The change is version-only when it changes only these, and anything else, including any other line of the SDK manifest, runs the full Check:

- The top-level `version` line of `projects/sdk/package.json`, to a higher version
- A new section for that version in `projects/sdk/CHANGELOG.md`, with every other line unchanged
- Deleted Changesets notes in `projects/.changeset/` and `projects/.changeset/pre/`, notes moved unchanged into `projects/.changeset/pre/`, and `projects/.changeset/pre.json`

A version-only change also needs a passing certificate for the parent commit's content, found and awaited as for identical content.
Each lookup needs the parent's own certificate, `npm release checks` for the npm lookup and `check` for the full one, so neither stands in for the other. Every such pass therefore traces back to actual checks of everything but the version files.
The run then runs the release tooling job and the website and contribution job, because the website builds its changelog page and search from the new notes. The release tooling job also checks that the version, its changelog section and the Changesets state agree, and the changelog's formatting and em dashes.
The `npm release checks` job passes only when the release tooling job passed and the SDK and consumer jobs were skipped for the version-only change. The `check` job passes only when that certificate and the website and contribution job passed and the workflow lint and browser jobs were skipped. The `main` push run after merging passes the same way, and Release prepare reuses its certificate like any passing main-push Check. Release prepare still refuses a Stable whose package content differs from the newest nightly.
Screens skips its screen check for a push to `main` whose change from its first parent is version-only

Check runs for one version branch of this repository share a concurrency group, so a newer run cancels an older one. Merging or closing the version pull request starts Version PR closed, which joins that group and cancels the runs still going

Release prepare reuses the `npm release checks` job of the newest main-push Check run for the exact source, waiting while that job runs. The rest of that run may still be going, or may have failed in the website and contribution checks, workflow lint, the browser job or the release trigger, because a package reads none of them. A reuse of that certificate from an earlier identical run counts as successful.
A run that finished without the certificate or with it failed stops preparation. Release prepare runs the helper of the source it checks out, so a source from before the certificates, whose helper does not know the scope option and whose Check has no `npm release checks` job, is rejected, and a rerun of its old Check cannot add the job. Prepare a reviewed descendant that contains the certificates. If a latest attempt lacks the job, re-run all jobs of that run so the attempt holds it. Only a verified absence of any main-push Check run for the source falls back to the SDK checks, the release tooling checks, the workspace script lint and the declared-minimum-Node checks. The full screen check stays with Screens and the browser checks with Check.
Preparation always builds fresh output, snapshots the documentation and installs the candidate's actual tarball before retaining it

Check on `main` dispatches Release prepare when its own `npm release checks` pass, whatever the website checks report. A newer push cancels an older Check, so dispatch Release prepare manually if a version change was superseded.
Website still requires the `check` job of the same run before it deploys, so a source whose website or workflow lint checks failed is published to npm but not deployed

Release prepare starts Release publish from its last job for both Stable and nightly candidates, so Release publish waits up to 5 minutes for the preparation run to finish before trusting it

### Publication

Publication first reads npm. An existing version with the reviewed bytes succeeds without uploading, and one with other bytes fails.
Otherwise it verifies the published baseline, submits the tarball once with npm OIDC and polls for up to 20 minutes until npm serves the reviewed bytes and the expected distribution tag points to the version.
Transient registry failures during polling do not trigger another upload

Two registry install jobs then install the exact version from npm on the development Node version and the declared minimum, Node.js 24.15.0, and import every entry point the installed package exports.
Only after both pass does the release App create a short-lived, repository-scoped token for the GitHub announcement

GitHub reconciliation polls delayed release, asset, tag and latest visibility for one minute per check.
HTTP 4xx responses are definite rejections and stop reconciliation. Network failures and 5xx responses are uncertain and lead to readback, never a repeated write.
A rerun deletes an incomplete expected asset, confirms its absence and uploads the reviewed bytes. Uploaded assets are never replaced.
Source, release notes and asset-content conflicts stop reconciliation

Provider output is logged with token-like values redacted

### npm distribution tags

The tags are `nightly` and `latest`, which is Stable.
Recovery accepts a newer channel-tag version on the same `major.minor` line only when npm still serves the candidate's reviewed bytes. It never moves the channel tag backward.
Older release lines publish under a line-specific staging tag, such as `nightly-1000-0`, and still require that tag for recovery

A Stable moves `latest` when it's the newest version, and nightlies never move it

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
| `pnpm release:plan --channel CHANNEL` | Show the source-only version proposal without comparing registry bytes. A nightly plan also reads the registry version list and requires `--date YYYYMMDD` and `--number RUN`, with no default, so a plan never silently uses another day |
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

Use [documentation maintenance](/docs/DOCUMENTATION.md#deployment) for Cloudflare access and the `website` environment.
Local tests establish the checked planning, staging and recovery boundaries, not live provider success
