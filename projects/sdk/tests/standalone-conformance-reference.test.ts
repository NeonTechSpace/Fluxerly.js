import { createRequire } from "node:module"
import { Effect, Exit, Scope } from "effect"
import type { ResultAsync } from "neverthrow"
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest"
import { createClient, createWebhookClient, oauth } from "../src/index.js"
import {
    createClient as createNativeClient,
    createWebhookClient as createNativeWebhookClient,
    oauth as nativeOauth,
} from "../src/effect.js"

const require = createRequire(import.meta.url)
const cases = require("./standalone-conformance-reference-cases.json") as Readonly<{
    discovery: {
        url: string
        api: string
        gateway: string
        media: string
        staticCdn: string
        webapp: string
        invite: string
    }
    oauth: {
        clientId: string
        clientSecret: string
        invalidOpaqueToken: string
        accessToken: string
        exchange: { code: string; redirectUri: string; codeVerifier: string }
        tokenResponse: Record<string, unknown>
        identityResponse: Record<string, unknown>
        tokenRequest: {
            method: string
            path: string
            contentType: string
            authorizationScheme: string
            body: Record<string, string>
        }
        identityRequest: { method: string; path: string; authorization: string }
    }
    webhook: {
        id: string
        token: string
        sendInput: { content: string; embeds: readonly [] }
        messageResponse: Record<string, unknown>
        request: {
            method: string
            path: string
            query: string
            authorization: null
            body: Record<string, unknown>
        }
        rejection: {
            status: number
            providerCode: string
            privateMessage: string
            reason: string
            outcome: string
            apiCode: string
        }
    }
    clientLifecycle: { token: string; activeUserId: string; closedUserId: string }
}>

type Mode = "default" | "native"

function discoveryResponse() {
    return Response.json({
        api_code_version: 1,
        endpoints: {
            api_public: cases.discovery.api,
            gateway: cases.discovery.gateway,
            media: cases.discovery.media,
            static_cdn: cases.discovery.staticCdn,
            webapp: cases.discovery.webapp,
            invite: cases.discovery.invite,
        },
        features: { presigned_attachment_uploads: true },
    })
}

function requestUrl(input: RequestInfo | URL): URL {
    return new URL(typeof input === "string" || input instanceof URL ? input : input.url)
}

async function settle<A>(value: ResultAsync<A, unknown> | Effect.Effect<A, unknown>): Promise<A> {
    if (Effect.isEffect(value)) return Effect.runPromise(value)
    const result = await value
    if (result.isErr()) throw result.error
    return result.value
}

async function failure<A>(value: ResultAsync<A, unknown> | Effect.Effect<A, unknown>): Promise<unknown> {
    if (Effect.isEffect(value)) return Effect.runPromise(Effect.flip(value))
    const result = await value
    if (result.isOk()) throw new Error("Expected the reference operation to fail")
    return result.error
}

async function oauthFixture(mode: Mode) {
    const config = { clientId: cases.oauth.clientId, clientSecret: cases.oauth.clientSecret }
    if (mode === "default") {
        const client = oauth.create(config)._unsafeUnwrap()
        return {
            exchangeCode: () => settle(client.exchangeCode(cases.oauth.exchange)),
            fetchIdentity: () => settle(client.fetchIdentity(cases.oauth.accessToken)),
            rejectInvalidToken: () => failure(client.introspect(cases.oauth.invalidOpaqueToken)),
            close: async () => void (await settle(client.shutdown())),
        }
    }
    const scope = Scope.makeUnsafe()
    const client = await Effect.runPromise(nativeOauth.create(config).pipe(Scope.provide(scope)))
    return {
        exchangeCode: () => settle(client.exchangeCode(cases.oauth.exchange)),
        fetchIdentity: () => settle(client.fetchIdentity(cases.oauth.accessToken)),
        rejectInvalidToken: () => failure(client.introspect(cases.oauth.invalidOpaqueToken)),
        close: async () => {
            await settle(client.shutdown())
            await Effect.runPromise(Scope.close(scope, Exit.void))
        },
    }
}

