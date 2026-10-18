---
"@neontechspace/fluxerly": patch
---

Nightly builds replace Canary releases. A nightly is an automatic build of the latest source, published under the `nightly` npm tag on days when the SDK changed, with a version such as `1000.0.0-nightly.20261019.57`, which carries the UTC build date and the run number. Run numbers only grow but can skip values, while the core of a nightly version can drop when a pending major or minor note is removed. Like an RC, a nightly can include breaking changes, so install it with `--save-exact`, or `--exact` with Bun. The Canary versions were removed from npm, so they can no longer be installed
