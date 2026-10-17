---
"@neontechspace/fluxerly": patch
---

The supervisor `waitForClose` method now returns success after a normal shutdown even when a child's stop request fails because the child is exiting on its own at that moment. It previously returned a `SupervisorError` of reason `spawn`. The shutdown completes once the child exits, or at the `shutdownTimeoutMs` deadline for a child that is still running, in both APIs
