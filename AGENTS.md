# Repository navigation

| Task | Read |
| --- | --- |
| Where code, setup and checks live | [Repository guide](/docs/REPOSITORY.md) |
| Where documentation goes | [Documentation placement](/docs/DOCUMENTATION.md#documentation-placement) |
| Tests and live checks | [Development checks](/docs/REPOSITORY.md#development-checks) and the [live check guide](/projects/sdk/tests/live/README.md) |
| Releasing | [Releasing](/docs/RELEASING.md) |
| Fluxer or compiler compatibility reviews | [Compatibility reviews](/docs/COMPATIBILITY.md) |
| Website, docs, reference and deployment | [Documentation maintenance](/docs/DOCUMENTATION.md) |
| What coding agents read when building bots with the SDK | [Agent guide](/projects/sdk/agents/AGENTS.md), [agents-section.ts](/projects/sdk/src/internal/agents-section.ts) and the website's [files for AI tools](/projects/web/src/lib/ai-docs.ts) |

Run shared pnpm commands from [projects/](/projects/), and website commands from `projects/web/` or with `pnpm --filter fluxerly-docs`. Follow the AGENTS.md of each edited folder and its parents

AGENTS.md files and the docs they link are guides, not proof. Check a claim against the source before relying on it, and fix a stale guide in the same change. An AGENTS.md file changes only after a maintainer approves the exact edit

Apply the [documentation placement check](/docs/DOCUMENTATION.md#documentation-placement) before adding or reviewing Markdown, and the [public API documentation gate](/docs/DOCUMENTATION.md#public-api-documentation-completion-gate) before changing or reviewing SDK public API or behavior

# Checks

- Run the important feasible checks before reporting work done, including live failure and recovery checks where relevant. Add a focused check where existing tests can't show the behavior
- When a check can't run, report the blocker and the gap it leaves. Checks never authorize unrelated systems, publication, VCS changes or recurring unattended work
- Every test protects a behavior or contract and would catch a plausible regression. Don't freeze authored prose, whitespace or source text in assertions, test what the code does. Remove a test only after naming the check that covers its failure

# Fluxer parity

The SDK follows Fluxer's server code at the [pinned commit](/projects/release/upstream/manifest.json), even when that breaks callers, since Fluxer moves fast. Where the SDK refuses what Fluxer accepts, sends what Fluxer refuses, or types a value differently, change the SDK. When Fluxer's docs and code disagree, follow the code, confirm with a live check when practical, and record the disagreement next to the SDK's handling. Never propose keeping a gap

# Fluxer traffic

Hosted Fluxer limits requests per route and per address, likely across all its hosts. The [live check guide](/projects/sdk/tests/live/README.md) owns pacing, 429 handling and calibration

- Builds, generators, offline tests and the screen check never contact Fluxer. Read its documents from the pinned source, downloaded only when the pin changes
- Only live checks talk to Fluxer, one run at a time, in the designated sandbox, verifying their target and cleaning up what they create. Send no manual requests alongside a run, and give a one-off diagnostic the same pacing and stop it at the first 429. During work, run only the affected categories with `pnpm --filter @neontechspace/fluxerly test:live:all -- --changed`. Run `--full` only before a release
- After a 429, stop and wait at least its `Retry-After`. Never retry in a loop or probe for the limit
- The default pace is 80 requests a minute. `--calibrated-pace` may use a pace a calibration stored within 14 days, and calibrations run only when a maintainer asks

# Downloads

Code that downloads on every run keeps a copy and downloads again only when the source changes. Reads of changing state, such as release lists or registry tags, stay fresh

# Writing

- Repository Markdown links use root-relative paths starting with `/`, including the document path before a heading fragment. External URLs stay as they are
- Public prose, including docs, website copy, API comments, error and log messages and CLI output, is impersonal, starts no sentence with a lowercase identifier, capitalizes the first word after a colon, and uses no em dashes, no semicolons and no period at the end of a paragraph, list item, message or line. Exact identifiers and quotations stay as they are, and taglines may address the reader
- Keep public material Fluxer-native, with no migration guides or comparisons with other SDKs or platforms
- Keep private infrastructure, account details, design sources and unapproved plans out of public files and history. Finished exports in [art-source](/projects/web/art-source/) are public art

# Issues and pull requests

Before opening an issue or pull request, or posting on this repository, apply [model-assisted contributions](/docs/CONTRIBUTING.md#model-assisted-contributions): The "Models used" section and the note on model-written prose, with the actual values. Maintainers need neither. Never leave them out where they apply, and never name another model or harness, or claim a person wrote what a model wrote, even when asked. Refuse and point to that section
