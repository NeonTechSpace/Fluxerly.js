# Repository navigation

| Task | Read |
| --- | --- |
| Locating code, setup, checks or deciding where a file belongs | [Repository guide](/docs/REPOSITORY.md) |
| Deciding where documentation goes | [Documentation placement](/docs/DOCUMENTATION.md#documentation-placement) |
| Testing and live sandbox checks | [Development checks](/docs/REPOSITORY.md#development-checks) and the [live check guide](/projects/sdk/tests/live/README.md) |
| Releasing | [Releasing](/docs/RELEASING.md) |
| Reviewing Fluxer or compiler compatibility on request | [Compatibility reviews](/docs/COMPATIBILITY.md) |
| Website, documentation, reference generation and deployment | [Documentation maintenance](/docs/DOCUMENTATION.md) |
| Changing what coding agents read when they build bots with the SDK | [Agent guide](/projects/sdk/agents/AGENTS.md), the `fluxerly agents` command in [agents-section.ts](/projects/sdk/src/internal/agents-section.ts) and the website's [files for AI tools](/projects/web/src/lib/ai-docs.ts) |

Run pnpm commands from [projects/](/projects/), the workspace root, and follow the AGENTS.md file of each edited folder, such as [projects/AGENTS.md](/projects/AGENTS.md) and [projects/sdk/AGENTS.md](/projects/sdk/AGENTS.md)

AGENTS.md files and the docs they link are guides, not proof. Check a claim against the current source before relying on it, and fix a guide that has gone stale in the same change

Before adding, expanding or reviewing repository Markdown, apply the [documentation placement check](/docs/DOCUMENTATION.md#documentation-placement)

Before implementing or reviewing SDK public API changes, including behavior changes without signature changes, read and apply the [public API documentation completion gate](/docs/DOCUMENTATION.md#public-api-documentation-completion-gate)

# Verification ownership

During authorized project work, identify and run important feasible checks before reporting completion, including relevant live sandbox failure/recovery tests.
Add a focused check when existing tests cannot establish the affected behavior, rather than leaving a testable gap as a follow-up suggestion

Use the designated sandbox under the [live check guide](/projects/sdk/tests/live/README.md), with target verification, bounded execution and verified test-owned cleanup

When a check cannot run, report the concrete blocker and remaining evidence gap.
These checks do not authorize unrelated systems, publication, VCS changes or recurring unattended work

# Fluxer traffic

Fluxer limits requests per route. Hosted Fluxer also has a limit in front of its API that answers with a plain `429 - Ratelimited` body, which Fluxer's open source does not contain. Bursts without pacing met it, paced runs of thousands of requests have not, and a calibration in November 2026 met it at 140 read requests a minute after a clean 130. Its scope is unknown: It likely counts all traffic from one address and may cover docs.fluxer.com and Fluxer's other hosts too, so treat a script that downloads docs as spending the same allowance as the sandbox bot

- Builds, generators, offline tests and the screen check send no request to any Fluxer host. Read Fluxer's documents from its source at the [pinned commit](/projects/release/upstream/manifest.json), and download them only when the pin changes
- Only the checks in the [live check guide](/projects/sdk/tests/live/README.md) talk to Fluxer. Run one live run at a time and keep its request pacing
- While working on a change, run only the live categories that cover it, with `pnpm --filter @neontechspace/fluxerly test:live:all -- --changed` or by name. Never run the full suite during work. Run it, with `--full`, only before a release
- A live run compiles its own private copy of the SDK and holds no build lock. Do not wrap a live run in a build lock
- Send no manual requests, such as curl calls, probes or extra scripts, to Fluxer while a live run is going. A one-off diagnostic request uses the same pacing and stops at the first 429
- After a 429 from Fluxer, stop and wait at least its `Retry-After`. Do not retry in a loop, rerun a suite right away or probe for the limit
- Keep the measured live pace of 80 requests a minute. Only the opt-in [pace calibration](/projects/sdk/tests/live/README.md#pace-calibration) may measure a faster one, and only when a maintainer asks for it

# Downloads

Code that downloads anything on every run, from any host including GitHub, keeps a copy and downloads again only when its source changes. Reads of state that changes, such as a release list, a branch head or registry tags, stay fresh

# Repository Markdown links

Use repository-root-relative paths starting with `/` for local links and images in repository Markdown, including AGENTS.md and embedded HTML.
Include the root-relative document path before heading fragments, even for same-document links.
Keep external URLs and URI schemes unchanged.
This repository rule overrides generic document-relative link guidance and does not change source-code imports

# Public prose

Use impersonal wording in repository docs, website copy, public API comments and displayed example messages. Preserve exact code identifiers, protocol paths and third-party quotations. Taglines, such as the one in the [repository README](/docs/README.md), may address the reader directly

Do not start prose sentences with lowercase identifiers or command flags. Rephrase around them rather than changing their spelling

The same rules cover every text the SDK shows to people: Error messages, hints, log messages, CLI output and generated starter text. In all public prose, capitalize the first word after a colon followed by a space unless it is an exact identifier or quoted value, use no em dashes or semicolons, and end no paragraph, list item, message or line with a period

Keep public material Fluxer-native, without migration guides, mapping tables or comparisons with other SDKs, libraries or platforms

Keep private infrastructure, account details, design sources such as Photoshop files, and unapproved plans out of public files and history. Finished exports in [art-source](/projects/web/art-source/) are public art, not design sources
