---
"@neontechspace/fluxerly": patch
---

Cancelling a connect while a failed discovery response is being cleaned up again keeps the discovery `ConnectionError` alongside the interruption and the cleanup defect. The native Cause holds all three, and the default API's `SdkDefect` lists them as reasons. With Effect 4.0.1, the discovery failure had been dropped
