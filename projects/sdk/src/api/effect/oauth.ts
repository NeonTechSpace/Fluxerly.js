import type { GuildListQuery, GuildListSummary } from "#sdk/guilds"
import * as Effect from "effect/Effect"
import * as Scope from "effect/Scope"
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
    type OAuthOperationOptions,
} from "#sdk/oauth"
import { makeOAuthOwner } from "#sdk/internal/oauth"

/**
 * Use OAuth to access a user's Fluxer account with their consent and a server-held client secret.
 * The scope that creates this client shuts it down
 *
 * The application handles consent, browser callbacks, state checks, token storage and refresh coordination
 *
 * The client keeps a copy of the secret until shutdown and allows at most eight concurrent operations, without a queue.
 * Response bodies are capped at 1 MiB. Requests never retry automatically.
 * Discovery throttling fails with OAuthOperationError reason rateLimit, outcome notDispatched, status 429 and the server's retryAfterMs when available
 *
 * Expected failures use Effect's error channel. Interruption and cleanup defects remain in Cause.
 * Response and discovery cleanup faults keep their original values as Cause defects, and describeError masks credential patterns in them
 *
 * Operation input properties are read during execution, with throwing accessors retained as defects
 *
 * @category OAuth
 */
export interface OAuthClient {
    /**
     * Build an authorization URL for the selected instance using its discovered web application URL, including its path.
     * Supply the redirect URI, scopes, caller-generated state and S256 PKCE challenge, which binds the callback code to the private verifier.
     * The application must retain state correlation and the PKCE verifier.
     * Bot community and permission parameters are consent hints, not proof of installation or authorization.
     * This returns the URL without opening it
     */
    authorizationUrl(
        input: OAuthAuthorizationInput,
        options?: OAuthOperationOptions,
    ): Effect.Effect<string, OAuthOperationFailure>
    /**
     * Exchange the code from an authorization callback for access and refresh tokens.
     * Supply the matching redirect URI and PKCE verifier.
     * The application must store the returned tokens.
     * After dispatch, cancellation or a lost response cannot tell whether Fluxer consumed the one-use code.
     * Do not retry that exchange when its outcome is unknown
     */
    exchangeCode(
        input: OAuthCodeExchangeInput,
        options?: OAuthOperationOptions,
    ): Effect.Effect<OAuthTokens, OAuthOperationFailure>
    /**
     * Exchange a refresh token for a new access and refresh token pair.
     * Form tokens must contain 1–256 well-formed UTF-16 units without surrounding whitespace, U+000C or U+202E.
     * Invalid values fail locally rather than being normalized, and this also applies to revoke and introspect tokens.
     * Fluxer rotates refresh tokens.
     * The application must coordinate refreshes and atomically replace both stored tokens after success, so it never stores a mixed pair.
     * A refresh with an unknown outcome must not be retried, because it may have rotated the token
     */
    refresh(refreshToken: string, options?: OAuthOperationOptions): Effect.Effect<OAuthTokens, OAuthOperationFailure>
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
        options?: OAuthOperationOptions,
    ): Effect.Effect<void, OAuthOperationFailure>
    /**
     * Fetch the delegated user's identity with an access token granted the identify scope.
     * Additional identity fields depend on the token's scopes.
     * The access token is not retained by this client
     */
    fetchIdentity(
        accessToken: string,
        options?: OAuthOperationOptions,
    ): Effect.Effect<OAuthIdentity, OAuthOperationFailure>
    /**
     * Fetch one bounded page of the delegated user's community memberships.
     * Use an access token with Fluxer's guilds scope.
     * Optionally supply pagination settings in GuildListQuery, where limit defaults to 200 and accepts 1–200, and before and after are mutually exclusive cursors.
     * This uses bearer authentication with the supplied access token, never the bot token
     */
    fetchGuilds(
        accessToken: string,
        query?: GuildListQuery,
        options?: OAuthOperationOptions,
    ): Effect.Effect<readonly GuildListSummary[], OAuthOperationFailure>
    /**
     * Fetch the delegated user's full connections list with a connections-scoped access token.
     * The client neither creates, verifies, reorders nor retains those connections
     */
    fetchConnections(
        accessToken: string,
        options?: OAuthOperationOptions,
    ): Effect.Effect<readonly OAuthConnection[], OAuthOperationFailure>
    /**
     * Inspect an access or refresh token using this client's ID and secret through HTTP Basic authentication.
     * An inactive result does not explain expiry or revocation, prove token ownership or establish whether it ever existed
     */
    introspect(token: string, options?: OAuthOperationOptions): Effect.Effect<OAuthIntrospection, OAuthOperationFailure>
    /**
     * Permanently stop OAuth work, reject new work, release the client's copied secret and abort active requests.
     * Shutdown waits for fetch and response-reader cleanup.
     * A response-cleanup failure in an active operation fails that operation, while shutdown waits for it and may itself succeed.
     * A failure in shutdown's own discovery cleanup fails shutdown
     *
     * @remarks
     * Those cleanup defects remain in the affected Effect's Cause
     */
    shutdown(): Effect.Effect<void>
}

