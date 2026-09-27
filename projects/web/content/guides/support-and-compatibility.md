---
title: Support and compatibility
navTitle: Support and compatibility
description: Separate SDK support, instance availability and account permissions before deploying a bot
---

Fluxerly is prerelease software intended for testing. It does not yet promise stable support or service availability. Before production use, check how the application handles failures, restarts and deployment with the exact SDK version installed

## Runtime and upgrade requirements

| Area              | Current policy                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Runtime           | Tested against Node.js 24.15 or newer                                                            |
| Modules           | ESM only, with `"type": "module"` in `package.json` or `.mjs` files                              |
| JavaScript        | No TypeScript compiler requirement                                                               |
| TypeScript        | TypeScript 7, not TypeScript 6 or earlier, with `@types/node` for the Node.js types              |
| Native Effect     | The exact Effect peer version declared by the installed SDK                                      |
| Web browsers      | Not supported. A bot runs as a Node.js program, not inside a web page                            |
| Operating systems | Hosted CI uses Ubuntu. A passing Ubuntu run does not qualify every operating system or container |

Check the installed package's manifest for its Node.js and Effect requirements. The default API needs Effect internally, and npm or pnpm normally installs that dependency automatically. Native Effect code must use the exact version listed there, not another release candidate

The lockfile records the exact installed SDK version and keeps installs reproducible. During the prerelease, install with `--save-exact`, which npm and pnpm both accept, so a fresh install without a lockfile cannot pick up a newer prerelease that may break the API. Read the matching [changelog](/docs/{{version}}/changelog/) and rerun application tests before upgrading. Prerelease suffixes describe release readiness, not a guarantee that upgrades preserve every application assumption. Breaking changes target the next breaking package version under the project's versioning policy

No long-term maintenance window, response-time guarantee or deprecation notice period is promised for prerelease versions. A green SDK check covers its named tests, not every bot workload, provider deployment or recovery scenario

## Check SDK, instance and account support

Before relying on an operation, check three separate things:

1. **Does the SDK implement the operation?** Consult the installed version's [API reference](/docs/{{version}}/api/). A method available in newer documentation may not exist in an older package
2. **Does the selected instance implement and enable it?** Discovery exposes reviewed endpoint and upload metadata, not a complete endpoint capability registry
3. **May this account perform it on this resource?** Account type, OAuth scope, community membership and permissions remain provider decisions at request time

<details>
<summary>How the client reads instance details</summary>

A provider code-version number does not say which API routes or permissions are available. The client reads instance details once and does not refresh them while it runs. A 404 response alone cannot tell whether a feature is missing, a resource is unavailable or access is hidden

The existing presigned-upload flag is an advertised Boolean used for attachment routing. Missing or malformed required discovery data fails resolution rather than becoming an assumed capability. Features without a reviewed discovery field remain unknown. Neither a guessed capability nor another instance's metadata should select a credential destination

</details>

## Get help

Issues and pull requests are maintainer-only until the first stable release, so there is no public help channel before then. Use [troubleshooting](/docs/{{version}}/troubleshooting/) and the [FAQ](/docs/{{version}}/faq/) to diagnose a problem

Report a security vulnerability privately, as the [repository security policy](https://github.com/NeonTechSpace/Fluxerly.js/security/policy) describes, through GitHub's private vulnerability reporting. Do not post vulnerabilities in public issues, pull requests or discussions

## Safe failure reports

To report a failure, include the exact SDK, Effect and Node versions, operating system, default or native entry point, operation name, safe error code, expected result and a minimal reproduction using a controlled test resource. The output of `describeError(error)` supplies the code, hint and cause chain. Say whether the failure came from a local fake provider or a live instance, and which recovery or cleanup checks ran

Exclude tokens, authorization headers, OAuth codes and refresh tokens, webhook credentials, signed attachment URLs, private message bodies and unredacted request or response dumps. Reduce identifiers and payloads to synthetic examples. Application logs need independent redaction even when SDK diagnostics omit sensitive fields