async function webhookFixture(mode: Mode) {
    const options = { id: cases.webhook.id, token: cases.webhook.token }
    if (mode === "default") {
        const client = createWebhookClient(options)._unsafeUnwrap()
        return {
            send: () => settle(client.send(cases.webhook.sendInput)),
            sendFailure: () => failure(client.send(cases.webhook.sendInput)),
            close: async () => void (await settle(client.shutdown())),
        }
    }
    const scope = Scope.makeUnsafe()
    const client = await Effect.runPromise(createNativeWebhookClient(options).pipe(Scope.provide(scope)))
    return {
        send: () => settle(client.send(cases.webhook.sendInput)),
        sendFailure: () => failure(client.send(cases.webhook.sendInput)),
        close: async () => {
            await settle(client.shutdown())
            await Effect.runPromise(Scope.close(scope, Exit.void))
        },
    }
}

async function clientFixture(mode: Mode) {
    const options = { token: cases.clientLifecycle.token }
    if (mode === "default") {
        const client = createClient(options)._unsafeUnwrap()
        return {
            fetchUserFailure: (id: string) => failure(client.users.fetch(id)),
            connectFailure: () => failure(client.connect()),
            shutdown: () => settle(client.shutdown()),
            waitForClose: () => settle(client.waitForClose()),
            state: () => client.state,
            dispose: async () => void (await settle(client.shutdown())),
        }
    }
    const scope = Scope.makeUnsafe()
    const client = await Effect.runPromise(createNativeClient(options).pipe(Scope.provide(scope)))
    return {
        fetchUserFailure: (id: string) => failure(client.users.fetch(id)),
        connectFailure: () => failure(client.connect()),
        shutdown: () => settle(client.shutdown()),
        waitForClose: () => settle(client.waitForClose()),
        state: () => client.state,
        dispose: async () => void (await Effect.runPromise(Scope.close(scope, Exit.void))),
    }
}

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe.each(["default", "native"] as const)("%s standalone and lifecycle conformance reference", (mode) => {
    test("separates OAuth Basic form exchange from Bearer identity and rejects invalid opaque tokens locally", async () => {
        const requests: Array<{ url: URL; init: RequestInit }> = []
        let fetchCalls = 0
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
                fetchCalls += 1
                const url = requestUrl(input)
                if (url.href === cases.discovery.url) return discoveryResponse()
                requests.push({ url, init })
                if (url.pathname === cases.oauth.tokenRequest.path) return Response.json(cases.oauth.tokenResponse)
                if (url.pathname === cases.oauth.identityRequest.path)
                    return Response.json(cases.oauth.identityResponse)
                throw new Error(`Unexpected OAuth reference request: ${url.pathname}`)
            }),
        )
        const client = await oauthFixture(mode)
        expect(fetchCalls).toBe(0)
        expect(requests).toHaveLength(0)
        try {
            expect(await client.rejectInvalidToken()).toMatchObject({
                _tag: "OAuthOperationError",
                reason: "input",
                outcome: "notDispatched",
            })
            expect(fetchCalls).toBe(0)
            expect(requests).toHaveLength(0)

            const tokens = await client.exchangeCode()
            expect(tokens).toMatchObject({
                accessToken: cases.oauth.tokenResponse.access_token,
                refreshToken: cases.oauth.tokenResponse.refresh_token,
                scopes: ["identify"],
            })
            const identity = await client.fetchIdentity()
            expect(identity).toMatchObject({ id: cases.oauth.identityResponse.id, globalName: null, avatar: null })
        } finally {
            await client.close()
        }

        expect(requests).toHaveLength(2)
        const tokenRequest = requests[0]!
        const tokenHeaders = new Headers(tokenRequest.init.headers)
        expect({
            method: tokenRequest.init.method,
            path: tokenRequest.url.pathname,
            contentType: tokenHeaders.get("content-type"),
            authorizationScheme: tokenHeaders.get("authorization")?.split(" ", 1)[0],
            body: Object.fromEntries(new URLSearchParams(String(tokenRequest.init.body))),
        }).toEqual(cases.oauth.tokenRequest)
        expect(tokenHeaders.get("authorization")).toBe(
            `Basic ${Buffer.from(`${cases.oauth.clientId}:${cases.oauth.clientSecret}`).toString("base64")}`,
        )
        const identityRequest = requests[1]!
        expect({
            method: identityRequest.init.method,
            path: identityRequest.url.pathname,
            authorization: new Headers(identityRequest.init.headers).get("authorization"),
        }).toEqual(cases.oauth.identityRequest)
    })

    test("uses the token webhook route without Authorization and maps null, empty, and rejected responses", async () => {
        const requests: Array<{ url: URL; init: RequestInit }> = []
        let fetchCalls = 0
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
                fetchCalls += 1
                const url = requestUrl(input)
                if (url.href === cases.discovery.url) return discoveryResponse()
                requests.push({ url, init })
                if (requests.length === 1) return Response.json(cases.webhook.messageResponse)
                return Response.json(
                    {
                        code: cases.webhook.rejection.providerCode,
                        message: cases.webhook.rejection.privateMessage,
                    },
                    { status: cases.webhook.rejection.status },
                )
            }),
        )
        const client = await webhookFixture(mode)
        expect(fetchCalls).toBe(0)
        expect(requests).toHaveLength(0)
        try {
            const message = await client.send()
            expect(message).toMatchObject({
                id: cases.webhook.messageResponse.id,
                content: "",
                embeds: [],
                attachments: [],
                stickers: [],
            })
            const rejected = await client.sendFailure()
            expect(rejected).toMatchObject({
                _tag: "WebhookOperationError",
                status: cases.webhook.rejection.status,
                reason: cases.webhook.rejection.reason,
                outcome: cases.webhook.rejection.outcome,
                apiError: { code: cases.webhook.rejection.apiCode },
            })
            expect(JSON.stringify(rejected)).not.toContain(cases.webhook.rejection.privateMessage)
        } finally {
            await client.close()
        }

        expect(requests).toHaveLength(2)
        for (const { url, init } of requests) {
            expect({
                method: init.method,
                path: url.pathname,
                query: url.search,
                authorization: new Headers(init.headers).get("authorization"),
                body: JSON.parse(String(init.body)),
            }).toEqual(cases.webhook.request)
        }
    })

    test("creates without I/O and makes repeated shutdown wait for cleanup before rejecting later work", async () => {
        let releaseCleanup!: () => void
        const cleanup = new Promise<void>((resolve) => (releaseCleanup = resolve))
        let markStarted!: () => void
        const started = new Promise<void>((resolve) => (markStarted = resolve))
        let markAborted!: () => void
        const aborted = new Promise<void>((resolve) => (markAborted = resolve))
        let fetchCalls = 0
        let operationDispatches = 0
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
                fetchCalls += 1
                const url = requestUrl(input)
                if (url.href === cases.discovery.url) return discoveryResponse()
                operationDispatches += 1
                markStarted()
                await new Promise<void>((resolve) => {
                    if (init.signal?.aborted) resolve()
                    else init.signal?.addEventListener("abort", () => resolve(), { once: true })
                })
                markAborted()
                await cleanup
                throw init.signal?.reason ?? new Error("Reference request was aborted")
            }),
        )
        const client = await clientFixture(mode)
        let disposed = false
        const dispose = async () => {
            if (disposed) return
            disposed = true
            releaseCleanup()
            await client.dispose()
        }
        onTestFinished(dispose)
        expect(fetchCalls).toBe(0)
        expect(operationDispatches).toBe(0)
        try {
            const active = client.fetchUserFailure(cases.clientLifecycle.activeUserId)
            await started
            let completedShutdowns = 0
            const shutdowns = [client.shutdown(), client.shutdown()].map((shutdown) =>
                shutdown.then(() => {
                    completedShutdowns += 1
                }),
            )
            await aborted
            await Promise.resolve()
            expect(completedShutdowns).toBe(0)
            releaseCleanup()
            await Promise.all(shutdowns)
            expect(await active).toMatchObject({ _tag: "ClientClosedError" })
            expect(client.state()).toBe("Closed")
            await client.waitForClose()

            const fetchesBeforeClosedCalls = fetchCalls
            expect(await client.fetchUserFailure(cases.clientLifecycle.closedUserId)).toMatchObject({
                _tag: "ClientClosedError",
            })
            expect(await client.connectFailure()).toMatchObject({ _tag: "ClientClosedError" })
            expect(fetchCalls).toBe(fetchesBeforeClosedCalls)
        } finally {
            await dispose()
        }
    })
})
