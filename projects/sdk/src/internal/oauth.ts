/**
 * OAuth client operations: Authorization URLs, code exchange, refresh, revocation, introspection and authorized reads.
 * Invariant: Consent, storage and refresh coordination stay application-owned, credentials never appear in errors or logs, and
 * every request goes through the HTTP transport seam. Implements [SDK contracts: Results and failures](/docs/SDK-CONTRACTS.md#results-and-failures)
 */
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scope from "effect/Scope"
import type {
    OAuthAuthorizationInput,
    OAuthCodeExchangeInput,
    OAuthConfig,
    OAuthAuthorization,
    OAuthConnection,
    OAuthIdentity,
    OAuthIntrospection,
    OAuthOperation,
    OAuthOperationError,
    OAuthTokens,
} from "#sdk/oauth"
import { OAuthOperationError as OAuthError, oauthCredential } from "#sdk/oauth"
import { loggingConfiguration, type ClientLogger } from "#sdk/internal/logging"
import type * as Context from "effect/Context"
import { apiErrorDetail, unrecognizedProviderCode } from "#sdk/api-errors"
import { ClientClosedError, ConfigurationError, ConnectionError, RateLimitError } from "#sdk/errors"
import { closedBeforeSend } from "#sdk/internal/rest/closed"
import { failures, mapFailureCause, TransportError, withDeadline } from "#sdk/internal/effect-failures"
import { nowMs } from "#sdk/internal/clock"
import { defaultHttpTransport, type HttpTransport } from "#sdk/internal/transport/index"
import { InstanceResolver, instanceConfiguration } from "#sdk/internal/instance"
import { guildList } from "#sdk/internal/guild-lifecycle"
import { identifier, inputId, int32, record } from "#sdk/internal/decode/primitives"
import { failingFieldPath } from "#sdk/internal/decode/trace"
import { readCaller, suspendInput, suspendMarked } from "#sdk/internal/defects"
import type { GuildListQuery, GuildListSummary } from "#sdk/guilds"
import {
    InputValidationFailure,
    inputValidationFailure,
    unsupportedKeyFailure,
    type InputValidationConstraint,
} from "#sdk/input-validation"
import type { RequestOptions } from "#sdk/client"

const maximumResponseBytes = 1_048_576
const maximumConcurrentRequests = 8
const defaultTimeoutMs = 30_000
const maximumPermissionBits = (1n << 64n) - 1n
const maximumInt32 = 2_147_483_647

function text(value: unknown): value is string {
    return typeof value === "string" && value.length > 0
}

// Fluxer OAuth form/query strings use createStringType(1), capped at 256 UTF-16 units.
// Reject normalization changes rather than changing opaque state or credentials. Redirect URIs follow Fluxer's own
// normalization in redirectUri below
function canonicalText(value: unknown): value is string {
    return (
        text(value) &&
        value.length <= 256 &&
        value.isWellFormed() &&
        // oxlint-disable-next-line no-control-regex -- the provider strips form feed before validating text
        value === value.replace(/[\u000c\u202e]/g, "").trim()
    )
}

const oauthScopeInputCapacity = 256

/** Fluxer's normalizeString for OAuth text: Remove form feed and U+202E, then trim
 * (packages/schema/src/primitives/SchemaPrimitives.ts:20 to :21 at 5f3fc0b1)
 */
const normalizeString = (value: string) =>
    // oxlint-disable-next-line no-control-regex -- the provider strips form feed before validating text
    value.replace(/[\u000c\u202e]/g, "").trim()

/** An IPv4 address of four decimal parts or a bracketed IPv6 address, as Fluxer's isIPLiteralHost reads a host */
const ipLiteralHost = (hostname: string) =>
    /^\d+\.\d+\.\d+\.\d+$/.test(hostname) ||
    (hostname.startsWith("[") && hostname.endsWith("]") && hostname.includes(":"))

/**
 * Read a redirect URI as Fluxer does at each step, or return undefined when Fluxer would refuse it. Authorization
 * compares the normalized text exactly with the application's registered redirect URIs, then stores its URL
 * serialization with the code, and the token exchange compares its redirect_uri exactly with that serialization
 * (fluxer_api/src/api/oauth/OAuth2Service.ts:55 to :60, :116 to :129 and :271 to :279 at 5f3fc0b1). So authorize
 * receives the normalized text and the exchange its serialization. Fluxer registers HTTPS URIs, and HTTP ones only
 * for a loopback host or an IP address (packages/schema/src/domains/oauth/OAuthSchemas.ts:368 to :380). Both forms
 * must fit Fluxer's 256-unit limit, and credentials or a fragment are refused locally
 */
function redirectUri(value: unknown): { readonly authorize: string; readonly exchange: string } | undefined {
    if (!text(value) || !value.isWellFormed()) return undefined
    const authorize = normalizeString(value)
    if (authorize.length === 0 || authorize.length > 256) return undefined
    try {
        const url = new URL(authorize)
        const loopback =
            url.hostname === "localhost" ||
            url.hostname === "127.0.0.1" ||
            url.hostname === "[::1]" ||
            url.hostname.endsWith(".localhost")
        const exchange = url.toString()
        return !url.username &&
            !url.password &&
            !url.hash &&
            exchange.length <= 256 &&
            (url.protocol === "https:" || (url.protocol === "http:" && (loopback || ipLiteralHost(url.hostname))))
            ? { authorize, exchange }
            : undefined
    } catch {
        return undefined
        // allow-silent: An unparsable redirect URI is rejected as invalid input
    }
}

function timeout(value: unknown): number | undefined {
    return value === undefined ||
        (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647)
        ? value
        : undefined
}

function retryAfter(response: Response): number | null {
    const value = response.headers.get("retry-after")
    const milliseconds = value === null ? NaN : Number(value) * 1_000
    return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.ceil(milliseconds) : null
}

