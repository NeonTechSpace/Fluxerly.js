---
"@neontechspace/fluxerly": patch
---

The supervisor no longer fails with a `SupervisorError` of reason `spawn` when it stops a child while the supervisor keeps running, such as for a reshard or an unconfirmed Identify permission, and a message to that child fails because the child is exiting on its own at that moment. The supervisor waits for that exit, or force-terminates the child at the `shutdownTimeoutMs` deadline, and then handles the exit as usual, in both APIs
