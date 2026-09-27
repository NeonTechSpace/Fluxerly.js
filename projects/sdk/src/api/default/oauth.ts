import type { GuildListQuery, GuildListSummary } from "#sdk/guilds"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scope from "effect/Scope"
import { ok, ResultAsync } from "neverthrow"
import { causeReasons, suspendInput } from "#sdk/internal/defects"
import {
    createPkce,
    type OAuthPkce,
    type OAuthAuthorizationInput,
    type OAuthConnection,
    type OAuthCodeExchangeInput,
    type OAuthConfig,
    type OAuthIdentity,
    type OAuthIntrospection,
    type OAuthOperationFailure,
    type OAuthTokens,
    type DefaultOAuthOperationOptions,
} from "#sdk/oauth"
import { makeOAuthOwner } from "#sdk/internal/oauth"
import { CancelledError, ConfigurationError, SdkDefect } from "#sdk/errors"
import { executeOperation, fromExit } from "#sdk/internal/binding/execute"

function oauthOwnerOptions(options: DefaultOAuthOperationOptions | undefined) {
    if (Array.isArray(options)) return options
    if (typeof options !== "object" || options === null || !("signal" in options)) return options
    const { signal: _signal, ...ownerOptions } = options
    return ownerOptions
}

/**
 * Use a standalone OAuth client to exchange authorization codes, refresh or revoke tokens, and read delegated user data.
 * This confidential client requires a server-held client secret, not a bot token.
 * It does not open a browser, handle callbacks, compare state, store tokens or run a gateway.
 * The application owns those steps and coordinates refreshes
 *
 * @remarks
 * The secret is copied until shutdown.
 * Calls start immediately and return ResultAsync.
 * At most eight operations run concurrently, without a queue.
 * The timeoutMs option defaults to 30,000 for discovery and the operation, with request cleanup awaited afterward.
 * Responses are capped at 1 MiB and requests are never retried automatically.
 * Discovery throttling returns OAuthOperationError with rateLimit, notDispatched, status 429 and available retryAfterMs
 *
 * Expected failures return Err.
 * A throw while reading input or option properties rejects with SdkDefect code application.defect and the thrown value
 * as its cause, and unexpected cleanup failures reject with SdkDefect.
 * It keeps the original cleanup failure, never response text, and its message and toJSON mask credential patterns
 *
 * @category OAuth
 */
