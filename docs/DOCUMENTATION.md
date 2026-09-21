# Documentation maintenance

This guide is for maintainers editing, checking and delivering SDK documentation.
The website builds locally with Astro, React and Fumadocs.
It contains handwritten guides and a generated public API reference

Temporary public delivery is Preview only.
The permanent cinematic site remains deferred until the first stable SDK release

## Edit the owner

Apply [documentation placement](/docs/TECHNOLOGY.md#documentation-placement) before adding prose

- Edit caller-visible member behavior in public SDK source comments
- Edit handwritten website guides in the ordered source inventory at `projects/web/content/guides/meta.json`. Every listed Markdown guide is generated for the unreleased documentation version
- Use short `navTitle` frontmatter for sidebar labels and `title` for article headings and search. Group related pages with Fumadocs separators in the navigation inventory
- Edit website components (`projects/web/src/components/`) and styles (`projects/web/src/styles/global.css`) for rendering
- Author release fragments through Changesets, which owns the SDK changelog rendered by the website
- Keep setup, verification and release operations in repository Markdown

Introduce the SDK with a running bot that responds to a message.
Keep the first example to client creation, one message handler and connection.
Put configuration patterns, error-handling detail and graceful shutdown after the reader's first working result.
Put advanced overview notes in JSDoc `@remarks`, rendered as expandable usage details, while preserving precise behavior on individual API members

Use JavaScript & TypeScript for the default API section, `js-ts` in its generated URLs and `Default` in SDK identifiers.
Published snapshot URLs remain tied to their original release

Group related sentences into paragraphs that develop one idea, explanation or instruction. Start a new paragraph when its purpose changes, not whenever a sentence ends. Keep genuine steps, warnings and deliberate emphasis distinct, without imposing a sentence-count rule

Reduce avoidable cognitive load by leading with the reader's next task, explaining unfamiliar concepts before using them, and keeping conditions beside their consequences. Put optional detail after the main path without hiding necessary warnings. Check for both fragmented explanations and dense paragraphs that switch topics

Choose that reading flow before applying punctuation. Omit the final period only at the end of a rendered paragraph, including a visually standalone sentence. Keep periods between sentences sharing that paragraph, even when their source lines differ

Use a blank line between Markdown paragraphs and an empty comment line between JSDoc paragraphs. Source wrapping and hard line breaks do not end a paragraph. The prose renderer (`projects/web/scripts/prose.js`) preserves standard Markdown boundaries, including those inside lists, quotes and generated API descriptions, rather than repairing missing source boundaries

Technical vocabulary, numeric values and uppercase code constants receive consistent emphasis in prose, while code and existing links keep their own styling

The signature highlighter (`projects/web/scripts/signature-colors.js`) uses TypeScript syntax colours for linked signatures, return types and inline code without replacing their links or changing copied text

Reference generation (`projects/web/scripts/generate.js`) reads TypeScript 7-emitted `dist/index.d.ts` and `dist/effect.d.ts`.
TypeDoc and its Markdown plugins run with TypeScript 6 as a documentation-tooling exception, not SDK consumer support.
Internal, private, protected and external declarations are excluded.
The reference theme and route integration own generated links and fragment targets.
Do not hand-edit generated Markdown, declarations or output under `content/docs/` or `dist/`

### Command blocks and navigation

Use a fenced `command` block with JSON metadata for package installation and executable guide commands.
The command renderer (`projects/web/scripts/command-blocks.js`) owns the supported `install`, `add`, `list` and `run` variants

The generator reads the guide inventory and fills SDK and Effect versions from the selected release and SDK manifest before taking a snapshot.
Unpublished Canary installation uses an explicit `VERSION` placeholder, never a claimed registry release

Each block offers registry and package-manager selectors.
The browser enhancement (`projects/web/src/components/command-preferences.ts`) synchronizes them across blocks and Astro navigation.
It stores only those two choices in browser-local storage, until changed or site data is cleared.
If storage is unavailable, choices last for the current page session.
Without JavaScript, the default npm commands remain readable

After changing Markdown transforms, run `pnpm --filter fluxerly-docs exec astro build --force` to refresh Astro's content cache before inspecting the result

The docs layout (`projects/web/src/components/Docs.tsx`) renders a compact API sidebar while retaining the complete reference tree for search, breadcrumbs and exact-version navigation.
Do not remove generated symbol pages to reduce sidebar size

Default API examples offer remembered JavaScript and TypeScript choices.
The example renderer (`projects/web/scripts/example-blocks.js`) keeps authored TypeScript and derives JavaScript at build time.
Effect-native examples remain TypeScript-only, regardless of the saved preference.
The starter's filename and run command follow its selected language, using `bot.js` or `bot.ts` with `"type": "module"` in `package.json`

Keep the IMPORTANT preview notice between each page title and its introduction until the temporary website is replaced

API parameter and property tables are generated by TypeDoc

The type-preview enhancement (`projects/web/src/components/reference-previews.ts`) reads only the linked public page from the same documentation version.
Hover or focus previews its summary and members, while the link still opens the full reference.
Touch readers have a separate preview button

Do not expose internal declarations or combine versions in a preview

## Local checks

Use Node.js from [the shared pin](/projects/.node-version), install the locked workspace, and run from [projects/](/projects/)

Before starting a server, inspect occupied ports and existing processes.
Stop only processes started for your own check

```sh
pnpm install --frozen-lockfile
pnpm docs:dev
```

`docs:dev` builds the SDK before reference generation and local Astro development.
For non-interactive validation, run `pnpm check`.
The aggregate check includes the SDK, release tooling tests and website build, typecheck and local tests

The packed-consumer check compiles every fenced JavaScript or TypeScript guide example in a separate module.
It selects the packed default or Effect entry point from the authored import.
JavaScript examples use `checkJs: false`, while TypeScript examples compile strictly

For rendered checks, install Chromium with `pnpm --filter fluxerly-docs exec playwright install chromium`.
Run `pnpm --filter fluxerly-docs test:browser` for the development documentation.
Run `pnpm --filter fluxerly-docs test:versions` for isolated exact-version fixtures

The browser harness runs Wrangler Pages locally, owns loopback port 4322 and refuses to reuse an existing server.
This checks the emitted hosting worker as well as the static pages. Astro development and preview alone do not establish HTTP redirect behavior
Fixture versions are test data, not published releases

Inspect desktop and mobile reading, keyboard navigation, search, version switching, public reference links and fragments.
The selected reading UI is dark and cozy with 20px body text.
Keep noindex controls, and add no SEO or sitemap to this temporary site.
See [the public API documentation gate](/docs/TECHNOLOGY.md#public-api-documentation-completion-gate) when SDK behavior changes

## Exact-version archives

The local Canary preview is regenerated from the current SDK build and marked Unreleased.
Released docs come from retained snapshots, not the latest declarations relabeled with an old version

Snapshot creation (`projects/web/scripts/snapshot.js`) requires a prepared release version and clean reviewed source checkout.
It records the exact version, source commit and generated Markdown and metadata.
Release preparation binds that snapshot to the immutable package candidate.
Publication requires the [registry contract and external setup](/docs/RELEASING.md#registry-publication-contract)

Release import (`projects/web/scripts/fetch-releases.js`) uses authenticated `gh` reads for `NeonTechSpace/Fluxerly.js`.
It checks the unique `docs.json` asset, SHA256 digest, size, version tag and resolved tag commit against the snapshot source

Imported archives live under ignored `projects/web/released/`.
An import requires an empty generated archive directory and preserves existing or partial files on failure.
Reconcile partial output explicitly rather than deleting it to hide an error.
Archive imports are not multi-file atomic writes

Each exact version has its own guide, reference, changelog and search index.
The selector has one entry per available channel, ordered Stable, RC and Canary.
The default uses that same order.
Until a published Canary exists, the local unpublished preview occupies the Canary entry rather than adding a Development group

Release and documentation version parsing share the [release planner](/projects/release/planning.js)

Changing channels keeps the same page when it exists in the destination version, otherwise it opens that version's introduction.
Older exact versions stay accessible by URL without adding more selector entries.
Exact version URLs remain tied to the retained snapshot even when a channel target advances

No channel or version should imply that a prepared version was actually published

### Latest alias and missing pages

The stable address `/docs/latest/` contains a build-time copy of the newest imported Stable snapshot, otherwise the newest RC, otherwise the newest Canary.
Only when no published snapshot is available does it use the unreleased development content.
The visible SDK label identifies the selected source version. Navigation, reference previews and search remain under `latest`, while changing to another channel opens its exact version

The generator rebases documentation link destinations in the alias without rewriting code examples or changing retained exact-version pages.
An updated alias requires another build and separately authorized deployment. It does not query release metadata on each request

The hosting integration (`projects/web/scripts/hosting.js`) inventories the emitted HTML and produces a self-contained Cloudflare Pages `_worker.js` and `_routes.json` in the selected build directory.
The routing policy (`projects/web/scripts/docs-routing.js`) handles `/`, `/docs` and documentation paths. Both documentation entrances return HTTP 302 to `/docs/latest/`, without waiting for page JavaScript or a meta refresh

Existing exact-version and latest pages pass through unchanged. Unknown versions and broken documentation paths redirect to an existing equivalent latest page when unambiguous, otherwise to its introduction.
Malformed encoded paths fall back to the introduction rather than being interpreted as another path.
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
It always checks out `main`, imports verified released snapshots and runs the aggregate check before upload.
Set these values in the `website` environment before separately authorized delivery:

| Setting | Store as | Required value |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Environment variable | Selected account's 32-character lowercase hexadecimal ID |
| `CLOUDFLARE_PAGES_PROJECT` | Environment variable | Selected Pages project name |
| `CLOUDFLARE_PREVIEW_URL` | Environment variable | Public HTTPS origin whose hostname starts with `preview.`, without path, credentials, port, query or fragment |
| `CLOUDFLARE_API_TOKEN` | Environment secret | Token with access to read the selected project and deploy Pages |

Add these under GitHub Settings, Environments, website.
The workflow reads the three non-secret settings through `vars` and the token through `secrets`.
GitHub supplies its repository-read token automatically.
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
It then verifies the provider deployment identity and Preview environment, source commit, documentation route, noindex response header and served source marker at that deployment's unique Pages URL.
The URL must be HTTPS and belong to the subdomain returned for the verified Pages project. Cloudflare credentials are sent only to the provider API, never to either website

The configured custom domain is checked separately for the same content.
Only a positively identified Cloudflare challenge response, `cf-mitigated: challenge`, changes that check to a warning after exact-deployment verification succeeds.
That outcome does not prove custom-domain content or public access. Other access denials, stale source, missing noindex and redirects remain failures, not accepted deployment evidence.
The workflow summary distinguishes exact-deployment verification from the custom-domain result

Cloudflare Bot Fight Mode can challenge CI requests even when the website works in a browser.
Keep that protection enabled rather than treating a challenge as an upload failure or disabling domain-wide protection.
See [challenge-response detection](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/) and [Pages deployment URLs](https://developers.cloudflare.com/pages/configuration/preview-deployments/)

Readback is bounded and retries transient reads, including provider rate-limit delays

The wrapper does not repeat uploads after an uncertain acknowledgement.
Wrangler has internal provider retries, so this is not exactly-once deployment.
Pages does not provide a conditional upload guard against concurrent project-setting changes

When an upload identity is missing or readback does not converge, inspect that source, branch, deployment and custom-domain routing before another upload.
A local build or mock provider test does not establish public access or an actual deployment
