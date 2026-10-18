---
"@neontechspace/fluxerly": patch
---

The Effect API `supervisor.child.run` helper now succeeds when the parent stops the child before its gateway session is ready, as the default API helper already did. It previously failed with `ClientClosedError` after that normal stop
