# Repository navigation

| Task | Read |
| --- | --- |
| Locating code, setup, checks or deciding where a file belongs | [Repository guide](/docs/REPOSITORY.md) |
| Deciding where documentation goes | [Documentation placement](/docs/DOCUMENTATION.md#documentation-placement) |
| Testing and live sandbox checks | [Development checks](/docs/REPOSITORY.md#development-checks) and the [live check guide](/projects/sdk/tests/live/README.md) |
| Releasing | [Releasing](/docs/RELEASING.md) |
| Website documentation, reference generation and Preview delivery | [Documentation maintenance](/docs/DOCUMENTATION.md) |

Before adding, expanding or reviewing repository Markdown, apply the [documentation placement check](/docs/DOCUMENTATION.md#documentation-placement)

Before implementing or reviewing SDK public API changes, including behavior changes without signature changes, read and apply the [public API documentation completion gate](/docs/DOCUMENTATION.md#public-api-documentation-completion-gate)

# Verification ownership

During authorized project work, identify and run important feasible checks before reporting completion, including relevant live sandbox failure/recovery tests.
Add a focused check when existing tests cannot establish the affected behavior, rather than leaving a testable gap as a follow-up suggestion

Use the designated sandbox under the [live check guide](/projects/sdk/tests/live/README.md), with target verification, bounded execution and verified test-owned cleanup

When a check cannot run, report the concrete blocker and remaining evidence gap.
These checks do not authorize unrelated systems, publication, VCS changes or recurring unattended work

# Repository Markdown links

Use repository-root-relative paths starting with `/` for local links and images in repository Markdown, including AGENTS.md and embedded HTML.
Include the root-relative document path before heading fragments, even for same-document links.
Keep external URLs and URI schemes unchanged.
This repository rule overrides generic document-relative link guidance and does not change source-code imports

# Public prose

Use impersonal wording in repository docs, website copy, public API comments and displayed example messages. Preserve exact code identifiers, protocol paths and third-party quotations

Do not start prose sentences with lowercase identifiers or command flags. Rephrase around them rather than changing their spelling
