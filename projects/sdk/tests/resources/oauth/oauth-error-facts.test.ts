import { Effect, Exit, Scope } from "effect"
import { afterEach, expect, onTestFinished, test, vi } from "vitest"
import { errors, oauth } from "../../../src/index.js"
import { oauth as native } from "../../../src/effect.js"
import { modes } from "../../support/both-apis.js"
import { hostedDiscoveryDocument } from "../../support/hosted-discovery.js"
import { expectErr } from "../../support/settle.js"

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
