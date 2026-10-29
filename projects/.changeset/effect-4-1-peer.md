---
"@neontechspace/fluxerly": major
---

Require Effect 4.1.0 or newer. The `effect` peer range is now `^4.1.0`, so every supported Effect release reports combined failures the same way.
Since Effect 4.0.6, an expected failure that occurs together with a defect, such as a cleanup fault, is reported as a defect that keeps the failure's value. In the default API, such an `SdkDefect` lists the original error as a `Defect` reason instead of a `Failure` reason, while its cause, message and code still come from the actual fault, such as the cleanup failure. In the native API, the Cause holds the original error as a `Die` next to the cleanup defect, so `catchTag` no longer recovers from it. The original error is still the public one, such as `MessageOperationError` or `ConnectionError`, never an internal REST or gateway failure

Migration: Update Effect to 4.1.0 or a later Effect 4 release. Code that read the `Failure` reason of an `SdkDefect` to find the original error should also look at its `Defect` reasons