function token(value: unknown): OAuthTokens | undefined {
    if (
        !record(value) ||
        !text(value.access_token) ||
        !text(value.refresh_token) ||
        value.token_type !== "Bearer" ||
        !text(value.scope)
    )
        return undefined
    if (typeof value.expires_in !== "number" || !Number.isSafeInteger(value.expires_in) || value.expires_in < 0)
        return undefined
    return Object.freeze({
        accessToken: value.access_token,
        refreshToken: value.refresh_token,
        tokenType: "Bearer",
        expiresInSeconds: value.expires_in,
        scopes: Object.freeze(value.scope.split(/[\s+]+/).filter(Boolean)),
    })
}

function identity(value: unknown): OAuthIdentity | undefined {
    if (!record(value) || !identifier(value.id) || !text(value.username) || typeof value.discriminator !== "string")
        return undefined
    if (
        (value.global_name !== null && typeof value.global_name !== "string") ||
        (value.avatar !== null && typeof value.avatar !== "string")
    )
        return undefined
    if (value.email !== undefined && value.email !== null && typeof value.email !== "string") return undefined
    if (value.verified !== undefined && value.verified !== null && typeof value.verified !== "boolean") return undefined
    if (
        (value.flags !== undefined && !int32(value.flags)) ||
        (value.avatar_color !== undefined && value.avatar_color !== null && !int32(value.avatar_color)) ||
        (value.bot !== undefined && typeof value.bot !== "boolean") ||
        (value.system !== undefined && typeof value.system !== "boolean")
    )
        return undefined
    return Object.freeze({
        id: value.id,
        username: value.username,
        discriminator: value.discriminator,
        displayName: value.global_name,
        avatar: value.avatar,
        ...(value.email === undefined ? {} : { email: value.email }),
        ...(value.verified === undefined ? {} : { verified: value.verified }),
        ...(value.flags === undefined ? {} : { flags: value.flags }),
        ...(value.avatar_color === undefined ? {} : { avatarColor: value.avatar_color }),
        ...(value.bot === undefined ? {} : { isBot: value.bot }),
        ...(value.system === undefined ? {} : { isSystem: value.system }),
    })
}

/** GET /oauth2/@me, an OAuth2MeResponse (packages/schema/src/domains/oauth/OAuthSchemas.ts:237 at 5f3fc0b1) */
function authorization(value: unknown): OAuthAuthorization | undefined {
    if (!record(value) || !record(value.application)) return undefined
    const application = value.application
    if (
        !identifier(application.id) ||
        typeof application.name !== "string" ||
        (application.icon !== null && typeof application.icon !== "string") ||
        (application.description !== null && typeof application.description !== "string") ||
        typeof application.bot_public !== "boolean" ||
        typeof application.bot_require_code_grant !== "boolean" ||
        !int32(application.flags) ||
        !Array.isArray(value.scopes) ||
        value.scopes.length > 50 ||
        !value.scopes.every((scope) => typeof scope === "string") ||
        typeof value.expires !== "string" ||
        Number.isNaN(Date.parse(value.expires))
    )
        return undefined
    const user = value.user === undefined ? undefined : identity(value.user)
    if (value.user !== undefined && user === undefined) return undefined
    return Object.freeze({
        application: Object.freeze({
            id: application.id,
            name: application.name,
            icon: application.icon,
            description: application.description,
            botPublic: application.bot_public,
            botRequireCodeGrant: application.bot_require_code_grant,
            flags: application.flags,
        }),
        scopes: Object.freeze([...(value.scopes as string[])]),
        expiresAt: value.expires,
        ...(user === undefined ? {} : { user }),
    })
}

function connections(value: unknown): readonly OAuthConnection[] | undefined {
    if (!Array.isArray(value)) return undefined
    const result: OAuthConnection[] = []
    for (const item of value) {
        if (
            !record(item) ||
            typeof item.id !== "string" ||
            (item.type !== "bsky" && item.type !== "domain") ||
            typeof item.name !== "string" ||
            typeof item.verified !== "boolean" ||
            typeof item.visibility_flags !== "number" ||
            !Number.isSafeInteger(item.visibility_flags) ||
            item.visibility_flags < 0 ||
            item.visibility_flags > maximumInt32 ||
            typeof item.sort_order !== "number" ||
            !Number.isSafeInteger(item.sort_order) ||
            item.sort_order < 0 ||
            item.sort_order > maximumInt32
        )
            return undefined
        result.push(
            Object.freeze({
                id: item.id,
                type: item.type,
                name: item.name,
                verified: item.verified,
                visibilityFlags: item.visibility_flags,
                sortOrder: item.sort_order,
            }),
        )
    }
    return Object.freeze(result)
}

function introspection(value: unknown): OAuthIntrospection | undefined {
    if (!record(value) || typeof value.active !== "boolean") return undefined
    if (!value.active) return Object.freeze({ active: false })
    if (
        !identifier(value.client_id) ||
        (value.sub !== undefined && !identifier(value.sub)) ||
        typeof value.scope !== "string" ||
        (value.token_type !== "Bearer" && value.token_type !== "refresh_token") ||
        typeof value.iat !== "number" ||
        !Number.isSafeInteger(value.iat) ||
        value.iat < 0 ||
        (value.exp !== undefined &&
            (typeof value.exp !== "number" || !Number.isSafeInteger(value.exp) || value.exp < 0))
    )
        return undefined
    return Object.freeze({
        active: true,
        clientId: value.client_id,
        ...(value.sub === undefined ? {} : { subjectId: value.sub }),
        tokenType: value.token_type,
        scopes: Object.freeze(value.scope.split(/[\s+]+/).filter(Boolean)),
        issuedAtUnixSeconds: value.iat,
        ...(value.exp === undefined ? {} : { expiresAtUnixSeconds: value.exp }),
    })
}

