# Documentation maintenance

This guide covers SDK documentation authoring, local checks, published version channels and Preview delivery. The Astro website combines handwritten guides with a generated public API reference. Public delivery is Preview only. The permanent cinematic site remains deferred until the first stable SDK release

## Where to edit

Apply [documentation placement](/docs/DOCUMENTATION.md#documentation-placement) before adding prose

- Edit caller-visible member behavior in public SDK source comments
- Edit handwritten website guides listed in `projects/web/content/guides/meta.json`, the ordered inventory for unreleased guides. Use short `navTitle` sidebar labels, `title` for headings, with both searchable, and separators for related pages
- Edit website components under `projects/web/src/components/` and styles in `projects/web/src/styles/global.css` for rendering
- Author release fragments through Changesets, which owns the SDK changelog rendered by the website
- Edit the generated error and log codes page through its entries in `projects/sdk/src/internal/code-catalogue.ts`. Logging an uncatalogued code fails the SDK type check, and generation fails when the SDK source creates an error code without an entry or an entry's code no longer exists
- Keep setup, verification and release operations in repository Markdown

Introduce the SDK with a bot that responds to a message. Show client creation, one handler and connection before configuration, error handling and shutdown. Put advanced overview notes in JSDoc `@remarks`, not in place of precise member behavior

Use JavaScript & TypeScript for the default API section, `js-ts` in its generated URLs and `Default` in SDK identifiers.
The testing entry points are titled Testing and Effect testing, with `testing` and `Effect-testing` in their generated URLs.
Published Stable URLs remain tied to their original release. Canary and RC URLs show the newest published snapshot in their respective channels

Lead with the reader's next task and explain unfamiliar concepts before use. Keep conditions beside consequences, and place necessary warnings before optional detail. Group sentences by purpose, with blank lines between Markdown paragraphs and empty comment lines between JSDoc paragraphs. Source wrapping does not end a paragraph. Omit the final period only at the end of a rendered paragraph, while retaining periods between its sentences

Reference generation (`projects/web/scripts/generate.js`) uses TypeDoc with TypeScript 6 to read the declarations emitted by TypeScript 7 for each public entry point listed in `projects/web/scripts/reference-entries.js`. Add a new package entry point there and in `projects/web/tsconfig.reference.json`. Released snapshots keep the entry points they were generated with. This is a tooling exception, not SDK consumer support. Internal, private, protected and external declarations are excluded. The generator creates links and fragment targets. Do not hand-edit generated Markdown, declarations or output under `content/docs/` or `dist/`

Classes, interfaces and enums have their own reference pages. Functions, variables and type aliases are sections of their entry point page.
When source comments add `@category` tags, entry point pages and the reference sidebar group symbols by category, with `Other` for untagged symbols.
The sidebar lists an entry point's categories only when it has more than one, and each category link's accessible name includes its entry point.
Category sections move grouped symbols one heading level deeper, and the page outline follows them to symbol headings.
The API landing page links a task index generated from each client's namespaces and method summaries.
Effect types link to Effect's API reference. Their module mapping is in the generator

Missing member comments and referenced types that are not exported fail generation as source documentation gaps, as other TypeDoc diagnostics do.
Fix gaps in SDK source comments or exports, not in generated output

The overview and API landing prose live in Markdown partials under `projects/web/content/partials/`, with `/docs/{{version}}/` links filled for each served version

### Command blocks and navigation

Use a fenced `command` block with JSON metadata for package installation and executable guide commands.
The command renderer (`projects/web/scripts/command-blocks.js`) owns the supported `install`, `add`, `list` and `run` variants

The generator reads the guide inventory and fills SDK and Effect versions from the selected release and SDK manifest before taking a snapshot.
Local source previews show an unreleased-version notice instead of an installation command for an unavailable package

Each block offers a package-manager selector. The choice is saved in the browser when storage is available and otherwise lasts for the current page session. Default npm commands remain readable without JavaScript

After changing Markdown transforms, run `pnpm --filter fluxerly-docs exec astro build --force` to refresh Astro's content cache before inspecting the result

Each page sends the browser only its version's navigation tree, reduced to what the sidebar renders. The reference contributes its landing page and entry points, not symbol pages. Breadcrumbs are resolved from the complete tree during the build, and channel choices are supplied separately

Search uses one index per served version. Guides keep their full text and their sidebar `navTitle`, which search results show above the page title. Reference symbols contribute names, member, option and parameter names, error tags and first summary sentences.
Results are ordered by match strength in [search options](/projects/web/src/lib/search-options.ts): An exact page title or sidebar label first, then every query word in a guide title or label, an exact member heading, every query word in an identifier title such as `RateLimitError`, and headings before plain text. For a query of several words, such as "edit message", a guide heading containing every word ranks with an exact member heading, and guides come before reference pages of equal strength.
Hub pages, such as the landing page, task index, changelog, glossary, FAQ, examples and error and log codes, rise only by an exact title and follow dedicated pages of equal strength. Effect guides follow other guides of equal strength unless the query names Effect, and a default API symbol takes the place of its Effect twin, including `Default<Name>` command types in place of `Native<Name>`. Results from the testing entry points follow other matches unless their title matches the query exactly.
Index filenames carry a content hash, so they are cached as immutable like the `_astro/` assets.
The [search precision check](/projects/web/tests/search-precision.js) records realistic queries, the pages that answer them and the rank each must keep. Targets name dedicated pages, not hubs that only route to them. Search changes must not make any recorded query rank worse

Each version also serves `llms.txt`, an index of guides and reference pages, and `llms-full.txt`, with every guide and a condensed reference. Guide pages have a Markdown twin at the same path with `.md`, linked beside the page title. These files use the site's noindex headers

Author default API examples in TypeScript. The build derives JavaScript, and the reader's language choice is remembered. Effect examples remain TypeScript-only. The starter uses the selected `bot.js` or `bot.ts` filename and run command, with `"type": "module"` in `package.json`. A guide renders any repository example file with an `{{example:<folder>/<file>}}` marker, such as the small bot example

Keep the IMPORTANT preview notice between each page title and its introduction until the temporary website is replaced

API parameter and property tables are generated by TypeDoc

Reference previews work on every docs page, for classes, interfaces, type aliases, functions, variables and their members. They read only linked public pages from the same documentation version. Keep the link to the full page. Previews open on hover or keyboard focus, and Alt+Down moves into an open preview. Touch readers use one toggle above the reference instead of a button per link. Do not expose internal declarations or combine versions

The build adds previews without authored links. Inline code that is exactly one public name, such as `runBot`, `errors.apiCode` or `client.messages.send`, links to that version's reference ([`reference-links.js`](/projects/web/scripts/reference-links.js)). Pages use the Effect API when their examples import only from it, and the default API otherwise. Headings, existing links and reference signatures stay unlinked, and each page gets at most 60 generated links. A lowercase word, such as `text`, links only in a member chain or as a call of a public function. Code block identifiers that the TypeScript checker resolves to public API in the built SDK declarations, including destructured members such as `reply`, preview on hover when the target exists in that version's reference ([`reference-code.js`](/projects/web/scripts/reference-code.js)). Code tokens keep their text and are not links or tab stops, so keyboard readers reach the same previews through the page's links. Link an unmatched name explicitly when it needs a preview

## Documentation placement

Before adding or expanding documentation, choose its owner:

| Content | Owner |
| --- | --- |
| Member signatures, defaults and caller-visible behavior | Public source comments, preserved in declarations for the website reference |
| User guides, tutorials, examples and design explanations for SDK users | Documentation website |
| Introduction, contributor setup, navigation, testing procedures and release policy | Repository Markdown |
| Instructions for agents consuming the installed package | [Consumer agent guide](/projects/sdk/consumer/AGENTS.md), discovered through the package README |
| Cross-component ownership, invariants and coordination that maintainers need beyond documented public members | Concise repository implementation contracts |

Keep member behavior in source comments and handwritten guides in website source.
Link to the relevant source comments, website pages or tests instead of repeating API reference, defaults, feature inventories or test assertions.
Update repository docs only when the milestone changes a maintainer-facing rule, boundary, navigation or procedure

Before completing a documentation change, inspect each added or expanded passage against this table.
Retain repository prose only when its maintainer purpose is clear and an existing source does not already serve that purpose.
For live checks, the [live check guide](/projects/sdk/tests/live/README.md) retains commands, prerequisites, outside effects and shared recovery instructions, while test implementations own detailed assertions.
During read-only review, report misplaced or duplicated content rather than moving or deleting it

## Public API documentation completion gate

Apply [documentation placement](/docs/DOCUMENTATION.md#documentation-placement) to accompanying prose

For implementation or review of SDK public API changes, complete these steps before reporting completion:

1. Inventory the affected public exports and members in every public entry point, the testing entry points included.
   Cover shared types and behavior changes with unchanged signatures
2. During implementation, write or update their source comments alongside the code.
   Explain applicable inputs, defaults, units, completion, readiness, ownership, cancellation, expected failures, defects and observable side effects.
   Describe caller-relevant behavior rather than restating the member name or type.
   During read-only review, report missing or inaccurate comments as findings rather than editing them
3. Compare those comments with the implementation and behavioral tests.
   Check the default and native execution differences explicitly.
   Include a concise review identifying the affected members, evidence and unresolved documentation gaps in the completion report
4. Run the [aggregate development check](/docs/REPOSITORY.md#development-checks).
   Verify that each affected member's authored comments survive in the emitted and packed declarations.
   Typecheck affected runnable examples against the public package exports, rather than a separately maintained copy
5. Report the documentation review and verification results with the implementation result.
   Unresolved gaps or skipped required checks mean the affected work is not complete

Apply this gate to both development and release reference generation.
Repository prose does not substitute for public source comments

Comment-presence checks, successful compilation and declaration preservation cannot establish documentation accuracy.
Review the described behavior against the code and tests even when automated checks pass

This gate grants no implementation authority during a read-only review, and no website, dependency, publication or VCS authority

## Local checks

Use Node.js from [the shared pin](/projects/.node-version), install the locked workspace, and run from [projects/](/projects/)

Before starting a server, inspect occupied ports and existing processes.
Stop only processes started for the current check

```sh
pnpm install --frozen-lockfile
pnpm docs:dev
```

The `docs:dev` script builds the SDK before reference generation and local Astro development.
The `docs:dev:skip-build` script reuses the existing SDK build, so it leaves `projects/sdk/dist` untouched while other checks use it. Its API reference reflects that build, not later source changes
The local preview follows the source manifest's channel. To inspect another planned channel after building the SDK, run `node scripts/generate.js --preview-channel rc` from `projects/web/`. This changes only the local docs label, not the SDK version or release selection.
For non-interactive validation, run `pnpm check`.
The aggregate check includes the SDK, release tooling tests and website build, typecheck and local tests

The packed-consumer check compiles guide examples against their authored packed entry points, with strict TypeScript checking and `checkJs: false` for JavaScript

For rendered checks, install Chromium with `pnpm --filter fluxerly-docs exec playwright install chromium`.
Run `pnpm --filter fluxerly-docs test:browser` for the development documentation.
Run `pnpm --filter fluxerly-docs test:versions` for isolated published-version fixtures.
After importing release snapshots, run `pnpm --filter fluxerly-docs test:snapshots` to build every retained snapshot and check its served pages. It builds into a temporary directory and restores the local preview content afterward

The browser checks run Wrangler Pages on loopback port 4322 and refuse an occupied port. They check the emitted worker and static pages. Astro development or preview alone does not check HTTP redirects. Fixture versions are test data, not releases

Inspect desktop and mobile reading, keyboard navigation, search, version switching, public reference links and fragments.
The selected reading UI is dark and cozy with 20px body text.
Keep noindex controls, and add no SEO or sitemap to this temporary site.
See [the public API documentation gate](/docs/DOCUMENTATION.md#public-api-documentation-completion-gate) when SDK behavior changes

## Published version channels

The local `/docs/preview/` preview is regenerated from the current SDK build and labeled with its planned version and Unreleased status.
Released docs come from retained snapshots, not the latest declarations relabeled with an old version

Snapshot creation (`projects/web/scripts/snapshot.js`) requires a prepared release version and clean reviewed source checkout.
It records the exact version, source commit and generated Markdown and metadata.
Schema 2 snapshots write documentation links as `/docs/{{version}}/`, filled with each served path. Schema 1 snapshots keep exact-version links, which rolling channels rebase outside code.
Build-time Markdown transforms list the schemas they read in the [schema registry](/projects/web/scripts/transform-schemas.js). A change to generated syntax needs a new schema while retained snapshots stay readable.
Release preparation binds that snapshot to the immutable package candidate.
Publication requires the [registry contract and external setup](/docs/RELEASING.md#registry-publication-contract)

Release import (`projects/web/scripts/fetch-releases.js`) uses authenticated `gh` reads for `NeonTechSpace/Fluxerly.js`.
It selects every Stable release and the newest published Canary and RC before downloading snapshots. Each selected snapshot requires a unique `docs.json` asset, matching SHA256 digest, size, version tag and resolved source commit. A failed newest snapshot stops the build rather than falling back to an older prerelease

Imported archives live under ignored `projects/web/released/`.
An import requires an empty generated archive directory and preserves existing or partial files on failure.
Reconcile partial output explicitly rather than deleting it to hide an error.
Archive imports are not multi-file atomic writes

The public site serves every published Stable version at its exact-version URL, plus the newest published Canary at `/docs/canary/` and the newest published RC at `/docs/rc/`. Each served version has its own guide, reference, changelog and search index. The rolling channel pages prominently identify the exact package version used for their content and installation commands

The selector has one entry per available channel, ordered Stable, RC and Canary, with channel-only labels. Keep Canary and RC available after a Stable release, even if their newest snapshots are older than Stable. The local source preview remains separate from published channels and is excluded from public builds

Release and documentation version parsing share the [release planner](/projects/release/planning.js)

Changing channels keeps the same page when it exists in the destination channel, otherwise it opens that channel's introduction. Navigation, search and documentation links on rolling channel pages use the channel path, without rewriting code examples or the original snapshots

Retain every immutable release `docs.json` asset. Do not automatically delete Stable pages or introduce separate archive hosting. Use deployment file and byte counts, together with build and deployment timing, to decide whether Stable retention needs reconsideration later

Explicitly withdrawn editorial guides are excluded from the generated site, navigation and search through `publishedSnapshotFiles`. Saved release assets stay unchanged and unrelated historical pages remain available. Withdrawn guide and numbered prerelease URLs return 404 directly from the worker, without asking asset storage that may still cache removed files

No channel or version should imply that a prepared version was actually published

### Latest alias and missing pages

The `/docs/latest/` address is an HTTP 302 redirect to the path of the newest imported Stable snapshot, otherwise the RC channel, otherwise the Canary channel. It is not a generated copy.
The redirect keeps the rest of the path and the query. It never falls back to unpublished source. Public builds require at least one imported published snapshot.
The build records the selected path in `content/versions.json` and the emitted worker. Changing it requires a successful documentation build and separately authorized deployment, without querying npm or release metadata on each request

The hosting integration (`projects/web/scripts/hosting.js`) inventories the emitted HTML and produces a self-contained Cloudflare Pages `_worker.js` and `_routes.json` in the selected build directory.
The routing policy (`projects/web/scripts/docs-routing.js`) handles `/`, `/docs` and documentation paths. Both documentation entrances return HTTP 302 to the path `latest` selects, without waiting for page JavaScript or a meta refresh

Stable exact-version and rolling channel pages pass through unchanged. Numbered Canary and RC paths return 404, with no redirects or compatibility routes. Other unknown versions and broken non-channel documentation paths redirect to an existing equivalent page in the path `latest` selects when unambiguous, otherwise to its introduction. Missing pages in an emitted rolling channel redirect to that channel's introduction. An absent channel remains a 404 rather than falling back to Stable.
Malformed encoded paths fall back to the applicable channel introduction or the selected introduction rather than being interpreted as another page, except numbered prerelease paths remain 404.
Queries are preserved, and redirect targets come only from the built page inventory. Browsers retain fragments across redirects when the response supplies none

Fallback applies only to GET and HEAD document requests. Assets, scripts, search JSON, unrelated routes and other methods are not redirected into documentation.
Reference pages under `/docs/<version>/api/` remain documentation, not HTTP API endpoints.
An explicit `404.html` prevents missing resources from becoming a successful single-page-app fallback

Pages advanced mode supplies the built-in `ASSETS` binding for static responses, with invocation limited by the emitted route configuration.
No Astro server adapter, custom binding or new hosting configuration file is required. Upload the complete build directory through the existing Wrangler Pages deployment path, not HTML alone.
See [Pages advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/) and [invocation routes](https://developers.cloudflare.com/pages/functions/routing/#functions-invocation-routes)

Redirect responses are temporary, non-cacheable and noindex. Static responses retain the existing Pages header rules.
Worker availability and the selected account's Functions allowance remain hosting prerequisites. A static-only host cannot supply this routing contract

The external Pages fail-open setting bypasses Functions when the Free-plan allowance is exhausted, degrading HTTP redirects to static behavior.
Fail-closed instead returns an error. Verify the account allowance and runtime setting before promising uninterrupted edge redirects, without changing either as part of local validation.
See [Pages quota behavior](https://developers.cloudflare.com/pages/functions/routing/#fail-open--closed)

## Preview setup

[Docs preview](/.github/workflows/docs-preview.yml) is manually dispatched or called after the gated package publisher.
It always checks out `main`, imports verified released snapshots, builds the SDK declarations and checks the full Preview documentation inventory.
The public build uses `pnpm --filter fluxerly-docs check:public` to exclude local preview pages and validate published documentation. Before upload, it requires a successful main-push [Check workflow](/.github/workflows/ci.yml) for that exact checkout through the [source gate](/projects/web/scripts/checked-source.js), rather than repeating SDK and release-tooling checks.
Documentation work runs while Check can still be in progress. The gate waits up to ten minutes and rejects failed, cancelled, missing or mismatched evidence instead of silently skipping validation.
The newest matching run must pass, including its current attempt. No build artifact or test result from another source commit is reused

Set these values in the `website` environment before separately authorized delivery:

| Setting | Store as | Required value |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Environment variable | Selected account's 32-character lowercase hexadecimal ID |
| `CLOUDFLARE_PAGES_PROJECT` | Environment variable | Selected Pages project name |
| `CLOUDFLARE_PREVIEW_URL` | Environment variable | Public HTTPS origin whose hostname starts with `preview.`, without path, credentials, port, query or fragment |
| `CLOUDFLARE_API_TOKEN` | Environment secret | Token with access to read the selected project and deploy Pages |

Add these under GitHub Settings, Environments, website.
The workflow reads the three non-secret settings through `vars` and the token through `secrets`.
GitHub supplies its repository and Actions read token automatically, including when the publisher calls this workflow.
The local documentation server needs none of these credentials

The `website` environment name does not select the deployment target.
The current workflow still enforces the Preview URL and Pages branch described below

After configuration, open Actions, Docs preview, Run workflow.
The workflow always builds `main`, even when another workflow branch is selected.
Its custom run summary reports check and deployment outcomes, the checked source and configured Preview URL.
Use the deploy step's logs if provider readback fails, because a failed step does not prove that no upload occurred

The exact Preview hostname is not established by the repository's production website link.
Do not infer or invent it

Associate the chosen hostname with the selected Pages project and route it to the `preview` Preview branch.
Keep `main` as the Pages Production branch for the real website, separate from Preview delivery.
For a Git-connected project, disable production deployments and keep its Production branch settings consistent

Configure environment reviewers and deployment rules before supplying credentials.
Do not change repository visibility or deploy Production as part of Preview delivery

## Preview readback and recovery

The deploy script (`projects/web/scripts/preview-deploy.js`) validates project identity, hostname association, branch settings, built noindex headers and the checked source marker before upload.
It uses Wrangler to deploy only the `preview` branch, independently of the GitHub environment named `website`.
It then verifies the provider deployment identity and Preview environment, source commit, the `latest` redirect and the documentation page it selects, noindex response header and served source marker at that deployment's unique Pages URL.
The URL must be HTTPS and belong to the subdomain returned for the verified Pages project. Cloudflare credentials are sent only to the provider API, never to either website

The configured custom domain is checked separately for the content served at the exact deployment URL.
Only a positively identified Cloudflare challenge response, `cf-mitigated: challenge`, changes that check to a warning after exact-deployment verification succeeds.
That outcome does not prove custom-domain content or public access. Other access denials, stale source, missing noindex and redirects remain failures, not accepted deployment evidence.
The workflow summary distinguishes exact-deployment verification from the custom-domain result

Cloudflare Bot Fight Mode can challenge CI requests even when the website works in a browser.
Keep that protection enabled rather than treating a challenge as an upload failure or disabling domain-wide protection.
See [challenge-response detection](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/) and [Pages deployment URLs](https://developers.cloudflare.com/pages/configuration/preview-deployments/)

Readback is bounded and retries transient reads, including provider rate-limit delays

The deployment log reports local file count, total bytes and largest-file bytes, plus separate local preflight, target preflight, Wrangler and readback durations. Local bytes are not transferred bytes, and Wrangler time includes work other than network transfer. Elapsed upload messages appear every 30 seconds, with elapsed readback waits.
Raw Wrangler output and child-process error details remain suppressed to protect credentials.
An upload timeout starts child termination and waits for its close before reconciling the recorded deployment identity

The wrapper does not repeat uploads after an uncertain acknowledgement.
Wrangler has internal provider retries, so this is not exactly-once deployment.
Pages does not provide a conditional upload guard against concurrent project-setting changes

When an upload identity is missing or readback does not converge, inspect that source, branch, deployment and custom-domain routing before another upload.
A local build or mock provider test does not establish public access or an actual deployment
