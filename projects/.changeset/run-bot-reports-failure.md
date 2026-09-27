---
"@neontechspace/fluxerly": major
---

The `runBot` function reports a failed run for the process by default, in both entry points.
When the bot stops because of a failure, it logs that failure once as an Error record with code `lifecycle.botFailed` and sets `process.exitCode` to 1. It skips the record when the client already logged the same error, such as the `lifecycle.connectionEnded` record of a rejected token, so the failure appears once. The failure is still returned, and a normal stop or an interruption reports nothing. The native API also reports a defect this way, including misuse found before any client exists, such as a missing token or a misspelled option key. In the default API, misuse throws `ConfigurationError` and a defect rejects with `SdkDefect`, which Node.js prints before it exits with a failing code.
A bot entry point therefore needs no try/catch: `await runBot({ ... })` is complete in the default API, and so is `await Effect.runPromiseExit(runBot({ ... }))` in the native API

Migration: Code that already logs the returned failure and sets the exit code can drop that handling. To keep full control of the failure output and exit status, pass `reportFailure: false`
