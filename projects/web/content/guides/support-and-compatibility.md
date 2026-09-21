---
title: Support and compatibility
navTitle: Support and compatibility
description: Separate SDK support, instance availability and account permissions before deploying a bot
---

Fluxerly is a Canary SDK for testing, not a stable-support or service-availability commitment. Production adoption needs an application-owned assessment of failure handling, recovery, deployment and the exact installed version

## Runtime and upgrade boundaries

| Boundary          | Current policy                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Runtime           | Node.js 24.11.0 or newer, with current security updates                                          |
| JavaScript        | ESM, without a TypeScript compiler requirement                                                   |
| TypeScript        | TypeScript 7, not TypeScript 6 or earlier                                                        |
| Native Effect     | The exact Effect peer version declared by the installed SDK                                      |
| Browser runtimes  | Not supported by the Node.js SDK                                                                 |
| Operating systems | Hosted CI uses Ubuntu. A passing Ubuntu run does not qualify every operating system or container |

The package manifest is authoritative for the installed version's runtime and peer requirements. The default API also requires the Effect peer internally, normally installed automatically by npm or pnpm. Native Effect code must use the same exact version rather than a different release candidate

Pin the SDK version and retain the application's lockfile for reproducible deployments. Review the matching changelog and rerun application tests before upgrading. Canary and RC suffixes describe release readiness, not a guarantee that upgrades preserve every application assumption. Breaking changes target the next breaking package version under the project's versioning policy

No long-term maintenance window, response-time guarantee or deprecation notice period is promised for Canary releases. A green SDK check covers its named tests, not every bot workload, provider deployment or recovery scenario

## Three different capability questions

1. **Does the SDK implement the operation?** Consult the installed version's public API reference. A method available in newer documentation may not exist in an older package
2. **Does the selected instance implement and enable it?** Discovery exposes reviewed endpoint and upload metadata, not a complete endpoint capability registry
3. **May this account perform it on this resource?** Account type, OAuth scope, guild membership and permissions remain provider decisions at request time

A provider code-version number is not an API route version or a permission check. The resolved instance snapshot is retained for one client lifetime and is not continuously refreshed. An operation returning 404 does not alone distinguish an absent feature, an unavailable resource or hidden access

The existing presigned-upload flag is an advertised Boolean used for attachment routing. Missing or malformed required discovery data fails resolution rather than becoming an assumed capability. Features without a reviewed discovery field remain unknown. Neither a guessed capability nor another instance's metadata should select a credential destination

## Safe failure reports

Useful reproduction material contains the exact SDK, Effect and Node versions, operating system, default or native entry point, operation name, safe error tag, expected result and a minimal reproduction using an owned test resource. Indicate whether the failure came from a local fake provider or a live instance and which recovery or cleanup checks were actually performed

Exclude tokens, authorization headers, OAuth codes and refresh tokens, webhook credentials, signed attachment URLs, private message bodies and unredacted request or response dumps. Reduce identifiers and payloads to synthetic examples. Application logs need independent redaction even when SDK diagnostics omit sensitive fields

Public issues and contributions are deferred until the first stable release. A private vulnerability-reporting channel is not currently published by this project. Sensitive findings must not be posted publicly or placed in ordinary diagnostic logs. Private reporting and maintainer response ownership remain prerequisites for a future stable-support commitment
