---
"@neontechspace/fluxerly": patch
---

The supervisor now logs why before it acts. A child that misses `startupTimeoutMs` logs `supervisor.startupTimeout` at Error before the supervisor shuts down. A child force-terminated after ignoring a stop request logs `supervisor.terminated` at Warn, and one that lost its message channel and kept running logs it at Error before the supervisor shuts down. A child that does not confirm sending Identify within 5 seconds of its permission logs `supervisor.identifyUnacknowledged` at Warn before it is stopped. A failed read of a child's output, which ends forwarding of that stream while the child keeps running, logs `supervisor.outputFailed` at Warn with the error. A failed message send to a child now keeps its error in the `supervisor.spawnFailed` record
