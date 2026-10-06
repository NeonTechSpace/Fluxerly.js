import type { BotApplication, BotApplicationOperationFailure, BotApplicationOperationOptions } from "#sdk/application"
import type * as Effect from "effect/Effect"

/** Read the application associated with this bot token through GET `/oauth2/applications/@me`.
 * No gateway connection is required.
 * Effects start when executed and can be run again, using the caller's services with the shared 30-second total deadline and at most two transient read retries.
 * Returns a frozen set of documented application fields, including the owner's user ID, without caching. Other owner details, redirect URIs, verification keys, client secrets, and nested bot fields are never exposed.
 * Fluxer remains authoritative for application visibility and installability. This read neither manages an application nor opens an authorization page.
 * Input, HTTP, and malformed-response failures use BotApplicationOperationError. Closure uses ClientClosedError. Interruption and defects remain in the Cause
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { links, type Client } from "@neontechspace/fluxerly/effect"
 * export const applicationExample = (client: Client) => Effect.gen(function* () {
 *     const application = yield* client.application.fetch()
 *     return links.installation(application.id, { permissions: 0n })
 * })
 * ```
 *
 * @category Client and lifecycle
 */
export interface CurrentBotApplication {
    /**
     * Fetch this bot token's application data from /oauth2/applications/@me.
     * Only the documented fields are returned, frozen, without cache storage, gateway events, owner profile lookup or follow-up requests
     */
    fetch(options?: BotApplicationOperationOptions): Effect.Effect<BotApplication, BotApplicationOperationFailure>
}
