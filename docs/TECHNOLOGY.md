# Technology choices

This document records SDK and website tooling, consumer support and release policy.
Use [the repository guide](/docs/REPOSITORY.md) for setup and file locations

## SDK

| Area | Selected choice |
| --- | --- |
| Package | `@neontechspace/fluxerly`, initially one published package with internal module boundaries |
| Language | TypeScript 7 |
| Module format | ECMAScript modules (ESM) |
| Runtime | Tested against Node.js 24.15 or newer |
| Internal implementation | Effect 4 |
| WebSocket transport | `ws`, kept behind internal SDK boundaries |
| Public entry points | Default JavaScript/TypeScript and Effect, sharing one implementation |
| Public error results | neverthrow `Result` for default synchronous operations and `ResultAsync` for default async operations, typed Effect failures for the native API |
| Initial build | TypeScript 7 compiler-only ESM output, public declarations and source maps |
| Tests | Vitest runtime tests and separate TypeScript 7 consumer checks |
| Distribution | npm from a separately staged package |

### Consumer support

The SDK supports JavaScript and TypeScript 7.
TypeScript 6 and earlier are outside the SDK's support policy.
JavaScript consumers do not need a TypeScript installation

Fluxerly is tested against Node.js 24.15 or newer, the oldest Node 24 release that npm 12 supports.
Use current security updates within a supported Node.js release line. The development pin is maintained separately from this compatibility floor

### Support policy

- Raising the minimum Node.js version is a breaking change that increases MAJOR
- A Node.js release line is dropped no sooner than six months after its end of life
- The Effect peer accepts releases of one Effect major starting at the supported minimum, independently of the development dependency. Raising that minimum or changing the Effect major is a breaking change that increases MAJOR

### Versioning and release stages

