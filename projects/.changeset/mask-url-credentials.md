---
"@neontechspace/fluxerly": patch
---

Log records, unsafe payload records and `describeError` output now hide the user information of a URL, such as `user:password` in `https://user:password@host/path`, in both APIs. A user name without a password is hidden too, because it can be a credential on its own. The scheme, host and path stay readable, and an `@` in a path, query or fragment is left as it was
