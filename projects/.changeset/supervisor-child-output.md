---
"@neontechspace/fluxerly": major
---

Forward each supervised child's output in the supervisor's console format by default, and add the `childOutput` supervisor option with `prefix`, `inherit` and `ignore`.
Readable output labels each line with its shard or child ID. JSON output stays valid JSON Lines: A child's SDK record gains `fields.child`, another JSON object passes through unchanged and other text becomes a `supervisor.childOutput` record.
With `prefix`, children receive the supervisor's format and color through `FLUXERLY_LOG_FORMAT` and `FLUXERLY_LOG_COLOR` unless those variables are already set. Very long lines are truncated with a marker, forwarding respects output backpressure, and exit handling waits briefly for a child's final output, such as a crash stack trace.
The supervisor now logs child start, exit, crash, restart and spawn failures, and spawn errors keep their original cause. The new `logging` supervisor option accepts the client logging settings for these records

Migration: Supervised child output was previously discarded. Set `childOutput: "ignore"` to keep discarding it
