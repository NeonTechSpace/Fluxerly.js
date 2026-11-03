---
"@neontechspace/fluxerly": minor
---

Errors classify failures more precisely and give better hints:

- A failed `directMessages.fetchLatestMessages` call is now reported as a read. A network failure or timeout no longer says the change may have been applied, `details.read` is true, and `errors.isRetryable` returns true for it. The SDK still does not send it again automatically
- A failed `messages.previewCleanup` now counts as a read. Its error no longer warns that a change may have applied, and `errors.isRetryable` returns true when a network failure or timeout interrupted it. A failed cleanup batch keeps its warning. A `members.fetchCanManage` whose answers cannot be evaluated, such as a member with a role missing from the role list, now also fails as a read without that warning
- A message send, reply, webhook message or upload that read an attachment from a `ReadableStream` and was then rate-limited now sets `details.streamUsed`, so `errors.isRetryable` returns false, because repeating the call would send the used stream. Its hint says to wait and send again with a new stream or with the file as bytes. This covers inline uploads and presigned uploads, whose stream is read before the message request. A stream the upload never read, such as an inline upload rate-limited while an earlier file was still being sent, and a Blob or File stay retryable. The `MessageError` constructor accepts `streamUsed` like the other operation errors
- A webhook message, or a message on an instance without direct uploads, that carries a Blob, File or stream attachment and is rate-limited now logs a Warn record with the new code `ratelimit.notResent` before it fails with reason `rateLimit`. Its body cannot be sent twice, so the SDK cannot wait and send it again
- Shutdown during an attachment download now fails it with `ClientClosedError`, as documented, instead of a retryable network failure. This covers opening the download in both APIs and reading a buffered download
- A response that describes another resource than the one requested, such as a member read that returns a different user, now fails with `details.responseField` `targetMismatch`. This covers reads of users, communities, channels and members, edits of communities, channels and threads, active thread lists, created invites and opened direct messages. The error no longer names an unrelated field, such as `Field flags is missing or has the wrong type`
- A success status other than the one an operation expects now fails with `details.responseField` `status`, and its `rest.responseRejected` record names that check in `fields.field`. An attachment upload plan or completion answer of the wrong shape names `attachments` or `uploads`
- An `OAuthOperationError` with reason `response` now names the field Fluxer's answer got wrong in `details.responseField` and in its message, such as `expires_in`, as REST errors already do. The value itself is never kept. The constructor accepts the new `responseField` option
- A Fluxer validation entry that names a field without a code, such as an invalid badge cursor for `instance.fetchBadges`, is now kept in `apiError.validationErrors` with its `path` and an empty `providerCode`. It used to be dropped, which left an empty list
- An error's `toJSON` now follows an ordinary `Error` cause's own cause, such as the DNS failure inside a `TypeError: fetch failed`, as an optional nested `cause`, with the same masking and nesting limit as SDK causes
- A defect in the cleanup of an Effect scheduled task that shutdown interrupted, such as a scoped resource whose release fails, now fails shutdown and is logged as `lifecycle.cleanupFailed`, so `runBot` ends with a failure and the process exits with code 1. It used to be logged as a task failure while shutdown succeeded
- A defect raised in the cleanup of a native `onError` hook that shutdown interrupted now fails shutdown as a cleanup fault and is logged as `lifecycle.cleanupFailed` and counted, as other cleanup faults are. It used to be dropped, so shutdown reported success
- A wrong or deleted webhook token, which Fluxer answers with `UNKNOWN_WEBHOOK` and HTTP 404, now logs the promised `rest.rejected` Warn and gets the hint to check the webhook ID and token, instead of a hint about bot access. Other 404s, and a bot looking up a missing webhook, are unchanged
- A download that the media server refuses with a non-2xx status now says the media server refused it and suggests fetching the message again for a current URL, instead of saying the answer had the wrong format and pointing at test fixtures
- A rejection with HTTP 423, which Fluxer sends while another change holds a role order, channel order or community settings lock, now has a hint to wait `retryAfterMs` and send again

These messages and hints change:

- A refused send or typing request names Send messages in threads for threads, and a refused channel deletion names Manage threads for threads
- A refused `channels.edit` on a thread explains Fluxer's thread rules: Renaming or archiving another member's thread, changing its slowmode or flags, unlocking it or changing a locked thread needs Manage threads in the parent channel
- Timed-out bots and text blocked by an instance's content filter get their own hints instead of the permission and role hint
- The `CONTENT_BLOCKED` hint says that text, a link or a file can be blocked, since Fluxer also blocks uploads by file hash
- The hint for `featureTemporarilyDisabled` no longer says to retry later. Fluxer sends it when instance staff turned the operation off for the community or the instance, so it says that retrying does not help
- The `explicitContentCannotBeSent` code has a hint that names the community's explicit content filter and a direct message recipient's media setting
- The `DIRECT_MESSAGES_DISABLED` code now says the Fluxer instance turned off direct messages, not that the recipient refuses them
- The `CANNOT_MODIFY_SYSTEM_WEBHOOK` code now says Fluxer does not allow editing, pinning or starting a thread from a system message, and gets a hint
- The missing-access hint covers private threads the bot was not added to
- The `rest.rejected` hint names Send messages only for sending a message, and role order only for actions on one member, so clearing reactions or reading bans no longer gets the wrong fix
- The `rest.rejected` Warn for a refused message send also names Send messages in threads for threads, matching the operation error
- The `rest.rejected` Warn for a refused unban names Ban members and no longer asks to move the bot's role, because Fluxer checks no role order for an unban
- A refused `members.addRole` or `members.removeRole` logs a hint that names Manage roles and a bot role above the role, instead of a role above the member's
- A webhook refused when it reads, edits or deletes a message it did not send is told to use its own message, instead of being told to grant the bot's role a permission
- A rejected OAuth user access token also says that a closed or temporarily banned account is refused even with a fresh token
- The `invalid_grant` hint for a code exchange names the PKCE verifier, which Fluxer also answers with that error
- A `members.search` denied by the SDK's own ManageGuild check says the search was not sent and how to fix it
- The presence limit hint no longer offers clearing as a way to free a community slot
- The invalid message flags error explains what a voice message also needs
- The malformed-answer hint names `details.responseField` only when the error has it
- The `gateway.ignoredEventRegistered` Warn says that `messageCreate` still receives messages that mention the bot directly, with @here or with @everyone
- The 4009 close diagnostic says the gateway received no heartbeat from the bot in time, instead of blaming a missing acknowledgement
- Calling `waitForReady` before `start` says the supervisor is not running and to call `start` first, and a supervisor `spawn` failure covers a failed message to a running child
