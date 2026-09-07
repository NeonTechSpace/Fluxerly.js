# Repository navigation

When locating code or documentation, or deciding where a file belongs, read [the repository guide](/docs/REPOSITORY.md)

Before adding, expanding or reviewing repository Markdown, apply the [documentation placement check](/docs/TECHNOLOGY.md#documentation-placement)

Before implementing or reviewing SDK public API changes, including behavior changes without signature changes, read and apply the [public API documentation completion gate](/docs/TECHNOLOGY.md#public-api-documentation-completion-gate)

# Verification ownership

During authorized project work, identify and run important feasible checks before reporting completion, including relevant live sandbox failure/recovery tests.
Add a focused check when existing tests cannot establish the affected behavior, rather than leaving a testable gap as a follow-up suggestion

Use the designated sandbox under the [live-test instructions](/docs/REPOSITORY.md#opt-in-live-sandbox-check), with target verification, bounded execution and verified test-owned cleanup

When a check cannot run, report the concrete blocker and remaining evidence gap.
This standing rule applies to new chats and does not authorize unrelated systems, publication, VCS changes or recurring unattended work

# Repository Markdown links

Use repository-root-relative paths starting with `/` for local links and images in repository Markdown, including AGENTS.md and embedded HTML.
Include the root-relative document path before heading fragments, even for same-document links.
Keep external URLs and URI schemes unchanged.
This repository rule overrides generic document-relative link guidance and does not change source-code imports
