---
"@neontechspace/fluxerly": patch
---

Keep the original OAuth response cleanup failure when reader cancellation or release fails, as REST and discovery cleanup already do. The native Cause holds it as the defect, the default API's `SdkDefect` holds it as its cause, and several failures arrive as one `AggregateError`. Response bodies never become part of it
