---
"@neontechspace/fluxerly": major
---

Test waits in both testing entry points, such as `TestRoute.next` and `idle`, no longer fail after a default 2,000 ms. Without `timeoutMs` they wait until their condition holds, the test client shuts down or, in the Effect API, the wait is interrupted, so the test runner's own timeout ends a test that hangs. An explicit `timeoutMs` still fails the wait with `TestTimeoutError`

Migration: A test that expects `TestTimeoutError` from a wait without options passes `timeoutMs`
