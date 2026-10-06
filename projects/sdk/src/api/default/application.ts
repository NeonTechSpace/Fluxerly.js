import type {
    BotApplication,
    BotApplicationOperationFailure,
    DefaultBotApplicationOperationOptions,
} from "#sdk/application"
import type { ResultAsync } from "neverthrow"
import type { CancelledError, ConfigurationError } from "#sdk/errors"

/**
 * Read the authenticated bot's application identity, its owner's user ID and selected public settings.
 * No gateway connection, application management or authorization-page navigation is performed.
 * The GET uses shared request limits, the client's default deadline (rest.defaultTimeoutMs, 30,000 ms unless configured) and at most two transient read retries.
 * The frozen result is not cached.
 * Of the owner only the user ID is kept, and redirect URIs, verification keys, client secrets and nested bot fields are excluded.
 * Fluxer decides application visibility and installability.
 * Input, HTTP and malformed-response failures return BotApplicationOperationError.
 * Closure returns ClientClosedError.
 * Abort waits for cleanup and returns CancelledError.
 * Unexpected failures reject with SdkDefect
 *
 * @example
 * ```ts
 * import { links, type Client } from "@neontechspace/fluxerly"
 * export async function applicationExample(client: Client) {
 *     const application = await client.application.fetch()
 *     return application.isErr() ? application : links.installation(application.value.id, { permissions: 0n })
 * }
 * ```
 *
 * @category Client and lifecycle
 */
export interface CurrentBotApplication {
    /**
     * Fetch this bot token's application data from /oauth2/applications/@me.
     * Only the documented fields are returned, frozen, without cache storage, gateway events, owner profile lookup or follow-up requests
     */
    fetch(
        options?: DefaultBotApplicationOperationOptions,
    ): ResultAsync<BotApplication, BotApplicationOperationFailure | CancelledError | ConfigurationError>
}