/** The input failure for an unsupported key in an OAuth input object */
function unsupportedInput(operation: OAuthOperation, failure: InputValidationFailure): OAuthOperationError {
    return new OAuthError({ operation, reason: "input", outcome: "notDispatched", inputValidation: failure.detail })
}

function inputError(
    operation: OAuthOperation,
    path: string,
    constraint: InputValidationConstraint,
    explanation: string,
): OAuthOperationError {
    return new OAuthError({
        operation,
        reason: "input",
        outcome: "notDispatched",
        inputValidation: inputValidationFailure(path, constraint, explanation).detail,
    })
}

function responseError(operation: OAuthOperation, status: number, responseField?: string): OAuthOperationError {
    const mutation = operation === "oauth.exchangeCode" || operation === "oauth.refresh" || operation === "oauth.revoke"
    return new OAuthError({
        operation,
        reason: "response",
        outcome: mutation ? "unknown" : "rejected",
        status,
        responseField,
    })
}

function operationError(
    operation: OAuthOperation,
    response: Response | undefined,
    cause: "notDispatched" | "unknown",
    details: { readonly body?: unknown; readonly cause?: unknown } = {},
): OAuthOperationError {
    const { body, cause: networkCause } = details
    const apiError = apiErrorDetail(body)
    const providerCode = unrecognizedProviderCode(body)
    const oauthError =
        record(body) &&
        typeof body.error === "string" &&
        [
            "invalid_grant",
            "invalid_client",
            "invalid_request",
            "invalid_scope",
            "unauthorized_client",
            "unsupported_grant_type",
        ].includes(body.error)
            ? body.error
            : null
    if (!response)
        return new OAuthError({ operation, reason: "network", outcome: cause, cause: new TransportError(networkCause) })
    if (response.status === 429)
        return new OAuthError({
            operation,
            reason: "rateLimit",
            outcome: "rejected",
            status: response.status,
            retryAfterMs: retryAfter(response),
            oauthError,
            apiError,
            providerCode,
        })
    const mutation = operation === "oauth.exchangeCode" || operation === "oauth.refresh" || operation === "oauth.revoke"
    return new OAuthError({
        operation,
        reason: "rejected",
        outcome: mutation && response.status >= 500 ? "unknown" : "rejected",
        status: response.status,
        oauthError,
        apiError,
        providerCode,
    })
}