/**
 * Create a server-side OAuth client, or generate an S256 PKCE challenge for an authorization request.
 * The create method returns an Effect that requires Scope. Invalid configuration is misuse and dies with ConfigurationError.
 * The application owns consent, callback correlation, state validation, token storage, installation policy and coordinated refresh
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { oauth, OAuthScopes } from "@neontechspace/fluxerly/effect"
 *
 * export const oauthEffectExample = Effect.scoped(
 *     Effect.gen(function* () {
 *         const client = yield* oauth.create({ clientId: "123", clientSecret: "server-held-secret" })
 *         const pkce = oauth.createPkce()
 *         return yield* client.authorizationUrl({
 *             redirectUri: "https://app.example.test/oauth/callback",
 *             scopes: [OAuthScopes.Identify, OAuthScopes.Bot],
 *             state: "caller-correlated-state",
 *             codeChallenge: pkce.challenge,
 *             guildId: "456",
 *             permissions: 0n,
 *         })
 *     }),
 * )
 * ```
 *
 * @category OAuth
 */
export const oauth: Readonly<{
    /** Create the OAuth client when this Effect executes, without making a request.
     * Invalid client credentials or instance settings are misuse and die with ConfigurationError. Unexpected failures remain defects in the Cause.
     * Scope closure calls shutdown
     */
    create: (config: OAuthConfig) => Effect.Effect<OAuthClient, never, Scope.Scope>
    /**
     * Generate a private verifier and matching S256 challenge for one authorization-code flow.
     * Send challenge to authorizationUrl and keep verifier privately for exchangeCode.
     * This synchronous helper returns the values immediately, without a request or token storage.
     * It does not generate or verify the callback's state value
     */
    createPkce: () => OAuthPkce
}> = Object.freeze({
    create: (config: OAuthConfig): Effect.Effect<OAuthClient, never, Scope.Scope> =>
        Effect.gen(function* () {
            const owner = yield* makeOAuthOwner(config, Scope.makeUnsafe(), true).pipe(Effect.orDie)
            yield* Effect.addFinalizer(() => owner.shutdown())
            return Object.freeze({
                authorizationUrl: (input: OAuthAuthorizationInput, options?: OAuthOperationOptions) =>
                    owner.authorizationUrl(input, options),
                exchangeCode: (input: OAuthCodeExchangeInput, options?: OAuthOperationOptions) =>
                    owner.exchangeCode(input, options),
                refresh: (refreshToken: string, options?: OAuthOperationOptions) =>
                    owner.refresh(refreshToken, options),
                revoke: (
                    input: { readonly token: string; readonly tokenTypeHint?: "access_token" | "refresh_token" },
                    options?: OAuthOperationOptions,
                ) => owner.revoke(input, options),
                fetchIdentity: (accessToken: string, options?: OAuthOperationOptions) =>
                    owner.fetchIdentity(accessToken, options),
                fetchGuilds: (accessToken: string, query?: GuildListQuery, options?: OAuthOperationOptions) =>
                    owner.fetchGuilds(accessToken, query, options),
                fetchConnections: (accessToken: string, options?: OAuthOperationOptions) =>
                    owner.fetchConnections(accessToken, options),
                introspect: (token: string, options?: OAuthOperationOptions) => owner.introspect(token, options),
                shutdown: () => owner.shutdown(),
            })
        }),
    createPkce,
})
