---
"@neontechspace/fluxerly": major
---

Report every failure that has no returned result, including throwing event handlers, failed commands, collector callbacks and filters, cleanup progress callbacks, message cache callbacks, state observers and overflowing subscriptions.
Each failure goes to the subscription's `onError`, then the client's new `onError` option, or is logged at Error with its full message, stack and cause chain.
A `FailureReport` carries the original thrown value unchanged, its kind, and the event, command, subscription and message IDs involved, and `describe()` returns readable text. Native reports also keep the Effect cause

A failure only queues its report. Each client, subscription and command router hook receives reports one at a time in order through its own bounded queue, so a slow hook never holds up handlers.
Later reports are logged and counted instead, and a failing hook is logged together with the original failure without being retried.
Shutdown interrupts running hooks without waiting for one that never finishes, and logs the interrupted and queued reports.
Command routers now report failures with the command name, including failed `onUnmatched` callbacks and parsers, and rejected or unmatched commands are logged at Debug and counted

Migration: `HandlerErrorReport` is replaced by `FailureReport`, and the message cache `onError` option and `CachePolicyErrorReport` are removed in favour of the client's `onError`.
A message cleanup `onProgress` callback that throws, rejects or returns an Err is now reported to `onError` with kind `progress` instead of being ignored, and cleanup continues. The callback stays synchronous, so a returned Effect is not run and is reported as a `TypeError`.
`SdkDefect` now keeps each fault's original value in `reasons` and its first fault as `cause`. A fault from an application callback, or a throw while the SDK reads caller-supplied options or input, such as a property getter or a caller AbortSignal's `aborted` getter or listener methods, has origin `application` and code `application.defect`. Other faults, including faults in SDK work around those reads, have code `sdk.defect`
