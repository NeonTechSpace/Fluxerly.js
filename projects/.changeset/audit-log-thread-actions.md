---
"@neontechspace/fluxerly": major
---

Audit-log reads and `guildAuditLogEntryCreate` events no longer fail on an audit action this SDK version does not name. `AuditLogEntry.actionType` is now a `number` that keeps any action Fluxer records, including ones added later, so compare it with `AuditLogActions` values. Previously one such entry rejected its whole audit-log page and made the gateway event malformed. `AuditLogActions` gains `ThreadCreate` (110), `ThreadUpdate` (111) and `ThreadDelete` (112), which also work as `actionType` filters
