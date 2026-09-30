---
"@neontechspace/fluxerly": patch
---

Effect supervised children let running handlers, queued handler events and REST requests finish within the parent's drain allowance before closing when the parent stops them, including a move to a larger automatic shard plan. Failure still stops running work without draining

Supervisor child-run options and default readiness-wait options reject unsupported keys before waiting for the parent or observing readiness. Misspelled keys include a suggested supported name, as do assignment and Identify options

Both `runBot` entry points mask the normalized token in failure reports before a client exists, including tokens surrounded by whitespace and matching quotes

Effect `runBot` retains readable token, logging and `reportFailure` settings when an option getter throws. A throwing getter no longer discards a configured log sink, token masking or `reportFailure: false`