async function body(
    response: Response,
    state: { reader: ReadableStreamDefaultReader<Uint8Array> | undefined; done: boolean },
): Promise<Uint8Array> {
    const reader = response.body?.getReader()
    if (!reader) throw new Error("missing response body")
    state.reader = reader
    const chunks: Uint8Array[] = []
    let length = 0
    for (;;) {
        const item = await reader.read().catch((error: unknown) => {
            // A failed read leaves the stream errored, so release must not cancel it again
            state.done = true
            throw new TransportError(error, "response body read")
        })
        if (item.done) {
            state.done = true
            break
        }
        length += item.value.byteLength
        if (length > maximumResponseBytes) throw new Error("response too large")
        chunks.push(item.value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    return bytes
}

async function json(
    response: Response,
    state: { reader: ReadableStreamDefaultReader<Uint8Array> | undefined; done: boolean },
): Promise<unknown> {
    return JSON.parse(new TextDecoder().decode(await body(response, state)))
}

export class OAuthOwner {
    #closed = false
    #active = 0
    #secret: string | undefined
    readonly #controllers = new Set<AbortController>()
    readonly #operations = new Set<Deferred.Deferred<void>>()
    readonly #http: HttpTransport
    readonly instance: InstanceResolver

    constructor(
        readonly clientId: string,
        secret: string,
        configuration: ReturnType<typeof instanceConfiguration>,
        scope: Scope.Scope,
        readonly logging: ClientLogger,
        http: HttpTransport = defaultHttpTransport,
    ) {
        this.#secret = secret
        this.#http = http
        this.instance = new InstanceResolver(
            configuration as Exclude<typeof configuration, ConfigurationError>,
            scope,
            {
                http,
            },
        )
    }

    shutdown(): Effect.Effect<void> {
        return Effect.uninterruptible(
            Effect.suspend(() => {
                this.#closed = true
                this.#secret = undefined
                for (const controller of this.#controllers) controller.abort()
                const operations = [...this.#operations]
                return Effect.all(
                    [
                        this.instance.shutdown(),
                        Effect.forEach(operations, (operation) => Deferred.await(operation), {
                            discard: true,
                            concurrency: "unbounded",
                        }),
                    ],
                    { concurrency: "unbounded", discard: true },
                ).pipe(
                    Effect.ensuring(Effect.withFiber((fiber) => Effect.sync(() => this.logging.flush(fiber.context)))),
                )
            }),
        )
    }

    /**
     * Log a rejected client ID and secret even when the application handles the failure, because it persists until
     * someone changes the configuration. A rejected user access token concerns one user, so
     * it is only returned
     */
    #logRejection(error: unknown, context: Context.Context<never>) {
        if (
            !(error instanceof OAuthError) ||
            error.reason !== "rejected" ||
            !(error.status === 401 || error.status === 403 || error.oauthError === "invalid_client") ||
            oauthCredential(error.operation, error.oauthError) !== "oauthClient"
        )
            return
        this.logging.log(
            {
                level: "warn",
                category: "rest",
                code: "rest.rejected",
                message: error.message,
                ...(error.status === null ? {} : { status: error.status }),
                fields: {
                    operation: error.operation,
                    oauthError: error.oauthError ?? undefined,
                    apiError: error.apiError?.providerCode,
                    hint: error.hint,
                },
            },
            context,
        )
    }

    #run<A>(
        operation: OAuthOperation,
        options: RequestOptions | undefined,
        task: (
            api: string,
            webapp: string,
            secret: string,
            progress: { knownResponseFailure: OAuthOperationError | undefined },
        ) => Effect.Effect<A, OAuthOperationError>,
    ): Effect.Effect<A, OAuthOperationError | ClientClosedError> {
        return Clock.clockWith((clock) =>
            suspendMarked<A, OAuthOperationError | ClientClosedError, never>(() => {
                // Only reading the caller options is marked, so a throw from their getters is an application fault
                const limit = readCaller(() => {
                    if (
                        options !== undefined &&
                        (typeof options !== "object" || options === null || Array.isArray(options))
                    )
                        return "invalid"
                    const unsupported =
                        options === undefined
                            ? undefined
                            : unsupportedKeyFailure(options, ["timeoutMs"], "options", "the OAuth operation options")
                    if (unsupported) return unsupported
                    const timeoutMs = options?.timeoutMs
                    const limit = timeout(timeoutMs)
                    return timeoutMs !== undefined && limit === undefined ? "invalid" : limit
                })
                if (limit instanceof InputValidationFailure)
                    return Effect.fail(
                        new OAuthError({
                            operation,
                            reason: "input",
                            outcome: "notDispatched",
                            inputValidation: limit.detail,
                        }),
                    )
                if (limit === "invalid")
                    return Effect.fail(
                        inputError(
                            operation,
                            "options",
                            "format",
                            "OAuth operation options may contain only a timeoutMs integer from 1 through 2,147,483,647",
                        ),
                    )
                if (this.#closed || !this.#secret) return Effect.fail(closedBeforeSend())
                if (this.#active >= maximumConcurrentRequests)
                    return Effect.fail(new OAuthError({ operation, reason: "busy", outcome: "notDispatched" }))
                this.#active += 1
                const completed = Deferred.makeUnsafe<void>()
                this.#operations.add(completed)
                const deadline = limit ?? defaultTimeoutMs
                const started = nowMs(clock)
                const progress: { knownResponseFailure: OAuthOperationError | undefined } = {
                    knownResponseFailure: undefined,
                }
                return this.instance.resolve().pipe(
                    withDeadline(
                        deadline,
                        () => new OAuthError({ operation, reason: "timeout", outcome: "notDispatched" }),
                    ),
                    mapFailureCause(
                        failures(OAuthError, ClientClosedError, RateLimitError, ConnectionError),
                        (error) =>
                            error instanceof OAuthError
                                ? error
                                : error instanceof ClientClosedError
                                  ? // Discovery closes without a request, so the closure reports that nothing was sent
                                    error.outcome === undefined
                                      ? closedBeforeSend()
                                      : error
                                  : this.#closed
                                    ? closedBeforeSend()
                                    : error instanceof RateLimitError
                                      ? new OAuthError({
                                            operation,
                                            reason: "rateLimit",
                                            outcome: "notDispatched",
                                            status: 429,
                                            retryAfterMs: error.retryAfterMs,
                                        })
                                      : new OAuthError({
                                            operation,
                                            reason: "network",
                                            outcome: "notDispatched",
                                            cause: new TransportError(error),
                                        }),
                    ),
                    Effect.flatMap((endpoints): Effect.Effect<A, OAuthOperationError | ClientClosedError> =>
                        this.#closed || !this.#secret
                            ? Effect.fail(closedBeforeSend())
                            : task(endpoints.apiPublic, endpoints.webapp, this.#secret, progress).pipe(
                                  withDeadline(
                                      Math.max(1, deadline - (nowMs(clock) - started)),
                                      () =>
                                          progress.knownResponseFailure ??
                                          new OAuthError({ operation, reason: "timeout", outcome: "unknown" }),
                                  ),
                              ),
                    ),
                    Effect.tapError((error) =>
                        Effect.withFiber((fiber) => Effect.sync(() => this.#logRejection(error, fiber.context))),
                    ),
                    Effect.ensuring(
                        Effect.sync(() => {
                            this.#active -= 1
                            this.#operations.delete(completed)
                            Deferred.doneUnsafe(completed, Effect.void)
                        }),
                    ),
                ) as Effect.Effect<A, OAuthOperationError | ClientClosedError>
            }),
        )
    }

    authorizationUrl(
        input: OAuthAuthorizationInput,
        options?: RequestOptions,
    ): Effect.Effect<string, OAuthOperationError | ClientClosedError> {
        return suspendInput(() => {
            if (!record(input))
                return Effect.fail(
                    inputError(
                        "oauth.authorizationUrl",
                        "input",
                        "type",
                        "OAuth authorization input must be an object",
                    ),
                )
            const unsupported = unsupportedKeyFailure(
                input,
                [
                    "redirectUri",
                    "scopes",
                    "state",
                    "codeChallenge",
                    "guildId",
                    "channelId",
                    "permissions",
                    "disableGuildSelect",
                ],
                "input",
                "the OAuth authorization input",
            )
            if (unsupported) return Effect.fail(unsupportedInput("oauth.authorizationUrl", unsupported))
            const redirect = redirectUri(input.redirectUri)
            if (redirect === undefined)
                return Effect.fail(
                    inputError(
                        "oauth.authorizationUrl",
                        "redirectUri",
                        "format",
                        "Redirect URI must be HTTPS, or HTTP for a loopback host or an IP address, without credentials or a fragment, and at most 256 UTF-16 code units",
                    ),
                )
            const state = input.state
            if (!canonicalText(state))
                return Effect.fail(
                    inputError(
                        "oauth.authorizationUrl",
                        "state",
                        "format",
                        "OAuth state must contain 1 through 256 UTF-16 code units without leading or trailing whitespace",
                    ),
                )
            const codeChallenge = input.codeChallenge
            if (typeof codeChallenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge))
                return Effect.fail(
                    inputError(
                        "oauth.authorizationUrl",
                        "codeChallenge",
                        "format",
                        "PKCE code challenge must contain exactly 43 base64url characters",
                    ),
                )
            const scopeInput = input.scopes
            if (!Array.isArray(scopeInput))
                return Effect.fail(
                    inputError("oauth.authorizationUrl", "scopes", "length", "OAuth scopes must be a non-empty array"),
                )
            const scopeLength = scopeInput.length
            if (scopeLength === 0 || scopeLength > oauthScopeInputCapacity)
                return Effect.fail(
                    inputError(
                        "oauth.authorizationUrl",
                        "scopes",
                        "length",
                        "OAuth scopes must contain 1 through 256 entries",
                    ),
                )
            const scopes = [...new Set(Array.from({ length: scopeLength }, (_, index) => scopeInput[index]))]
            if (scopes.some((scope) => !["identify", "email", "guilds", "connections", "bot"].includes(scope)))
                return Effect.fail(
                    inputError(
                        "oauth.authorizationUrl",
                        "scopes[]",
                        "allowedValue",
                        "OAuth scopes must be identify, email, guilds, connections, or bot",
                    ),
                )
            const botScope = scopes.includes("bot")
            const rawGuildId = input.guildId
            const rawChannelId = input.channelId
            const guildId = rawGuildId === undefined ? undefined : inputId(rawGuildId)
            const channelId = rawChannelId === undefined ? undefined : inputId(rawChannelId)
            const permissions = input.permissions
            const disableGuildSelect = input.disableGuildSelect
            const installationInput =
                rawGuildId !== undefined ||
                rawChannelId !== undefined ||
                permissions !== undefined ||
                disableGuildSelect !== undefined
            if (installationInput && !botScope)
                return Effect.fail(
                    inputError(
                        "oauth.authorizationUrl",
                        "botInstallation",
                        "required",
                        "Bot installation options require the bot scope",
                    ),
                )
            if (rawGuildId !== undefined && guildId === undefined)
                return Effect.fail(
                    inputError(
                        "oauth.authorizationUrl",
                        "guildId",
                        "format",
                        "Guild target must be a decimal ID, because JavaScript numbers cannot hold Fluxer IDs exactly",
                    ),
                )
            if (rawChannelId !== undefined && channelId === undefined)
                return Effect.fail(
                    inputError(
                        "oauth.authorizationUrl",
                        "channelId",
                        "format",
                        "Channel target must be a decimal ID, because JavaScript numbers cannot hold Fluxer IDs exactly",
                    ),
                )
            if (rawGuildId !== undefined && rawChannelId !== undefined)
                return Effect.fail(
                    inputError(
                        "oauth.authorizationUrl",
                        "channelId",
                        "relationship",
                        "Channel target cannot be used with guild target",
                    ),
                )
            if (
                permissions !== undefined &&
                (typeof permissions !== "bigint" || permissions < 0n || permissions > maximumPermissionBits)
            )
                return Effect.fail(
                    inputError(
                        "oauth.authorizationUrl",
                        "permissions",
                        "range",
                        "Bot permissions must be an unsigned 64-bit bitfield",
                    ),
                )
            if (disableGuildSelect !== undefined && typeof disableGuildSelect !== "boolean")
                return Effect.fail(
                    inputError(
                        "oauth.authorizationUrl",
                        "disableGuildSelect",
                        "type",
                        "The option disableGuildSelect must be a boolean",
                    ),
                )
            const request = {
                redirectUri: redirect.authorize,
                scopes: Object.freeze(scopes),
                state,
                codeChallenge,
                guildId,
                channelId,
                permissions,
                disableGuildSelect,
            }
            return this.#run("oauth.authorizationUrl", options, (_api, webapp) =>
                Effect.sync(() => {
                    const url = new URL("oauth2/authorize", `${webapp}/`)
                    const query = new URLSearchParams({
                        client_id: this.clientId,
                        response_type: "code",
                        redirect_uri: request.redirectUri,
                        scope: request.scopes.join(" "),
                        state: request.state,
                        code_challenge: request.codeChallenge,
                        code_challenge_method: "S256",
                    })
                    if (request.guildId !== undefined) query.set("guild_id", request.guildId)
                    if (request.channelId !== undefined) query.set("channel_id", request.channelId)
                    if (request.permissions !== undefined) query.set("permissions", request.permissions.toString())
                    if (request.disableGuildSelect !== undefined)
                        query.set("disable_guild_select", String(request.disableGuildSelect))
                    url.search = query.toString()
                    return url.toString()
                }),
            )
        })
    }

    #request<A>(
        operation: OAuthOperation,
        api: string,
        path: string,
        init: RequestInit,
        decode: (body: unknown) => A | undefined,
        progress: { knownResponseFailure: OAuthOperationError | undefined },
        emptyResponse = false,
    ): Effect.Effect<A, OAuthOperationError> {
        // What the Debug request record reports: The status and the time until response headers, as REST records it
        const seen: { status: number | null; durationMs: number | null } = { status: null, durationMs: null }
        return Clock.clockWith((clock) => {
            const started = nowMs(clock)
            const responded = (status: number) => {
                seen.status = status
                seen.durationMs = Math.round(nowMs(clock) - started)
            }
            return this.#exchange(operation, api, path, init, decode, progress, emptyResponse, responded).pipe(
                Effect.onExit((exit) =>
                    Effect.withFiber((fiber) =>
                        Effect.sync(() =>
                            this.#logRequest(
                                init.method ?? "GET",
                                path,
                                seen.status,
                                seen.durationMs ?? Math.round(nowMs(clock) - started),
                                exit,
                                fiber.context,
                            ),
                        ),
                    ),
                ),
            )
        })
    }

    /** One Debug rest.request record per OAuth request, with its method, route, status and duration but no query,
     * form, body or Authorization value */
    #logRequest(
        method: string,
        path: string,
        status: number | null,
        durationMs: number,
        exit: Exit.Exit<unknown, unknown>,
        context: Context.Context<never>,
    ) {
        if (!this.logging.enabled("debug", "rest")) return
        const route = path.split("?")[0]!
        const outcome =
            status !== null
                ? `returned ${status}`
                : Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
                  ? "was cancelled"
                  : "failed before a response"
        this.logging.log(
            {
                level: "debug",
                category: "rest",
                code: "rest.request",
                message: `${method} ${route} ${outcome} in ${durationMs} ms`,
                route,
                ...(status === null ? {} : { status }),
                durationMs,
                attempt: 1,
                fields: { method },
            },
            context,
        )
    }

    #exchange<A>(
        operation: OAuthOperation,
        api: string,
        path: string,
        init: RequestInit,
        decode: (body: unknown) => A | undefined,
        progress: { knownResponseFailure: OAuthOperationError | undefined },
        emptyResponse: boolean,
        responded: (status: number) => void,
    ): Effect.Effect<A, OAuthOperationError> {
        return Effect.acquireUseRelease(
            Effect.sync(
                (): {
                    controller: AbortController
                    settled: Promise<void>
                    responseSettled: Promise<void>
                    settleResponse: () => void
                    response: Response | undefined
                    dispatched: boolean
                    knownResponseFailure: OAuthOperationError | undefined
                    reader: ReadableStreamDefaultReader<Uint8Array> | undefined
                    done: boolean
                } => {
                    const controller = new AbortController()
                    let settleResponse = () => {}
                    const responseSettled = new Promise<void>((resolve) => {
                        settleResponse = resolve
                    })
                    this.#controllers.add(controller)
                    return {
                        controller,
                        settled: Promise.resolve(),
                        responseSettled,
                        settleResponse,
                        response: undefined,
                        dispatched: false,
                        knownResponseFailure: undefined,
                        reader: undefined,
                        done: false,
                    }
                },
            ),
            (state) =>
                Effect.tryPromise({
                    try: () => {
                        const work = (async () => {
                            let response: Response | undefined
                            try {
                                state.dispatched = true
                                response = await this.#http(`${api}${path}`, {
                                    ...init,
                                    redirect: "error",
                                    signal: state.controller.signal,
                                })
                                state.response = response
                                responded(response.status)
                                if (!response.ok)
                                    state.knownResponseFailure = progress.knownResponseFailure = operationError(
                                        operation,
                                        response,
                                        "unknown",
                                    )
                                state.settleResponse()
                                if (state.controller.signal.aborted)
                                    throw operationError(operation, response, "unknown")
                                const decoded =
                                    response.status === 204
                                        ? undefined
                                        : emptyResponse && response.ok
                                          ? (await body(response, state), undefined)
                                          : await json(response, state)
                                if (!response.ok)
                                    throw operationError(operation, response, "unknown", { body: decoded })
                                if (emptyResponse) return true as A
                                const result = decode(decoded)
                                // Name the field the decoder stopped at, as REST does, without keeping any value
                                if (result === undefined)
                                    throw responseError(operation, response.status, failingFieldPath(decode, decoded))
                                return result
                            } catch (error) {
                                if (error instanceof OAuthError) throw error
                                // A lost successful body leaves the outcome unknown. A failed reply keeps its status below
                                if (response?.ok)
                                    throw error instanceof TransportError
                                        ? new OAuthError({
                                              operation,
                                              reason: "network",
                                              outcome: "unknown",
                                              status: response.status,
                                              cause: error,
                                          })
                                        : responseError(operation, response.status)
                                throw operationError(
                                    operation,
                                    response,
                                    state.dispatched ? "unknown" : "notDispatched",
                                    { cause: error },
                                )
                            } finally {
                                state.settleResponse()
                            }
                        })()
                        // allow-silent: The work promise itself is returned and its rejection observed by the caller, so this only records settlement
                        state.settled = work.then(
                            () => undefined,
                            () => undefined,
                        )
                        return Promise.race([
                            work,
                            new Promise<never>((_resolve, reject) => {
                                const abort = () =>
                                    reject(state.knownResponseFailure ?? new Error("OAuth request aborted"))
                                if (state.controller.signal.aborted) abort()
                                else state.controller.signal.addEventListener("abort", abort, { once: true })
                                // allow-silent: The work promise is raced and returned below, so its rejection reaches the caller. This only removes the listener
                                void work.then(
                                    () => state.controller.signal.removeEventListener("abort", abort),
                                    () => state.controller.signal.removeEventListener("abort", abort),
                                )
                            }),
                        ])
                    },
                    catch: (error) =>
                        error instanceof OAuthError
                            ? error
                            : new OAuthError({
                                  operation,
                                  reason: "network",
                                  outcome: "unknown",
                                  cause: new TransportError(error),
                              }),
                }),
            (state) =>
                Effect.promise(async () => {
                    state.controller.abort()
                    this.#controllers.delete(state.controller)
                    const failures: unknown[] = []
                    await state.responseSettled
                    if (state.reader) {
                        if (!state.done)
                            try {
                                await state.reader.cancel()
                            } catch (error) {
                                if (!(state.controller.signal.aborted && error === state.controller.signal.reason))
                                    failures.push(error)
                            }
                        try {
                            state.reader.releaseLock()
                        } catch (error) {
                            failures.push(error)
                        }
                    } else if (state.response && !state.response.bodyUsed) {
                        try {
                            await state.response.body?.cancel()
                        } catch (error) {
                            if (!(state.controller.signal.aborted && error === state.controller.signal.reason))
                                failures.push(error)
                        }
                    }
                    await state.settled
                    // Cleanup faults keep their original values, as REST and discovery cleanup faults do. Error rendering
                    // masks credentials, and the response body never becomes part of a cleanup fault
                    if (failures.length === 1) throw failures[0]
                    if (failures.length > 1) throw new AggregateError(failures, "OAuth response cleanup failed")
                }),
        )
    }

    exchangeCode(
        input: OAuthCodeExchangeInput,
        options?: RequestOptions,
    ): Effect.Effect<OAuthTokens, OAuthOperationError | ClientClosedError> {
        return suspendInput(() => {
            if (!record(input))
                return Effect.fail(
                    inputError("oauth.exchangeCode", "input", "type", "OAuth code exchange input must be an object"),
                )
            const unsupported = unsupportedKeyFailure(
                input,
                ["code", "redirectUri", "codeVerifier"],
                "input",
                "the OAuth code exchange input",
            )
            if (unsupported) return Effect.fail(unsupportedInput("oauth.exchangeCode", unsupported))
            const code = input.code
            if (!canonicalText(code))
                return Effect.fail(
                    inputError(
                        "oauth.exchangeCode",
                        "code",
                        "format",
                        "Authorization code must contain 1 through 256 UTF-16 code units without leading or trailing whitespace",
                    ),
                )
            const redirect = redirectUri(input.redirectUri)
            if (redirect === undefined)
                return Effect.fail(
                    inputError(
                        "oauth.exchangeCode",
                        "redirectUri",
                        "format",
                        "Redirect URI must be HTTPS, or HTTP for a loopback host or an IP address, without credentials or a fragment, and at most 256 UTF-16 code units",
                    ),
                )
            const codeVerifier = input.codeVerifier
            if (typeof codeVerifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier))
                return Effect.fail(
                    inputError(
                        "oauth.exchangeCode",
                        "codeVerifier",
                        "format",
                        "PKCE code verifier must contain 43 through 128 unreserved characters",
                    ),
                )
            const request = { code, redirectUri: redirect.exchange, codeVerifier }
            return this.#run("oauth.exchangeCode", options, (api, _webapp, secret, progress) =>
                this.#request(
                    "oauth.exchangeCode",
                    api,
                    "/oauth2/token",
                    {
                        method: "POST",
                        headers: {
                            authorization: `Basic ${Buffer.from(`${this.clientId}:${secret}`).toString("base64")}`,
                            "content-type": "application/x-www-form-urlencoded",
                        },
                        body: new URLSearchParams({
                            grant_type: "authorization_code",
                            code: request.code,
                            redirect_uri: request.redirectUri,
                            code_verifier: request.codeVerifier,
                        }).toString(),
                    },
                    token,
                    progress,
                ),
            )
        })
    }

    refresh(
        refreshToken: string,
        options?: RequestOptions,
    ): Effect.Effect<OAuthTokens, OAuthOperationError | ClientClosedError> {
        if (!canonicalText(refreshToken))
            return Effect.fail(
                inputError(
                    "oauth.refresh",
                    "refreshToken",
                    "format",
                    "Refresh token must contain 1 through 256 UTF-16 code units without leading or trailing whitespace",
                ),
            )
        return this.#run("oauth.refresh", options, (api, _webapp, secret, progress) =>
            this.#request(
                "oauth.refresh",
                api,
                "/oauth2/token",
                {
                    method: "POST",
                    headers: {
                        authorization: `Basic ${Buffer.from(`${this.clientId}:${secret}`).toString("base64")}`,
                        "content-type": "application/x-www-form-urlencoded",
                    },
                    body: new URLSearchParams({
                        grant_type: "refresh_token",
                        refresh_token: refreshToken,
                    }).toString(),
                },
                token,
                progress,
            ),
        )
    }

    revoke(
        value: { readonly token: string; readonly tokenTypeHint?: "access_token" | "refresh_token" },
        options?: RequestOptions,
    ): Effect.Effect<void, OAuthOperationError | ClientClosedError> {
        return suspendInput(() => {
            if (!record(value))
                return Effect.fail(inputError("oauth.revoke", "input", "type", "OAuth revoke input must be an object"))
            const unsupported = unsupportedKeyFailure(
                value,
                ["token", "tokenTypeHint"],
                "input",
                "the OAuth revoke input",
            )
            if (unsupported) return Effect.fail(unsupportedInput("oauth.revoke", unsupported))
            const token = value.token
            if (!canonicalText(token))
                return Effect.fail(
                    inputError(
                        "oauth.revoke",
                        "token",
                        "format",
                        "Revoked token must contain 1 through 256 UTF-16 code units without leading or trailing whitespace",
                    ),
                )
            const tokenTypeHint = value.tokenTypeHint
            if (tokenTypeHint !== undefined && tokenTypeHint !== "access_token" && tokenTypeHint !== "refresh_token")
                return Effect.fail(
                    inputError(
                        "oauth.revoke",
                        "tokenTypeHint",
                        "allowedValue",
                        "Token type hint must be access_token or refresh_token",
                    ),
                )
            const request = { token, tokenTypeHint }
            return this.#run("oauth.revoke", options, (api, _webapp, secret, progress) =>
                this.#request(
                    "oauth.revoke",
                    api,
                    "/oauth2/token/revoke",
                    {
                        method: "POST",
                        headers: {
                            authorization: `Basic ${Buffer.from(`${this.clientId}:${secret}`).toString("base64")}`,
                            "content-type": "application/x-www-form-urlencoded",
                        },
                        body: new URLSearchParams({
                            token: request.token,
                            // Fluxer looks up refresh tokens only for this hint and then falls back to access tokens,
                            // so it is the default that finds either kind
                            token_type_hint: request.tokenTypeHint ?? "refresh_token",
                        }).toString(),
                    },
                    () => true,
                    progress,
                    true,
                ).pipe(Effect.asVoid),
            )
        })
    }

    fetchIdentity(
        accessToken: string,
        options?: RequestOptions,
    ): Effect.Effect<OAuthIdentity, OAuthOperationError | ClientClosedError> {
        if (!text(accessToken))
            return Effect.fail(
                inputError("oauth.fetchIdentity", "accessToken", "required", "Access token must be a non-empty string"),
            )
        return this.#run("oauth.fetchIdentity", options, (api, _webapp, _secret, progress) =>
            this.#request(
                "oauth.fetchIdentity",
                api,
                "/oauth2/userinfo",
                { method: "GET", headers: { authorization: `Bearer ${accessToken}` } },
                identity,
                progress,
            ),
        )
    }

    fetchAuthorization(
        accessToken: string,
        options?: RequestOptions,
    ): Effect.Effect<OAuthAuthorization, OAuthOperationError | ClientClosedError> {
        if (!text(accessToken))
            return Effect.fail(
                inputError(
                    "oauth.fetchAuthorization",
                    "accessToken",
                    "required",
                    "Access token must be a non-empty string",
                ),
            )
        return this.#run("oauth.fetchAuthorization", options, (api, _webapp, _secret, progress) =>
            this.#request(
                "oauth.fetchAuthorization",
                api,
                "/oauth2/@me",
                { method: "GET", headers: { authorization: `Bearer ${accessToken}` } },
                authorization,
                progress,
            ),
        )
    }

    fetchGuilds(
        accessToken: string,
        query: GuildListQuery = {},
        options?: RequestOptions,
    ): Effect.Effect<readonly GuildListSummary[], OAuthOperationError | ClientClosedError> {
        return suspendInput(() => {
            const request = guildList(query)
            if (!text(accessToken))
                return Effect.fail(
                    inputError(
                        "oauth.fetchGuilds",
                        "accessToken",
                        "required",
                        "Access token must be a non-empty string",
                    ),
                )
            if (request instanceof InputValidationFailure)
                return Effect.fail(
                    new OAuthError({
                        operation: "oauth.fetchGuilds",
                        reason: "input",
                        outcome: "notDispatched",
                        inputValidation: request.detail,
                    }),
                )
            return this.#run("oauth.fetchGuilds", options, (api, _webapp, _secret, progress) =>
                this.#request(
                    "oauth.fetchGuilds",
                    api,
                    request.path,
                    { method: "GET", headers: { authorization: `Bearer ${accessToken}` } },
                    request.decode,
                    progress,
                ),
            )
        })
    }

    fetchConnections(
        accessToken: string,
        options?: RequestOptions,
    ): Effect.Effect<readonly OAuthConnection[], OAuthOperationError | ClientClosedError> {
        if (!text(accessToken))
            return Effect.fail(
                inputError(
                    "oauth.fetchConnections",
                    "accessToken",
                    "required",
                    "Access token must be a non-empty string",
                ),
            )
        return this.#run("oauth.fetchConnections", options, (api, _webapp, _secret, progress) =>
            this.#request(
                "oauth.fetchConnections",
                api,
                "/users/@me/connections",
                { method: "GET", headers: { authorization: `Bearer ${accessToken}` } },
                connections,
                progress,
            ),
        )
    }

    introspect(
        token: string,
        options?: RequestOptions,
    ): Effect.Effect<OAuthIntrospection, OAuthOperationError | ClientClosedError> {
        if (!canonicalText(token))
            return Effect.fail(
                inputError(
                    "oauth.introspect",
                    "token",
                    "format",
                    "Inspected token must contain 1 through 256 UTF-16 code units without leading or trailing whitespace",
                ),
            )
        return this.#run("oauth.introspect", options, (api, _webapp, secret, progress) =>
            this.#request(
                "oauth.introspect",
                api,
                "/oauth2/introspect",
                {
                    method: "POST",
                    headers: {
                        authorization: `Basic ${Buffer.from(`${this.clientId}:${secret}`).toString("base64")}`,
                        "content-type": "application/x-www-form-urlencoded",
                    },
                    body: new URLSearchParams({ token }).toString(),
                },
                introspection,
                progress,
            ),
        )
    }
}

