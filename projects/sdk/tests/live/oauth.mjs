import assert from "node:assert/strict"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs"
import { parseEnv } from "node:util"
import { Effect, Exit, Scope } from "effect"

// Default mode requires manual consent; --no-consent performs only explicit read and URL-construction checks
// Neither mode is part of CI or schedules
// Prerequisites: An authorized sandbox application, FLUXER_TEST_CLIENT_SECRET, and this exact registered redirect URI
const noConsent = process.argv.includes("--no-consent")
const mode = process.argv.slice(2).find((argument) => argument !== "--no-consent")
const redirectUri = "http://localhost:3000/auth/fluxer/callback"
const callbackPath = "/auth/fluxer/callback"
const apiBase = "https://api.fluxer.app"
const environment = new URL("../../.env.test.local", import.meta.url)
const lockPath = new URL("../../.env.test.local.lock", import.meta.url)
const report = (check, details = {}) => console.log(JSON.stringify({ mode, check, ...details }))

class HarnessFailure extends Error {
    constructor(check, details = {}) {
        super(check)
        this.check = check
        this.details = details
    }
}

const safeEqual = (left, right) => {
    const leftBytes = Buffer.from(left)
    const rightBytes = Buffer.from(right)
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

async function responseJson(response, check) {
    if (!response.ok) {
        await response.body?.cancel()
        throw new HarnessFailure(check, { httpStatus: response.status })
    }
    return response.json()
}

async function botGet(path, token, check) {
    let response
    try {
        response = await fetch(`${apiBase}${path}`, {
            headers: { Authorization: `Bot ${token}` },
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
        })
        return await responseJson(response, check)
    } catch (error) {
        if (error instanceof HarnessFailure) throw error
        throw new HarnessFailure(check)
    }
}

async function bearerGet(path, token, check) {
    let response
    try {
        response = await fetch(`${apiBase}${path}`, {
            headers: { Authorization: `Bearer ${token}` },
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
        })
        return await responseJson(response, check)
    } catch (error) {
        if (error instanceof HarnessFailure) throw error
        throw new HarnessFailure(check)
    }
}

async function verifyRevokedIdentity(token) {
    let response
    try {
        response = await fetch(`${apiBase}/oauth2/userinfo`, {
            headers: { Authorization: `Bearer ${token}` },
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
        })
        assert.equal(response.status, 401)
    } catch (error) {
        if (error instanceof HarnessFailure) throw error
        throw new HarnessFailure("revoked_identity")
    } finally {
        await response?.body?.cancel()
    }
}

function hasUnknownOAuthFailure(value, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) return false
    seen.add(value)
    if (value._tag === "OAuthOperationError" && value.outcome === "unknown") return true
    if (Array.isArray(value)) return value.some((item) => hasUnknownOAuthFailure(item, seen))
    for (const key of ["cause", "error", "failure", "defect", "errors", "reasons"])
        if (hasUnknownOAuthFailure(value[key], seen)) return true
    return false
}

async function discoverHostedApi() {
    let response
    try {
        response = await fetch("https://api.fluxer.app/.well-known/fluxer", {
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
        })
        const document = await responseJson(response, "instance_discovery")
        const selected = new URL(document?.endpoints?.api_public)
        assert.equal(selected.protocol, "https:")
        assert.equal(selected.hostname, "api.fluxer.app")
        assert.equal(selected.port, "")
        assert.equal(selected.username, "")
        assert.equal(selected.password, "")
        assert.equal(selected.pathname, "/")
        assert.equal(selected.search, "")
        assert.equal(selected.hash, "")
        assert.equal(selected.href, new URL(apiBase).href)
    } catch (error) {
        if (error instanceof HarnessFailure) throw error
        throw new HarnessFailure("instance_discovery")
    }
}

