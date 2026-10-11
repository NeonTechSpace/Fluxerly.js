# Contribution administration

This guide covers repository maintainers preparing contribution access, operating
permission commands, and recovering failed checks. Contributor requirements live
in [Contributing](/docs/CONTRIBUTING.md)

## Preparation status

Public issues and PRs remain maintainer-only until the first Stable release.
Discussions remain disabled. Forms, labels, and workflows are installed as
preparation. The `enabled` field in
[the contribution policy](/.github/contribution-policy.json) is `false`, so the
permission workflow reads trusted configuration and exits without changing
comments, labels, trust files, or PRs

Opening access is a separate release action. When authorized:

1. Enable Discussions and create **Ideas** as an open-ended category with slug
   `ideas`, and **Q&A** as an answerable category with slug `q-a`. The
   [Ideas form](/.github/DISCUSSION_TEMPLATE/ideas.yml) matches its category slug.
   Q&A uses the normal discussion editor
2. Update the preparation notices in the contributor guide, README, and forms,
   and verify issue chooser links and the rendered forms
3. Set `enabled` to `true` through review and verify the workflow before opening
   public issue and PR creation. General vouching requires public PR creation
   because the custom gate checks submissions after creation. Native
   collaborator-only PR access would prevent vouched external users from submitting
4. Open public access only after those checks pass. Retain normal branch review
   and merge requirements

## Permission commands

Post one command as the entire comment. The workflow accepts permission-changing
commands only from numeric GitHub identities in `maintainerIds`. Repository write
access, an association badge, and a permission label do not authorize commands

| Command | Where | Result when automation is enabled |
| --- | --- | --- |
| `/vouch @username` | An issue or PR | Prepares a reviewed PR adding the numeric user ID to the general trust list |
| `/unvouch @username` | An issue or PR | Prepares a reviewed PR removing general trust |
| `/allow-pr @username` | The open issue being worked on | Records permission for that person on that issue, without a commit |
| `/revoke-pr @username` | The open issue | Removes that person's issue grant, without a commit |
| `/recheck` | An open PR | Refreshes eligibility and the model check from its current body, permission records, and model list |

General permission changes take effect only after their trust-list PR merges to
`main`. These commits use the configured maintainer identity. No command bypasses
review or merges its change automatically. The workflow explicitly dispatches
the normal Check on the trust-change branch because token-authored PRs do not
trigger PR workflows. The
[general trust list](/.github/VOUCHED.json) records user IDs and display logins,
so renaming an account does not transfer permission to a different account

Issue-specific permission is stored in one workflow-authored record comment on
the issue. A grant names the contributor, issuer, and source command. The PR body
must include a standalone `Issue: #123` line for that same repository issue.
Full issue URLs and standalone `Fixes`, `Closes`, or `Resolves` references also
work. Quoted text, fenced code, hidden instructions, and cross-repository links
do not count

Closing an issue suspends its grants and causes open PRs to be checked again.
Reopening restores those grants until explicitly revoked. Removing general trust
does not remove separate issue grants. Authors without write access cannot
reopen a PR or issue that the workflow closed. When it is edited and the edited
version passes, the workflow reopens it. This applies only when the
latest closure came from the workflow with its explanation comment, so a
maintainer's own closure is never undone. Other closed PRs are never reopened
automatically. `/recheck` refreshes an open PR

Permission permits submission, not feature scope or merging. Maintainers record
approved feature direction and scope separately, using `scope:approved` as a
visible summary of linked approval

## Labels

[Label definitions](/.github/labels.json) own names, descriptions, and colors.
Most labels are applied during maintainer triage. The permission workflow manages
`vouch:trusted`, `vouch:unvouched`, and `permission:issue` on PRs, and `pr:allowed`
on issues. These labels display permission records and never grant authority

The `help wanted` and `good first issue` labels identify suitable work. Implementation
still requires permission. The `needs-triage`, `needs-info`, and `confirmed` labels
describe review progress. The `out-of-scope`, `not-planned`, and `duplicate` labels
explain disposition.
Release targeting belongs in milestones and exact version fields

The `keep-open` label is a maintainer override. While it is present, neither the
permission check nor the model check closes that PR or issue. It suits
contributions already being worked through with the author. To keep a closed
item open, reopen it and add the label

## Allowed models

The `allowedModels` array in [the contribution policy](/.github/contribution-policy.json)
lists the main models accepted from contributors without general vouch status.
Each entry has an `id`, a display `name`, optional `aliases`, and an optional
`allowedUntil` date in `YYYY-MM-DD` form. A declared model matches the `id`,
the `name`, or an alias. Matching ignores case and treats spaces, underscores,
and hyphens alike

Change the list through a reviewed PR. When replacing a model, set
`allowedUntil` on the old entry instead of removing it at once, so open work
keeps passing until that date. Remove the entry after the date passes

The model check runs only on a PR or issue's own events, such as opening,
editing, pushing, reopening, or marking ready, on `/recheck`, and on a manual
run for one PR. Changing the list re-checks permission on open PRs as before but
never re-checks their models, so a list change cannot close existing work

## Checks and recovery

From the repository root, run:

```sh
node --test .github/tests/*.test.mjs
```

The [aggregate check](/docs/REPOSITORY.md#development-checks) also runs these tests.
CI checks the contribution behavior and workflow syntax. The privileged workflow
uses trusted `main` code and reads PR metadata without executing contributor code

After installation on `main`, inspect current permissions without mutations:

```sh
gh workflow run contributions.yml --repo NeonTechSpace/Fluxerly.js --ref main -f dry_run=true
```

Add `-f pr_number=123` to inspect one PR. While preparation is disabled, the run
verifies configuration and reports the disabled state. After activation, dry
runs report proposed permission labels and closures without applying them

A failed lookup, malformed trust list, malformed model list, or ambiguous issue
record fails the check rather than closing a PR or issue on an unresolved
decision. Workflow events are queued to serialize grant updates. If a run fails
after some writes, inspect the current issue record, labels, and PR before
rerunning the failed job. Retries use
the same trust-change branch and avoid duplicate permission-result comments

Rendered GitHub forms and live command writes must be verified during activation.
Local behavioral checks and a read-only workflow run do not establish those
integrations