const oauthConfigKeys = ["clientId", "clientSecret", "instance", "logging"]

export function makeOAuthOwner(
    config: OAuthConfig,
    scope: Scope.Scope,
    native = false,
): Effect.Effect<OAuthOwner, ConfigurationError> {
    return suspendInput(() => {
        if (!record(config) || Object.keys(config).some((key) => !oauthConfigKeys.includes(key)))
            return Effect.fail(
                new ConfigurationError(
                    "configuration",
                    "OAuth configuration must be an object with only clientId, clientSecret, instance, and logging",
                ),
            )
        const clientId = inputId(config.clientId)
        const clientSecret = config.clientSecret
        if (clientId === undefined || !text(clientSecret))
            return Effect.fail(
                new ConfigurationError(
                    "configuration",
                    "OAuth configuration requires a decimal clientId and nonempty clientSecret",
                ),
            )
        const instance = config.instance
        const configuration = instanceConfiguration(instance)
        if (configuration instanceof ConfigurationError) return Effect.fail(configuration)
        const logging = loggingConfiguration(config.logging, native)
        if (logging instanceof ConfigurationError) return Effect.fail(logging)
        logging.addSecret(clientSecret)
        return Effect.withFiber((fiber) => {
            // Native records outside an operation use the creating fiber's logger and annotations
            if (native) logging.context = fiber.context
            return Effect.succeed(new OAuthOwner(clientId, clientSecret, configuration, scope, logging))
        })
    })
}
