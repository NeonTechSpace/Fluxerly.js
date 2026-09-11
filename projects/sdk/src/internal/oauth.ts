import { Deferred, Effect, Scope } from "effect"
import type {
    OAuthAuthorizationInput,
    OAuthCodeExchangeInput,
    OAuthConfig,
    OAuthIdentity,
    OAuthOperation,
    OAuthOperationError,
    OAuthOperationOptions,
    OAuthTokens,
} from "#sdk/oauth"
import { OAuthOperationError as OAuthError } from "#sdk/oauth"
import { ClientClosedError, ConfigurationError } from "#sdk/errors"
import { withDeadline } from "#sdk/internal/effect-failures"
import { InstanceResolver, instanceConfiguration } from "#sdk/internal/instance"
import { guildList } from "#sdk/internal/guild-lifecycle"
import { identifier, record } from "#sdk/internal/message"
import type { GuildListQuery, GuildListSummary } from "#sdk/guilds"

const maximumResponseBytes = 1_048_576
const maximumConcurrentRequests = 8
const defaultTimeoutMs = 30_000

/** Carries no upstream text, payload, credential, or cause into either public boundary */
class OAuthResponseCleanupDefect extends Error {
    constructor() {
        super("OAuth response cleanup failed")
    }
}

function text(value: unknown): value is string {
    return typeof value === "string" && value.length > 0
}

