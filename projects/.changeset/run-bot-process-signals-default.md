---
"@neontechspace/fluxerly": major
---

The default API's `runBot` now handles SIGINT and SIGTERM unless `processSignals` is `false`. Ctrl+C or a stop from a process manager such as Docker, systemd or PM2 requests a normal stop that drains running work for `drainMs`, then the listeners are removed and the process can exit. The runner still never exits the process itself, and `processSignals: true` is no longer needed

The Effect API's `runBot` keeps process signals opt-in. A launcher such as `NodeRuntime.runMain` already interrupts the program on these signals, and a second handler would race its interruption. Set `processSignals: true` there only when nothing else handles the signals

Migration: An application that handles SIGINT or SIGTERM itself, or runs several bots in one process with its own shutdown, passes `processSignals: false` to the default `runBot`
