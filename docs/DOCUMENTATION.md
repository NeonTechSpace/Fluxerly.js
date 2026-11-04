# Documentation maintenance

This guide covers the website, SDK documentation authoring, local checks, published versions and deployment. The Astro site in `projects/web/` combines handwritten guides with a generated public API reference. Its design rules, checks and the fixed screens they cover are in [its AGENTS.md](/projects/web/AGENTS.md)

## Where to edit

Apply [documentation placement](/docs/DOCUMENTATION.md#documentation-placement) before adding prose

- Edit caller-visible member behavior in public SDK source comments
- Edit handwritten guides in `projects/web/content/guides/`. `meta.json` there is the ordered inventory for the sidebar. Use short `navTitle` sidebar labels and `title` for headings. List other words readers use for a guide's topic, such as `getting started`, under `search`. Docs search reads them as it reads the title
- Edit the site under `projects/web/src/`, with shared values at the top of `src/styles/global.css`
- Author release fragments through Changesets, which owns the SDK changelog that the site renders at `/docs/changelog/`
- Edit the generated error and log codes page through its entries in `projects/sdk/src/internal/code-catalogue.ts`. Logging an uncatalogued code fails the SDK type check
- Keep setup, verification and release operations in repository Markdown

Introduce the SDK with a bot that responds to a message. Show client creation, one handler and connection before configuration, error handling and shutdown. Put advanced overview notes in JSDoc `@remarks`, not in place of precise member behavior

Lead with the reader's next task and explain unfamiliar concepts before use. Keep conditions beside consequences, and place necessary warnings before optional detail

## What is generated

`pnpm --filter fluxerly-docs generate` runs [generate.mjs](/projects/web/scripts/docs/generate.mjs) after the SDK is built. It writes these ignored files under `projects/web/content/`:

| File | Source |
| --- | --- |
| `reference/model.json`, `codes.json` and `links.json` | TypeDoc reads the SDK's emitted declarations in [extract.mjs](/projects/web/scripts/docs/extract.mjs). A gap in a member's comment or a type that isn't exported fails it, so fix those in SDK source. The only exception is the private Fluxer schema types inside the generated REST route and gateway payload modules, whose entries link Fluxer's docs instead |
| `reference/endpoints.json` | [endpoints.mjs](/projects/web/scripts/docs/endpoints.mjs) matches the routes the SDK sends against Fluxer's OpenAPI document at the commit pinned in `projects/release/upstream/manifest.json`, and links each route to Fluxer's docs at `docs.fluxer.com`. It reads the OpenAPI document and the docs files the manifest lists under `endpointDocs` from raw.githubusercontent.com at that commit, never from a Fluxer host, and keeps them in `projects/web/.cache/fluxer` ([fluxer-source.mjs](/projects/web/scripts/docs/fluxer-source.mjs)). Every file, cached or downloaded, must match the sha256 the manifest pins, and a cached file that doesn't is downloaded again. A build with an unchanged pin downloads nothing, and a new pin downloads each file once. CI's Check workflow saves that folder as a cache, and the release and website workflows only restore it. The docs sidebar and the docs overview show the commit from this map, so each version names the Fluxer commit it was checked against |
| `examples/` | A copy of `projects/sdk/examples/`, shown by the `{{starter:file}}` and `{{example:folder/file}}` markers in guides |
| `changelog.md` | A copy of `projects/sdk/CHANGELOG.md`. A nightly's snapshot adds its pending notes at the top |

Guides use a fenced `command` block, `{{installation}}` or `{{init}}` for package manager commands, which [remark-guides.mjs](/projects/web/scripts/docs/remark-guides.mjs) renders as a chip with npm, pnpm and Bun forms. Author default API examples in TypeScript. The build derives JavaScript, and Effect examples remain TypeScript-only

The site's art in `projects/web/public/art/` is cut by `pnpm --filter fluxerly-docs prepare:art` from the originals in [art-source](/projects/web/art-source/), which keeps only the files that [prepare-art.mjs](/projects/web/scripts/prepare-art.mjs) reads. The built site does not include them

Each guide page names its Markdown in its head and has a Copy as Markdown button. Each served version also has files for AI tools: `llms.txt`, an index, `llms-full.txt`, with every guide, `llms-reference.txt`, a condensed reference, `api/tasks.md`, every client method by task, and each guide as `<guide>.md`. The site root serves the newest version's `llms.txt`

## Documentation placement

Before adding or expanding documentation, choose its owner:

| Content | Owner |
| --- | --- |
| Member signatures, defaults and caller-visible behavior | Public source comments, preserved in declarations for the website reference |
| User guides, tutorials, examples and design explanations for SDK users | Documentation website |
| Introduction, contributor setup, navigation, testing procedures and release policy | Repository Markdown |
| Instructions for agents consuming the installed package | [Agent guide](/projects/sdk/agents/AGENTS.md), discovered through the package README |
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

Use Node.js from [the shared pin](/projects/.node-version), install the locked workspace, and run from [projects/](/projects/). Before starting a server, inspect occupied ports and existing processes, and stop only processes started for the current check

```sh
pnpm install --frozen-lockfile
pnpm docs:dev
```

The `docs:dev` script builds the SDK, generates the content and starts Astro. `docs:dev:skip-build` reuses the existing SDK build.

For non-interactive validation, run `pnpm check`. The aggregate check includes contribution tooling, the SDK, release tooling and the website's lint, build, types, tests and search ranking, each step starting as soon as the steps it reads from pass.

For rendered checks, install Chromium with `pnpm --filter fluxerly-docs exec playwright install chromium`, then build:

| Command | What it does |
| --- | --- |
| `pnpm --filter fluxerly-docs test:browser` | Sweeps the built site across every screen in `scripts/checks/lib.mjs`, in the way a reader uses it. Its parts run side by side in one browser. `--changed` runs only the parts and pages the changed files can reach, as [changed.mjs](/projects/web/scripts/checks/changed.mjs) works them out |
| `pnpm --filter fluxerly-docs test:versions` | Builds the public site from fixture versions and checks each version's pages, links, search, redirects and search engine rules. Fixture versions are test data, not releases |
| `pnpm --filter fluxerly-docs check:ui` | Checks Astro types, builds the site, runs the website's TypeScript and JavaScript tests through `pnpm test` and runs the browser sweep. Lint, search ranking (`test:search`) and version checks run separately. `--changed` builds first and then runs the type check, the tests and the sweep's `--changed` run side by side, and stops at once when nothing on the website changed |

See [the public API documentation gate](/docs/DOCUMENTATION.md#public-api-documentation-completion-gate) when SDK behavior changes

## Published versions

A local build shows the working tree. The public site is built only from published versions, each from the snapshot made for it.

Snapshot creation ([snapshot.js](/projects/web/scripts/snapshot.js)) requires a prepared release version and a clean reviewed source checkout. A nightly snapshot receives its planned version through `--nightly VERSION`. The snapshot holds the guides, reference, endpoint map, examples and changelog, with the exact version and source commit. Release preparation binds it to the immutable package candidate as `docs.json`, and publication requires the [registry contract and external setup](/docs/RELEASING.md#registry-publication-contract).

Release import ([fetch-releases.js](/projects/web/scripts/fetch-releases.js)) uses authenticated `gh` reads. It selects every Stable release and the newest published nightly, then checks each `docs.json` against its digest, size, tag and source commit. Snapshots written for an earlier version of the site are skipped, so that release has no pages here. A public build needs at least one current snapshot. Imports go to ignored `projects/web/released/`, which must start empty. The import keeps a copy of each asset in ignored `projects/web/.cache/releases/`, named by its digest, and uses a copy only when it matches the digest and size in the fresh release metadata, so each asset is downloaded once. With `--cache-only` it fills that cache without writing `released/`. CI's Check workflow does that on each push to `main` and saves the cache, which the Website workflow only restores. Retain every immutable `docs.json` asset.

[build-public.mjs](/projects/web/scripts/docs/build-public.mjs) builds the site:

| Address | Serves |
| --- | --- |
| `/docs/` | The newest version: Stable, otherwise nightly. Only these pages are in the sitemap and open to search engines |
| `/docs/nightly/` | The newest published nightly. Its pages install that exact version, and they carry `noindex` |
| `/docs/<version>/` | Each older Stable release, with `noindex` |
| `/docs/latest/` and the newest version's own address | A 302 redirect to `/docs/`, keeping the rest of the path, from a static `_redirects` file |

Numbered nightly addresses and retired channels return 404. Each version has its own reference, changelog and search index. The sidebar's version menu lists Stable, Nightly and any older Stable releases. It keeps the same page when the destination has it, otherwise opening that version's overview.

## Deployment

[Website](/.github/workflows/website.yml) is started on `main` by Release publish after the GitHub release is announced, in its own run, or run by hand. It always checks out `main`, imports the published versions' snapshots, and runs `check:public`. The full screen check, `test:browser` on every screen, runs in [Screens](/.github/workflows/screens.yml) after each push to `main` that changes what the website builds from, so a deploy never waits for it. Before upload it requires a successful main-push [Check workflow](/.github/workflows/ci.yml) for that exact checkout through [checked-source.js](/projects/web/scripts/checked-source.js), waiting up to twenty minutes and rejecting failed, cancelled, missing or mismatched evidence

[deploy.js](/projects/web/scripts/deploy.js) validates the Pages project, the Production branch `main`, the custom hostname, the source marker and the build's sitemap and redirects. It uploads with Wrangler from `projects/web`, so `functions/` goes along, then verifies the exact deployment at its Pages URL and at `https://fluxerly.neontechspace.com`: The source marker, the `/docs/latest/` redirect and that `/docs/` is open to search engines. Cloudflare bot protection on the custom domain counts as a warning, and a plain access denial as a failure. Never rerun an upload after an uncertain result, reconcile it in Cloudflare first, because a failed step doesn't prove that nothing was uploaded.

Set these in GitHub Settings, Environments, `website`:

| Setting | Store as | Required value |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Environment variable | The account's 32-character lowercase hexadecimal ID |
| `CLOUDFLARE_PAGES_PROJECT` | Environment variable | The Pages project name |
| `CLOUDFLARE_API_TOKEN` | Environment secret | A token that can read the project and deploy Pages |

The homepage's download chart reads `/api/npm-downloads` ([its function](/projects/web/functions/api/npm-downloads.ts)), which needs the KV namespace `NPM_DOWNLOADS` bound to the Pages project. The counts update with each deploy, when the Website workflow runs `pnpm --filter fluxerly-docs downloads:fetch`, and from then on once a day after 04:00 UTC, about three hours after npm publishes the previous UTC day. A copy stays fresh until the first 04:00 UTC after it was fetched, and a stale one is served at once while it is refreshed in the background. Without the binding each Cloudflare location asks npm on its own.
