import type {
    Webhook,
    CreatedWebhook,
    WebhookCreate,
    WebhookEdit,
    WebhookOperationFailure,
    WebhookOperationOptions,
} from "#sdk/webhooks"
import type * as Effect from "effect/Effect"

/** Create and manage webhooks with the bot token, without a gateway connection.
 * No webhook cache, hidden credential persistence or synthesized events.
 * Successful JSON responses are limited to 16 MiB before parsing. This is not a total memory limit. Malformed or larger responses fail with reason response.
 * If a response fails after a write was sent, the write may still have applied. The SDK does not retry it automatically.
 * Each Effect starts when executed, with Effect interruption and defects.
 * Requests default to a 30-second total deadline, allow bounded read retries and retry writes only after confirmed rate-limit rejection.
 * Shutdown rejects new work and awaits accepted request cleanup. Separate clients do not coordinate rate limits
 *
 * @category Invites and webhooks
 */
export interface Webhooks {
    /**
     * Create an incoming webhook in a text, voice or announcement channel using the bot's permissions.
     * The result separates metadata from redacted credentials, which expose the token only through revealToken.
     * Credentials passed to createWebhookClient must remain private.
     * An unknown outcome may have left the webhook created
     */
    create(
        channelId: string,
        input: WebhookCreate,
        options?: WebhookOperationOptions,
    ): Effect.Effect<CreatedWebhook, WebhookOperationFailure>
    /**
     * Fetch incoming, follower or unknown-kind metadata by decimal ID, discarding any returned token.
     * Follower sources are present only while they exist and the original creator can view them.
     * Missing source metadata does not prove deletion. A missing webhook fails with reason notFound
     */
    fetch(id: string, options?: WebhookOperationOptions): Effect.Effect<Webhook, WebhookOperationFailure>
    /**
     * List the channel's accessible incoming, follower and unknown-kind webhook metadata without pagination.
     * No tokens are retained and no webhook cache is filled
     */
    fetchForChannel(
        channelId: string,
        options?: WebhookOperationOptions,
    ): Effect.Effect<readonly Webhook[], WebhookOperationFailure>
    /**
     * List the community's accessible incoming, follower and unknown-kind webhook metadata.
     * Fluxer permissions determine visibility.
     * Concurrent changes mean this is not a stable snapshot
     */
    fetchForGuild(
        guildId: string,
        options?: WebhookOperationOptions,
    ): Effect.Effect<readonly Webhook[], WebhookOperationFailure>
    /**
     * Change the supplied incoming or follower webhook settings, including its destination channel.
     * Followers can be renamed or moved to a text channel in the same community, but an avatar change fails
     * with field avatar and Fluxer code INVALID_FORMAT. Incoming webhooks allow text, voice or announcement destinations.
     * Moving emits Webhooks Update for the old and new channel. The SDK does not synthesize those events.
     * Returned metadata excludes credentials. A failed response does not guarantee the changes were rolled back
     */
    edit(
        id: string,
        input: WebhookEdit,
        options?: WebhookOperationOptions,
    ): Effect.Effect<Webhook, WebhookOperationFailure>
    /**
     * Delete an incoming webhook and revoke its credential, or delete a follower webhook to unfollow its source.
     * Existing webhook messages remain. Fluxer emits Webhooks Update for the destination channel.
     * The SDK does not synthesize that event. A failure does not restore a deleted follow or revoked credential
     */
    delete(id: string, options?: WebhookOperationOptions): Effect.Effect<void, WebhookOperationFailure>
}
