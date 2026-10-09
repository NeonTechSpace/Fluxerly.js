---
"@neontechspace/fluxerly": patch
---

A supervisor with `totalShards: "auto"` now completes its move to a larger plan when a child's shard asks to start a session, or reports one it just started, while every child stops for the move. Either message previously failed the whole supervisor with reason `protocol` instead of moving. A request during the move stays unanswered until its stopping child withdraws it, and an Identify that a child sent after its permission still counts, so the larger plan's first Identify waits `identify.minimumSpacingMs` after it
