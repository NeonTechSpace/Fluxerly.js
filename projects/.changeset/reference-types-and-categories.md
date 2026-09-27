---
"@neontechspace/fluxerly": minor
---

Export the types that public signatures already referenced, so they can be named in application code and appear in the reference.
Both entry points now export `FormatHelpers`, `SnowflakeHelpers`, `DisplayHelpers`, `PermissionBitHelpers`, `ColorHelpers`, `TextHelpers`, `LinkHelpers` and `AssetHelpers` for the helper objects, whose `tryParse` methods return a Result in the default entry point and an Effect in the Effect entry point, and `Operation`, `MessageContent`, `EditMessageOptions`, `WebhookMessageOptions`, `AuditLogFilter`, `AuditLogQueryBase`, `AuditLogIterationQueryBase`, `CommandArgumentOptionalValue` and `ErrorMatchHandlers`.
The default entry point adds `DefaultCommands` and `DefaultPrefixCommandBatch`, and the Effect entry point adds `NativeCommands`, `NativePrefixCommandBatch`, `NativeBatchRequirements`, `NativeCommandRequirements`, `NativeEffectRequirements`, `BotEventServices` and `HandlerServices`

Every public export now has a reference category, and each client method has one description shared by both entry points, with the differences between them stated separately
