import type { User, UserProfile, UserProfileQuery, UserOperationFailure } from "#sdk/users"
import type * as Effect from "effect/Effect"
import type { RequestOptions } from "#sdk/client"

/** Read public account information or a privacy-filtered profile.
 * Methods return Effects with the client's default deadline (rest.defaultTimeoutMs, 30,000 ms unless configured) and at most two eligible transient read retries.
 * Writes retry only confirmed rate-limit rejection, never an unknown outcome. No gateway connection is required.
 * Cancellation and unexpected faults remain in Cause rather than becoming UserOperationError
 *
 * @category Users and DMs
 */
export interface Users {
    /**
     * Look up a public account in the optional cache using its decimal ID, without a request.
     * A hit may be stale and becomes more recently used without extending its age.
     * A miss produces undefined.
     * An invalid ID is misuse: The default API throws UserOperationError with reason input and the native API dies with it.
     * A closing or closed client has no cache, so the result is undefined
     */
    get(id: string): Effect.Effect<User | undefined>
    /**
     * Look up the bot's own public account as the gateway's READY reported it, without a request.
     * The result is undefined until this client's first READY, and also while no READY has carried a complete public account.
     * A later READY with a complete public account, such as for a new session, replaces it, while an incomplete one keeps the previous account.
     * Other user updates and fetchSelf results do not change it, so its username or avatar can be stale.
     * The value remains available after the client stops.
     * This lookup never fails. Use fetchSelf for a current remote snapshot
     */
    getSelf(): Effect.Effect<User | undefined>
    /**
     * Fetch a public account snapshot by decimal user ID.
     * An unknown user fails with reason notFound rather than an empty result.
     * With the user cache enabled, a concurrent fetch of another user ID does not keep this result from being stored, unless more than 256 user IDs are being read at once
     */
    fetch(id: string, options?: RequestOptions): Effect.Effect<User, UserOperationFailure>
    /**
     * Fetch a user's privacy-filtered profile, optionally for the community specified in query.guildId.
     * The frozen result includes only documented identity and profile fields.
     * The isLimited field reports Fluxer's privacy restriction, not missing community membership.
     * A guildProfile of null means no contextual profile was supplied, not proof the user is outside the community.
     * No gateway connection, hidden member fetch or account or profile cache use is performed, and each call issues a separate read.
     * Users' shared deadlines and eligible read retries apply.
     * Fluxer may clear expired premium state while serving this GET.
     * Invalid input, denied access or a malformed response fails with UserOperationError for users.fetchProfile.
     * Cancellation affects this request only and waits for cleanup
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export function profileExample(client: Client, userId: string, guildId: string) {
     *     return client.users.fetchProfile(userId, { guildId })
     * }
     * ```
     */
    fetchProfile(
        id: string,
        query?: UserProfileQuery,
        options?: RequestOptions,
    ): Effect.Effect<UserProfile, UserOperationFailure>
    /**
     * Fetch the authenticated bot's public account data remotely.
     * Private account fields are excluded.
     * With the user cache enabled, the bot's ID is unknown until the response arrives, so some concurrent user cache changes keep the result out of the cache.
     * Examples are another users.fetch or users.fetchSelf call, a user update event and a lost gateway connection
     */
    fetchSelf(options?: RequestOptions): Effect.Effect<User, UserOperationFailure>
}
