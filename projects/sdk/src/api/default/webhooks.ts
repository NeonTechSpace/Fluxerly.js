import type {
    Webhook,
    CreatedWebhook,
    WebhookCreate,
    WebhookEdit,
    WebhookOperationFailure,
    DefaultWebhookOperationOptions,
} from "#sdk/webhooks"
import type { ResultAsync } from "neverthrow"
import type { CancelledError, ConfigurationError } from "#sdk/errors"

/**
 * Manage webhooks with this bot's credentials, without connecting the gateway.
 * Use createWebhookClient for a separate client that sends using a webhook's own token.
 * Metadata excludes tokens.
 * There is no webhook cache or hidden credential storage.
 * The default total deadline, rest.defaultTimeoutMs (30,000 ms unless configured), includes capacity, rate-limit and retry waits.
 * Eligible reads have bounded retries.
 * Writes retry only confirmed rate-limit rejection.
 * Success JSON is limited to 16 MiB before parsing, not total memory.
 * Malformed or larger successes return reason response.
 * After dispatch, a failed response can leave the write applied and is not retried automatically.
 * Abort returns CancelledError after cleanup.
 * Unexpected failures reject with SdkDefect.
 * Client shutdown rejects new work and waits for active request cleanup.
 * Separate clients do not coordinate rate limits
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
        options?: DefaultWebhookOperationOptions,
    ): ResultAsync<CreatedWebhook, WebhookOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch incoming, follower or unknown-kind metadata by decimal ID, discarding any returned token.
     * Follower sources are present only while they exist and the original creator can view them.
     * Missing source metadata does not prove deletion. A missing webhook fails with reason notFound
     */
    fetch(
        id: string,
        options?: DefaultWebhookOperationOptions,
    ): ResultAsync<Webhook, WebhookOperationFailure | CancelledError | ConfigurationError>
    /**
     * List the channel's accessible incoming, follower and unknown-kind webhook metadata without pagination.
     * No tokens are retained and no webhook cache is filled
     */
    fetchForChannel(
        channelId: string,
        options?: DefaultWebhookOperationOptions,
    ): ResultAsync<readonly Webhook[], WebhookOperationFailure | CancelledError | ConfigurationError>
    /**
     * List the community's accessible incoming, follower and unknown-kind webhook metadata.
     * Fluxer permissions determine visibility.
     * Concurrent changes mean this is not a stable snapshot
     */
    fetchForGuild(
        guildId: string,
        options?: DefaultWebhookOperationOptions,
    ): ResultAsync<readonly Webhook[], WebhookOperationFailure | CancelledError | ConfigurationError>
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
        options?: DefaultWebhookOperationOptions,
    ): ResultAsync<Webhook, WebhookOperationFailure | CancelledError | ConfigurationError>
    /**
     * Delete an incoming webhook and revoke its credential, or delete a follower webhook to unfollow its source.
     * Existing webhook messages remain. Fluxer emits Webhooks Update for the destination channel.
     * The SDK does not synthesize that event. A failure does not restore a deleted follow or revoked credential
     */
    delete(
        id: string,
        options?: DefaultWebhookOperationOptions,
    ): ResultAsync<void, WebhookOperationFailure | CancelledError | ConfigurationError>
}
