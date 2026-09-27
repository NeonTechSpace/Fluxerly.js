import type { User, UserProfile, UserProfileQuery, UserOperationFailure, DefaultUserOperationOptions } from "#sdk/users"
import type { ResultAsync } from "neverthrow"
import type { CancelledError, ConfigurationError } from "#sdk/errors"

/**
 * Read public user account and profile data, without connecting the gateway.
 * Use get for an explicitly enabled local account cache, or fetch for a remote read.
 * HTTP calls start immediately with the client's default deadline (rest.defaultTimeoutMs, 30,000 ms unless configured) and bounded eligible read retries.
 * Any writes retry only confirmed rate-limit rejection, not an uncertain outcome.
 * Abort waits for cleanup and returns CancelledError.
 * Unexpected failures reject with SdkDefect
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
     *
     * @remarks
     * Returns the value synchronously.
     * Unexpected failures throw SdkDefect
     */
    get(id: string): User | undefined
    /**
     * Fetch a public account snapshot by decimal user ID.
     * An unknown user fails with reason notFound rather than an empty result.
     * An enabled user cache admits this ID independently of unrelated targeted user reads
     */
    fetch(
        id: string,
        options?: DefaultUserOperationOptions,
    ): ResultAsync<User, UserOperationFailure | CancelledError | ConfigurationError>
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
     * import type { Client } from "@neontechspace/fluxerly"
     * export function profileExample(client: Client, userId: string, guildId: string) {
     *     return client.users.fetchProfile(userId, { guildId })
     * }
     * ```
     */
    fetchProfile(
        id: string,
        query?: UserProfileQuery,
        options?: DefaultUserOperationOptions,
    ): ResultAsync<UserProfile, UserOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch the authenticated bot's public account data remotely.
     * Private account fields are excluded.
     * Because its ID is not known before the response, enabled user-cache conflict handling is collection-wide, so a later cache change can prevent the result from being stored
     */
    fetchSelf(
        options?: DefaultUserOperationOptions,
    ): ResultAsync<User, UserOperationFailure | CancelledError | ConfigurationError>
}
