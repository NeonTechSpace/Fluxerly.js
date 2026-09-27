---
"@neontechspace/fluxerly": major
---

Public types now use one name per concept, and API rejection details are readable in the reference, in both entry points

- `MemberSearchHit.globalName` and `OAuthIdentity.globalName` are now `displayName`, the name `User` and `MessageUser` already use for the account-wide display name. The `display.name` helper therefore reads it from member-search hits and OAuth identities too
- The deprecated `MessageMention` alias is removed. `MessageUser` is the only name for the partial-user shape in mentions and references
- `ApiErrorDetail` and `ApiValidationErrorDetail` are plain interfaces. The new `ApiErrorCode`, `ApiProviderCode` and `ApiValidationCode` unions list every recognized category and server code to branch on. The `explanation` fields are typed `string`, and `validationErrors` is present only when `code` is `invalidFormBody`
- The `@neontechspace/fluxerly/effect` entry point no longer exports the ten default-API option types `DefaultMemberChunkOptions`, `DefaultCountOperationOptions`, `DefaultBotApplicationOperationOptions`, `DefaultExpressionDeleteOptions`, `DefaultUserOperationOptions`, `DefaultWebhookOperationOptions`, `DefaultAttachmentDownloadOptions`, `DefaultAttachmentRefreshOptions`, `DefaultAttachmentStreamOptions` and `DefaultMessageCleanupOptions`. No Effect member accepts them

Migration:

- Read `displayName` instead of `globalName` on `MemberSearchHit` and `OAuthIdentity`
- Replace `MessageMention` with `MessageUser`
- Use `ApiErrorCode`, `ApiProviderCode` or `ApiValidationCode` to branch on codes. Code that compared `explanation` against literal types compares strings instead
- Effect code that imported a `Default*` option type imports it from `@neontechspace/fluxerly`, or uses the Effect option type of the same operation
