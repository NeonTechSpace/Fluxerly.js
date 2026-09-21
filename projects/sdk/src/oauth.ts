import { createHash, randomBytes } from "node:crypto"
import type { OperationOptions } from "./client.js"
import type { InstanceOptions } from "./instance.js"
import type { ClientClosedError } from "./errors.js"
import { operationErrorMessage, type ApiErrorDetail } from "./api-errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"

/** Choose which account data the user may share, or request bot installation, in authorizationUrl */
export const OAuthScopes: Readonly<{
    /** Read the consenting account's basic identity */
    Identify: "identify"
    /** Request the consenting account's email fields */
    Email: "email"
    /** Read the consenting account's guild memberships */
    Guilds: "guilds"
    /** Read the consenting account's connected accounts */
    Connections: "connections"
    /** Include bot installation in the consent request */
    Bot: "bot"
}> = Object.freeze({
    Identify: "identify",
    Email: "email",
    Guilds: "guilds",
    Connections: "connections",
    Bot: "bot",
})

/** One supported authorization scope from OAuthScopes.
 * Returned token scopes remain strings because Fluxer can grant additional scopes unknown to this SDK
 */
export type OAuthScope = (typeof OAuthScopes)[keyof typeof OAuthScopes]

/** Create a server-side OAuth client for exchanging authorization codes with an application secret.
 * Keep the secret on your server, not in browser code.
 * This client is separate from a bot-token client and does not own your consent callback or token storage
 */
export interface OAuthConfig {
    /** Decimal Fluxer application ID */
    readonly clientId: string
    /** Application client secret retained until shutdown.
     * Shutdown releases the SDK's reference, not caller-held copies or the string's underlying memory
     */
    readonly clientSecret: string
    /** Omit for hosted Fluxer. A supplied instance requires its root URL and trusts its discovered service origins */
    readonly instance?: InstanceOptions
}

/** Build the consent URL for an authorization-code request with PKCE.
 * Retain state and the PKCE verifier in your application, then verify state when you receive the callback.
 * The SDK does not store these values, open a browser or receive the redirect.
 * Values are sampled once when authorizationUrl starts, then validated and encoded from that snapshot
 */
export interface OAuthAuthorizationInput {
    /** Exact registered redirect, using HTTPS or loopback HTTP, without embedded credentials or a fragment.
     * Must contain 1–256 well-formed UTF-16 units, with no surrounding whitespace, U+000C or U+202E.
     * Noncanonical values are rejected rather than normalized
     */
    readonly redirectUri: string
    /** Provide 1–256 delegated or bot-installation scopes from OAuthScopes.
     * Supplied entries, including duplicates, count toward this SDK defensive limit.
     * Duplicates are removed in first-occurrence order before serialization
     */
    readonly scopes: readonly OAuthScope[]
    /** Unpredictable caller-generated value of 1–256 well-formed UTF-16 units, verified by the application on callback.
     * Surrounding whitespace, U+000C and U+202E are rejected, not removed, so accepted state is preserved exactly
     */
    readonly state: string
    /** Public hash challenge produced by createPkce, using S256 and exactly 43 base64url characters.
     * Retain the paired secret verifier for exchangeCode when the callback arrives
     */
    readonly codeChallenge: string
    /** Optional guild installation target for the bot scope. This hint neither proves membership nor grants permissions */
    readonly guildId?: string
    /** Optional group-DM installation target for the bot scope. Mutually exclusive with guildId and not proof of installation */
    readonly channelId?: string
    /** Optional unsigned 64-bit bot permission bitfield, serialized as a decimal provider parameter without local authorization */
    readonly permissions?: bigint
    /** Ask the bot-installation consent page to hide guild selection. This does not establish a selected target */
    readonly disableGuildSelect?: boolean
}

/** Values received or retained by your application for exchangeCode after a consent callback.
 * Verify the callback's state before exchanging its code, since the SDK does not perform that check.
 * Values are sampled once when exchangeCode starts, then validated and transmitted from that snapshot
 */
export interface OAuthCodeExchangeInput {
    /** Callback code of 1–256 well-formed UTF-16 units to exchange for tokens.
     * Surrounding whitespace, U+000C and U+202E are rejected rather than changing the opaque credential.
     * A dispatched attempt may consume this one-use code even if its response is lost
     */
    readonly code: string
    /** The exact redirect URI used in the authorization request, with the same 1–256-unit and canonical-text requirements */
    readonly redirectUri: string
    /** Original secret PKCE verifier, such as the verifier returned by createPkce.
     * Must contain 43–128 ASCII letters, digits or the characters - . _ ~
     */
    readonly codeVerifier: string
}

