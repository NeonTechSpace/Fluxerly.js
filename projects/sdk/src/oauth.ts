import { createHash, randomBytes } from "node:crypto"
import type { OperationOptions } from "./client.js"
import type { ClientClosedError } from "./errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"

/** Delegated identity scopes accepted by authorizationUrl, distinct from bot installation permissions */
export const OAuthScopes = Object.freeze({
    Identify: "identify",
    Email: "email",
    Guilds: "guilds",
    Connections: "connections",
})

export type OAuthScope = (typeof OAuthScopes)[keyof typeof OAuthScopes]

/** Application credentials for Fluxer's confidential authorization-code client. Browser-only public clients are unsupported */
export interface OAuthConfig {
    /** Decimal Fluxer application ID */
    readonly clientId: string
    /** Application client secret, copied into the OAuth client and cleared during shutdown */
    readonly clientSecret: string
    /** Hosted Fluxer by default, or one explicitly selected discovered instance */
    readonly instance?: { readonly url?: string; readonly allowInsecure?: boolean }
}

/** Caller-owned authorization request. The SDK neither stores state nor receives the redirect */
export interface OAuthAuthorizationInput {
    /** Exact registered redirect, using HTTPS or loopback HTTP, without embedded credentials or a fragment */
    readonly redirectUri: string
    /** At least one delegated scope from OAuthScopes */
    readonly scopes: readonly OAuthScope[]
    /** Nonempty unpredictable caller-generated value, which the application must verify on the callback */
    readonly state: string
    /** S256 base64url challenge, exactly 43 characters, paired with the callback's retained verifier */
    readonly codeChallenge: string
}

/** Caller-owned authorization-code callback values */
export interface OAuthCodeExchangeInput {
    /** Nonempty fresh callback code, consumed by one exchange attempt */
    readonly code: string
    /** The exact redirect URI used in the authorization request */
    readonly redirectUri: string
    /** Original PKCE verifier, 43 to 128 unreserved ASCII characters */
    readonly codeVerifier: string
}

/** Frozen credentials returned only by a successful explicit token operation */
export interface OAuthTokens {
    readonly accessToken: string
    readonly refreshToken: string
    readonly tokenType: "Bearer"
    /** Provider-reported lifetime in seconds, not an absolute expiry or a scheduled refresh */
    readonly expiresInSeconds: number
    /** Granted scopes as returned by Fluxer. They can differ from requested scopes */
    readonly scopes: readonly string[]
}

/** Minimal identity projection from Fluxer's identify-scoped userinfo endpoint */
export interface OAuthIdentity {
    readonly id: string
    readonly username: string
    readonly discriminator: string
    readonly globalName: string | null
    readonly avatar: string | null
    readonly email?: string | null
    readonly verified?: boolean | null
}

export interface OAuthOperationOptions {
    /** Total milliseconds across discovery and one request, default 30,000. Cleanup can take longer */
    readonly timeoutMs?: number
}

/** Default OAuth cancellation affects only that operation and awaits request cleanup */
export interface DefaultOAuthOperationOptions extends OAuthOperationOptions, OperationOptions {}

export type OAuthOperation =
    | "oauth.authorizationUrl"
    | "oauth.exchangeCode"
    | "oauth.refresh"
    | "oauth.revoke"
    | "oauth.fetchIdentity"
    | "oauth.fetchGuilds"

/** Expected OAuth failure with safe metadata. Only recognized OAuth error codes are retained, without bodies, descriptions, or credentials */
export class OAuthOperationError extends Error {
    readonly _tag = "OAuthOperationError"
    /** SDK-owned local input detail, or null for non-input and unattributable failures */
    readonly inputValidation: InputValidationDetail | null
    constructor(
        readonly operation: OAuthOperation,
        readonly reason: "input" | "busy" | "rejected" | "network" | "response" | "timeout" | "rateLimit",
        /** Unknown means a code, refresh token, or revoke request may have been consumed after dispatch */
        readonly outcome: "notDispatched" | "rejected" | "unknown",
        readonly status: number | null = null,
        /** Numeric Retry-After duration in milliseconds for a 429 response, or null when unavailable */
        readonly retryAfterMs: number | null = null,
        /** Recognized invalid_grant, invalid_client, invalid_request, invalid_scope, unauthorized_client, or unsupported_grant_type code, otherwise null */
        readonly oauthError: string | null = null,
        inputValidation: InputValidationDetail | null = null,
    ) {
        super(`OAuth operation ${operation} failed (${reason}; outcome ${outcome})`)
        this.name = this._tag
        this.inputValidation = freezeInputValidationDetail(inputValidation)
    }
}

export type OAuthOperationFailure = OAuthOperationError | ClientClosedError

/** PKCE secrets remain caller-owned and are not retained by the SDK */
export interface OAuthPkce {
    readonly verifier: string
    readonly challenge: string
}

/** Generate a cryptographically random S256 verifier and its base64url challenge without storing either value */
export function createPkce(): OAuthPkce {
    const verifier = randomBytes(32).toString("base64url")
    const challenge = createHash("sha256").update(verifier).digest("base64url")
    return Object.freeze({ verifier, challenge })
}
