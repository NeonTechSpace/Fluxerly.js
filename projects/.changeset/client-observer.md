---
"@neontechspace/fluxerly": minor
---

Add the `observe` client option to export metrics and traces from either entry point to any monitoring system.
The observer receives one frozen `Observation` for each finished REST request attempt, with its method, route template, status, duration and attempt number, each rate-limit wait, each reconnection attempt, each resumed session, and each finished handler or command invocation, with its duration, outcome and the error name and code of a failure.
Observations never contain tokens, payloads or message content, and route templates replace IDs with placeholders.
The observer runs synchronously and independently of the logging settings. An observer that throws is counted in `diagnostics().counters.sinkFailures` without changing SDK work. The Effect API keeps its Effect metrics and spans and calls the same observer