export interface OAuthClient extends AsyncDisposable {
    /**
     * Build an authorization URL for the selected instance using its discovered web application URL, including its path.
     * Supply the redirect URI, scopes, caller-generated state and S256 PKCE challenge, which binds the callback code to the private verifier.
     * The application must retain state correlation and the PKCE verifier.
     * Bot community and permission parameters are consent hints, not proof of installation or authorization.
     * This returns the URL without opening it
     */
    authorizationUrl(
        input: OAuthAuthorizationInput,
        options?: DefaultOAuthOperationOptions,
    ): ResultAsync<string, OAuthOperationFailure | CancelledError | ConfigurationError>
    /**
     * Exchange the code from an authorization callback for access and refresh tokens.
     * Supply the matching redirect URI and PKCE verifier.
     * The application must store the returned tokens.
     * After dispatch, cancellation or a lost response cannot tell whether Fluxer consumed the one-use code.
     * Do not retry that exchange when its outcome is unknown
     */
    exchangeCode(
        input: OAuthCodeExchangeInput,
        options?: DefaultOAuthOperationOptions,
    ): ResultAsync<OAuthTokens, OAuthOperationFailure | CancelledError | ConfigurationError>
    /**
     * Exchange a refresh token for a new access and refresh token pair.
     * Form tokens must contain 1–256 well-formed UTF-16 units without surrounding whitespace, U+000C or U+202E.
     * Invalid values fail locally rather than being normalized, and this also applies to revoke and introspect tokens.
     * Fluxer rotates refresh tokens.
     * The application must coordinate refreshes and atomically replace both stored tokens after success, so it never stores a mixed pair.
     * A refresh with an unknown outcome must not be retried, because it may have rotated the token
     */
    refresh(
        refreshToken: string,
        options?: DefaultOAuthOperationOptions,
    ): ResultAsync<OAuthTokens, OAuthOperationFailure | CancelledError | ConfigurationError>
    /**
     * Revoke an access or refresh token, with an optional token-type hint.
     * The token and hint are captured once when execution starts, then validated and transmitted from that snapshot.
     * A lost response can still mean the token was revoked
     */
    revoke(
        input: {
            /** Access or refresh token to invalidate. Keep this secret out of logs */
            readonly token: string
            /** Identify the token as an access token or a refresh token. Omit when the kind is unknown */
            readonly tokenTypeHint?: "access_token" | "refresh_token"
        },
        options?: DefaultOAuthOperationOptions,
    ): ResultAsync<void, OAuthOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch the delegated user's identity with an access token granted the identify scope.
     * Additional identity fields depend on the token's scopes.
     * The access token is not retained by this client
     */
    fetchIdentity(
        accessToken: string,
        options?: DefaultOAuthOperationOptions,
    ): ResultAsync<OAuthIdentity, OAuthOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch one bounded page of the delegated user's community memberships.
     * Use an access token with Fluxer's guilds scope.
     * Optionally supply pagination settings in GuildListQuery, where limit defaults to 200 and accepts 1–200, and before and after are mutually exclusive cursors.
     * This uses bearer authentication with the supplied access token, never the bot token
     */
    fetchGuilds(
        accessToken: string,
        query?: GuildListQuery,
        options?: DefaultOAuthOperationOptions,
    ): ResultAsync<readonly GuildListSummary[], OAuthOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch the delegated user's full connections list with a connections-scoped access token.
     * The client neither creates, verifies, reorders nor retains those connections
     */
    fetchConnections(
        accessToken: string,
        options?: DefaultOAuthOperationOptions,
    ): ResultAsync<readonly OAuthConnection[], OAuthOperationFailure | CancelledError | ConfigurationError>
    /**
     * Inspect an access or refresh token using this client's ID and secret through HTTP Basic authentication.
     * An inactive result does not explain expiry or revocation, prove token ownership or establish whether it ever existed
     */
    introspect(
        token: string,
        options?: DefaultOAuthOperationOptions,
    ): ResultAsync<OAuthIntrospection, OAuthOperationFailure | CancelledError | ConfigurationError>
    /**
     * Permanently stop OAuth work, reject new work, release the client's copied secret and abort active requests.
     * Shutdown waits for fetch and response-reader cleanup.
     * A response-cleanup failure in an active operation fails that operation, while shutdown waits for it and may itself succeed.
     * A failure in shutdown's own discovery cleanup fails shutdown
     *
     * @remarks
     * Those cleanup failures reject with SdkDefect
     */
    shutdown(): ResultAsync<void, never>
    /**
     * Shut down this client and wait for cleanup, as `await using` does at the end of a block.
     * Unexpected cleanup failures reject with SdkDefect, as shutdown does
     */
    [Symbol.asyncDispose](): Promise<void>
}

/**
 * Create confidential OAuth clients and generate PKCE values for authorization-code flows.
 * Use these helpers on a trusted server where the client secret is not exposed to a browser
 *
 * @remarks
 * The application handles browser navigation, callbacks, state correlation, consent and token storage.
 * It also decides installation policy and coordinates refreshes.
 * The create method returns the client synchronously without making a request, and throws ConfigurationError for invalid settings.
 * The createPkce method returns a new verifier and S256 challenge for the same authorization flow.
 * PKCE links authorization to the code exchange using a private random verifier and its public SHA-256 hash challenge.
 * Keep the verifier private and send only the challenge to authorizationUrl
 *
 * @example
 * ```ts
 * import { oauth, OAuthScopes } from "@neontechspace/fluxerly"
 *
 * export async function oauthExample(clientId: string, clientSecret: string, redirectUri: string, state: string) {
 *     const client = oauth.create({ clientId, clientSecret })
 *     try {
 *         const pkce = oauth.createPkce()
 *         return await client.authorizationUrl({
 *             redirectUri,
 *             scopes: [OAuthScopes.Identify, OAuthScopes.Bot],
 *             state,
 *             codeChallenge: pkce.challenge,
 *             guildId: "456",
 *             permissions: 0n,
 *         })
 *     } finally {
 *         await client.shutdown()
 *     }
 * }
 * ```
 *
 * @category OAuth
 */