function redirectUri(value: unknown): value is string {
    if (!text(value)) return false
    try {
        const url = new URL(value)
        const loopback =
            url.hostname === "localhost" ||
            url.hostname === "127.0.0.1" ||
            url.hostname === "[::1]" ||
            url.hostname.endsWith(".localhost")
        return (
            !url.username &&
            !url.password &&
            !url.hash &&
            (url.protocol === "https:" || (url.protocol === "http:" && loopback))
        )
    } catch {
        return false
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
    return Object.freeze({
        id: value.id,
        username: value.username,
        discriminator: value.discriminator,
        globalName: value.global_name,
        avatar: value.avatar,
        ...(value.email === undefined ? {} : { email: value.email }),
        ...(value.verified === undefined ? {} : { verified: value.verified }),
    })
}

function inputError(operation: OAuthOperation): OAuthOperationError {
    return new OAuthError(operation, "input", "notDispatched")
}

function responseError(operation: OAuthOperation, status: number): OAuthOperationError {
    const mutation = operation === "oauth.exchangeCode" || operation === "oauth.refresh" || operation === "oauth.revoke"
    return new OAuthError(operation, "response", mutation ? "unknown" : "rejected", status)
}

function operationError(
    operation: OAuthOperation,
    response: Response | undefined,
    cause: "notDispatched" | "unknown",
    body?: unknown,
): OAuthOperationError {
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
    if (!response) return new OAuthError(operation, "network", cause)
    if (response.status === 429)
        return new OAuthError(operation, "rateLimit", "rejected", response.status, retryAfter(response), oauthError)
    const mutation = operation === "oauth.exchangeCode" || operation === "oauth.refresh" || operation === "oauth.revoke"
    return new OAuthError(
        operation,
        "rejected",
        mutation && response.status >= 500 ? "unknown" : "rejected",
        response.status,
        null,
        oauthError,
    )
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
        const item = await reader.read()
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
    readonly instance: InstanceResolver

    constructor(
        readonly clientId: string,
        secret: string,
        configuration: ReturnType<typeof instanceConfiguration>,
        scope: Scope.Scope,
    ) {
        this.#secret = secret
        this.instance = new InstanceResolver(configuration as Exclude<typeof configuration, ConfigurationError>, scope)
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
                )
            }),
        )
    }

    #run<A>(
        operation: OAuthOperation,
        options: OAuthOperationOptions | undefined,
        task: (
            api: string,
            webapp: string,
            secret: string,
            progress: { knownResponseFailure: OAuthOperationError | undefined },
        ) => Effect.Effect<A, OAuthOperationError>,
    ): Effect.Effect<A, OAuthOperationError | ClientClosedError> {
        const limit = timeout(options?.timeoutMs)
        if (
            options !== undefined &&
            (typeof options !== "object" ||
                options === null ||
                Object.keys(options).some((key) => key !== "timeoutMs") ||
                (options.timeoutMs !== undefined && limit === undefined))
        )
            return Effect.fail(inputError(operation))
        return Effect.suspend<A, OAuthOperationError | ClientClosedError, never>(() => {
            if (this.#closed || !this.#secret) return Effect.fail(new ClientClosedError())
            if (this.#active >= maximumConcurrentRequests)
                return Effect.fail(new OAuthError(operation, "busy", "notDispatched"))
            this.#active += 1
            const completed = Deferred.makeUnsafe<void>()
            this.#operations.add(completed)
            const deadline = limit ?? defaultTimeoutMs
            const started = Date.now()
            const progress: { knownResponseFailure: OAuthOperationError | undefined } = {
                knownResponseFailure: undefined,
            }
            return this.instance.resolve().pipe(
                withDeadline(deadline, () => new OAuthError(operation, "timeout", "notDispatched")),
                Effect.mapError((error) =>
                    error instanceof OAuthError || error instanceof ClientClosedError
                        ? error
                        : this.#closed
                          ? new ClientClosedError()
                          : new OAuthError(operation, "network", "notDispatched"),
                ),
                Effect.flatMap((endpoints): Effect.Effect<A, OAuthOperationError | ClientClosedError> =>
                    this.#closed || !this.#secret
                        ? Effect.fail(new ClientClosedError())
                        : task(endpoints.apiPublic, endpoints.webapp, this.#secret, progress).pipe(
                              withDeadline(
                                  Math.max(1, deadline - (Date.now() - started)),
                                  () =>
                                      progress.knownResponseFailure ?? new OAuthError(operation, "timeout", "unknown"),
                              ),
                          ),
                ),
                Effect.ensuring(
                    Effect.sync(() => {
                        this.#active -= 1
                        this.#operations.delete(completed)
                        Deferred.doneUnsafe(completed, Effect.void)
                    }),
                ),
            ) as Effect.Effect<A, OAuthOperationError | ClientClosedError>
        })
    }

    authorizationUrl(
        input: OAuthAuthorizationInput,
        options?: OAuthOperationOptions,
    ): Effect.Effect<string, OAuthOperationError | ClientClosedError> {
        if (
            !record(input) ||
            !redirectUri(input.redirectUri) ||
            !text(input.state) ||
            typeof input.codeChallenge !== "string" ||
            !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge) ||
            !Array.isArray(input.scopes) ||
            input.scopes.length === 0 ||
            Array.from(input.scopes).some((scope) => !["identify", "email", "guilds", "connections"].includes(scope))
        )
            return Effect.fail(inputError("oauth.authorizationUrl"))
        const request = {
            redirectUri: input.redirectUri,
            scopes: Object.freeze([...input.scopes]),
            state: input.state,
            codeChallenge: input.codeChallenge,
        }
        return this.#run("oauth.authorizationUrl", options, (_api, webapp) =>
            Effect.sync(() => {
                const url = new URL("oauth2/authorize", `${webapp}/`)
                url.search = new URLSearchParams({
                    client_id: this.clientId,
                    response_type: "code",
                    redirect_uri: request.redirectUri,
                    scope: request.scopes.join(" "),
                    state: request.state,
                    code_challenge: request.codeChallenge,
                    code_challenge_method: "S256",
                }).toString()
                return url.toString()
            }),
        )
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
                                response = await fetch(`${api}${path}`, {
                                    ...init,
                                    redirect: "error",
                                    signal: state.controller.signal,
                                })
                                state.response = response
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
                                if (!response.ok) throw operationError(operation, response, "unknown", decoded)
                                if (emptyResponse) return true as A
                                const result = decode(decoded)
                                if (result === undefined) throw responseError(operation, response.status)
                                return result
                            } catch (error) {
                                if (error instanceof OAuthError) throw error
                                if (response?.ok) throw responseError(operation, response.status)
                                throw operationError(
                                    operation,
                                    response,
                                    state.dispatched ? "unknown" : "notDispatched",
                                )
                            } finally {
                                state.settleResponse()
                            }
                        })()
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
                                void work.then(
                                    () => state.controller.signal.removeEventListener("abort", abort),
                                    () => state.controller.signal.removeEventListener("abort", abort),
                                )
                            }),
                        ])
                    },
                    catch: (error) =>
                        error instanceof OAuthError ? error : new OAuthError(operation, "network", "unknown"),
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
                    if (failures.length) throw new OAuthResponseCleanupDefect()
                }),
        )
    }

    exchangeCode(
        input: OAuthCodeExchangeInput,
        options?: OAuthOperationOptions,
    ): Effect.Effect<OAuthTokens, OAuthOperationError | ClientClosedError> {
        if (
            !record(input) ||
            !text(input.code) ||
            !redirectUri(input.redirectUri) ||
            !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)
        )
            return Effect.fail(inputError("oauth.exchangeCode"))
        const request = { code: input.code, redirectUri: input.redirectUri, codeVerifier: input.codeVerifier }
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
    }

    refresh(
        refreshToken: string,
        options?: OAuthOperationOptions,
    ): Effect.Effect<OAuthTokens, OAuthOperationError | ClientClosedError> {
        if (!text(refreshToken)) return Effect.fail(inputError("oauth.refresh"))
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
        options?: OAuthOperationOptions,
    ): Effect.Effect<void, OAuthOperationError | ClientClosedError> {
        if (
            !record(value) ||
            !text(value.token) ||
            (value.tokenTypeHint !== undefined &&
                value.tokenTypeHint !== "access_token" &&
                value.tokenTypeHint !== "refresh_token")
        )
            return Effect.fail(inputError("oauth.revoke"))
        const request = { token: value.token, tokenTypeHint: value.tokenTypeHint }
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
                        ...(request.tokenTypeHint === undefined ? {} : { token_type_hint: request.tokenTypeHint }),
                    }).toString(),
                },
                () => true,
                progress,
                true,
            ).pipe(Effect.asVoid),
        )
    }

    fetchIdentity(
        accessToken: string,
        options?: OAuthOperationOptions,
    ): Effect.Effect<OAuthIdentity, OAuthOperationError | ClientClosedError> {
        if (!text(accessToken)) return Effect.fail(inputError("oauth.fetchIdentity"))
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

    fetchGuilds(
        accessToken: string,
        query: GuildListQuery = {},
        options?: OAuthOperationOptions,
    ): Effect.Effect<readonly GuildListSummary[], OAuthOperationError | ClientClosedError> {
        const request = guildList(query)
        if (!text(accessToken) || !request) return Effect.fail(inputError("oauth.fetchGuilds"))
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
    }
}

export function makeOAuthOwner(config: OAuthConfig, scope: Scope.Scope): Effect.Effect<OAuthOwner, ConfigurationError> {
    return Effect.try({
        try: () => {
            if (
                !record(config) ||
                Object.keys(config).some((key) => key !== "clientId" && key !== "clientSecret" && key !== "instance") ||
                !identifier(config.clientId) ||
                !text(config.clientSecret)
            )
                throw new ConfigurationError(
                    "configuration",
                    "OAuth configuration requires a decimal clientId and nonempty clientSecret",
                )
            const configuration = instanceConfiguration(config.instance)
            if (configuration instanceof ConfigurationError) throw configuration
            return new OAuthOwner(config.clientId, config.clientSecret, configuration, scope)
        },
        catch: (error) =>
            error instanceof ConfigurationError
                ? error
                : new ConfigurationError("configuration", "Invalid OAuth configuration"),
    })
}
