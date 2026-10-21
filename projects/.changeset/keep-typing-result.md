---
"@neontechspace/fluxerly": minor
---

Behavior change: `messages.keepTyping` now returns the task's own result when a later typing refresh fails. Before, the default API returned `Err` with the typing failure even when the task succeeded, which lost the task's value, and the Effect API combined the refresh failure with the task's `Cause`. Now a refresh failure stops the refreshes without interrupting the task, and it logs one Warn record with the new code `rest.typingRefreshStopped`, whose `fields.channelId` names the channel and whose `error` holds the typing failure. A task that succeeds returns its value, and a task that fails returns only its own failure. A refresh stopped by client closure is not logged. The first typing request still has to succeed before the task starts, and its failure still fails the call. A defect in the refresh work still surfaces as `SdkDefect` in the default API and in the `Cause` in the Effect API

Code that relied on the `Err` or the combined `Cause` to learn about a failed refresh should read the `rest.typingRefreshStopped` record from the logging sink instead.

Before, client closure during the task also returned `ClientClosedError` (`Err` in the default API, `Fail` in the Effect API), and now the task's own result is returned. Code that detected shutdown that way should watch the client's `state` or `observeState` instead