/** Credentials returned by a successful exchangeCode or refresh call.
 * Store and protect these values in your application, since the SDK does not retain them or schedule refreshes.
 * After refresh, use the returned credentials rather than assuming the previous refresh token remains usable
 */
export interface OAuthTokens {
    /** Bearer credential for delegated reads, not a bot token */
    readonly accessToken: string
    /** Credential for an explicit refresh call, which may rotate it */
    readonly refreshToken: string
    /** Authentication scheme for the access token */
    readonly tokenType: "Bearer"
    /** Provider-reported lifetime in seconds, not an absolute expiry or a scheduled refresh */
    readonly expiresInSeconds: number
    /** Granted scopes as returned by Fluxer. They can differ from requested scopes */
    readonly scopes: readonly string[]
}

/** Frozen basic account identity returned by fetchIdentity using a delegated access token.
 * Optional email fields are included only when Fluxer supplies them, not synthesized from requested scopes
 */
export interface OAuthIdentity {
    /** Decimal account ID */
    readonly id: string
    /** Account username */
    readonly username: string
    /** Provider discriminator string, preserved without numeric conversion */
    readonly discriminator: string
    /** Display name, or null when absent */
    readonly globalName: string | null
    /** Avatar hash, or null when the account has no avatar */
    readonly avatar: string | null
    /** Email address when supplied, null when explicitly absent, or an omitted field when not returned */
    readonly email?: string | null
    /** Provider verification flag when supplied, null when unspecified, or an omitted field when not returned */
    readonly verified?: boolean | null
}

/** One connection returned by fetchConnections with the connections scope, as an immutable value */
export interface OAuthConnection {
    /** Provider connection identifier, which may be empty and is not necessarily a decimal account ID */
    readonly id: string
    /** Connection kind accepted by this SDK's response parser, currently bsky or domain */
    readonly type: string
    /** Provider connection name, which may be empty */
    readonly name: string
    /** Whether Fluxer reports that the connection is verified */
    readonly verified: boolean
    /** Provider visibility bitfield, preserved as a nonnegative 32-bit integer without interpreting its flags */
    readonly visibilityFlags: number
    /** Provider sort-order value, preserved without reordering the returned list */
    readonly sortOrder: number
}

/** Token-check result when Fluxer does not report the credential as active for this application.
 * This does not distinguish an unknown, expired or revoked token from a token issued to another client
 */
export interface OAuthInactiveIntrospection {
    /** Fluxer did not report this token as active for this application */
    readonly active: false
}

/** Token-check result when Fluxer reports this application's access or refresh token as active.
 * Inspect tokenType before using optional access-token expiry data
 */
export interface OAuthActiveIntrospection {
    /** Fluxer reported this token as active at the time of the request, not guaranteed for later use */
    readonly active: true
    /** Decimal ID of the application to which the token belongs */
    readonly clientId: string
    /** Subject account ID when Fluxer includes one. Its absence does not make an otherwise active access token inactive */
    readonly subjectId?: string
    /** Whether the inspected credential is an access token or refresh token */
    readonly tokenType: "Bearer" | "refresh_token"
    /** Granted scopes parsed from Fluxer's space-separated response, with no authorization decision or retention */
    readonly scopes: readonly string[]
    /** Provider-reported Unix seconds when this token was issued */
    readonly issuedAtUnixSeconds: number
    /** Provider-reported Unix seconds for an access token. Refresh-token results omit this field */
    readonly expiresAtUnixSeconds?: number
}

/** Result of introspect, which explicitly asks Fluxer whether a token is active for this application.
 * An inactive result does not establish why the token is inactive or prove revocation
 */
export type OAuthIntrospection = OAuthInactiveIntrospection | OAuthActiveIntrospection

/** Set the deadline for one OAuth call without scheduling retries or changing another call's lifetime.
 * Malformed options return a local input error before discovery
 */
export interface OAuthOperationOptions {
    /** Total milliseconds across discovery and the operation, integer 1–2,147,483,647, default 30,000.
     * Required cleanup can outlast this deadline
     */
    readonly timeoutMs?: number
}

