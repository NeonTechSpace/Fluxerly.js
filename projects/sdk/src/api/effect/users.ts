import type { User, UserProfile, UserProfileQuery, UserOperationFailure, UserOperationOptions } from "#sdk/users"
import type * as Effect from "effect/Effect"

/** Read public account information or a privacy-filtered profile.
 * Methods return Effects with shared 30-second default deadlines and at most two eligible transient read retries.
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
     * Fetch a public account snapshot by decimal user ID.
     * An unknown user fails with reason notFound rather than an empty result.
     * An enabled user cache admits this ID independently of unrelated targeted user reads
     */
    fetch(id: string, options?: UserOperationOptions): Effect.Effect<User, UserOperationFailure>
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
        options?: UserOperationOptions,
    ): Effect.Effect<UserProfile, UserOperationFailure>
    /**
     * Fetch the authenticated bot's public account data remotely.
     * Private account fields are excluded.
     * Because its ID is not known before the response, enabled user-cache conflict handling is collection-wide, so a later cache change can prevent the result from being stored
     */
    fetchSelf(options?: UserOperationOptions): Effect.Effect<User, UserOperationFailure>
}
