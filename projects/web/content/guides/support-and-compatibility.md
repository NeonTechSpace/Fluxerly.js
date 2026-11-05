---
title: Support and compatibility
navTitle: Support and compatibility
description: Separate SDK support, instance availability and account permissions before deploying a bot
---

Before production use, check how the application handles failures, restarts and deployment with the exact SDK version installed

## Runtime and upgrade requirements

| Area              | Current policy                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Runtime           | Tested against Node.js 24.15 or newer                                                            |
| Modules           | ESM only, with `"type": "module"` in `package.json` or `.mjs` files                              |
| Package managers  | npm, pnpm or Bun installs the package, and Node.js runs the bot                                  |
| JavaScript        | No TypeScript compiler requirement                                                               |
| TypeScript        | TypeScript 7, not TypeScript 6 or earlier, with `@types/node` for the Node.js types              |
| Native Effect     | Effect 4.1.2 or a later Effect 4 release, in the range the installed package lists               |
| Web browsers      | Not supported. A bot runs as a Node.js program, not inside a web page                            |
| Operating systems | Hosted CI uses Ubuntu. A passing Ubuntu run does not qualify every operating system or container |
| License           | Free and open source under the Apache License 2.0                                                |

Check the installed package's manifest for its Node.js and Effect requirements. The default API needs Effect internally, and npm or pnpm normally installs that dependency automatically. Native Effect code must use a version within the Effect range listed there, not Effect 3 or an Effect 4 prerelease. Since SDK 1001.0.0 the range starts at Effect 4.1.2, because Effect 4.1.0 fails to type-check in a TypeScript project that has the Node.js types but no `DOM` library, and 4.1.2 is the newest Effect release

Stable releases follow Epoch Semantic Versioning, so only a new major version or epoch can break existing code, and minor and patch releases are safe to take. Nightly builds can include breaking changes at any time


## Check SDK, instance and account support

Before relying on an operation, check three separate things:

1. **Does the SDK implement the operation?** Consult the installed version's [API reference](/docs/api/). A method available in newer documentation may not exist in an older package
2. **Does the selected instance implement and enable it?** Discovery exposes reviewed endpoint and upload metadata, not a complete endpoint capability registry
3. **May this account perform it on this resource?** Account type, OAuth scope, community membership and permissions remain provider decisions at request time

<details>
<summary>How the client reads instance details</summary>

A provider code-version number does not say which API routes or permissions are available. The client reads instance details once and does not refresh them while it runs. A 404 response alone cannot tell whether a feature is missing, a resource is unavailable or access is hidden

The existing presigned-upload flag is an advertised Boolean used for attachment routing. Missing or malformed required discovery data fails resolution rather than becoming an assumed capability. Features without a reviewed discovery field remain unknown. Neither a guessed capability nor another instance's metadata should select a credential destination

</details>

## Get help

Use [troubleshooting](/docs/troubleshooting/) and the [FAQ](/docs/faq/) to diagnose a problem. Ask usage questions in [Q&A](https://github.com/NeonTechSpace/Fluxerly.js/discussions/categories/q-a), propose features in [Ideas](https://github.com/NeonTechSpace/Fluxerly.js/discussions/categories/ideas), and report reproducible SDK problems with the [bug-report form](https://github.com/NeonTechSpace/Fluxerly.js/issues/new?template=bug_report.yml). Public issues cover only Stable releases in the current major. A problem found on a nightly must also reproduce on one of those Stable releases

Report a security vulnerability privately, as the [repository security policy](https://github.com/NeonTechSpace/Fluxerly.js/security/policy) describes, through GitHub's private vulnerability reporting. Do not post vulnerabilities in public issues, pull requests or discussions

## Safe failure reports

To report a failure, include the exact SDK, Effect and Node versions, operating system, default or native entry point, operation name, safe error code, expected result and a minimal reproduction using a controlled test resource. The output of `describeError(error)` supplies the code, hint and cause chain. Say whether the failure came from a local fake provider or a live instance, and which recovery or cleanup checks ran

Exclude tokens, authorization headers, OAuth codes and refresh tokens, webhook credentials, signed attachment URLs, private message bodies and unredacted request or response dumps. Reduce identifiers and payloads to synthetic examples. Application logs need independent redaction even when SDK diagnostics omit sensitive fields
