---
"@neontechspace/fluxerly": patch
---

Retain the gateway command pacing history across Resume within a running client, so reconnecting cannot restart a full send budget while Fluxer still counts the previous session's commands. A fresh Identify starts a new budget

Withdraw unsent community-count, channel-member-count and member-chunk requests when cancelled or timed out, preventing stale requests from being sent later. Bound internal waiting commands and report queue pressure through the existing busy failures

Release a cancelled, unsent `gateway.send` command's local queue capacity immediately, so replacement work can wait instead of failing as busy until the pacing window opens. Queued commands are still abandoned on disconnect rather than replayed

Coalesce outgoing status changes to one unsent update per shard, keeping only the latest intent while the gateway send budget is full. Measure the four-second interval from actual transmission, and avoid retaining timers that already fired during scheduling

Replace queued member-presence selections with the latest IDs and withdraw an unsent selection when cleared. Start member-selection spacing at actual transmission, so pacing delays cannot flush obsolete selections or clears together
