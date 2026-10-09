---
"@neontechspace/fluxerly": patch
---

The deploying guide and the agent guide now say which `runBot` handles SIGINT and SIGTERM by default. The default API does unless `processSignals` is `false`, while the native Effect `runBot` handles them only with `processSignals: true`, because an Effect launcher such as `NodeRuntime.runMain` already interrupts the program on both signals and an interrupted program skips the drain. Runtime behavior is unchanged
