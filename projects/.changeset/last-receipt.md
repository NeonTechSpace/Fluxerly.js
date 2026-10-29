---
"@neontechspace/fluxerly": minor
---

Both `Client` interfaces have a new read-only `lastReceipt` property: The receipt of the most recently accepted event, as `EventContext.receipt` numbers events, or 0 before the first. It is read live and counts every accepted event, whether or not a handler receives it. Work that is not an event, such as a timer or a command's follow-up, can record it when it starts and treat any event with a larger receipt as newer, for example to drop a result that a later edit made stale. Under a supervisor each child process numbers its own events, so values from different processes cannot be compared