export const oauth: Readonly<{
    /**
     * Create a standalone OAuth client with a clientId and server-held clientSecret.
     * Creation checks configuration synchronously without requests and copies the secret until shutdown.
     * Invalid settings throw ConfigurationError.
     * Unexpected creation failures throw SdkDefect with operation oauth.create and without configuration details.
     * A throwing configuration getter uses code application.defect with the thrown value as its cause
     */
    create(config: OAuthConfig): OAuthClient
    /**
     * Generate a private verifier and matching S256 challenge for one authorization-code flow.
     * Send challenge to authorizationUrl and keep verifier privately for exchangeCode.
     * This synchronous helper returns the values immediately, without a request or token storage.
     * It does not generate or verify the callback's state value
     */
    createPkce: () => OAuthPkce
}> = Object.freeze({
    create(config: OAuthConfig): OAuthClient {
        const scope = Scope.makeUnsafe()
        const created = fromExit(Effect.runSyncExit(makeOAuthOwner(config, scope)), "oauth.create")
        if (created.isErr()) throw created.error
        const owner = created.value
        const shutdown = () =>
            new ResultAsync<void, never>(
                Effect.runPromiseExit(owner.shutdown()).then((exit) => {
                    const result = fromExit(exit, "shutdown")
                    if (result.isErr())
                        throw new SdkDefect("shutdown", Exit.isFailure(exit) ? causeReasons(exit.cause) : [])
                    return ok(undefined)
                }),
            )
        return Object.freeze({
            authorizationUrl: (input: OAuthAuthorizationInput, options?: DefaultOAuthOperationOptions) =>
                executeOperation(
                    suspendInput(() => owner.authorizationUrl(input, oauthOwnerOptions(options))),
                    "oauth.authorizationUrl",
                    options,
                ),
            exchangeCode: (input: OAuthCodeExchangeInput, options?: DefaultOAuthOperationOptions) =>
                executeOperation(
                    suspendInput(() => owner.exchangeCode(input, oauthOwnerOptions(options))),
                    "oauth.exchangeCode",
                    options,
                ),
            refresh: (refreshToken: string, options?: DefaultOAuthOperationOptions) =>
                executeOperation(
                    suspendInput(() => owner.refresh(refreshToken, oauthOwnerOptions(options))),
                    "oauth.refresh",
                    options,
                ),
            revoke: (
                input: { readonly token: string; readonly tokenTypeHint?: "access_token" | "refresh_token" },
                options?: DefaultOAuthOperationOptions,
            ) =>
                executeOperation(
                    suspendInput(() => owner.revoke(input, oauthOwnerOptions(options))),
                    "oauth.revoke",
                    options,
                ),
            fetchIdentity: (accessToken: string, options?: DefaultOAuthOperationOptions) =>
                executeOperation(
                    suspendInput(() => owner.fetchIdentity(accessToken, oauthOwnerOptions(options))),
                    "oauth.fetchIdentity",
                    options,
                ),
            fetchGuilds: (accessToken: string, query?: GuildListQuery, options?: DefaultOAuthOperationOptions) =>
                executeOperation(
                    suspendInput(() => owner.fetchGuilds(accessToken, query, oauthOwnerOptions(options))),
                    "oauth.fetchGuilds",
                    options,
                ),
            fetchConnections: (accessToken: string, options?: DefaultOAuthOperationOptions) =>
                executeOperation(
                    suspendInput(() => owner.fetchConnections(accessToken, oauthOwnerOptions(options))),
                    "oauth.fetchConnections",
                    options,
                ),
            introspect: (token: string, options?: DefaultOAuthOperationOptions) =>
                executeOperation(
                    suspendInput(() => owner.introspect(token, oauthOwnerOptions(options))),
                    "oauth.introspect",
                    options,
                ),
            shutdown,
            [Symbol.asyncDispose]: async () => {
                await shutdown()
            },
        })
    },
    createPkce,
})
