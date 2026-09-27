---
"@neontechspace/fluxerly": major
---

Command `id` arguments now accept only IDs in the 64-bit ID range, in both entry points. A valid ID is a nonzero decimal without leading zeroes, up to `9223372036854775807`.
The same limit applies to IDs inside the accepted mention forms.
The value `0` and longer or larger values are now rejected as `Invalid` before the command runs.
Commands that relied on `0` or out-of-range tokens reaching the handler need a `custom` argument instead
