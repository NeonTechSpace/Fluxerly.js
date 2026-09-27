---
"@neontechspace/fluxerly": minor
---

Make errors and log records say what went wrong and what is accepted. `HelperError` and `AssetUrlError` messages name the helper and the accepted form, for example `Helper operation format.userMention failed: IDs must be decimal strings from 0 through 9,223,372,036,854,775,807`, instead of `Invalid input for format.userMention`.
`PaginationError` messages include the input explanation or what stopped the iteration, and the error carries a `hint`: The rejected path for invalid settings, raising `maxPages` for `pageLimit`, and retrying later for `cursorStalled` and `indexing`

Input validation explanations name the field in words and state the accepted range with its unit, such as `ms`, `bytes` or `seconds`. Presence explanations name the field they describe, unsupported-field explanations list the accepted fields or the type that defines them, timeouts state their `ms` unit, and ban and timeout durations state their range in `ms` with the matching days or years.
Connection, startup and shutdown records use full sentences, such as `Shard 1 lost its connection. Close code 4000 (UNKNOWN_ERROR): The gateway reported an unspecified error. Reconnecting and resuming the session in 486 ms`, and configuration errors name the full option path, such as `connection.startupTimeoutMs`. `SupervisorError` and `SupervisorChildError` messages describe the failure and carry a hint. An instance discovery failure keeps its transport error code and says what was wrong with the response.
`CancelledError` accepts an optional operation, which is recorded as `details.operation` and named in the message, and its hint explains that signals the SDK passes to handlers abort when the client shuts down

The `inputValidation.path` and `constraint` values are unchanged. Messages remain changeable text, so match on `code`, `reason`, `field` and `inputValidation` and on log record codes instead
