---
title: Support and compatibility
navTitle: Support and compatibility
description: Separate SDK support, instance availability and account permissions before deploying a bot
---

Fluxerly is a Canary SDK intended for testing. It does not yet promise stable support or service availability. Before production use, check how the application handles failures, restarts and deployment with the exact SDK version installed

## Runtime and upgrade requirements

| Area              | Current policy                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Runtime           | Node.js 24.11.0 or newer, with current security updates                                          |
| JavaScript        | ESM, without a TypeScript compiler requirement                                                   |
| TypeScript        | TypeScript 7, not TypeScript 6 or earlier                                                        |
| Native Effect     | The exact Effect peer version declared by the installed SDK                                      |
| Browser runtimes  | Not supported by the Node.js SDK                                                                 |
| Operating systems | Hosted CI uses Ubuntu. A passing Ubuntu run does not qualify every operating system or container |

Check the installed package's manifest for its Node.js and Effect requirements. The default API needs Effect internally, and npm or pnpm normally installs that dependency automatically. Native Effect code must use the exact version listed there, not another release candidate

Pin the SDK version and retain the application's lockfile for reproducible deployments. Review the matching changelog and rerun application tests before upgrading. Canary and RC suffixes describe release readiness, not a guarantee that upgrades preserve every application assumption. Breaking changes target the next breaking package version under the project's versioning policy

No long-term maintenance window, response-time guarantee or deprecation notice period is promised for Canary releases. A green SDK check covers its named tests, not every bot workload, provider deployment or recovery scenario

## Check SDK, instance and account support

1. **Does the SDK implement the operation?** Consult the installed version's public API reference. A method available in newer documentation may not exist in an older package
2. **Does the selected instance implement and enable it?** Discovery exposes reviewed endpoint and upload metadata, not a complete endpoint capability registry
3. **May this account perform it on this resource?** Account type, OAuth scope, guild membership and permissions remain provider decisions at request time

A provider code-version number does not say which API routes or permissions are available. The client reads instance details once and does not refresh them while it runs. A 404 response alone cannot tell whether a feature is missing, a resource is unavailable or access is hidden

The existing presigned-upload flag is an advertised Boolean used for attachment routing. Missing or malformed required discovery data fails resolution rather than becoming an assumed capability. Features without a reviewed discovery field remain unknown. Neither a guessed capability nor another instance's metadata should select a credential destination

## Safe failure reports

To report a failure, include the exact SDK, Effect and Node versions, operating system, default or native entry point, operation name, safe error tag, expected result and a minimal reproduction using a controlled test resource. Say whether the failure came from a local fake provider or a live instance, and which recovery or cleanup checks ran

Exclude tokens, authorization headers, OAuth codes and refresh tokens, webhook credentials, signed attachment URLs, private message bodies and unredacted request or response dumps. Reduce identifiers and payloads to synthetic examples. Application logs need independent redaction even when SDK diagnostics omit sensitive fields

Public issues and contributions are deferred until the first stable release. A private vulnerability-reporting channel is not currently published by this project. Sensitive findings must not be posted publicly or placed in ordinary diagnostic logs. Private reporting and maintainer response ownership remain prerequisites for a future stable-support commitment
