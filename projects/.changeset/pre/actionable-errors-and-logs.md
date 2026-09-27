---
"@neontechspace/fluxerly": major
---

Make request errors say what to change. Rejections carry a `hint` for missing permissions or access, naming what a message send or a moderation action needs, unknown IDs, rejected tokens, invalid form fields, refused direct messages, two-factor requirements, slowmode, resource limits and temporary Fluxer failures, with a fallback by HTTP status for 401, 403 and 404.
A rejected credential gets a hint for the credential the request sent: The webhook ID and token for a webhook client, the OAuth client ID and secret for an `invalid_client` error or a 401 from a code exchange, refresh, revocation or introspection, and the user's access token for a 401 from `fetchIdentity`, `fetchGuilds` or `fetchConnections`.
Operation error messages lead with the failed operation and Fluxer's answer, for example `Message send failed: Fluxer reports that the bot lacks a required permission (MISSING_PERMISSIONS, HTTP 403)`, and explanations name Fluxer instead of "the provider"

Keep Fluxer error codes that this SDK version does not describe yet. An uppercase code of up to 64 characters is recorded as `details.providerCode` and named in the message while `apiError` stays `null`, and an unrecognized validation code stays in `apiError.validationErrors` with its field path and a generic explanation. `OAuthOperationError` and `MessageCleanupError` keep unrecognized codes the same way.
A response that does not match the expected shape names the failing field or check, such as `type` or `channelMismatch`, in `details.responseField` and logs a `rest.responseRejected` Warn. A message cleanup that fails in a history read or batch request copies that step's `details.responseField`. A `client.rest.request` route has no expected shape, so its unusable response is only returned in the Result.
The `members.fetchCanManage` and `permissions.fetch` checks keep these facts and the failed step's error as `cause` when they report a failure under their own operation name.
`OperationErrorOptions` and the `MessageError` and `MessageCleanupError` constructors accept `providerCode` and `responseField`, and the `OAuthOperationError` constructor accepts `providerCode`

Log HTTP 401 and 403 rejections as a `rest.rejected` Warn with the Fluxer code and hint, even when the application handles the Result. When an event handler or command fails with the rejection and no `onError` hook receives the failure, the handler's failure record reports it instead, so one failed reply is logged once. Webhook clients and OAuth clients accept the same `logging` option as a client, so their rejected webhook tokens and OAuth client credentials are logged the same way. A rejected OAuth user access token concerns one user and is only returned. Like other Warn records, identical repeats within one minute are printed once by default, so a rejection that keeps happening shows about once a minute with a repeat count. Other client rejections are logged at Debug, and `rest.request` Debug records carry the Fluxer code in `fields.apiError`

A `ConfigurationError` thrown by the default `createClient` or `runBot` points at the caller's line

Migration: `ApiValidationErrorDetail.providerCode` is now `ApiValidationCode | (string & {})`, so code that assigns it to an `ApiValidationCode` must narrow it first.
Operation error message text changed, so match on `code`, `reason` and `apiError` rather than on messages
