# Technology choices

This document records SDK and website tooling, consumer support and release policy.
Use [the repository guide](/docs/REPOSITORY.md) for setup and file locations

## SDK

| Area | Selected choice |
| --- | --- |
| Package | `@neontechspace/fluxerly`, initially one published package with internal module boundaries |
| Language | TypeScript 7 |
| Module format | ECMAScript modules (ESM) |
| Runtime | Node.js 24.11.0 minimum consumer version |
| Internal implementation | Effect 4 release-candidate line |
| WebSocket transport | `ws`, kept behind internal SDK boundaries |
| Public entry points | Default JavaScript/TypeScript and Effect-native, sharing one implementation |
| Public error results | neverthrow `Result` for default synchronous operations and `ResultAsync` for default async operations, typed Effect failures for the native API |
| Initial build | TypeScript 7 compiler-only ESM output, public declarations and source maps |
| Tests | Vitest runtime tests and separate TypeScript 7 consumer checks |
| Distribution | npm |

### Consumer support

Planned support covers JavaScript and TypeScript 7 only.
TypeScript 6 and earlier are outside the SDK's support policy.
JavaScript consumers will not need a TypeScript installation

The minimum is Node.js 24.11.0, the [first Node 24 LTS release](https://nodejs.org/en/blog/release/v24.11.0).
This compatibility floor is separate from the development pin and does not recommend running an old patch instead of current security updates

### Versioning and release stages

The SDK uses [Epoch Semantic Versioning](https://antfu.me/posts/epoch-semver), with this SemVer-compatible package version format:

```text
(EPOCH * 1000 + MAJOR).MINOR.PATCH[-STAGE.NUMBER]
```

The epoch identifies a major project generation.
Within an epoch, MAJOR increases for breaking public API changes, MINOR for backward-compatible features and PATCH for backward-compatible fixes.
MAJOR ranges from 0 to 999 with this mapping.
The release suffix describes readiness, independently of compatibility changes

| Suffix | Meaning |
| --- | --- |
| `-alpha.N` | Initial SDK development, not ready for supported public use |
| `-beta.N` | Preview of upcoming changes, available for testing |
| `-rc.N` | Release candidate believed ready to ship, with no known release blockers, pending final validation |
| No suffix | Stable release supported for public use |

There is no literal `-none` suffix.
A prerelease containing breaking changes targets the next breaking version even when the suffix is beta or RC

Initial development uses default `0.x.y-alpha.N` versions without a stable public API guarantee.
Epoch zero leaves the package major unchanged because `0 * 1000 + MAJOR = MAJOR`.
The first stable public generation is called Epoch 1 and starts at `1000.0.0`, not `1.0.0`

| Example release | Package version |
| --- | --- |
| Initial development | `0.1.0-alpha.1` |
| First public release preview | `1000.0.0-beta.1` |
| First release candidate | `1000.0.0-rc.1` |
| First stable release | `1000.0.0` |
| Compatible bug fix | `1000.0.1` |
| Compatible feature | `1000.1.0` |
| Breaking API change within Epoch 1 | `1001.0.0` |
| Next major project generation | `2000.0.0` |

These are policy examples, not published releases.
The private development manifest remains at `0.0.0` for local package checks, as described under [build and package optimization](/docs/TECHNOLOGY.md#build-and-package-optimization)

### Effect and diagnostics

Effect owns internal concurrency, cancellation, resource management and logging.
Keep neverthrow conversion at the default public boundary.
The [SDK contracts](/docs/SDK-CONTRACTS.md) define shared ownership, failure and diagnostic constraints

### Optional consumer Effect integration

The initial target is Effect 4's release-candidate line, not Effect 3 or a stable Effect 4 release.
Use an exact prerelease pin for reproducible implementation and validation.
The private development package currently pins Effect as a runtime dependency.
Native consumers must use the same exact Effect version as the SDK for now, not an arbitrary Effect 4 RC.
The published dependency-versus-peer arrangement remains a separate release decision

### Build and package optimization

Start with TypeScript 7 compiler-only output: Readable ESM JavaScript, public type declarations and source maps.
Keep deliberate public exports and clean package contents.
Validate the packed artifacts through default JavaScript, TypeScript 7 and native Effect consumers rather than relying only on source imports

The private development package uses version `0.0.0` so it can be packed for local consumer checks.
Its tarball includes compiled output and source files for source-map and declaration-map navigation.
Release packaging is not configured, and the tarball does not yet include the repository license or a package README

Before publication, compare compiler-only and bundled artifacts once representative SDK code exists.
Measure package size and cold-import or startup behavior.
Check equivalent public behavior, declarations, export boundaries, source maps, diagnostics and native Effect interoperability.
Adopt bundling only when the measured benefit justifies the additional build dependency and maintenance cost.
No bundler is selected

Minification is off by default.
A smaller package must demonstrate enough benefit to justify less readable output and another code transformation.
A proposed change to that default requires runtime, type, source-map and diagnostic checks.
Build the working SDK first, then evaluate packaging optimizations before publishing

### Test tooling

Use Vitest for runtime tests and separate TypeScript 7 compiler checks for consumer examples.
Exercise default and native entry points, including failure, interruption and cleanup behavior.
Examples must use supported public imports without casts that bypass the intended API or repeated low-level orchestration on the main path.
Runtime success does not establish type correctness, and compiler success does not establish runtime behavior

An Effect-specific Vitest adapter, coverage target and additional test libraries have not been selected.
The [SDK validation requirements](/docs/SDK-CONTRACTS.md#validation-requirements) identify the behavior those tests must establish

The current Effect and test-tool declarations require DOM and explicit-resource-management library types during SDK compilation.
The SDK build includes `DOM` and `ESNext.Disposable` alongside `ES2024` without disabling dependency declaration checking.
The default packed TypeScript consumer checks with `ES2024` alone and does not import Effect types.
The native packed TypeScript consumer includes the additional libraries required by Effect's declarations.
These compiler libraries do not add browser runtime support

### Transport experiment

The built-in WebSocket candidate is test-only and must not be promoted on the strength of its characterization tests.
It lacks bounded forced closure, which is required to release owned resources before shutdown completes.
Use the selected ws transport rather than abandoning a socket after a timeout

#### Selected ws dependency

Keep ws and its types behind internal boundaries, with Effect owning cancellation and cleanup.
The [gateway implementation](/projects/sdk/src/internal/gateway.ts) owns production transport and protocol behavior

## Documentation website

| Area | Selected choice |
| --- | --- |
| Framework | Astro |
| Hosting | Cloudflare Pages |
| Tooling compiler | TypeScript 6 until the website toolchain supports TypeScript 7 and migration is approved |
| SDK reference generator | TypeDoc with typedoc-plugin-markdown, reading TypeScript 7-generated declarations |

TypeScript 6 is a compatibility exception for the website and reference-generation tooling, not SDK consumer support.
The website is separate from the SDK's npm package.
A documentation theme has not been selected

### SDK reference generation

TypeScript 7 builds the SDK and emits its public declarations with authored documentation comments.
TypeDoc runs with TypeScript 6 in the documentation tooling to read those declarations.
This keeps the SDK compiler and TypeScript consumer policy on TypeScript 7

Generated Markdown supplies the API reference within Astro, alongside handwritten learning guides and examples.
The website must explicitly map generated reference links to its page routes and preserve fragment targets.
Generated reference files must not require manual link edits

The generator and routing integration are selected but not installed or implemented in this repository

#### Documentation placement

Before adding or expanding documentation, choose its owner:

| Content | Owner |
| --- | --- |
| Member signatures, defaults and caller-visible behavior | Public source comments, preserved in declarations for the website reference |
| User guides, tutorials, recipes and design explanations for SDK users | Documentation website |
| Introduction, contributor setup, navigation, testing procedures and release policy | Repository Markdown |
| Cross-component ownership, invariants and coordination that maintainers need beyond documented public members | Concise repository implementation contracts |

Website Markdown and MDX are website source, not a parallel repository manual.
Until the website is implemented, keep member behavior in source comments.
Link to existing owners instead of repeating API reference, defaults, feature inventories or test assertions.
Update repository docs only when the milestone changes a maintainer-facing rule, boundary, navigation or procedure

Before completing a documentation change, inspect each added or expanded passage against this table.
Retain repository prose only when its maintainer purpose is clear and an existing source does not already serve that purpose.
For live checks, retain commands, prerequisites, outside effects and shared recovery instructions, while test implementations own detailed assertions.
During read-only review, report misplaced or duplicated content rather than moving or deleting it

#### Public API documentation completion gate

Apply [documentation placement](/docs/TECHNOLOGY.md#documentation-placement) to accompanying prose

For implementation or review of SDK public API changes, complete these steps before reporting completion:

1. Inventory the affected public exports and members in both entry points, including shared types and behavior changes with unchanged signatures
2. During implementation, write or update their source comments alongside the code.
   Explain applicable inputs, defaults, units, completion, readiness, ownership, cancellation, expected failures, defects and observable side effects.
   Describe caller-relevant behavior rather than restating the member name or type.
   During read-only review, report missing or inaccurate comments as findings rather than editing them
3. Compare those comments with the implementation and behavioral tests.
   Check the default and native execution differences explicitly.
   Retain a concise review record identifying the affected members, evidence and unresolved documentation gaps
4. Run the [aggregate development check](/docs/REPOSITORY.md#development-checks).
   Verify that each affected member's authored comments survive in the emitted and packed declarations.
   Typecheck affected runnable examples against the public package exports, rather than a separately maintained copy
5. Report the documentation review and verification results with the implementation result.
   Unresolved gaps or skipped required checks mean the affected work is not complete

Apply this gate even before reference generation is installed.
Repository prose does not substitute for public source comments

Comment-presence checks, successful compilation and declaration preservation cannot establish documentation accuracy.
Review the described behavior against the code and tests even when automated checks pass

This gate grants no implementation authority during a read-only review, and no website, dependency, publication or VCS authority

## Shared development tooling

| Area | Selected choice |
| --- | --- |
| Package manager | pnpm 12 |
| Workspace | One pnpm workspace and lockfile under [projects/](/projects/) |
| Development Node version | One shared version source in [projects/.node-version](/projects/.node-version) |
| Editor defaults | [EditorConfig](/.editorconfig) |
| Git line endings | [Git attributes](/.gitattributes) |
| License | [Apache-2.0](/LICENSE) for the SDK, website code and authored documentation |

The development Node version is pinned in `.node-version`, separately from the SDK's consumer minimum

The workspace declares the pnpm range `>=12 <13` through `devEngines.packageManager` in [projects/package.json](/projects/package.json).
pnpm records the resolved version in the shared lockfile and reuses it while it satisfies that range.
The `onFail: "download"` setting enables automatic download and version switching

Updates within pnpm 12 are deliberate, not automatic on each run.
Run `pnpm self-update 12` from `projects/`, then `pnpm install --lockfile-only` to refresh the lockfile.
Review and commit the resulting manifest and lockfile changes together.
Moving to pnpm 13 requires a separate decision

Prettier is an SDK development dependency, with its version recorded in the manifest and lockfile.
Its [configuration](/projects/sdk/.prettierrc.json) selects a 120-column target and no optional semicolons, with 4-space indentation and LF endings inherited from EditorConfig.
Other formatting options use Prettier's stable defaults, without plugins or experimental formatting

The [development checks](/docs/REPOSITORY.md#development-checks) include SDK formatting validation.
Lint tooling and website formatting have not been selected

The SDK build and test tools are installed and configured.
The optional transitive `msgpackr-extract` install script is explicitly disabled in the workspace's `allowBuilds` policy.
Unreviewed dependency builds still fail installation rather than being enabled globally.
Release and deployment workflows are not configured
