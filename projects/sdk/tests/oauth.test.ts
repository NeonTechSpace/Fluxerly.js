import { createServer, request as httpRequest } from "node:http"
import { inspect } from "node:util"
import { afterEach, describe, expect, test, vi } from "vitest"
import { Cause, Effect, Exit, Fiber, Scope } from "effect"
import {
    createClient,
    oauth as defaultApi,
    SdkDefect,
    type OAuthAuthorizationInput,
    type OAuthCodeExchangeInput,
    type OAuthConfig,
} from "../src/index.js"
import { oauth as native } from "../src/effect.js"

let close: (() => Promise<void>) | undefined

test.each(["default", "native"] as const)(
    "%s rejects noncanonical OAuth form/query values before discovery",
    async (mode) => {
        const fetch = vi.fn()
        vi.stubGlobal("fetch", fetch)
        const scope = Scope.makeUnsafe()
        const defaultClient = defaultApi.create({ clientId: "1", clientSecret: "secret" })._unsafeUnwrap()
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
    },
)

test.each(["default", "native"] as const)("%s bounds OAuth scope entries before discovery", async (mode) => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const scope = Scope.makeUnsafe()
    const defaultClient = defaultApi.create({ clientId: "1", clientSecret: "secret" })._unsafeUnwrap()
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
    const client = defaultApi.create(config)._unsafeUnwrap()
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
    let markRequestBodyStarted!: () => void
    const requestBodyStarted = new Promise<void>((resolve) => (markRequestBodyStarted = resolve))
    let markConnectionRequestStarted!: () => void
    const connectionRequestStarted = new Promise<void>((resolve) => (markConnectionRequestStarted = resolve))
    let base = ""
    const server = createServer(async (request, response) => {
        markRequestBodyStarted()
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
        if (request.url === "/users/@me/connections") markConnectionRequestStarted()
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
                    global_name: null,
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
    return { base, requests, requestBodyStarted, connectionRequestStarted }
}

afterEach(async () => {
    await close?.()
    close = undefined
})

describe("oauth", () => {
    test("keeps fixture discovery endpoints available while closing an active request", async () => {
        const { base, requestBodyStarted } = await fixture()
        const settleWithin = <A>(value: Promise<A>, stage: string) =>
            new Promise<A>((resolve, reject) => {
                const timer = setTimeout(
                    () => reject(new Error(`Fixture ${stage} did not settle within 1,000 ms`)),
                    1_000,
                )
                void value.then(
                    (result) => {
                        clearTimeout(timer)
                        resolve(result)
                    },
                    (error) => {
                        clearTimeout(timer)
                        reject(error)
                    },
                )
            })
        let resolveResponse!: (value: unknown) => void
        let rejectResponse!: (reason: unknown) => void
        const response = new Promise<unknown>((resolve, reject) => {
            resolveResponse = resolve
            rejectResponse = reject
        })
        const request = httpRequest(`${base}/.well-known/fluxer`, { method: "POST", agent: false }, (response) => {
            let body = ""
            response.setEncoding("utf8")
            response.on("data", (part) => (body += part))
            response.on("end", () => {
                try {
                    resolveResponse(JSON.parse(body))
                } catch (error) {
                    rejectResponse(error)
                }
            })
        })
        request.on("error", rejectResponse)
        try {
            request.write("pending")
            await settleWithin(requestBodyStarted, "request start")
            const stopping = close?.()
            if (!stopping) throw new Error("Fixture did not register shutdown")
            request.end()
            await expect(settleWithin(response, "response")).resolves.toMatchObject({ endpoints: { webapp: base } })
            request.destroy()
            await settleWithin(stopping, "shutdown")
        } finally {
            request.destroy()
        }
    })

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
            const expected = `${base}${expectedWebappPath}/oauth2/authorize?${new URLSearchParams({
                client_id: "1",
                response_type: "code",
                redirect_uri: input.redirectUri,
                scope: input.scopes.join(" "),
                state: input.state,
                code_challenge: input.codeChallenge,
                code_challenge_method: "S256",
            })}`

            const installationClient = createClient({
                token: "fixture-token",
                instance: { url: base, allowInsecure: true },
            })._unsafeUnwrap()
            try {
                const resolved = await installationClient.instance.resolve()
                expect(resolved._unsafeUnwrap().links.installation("1")._unsafeUnwrap()).toBe(
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
            if (defaultClient.isErr()) throw defaultClient.error
            try {
                expect((await defaultClient.value.authorizationUrl(input))._unsafeUnwrap()).toBe(expected)
            } finally {
                await defaultClient.value.shutdown()
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
            expect(nativeUrl).toBe(expected)
        },
    )

    test("builds combined code-grant authorization URLs with bounded bot installation hints", async () => {
        const { base } = await fixture()
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        if (made.isErr()) throw made.error
        try {
            const result = await made.value.authorizationUrl({
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
            await made.value.shutdown()
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
        if (defaultClient.isErr()) throw defaultClient.error
        try {
            const defaultUrl = (await defaultClient.value.authorizationUrl(input))._unsafeUnwrap()
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
            await defaultClient.value.shutdown()
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
        if (defaultClient.isErr()) throw defaultClient.error
        try {
            const authorization = await defaultClient.value.authorizationUrl(authorizationInput())
            expect(new URL(authorization._unsafeUnwrap()).searchParams.get("scope")).toBe("identify")

            expect((await defaultClient.value.exchangeCode(exchangeInput())).isOk()).toBe(true)
            expect(new URLSearchParams(requests.at(-1)?.body).get("code")).toBe("validated-code")

            expect((await defaultClient.value.revoke(revokeInput())).isOk()).toBe(true)
            expect(new URLSearchParams(requests.at(-1)?.body).get("token")).toBe("validated-token")

            const requestCount = requests.length
            expect(await defaultClient.value.authorizationUrl(invalidFirstInput())).toMatchObject({
                error: { reason: "input", outcome: "notDispatched", inputValidation: { path: "scopes[]" } },
            })
            expect(requests).toHaveLength(requestCount)
        } finally {
            await defaultClient.value.shutdown()
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
            if (defaultClient.isErr()) throw defaultClient.error
            try {
                expect(await defaultClient.value.authorizationUrl(input)).toMatchObject({
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
                await defaultClient.value.shutdown()
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
        if (made.isErr()) throw made.error
        try {
            expect((await made.value.fetchConnections("access"))._unsafeUnwrap()[0]).toMatchObject({ id: "", name: "" })
        } finally {
            await made.value.shutdown()
        }
    })

    test("rejects connection fields beyond Fluxer's nonnegative Int32 response domain", async () => {
        const { base } = await fixture("connectionsOutOfRange")
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        if (made.isErr()) throw made.error
        try {
            expect(await made.value.fetchConnections("access")).toMatchObject({
                error: { reason: "response", outcome: "rejected", status: 200 },
            })
        } finally {
            await made.value.shutdown()
        }
    })

    test("uses selected discovery, form and Basic authentication without bot credentials", async () => {
        const { base, requests } = await fixture()
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        expect(made.isOk()).toBe(true)
        if (made.isErr()) return
        const client = made.value
        const url = await client.authorizationUrl({
            redirectUri: "http://localhost/callback",
            scopes: ["identify", "guilds"],
            state: "state",
            codeChallenge: defaultApi.createPkce().challenge,
        })
        expect(url._unsafeUnwrap()).toContain("code_challenge_method=S256")
        const tokens = await client.exchangeCode({
            code: "code",
            redirectUri: "http://localhost/callback",
            codeVerifier: "a".repeat(43),
        })
        expect(tokens._unsafeUnwrap().scopes).toEqual(["identify", "guilds", "future"])
        expect((await client.fetchIdentity("access"))._unsafeUnwrap().id).toBe("1")
        expect((await client.fetchGuilds("access"))._unsafeUnwrap()[0]?.id).toBe("2")
        expect((await client.fetchConnections("access"))._unsafeUnwrap()[0]).toMatchObject({
            id: "connection",
            visibilityFlags: 1,
        })
        expect((await client.introspect("access"))._unsafeUnwrap()).toMatchObject({
            active: true,
            clientId: "1",
            subjectId: "2",
            scopes: ["identify", "connections", "bot"],
        })
        expect((await client.revoke({ token: "access" })).isOk()).toBe(true)
        expect(requests.find((entry) => entry.path === "/oauth2/token")?.authorization).toMatch(/^Basic /)
        expect(requests.find((entry) => entry.path === "/oauth2/introspect")).toMatchObject({
            authorization: expect.stringMatching(/^Basic /),
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
                .every((entry) => entry.authorization === "Bearer access"),
        ).toBe(true)
        await client.shutdown()
    })

    test("preserves native caller execution", async () => {
        const { base } = await fixture()
        const result = await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const client = yield* native.create({
                        clientId: "1",
                        clientSecret: "secret",
                        instance: { url: base, allowInsecure: true },
                    })
                    const connections = yield* client.fetchConnections("access")
                    const token = yield* client.introspect("access")
                    const identity = yield* client.fetchIdentity("access")
                    return { connections, token, identity }
                }),
            ),
        )
        expect(result.identity.id).toBe("1")
        expect(result.connections[0]?.type).toBe("domain")
        expect(result.token).toMatchObject({ active: true, tokenType: "Bearer" })
    })

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
        if (made.isErr()) throw made.error
        try {
            const result = await made.value[method](value)
            expect(result).toMatchObject({ error: { reason: "response", outcome: "rejected", status: 200 } })
        } finally {
            await made.value.shutdown()
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
        if (made.isErr()) throw made.error
        try {
            const result = (await made.value.introspect("access"))._unsafeUnwrap()
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
            await made.value.shutdown()
        }
    })

    test("projects active refresh introspection without inventing an access expiry", async () => {
        const { base } = await fixture("introspectionRefresh")
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        if (made.isErr()) throw made.error
        try {
            const result = (await made.value.introspect("refresh"))._unsafeUnwrap()
            expect(result).toMatchObject({
                active: true,
                tokenType: "refresh_token",
                issuedAtUnixSeconds: 1_700_000_000,
            })
            expect(Object.hasOwn(result, "expiresAtUnixSeconds")).toBe(false)
        } finally {
            await made.value.shutdown()
        }
    })

    test("keeps a delegated connection permission failure private and leaves the client usable", async () => {
        const { base } = await fixture("connectionsForbidden")
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        if (made.isErr()) throw made.error
        try {
            const denied = await made.value.fetchConnections("access")
            expect(denied).toMatchObject({ error: { reason: "rejected", outcome: "rejected", status: 403 } })
            expect(JSON.stringify(denied)).not.toContain("private connections")
            expect((await made.value.fetchIdentity("access"))._unsafeUnwrap().id).toBe("1")
        } finally {
            await made.value.shutdown()
        }
    })

    test("cancels a dispatched delegated connection read and awaits its cleanup", async () => {
        const { base, connectionRequestStarted } = await fixture("connectionsStall")
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        if (made.isErr()) throw made.error
        const controller = new AbortController()
        try {
            const operation = made.value.fetchConnections("access", { signal: controller.signal })
            await connectionRequestStarted
            controller.abort()
            expect(await operation).toMatchObject({ error: { _tag: "CancelledError" } })
        } finally {
            await made.value.shutdown()
        }
    })

    test("validates supplied state, PKCE, redirect and scope before discovery", async () => {
        const made = defaultApi.create({ clientId: "1", clientSecret: "secret" })
        if (made.isErr()) throw made.error
        const result = await made.value.authorizationUrl({
            redirectUri: "https://user:password@example.test/callback",
            scopes: [],
            state: "",
            codeChallenge: "",
        })
        expect(result.isErr()).toBe(true)
        if (result.isErr())
            expect(result.error).toMatchObject({
                _tag: "OAuthOperationError",
                reason: "input",
                outcome: "notDispatched",
            })
        const pkce = defaultApi.createPkce()
        expect(pkce.verifier).not.toBe(pkce.challenge)
        expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]+$/)
        await made.value.shutdown()
    })

    test.each(["rejected", "serverError", "malformed", "large"] as const)(
        "maps %s token responses without private bodies or retries",
        async (mode) => {
            const { base, requests } = await fixture(mode)
            const made = defaultApi.create({
                clientId: "1",
                clientSecret: "secret",
                instance: { url: base, allowInsecure: true },
            })
            if (made.isErr()) throw made.error
            const result = await made.value.exchangeCode({
                code: "code",
                redirectUri: "http://localhost/callback",
                codeVerifier: "a".repeat(43),
            })
            expect(result.isErr()).toBe(true)
            if (result.isErr()) {
                expect(result.error).toMatchObject({ _tag: "OAuthOperationError" })
                expect(result.error.message).not.toContain("secret")
                expect(JSON.stringify(result.error)).not.toContain("secret")
            }
            expect(requests.filter((request) => request.path === "/oauth2/token")).toHaveLength(1)
            await made.value.shutdown()
        },
    )

    test("maps a normal Fluxer error envelope without replacing RFC OAuth errors", async () => {
        const { base } = await fixture("fluxerRejected")
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        if (made.isErr()) throw made.error
        const result = await made.value.exchangeCode({
            code: "code",
            redirectUri: "http://localhost/callback",
            codeVerifier: "a".repeat(43),
        })
        expect(result).toMatchObject({
            error: {
                apiError: { providerCode: "MISSING_PERMISSIONS" },
                oauthError: null,
                message: expect.stringContaining("The provider reports that the bot lacks a required permission"),
            },
        })
        await made.value.shutdown()
    })

    test("maps invalid JSON from a dispatched 2xx mutation to an unknown response outcome", async () => {
        const { base } = await fixture("invalidJson")
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        if (made.isErr()) throw made.error
        const result = await made.value.exchangeCode({
            code: "code",
            redirectUri: "http://localhost/callback",
            codeVerifier: "a".repeat(43),
        })
        expect(result).toMatchObject({ error: { reason: "response", outcome: "unknown", status: 200 } })
        await made.value.shutdown()
    })

    test("keeps a lost response unknown and cancels a response that arrives after timeout", async () => {
        const { base } = await fixture()
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        if (made.isErr()) throw made.error
        await made.value.authorizationUrl({
            redirectUri: "http://localhost/callback",
            scopes: ["identify"],
            state: "state",
            codeChallenge: defaultApi.createPkce().challenge,
        })
        const originalFetch = globalThis.fetch
        globalThis.fetch = async (input, init) => {
            if (!String(input).endsWith("/oauth2/token")) return originalFetch(input, init)
            throw new Error("lost response")
        }
        try {
            expect(
                await made.value.exchangeCode({
                    code: "code",
                    redirectUri: "http://localhost/callback",
                    codeVerifier: "a".repeat(43),
                }),
            ).toMatchObject({ error: { reason: "network", outcome: "unknown" } })
        } finally {
            globalThis.fetch = originalFetch
        }

        let cancelled = false
        globalThis.fetch = async (input, init) => {
            if (!String(input).endsWith("/oauth2/token")) return originalFetch(input, init)
            await new Promise((resolve) => setTimeout(resolve, 5))
            return new Response(new ReadableStream({ cancel: () => void (cancelled = true) }), { status: 200 })
        }
        try {
            expect(
                await made.value.exchangeCode(
                    { code: "code", redirectUri: "http://localhost/callback", codeVerifier: "a".repeat(43) },
                    { timeoutMs: 1 },
                ),
            ).toMatchObject({ error: { reason: "timeout", outcome: "unknown" } })
            expect(cancelled).toBe(true)
        } finally {
            globalThis.fetch = originalFetch
            await made.value.shutdown()
        }
    })

    test("keeps a received 403 rejected when its metadata body stalls past the deadline", async () => {
        const { base } = await fixture()
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        if (made.isErr()) throw made.error
        await made.value.authorizationUrl({
            redirectUri: "http://localhost/callback",
            scopes: ["identify"],
            state: "state",
            codeChallenge: defaultApi.createPkce().challenge,
        })
        const originalFetch = globalThis.fetch
        globalThis.fetch = async (input, init) =>
            String(input).endsWith("/oauth2/token")
                ? new Response(new ReadableStream(), { status: 403 })
                : originalFetch(input, init)
        try {
            expect(
                await made.value.exchangeCode(
                    { code: "code", redirectUri: "http://localhost/callback", codeVerifier: "a".repeat(43) },
                    { timeoutMs: 5 },
                ),
            ).toMatchObject({ error: { reason: "rejected", outcome: "rejected", status: 403 } })
        } finally {
            globalThis.fetch = originalFetch
            await made.value.shutdown()
        }
    })

    test("rejects the ninth concurrent OAuth request before dispatch", async () => {
        const { base } = await fixture()
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        if (made.isErr()) throw made.error
        await made.value.authorizationUrl({
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
            const active = Array.from({ length: 8 }, () => made.value.exchangeCode(input))
            await allEntered
            expect(await made.value.exchangeCode(input)).toMatchObject({
                error: { reason: "busy", outcome: "notDispatched" },
            })
            await made.value.shutdown()
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
        if (first.isErr()) throw first.error
        expect((await first.value.revoke({ token: "access" })).isOk()).toBe(true)
        await first.value.shutdown()
        await close?.()
        close = undefined

        const rejected = await fixture("revokeRejected")
        const second = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: rejected.base, allowInsecure: true },
        })
        if (second.isErr()) throw second.error
        expect(await second.value.revoke({ token: "access" })).toMatchObject({
            error: { reason: "rejected", oauthError: "invalid_grant" },
        })
        await second.value.shutdown()
    })

    test("marks a dispatched code exchange timeout unknown without retrying", async () => {
        const { base, requests } = await fixture("stall")
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        if (made.isErr()) throw made.error
        const result = await made.value.exchangeCode(
            { code: "code", redirectUri: "http://localhost/callback", codeVerifier: "a".repeat(43) },
            { timeoutMs: 20 },
        )
        expect(result.isErr()).toBe(true)
        if (result.isErr())
            expect(result.error).toMatchObject({ _tag: "OAuthOperationError", reason: "timeout", outcome: "unknown" })
        expect(requests.filter((request) => request.path === "/oauth2/token")).toHaveLength(1)
        await made.value.shutdown()
    })

    test("uses the default AbortSignal without passing it into strict native options", async () => {
        const { base } = await fixture("stall")
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        if (made.isErr()) throw made.error
        const controller = new AbortController()
        const operation = made.value.exchangeCode(
            { code: "code", redirectUri: "http://localhost/callback", codeVerifier: "a".repeat(43) },
            { signal: controller.signal },
        )
        await new Promise((resolve) => setTimeout(resolve, 10))
        controller.abort()
        expect(await operation).toMatchObject({ error: { _tag: "CancelledError" } })
        await made.value.shutdown()
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
                expect((defaultFailure as SdkDefect).reasons).toEqual([{ kind: "Defect" }])
                expect(inspect(defaultFailure)).not.toContain(privateSecret)
                expect(inspect(defaultFailure)).not.toContain(defect.message)
                expect(JSON.stringify(defaultFailure)).not.toContain(privateSecret)
                expect(JSON.stringify(defaultFailure)).not.toContain(defect.message)

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
    ] as const)("keeps ordinary OAuth %s configuration failures expected", (_, configuration) => {
        const defaultFailure = defaultApi.create(configuration as OAuthConfig)
        expect(defaultFailure).toMatchObject({ error: { _tag: "ConfigurationError" } })

        const nativeFailure = Effect.runSyncExit(Effect.scoped(native.create(configuration as OAuthConfig)))
        expect(Exit.isFailure(nativeFailure)).toBe(true)
        if (Exit.isFailure(nativeFailure)) {
            expect(Cause.hasFails(nativeFailure.cause)).toBe(true)
            expect(Cause.hasDies(nativeFailure.cause)).toBe(false)
            expect(nativeFailure.cause.reasons).toEqual([
                expect.objectContaining({
                    _tag: "Fail",
                    error: expect.objectContaining({ _tag: "ConfigurationError" }),
                }),
            ])
        }
    })

    test("returns typed input failures for malformed operation options and sparse authorization scopes", async () => {
        const fetch = vi.fn()
        vi.stubGlobal("fetch", fetch)
        const made = defaultApi.create({ clientId: "1", clientSecret: "secret" })
        if (made.isErr()) throw made.error
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
                expect(await made.value.authorizationUrl(input, option)).toMatchObject({
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
            expect(await made.value.authorizationUrl({ ...input, scopes: Array(1) })).toMatchObject({
                error: { reason: "input", outcome: "notDispatched" },
            })
            expect(fetch).not.toHaveBeenCalled()
        } finally {
            await made.value.shutdown()
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
            if (made.isErr()) throw made.error
            await made.value.authorizationUrl({
                redirectUri: "http://localhost/callback",
                scopes: ["identify"],
                state: "state",
                codeChallenge: defaultApi.createPkce().challenge,
            })
            let entered!: () => void
            const enteredRequest = new Promise<void>((resolve) => (entered = resolve))
            let releaseCancel!: () => void
            const cancelled = new Promise<void>((resolve) => (releaseCancel = resolve))
            const originalFetch = globalThis.fetch
            globalThis.fetch = async (input, init) => {
                if (!String(input).endsWith("/oauth2/token")) return originalFetch(input, init)
                entered()
                return new Response(
                    new ReadableStream({
                        cancel: async () => {
                            await cancelled
                            if (cleanupDefects) throw new Error("private OAuth shutdown cleanup marker")
                        },
                    }),
                    { status: 200 },
                )
            }
            try {
                const operation = Promise.resolve(
                    made.value.exchangeCode({
                        code: "code",
                        redirectUri: "http://localhost/callback",
                        codeVerifier: "a".repeat(43),
                    }),
                ).catch((error) => error)
                await enteredRequest
                globalThis.fetch = originalFetch
                const shutdown = made.value.shutdown()
                await expect(
                    Promise.race([shutdown, new Promise((resolve) => setTimeout(resolve, 10, "pending"))]),
                ).resolves.toBe("pending")
                releaseCancel()
                expect((await shutdown).isOk()).toBe(true)
                const result = await operation
                if (cleanupDefects) {
                    expect(result).toMatchObject({
                        name: "SdkDefect",
                        reasons: [{ kind: "Failure", failure: { _tag: "OAuthOperationError" } }, { kind: "Defect" }],
                    })
                    expect(JSON.stringify(result)).not.toContain("private OAuth shutdown cleanup marker")
                } else {
                    expect(result).toMatchObject({ error: { _tag: "OAuthOperationError" } })
                }
                expect(await made.value.fetchIdentity("access")).toMatchObject({ error: { _tag: "ClientClosedError" } })
            } finally {
                releaseCancel()
                globalThis.fetch = originalFetch
                await made.value.shutdown()
            }
        },
    )

    test("native interruption waits for reader cancellation and preserves only a sanitized cleanup defect", async () => {
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
        const privateMarker = "private OAuth reader cancellation marker"
        globalThis.fetch = async () =>
            new Response(
                new ReadableStream({
                    pull: () => {
                        readEntered()
                    },
                    cancel: async () => {
                        cancelEntered()
                        await gate
                        throw new Error(privateMarker)
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
                expect(Cause.hasDies(exit.cause)).toBe(true)
                expect(Cause.pretty(exit.cause)).toContain("OAuth response cleanup failed")
                expect(Cause.pretty(exit.cause)).not.toContain(privateMarker)
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
        (["default", "native"] as const).flatMap((mode) =>
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
            if (made.isErr()) throw made.error
            try {
                const result =
                    operation === "refresh"
                        ? await made.value.refresh("refresh")
                        : await made.value.revoke({ token: "access" })
                expect(result).toMatchObject({ error: expected })
            } finally {
                await made.value.shutdown()
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

    test.each(
        (["default", "native"] as const).flatMap((mode) =>
            (["refresh", "revoke"] as const).map((operation) => ({ mode, operation })),
        ),
    )("$mode $operation retains a lost response as unknown with exactly one dispatch", async ({ mode, operation }) => {
        const { base, requests } = await fixture()
        const config = { clientId: "1", clientSecret: "secret", instance: { url: base, allowInsecure: true } }
        const path = operation === "refresh" ? "/oauth2/token" : "/oauth2/token/revoke"
        const originalFetch = globalThis.fetch
        globalThis.fetch = async (input, init) => {
            const response = await originalFetch(input, init)
            if (String(input) !== `${base}${path}`) return response
            await response.arrayBuffer()
            throw new Error("Fixture lost response")
        }
        const expected = { operation: `oauth.${operation}`, reason: "network", outcome: "unknown" }
        try {
            if (mode === "default") {
                const made = defaultApi.create(config)
                if (made.isErr()) throw made.error
                try {
                    const result =
                        operation === "refresh"
                            ? await made.value.refresh("refresh")
                            : await made.value.revoke({ token: "access", tokenTypeHint: "access_token" })
                    expect(result).toMatchObject({ error: expected })
                } finally {
                    await made.value.shutdown()
                }
            } else {
                const scope = Scope.makeUnsafe()
                const client = await Effect.runPromise(native.create(config).pipe(Scope.provide(scope)))
                try {
                    const exit =
                        operation === "refresh"
                            ? await Effect.runPromiseExit(client.refresh("refresh"))
                            : await Effect.runPromiseExit(
                                  client.revoke({ token: "access", tokenTypeHint: "access_token" }),
                              )
                    expect(exit).toMatchObject({ cause: { reasons: [{ _tag: "Fail", error: expected }] } })
                } finally {
                    await Effect.runPromise(Scope.close(scope, Exit.void))
                }
            }
            expect(requests.map((request) => request.path)).toEqual(["/.well-known/fluxer", path])
            const dispatched = requests.find((request) => request.path === path)
            expect(
                new URLSearchParams(dispatched?.body).get(operation === "refresh" ? "grant_type" : "token_type_hint"),
            ).toBe(operation === "refresh" ? "refresh_token" : "access_token")
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    test.each(["default", "native"] as const)(
        "%s retains discovery throttling alongside reader-cleanup defects",
        async (mode) => {
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
                    if (made.isErr()) throw made.error
                    try {
                        const error = await Promise.resolve(made.value.refresh("refresh")).catch((error) => error)
                        expect(error).toMatchObject({
                            name: "SdkDefect",
                            reasons: [{ kind: "Failure", failure: expected }, { kind: "Defect" }],
                        })
                        expect(JSON.stringify(error)).not.toContain(cleanup.message)
                    } finally {
                        await made.value.shutdown()
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
        },
    )

    test("marks a discovery deadline notDispatched and never sends a token request", async () => {
        const { base, requests } = await fixture("discoveryStall")
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        if (made.isErr()) throw made.error
        const result = await made.value.exchangeCode(
            { code: "code", redirectUri: "http://localhost/callback", codeVerifier: "a".repeat(43) },
            { timeoutMs: 20 },
        )
        expect(result.isErr()).toBe(true)
        if (result.isErr()) expect(result.error).toMatchObject({ reason: "timeout", outcome: "notDispatched" })
        expect(requests.filter((request) => request.path === "/oauth2/token")).toHaveLength(0)
        await made.value.shutdown()
    })

    test("waits for a stalled response-body abort during timeout and shutdown", async () => {
        const { base, requests } = await fixture("stallBody")
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        if (made.isErr()) throw made.error
        const result = await made.value.exchangeCode(
            { code: "code", redirectUri: "http://localhost/callback", codeVerifier: "a".repeat(43) },
            { timeoutMs: 20 },
        )
        expect(result.isErr()).toBe(true)
        if (result.isErr()) expect(result.error).toMatchObject({ reason: "timeout", outcome: "unknown" })
        expect(requests.filter((request) => request.path === "/oauth2/token")).toHaveLength(1)
        await made.value.shutdown()
    })

    test("retains a response failure with reader-cleanup defects and sanitizes the default rejection", async () => {
        const { base } = await fixture()
        const made = defaultApi.create({
            clientId: "1",
            clientSecret: "secret",
            instance: { url: base, allowInsecure: true },
        })
        if (made.isErr()) throw made.error
        await made.value.authorizationUrl({
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
                    cancel: () => Promise.reject(new Error("private reader cleanup secret")),
                }),
                { status: 200 },
            )
        }
        try {
            await expect(
                made.value.exchangeCode({
                    code: "code",
                    redirectUri: "http://localhost/callback",
                    codeVerifier: "a".repeat(43),
                }),
            ).rejects.toMatchObject({ name: "SdkDefect", reasons: [{ kind: "Failure" }, { kind: "Defect" }] })
        } finally {
            globalThis.fetch = originalFetch
            await made.value.shutdown()
        }
    })
})