The SDK uses [Epoch Semantic Versioning](https://antfu.me/posts/epoch-semver), with this SemVer-compatible package version format:

```text
(EPOCH * 1000 + MAJOR).MINOR.PATCH[-nightly.YYYYMMDD.N]
```

The epoch identifies a major project generation.
Within an epoch, MAJOR increases for breaking public API changes, MINOR for backward-compatible features and PATCH for backward-compatible fixes.
MAJOR ranges from 0 to 999 with this mapping.
The ending says what kind of release it is, separately from the numbers

| Suffix | Meaning |
| --- | --- |
| `-nightly.YYYYMMDD.N` | Automatic build of `main`, published twice a day when the SDK changed. It can include breaking changes at any time |
| No suffix | Stable release supported for public use |

There is no literal `-none` suffix.
The next version is measured against the last Stable, not the last nightly.
The first Stable is `1000.0.0`, whatever breaking changes its nightlies had along the way.
Later cycles accumulate compatibility changes against their stable starting version, so repeated major notes do not repeatedly increase the target major.
A bigger change can raise the target, but an epoch chosen on purpose never drops. Breaking changes between nightlies still need release notes

Nightlies can always include breaking changes against any earlier nightly, including after the first Stable. Only between Stable releases does the version tell what kind of change a release contains: MAJOR for breaking changes, MINOR for compatible features and PATCH for compatible fixes.
Every Stable ships the same code as the newest nightly of its version.
[Stable and nightly](/docs/RELEASING.md#stable-and-nightly) has the exact rules

A nightly version is never committed. Its first part is the version the next Stable would have, and the rest is the UTC date of its preparation followed by the preparing run's number, such as `1000.1.0-nightly.20261019.57`. The date comes first so builds sort by day, and run numbers only grow but can skip values. A nightly's core can still drop, for example when a pending minor note is removed. Nightly versions from before this format use `-nightly.N` and sort below every dated nightly of their core.
Nightlies never wait for another release

The first stable public generation is called Epoch 1 and starts at `1000.0.0`, not `1.0.0`

| Example release | Package version |
| --- | --- |
| First stable release | `1000.0.0` |
| Nightly build after the first stable release | `1000.0.1-nightly.20261019.57` |
| Compatible bug fix | `1000.0.1` |
| Compatible feature | `1000.1.0` |
| Breaking API change within Epoch 1 | `1001.0.0` |
| Next major project generation | `2000.0.0` |

These examples illustrate versioning, not the current release inventory.
Use the [SDK source manifest](/projects/sdk/package.json) for the checkout's version and [npm registry metadata](https://registry.npmjs.org/@neontechspace%2ffluxerly) for published versions.
The two release channels are Nightly and Stable, with the npm tags `nightly` and `latest`.
Release tooling moves only the published channel's tag, so nightlies never move `latest`.
Release documentation snapshots use the matching exact package version, including its prerelease suffix

Canary and RC were earlier channels and are retired. No new versions of them are published

### Effect and diagnostics

Effect handles internal concurrency, cancellation, resource management and logging.
Convert results to neverthrow only at the default public API.
The [SDK contracts](/docs/SDK-CONTRACTS.md) define shared ownership, failure and diagnostic constraints

### Optional consumer Effect integration

The SDK development dependency pins an exact stable Effect 4 version within the required peer range.
Packed consumers separately test the range's minimum, such as `4.1.2` for `^4.1.2`, including a native Effect consumer type-checked with Node.js types and no DOM library.
Updating the development dependency does not raise that minimum. Other releases within the range are accepted, and only the newest one is checked daily, as described under [shared development tooling](/docs/TECHNOLOGY.md#shared-development-tooling). Effect 3 and Effect 4 prereleases are unsupported

Modern npm, pnpm and Bun install required peers automatically by default.
Consumers that disable peer installation must install an Effect version within the declared range themselves

### Build and package optimization

Start with TypeScript 7 compiler-only output: Readable ESM JavaScript, public type declarations and source maps.
Keep deliberate public exports and clean package contents.
Validate the packed artifacts through default JavaScript, TypeScript 7 and native Effect consumers rather than relying only on source imports

The SDK source manifest stays private and records the version used for local package checks and release preparation.
Its tarball includes readable compiled output, public declarations, JavaScript and declaration maps, and sources for navigation.
The staged npm package includes the package README, consumer agent guidance and Apache-2.0 license, plus the Changesets changelog when present

The staged npm manifest takes its public package name and release version from the private SDK source manifest.
TypeScript 7 remains authoritative for SDK compilation and consumer checks.
Manual release workflows and immutable candidate tooling enforce the [registry publication contract](/docs/RELEASING.md#registry-publication-contract)

Compiler-only output is the selected release format.
No bundler is selected

Minification is off by default.
A smaller package must demonstrate enough benefit to justify less readable output and another code transformation.
A proposed change to that default requires runtime, type, source-map and diagnostic checks.
Bundling or minification requires a separate decision

### Test tooling

Use Vitest for runtime tests and separate TypeScript 7 compiler checks for consumer examples.
Exercise default and native entry points, including failure, interruption and cleanup behavior.
Examples must use supported public imports without casts that bypass the intended API or repeated low-level orchestration on the main path.
Runtime success does not establish type correctness, and compiler success does not establish runtime behavior

An Effect-specific Vitest adapter, coverage target and additional test libraries have not been selected.
The [SDK validation requirements](/docs/SDK-CONTRACTS.md#validation-requirements) identify the behavior those tests must establish

The current Effect and test-tool declarations require DOM and explicit-resource-management library types during SDK compilation.
The SDK build includes `DOM` and `ESNext.Disposable` alongside `ES2024` without disabling dependency declaration checking.
The default packed TypeScript consumer checks with `ES2024` and Node.js types, because handler signals are `AbortSignal` values and clients support `await using`. It does not import Effect types.
The native packed TypeScript consumer includes the additional libraries required by Effect's declarations.
These compiler libraries do not add browser runtime support

### Transport choice

The default transport uses ws, not the runtime's built-in WebSocket or Effect's unstable HTTP/socket modules.
The built-in WebSocket lacks bounded forced closure, which is required to release owned resources before shutdown completes, and the Effect adapter showed a cleanup limitation.
Use the selected ws transport rather than abandoning a socket after a timeout

#### Selected ws dependency

Keep ws and its types behind internal boundaries, with Effect owning cancellation and cleanup.
Only the [socket transport](/projects/sdk/src/internal/transport/socket.ts) imports ws. The [gateway implementation](/projects/sdk/src/internal/gateway.ts) owns protocol behavior through that transport seam

## Documentation website

| Area | Selected choice |
| --- | --- |
| Framework | Astro |
| Interactive parts | React islands, with three and gsap for the homepage's live scene |
| Search | Pagefind, one index per served version |
| Hosting | Cloudflare Pages |
| Tooling compiler | TypeScript 6 until the website toolchain supports TypeScript 7 and migration is approved |
| SDK reference generator | TypeDoc JSON, reading TypeScript 7-generated declarations |

TypeScript 6 is a compatibility exception for the website and reference-generation tooling, not SDK consumer support.
The website is separate from the SDK's npm package.
The site's character and rules are in [its AGENTS.md](/projects/web/AGENTS.md).
Use [documentation maintenance](/docs/DOCUMENTATION.md) for generation, exact-version snapshots and delivery setup

### SDK reference generation

TypeScript 7 builds the SDK and emits its public declarations with authored documentation comments.
TypeDoc runs with TypeScript 6 in the documentation tooling to read those declarations.
This keeps the SDK compiler and TypeScript consumer policy on TypeScript 7

Generated JSON provides the API reference rendered by Astro, alongside handwritten guides and examples.
The website must explicitly map generated reference links to its page routes and preserve fragment targets.
Generated reference files must not require manual link edits

The generator and route integration are implemented in `projects/web/`

Handwritten guides remain website source, and Changesets owns the package changelog rendered by the website and GitHub release notes

Documentation placement and the public API documentation completion gate are in [documentation maintenance](/docs/DOCUMENTATION.md#documentation-placement)

## Shared development tooling

| Area | Selected choice |
| --- | --- |
| Package manager | pnpm 12 |
| Workspace | One pnpm workspace and lockfile under [projects/](/projects/) |
| Development Node version | One shared version source in [projects/.node-version](/projects/.node-version) |
| Git line endings | [Git attributes](/.gitattributes) |
| License | [Apache-2.0](/LICENSE) for the SDK, website code and authored documentation |

The development Node version is pinned in `.node-version`, separately from the SDK's consumer minimum

The workspace declares the pnpm range `>=12 <13` through `devEngines.packageManager` in [projects/package.json](/projects/package.json).
The shared lockfile records the resolved pnpm version, which is reused while it satisfies that range.
The `onFail: "download"` setting enables automatic download and version switching

Updates within pnpm 12 are deliberate, not automatic on each run.
Run `pnpm self-update 12` from `projects/`, then `pnpm install --lockfile-only` to refresh the lockfile.
Review and commit the resulting manifest and lockfile changes together.
Moving to pnpm 13 requires a separate decision

Dependabot proposes weekly GitHub Actions and npm updates for the workspace, configured in [.github/dependabot.yml](/.github/dependabot.yml).
It ignores `effect`, whose development pin and public peer minimum are updated separately by decision, and major `typescript` and `@types/node` updates.
The SDK runtime dependencies `neverthrow` and `ws` are grouped into their own pull request, so their update can carry a Changeset

A fresh consumer install resolves the newest Effect release in the peer range, so the daily [Effect drift workflow](/.github/workflows/effect-drift.yml) watches new Effect releases instead of Dependabot.
It installs that release within pnpm's default one-day release-age policy. When it differs from the development pin, the workflow builds, type-checks and tests the SDK with it and fails on any error, naming the release in its job summary.
It changes nothing in the repository

The repository's Actions settings allow only selected actions, each pinned to a full commit SHA (`allowed_actions: selected` and `sha_pinning_required: true`).
A Dependabot GitHub Actions pull request therefore fails Check with a startup failure until its new SHAs are on the allowlist:

1. Collect the new SHAs, including those of actions used inside an updated composite action, such as the `github/codeql-action/upload-sarif` step in `zizmor-action`. Those do not appear in the pull request diff
2. Verify that each new SHA is the commit of its release tag, for example with `gh api repos/OWNER/REPO/git/ref/tags/TAG`, where `OWNER/REPO` is the repository part of the action path, such as `github/codeql-action` for `github/codeql-action/upload-sarif`. For an annotated tag, dereference the returned tag object to its commit
3. Add the new entries to the allowlist under Settings, Actions, General, or through the API. Each entry is the full action path from the `uses:` line, `OWNER/REPO[/PATH]@SHA`, such as `github/codeql-action/upload-sarif@SHA`. The API replaces the whole setting, so save the output of `gh api repos/NeonTechSpace/Fluxerly.js/actions/permissions/selected-actions`, edit `patterns_allowed` to keep the existing entries and add the new ones, and send the complete payload with `github_owned_allowed` and `verified_allowed` as they currently are. Use `gh api -X PUT` on the same path with `--input payload.json`, so booleans and arrays keep their JSON types. Read the setting again to verify it
4. Ask Dependabot to rebase the pull request, then merge it once Check passes
5. Remove the old SHAs the same way once no workflow on main uses them

Prettier is an SDK development dependency, with its version recorded in the manifest and lockfile.
Its [configuration](/projects/sdk/.prettierrc.json) selects a 120-column target, 4-space indentation, LF endings and no optional semicolons.
Other formatting options use Prettier's stable defaults, without plugins or experimental formatting

The [development checks](/docs/REPOSITORY.md#development-checks) include SDK formatting validation and linting.
Oxlint lints SDK source, scripts, examples and tests, release tooling and website scripts with type-aware rules through oxlint-tsgolint.
Knip reports unused SDK files and exports, and CSpell checks SDK source comments, website guides and repository documents against the [project word list](/projects/cspell-words.txt).
Source scans complete the lint. The [em-dash check](/projects/scripts/em-dashes.mjs) fails on any em dash in a tracked or new SDK or website file, except fixtures that copy Fluxer's text exactly. The [failure-mapping check](/projects/sdk/scripts/failure-mapping.js) fails when SDK source maps failures with `Effect.mapError` or `Cause.map` instead of the helpers that also map failures Effect turned into defects.
These tools are exact workspace development dependencies configured in [projects/](/projects/).
In CI, actionlint lints the workflow files and zizmor audits them.
Website formatting has not been selected.

The Effect language service for TypeScript 7, `@effect/tsgo`, checks SDK source, tests and examples for Effect mistakes, such as an Effect that is built but never run.
Its errors and warnings fail the lint.
Its style suggestions appear in editors and in `pnpm build` after the [editor setup](/docs/REPOSITORY.md#development-checks).
The [SDK tsconfig](/projects/sdk/tsconfig.json) turns off `lazyEffect`, because zero-argument public methods such as `connect()` return a new Effect by design.
Source that keeps a failure from a caller's store, hook or callback as it is turns off `unknownInEffectCatch` for that line with an `@effect-diagnostics-next-line` comment.
A session store timeout is reported as a plain `Error` among those failures, so its line turns off `globalErrorInEffectFailure` the same way.
Tests turn both rules off.
Type tests build Effect values without running them, so they also skip `floatingEffect` and `missingEffectContext`

The SDK build and test tools are installed and configured.
The workspace's `allowBuilds` policy enables the `esbuild` and `workerd` install scripts and explicitly disables the optional transitive `msgpackr-extract` script.
Unreviewed dependency builds still fail installation rather than being enabled globally

Check, version PR, candidate preparation, publication, Website, weekly upstream drift and daily Effect drift workflows are configured under [.github/workflows](/.github/workflows/).
Check on `main` dispatches candidate preparation after a passing run that changed the SDK to an unpublished version, and a schedule twice a day prepares a nightly build and publishes it when the SDK changed since the most recent nightly or release of that source.
[Releasing](/docs/RELEASING.md) describes each trigger and when a nightly is skipped.
Nightlies are published to npm.
Use [npm registry metadata](https://registry.npmjs.org/@neontechspace%2ffluxerly) for the published versions
