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
     * Create a webhook in a channel using the bot's permissions.
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
     * Fetch webhook metadata by decimal ID, discarding the returned token.
     * A missing webhook fails with reason notFound
     */
    fetch(id: string, options?: WebhookOperationOptions): Effect.Effect<Webhook, WebhookOperationFailure>
    /**
     * List the channel's accessible webhook metadata without pagination.
     * No tokens are retained and no webhook cache is filled
     */
    fetchForChannel(
        channelId: string,
        options?: WebhookOperationOptions,
    ): Effect.Effect<readonly Webhook[], WebhookOperationFailure>
    /**
     * List the community's accessible webhook metadata.
     * Fluxer permissions determine visibility.
     * Concurrent changes mean this is not a stable snapshot
     */
    fetchForGuild(
        guildId: string,
        options?: WebhookOperationOptions,
    ): Effect.Effect<readonly Webhook[], WebhookOperationFailure>
    /**
     * Change the supplied webhook settings, including its destination channel.
     * Returned metadata excludes credentials.
     * A failed response does not guarantee the changes were rolled back
     */
    edit(
        id: string,
        input: WebhookEdit,
        options?: WebhookOperationOptions,
    ): Effect.Effect<Webhook, WebhookOperationFailure>
    /**
     * Delete a webhook and revoke its credential.
     * Existing webhook messages remain.
     * A failure does not restore a credential that was already revoked
     */
    delete(id: string, options?: WebhookOperationOptions): Effect.Effect<void, WebhookOperationFailure>
}
