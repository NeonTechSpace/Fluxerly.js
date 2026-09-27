---
"@neontechspace/fluxerly": major
---

Log startup, readiness, lost connections with the close-code meaning and the real next step, session resets, long rate-limit waits, event drops, shutdown and every application failure by default.
Records share one shape with a level, category, stable code, message and safe fields, and never contain the token, authorization values, client secrets, webhook tokens or invite codes

Configure output through `logging` with `level`, per-category `categories`, `debug`, `format`, `sink`, `dedupe` and `unsafe` settings, or set `FLUXERLY_DEBUG=1` or a list of categories for Debug records.
The default API prints readable lines in a terminal and JSON lines otherwise, deciding separately for standard output and standard error. Readable lines show the record code after the category, print safe details for every error in the cause chain and collapse stack frames inside the SDK and Effect into one line. The `FLUXERLY_LOG_FORMAT` and `FLUXERLY_LOG_COLOR` environment variables choose the format and color for a client without `format`. The color variable accepts `1`, `true`, `yes` or `on` to force color and `0`, `false`, `no` or `off` to disable it, and an unrecognized value of either variable logs one `sdk.unknownEnvironmentValue` Warn.
Without `sink` or `format`, the native Effect API logs through the caller's Effect logger with `fluxerly.*` annotations, including `fluxerly.error.code`, `fluxerly.error.hint` and `fluxerly.error.*` details for a failure. Each error in the cause chain adds its own annotations under `fluxerly.error.cause.`, then `fluxerly.error.cause.cause.` and so on. Its records carry masked copies of failures that show their code, so Effect's cause printer never shows credentials or extra error properties.
Repeated Warn and Error records are collapsed with a repeat count, and `diagnostics().counters` counts failures, drops, retries, rate-limit waits, reconnects and resumes.
A rate limit whose wait would pass the request deadline fails the request at once, logs `ratelimit.deadline` and is not counted as a wait.
Failure reports logged instead of reaching an `onError` hook carry `fields.reportOutcome` (`queueFull`, `interrupted`, `clientClosed` or `subscriptionClosed`), and collapsed records carry the suppressed count in `fields.repeated`.
The `lifecycle.retry` and `lifecycle.connectionLost` records carry `fields.next`, which is `resume` or `identify` and names the next handshake

Unsafe payload logging prints its Warn banner once before the first payload record at any level, prints nothing for a `silent` category and reads at most the first 64 KiB of each received REST body

The native API also records `fluxerly.*` tracing spans for gateway connection, REST requests, event handling and command execution, plus REST duration, rate-limit wait, reconnect, drop and handler-failure metrics

Migration: The `development`, `measurements`, `minimumLevel` and `logger` logging settings, `fromStructuredLogger` and `fromEffectLogger` are removed.
Use `level` and `categories` for levels, `debug` or `FLUXERLY_DEBUG` for Debug records, and `sink` to forward records to another logger.
The types `DefaultLogger`, `DefaultLoggingOptions`, `StructuredLogger`, `SdkLifecycleEvent`, `SdkLifecycleLogRecord`, `SdkOperationalLogRecord`, `SdkMeasurementLogRecord`, `SdkMeasurementOperation` and `SdkMeasurementStage` are removed. `SdkLogLevel` is renamed to `LogLevel` and its values are now lowercase, such as `"info"`. The `All` and `None` values are removed, and `level: "silent"` replaces `None`. `SdkLogRecord` is renamed to `LogRecord`, which has a new shape.
Clients now print startup, readiness, connection loss and shutdown at Info by default. Set `level: "warn"` to print only problems.
The Effect API's `MessageCacheOptions<E, R, M>` is now `MessageCacheOptions<M>`, because cache callback failures go to the client's `onError` rather than a cache-specific hook
