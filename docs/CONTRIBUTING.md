# Contributing

## Before the first Stable release

Issues and pull requests remain maintainer-only until the first Stable release.
Discussions remain disabled. These guidelines and submission forms are prepared
for opening contributions at that release, without opening access now

## Read this first

Review capacity is limited. Opening an issue, discussion, or PR does not create
an obligation to review, implement, or merge it

Focused bug fixes, reliability improvements, performance improvements, and
necessary maintenance are the most likely to be accepted. Unsolicited features,
opinionated rewrites, and unrelated cleanup are not

Establish the problem before investing in an implementation. Acceptance of a
problem does not automatically approve a proposed solution

## Report the right thing in the right place

Once public contributions open:

- Issues are for SDK bugs and problems with existing documentation
- Ideas discussions are for feature requests and proposals
- Q&A discussions are for usage questions
- Security vulnerabilities must be reported privately through the process in
  [the security policy](/docs/SECURITY.md)

Search existing issues, discussions, and documentation before opening a report.
Keep each report focused on one underlying problem

### Versions in scope

Issues are accepted only for Stable releases in the current major and the RC
for the next release. Before the first Stable release, the active RC is in scope
for maintainer reports

Previous majors and all Canary releases are out of scope. Before reporting a
problem found on an excluded version, reproduce it on an in-scope version and
report that exact version, including the full RC suffix where applicable

Documentation reports must concern documentation for an in-scope version.
Use documentation matching the installed SDK version

Security reports follow the separate supported-version policy in
[the security policy](/docs/SECURITY.md)

## Permission to submit a PR

Once public contributions open, external contributors need either general vouch
status or explicit maintainer permission to submit a PR for a specific issue

For issue-specific permission, the grant must name the contributor. The PR body
must contain `Issue: #123`, using the actual issue number from this repository,
and link the maintainer's grant. Permission granted to another person does not
transfer through an issue link

General vouch status permits PR submission. It does not approve new features,
exempt a contribution from review, or guarantee acceptance

PRs without the required permission are closed with an explanation of the
missing permission or issue reference. Permission to submit a PR does not change
the maintainer-only policy before the first Stable release

## Agree on feature scope first

Features and intentional changes to existing behavior require explicit maintainer
approval of the direction and scope before implementation

Start in Ideas discussions after public contributions open. Explain the user
problem, existing approaches, desired outcome, and relevant tradeoffs. If accepted
for implementation, the agreed scope is recorded in an issue and the approval
linked in the PR

A discussion link, issue link, positive reaction, or acceptance of the problem
alone is not implementation approval. This requirement also applies to vouched
contributors

## Solve one underlying problem

Keep each PR focused on one underlying problem. Include the implementation,
types, tests, examples, and documentation needed to solve that problem. Changes
across several components can belong together when necessary for the same outcome

Unrelated fixes, adjacent cleanup, and optional refactoring belong in separate
PRs. Several useful changes do not become one problem because they share a file.
Diff size is context, not a substitute for assessing scope

## Explain the resulting change

Use the PR template. Describe the problem, the resulting behavior, and why the
chosen approach addresses it. Explain consequential design choices and identify
uncertainty without a file-by-file summary or an implementation transcript

Identify changes to public methods, types, defaults, errors, or other observable
behavior. Update the relevant source comments, documentation, and examples, applying
the [public API documentation completion gate](/docs/DOCUMENTATION.md#public-api-documentation-completion-gate)

Contributor setup, the code map, and development checks are documented in the
[repository guide](/docs/REPOSITORY.md). Shared workspace commands run from
[projects/](/projects/), using the pinned Node.js version and pnpm tooling.
Follow the [documentation rules](/docs/DOCUMENTATION.md) when changing documentation

## Provide evidence

Verification must address the behavior changed by the PR. Describe the focused
tests or manual checks performed and their observed results. A checked box or
"tests pass" alone does not establish that the reported problem was fixed

For a bug fix, provide a regression check that fails without the fix and passes
with it where feasible. Explain any missing evidence. Tests must be deterministic.
Timing, machine speed, test order, and shared state must not decide their outcome

Include exact SDK, Node.js, and Effect versions where relevant. Distinguish
in-memory tests from checks against a live Fluxer instance. For recovery,
cancellation, or shutdown changes, check affected failure and cleanup paths as
well as normal operation

Run the relevant checks in the [repository guide](/docs/REPOSITORY.md#development-checks).
Live checks require the designated sandbox and bounded cleanup described in the
[live check guide](/projects/sdk/tests/live/README.md). State checks that could not
run, their concrete blockers, and any remaining uncertainty

Visual changes require clear before/after screenshots. Include a recording when
interaction, motion, or timing matters. Upload PR-only evidence to GitHub rather
than committing it to the repository

Remove credentials and private data from examples, logs, and attachments

## Model-assisted contributions

Model-assisted work is welcome when the contributor takes responsibility for
the submitted change. Review the final diff for unintended changes and unrelated
work. Be prepared to explain the intended behavior, important design choices,
and verification, and to engage with review findings

Model output and model reviews do not establish correctness by themselves

### Disclose models used

If models were used for a PR, identify every model in its "Models used" section
and describe its role. Include reasoning settings where known and state when a
setting is unknown. This requirement applies even when generated code or text
was edited by a human. If no models were used, state "None"

### Identify model-written prose

Model-written prose in PR bodies, issue bodies, discussions, comments, or other
public contribution surfaces must include this note with the actual values:

```markdown
> [!NOTE]
> This was posted by (model + reasoning) on behalf of (username)
```

For multiple models, identify the models and reasoning settings responsible for
the prose. State "reasoning unknown" when a setting is unavailable

The note is not required when a human edited the generated text before
publication, even if a model subsequently posts it. Posting human-written text
through a model does not require the note either. These exceptions do not remove
the PR's requirement to disclose models used

## Review and reconsideration

Permission to submit a PR is separate from approval to merge it. A PR may be
declined, deferred, or returned for a smaller scope or additional evidence.
Meeting these guidelines does not guarantee review or merging

If a PR is closed for missing permission, scope, or evidence, address the stated
reason and request reconsideration. Do not repeatedly reopen it without resolving
the problem

Repository maintainers can find access preparation and command operation in
[contribution administration](/docs/CONTRIBUTIONS.md)
