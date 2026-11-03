import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { errors, oauth, OAuthOperationError } from "../../../src/index.js"
import { oauth as native } from "../../../src/effect.js"
import { modes } from "../../support/both-apis.js"
import { hostedDiscoveryDocument } from "../../support/hosted-discovery.js"
import { expectErr, settle } from "../../support/settle.js"
import { captureLogs } from "../../support/log-capture.js"

afterEach(() => vi.unstubAllGlobals())

test.each(modes)("%s classifies OAuth read failures as retryable reads and keeps safe causes", async (mode) => {
    const source = Object.assign(new Error("Private transport URL and credential"), { code: "ECONNRESET" })
    const fetch = vi.fn(async (url: string) => {
        if (url.endsWith("/.well-known/fluxer")) return Response.json(hostedDiscoveryDocument)
        throw source
    })
    vi.stubGlobal("fetch", fetch)
    const scope = Scope.makeUnsafe()
    const config = { clientId: "1", clientSecret: "fixture-secret" }
    const client =
        mode === "default"
            ? oauth.create(config)
            : await Effect.runPromise(native.create(config).pipe(Scope.provide(scope)))
    onTestFinished(async () => {
        if (mode === "default") await (client as ReturnType<typeof oauth.create>).shutdown()
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    for (const operation of [
        client.fetchIdentity("fixture-access"),
        client.fetchGuilds("fixture-access"),
        client.fetchConnections("fixture-access"),
        client.introspect("fixture-access"),
    ]) {
        const error = await expectErr<unknown, unknown>(operation)
        expect(error).toMatchObject({ reason: "network", outcome: "unknown", details: { read: true } })
        expect(errors.isRetryable(error)).toBe(true)
        expect((error as Error).message).not.toMatch(/change.*applied/i)
        expect(error).toMatchObject({ cause: { code: "ECONNRESET" } })
        expect(JSON.stringify(error)).not.toContain("Private transport")
        expect((error as Error).cause).not.toHaveProperty("cause")
    }
    for (const operation of [
        client.exchangeCode({
            code: "fixture-code",
            redirectUri: "https://example.com/callback",
            codeVerifier: "a".repeat(43),
        }),
        client.refresh("fixture-refresh"),
        client.revoke({ token: "fixture-access" }),
    ]) {
        const error = await expectErr<unknown, unknown>(operation)
        expect(error).toMatchObject({ reason: "network", outcome: "unknown", cause: { code: "ECONNRESET" } })
        expect(errors.isRetryable(error)).toBe(false)
        expect((error as { details: object }).details).not.toHaveProperty("read", true)
    }
})

test.each(modes)("%s preserves the sanitized discovery cause for OAuth failures", async (mode) => {
    vi.stubGlobal("fetch", async () => {
        throw Object.assign(new Error("Private discovery URL"), { code: "ECONNRESET" })
    })
    const scope = Scope.makeUnsafe()
    const config = { clientId: "1", clientSecret: "fixture-secret" }
    const client =
        mode === "default"
            ? oauth.create(config)
            : await Effect.runPromise(native.create(config).pipe(Scope.provide(scope)))
    onTestFinished(async () => {
        if (mode === "default") await (client as ReturnType<typeof oauth.create>).shutdown()
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    const error = await expectErr(client.fetchIdentity("fixture-access"))
    expect(error).toMatchObject({ reason: "network", outcome: "notDispatched", cause: { code: "ECONNRESET" } })
    expect(JSON.stringify(error)).not.toContain("Private discovery")
})

// REST names the field of a malformed answer, and the codes page promises the same for every reason response
test.each(modes)("%s names the failing field of a malformed OAuth answer without its value", async (mode) => {
    vi.stubGlobal("fetch", async (url: string) => {
        if (url.endsWith("/.well-known/fluxer")) return Response.json(hostedDiscoveryDocument)
        return Response.json({
            access_token: "fixture-private-access",
            refresh_token: "fixture-private-refresh",
            token_type: "Bearer",
            scope: "identify",
            expires_in: "604800",
        })
    })
    const scope = Scope.makeUnsafe()
    const config = { clientId: "1", clientSecret: "fixture-secret" }
    const client =
        mode === "default"
            ? oauth.create(config)
            : await Effect.runPromise(native.create(config).pipe(Scope.provide(scope)))
    onTestFinished(async () => {
        if (mode === "default") await (client as ReturnType<typeof oauth.create>).shutdown()
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    const error = await expectErr<unknown, unknown>(client.refresh("fixture-refresh"))
    expect(error).toMatchObject({ reason: "response", status: 200, details: { responseField: "expires_in" } })
    expect((error as Error).message).toContain("expires_in")
    expect(JSON.stringify(error)).not.toContain("fixture-private")
    expect(JSON.stringify(error)).not.toContain("604800")
})

// The logging guide says Debug shows every REST request, and OAuth clients take the same logging option
test.each(modes)("%s logs one Debug request record per OAuth request without credentials or bodies", async (mode) => {
    vi.stubGlobal("fetch", async (url: string) => {
        if (url.endsWith("/.well-known/fluxer")) return Response.json(hostedDiscoveryDocument)
        if (url.includes("/oauth2/token"))
            return Response.json({ error: "invalid_grant", error_description: "fixture-private-text" }, { status: 400 })
        return Response.json([])
    })
    const logs = captureLogs()
    const scope = Scope.makeUnsafe()
    const config = {
        clientId: "1",
        clientSecret: "fixture-secret",
        logging: { ...logs.logging, level: "debug" as const },
    }
    const client =
        mode === "default"
            ? oauth.create(config)
            : await Effect.runPromise(native.create(config).pipe(Scope.provide(scope)))
    onTestFinished(async () => {
        if (mode === "default") await (client as ReturnType<typeof oauth.create>).shutdown()
        await Effect.runPromise(Scope.close(scope, Exit.void))
    })
    const run = (operation: unknown) =>
        mode === "default" ? settle(operation as never) : Effect.runPromise(operation as never)
    await run(client.fetchGuilds("fixture-private-access", { limit: 5 }))
    await expectErr(client.refresh("fixture-private-refresh"))
    const records = logs.withCode("rest.request")
    expect(records.map((record) => [record.level, record.route, record.status, record.fields?.method])).toEqual([
        ["debug", "/users/@me/guilds", 200, "GET"],
        ["debug", "/oauth2/token", 400, "POST"],
    ])
    for (const record of records) expect(record.durationMs).toBeGreaterThanOrEqual(0)
    const text = JSON.stringify(logs.records)
    for (const secret of ["fixture-private", "fixture-secret", "limit=5", "Bearer", "Basic"])
        expect(text).not.toContain(secret)
})

// Fluxer answers invalid_grant when the PKCE verifier is missing or does not match the challenge
test("the invalid_grant hint names the PKCE verifier for a code exchange", () => {
    const error = new OAuthOperationError({
        operation: "oauth.exchangeCode",
        reason: "rejected",
        outcome: "rejected",
        status: 400,
        oauthError: "invalid_grant",
    })
    expect(error.hint).toContain("codeVerifier")
    expect(error.hint).toContain("codeChallenge")
})
