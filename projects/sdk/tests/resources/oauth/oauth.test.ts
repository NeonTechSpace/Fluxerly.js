import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { setImmediate as turn } from "node:timers/promises"
import { inspect } from "node:util"
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest"
import { Cause, Effect, Exit, Fiber, Scope } from "effect"
import {
    ConfigurationError,
    createClient,
    describeError,
    display,
    oauth as defaultApi,
    SdkDefect,
    type OAuthAuthorizationInput,
    type OAuthClient as DefaultOAuthClient,
    type OAuthCodeExchangeInput,
    type OAuthConfig,
} from "../../../src/index.js"
import { oauth as native, type OAuthClient as NativeOAuthClient } from "../../../src/effect.js"
import { modes, type Mode } from "../../support/both-apis.js"
import { expectErr, settle, type Operation } from "../../support/settle.js"
import { waitUntil } from "../../support/clock.js"
import { sdkClock } from "../../support/client-clock.js"

let close: (() => Promise<void>) | undefined

test.each(modes)("%s rejects noncanonical OAuth form/query values before discovery", async (mode) => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const scope = Scope.makeUnsafe()
    const defaultClient = defaultApi.create({ clientId: "1", clientSecret: "secret" })
    const client =
        mode === "default"
            ? defaultClient
            : await Effect.runPromise(
                  native.create({ clientId: "1", clientSecret: "secret" }).pipe(Scope.provide(scope)),
              )
    const run = async (operation: unknown) =>
        mode === "default"
            ? ((await operation) as { error: unknown }).error
            : await Effect.runPromise(Effect.flip(operation as Effect.Effect<unknown, unknown>))
    const auth = {
        redirectUri: "https://example.com/callback",
        scopes: ["identify"] as const,
        state: "state",
        codeChallenge: "a".repeat(43),
    }
    try {
        for (const value of [
            "",
            " ",
            "x".repeat(257),
            "😀".repeat(129),
            " state",
            "state ",
            "sta\u000cte",
            "sta\u202ete",
            "\ud800",
        ]) {
            for (const operation of [
                client.authorizationUrl({ ...auth, state: value }),
                client.exchangeCode({ code: value, redirectUri: auth.redirectUri, codeVerifier: "a".repeat(43) }),
                client.refresh(value),
                client.revoke({ token: value }),
                client.introspect(value),
            ])
                expect(await run(operation)).toMatchObject({ reason: "input", outcome: "notDispatched" })
        }
        for (const redirectUri of [
            "https://example.com/" + "x".repeat(257 - "https://example.com/".length),
            " https://example.com/callback",
            "https://example.com/\u202ecallback",
        ]) {
            expect(await run(client.authorizationUrl({ ...auth, redirectUri }))).toMatchObject({
                reason: "input",
                outcome: "notDispatched",
            })
            expect(
                await run(client.exchangeCode({ code: "code", redirectUri, codeVerifier: "a".repeat(43) })),
            ).toMatchObject({ reason: "input", outcome: "notDispatched" })
        }
        expect(fetch).not.toHaveBeenCalled()
    } finally {
        await defaultClient.shutdown()
        await Effect.runPromise(Scope.close(scope, Exit.void))
        vi.unstubAllGlobals()
    }
})

test.each(modes)("%s bounds OAuth scope entries before discovery", async (mode) => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const scope = Scope.makeUnsafe()
    const defaultClient = defaultApi.create({ clientId: "1", clientSecret: "secret" })
    const client =
        mode === "default"
            ? defaultClient
            : await Effect.runPromise(
                  native.create({ clientId: "1", clientSecret: "secret" }).pipe(Scope.provide(scope)),
              )
    const run = async (operation: unknown) =>
        mode === "default"
            ? ((await operation) as { error: unknown }).error
            : await Effect.runPromise(Effect.flip(operation as Effect.Effect<unknown, unknown>))
    const auth = {
        redirectUri: "https://example.com/callback",
        state: "state",
        codeChallenge: "a".repeat(43),
    }
    const sparse: "identify"[] = []
    sparse.length = 0xffffffff
    try {
        for (const scopes of [Array<"identify">(257).fill("identify"), sparse])
            expect(await run(client.authorizationUrl({ ...auth, scopes }))).toMatchObject({
                reason: "input",
                outcome: "notDispatched",
            })
        expect(fetch).not.toHaveBeenCalled()
    } finally {
        await defaultClient.shutdown()
        await Effect.runPromise(Scope.close(scope, Exit.void))
        vi.unstubAllGlobals()
    }
})

test("OAuth authorization preserves boundary state and deduplicates scopes through both APIs", async () => {
    const { base, requests } = await fixture()
    const config = { clientId: "1", clientSecret: "secret", instance: { url: base, allowInsecure: true } }
    const client = defaultApi.create(config)
    const scope = Scope.makeUnsafe()
    const nativeClient = await Effect.runPromise(native.create(config).pipe(Scope.provide(scope)))
    const redirectUri = "https://example.com/" + "x".repeat(256 - "https://example.com/".length)
    const scopes: OAuthAuthorizationInput["scopes"] = Array.from({ length: 256 }, (_, index) =>
        index === 1 ? "guilds" : "identify",
    )
    try {
        for (const state of ["x".repeat(256), "😀".repeat(128), "internal space"]) {
            const input = {
                redirectUri,
                state,
                scopes,
                codeChallenge: "a".repeat(43),
            }
            const result = await client.authorizationUrl(input)
            if (result.isErr()) throw result.error
            const urls = [result.value, await Effect.runPromise(nativeClient.authorizationUrl(input))]
            for (const url of urls) {
                const params = new URL(url).searchParams
                expect(params.get("state")).toBe(state)
                expect(params.get("redirect_uri")).toBe(redirectUri)
                expect(params.get("scope")).toBe("identify guilds")
            }
        }
        const input = { code: "x".repeat(256), redirectUri, codeVerifier: "a".repeat(43) }
        expect((await client.exchangeCode(input)).isOk()).toBe(true)
        await Effect.runPromise(nativeClient.exchangeCode(input))
        const exchanges = requests.filter((request) => request.path === "/oauth2/token")
        expect(exchanges).toHaveLength(2)
        for (const exchange of exchanges) expect(new URLSearchParams(exchange.body).get("code")).toBe(input.code)
    } finally {
        await client.shutdown()
        await Effect.runPromise(Scope.close(scope, Exit.void))
    }
})

