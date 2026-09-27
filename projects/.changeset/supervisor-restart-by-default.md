---
"@neontechspace/fluxerly": major
---

Supervisors now restart a crashed child by default, with the documented defaults of `SupervisorRestartOptions`: Up to 3 restarts in a row, delays from 1,000 ms doubling up to 30,000 ms, and a fresh budget after 60,000 ms of healthy running. Previously an omitted `restart` option meant that one crashed child stopped the whole supervisor and took every shard offline. The `restart` option now also accepts `false`, and the `supervisor.crash` record names that setting when it stops the supervisor

Restart budgets now count consecutive crashes instead of every crash over a child's lifetime. A child that runs for the new `restart.healthyResetMs` (default 60,000 ms) after finishing configuration gets its full budget and the first delay back at its next exit. When that restores used restarts, the `supervisor.restart` record has `fields.budgetReset` set to true. A crash loop still exhausts `maxAttempts` and stops the supervisor

Migration:

- To keep the previous behavior, where one unexpected child exit stops the supervisor, set `restart: false`
- To keep a lifetime-wide budget in practice, set `restart.healthyResetMs` to a period longer than the expected process lifetime, up to 2,147,483,647 ms. The `restarts` count in `status()` child snapshots also starts again after such a reset
