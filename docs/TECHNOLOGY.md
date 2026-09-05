# Technology choices

This document records SDK and website tooling, consumer support and release policy.
Use [the repository guide](/docs/REPOSITORY.md) for setup and file locations

## SDK

| Area | Selected choice |
| --- | --- |
| Package | `@neontechspace/fluxerly`, initially one published package with internal module boundaries |
| Language | TypeScript 7 |
| Module format | ECMAScript modules (ESM) |
| Runtime | Node.js 24 as the minimum consumer major |
| Internal implementation | Effect 4 release-candidate line |
| Public entry points | Default JavaScript/TypeScript and Effect-native, sharing one implementation |
| Public error results | neverthrow `Result` for default synchronous creation and `ResultAsync` for default async operations, typed Effect failures for the native API |
| Initial build | TypeScript 7 compiler-only ESM output, public declarations and source maps |
| Tests | Vitest runtime tests and separate TypeScript 7 consumer checks |
| Distribution | npm |

### Consumer support

Planned support covers JavaScript and TypeScript 7 only.
TypeScript 6 and earlier are outside the SDK's support policy.
JavaScript consumers will not need a TypeScript installation

The exact minimum Node.js 24 minor and patch versions remain to be selected and tested

### Effect and diagnostics

Effect owns internal concurrency, cancellation, resource management and logging.
Keep neverthrow conversion at the default public boundary.
The [SDK contracts](/docs/SDK-CONTRACTS.md) define shared ownership, failure and diagnostic constraints

### Optional consumer Effect integration

The initial target is Effect 4's release-candidate line, not Effect 3 or a stable Effect 4 release.
Use an exact prerelease pin for reproducible implementation and validation.
The native consumer compatibility range and dependency or peer-dependency packaging remain undecided

### Build and package optimization

Start with TypeScript 7 compiler-only output: Readable ESM JavaScript, public type declarations and source maps.
Keep deliberate public exports and clean package contents.
Validate the packed artifacts through default JavaScript, TypeScript 7 and native Effect consumers rather than relying only on source imports

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

Exact dependency versions need a compatibility check before installation is treated as a validated toolchain.
An Effect-specific Vitest adapter, coverage target and additional test libraries have not been selected.
The [SDK validation requirements](/docs/SDK-CONTRACTS.md#validation-requirements) identify the behavior those tests must establish

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

## Shared development tooling

| Area | Selected choice |
| --- | --- |
| Package manager | pnpm 12 |
| Workspace | One pnpm workspace and lockfile under [projects/](/projects) |
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

Lint and formatting tools have not been selected.
The selected build and test tools are not installed or configured.
Release and deployment workflows are not configured
