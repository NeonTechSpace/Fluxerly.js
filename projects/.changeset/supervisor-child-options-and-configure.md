---
"@neontechspace/fluxerly": patch
---

In the default API, a `configure` callback of `supervisor.child.run` that throws or rejects makes `child.run` reject with `SdkDefect` code `application.defect`. Its cause is an `ApplicationError` with source `supervisor child configure`, whose own cause is the original value
