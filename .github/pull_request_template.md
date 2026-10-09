<!--
Issues and PRs remain maintainer-only until the first Stable release
This template prepares the contribution process without opening public access
Contributor policy: /docs/CONTRIBUTING.md

Model-written prose that has not been edited by a human must include this note
outside this comment, replacing the placeholders with actual values:

> [!NOTE]
> This was posted by (model + reasoning) on behalf of (username)

Human-edited text and human-written text do not require the note, even when a
model posts them. Model use must still be disclosed in "Models used"
-->

## Problem

<!--
Describe the concrete problem and its practical impact
For a bug, explain the trigger and expected versus actual behavior
For an approved feature, describe the intended user outcome
-->

## Change

<!--
Explain the resulting behavior and why this approach addresses the problem
Describe important design choices without narrating every changed file
Explain why changes across components belong to the same underlying problem
-->

## Related issue and permission

<!--
Replace the issue number below with the actual issue number from this repository
Contributors without general vouch status must also link the maintainer's grant
for the PR author to work on that specific issue

Features and intentional behavior changes require a link to explicit maintainer
approval of the direction and scope, including for vouched contributors
A linked issue alone does not establish permission or feature approval

Maintainer PRs without an issue may remove the placeholder
-->

Issue: #

## Verification

<!--
Describe the checks actually performed and their observed results
Include relevant test commands, manual reproduction, or measurements
For a bug fix, identify a regression check that fails without the fix and passes
with it, or explain why that evidence is unavailable

Include exact SDK, Node.js, and Effect versions where relevant
Distinguish in-memory tests from checks against a live Fluxer instance
For recovery, cancellation, or shutdown changes, describe the affected failure
and cleanup paths checked

State checks that could not run, their blockers, and remaining uncertainty
-->

## API and documentation impact

<!--
Describe changes to public methods, types, defaults, errors, or observable behavior
Identify breaking changes and the affected caller workflow
Link updated source comments, documentation, and examples where needed
Public API changes must satisfy /docs/DOCUMENTATION.md#public-api-documentation-completion-gate
Remove this section if there is no API or documentation impact
-->

## Screenshots or recordings

<!--
Optional for changes without a visual effect
For visual changes, include clear before/after screenshots
Use a short recording when interaction, motion, or timing matters
Upload evidence here rather than committing PR-only assets
Remove credentials and private data before uploading
Remove this section if it does not apply
-->

## Review notes

<!--
Identify uncertainty, relevant tradeoffs, or parts needing particular review
Include alternatives where they explain a consequential design choice
Remove this section if there is nothing additional to flag
-->

## Models used

<!--
Identify every model used for the contribution, its role, and reasoning setting
where known. State when a reasoning setting is unknown
This includes implementation, tests, review, and prose, even if edited by a human
If no models were used, state "None"
-->

## Contributor confirmation

<!--
Responsibility stays with the contributor regardless of the tools used
Be prepared to explain the intended behavior, important design choices, and
verification, and engage with review findings
-->

- [ ] The final diff has been reviewed for unintended changes and unrelated work
- [ ] Verification results reflect checks actually performed, with limits stated
- [ ] Code, logs, and attachments have been checked for credentials and private data