function openCallbackListener(state) {
    return new Promise((resolve, reject) => {
        let settled = false
        let accept
        let fail
        const callback = new Promise((callbackResolve, callbackReject) => {
            accept = callbackResolve
            fail = callbackReject
        })
        const rejectCallback = (error) => {
            if (settled) return
            settled = true
            fail(error)
        }
        const server = createServer((request, response) => {
            const finish = (status, body) => {
                response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })
                response.end(body)
            }
            if (request.method !== "GET") {
                finish(405, "OAuth callback rejected")
                return
            }
            let url
            try {
                url = new URL(request.url ?? "/", redirectUri)
            } catch {
                finish(400, "OAuth callback rejected")
                return
            }
            if (url.pathname !== callbackPath || settled) {
                finish(400, "OAuth callback rejected")
                return
            }
            const states = url.searchParams.getAll("state")
            const callbackState = states[0]
            const codes = url.searchParams.getAll("code")
            const code = codes[0]
            const providerError = url.searchParams.get("error")
            if (states.length !== 1 || !callbackState || !safeEqual(state, callbackState)) {
                finish(400, "OAuth callback rejected")
                return
            }
            if (providerError !== null) {
                settled = true
                finish(400, "OAuth authorization was not completed")
                fail(new HarnessFailure("authorization_redirect"))
                return
            }
            if (codes.length !== 1 || !code) {
                finish(400, "OAuth callback rejected")
                return
            }
            settled = true
            finish(200, "OAuth authorization received. You can close this window")
            accept(code)
        })
        server.requestTimeout = 15_000
        server.headersTimeout = 15_000
        server.listen(3000, "localhost", () => resolve({ server, callback, cancel: rejectCallback }))
        server.once("error", () => reject(new HarnessFailure("callback_listener")))
    })
}

async function closeServer(server) {
    if (!server) return
    await new Promise((resolve) => server.close(() => resolve()))
}

let lock
let server
let client
let scope
let stage = "configuration"
let currentTokens
const issuedPairs = []
let operation
let verifyToken
let tokenMutationUncertain = false
let accessRevoked = false
let accessRevocationConfirmed = false
let refreshRevocationConfirmed = false
const cleanup = {
    accessRevocationAttempted: false,
    refreshRevocationAttempted: false,
    callbackClosed: false,
    sdkClosed: false,
}
const deadlineAt = Date.now() + 300_000

