---
"@neontechspace/fluxerly": patch
---

The test clients of both testing entry points now see every unhandled failure, whatever their logging settings. Previously `failures()` and the shutdown check read failures from the captured log records, so a test client with a logging level above `error` or a silent `events` or `commands` category hid a broken handler, and shutdown passed. A failure repeated within the log deduplication window also appeared in `failures()` only once, and shutdown then rejected for the summary of the suppressed repeats. Each failure now appears in `failures()` once and counts for shutdown, while `logs()` still follows the logging settings
