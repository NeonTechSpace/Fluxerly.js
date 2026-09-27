---
"@neontechspace/fluxerly": major
---

Ban durations are milliseconds, like member timeouts, command cooldowns and the `duration` command argument. The `BanInput` fields are now `durationMs`, 0 for a permanent ban or 60,000 through 63,072,000,000 for a temporary one, and `deleteMessagesMs`, 0 through 604,800,000. Both must be whole seconds and are sent to Fluxer in seconds. A rejected ban input names the failing field, such as `input.durationMs`, and states its whole-second range

Audit-log entries report the message deletion of a member ban in milliseconds too, so the `AuditLogOptions` field `deleteMessageSeconds` is now `deleteMessagesMs`, in both API styles and in `guildAuditLogEntryCreate` events

A `duration` command argument accepts `wholeSeconds: true`, which rejects a value with a millisecond part such as `1m500ms` and adds "in whole seconds" to the rejection reply. With `wholeSeconds: true`, `min: 60_000` and `max: 63_072_000_000`, the argument's value can be passed to `durationMs` unchanged, and a moderator's out-of-range value gets the usage reply instead of a failed ban

Migration:

- Replace `durationSeconds: n` with `durationMs: n * 1000` and `deleteMessageSeconds: n` with `deleteMessagesMs: n * 1000` in ban input
- Replace `options.deleteMessageSeconds` with `options.deleteMessagesMs` on audit-log entries, and divide by 1000 where seconds are still needed