/** Default-API OAuth cancellation affects only that operation and awaits request cleanup */
export interface DefaultOAuthOperationOptions extends OAuthOperationOptions, OperationOptions {}

/** Public OAuth call identified by operation-error metadata */
export type OAuthOperation =
    | "oauth.authorizationUrl"
    | "oauth.exchangeCode"
    | "oauth.refresh"
    | "oauth.revoke"
    | "oauth.fetchIdentity"
    | "oauth.fetchGuilds"
    | "oauth.fetchConnections"
    | "oauth.introspect"

/** An OAuth call failed an input check, reached a local capacity limit, or failed during its request or response.
 * A deadline expiry is also reported here.
 * Inspect outcome before deciding whether to retry a code exchange, refresh or revocation.
 * The SDK does not retry these operations automatically.
 * Only reviewed error classifications are retained, not bodies, provider descriptions or credentials
 */
export class OAuthOperationError extends Error {
    /** Discriminator for narrowing this expected failure in either entry point */
    readonly _tag = "OAuthOperationError"
    /** Safe local validation facts when the SDK can identify a failed input rule, otherwise null */
    readonly inputValidation: InputValidationDetail | null
    constructor(
        /** OAuth call that failed */
        readonly operation: OAuthOperation,
        /** Input validation, full local capacity, HTTP rejection, network failure, invalid response, deadline expiry or HTTP 429 */
        readonly reason: "input" | "busy" | "rejected" | "network" | "response" | "timeout" | "rateLimit",
        /** notDispatched means no OAuth service request started, and rejected means an observed rejection.
         * Unknown means a token-changing request may have taken effect after dispatch, so retrying can consume or invalidate credentials again.
         * Read calls cannot change tokens, even when their request outcome is unknown
         */
        readonly outcome: "notDispatched" | "rejected" | "unknown",
        /** HTTP status when received, otherwise null */
        readonly status: number | null = null,
        /** Numeric Retry-After duration in milliseconds for a 429 response, or null when unavailable */
        readonly retryAfterMs: number | null = null,
        /** Recognized RFC OAuth error code, otherwise null */
        readonly oauthError: string | null = null,
        inputValidation: InputValidationDetail | null = null,
        /** Reviewed Fluxer HTTP error detail when the response uses the normal Fluxer envelope, otherwise null */
        readonly apiError: ApiErrorDetail | null = null,
    ) {
        super(
            operationErrorMessage(
                "OAuth",
                operation,
                reason,
                outcome,
                status,
                apiError,
                oauthError === null ? (inputValidation?.explanation ?? null) : `OAuth protocol error ${oauthError}`,
                retryAfterMs,
            ),
        )
        this.name = this._tag
        this.inputValidation = freezeInputValidationDetail(inputValidation)
    }
}

/** Expected OAuth failures shared by both entry points.
 * Default-API calls add CancelledError, while native interruption remains in the Effect cause
 */
export type OAuthOperationFailure = OAuthOperationError | ClientClosedError

/** A PKCE secret and its public hash challenge, used to prove that the code exchange belongs to the authorization request.
 * Your application owns these values, and the SDK does not retain them
 */
export interface OAuthPkce {
    /** Secret to retain for exchangeCode, not to publish in the consent URL or logs */
    readonly verifier: string
    /** Public S256 challenge to pass to authorizationUrl */
    readonly challenge: string
}

/** Generate a random PKCE verifier and its SHA-256 base64url challenge for one authorization request.
 * Retain verifier privately for exchangeCode and send challenge in the consent URL.
 * This synchronous helper makes no request and does not store either value.
 * It does not generate or verify the callback's state value
 *
 * @example
 * ```ts
 * import { createPkce, OAuthScopes, type OAuthClient } from "@neontechspace/fluxerly"
 * export async function prepareConsent(client: OAuthClient, redirectUri: string, state: string) {
 *     const pkce = createPkce()
 *     const authorization = await client.authorizationUrl({
 *         redirectUri,
 *         scopes: [OAuthScopes.Identify],
 *         state,
 *         codeChallenge: pkce.challenge,
 *     })
 *     return authorization.map((url) => ({ url, codeVerifier: pkce.verifier }))
 * }
 * ```
 */
export function createPkce(): OAuthPkce {
    const verifier = randomBytes(32).toString("base64url")
    const challenge = createHash("sha256").update(verifier).digest("base64url")
    return Object.freeze({ verifier, challenge })
}