async function fixture(
    mode:
        | "normal"
        | "rejected"
        | "fluxerRejected"
        | "serverError"
        | "malformed"
        | "invalidJson"
        | "large"
        | "stall"
        | "stallBody"
        | "discoveryStall"
        | "discoveryRateLimit"
        | "operationRateLimit"
        | "revokeRejected"
        | "revokeBody"
        | "connectionsMalformed"
        | "connectionsForbidden"
        | "connectionsStall"
        | "connectionsEmptyStrings"
        | "connectionsOutOfRange"
        | "introspectionMalformed"
        | "introspectionNoSubject"
        | "introspectionInactive"
        | "introspectionRefresh"
        | "introspectionLarge" = "normal",
    webappPath = "",
) {
    const requests: Array<{ path: string; authorization?: string; body: string }> = []
    let base = ""
    const server = createServer(async (request, response) => {
        const body = await new Promise<string>((resolve) => {
            let text = ""
            request.on("data", (part) => (text += part))
            request.on("end", () => resolve(text))
        })
        requests.push({
            path: request.url ?? "",
            ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
            body,
        })
        if (request.headers.authorization?.startsWith("Basic ") && new URLSearchParams(body).has("client_id")) {
            response.statusCode = 400
            return response.end(JSON.stringify({ error: "invalid_request" }))
        }
        if (request.url === "/.well-known/fluxer" && mode === "discoveryStall") return
        if (request.url === "/.well-known/fluxer" && mode === "discoveryRateLimit") {
            response.writeHead(429, { "retry-after": "2" })
            return response.end("{}")
        }
        if (request.url === "/.well-known/fluxer")
            return response.end(
                JSON.stringify({
                    api_code_version: 1,
                    endpoints: {
                        api_public: base,
                        gateway: base.replace("http", "ws"),
                        media: base,
                        static_cdn: base,
                        webapp: `${base}${webappPath}`,
                        invite: base,
                    },
                    features: { presigned_attachment_uploads: false },
                }),
            )
        if (
            mode === "operationRateLimit" &&
            (request.url === "/oauth2/token" || request.url === "/oauth2/token/revoke")
        ) {
            response.writeHead(429, { "retry-after": "2" })
            return response.end("{}")
        }
        if (request.url === "/oauth2/token" && mode === "stall") return
        if (request.url === "/oauth2/token" && mode === "rejected") {
            response.statusCode = 400
            return response.end(JSON.stringify({ error: "invalid_grant", error_description: "secret must not escape" }))
        }
        if (request.url === "/oauth2/token" && mode === "fluxerRejected") {
            response.statusCode = 403
            return response.end(JSON.stringify({ code: "MISSING_PERMISSIONS", message: "secret must not escape" }))
        }
        if (request.url === "/oauth2/token" && mode === "serverError") {
            response.statusCode = 503
            return response.end(JSON.stringify({ error: "temporarily_unavailable" }))
        }
        if (request.url === "/oauth2/token" && mode === "malformed")
            return response.end(JSON.stringify({ access_token: 1 }))
        if (request.url === "/oauth2/token" && mode === "invalidJson") return response.end("not json")
        if (request.url === "/oauth2/token" && mode === "large") return response.end("x".repeat(1_048_577))
        if (request.url === "/oauth2/token" && mode === "stallBody") {
            response.writeHead(200, { "content-type": "application/json" })
            response.write('{"access_token":"access"')
            return
        }
        if (request.url === "/oauth2/token")
            return response.end(
                JSON.stringify({
                    access_token: "access",
                    refresh_token: "refresh-next",
                    token_type: "Bearer",
                    expires_in: 60,
                    scope: "identify guilds future",
                }),
            )
        if (request.url === "/oauth2/token/revoke" && mode === "revokeRejected") {
            response.statusCode = 400
            return response.end(JSON.stringify({ error: "invalid_grant" }))
        }
        if (request.url === "/oauth2/token/revoke" && mode === "revokeBody") return response.end("not json")
        if (request.url === "/oauth2/token/revoke") return response.end()
        if (request.url === "/oauth2/introspect" && mode === "introspectionMalformed")
            return response.end(JSON.stringify({ active: true, client_id: "1" }))
        if (request.url === "/oauth2/introspect" && mode === "introspectionInactive")
            return response.end(JSON.stringify({ active: false }))
        if (request.url === "/oauth2/introspect" && mode === "introspectionLarge")
            return response.end("x".repeat(1_048_577))
        if (request.url === "/oauth2/introspect")
            return response.end(
                JSON.stringify({
                    active: true,
                    client_id: "1",
                    ...(mode === "introspectionNoSubject" ? {} : { sub: "2" }),
                    scope: mode === "introspectionNoSubject" ? "" : "identify connections bot",
                    token_type: mode === "introspectionRefresh" ? "refresh_token" : "Bearer",
                    ...(mode === "introspectionRefresh" ? {} : { exp: 1_800_000_000 }),
                    iat: 1_700_000_000,
                }),
            )
        if (request.url === "/oauth2/userinfo")
            return response.end(
                JSON.stringify({
                    sub: "1",
                    id: "1",
                    username: "name",
                    discriminator: "0",
                    global_name: "Display",
                    avatar: null,
                }),
            )
        if (request.url?.startsWith("/users/@me/guilds"))
            return response.end(
                JSON.stringify([
                    {
                        id: "2",
                        name: "Guild",
                        owner_id: "1",
                        features: [],
                        icon: null,
                        banner: null,
                        splash: null,
                        embed_splash: null,
                        content_warning_text: null,
                    },
                ]),
            )
        if (request.url === "/users/@me/connections" && mode === "connectionsStall") return
        if (request.url === "/users/@me/connections" && mode === "connectionsForbidden") {
            response.statusCode = 403
            return response.end(JSON.stringify({ message: "private connections must not escape" }))
        }
        if (request.url === "/users/@me/connections" && mode === "connectionsMalformed")
            return response.end(JSON.stringify([{ id: "connection" }]))
        if (request.url === "/users/@me/connections")
            return response.end(
                JSON.stringify([
                    {
                        id: mode === "connectionsEmptyStrings" ? "" : "connection",
                        type: "domain",
                        name: mode === "connectionsEmptyStrings" ? "" : "example.test",
                        verified: true,
                        visibility_flags: mode === "connectionsOutOfRange" ? 2_147_483_648 : 1,
                        sort_order: 0,
                    },
                ]),
            )
        response.statusCode = 404
        response.end(JSON.stringify({ error: "invalid_grant" }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    let closing: Promise<void> | undefined
    close = () =>
        (closing ??= new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))))
    return { base, requests }
}

afterEach(async () => {
    await close?.()
    close = undefined
    vi.restoreAllMocks()
})

/** Query parameters as sorted entries, so a comparison keeps duplicates but ignores their order */
function sortedParameters(parameters: ConstructorParameters<typeof URLSearchParams>[0]) {
    return [...new URLSearchParams(parameters)].sort(([left], [right]) => left.localeCompare(right))
}

/** An authorization URL split into its endpoint and sorted query parameters */
function authorizationParts(url: string) {
    const parsed = new URL(url)
    return { endpoint: `${parsed.origin}${parsed.pathname}`, parameters: sortedParameters(parsed.searchParams) }
}

/** A default or native OAuth client. Pair its operations with settle() or expectErr() to run either style */
type AnyOAuthClient = DefaultOAuthClient | NativeOAuthClient

/** Create an OAuth client for one API style against a fixture base URL, closed when the current test finishes */
async function oauthClient(mode: Mode, base: string): Promise<AnyOAuthClient> {
    const config = { clientId: "1", clientSecret: "secret", instance: { url: base, allowInsecure: true } }
    if (mode === "default") {
        const client = defaultApi.create(config)
        onTestFinished(async () => {
            await client.shutdown()
        })
        return client
    }
    const scope = Scope.makeUnsafe()
    const client = await Effect.runPromise(native.create(config).pipe(Scope.provide(scope)))
    onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
    return client
}

describe("oauth", () => {
    test.each([
        ["root", "", ""],
        ["path-prefixed", "/community", "/community"],
        ["path-prefixed-with-trailing-slash", "/community/", "/community"],
    ])(
        "uses the normalized discovered %s web application base for default and native authorization URLs",
        async (_, webappPath, expectedWebappPath) => {
            const { base } = await fixture("normal", webappPath)
            const input = {
                redirectUri: "http://localhost/callback?return=one%20two",
                scopes: ["identify", "guilds"] as const,
                state: "state value",
                codeChallenge: "a".repeat(43),
            }
            const expected = {
                endpoint: `${base}${expectedWebappPath}/oauth2/authorize`,
                parameters: sortedParameters({
                    client_id: "1",
                    response_type: "code",
                    redirect_uri: input.redirectUri,
                    scope: input.scopes.join(" "),
                    state: input.state,
                    code_challenge: input.codeChallenge,
                    code_challenge_method: "S256",
                }),
            }

            const installationClient = createClient({
                token: "fixture-token",
                instance: { url: base, allowInsecure: true },
            })
            try {
                const resolved = await installationClient.instance.resolve()
                expect(resolved._unsafeUnwrap().links.installation("1")).toBe(
                    `${base}${expectedWebappPath}/oauth2/authorize?client_id=1&scope=bot`,
                )
            } finally {
                await installationClient.shutdown()
            }

            const defaultClient = defaultApi.create({
                clientId: "1",
                clientSecret: "secret",
                instance: { url: base, allowInsecure: true },
            })
            let defaultUrl = ""
            try {
                defaultUrl = (await defaultClient.authorizationUrl(input))._unsafeUnwrap()
                expect(authorizationParts(defaultUrl)).toEqual(expected)
            } finally {
                await defaultClient.shutdown()
            }

            const nativeUrl = await Effect.runPromise(
                Effect.scoped(
                    Effect.gen(function* () {
                        const client = yield* native.create({
                            clientId: "1",
                            clientSecret: "secret",
                            instance: { url: base, allowInsecure: true },
                        })
                        return yield* client.authorizationUrl(input)
                    }),
                ),
            )
            expect(nativeUrl).toBe(defaultUrl)
        },
    )

    test("builds combined code-grant authorization URLs with bounded bot installation hints", async () => {
        const { base } = await fixture()
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        try {
            const result = await made.authorizationUrl({
                redirectUri: "http://localhost/callback",
                scopes: ["identify", "bot"],
                state: "state",
                codeChallenge: "a".repeat(43),
                guildId: "2",
                permissions: (1n << 64n) - 1n,
                disableGuildSelect: true,
            })
            const url = new URL(result._unsafeUnwrap())
            expect(url.searchParams.get("scope")).toBe("identify bot")
            expect(url.searchParams.get("response_type")).toBe("code")
            expect(url.searchParams.get("guild_id")).toBe("2")
            expect(url.searchParams.get("permissions")).toBe("18446744073709551615")
            expect(url.searchParams.get("disable_guild_select")).toBe("true")
        } finally {
            await made.shutdown()
        }
    })

    test("keeps bot-only code-grant group-DM targets consistent across default and native clients", async () => {
        const { base } = await fixture()
        const input = {
            redirectUri: "http://localhost/callback",
            scopes: ["bot"] as const,
            state: "state",
            codeChallenge: "a".repeat(43),
            channelId: "2",
            permissions: 0n,
        }
        const defaultClient = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        try {
            const defaultUrl = (await defaultClient.authorizationUrl(input))._unsafeUnwrap()
            const nativeUrl = await Effect.runPromise(
                Effect.scoped(
                    Effect.gen(function* () {
                        const client = yield* native.create({
                            clientId: "1",
                            clientSecret: "secret",
                            instance: { url: base, allowInsecure: true },
                        })
                        return yield* client.authorizationUrl(input)
                    }),
                ),
            )
            expect(nativeUrl).toBe(defaultUrl)
            const url = new URL(defaultUrl)
            expect(url.searchParams.get("scope")).toBe("bot")
            expect(url.searchParams.get("response_type")).toBe("code")
            expect(url.searchParams.get("channel_id")).toBe("2")
            expect(url.searchParams.get("guild_id")).toBeNull()
        } finally {
            await defaultClient.shutdown()
        }
    })

    test("uses the initially validated OAuth inputs through both clients", async () => {
        const { base, requests } = await fixture()
        const config = {
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        }
        const authorizationInput = (): OAuthAuthorizationInput => {
            let reads = 0
            const scopes: OAuthAuthorizationInput["scopes"] = ["identify"]
            Object.defineProperty(scopes, "0", {
                enumerable: true,
                get: () => (reads++ === 0 ? "identify" : "bot"),
            })
            return {
                redirectUri: "http://localhost/callback",
                scopes,
                state: "state",
                codeChallenge: "a".repeat(43),
            }
        }
        const exchangeInput = (): OAuthCodeExchangeInput => {
            let reads = 0
            return {
                get code() {
                    return reads++ === 0 ? "validated-code" : "transmitted-code"
                },
                redirectUri: "http://localhost/callback",
                codeVerifier: "a".repeat(43),
            }
        }
        const revokeInput = () => {
            let reads = 0
            return {
                get token() {
                    return reads++ === 0 ? "validated-token" : "revoked-token"
                },
            }
        }
        const invalidFirstInput = (): OAuthAuthorizationInput => {
            let reads = 0
            const scopes: OAuthAuthorizationInput["scopes"] = ["identify"]
            Object.defineProperty(scopes, "0", {
                enumerable: true,
                get: () => (reads++ === 0 ? "unrecognized" : "identify"),
            })
            return {
                redirectUri: "http://localhost/callback",
                scopes,
                state: "state",
                codeChallenge: "a".repeat(43),
            }
        }
        const defaultClient = defaultApi.create(config)
        try {
            const authorization = await defaultClient.authorizationUrl(authorizationInput())
            expect(new URL(authorization._unsafeUnwrap()).searchParams.get("scope")).toBe("identify")

            expect((await defaultClient.exchangeCode(exchangeInput())).isOk()).toBe(true)
            expect(new URLSearchParams(requests.at(-1)?.body).get("code")).toBe("validated-code")

            expect((await defaultClient.revoke(revokeInput())).isOk()).toBe(true)
            expect(new URLSearchParams(requests.at(-1)?.body).get("token")).toBe("validated-token")

            const requestCount = requests.length
            expect(await defaultClient.authorizationUrl(invalidFirstInput())).toMatchObject({
                error: { reason: "input", outcome: "notDispatched", inputValidation: { path: "scopes[]" } },
            })
            expect(requests).toHaveLength(requestCount)
        } finally {
            await defaultClient.shutdown()
        }

        const nativeValues = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const client = yield* native.create(config)
                    const authorization = yield* client.authorizationUrl(authorizationInput())
                    const exchange = yield* client.exchangeCode(exchangeInput())
                    const revoke = yield* client.revoke(revokeInput())
                    return { authorization, exchange, revoke }
                }),
            ),
        )
        expect(new URL(nativeValues.authorization).searchParams.get("scope")).toBe("identify")
        expect(nativeValues.exchange.accessToken).toBe("access")
        expect(new URLSearchParams(requests.at(-2)?.body).get("code")).toBe("validated-code")
        expect(new URLSearchParams(requests.at(-1)?.body).get("token")).toBe("validated-token")

        const requestCount = requests.length
        const nativeInvalid = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const client = yield* native.create(config)
                    return yield* Effect.flip(client.authorizationUrl(invalidFirstInput()))
                }),
            ),
        )
        expect(nativeInvalid).toMatchObject({
            reason: "input",
            outcome: "notDispatched",
            inputValidation: { path: "scopes[]" },
        })
        expect(requests).toHaveLength(requestCount)
    })

    test.each([
        [{ permissions: 1n << 64n }, "permissions", "range"],
        [{ guildId: "1", channelId: "2" }, "channelId", "relationship"],
        [{ scopes: ["identify"] as const, guildId: "1" }, "botInstallation", "required"],
    ] as const)(
        "rejects invalid installation input before discovery through both clients",
        async (override, path, constraint) => {
            const { base, requests } = await fixture()
            const input = {
                redirectUri: "http://localhost/callback",
                scopes: ["bot"] as const,
                state: "state",
                codeChallenge: "a".repeat(43),
                ...override,
            }
            const defaultClient = defaultApi.create({
                clientId: "1",
                clientSecret: "secret",
                instance: { url: base, allowInsecure: true },
            })
            try {
                expect(await defaultClient.authorizationUrl(input)).toMatchObject({
                    error: { reason: "input", outcome: "notDispatched", inputValidation: { path, constraint } },
                })
                await expect(
                    Effect.runPromise(
                        Effect.scoped(
                            Effect.gen(function* () {
                                const client = yield* native.create({
                                    clientId: "1",
                                    clientSecret: "secret",
                                    instance: { url: base, allowInsecure: true },
                                })
                                return yield* client.authorizationUrl(input)
                            }),
                        ),
                    ),
                ).rejects.toMatchObject({
                    reason: "input",
                    outcome: "notDispatched",
                    inputValidation: { path, constraint },
                })
                expect(requests).toHaveLength(0)
            } finally {
                await defaultClient.shutdown()
            }
        },
    )

    test("preserves empty provider connection identifiers and names allowed by the response schema", async () => {
        const { base } = await fixture("connectionsEmptyStrings")
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        try {
            expect((await made.fetchConnections("access"))._unsafeUnwrap()[0]).toMatchObject({ id: "", name: "" })
        } finally {
            await made.shutdown()
        }
    })

    test("rejects connection fields beyond Fluxer's nonnegative Int32 response domain", async () => {
        const { base } = await fixture("connectionsOutOfRange")
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        try {
            expect(await made.fetchConnections("access")).toMatchObject({
                error: { reason: "response", outcome: "rejected", status: 200 },
            })
        } finally {
            await made.shutdown()
        }
    })

    test.each(modes)(
        "%s uses selected discovery, form and Basic authentication without bot credentials",
        async (mode) => {
            const { base, requests } = await fixture()
            const client = await oauthClient(mode, base)
            const url = await settle(
                client.authorizationUrl({
                    redirectUri: "http://localhost/callback",
                    scopes: ["identify", "guilds"],
                    state: "state",
                    codeChallenge: defaultApi.createPkce().challenge,
                }),
            )
            expect(new URL(url).searchParams.get("code_challenge_method")).toBe("S256")
            const tokens = await settle(
                client.exchangeCode({
                    code: "code",
                    redirectUri: "http://localhost/callback",
                    codeVerifier: "a".repeat(43),
                }),
            )
            expect(tokens.scopes).toEqual(["identify", "guilds", "future"])
            const identity = await settle(client.fetchIdentity("access"))
            expect(identity.id).toBe("1")
            // The account-wide name uses the same field as User, so the display helper reads it
            expect(display.name(identity)).toBe("Display")
            expect((await settle(client.fetchGuilds("access")))[0]?.id).toBe("2")
            expect((await settle(client.fetchConnections("access")))[0]).toMatchObject({
                id: "connection",
                type: "domain",
                visibilityFlags: 1,
            })
            expect(await settle(client.introspect("access"))).toMatchObject({
                active: true,
                clientId: "1",
                subjectId: "2",
                tokenType: "Bearer",
                scopes: ["identify", "connections", "bot"],
            })
            await settle(client.revoke({ token: "access" }))
            const basic = `Basic ${Buffer.from("1:secret").toString("base64")}`
            expect(requests.find((entry) => entry.path === "/oauth2/token")?.authorization).toBe(basic)
            expect(requests.find((entry) => entry.path === "/oauth2/introspect")).toMatchObject({
                authorization: basic,
                body: "token=access",
            })
            expect(
                requests
                    .filter(
                        (entry) =>
                            entry.path === "/oauth2/userinfo" ||
                            entry.path.startsWith("/users/@me/guilds") ||
                            entry.path === "/users/@me/connections",
                    )
                    .map((entry) => entry.authorization),
            ).toEqual(["Bearer access", "Bearer access", "Bearer access"])
        },
    )

    test.each([
        ["connectionsMalformed", "fetchConnections", "access"],
        ["introspectionMalformed", "introspect", "access"],
        ["introspectionLarge", "introspect", "access"],
    ] as const)("rejects malformed or oversized %s read bodies without exposing them", async (mode, method, value) => {
        const { base } = await fixture(mode)
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        try {
            const result = await made[method](value)
            expect(result).toMatchObject({ error: { reason: "response", outcome: "rejected", status: 200 } })
        } finally {
            await made.shutdown()
        }
    })

    test.each([
        ["introspectionInactive", false],
        ["introspectionNoSubject", true],
    ] as const)("projects %s introspection without inferring token lifecycle state", async (mode, subjectAbsent) => {
        const { base } = await fixture(mode)
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        try {
            const result = (await made.introspect("access"))._unsafeUnwrap()
            if (!result.active) expect(Object.keys(result)).toEqual(["active"])
            else {
                expect(result).toMatchObject({
                    active: true,
                    clientId: "1",
                    scopes: subjectAbsent ? [] : ["identify", "connections", "bot"],
                })
                if (subjectAbsent) expect(result.scopes).toEqual([])
                expect(Object.hasOwn(result, "subjectId")).toBe(!subjectAbsent)
            }
        } finally {
            await made.shutdown()
        }
    })

    test("projects active refresh introspection without inventing an access expiry", async () => {
        const { base } = await fixture("introspectionRefresh")
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        try {
            const result = (await made.introspect("refresh"))._unsafeUnwrap()
            expect(result).toMatchObject({
                active: true,
                tokenType: "refresh_token",
                issuedAtUnixSeconds: 1_700_000_000,
            })
            expect(Object.hasOwn(result, "expiresAtUnixSeconds")).toBe(false)
        } finally {
            await made.shutdown()
        }
    })

    test("keeps a delegated connection permission failure private and leaves the client usable", async () => {
        const { base } = await fixture("connectionsForbidden")
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        try {
            const denied = await made.fetchConnections("access")
            expect(denied).toMatchObject({ error: { reason: "rejected", outcome: "rejected", status: 403 } })
            expect(JSON.stringify(denied)).not.toContain("private connections")
            expect((await made.fetchIdentity("access"))._unsafeUnwrap().id).toBe("1")
        } finally {
            await made.shutdown()
        }
    })

    test.each([
        ["fetchConnections", "connectionsStall", "/users/@me/connections"],
        ["exchangeCode", "stall", "/oauth2/token"],
    ] as const)("default signal cancels a dispatched OAuth %s request", async (operation, mode, path) => {
        const { base, requests } = await fixture(mode)
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        const controller = new AbortController()
        try {
            const pending =
                operation === "fetchConnections"
                    ? made.fetchConnections("access", { signal: controller.signal })
                    : made.exchangeCode(
                          { code: "code", redirectUri: "http://localhost/callback", codeVerifier: "a".repeat(43) },
                          { signal: controller.signal },
                      )
            await waitUntil(() => requests.some((request) => request.path === path), {
                message: "The OAuth request did not reach the stalled fixture",
            })
            controller.abort()
            expect(await pending).toMatchObject({ error: { _tag: "CancelledError" } })
            expect(requests.filter((request) => request.path === path)).toHaveLength(1)
        } finally {
            await made.shutdown()
        }
    })

    test.each([
        ["redirectUri", { redirectUri: "https://user:password@example.test/callback" }],
        ["state", { state: "" }],
        ["codeChallenge", { codeChallenge: "" }],
        ["scopes", { scopes: [] }],
    ] as const)("rejects an invalid %s before discovery", async (path, override) => {
        const fetch = vi.fn()
        vi.stubGlobal("fetch", fetch)
        const made = defaultApi.create({ clientId: "1", clientSecret: "secret" })
        try {
            const result = await made.authorizationUrl({
                redirectUri: "https://example.test/callback",
                scopes: ["identify"],
                state: "state",
                codeChallenge: defaultApi.createPkce().challenge,
                ...override,
            })
            expect(result).toMatchObject({
                error: {
                    _tag: "OAuthOperationError",
                    reason: "input",
                    outcome: "notDispatched",
                    inputValidation: { path },
                },
            })
            expect(fetch).not.toHaveBeenCalled()
        } finally {
            await made.shutdown()
            vi.unstubAllGlobals()
        }
    })

    test("creates a fresh S256 PKCE pair", () => {
        const first = defaultApi.createPkce()
        const second = defaultApi.createPkce()
        for (const pkce of [first, second]) {
            expect(pkce.verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/)
            expect(pkce.challenge).toBe(createHash("sha256").update(pkce.verifier).digest("base64url"))
        }
        expect(second.verifier).not.toBe(first.verifier)
    })

    test.each([
        ["rejected", { reason: "rejected", outcome: "rejected", status: 400, oauthError: "invalid_grant" }],
        ["serverError", { reason: "rejected", outcome: "unknown", status: 503, oauthError: null }],
        ["malformed", { reason: "response", outcome: "unknown", status: 200 }],
        ["large", { reason: "response", outcome: "unknown", status: 200 }],
    ] as const)("maps %s token responses without private bodies or retries", async (mode, expected) => {
        const { base, requests } = await fixture(mode)
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        try {
            const result = await made.exchangeCode({
                code: "code",
                redirectUri: "http://localhost/callback",
                codeVerifier: "a".repeat(43),
            })
            expect(result).toMatchObject({ error: { _tag: "OAuthOperationError", ...expected } })
            // Only the rejected fixture body carries provider prose
            expect(JSON.stringify(result._unsafeUnwrapErr())).not.toContain("must not escape")
            expect(requests.filter((request) => request.path === "/oauth2/token")).toHaveLength(1)
        } finally {
            await made.shutdown()
        }
    })

    test("maps a normal Fluxer error envelope without replacing RFC OAuth errors", async () => {
        const { base } = await fixture("fluxerRejected")
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        try {
            const result = await made.exchangeCode({
                code: "code",
                redirectUri: "http://localhost/callback",
                codeVerifier: "a".repeat(43),
            })
            expect(result).toMatchObject({
                error: {
                    reason: "rejected",
                    status: 403,
                    apiError: { code: "missingPermissions", providerCode: "MISSING_PERMISSIONS" },
                    oauthError: null,
                },
            })
        } finally {
            await made.shutdown()
        }
    })

    test("maps invalid JSON from a dispatched 2xx mutation to an unknown response outcome", async () => {
        const { base } = await fixture("invalidJson")
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        const result = await made.exchangeCode({
            code: "code",
            redirectUri: "http://localhost/callback",
            codeVerifier: "a".repeat(43),
        })
        expect(result).toMatchObject({ error: { reason: "response", outcome: "unknown", status: 200 } })
        await made.shutdown()
    })

    test("cancels a token response that arrives after the deadline", async () => {
        const clock = sdkClock()
        const { base } = await fixture()
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        await made.authorizationUrl({
            redirectUri: "http://localhost/callback",
            scopes: ["identify"],
            state: "state",
            codeChallenge: defaultApi.createPkce().challenge,
        })
        const originalFetch = globalThis.fetch
        let cancelled = false
        let entered!: () => void
        const dispatched = new Promise<void>((resolve) => (entered = resolve))
        globalThis.fetch = async (input, init) => {
            if (!String(input).endsWith("/oauth2/token")) return originalFetch(input, init)
            // The response arrives only after the deadline aborts the request, so its body must be cancelled
            await new Promise((resolve) => {
                init!.signal!.addEventListener("abort", resolve, { once: true })
                entered()
            })
            return new Response(new ReadableStream({ cancel: () => void (cancelled = true) }), { status: 200 })
        }
        try {
            const pending = made.exchangeCode(
                { code: "code", redirectUri: "http://localhost/callback", codeVerifier: "a".repeat(43) },
                { timeoutMs: 100 },
            )
            await dispatched
            await clock.waiting(100)
            await clock.advance(100)
            expect(await pending).toMatchObject({ error: { reason: "timeout", outcome: "unknown" } })
            expect(cancelled).toBe(true)
        } finally {
            globalThis.fetch = originalFetch
            await made.shutdown()
        }
    })

    test("keeps a received 403 rejected when its metadata body stalls past the deadline", async () => {
        const clock = sdkClock()
        const { base } = await fixture()
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        await made.authorizationUrl({
            redirectUri: "http://localhost/callback",
            scopes: ["identify"],
            state: "state",
            codeChallenge: defaultApi.createPkce().challenge,
        })
        const originalFetch = globalThis.fetch
        let entered!: () => void
        const reading = new Promise<void>((resolve) => (entered = resolve))
        globalThis.fetch = async (input, init) =>
            String(input).endsWith("/oauth2/token")
                ? new Response(new ReadableStream({ pull: () => entered() }, { highWaterMark: 0 }), { status: 403 })
                : originalFetch(input, init)
        try {
            const pending = made.exchangeCode(
                { code: "code", redirectUri: "http://localhost/callback", codeVerifier: "a".repeat(43) },
                { timeoutMs: 5 },
            )
            await reading
            await clock.waiting(5)
            await clock.advance(5)
            expect(await pending).toMatchObject({ error: { reason: "rejected", outcome: "rejected", status: 403 } })
        } finally {
            globalThis.fetch = originalFetch
            await made.shutdown()
        }
    })

    test("rejects the ninth concurrent OAuth request before dispatch", async () => {
        const { base } = await fixture()
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        await made.authorizationUrl({
            redirectUri: "http://localhost/callback",
            scopes: ["identify"],
            state: "state",
            codeChallenge: defaultApi.createPkce().challenge,
        })
        const originalFetch = globalThis.fetch
        let entered = 0
        let ready!: () => void
        const allEntered = new Promise<void>((resolve) => (ready = resolve))
        globalThis.fetch = async (input, init) => {
            if (!String(input).endsWith("/oauth2/token")) return originalFetch(input, init)
            if (++entered === 8) ready()
            return new Response(new ReadableStream(), { status: 200 })
        }
        try {
            const input = { code: "code", redirectUri: "http://localhost/callback", codeVerifier: "a".repeat(43) }
            const active = Array.from({ length: 8 }, () => made.exchangeCode(input))
            await allEntered
            expect(await made.exchangeCode(input)).toMatchObject({
                error: { reason: "busy", outcome: "notDispatched" },
            })
            await made.shutdown()
            await Promise.all(active)
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    test("reads successful revoke bodies and retains allowlisted OAuth errors from failed revokes", async () => {
        const successful = await fixture("revokeBody")
        const first = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: successful.base, allowInsecure: true },
        })
        expect((await first.revoke({ token: "access" })).isOk()).toBe(true)
        await first.shutdown()
        await close?.()
        close = undefined

        const rejected = await fixture("revokeRejected")
        const second = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: rejected.base, allowInsecure: true },
        })
        expect(await second.revoke({ token: "access" })).toMatchObject({
            error: { reason: "rejected", oauthError: "invalid_grant" },
        })
        await second.shutdown()
    })

    test("marks a dispatched code exchange timeout unknown without retrying", async () => {
        const clock = sdkClock()
        const { base, requests } = await fixture("stall")
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        const pending = made.exchangeCode(
            { code: "code", redirectUri: "http://localhost/callback", codeVerifier: "a".repeat(43) },
            { timeoutMs: 20 },
        )
        await waitUntil(() => requests.some((request) => request.path === "/oauth2/token"))
        await clock.waiting(20)
        await clock.advance(20)
        const result = await pending
        expect(result.isErr()).toBe(true)
        if (result.isErr())
            expect(result.error).toMatchObject({ _tag: "OAuthOperationError", reason: "timeout", outcome: "unknown" })
        expect(requests.filter((request) => request.path === "/oauth2/token")).toHaveLength(1)
        await made.shutdown()
    })

    test.each(["clientId", "clientSecret", "instance", "instance.url"] as const)(
        "preserves unexpected OAuth %s getter failures through both creation APIs",
        (field) => {
            const privateSecret = "fixture-only-private OAuth construction secret"
            const defect = new Error(`fixture-only-private OAuth ${field} construction defect`)
            const configuration = (): OAuthConfig => {
                switch (field) {
                    case "clientId":
                        return {
                            get clientId(): never {
                                throw defect
                            },
                            clientSecret: privateSecret,
                        }
                    case "clientSecret":
                        return {
                            clientId: "1",
                            get clientSecret(): never {
                                throw defect
                            },
                        }
                    case "instance":
                        return {
                            clientId: "1",
                            clientSecret: privateSecret,
                            get instance(): never {
                                throw defect
                            },
                        }
                    case "instance.url":
                        return {
                            clientId: "1",
                            clientSecret: privateSecret,
                            instance: {
                                get url(): never {
                                    throw defect
                                },
                            },
                        }
                }
            }
            const fetch = vi.fn(() => {
                throw new Error("OAuth construction must not request")
            })
            vi.stubGlobal("fetch", fetch)
            try {
                let defaultFailure: unknown
                try {
                    defaultApi.create(configuration())
                } catch (error) {
                    defaultFailure = error
                }
                expect(defaultFailure).toBeInstanceOf(SdkDefect)
                expect((defaultFailure as SdkDefect).operation).toBe("oauth.create")
                expect((defaultFailure as SdkDefect).reasons).toEqual([expect.objectContaining({ kind: "Defect" })])
                expect(inspect(defaultFailure)).not.toContain(privateSecret)
                expect(inspect(defaultFailure)).toContain(defect.message)
                expect(JSON.stringify(defaultFailure)).not.toContain(privateSecret)
                expect(JSON.stringify(defaultFailure)).toContain(defect.message)

                const nativeFailure = Effect.runSyncExit(Effect.scoped(native.create(configuration())))
                expect(Exit.isFailure(nativeFailure)).toBe(true)
                if (Exit.isFailure(nativeFailure)) {
                    expect(Cause.hasFails(nativeFailure.cause)).toBe(false)
                    expect(Cause.hasDies(nativeFailure.cause)).toBe(true)
                    expect(nativeFailure.cause.reasons).toEqual([expect.objectContaining({ _tag: "Die", defect })])
                }
                expect(fetch).not.toHaveBeenCalled()
            } finally {
                vi.unstubAllGlobals()
            }
        },
    )

    test.each([
        ["missing client secret", { clientId: "1" }],
        ["empty client secret", { clientId: "1", clientSecret: "" }],
        [
            "insecure instance without opt-in",
            { clientId: "1", clientSecret: "secret", instance: { url: "http://example.test" } },
        ],
    ] as const)("reports ordinary OAuth %s misuse as ConfigurationError", (_, configuration) => {
        expect(() => defaultApi.create(configuration as OAuthConfig)).toThrow(ConfigurationError)

        const nativeFailure = Effect.runSyncExit(Effect.scoped(native.create(configuration as OAuthConfig)))
        expect(Exit.isFailure(nativeFailure)).toBe(true)
        if (Exit.isFailure(nativeFailure)) {
            expect(Cause.hasFails(nativeFailure.cause)).toBe(false)
            expect(nativeFailure.cause.reasons).toEqual([
                expect.objectContaining({ _tag: "Die", defect: expect.any(ConfigurationError) }),
            ])
        }
    })

    test("returns typed input failures for malformed operation options and sparse authorization scopes", async () => {
        const fetch = vi.fn()
        vi.stubGlobal("fetch", fetch)
        const made = defaultApi.create({ clientId: "1", clientSecret: "secret" })
        const scope = Scope.makeUnsafe()
        const nativeClient = await Effect.runPromise(
            native.create({ clientId: "1", clientSecret: "secret" }).pipe(Scope.provide(scope)),
        )
        try {
            const input = {
                redirectUri: "http://localhost/callback",
                scopes: ["identify"] as const,
                state: "state",
                codeChallenge: defaultApi.createPkce().challenge,
            }
            const options: readonly unknown[] = [
                null,
                3,
                [],
                Object.assign([], { signal: new AbortController().signal }),
            ]
            for (const option of options) {
                // @ts-expect-error Exercise untyped JavaScript input at the public boundary
                expect(await made.authorizationUrl(input, option)).toMatchObject({
                    error: { _tag: "OAuthOperationError", reason: "input", outcome: "notDispatched" },
                })
                const nativeOperation =
                    // @ts-expect-error Exercise untyped JavaScript input at the public boundary
                    nativeClient.authorizationUrl(input, option)
                expect(await Effect.runPromise(Effect.flip(nativeOperation))).toMatchObject({
                    _tag: "OAuthOperationError",
                    reason: "input",
                    outcome: "notDispatched",
                })
            }
            expect(await made.authorizationUrl({ ...input, scopes: Array(1) })).toMatchObject({
                error: { reason: "input", outcome: "notDispatched" },
            })
            expect(fetch).not.toHaveBeenCalled()
        } finally {
            await made.shutdown()
            await Effect.runPromise(Scope.close(scope, Exit.void))
            vi.unstubAllGlobals()
        }
    })

    test.each([false, true])(
        "shutdown waits for active response cleanup (defect: %s) and closes future OAuth work",
        async (cleanupDefects) => {
            const { base } = await fixture()
            const made = defaultApi.create({
                clientId: "1",
                clientSecret: "secret",
                instance: { url: base, allowInsecure: true },
            })
            await made.authorizationUrl({
                redirectUri: "http://localhost/callback",
                scopes: ["identify"],
                state: "state",
                codeChallenge: defaultApi.createPkce().challenge,
            })
            let entered!: () => void
            const enteredRequest = new Promise<void>((resolve) => (entered = resolve))
            let releaseCancel!: () => void
            const cancelled = new Promise<void>((resolve) => (releaseCancel = resolve))
            let cancelling!: () => void
            const cancelStarted = new Promise<void>((resolve) => (cancelling = resolve))
            const cleanup = new Error("OAuth shutdown cleanup marker")
            const originalFetch = globalThis.fetch
            globalThis.fetch = async (input, init) => {
                if (!String(input).endsWith("/oauth2/token")) return originalFetch(input, init)
                entered()
                return new Response(
                    new ReadableStream({
                        cancel: async () => {
                            cancelling()
                            await cancelled
                            if (cleanupDefects) throw cleanup
                        },
                    }),
                    { status: 200 },
                )
            }
            try {
                const operation = Promise.resolve(
                    made.exchangeCode({
                        code: "code",
                        redirectUri: "http://localhost/callback",
                        codeVerifier: "a".repeat(43),
                    }),
                ).catch((error) => error)
                await enteredRequest
                globalThis.fetch = originalFetch
                let stopped = false
                const shutdown = made.shutdown()
                void Promise.resolve(shutdown).then(() => {
                    stopped = true
                })
                // Body cancellation is now held. Let any premature shutdown completion arrive first
                await cancelStarted
                for (let index = 0; index < 5; index++) await turn()
                expect(stopped).toBe(false)
                releaseCancel()
                expect((await shutdown).isOk()).toBe(true)
                const result = await operation
                if (cleanupDefects) {
                    expect(result).toMatchObject({
                        name: "SdkDefect",
                        reasons: [
                            { kind: "Failure", failure: { _tag: "OAuthOperationError" } },
                            { kind: "Defect", defect: cleanup },
                        ],
                    })
                } else {
                    expect(result).toMatchObject({ error: { _tag: "OAuthOperationError" } })
                }
                expect(await made.fetchIdentity("access")).toMatchObject({ error: { _tag: "ClientClosedError" } })
            } finally {
                releaseCancel()
                globalThis.fetch = originalFetch
                await made.shutdown()
            }
        },
    )

    test("native interruption waits for reader cancellation and retains its cleanup defect", async () => {
        const { base } = await fixture()
        const scope = Scope.makeUnsafe()
        const client = await Effect.runPromise(
            native
                .create({ clientId: "1", clientSecret: "secret", instance: { url: base, allowInsecure: true } })
                .pipe(Effect.provideService(Scope.Scope, scope)),
        )
        await Effect.runPromise(
            client.authorizationUrl({
                redirectUri: "http://localhost/callback",
                scopes: ["identify"],
                state: "state",
                codeChallenge: native.createPkce().challenge,
            }),
        )
        const originalFetch = globalThis.fetch
        let readEntered!: () => void
        const reading = new Promise<void>((resolve) => (readEntered = resolve))
        let cancelEntered!: () => void
        const cancelling = new Promise<void>((resolve) => (cancelEntered = resolve))
        let releaseCancel!: () => void
        const gate = new Promise<void>((resolve) => (releaseCancel = resolve))
        const cleanup = new Error("OAuth reader cancellation marker")
        globalThis.fetch = async () =>
            new Response(
                new ReadableStream({
                    pull: () => {
                        readEntered()
                    },
                    cancel: async () => {
                        cancelEntered()
                        await gate
                        throw cleanup
                    },
                }),
            )
        const fiber = Effect.runFork(
            client.exchangeCode({
                code: "code",
                redirectUri: "http://localhost/callback",
                codeVerifier: "a".repeat(43),
            }),
        )
        try {
            await reading
            let interrupted = false
            const interrupt = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
                interrupted = true
            })
            await cancelling
            expect(interrupted).toBe(false)
            releaseCancel()
            await interrupt
            const exit = await Effect.runPromise(Fiber.await(fiber))
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
                expect(Cause.hasInterrupts(exit.cause)).toBe(true)
                expect(exit.cause.reasons.filter((reason) => reason._tag === "Die")).toEqual([
                    expect.objectContaining({ defect: cleanup }),
                ])
                const die = exit.cause.reasons.find((reason) => reason._tag === "Die")
                if (die?._tag === "Die") expect(die.defect).toBe(cleanup)
            }
        } finally {
            releaseCancel()
            await Effect.runPromise(Fiber.interrupt(fiber))
            globalThis.fetch = originalFetch
            await Effect.runPromise(Scope.close(scope, Exit.void))
        }
        const closed = await Effect.runPromiseExit(client.fetchIdentity("access"))
        expect(closed).toMatchObject({ cause: { reasons: [{ _tag: "Fail", error: { _tag: "ClientClosedError" } }] } })
    })

    test.each(
        modes.flatMap((mode) =>
            (["refresh", "revoke"] as const).flatMap((operation) =>
                (["discovery", "operation"] as const).map((phase) => ({ mode, operation, phase })),
            ),
        ),
    )("$mode $operation preserves $phase throttling without retry", async ({ mode, operation, phase }) => {
        const { base, requests } = await fixture(phase === "discovery" ? "discoveryRateLimit" : "operationRateLimit")
        const config = { clientId: "1", clientSecret: "secret", instance: { url: base, allowInsecure: true } }
        const expected = {
            _tag: "OAuthOperationError",
            operation: `oauth.${operation}`,
            reason: "rateLimit",
            outcome: phase === "discovery" ? "notDispatched" : "rejected",
            status: 429,
            retryAfterMs: 2_000,
        }
        if (mode === "default") {
            const made = defaultApi.create(config)
            try {
                const result =
                    operation === "refresh" ? await made.refresh("refresh") : await made.revoke({ token: "access" })
                expect(result).toMatchObject({ error: expected })
            } finally {
                await made.shutdown()
            }
        } else {
            const scope = Scope.makeUnsafe()
            const client = await Effect.runPromise(native.create(config).pipe(Scope.provide(scope)))
            try {
                const exit =
                    operation === "refresh"
                        ? await Effect.runPromiseExit(client.refresh("refresh"))
                        : await Effect.runPromiseExit(client.revoke({ token: "access" }))
                expect(exit).toMatchObject({ cause: { reasons: [{ _tag: "Fail", error: expected }] } })
            } finally {
                await Effect.runPromise(Scope.close(scope, Exit.void))
            }
        }
        expect(requests.map((request) => request.path)).toEqual([
            "/.well-known/fluxer",
            ...(phase === "discovery" ? [] : [operation === "refresh" ? "/oauth2/token" : "/oauth2/token/revoke"]),
        ])
    })

    const lostResponseOperations = {
        exchangeCode: {
            path: "/oauth2/token",
            field: ["grant_type", "authorization_code"],
            call: (client: AnyOAuthClient): Operation<unknown, unknown> =>
                client.exchangeCode({
                    code: "code",
                    redirectUri: "http://localhost/callback",
                    codeVerifier: "a".repeat(43),
                }),
        },
        refresh: {
            path: "/oauth2/token",
            field: ["grant_type", "refresh_token"],
            call: (client: AnyOAuthClient): Operation<unknown, unknown> => client.refresh("refresh"),
        },
        revoke: {
            path: "/oauth2/token/revoke",
            field: ["token_type_hint", "access_token"],
            call: (client: AnyOAuthClient): Operation<unknown, unknown> =>
                client.revoke({ token: "access", tokenTypeHint: "access_token" }),
        },
    } as const

    test.each(
        modes.flatMap((mode) =>
            (["exchangeCode", "refresh", "revoke"] as const).map((operation) => ({ mode, operation })),
        ),
    )("$mode $operation retains a lost response as unknown with exactly one dispatch", async ({ mode, operation }) => {
        const { base, requests } = await fixture()
        const { path, field, call } = lostResponseOperations[operation]
        const originalFetch = globalThis.fetch
        globalThis.fetch = async (input, init) => {
            const response = await originalFetch(input, init)
            if (String(input) !== `${base}${path}`) return response
            await response.arrayBuffer()
            throw new Error("Fixture lost response")
        }
        try {
            const client = await oauthClient(mode, base)
            expect(await expectErr(call(client))).toMatchObject({
                operation: `oauth.${operation}`,
                reason: "network",
                outcome: "unknown",
            })
            expect(requests.map((request) => request.path)).toEqual(["/.well-known/fluxer", path])
            const dispatched = requests.find((request) => request.path === path)
            expect(new URLSearchParams(dispatched?.body).get(field[0])).toBe(field[1])
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    test.each(modes)("%s retains discovery throttling alongside reader-cleanup defects", async (mode) => {
        const { base } = await fixture()
        const config = { clientId: "1", clientSecret: "secret", instance: { url: base, allowInsecure: true } }
        const originalFetch = globalThis.fetch
        const paths: string[] = []
        const cleanup = new Error("private discovery cleanup marker")
        let cancellations = 0
        globalThis.fetch = async (input) => {
            paths.push(String(input))
            return new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(new Uint8Array(1_048_577))
                    },
                    cancel() {
                        cancellations += 1
                        throw cleanup
                    },
                }),
                { status: 429, headers: { "retry-after": "2" } },
            )
        }
        const expected = {
            _tag: "OAuthOperationError",
            operation: "oauth.refresh",
            reason: "rateLimit",
            outcome: "notDispatched",
            status: 429,
            retryAfterMs: 2_000,
        }
        try {
            if (mode === "default") {
                const made = defaultApi.create(config)
                try {
                    const error = await Promise.resolve(made.refresh("refresh")).catch((error) => error)
                    expect(error).toMatchObject({
                        name: "SdkDefect",
                        reasons: [
                            { kind: "Failure", failure: expected },
                            { kind: "Defect", defect: cleanup },
                        ],
                    })
                    expect(JSON.stringify(error)).toContain(cleanup.message)
                } finally {
                    await made.shutdown()
                }
            } else {
                const scope = Scope.makeUnsafe()
                const client = await Effect.runPromise(native.create(config).pipe(Scope.provide(scope)))
                try {
                    const exit = await Effect.runPromiseExit(client.refresh("refresh"))
                    expect(exit).toMatchObject({
                        cause: {
                            reasons: [
                                { _tag: "Fail", error: expected },
                                { _tag: "Die", defect: cleanup },
                            ],
                        },
                    })
                } finally {
                    await Effect.runPromise(Scope.close(scope, Exit.void))
                }
            }
            expect(paths).toEqual([`${base}/.well-known/fluxer`])
            expect(cancellations).toBe(1)
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    test("marks a discovery deadline notDispatched and never sends a token request", async () => {
        const clock = sdkClock()
        const { base, requests } = await fixture("discoveryStall")
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        const pending = made.exchangeCode(
            { code: "code", redirectUri: "http://localhost/callback", codeVerifier: "a".repeat(43) },
            { timeoutMs: 20 },
        )
        await waitUntil(() => requests.some((request) => request.path === "/.well-known/fluxer"))
        await clock.waiting(20)
        await clock.advance(20)
        const result = await pending
        expect(result.isErr()).toBe(true)
        if (result.isErr()) expect(result.error).toMatchObject({ reason: "timeout", outcome: "notDispatched" })
        expect(requests.filter((request) => request.path === "/oauth2/token")).toHaveLength(0)
        await made.shutdown()
    })

    test("times out a stalled token response body as unknown", async () => {
        const clock = sdkClock()
        const { base, requests } = await fixture("stallBody")
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        const originalFetch = globalThis.fetch
        let reading = false
        globalThis.fetch = async (input, init) => {
            const response = await originalFetch(input, init)
            if (!String(input).endsWith("/oauth2/token")) return response
            const reader = response.body!.getReader()
            let chunks = 0
            return new Response(
                new ReadableStream(
                    {
                        async pull(controller) {
                            if (chunks > 0) reading = true
                            const chunk = await reader.read()
                            if (chunk.done) controller.close()
                            else {
                                chunks++
                                controller.enqueue(chunk.value)
                            }
                        },
                        cancel: () => reader.cancel(),
                    },
                    { highWaterMark: 0 },
                ),
                { status: response.status, headers: response.headers },
            )
        }
        try {
            const pending = made.exchangeCode(
                { code: "code", redirectUri: "http://localhost/callback", codeVerifier: "a".repeat(43) },
                { timeoutMs: 20 },
            )
            await waitUntil(() => reading)
            await clock.waiting(20)
            await clock.advance(20)
            const result = await pending
            expect(result.isErr()).toBe(true)
            if (result.isErr()) expect(result.error).toMatchObject({ reason: "timeout", outcome: "unknown" })
            expect(requests.filter((request) => request.path === "/oauth2/token")).toHaveLength(1)
        } finally {
            globalThis.fetch = originalFetch
            await made.shutdown()
        }
    })

    test("retains a response failure with its reader-cleanup defect and masks credentials in the default rejection", async () => {
        const { base } = await fixture()
        const cleanup = new Error("OAuth reader cleanup marker client_secret=fixture-planted-secret")
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        await made.authorizationUrl({
            redirectUri: "http://localhost/callback",
            scopes: ["identify"],
            state: "state",
            codeChallenge: defaultApi.createPkce().challenge,
        })
        const originalFetch = globalThis.fetch
        globalThis.fetch = async (input) => {
            if (!String(input).endsWith("/oauth2/token")) return originalFetch(input)
            return new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode("x".repeat(1_048_577)))
                    },
                    cancel: () => Promise.reject(cleanup),
                }),
                { status: 200 },
            )
        }
        try {
            const error = await Promise.resolve(
                made.exchangeCode({
                    code: "code",
                    redirectUri: "http://localhost/callback",
                    codeVerifier: "a".repeat(43),
                }),
            ).catch((error: unknown) => error)
            expect(error).toMatchObject({
                name: "SdkDefect",
                reasons: [
                    {
                        kind: "Failure",
                        failure: { _tag: "OAuthOperationError", reason: "response", outcome: "unknown", status: 200 },
                    },
                    { kind: "Defect", defect: cleanup },
                ],
            })
            for (const text of [JSON.stringify(error), describeError(error)]) {
                expect(text).toContain("OAuth reader cleanup marker")
                expect(text).not.toContain("fixture-planted-secret")
            }
        } finally {
            globalThis.fetch = originalFetch
            await made.shutdown()
        }
    })
})
