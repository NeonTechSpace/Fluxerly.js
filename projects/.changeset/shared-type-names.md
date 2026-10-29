---
"@neontechspace/fluxerly": major
---

Public type names no longer carry `Default` or `Native` prefixes, and the per-resource request option types become `RequestOptions` and `AuditedRequestOptions`

Each entry point exports a type that differs between the APIs under one name with its own shape, as `Client` already did. In `@neontechspace/fluxerly`, `RequestOptions` has `signal` and `timeoutMs`, and in `@neontechspace/fluxerly/effect` it has `timeoutMs`. `AuditedRequestOptions` adds `auditReason` in both. Notes that the removed option types carried, such as the per-page deadline of `messages.iterateSearch`, now sit on the methods that use them. The `reply` helpers of default command and event contexts take `Omit<RequestOptions, "signal">`, because they apply the handler's signal. Runtime behavior is unchanged

Migration:

| Entry point | Old name | New name |
| --- | --- | --- |
| Both | `ChannelOperationOptions`, `GuildOperationOptions`, `MessageOperationOptions`, `SendOptions`, `UserOperationOptions`, `CountOperationOptions`, `BotApplicationOperationOptions`, `MessageSearchOptions`, `AttachmentRefreshOptions`, `OAuthOperationOptions`, `InstanceResolveOptions` | `RequestOptions` |
| Both | `ChannelAuditOperationOptions`, `GuildAuditOperationOptions`, `MessageAuditOperationOptions`, `ModerationOptions`, `WebhookOperationOptions` | `AuditedRequestOptions` |
| Default | `Default` plus any name in the two rows above | `RequestOptions` or `AuditedRequestOptions` |
| Default | `Default<Name>`, such as `DefaultCanManageOptions`, `DefaultCollectorOptions`, `DefaultRestRequest`, `DefaultPrefixCommandContext`, `DefaultSupervisor`, `DefaultGuards` or `DefaultCommands` | `<Name>` |
| Effect | `Native<Name>`, such as `NativePrefixCommandContext`, `NativeSupervisor`, `NativeGuards`, `NativeCommands` or `NativeCommandRequirements` | `<Name>` |

In the default entry point, names such as `CanManageOptions`, `CollectorOptions`, `PrefixCommandsOptions`, `SupervisorChildOptions` and `RestRequest` now name the default shape, which includes `signal` where the old `Default` type did. The Effect entry point no longer exports the default-API `PrefixCommandsOptions` and `SupervisorChildOptions` shapes, and those names now refer to its own
