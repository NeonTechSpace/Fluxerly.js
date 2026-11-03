import { createHash, randomBytes } from "node:crypto"
import type { InstanceOptions } from "./instance.js"
import type { LoggingOptions } from "./logging.js"
import type { ClientClosedError } from "./errors.js"
import {
    operationErrorMessage,
    operationFailureHint,
    safeProviderCode,
    safeResponseField,
    type ApiErrorDetail,
    type RequestCredential,
} from "./api-errors.js"
import { FluxerlyError, operationDetails } from "./errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"

/**
 * Choose which account data the user may share, or request bot installation, in authorizationUrl
 *
 * @category OAuth
 */
export const OAuthScopes: Readonly<{
    /** Read the consenting account's basic identity */
    Identify: "identify"
    /** Request the consenting account's email fields */
    Email: "email"
    /** Read the consenting account's community memberships */
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
 *
 * @category OAuth
 */
export type OAuthScope = (typeof OAuthScopes)[keyof typeof OAuthScopes]

/** Create a server-side OAuth client for exchanging authorization codes with an application secret.
 * Keep the secret on the application server, not in browser code.
 * This client is separate from a bot-token client. The application handles the consent callback and stores tokens
 *
 * @category OAuth
 */
export interface OAuthConfig {
    /** Decimal Fluxer application ID */
    readonly clientId: string
    /** Application client secret retained until shutdown.
     * The client's logger keeps a copy to mask it while the client object is reachable. Drop the client object to release it
     */
    readonly clientSecret: string
    /** Omit for hosted Fluxer. A supplied instance requires its root URL and trusts its discovered service origins */
    readonly instance?: InstanceOptions
    /**
     * Log records for this OAuth client, with the same settings as the client option logging. Omit it for the default
     * console output of Info and above. A rejected client ID or secret logs a rest.rejected Warn record even when the
     * application handles the failure. Repeats follow logging.dedupe, which by default shows one per minute. A rejected
     * user access token is only returned. At Debug, each OAuth request logs one rest.request record with its method,
     * route, status and duration, never its query, form, body or Authorization value
     */
    readonly logging?: LoggingOptions
}

/** Build the consent URL for an authorization-code request with PKCE.
 * The application keeps state and the PKCE verifier. When the callback arrives, it checks that state matches the sent value.
 * The SDK does not save these values, open a browser or handle the redirect.
 * Values are sampled once when authorizationUrl starts, then validated and encoded from that snapshot
 *
 * @category OAuth
 */
export interface OAuthAuthorizationInput {
    /** A redirect URI registered for the application, using HTTPS, or HTTP for a loopback host or an IP address such as
     * a LAN address, without embedded credentials or a fragment. The SDK applies Fluxer's normalization: It removes
     * U+000C and U+202E and trims surrounding whitespace. The result must contain 1–256 well-formed UTF-16 units and
     * match a registered redirect URI exactly. Fluxer keeps the URL's standard form with the code, such as
     * https://example.test/ for https://example.test, so that form must also fit 256 units
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
    /** Public hash challenge produced by oauth.createPkce, using S256 and exactly 43 base64url characters.
     * Retain the paired secret verifier for exchangeCode when the callback arrives
     */
    readonly codeChallenge: string
    /** Optional community installation target for the bot scope. This hint neither proves membership nor grants permissions */
    readonly guildId?: string
    /** Optional group-DM installation target for the bot scope. Mutually exclusive with guildId and not proof of installation */
    readonly channelId?: string
    /** Optional unsigned 64-bit bot permission bitfield, serialized as a decimal provider parameter without local authorization */
    readonly permissions?: bigint
    /** Ask the bot-installation consent page to hide community selection. This does not establish a selected target */
    readonly disableGuildSelect?: boolean
}

/** Values received or retained by the application for exchangeCode after a consent callback.
 * Verify the callback's state before exchanging its code, since the SDK does not perform that check.
 * Values are sampled once when exchangeCode starts, then validated and transmitted from that snapshot
 *
 * @category OAuth
 */
export interface OAuthCodeExchangeInput {
    /** Callback code of 1–256 well-formed UTF-16 units to exchange for tokens.
     * Surrounding whitespace, U+000C and U+202E are rejected rather than changing the opaque credential.
     * A dispatched attempt may consume this one-use code even if its response is lost
     */
    readonly code: string
    /** The redirect URI used in the authorization request, under the same rules. The SDK sends its standard URL form,
     * such as https://example.test/ for https://example.test, because Fluxer compares the exchange with the form it
     * stored for the code
     */
    readonly redirectUri: string
    /** Original secret PKCE verifier, such as the verifier returned by oauth.createPkce.
     * Must contain 43–128 ASCII letters, digits or the characters - . _ ~
     */
    readonly codeVerifier: string
}

/** Credentials returned by a successful exchangeCode or refresh call.
 * Store and protect these values in the application, since the SDK does not retain them or schedule refreshes.
 * After a refresh, use the new credentials. The previous refresh token may no longer work
 *
 * @category OAuth
 */
export interface OAuthTokens {
    /** Bearer credential for delegated reads, not a bot token */
    readonly accessToken: string
    /** Credential for an explicit refresh call, which may rotate it */
    readonly refreshToken: string
    /** Authentication scheme for the access token */
    readonly tokenType: "Bearer"
    /** Provider-reported lifetime in seconds, not an absolute expiry or a scheduled refresh.
     * Fluxer names it expires_in
     */
    readonly expiresInSeconds: number
    /** Granted scopes as returned by Fluxer. They can differ from requested scopes.
     * Fluxer sends one space-separated scope string
     */
    readonly scopes: readonly string[]
}

/** Frozen basic account identity returned by fetchIdentity using a delegated access token.
 * Optional email fields are included only when Fluxer supplies them, not synthesized from requested scopes
 *
 * @category OAuth
 */
export interface OAuthIdentity {
    /** Decimal account ID, Fluxer's id field. Fluxer's sub field is not kept, because Fluxer sets it to the same
     * account ID. A GET of /oauth2/userinfo sent with the access token as Bearer authorization returns both. The raw
     * client.rest.request method cannot send it, because it uses the bot token
     */
    readonly id: string
    /** Account username */
    readonly username: string
    /** Provider discriminator string, preserved without numeric conversion */
    readonly discriminator: string
    /** Account-wide display name, or null when absent. The display.name helper reads it. Fluxer names it global_name */
    readonly displayName: string | null
    /** Avatar hash, or null when the account has no avatar */
    readonly avatar: string | null
    /** Email address when supplied, null when explicitly absent, or an omitted field when not returned */
    readonly email?: string | null
    /** Provider verification flag when supplied, null when unspecified, or an omitted field when not returned */
    readonly verified?: boolean | null
    /** Public account flags, such as badges, absent when Fluxer omits them. Unrecognized 32-bit values are kept */
    readonly flags?: number
    /** Dominant avatar color, for a fallback while the avatar loads. Null when unset, absent when Fluxer omits it */
    readonly avatarColor?: number | null
    /** Whether Fluxer identifies this account as a bot, absent when Fluxer omits it. Fluxer names it bot */
    readonly isBot?: boolean
    /** Whether Fluxer identifies this account as a system user, absent when Fluxer omits it. Fluxer names it system */
    readonly isSystem?: boolean
}

/** Frozen description of the authorization behind a delegated access token, returned by fetchAuthorization.
 * Fluxer reads it from the token alone, so any scope works, and it includes the user only when the token has the
 * identify scope
 *
 * @category OAuth
 */
export interface OAuthAuthorization {
    /** The application the user authorized */
    readonly application: {
        /** Decimal application ID */
        readonly id: string
        /** Application name */
        readonly name: string
        /** Icon hash, or null. Fluxer currently always sends null here */
        readonly icon: string | null
        /** Description, or null. Fluxer currently always sends null here */
        readonly description: string | null
        /** Whether anyone can add the application's bot to a community */
        readonly botPublic: boolean
        /** Whether adding the bot requires the full authorization-code flow */
        readonly botRequireCodeGrant: boolean
        /** Application flags as a 32-bit integer. Fluxer currently always sends 0 here */
        readonly flags: number
    }
    /** Scopes granted to the token, as Fluxer lists them */
    readonly scopes: readonly string[]
    /** When the access token expires, as an ISO 8601 timestamp. Fluxer names it expires */
    readonly expiresAt: string
    /** The authorizing user, present only when the token has the identify scope. Email fields also need the email scope */
    readonly user?: OAuthIdentity
}

/**
 * One connection returned by fetchConnections with the connections scope, as an immutable value
 *
 * @category OAuth
 */
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
 *
 * @category OAuth
 */
export interface OAuthInactiveIntrospection {
    /** Fluxer did not report this token as active for this application */
    readonly active: false
}

/** Token-check result when Fluxer reports this application's access or refresh token as active.
 * Inspect tokenType before using optional access-token expiry data
 *
 * @category OAuth
 */
export interface OAuthActiveIntrospection {
    /** Fluxer reported this token as active at the time of the request, not guaranteed for later use */
    readonly active: true
    /** Decimal ID of the application to which the token belongs */
    readonly clientId: string
    /** Subject account ID when Fluxer includes one. Its absence does not make an otherwise active access token inactive.
     * Fluxer names it sub
     */
    readonly subjectId?: string
    /** Whether the inspected credential is an access token or refresh token */
    readonly tokenType: "Bearer" | "refresh_token"
    /** Granted scopes parsed from Fluxer's space-separated response, with no authorization decision or retention */
    readonly scopes: readonly string[]
    /** Provider-reported Unix seconds when this token was issued. Fluxer names it iat */
    readonly issuedAtUnixSeconds: number
    /** Provider-reported Unix seconds for an access token. Refresh-token results omit this field.
     * Fluxer names it exp
     */
    readonly expiresAtUnixSeconds?: number
}

/** Result of introspect, which explicitly asks Fluxer whether a token is active for this application.
 * An inactive result does not explain why the token is inactive or prove it was revoked
 *
 * @category OAuth
 */
export type OAuthIntrospection = OAuthInactiveIntrospection | OAuthActiveIntrospection

/**
 * Public OAuth call identified by operation-error metadata
 *
 * @category Errors
 */
export type OAuthOperation =
    | "oauth.authorizationUrl"
    | "oauth.exchangeCode"
    | "oauth.refresh"
    | "oauth.revoke"
    | "oauth.fetchIdentity"
    | "oauth.fetchAuthorization"
    | "oauth.fetchGuilds"
    | "oauth.fetchConnections"
    | "oauth.introspect"

/** Calls that send the user's access token. The others authenticate with the application's client ID and secret */
const userTokenOperations: ReadonlySet<OAuthOperation> = new Set<OAuthOperation>([
    "oauth.fetchIdentity",
    "oauth.fetchAuthorization",
    "oauth.fetchGuilds",
    "oauth.fetchConnections",
])

/** @internal The credential an OAuth call sent, for its rejection hint and log record */
export const oauthCredential = (operation: OAuthOperation, oauthError: string | null): RequestCredential =>
    oauthError !== "invalid_client" && userTokenOperations.has(operation) ? "oauthUser" : "oauthClient"

/** An OAuth call failed an input check, reached a local capacity limit, or failed during its request or response.
 * A deadline expiry is also reported here.
 * Inspect outcome before deciding whether to retry a code exchange, refresh or revocation.
 * The SDK does not retry these operations automatically.
 * Failures of fetchIdentity, fetchAuthorization, fetchGuilds, fetchConnections and introspect set details.read for errors.isRetryable and do not imply a token change.
 * SDK-reported discovery and transport failures retain sanitized causes with safe transport codes when available.
 * Only reviewed error classifications are retained, not bodies, provider descriptions or credentials
 *
 * @category Errors
 */
export class OAuthOperationError extends FluxerlyError {
    /** Discriminator for narrowing this expected failure in either entry point */
    readonly _tag = "OAuthOperationError"
    /** OAuth call that failed */
    readonly operation: OAuthOperation
    /** Input validation, full local capacity, HTTP rejection, network failure, invalid response, deadline expiry or HTTP 429 */
    readonly reason: "input" | "busy" | "rejected" | "network" | "response" | "timeout" | "rateLimit"
    /** Whether the request may have reached Fluxer, described by {@link OperationOutcome}.
     * An unknown token-changing request may have taken effect, so retrying can consume or invalidate credentials again.
     * Read calls cannot change tokens, even when their request outcome is unknown
     */
    readonly outcome: "notDispatched" | "rejected" | "unknown"
    /** HTTP status when received, otherwise null */
    readonly status: number | null
    /** Numeric Retry-After duration in milliseconds for a 429 response, or null when unavailable */
    readonly retryAfterMs: number | null
    /** Recognized RFC OAuth error code, otherwise null */
    readonly oauthError: string | null
    /** Safe local validation facts when the SDK can identify a failed input rule, otherwise null */
    readonly inputValidation: InputValidationDetail | null
    /** Reviewed Fluxer HTTP error detail when the response uses the normal Fluxer envelope, otherwise null */
    readonly apiError: ApiErrorDetail | null
    /** Create the failure from an options object, with an optional underlying cause */
    constructor(options: {
        readonly operation: OAuthOperation
        readonly reason: "input" | "busy" | "rejected" | "network" | "response" | "timeout" | "rateLimit"
        readonly outcome: "notDispatched" | "rejected" | "unknown"
        readonly status?: number | null | undefined
        readonly retryAfterMs?: number | null | undefined
        readonly oauthError?: string | null | undefined
        readonly inputValidation?: InputValidationDetail | null | undefined
        readonly apiError?: ApiErrorDetail | null | undefined
        /**
         * Fluxer error code that this SDK version does not recognize, recorded as details.providerCode and named in the
         * message. Ignored when apiError is present or the code does not have the shape of a Fluxer code
         */
        readonly providerCode?: string | null | undefined
        /**
         * For reason response, the response field path that failed, such as expires_in. Recorded as
         * details.responseField and named in the message, never with its value. Defaults to null
         */
        readonly responseField?: string | null | undefined
        readonly cause?: unknown
    }) {
        const operation = options.operation
        const reason = options.reason
        const outcome = options.outcome
        const status = options.status ?? null
        const retryAfterMs = options.retryAfterMs ?? null
        const oauthError = options.oauthError ?? null
        const inputValidation = options.inputValidation ?? null
        const apiError = options.apiError ?? null
        const providerCode = safeProviderCode(apiError, options.providerCode ?? null)
        const responseField = safeResponseField(options.responseField ?? null)
        const read =
            operation === "oauth.fetchIdentity" ||
            operation === "oauth.fetchAuthorization" ||
            operation === "oauth.fetchGuilds" ||
            operation === "oauth.fetchConnections" ||
            operation === "oauth.introspect"
        super(
            operationErrorMessage({
                subject: "OAuth",
                operation,
                reason,
                outcome,
                status,
                apiError,
                inputExplanation:
                    oauthError === null
                        ? (inputValidation?.explanation ?? null)
                        : `Fluxer returned the OAuth error ${oauthError}`,
                retryAfterMs,
                facts: { providerCode, responseField, read },
            }),
            {
                code: `oauth.${reason}`,
                hint: operationFailureHint({
                    reason,
                    outcome,
                    status,
                    retryAfterMs,
                    apiError,
                    inputPath: inputValidation?.path ?? null,
                    oauthError,
                    credential: oauthCredential(operation, oauthError),
                    read,
                }),
                cause: options.cause,
                details: operationDetails({
                    operation,
                    reason,
                    outcome,
                    status,
                    retryAfterMs,
                    oauthError,
                    providerCode,
                    responseField,
                    read,
                }),
            },
        )
        this.operation = operation
        this.reason = reason
        this.outcome = outcome
        this.status = status
        this.retryAfterMs = retryAfterMs
        this.oauthError = oauthError
        this.apiError = apiError
        this.name = this._tag
        this.inputValidation = freezeInputValidationDetail(inputValidation)
    }
}

/** Expected OAuth failures shared by both entry points.
 * Default-API calls add CancelledError, while native interruption remains in the Effect cause
 *
 * @category Errors
 */
export type OAuthOperationFailure = OAuthOperationError | ClientClosedError

/** A PKCE secret and its public hash challenge, used to prove that the code exchange belongs to the authorization request.
 * The application owns these values, and the SDK does not retain them
 *
 * @category OAuth
 */
export interface OAuthPkce {
    /** Secret to retain for exchangeCode, not to publish in the consent URL or logs */
    readonly verifier: string
    /** Public S256 challenge to pass to authorizationUrl */
    readonly challenge: string
}

/** Generate a random PKCE verifier and its SHA-256 base64url challenge for one authorization request.
 * Both entry points expose it as oauth.createPkce
 */
export function createPkce(): OAuthPkce {
    const verifier = randomBytes(32).toString("base64url")
    const challenge = createHash("sha256").update(verifier).digest("base64url")
    return Object.freeze({ verifier, challenge })
}