try {
    assert.ok((mode === "default" || mode === "effect") && process.argv.length === (noConsent ? 4 : 3))
    const env = parseEnv(readFileSync(environment, "utf8"))
    const clientId = env.FLUXER_TEST_APPLICATION_ID
    const botToken = env.FLUXER_TEST_BOT_TOKEN
    const clientSecret = env.FLUXER_TEST_CLIENT_SECRET
    const configuredRedirect = env.FLUXER_TEST_OAUTH_REDIRECT_URI
    assert.match(clientId ?? "", /^\d+$/)
    assert.match(env.FLUXER_TEST_GUILD_ID ?? "", /^\d+$/)
    assert.ok(botToken && botToken === botToken.trim())
    assert.ok(clientSecret && clientSecret === clientSecret.trim())
    assert.equal(configuredRedirect, redirectUri)
    verifyToken = async (token, active) => {
        const response = await fetch(`${apiBase}/oauth2/introspect`, {
            method: "POST",
            headers: {
                Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
                "content-type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ token }).toString(),
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
        })
        const result = await responseJson(response, "token_introspection")
        assert.equal(result.active, active)
        if (active) assert.equal(result.client_id, clientId)
    }

    lock = openSync(lockPath, "wx")
    writeSync(lock, String(process.pid))
    stage = "sandbox_identity"
    const application = await botGet("/applications/@me", botToken, "application_identity")
    const bot = await botGet("/users/@me", botToken, "bot_identity")
    const guild = await botGet(`/guilds/${env.FLUXER_TEST_GUILD_ID}`, botToken, "guild_identity")
    assert.equal(application.id, clientId)
    assert.equal(application.bot?.id, bot.id)
    assert.equal(bot.bot, true)
    assert.equal(guild.id, env.FLUXER_TEST_GUILD_ID)
    assert.ok(Array.isArray(application.redirect_uris))
    assert.ok(application.redirect_uris.includes(redirectUri))
    report(stage, { passed: true, redirectRegistered: true })
    stage = "instance_discovery"
    await discoverHostedApi()
    report(stage, { passed: true, independentApiTrusted: true })

    const sdk = await import(mode === "default" ? "@neontechspace/fluxerly" : "@neontechspace/fluxerly/effect")
    operation = async (value) => {
        if (mode === "effect") return Effect.runPromise(value.pipe(Effect.provideService(Scope.Scope, scope)))
        const result = await value
        if (result.isErr()) throw result.error
        return result.value
    }
    if (mode === "default") {
        const created = sdk.oauth.create({ clientId, clientSecret })
        if (created.isErr()) throw created.error
        client = created.value
    } else {
        scope = Scope.makeUnsafe()
        client = await operation(sdk.oauth.create({ clientId, clientSecret }))
    }
    if (noConsent) {
        const pkce = sdk.oauth.createPkce()
        const state = randomBytes(32).toString("base64url")
        stage = "combined_authorization_url"
        const authorizationUrl = await operation(
            client.authorizationUrl(
                {
                    redirectUri,
                    scopes: [sdk.OAuthScopes.Identify, sdk.OAuthScopes.Bot],
                    state,
                    codeChallenge: pkce.challenge,
                    guildId: env.FLUXER_TEST_GUILD_ID,
                    permissions: 0n,
                    disableGuildSelect: true,
                },
                { timeoutMs: 15_000 },
            ),
        )
        const url = new URL(authorizationUrl)
        assert.equal(url.searchParams.get("client_id"), clientId)
        assert.equal(url.searchParams.get("state"), state)
        assert.equal(url.searchParams.get("code_challenge"), pkce.challenge)
        assert.equal(url.searchParams.get("scope"), "identify bot")
        assert.equal(url.searchParams.get("response_type"), "code")
        assert.equal(url.searchParams.get("guild_id"), env.FLUXER_TEST_GUILD_ID)
        assert.equal(url.searchParams.get("permissions"), "0")
        assert.equal(url.searchParams.get("disable_guild_select"), "true")
        assert.equal(url.searchParams.has("client_secret"), false)
        assert.equal(url.searchParams.has("code_verifier"), false)
        report(stage, { passed: true, navigated: false, codeGrantRequested: true })

        const invalidToken = randomBytes(32).toString("base64url")
        stage = "inactive_introspection"
        const sdkIntrospection = await operation(client.introspect(invalidToken, { timeoutMs: 15_000 }))
        assert.deepEqual(sdkIntrospection, { active: false })
        await verifyToken(invalidToken, false)
        report(stage, { passed: true, independentlyConfirmed: true })

        stage = "invalid_bearer_connections"
        let rejected = false
        try {
            await operation(client.fetchConnections(randomBytes(32).toString("base64url"), { timeoutMs: 15_000 }))
        } catch (error) {
            assert.equal(error?._tag, "OAuthOperationError")
            assert.equal(error?.reason, "rejected")
            rejected = true
        }
        assert.equal(rejected, true)
        assert.deepEqual(await operation(client.introspect(invalidToken, { timeoutMs: 15_000 })), { active: false })
        report(stage, { passed: true, clientRemainedUsable: true })
    } else {
        const pkce = sdk.oauth.createPkce()
        const state = randomBytes(32).toString("base64url")
        stage = "callback_listener"
        const listener = await openCallbackListener(state)
        server = listener.server
        stage = "authorization_url"
        const authorizationUrl = await operation(
            client.authorizationUrl(
                {
                    redirectUri,
                    scopes: [sdk.OAuthScopes.Identify, sdk.OAuthScopes.Guilds],
                    state,
                    codeChallenge: pkce.challenge,
                },
                { timeoutMs: 15_000 },
            ),
        )
        const url = new URL(authorizationUrl)
        assert.equal(url.searchParams.get("client_id"), clientId)
        assert.equal(url.searchParams.get("state"), state)
        assert.equal(url.searchParams.get("code_challenge"), pkce.challenge)
        assert.equal(url.searchParams.get("scope"), "identify guilds")
        assert.equal(url.searchParams.has("client_secret"), false)
        assert.equal(url.searchParams.has("code_verifier"), false)
        report(stage, { passed: true, authorizationUrl })

        stage = "awaiting_consent"
        const remainingConsentMs = deadlineAt - Date.now()
        assert.ok(remainingConsentMs > 0)
        report(stage, { passed: true, consentWaitSeconds: Math.floor(remainingConsentMs / 1_000) })
        const consentTimer = setTimeout(
            () => listener.cancel(new HarnessFailure("awaiting_consent", { reason: "deadline" })),
            remainingConsentMs,
        )
        let code
        try {
            code = await listener.callback
        } finally {
            clearTimeout(consentTimer)
        }
        stage = "exchange_code"
        try {
            currentTokens = await operation(
                client.exchangeCode({ code, redirectUri, codeVerifier: pkce.verifier }, { timeoutMs: 15_000 }),
            )
            issuedPairs.push(currentTokens)
        } catch (error) {
            tokenMutationUncertain = hasUnknownOAuthFailure(error)
            throw error
        }
        report(stage, { passed: true })
        await verifyToken(currentTokens.accessToken, true)
        await verifyToken(currentTokens.refreshToken, true)

        stage = "sdk_bearer_reads"
        const identity = await operation(client.fetchIdentity(currentTokens.accessToken, { timeoutMs: 15_000 }))
        const guilds = await operation(
            client.fetchGuilds(currentTokens.accessToken, { limit: 200 }, { timeoutMs: 15_000 }),
        )
        assert.match(identity.id, /^\d+$/)
        assert.ok(Array.isArray(guilds))
        report(stage, { passed: true, guildCount: guilds.length })

        stage = "independent_bearer_reads"
        const rawIdentity = await bearerGet("/oauth2/userinfo", currentTokens.accessToken, "userinfo_read")
        const rawGuilds = await bearerGet(
            "/users/@me/guilds?limit=200&with_counts=false",
            currentTokens.accessToken,
            "guilds_read",
        )
        assert.equal(rawIdentity.id, identity.id)
        assert.ok(Array.isArray(rawGuilds))
        assert.deepEqual(
            rawGuilds.map((guild) => guild.id),
            guilds.map((guild) => guild.id),
        )
        report(stage, { passed: true, identityMatches: true, guildCount: rawGuilds.length })

        stage = "refresh_rotation"
        const previousTokens = currentTokens
        try {
            currentTokens = await operation(client.refresh(currentTokens.refreshToken, { timeoutMs: 15_000 }))
            issuedPairs.push(currentTokens)
        } catch (error) {
            tokenMutationUncertain = hasUnknownOAuthFailure(error)
            throw error
        }
        assert.notEqual(currentTokens.accessToken, previousTokens.accessToken)
        assert.notEqual(currentTokens.refreshToken, previousTokens.refreshToken)
        await verifyToken(previousTokens.refreshToken, false)
        await verifyToken(currentTokens.accessToken, true)
        await verifyToken(currentTokens.refreshToken, true)
        const refreshedIdentity = await operation(
            client.fetchIdentity(currentTokens.accessToken, { timeoutMs: 15_000 }),
        )
        assert.equal(refreshedIdentity.id, identity.id)
        report(stage, { passed: true, identityMatches: true })

        stage = "access_revocation"
        cleanup.accessRevocationAttempted = true
        await operation(
            client.revoke({ token: currentTokens.accessToken, tokenTypeHint: "access_token" }, { timeoutMs: 15_000 }),
        )
        accessRevoked = true
        await verifyRevokedIdentity(currentTokens.accessToken)
        accessRevocationConfirmed = true
        report(stage, { passed: true, revokedIdentityRejected: true })
    }
} catch (error) {
    report(error instanceof HarnessFailure ? error.check : stage, {
        passed: false,
        ...(error instanceof HarnessFailure ? error.details : {}),
        category: error?._tag ?? "check",
    })
    process.exitCode = 1
} finally {
    const revocationResults = []
    for (const pair of issuedPairs) {
        const confirmed = { access: false, refresh: false }
        revocationResults.push(confirmed)
        try {
            cleanup.accessRevocationAttempted = true
            await operation(
                client.revoke({ token: pair.accessToken, tokenTypeHint: "access_token" }, { timeoutMs: 15_000 }),
            )
            await verifyRevokedIdentity(pair.accessToken)
            await verifyToken(pair.accessToken, false)
            confirmed.access = true
        } catch (error) {
            tokenMutationUncertain ||= hasUnknownOAuthFailure(error)
            process.exitCode = 1
        }
        try {
            cleanup.refreshRevocationAttempted = true
            await operation(
                client.revoke({ token: pair.refreshToken, tokenTypeHint: "refresh_token" }, { timeoutMs: 15_000 }),
            )
            await verifyToken(pair.refreshToken, false)
            confirmed.refresh = true
        } catch (error) {
            tokenMutationUncertain ||= hasUnknownOAuthFailure(error)
            process.exitCode = 1
        }
    }
    accessRevocationConfirmed = revocationResults.length > 0 && revocationResults.every((result) => result.access)
    refreshRevocationConfirmed = revocationResults.length > 0 && revocationResults.every((result) => result.refresh)
    try {
        await closeServer(server)
        cleanup.callbackClosed = true
    } catch {
        process.exitCode = 1
    }
    try {
        if (client) {
            const shutdown = client.shutdown()
            if (mode === "effect") await Effect.runPromise(shutdown.pipe(Effect.provideService(Scope.Scope, scope)))
            else await shutdown
            cleanup.sdkClosed = true
        }
    } catch {
        process.exitCode = 1
    }
    try {
        if (scope) await Effect.runPromise(Scope.close(scope, Exit.void))
    } catch {
        process.exitCode = 1
    }
    verifyToken = undefined
    if (lock !== undefined) {
        closeSync(lock)
        unlinkSync(lockPath)
    }
    const manualConsentRevokeRequired =
        tokenMutationUncertain ||
        (currentTokens !== undefined && (!accessRevocationConfirmed || !refreshRevocationConfirmed))
    report("cleanup", {
        passed: process.exitCode !== 1,
        ...cleanup,
        accessRevoked,
        accessRevocationConfirmed,
        refreshRevocationConfirmed,
        tokenMutationUncertain,
    })
    if (manualConsentRevokeRequired) report("manual_consent_revoke", { required: true })
}
