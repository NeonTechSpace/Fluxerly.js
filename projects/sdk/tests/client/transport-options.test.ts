import { once } from "node:events"
import { readFileSync } from "node:fs"
import type { IncomingMessage } from "node:http"
import { Effect } from "effect"
import { afterEach, expect, test, vi } from "vitest"
import { WebSocket, WebSocketServer } from "ws"
import { createWebhookClient, oauth, type Client, type WebSocketOptions } from "../../src/index.js"
import {
    createWebhookClient as createNativeWebhook,
    oauth as nativeOAuth,
    type Client as NativeClient,
} from "../../src/effect.js"
import { defaultSocketFactory } from "../../src/internal/transport/index.js"
import { describeBothApis, fixtureToken, modes, setup, type Mode } from "../support/both-apis.js"
import { driveSdkTime, sdkClock } from "../support/client-clock.js"
import { creationField } from "../support/client-creation.js"
import { hostedDiscoveryDocument, stubFetchWithHostedDiscovery } from "../support/hosted-discovery.js"
import { startInstance } from "../support/instance.js"
import { expectErr, settle } from "../support/settle.js"

const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string
    homepage: string
}
/** The documented default: product token, SDK version and homepage from the package manifest */
const defaultAgent = `Fluxerly.js/${manifest.version} (+${manifest.homepage})`
const discoveryUrl = "https://fluxer.app/.well-known/fluxer"

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

const userAgentOf = (init: RequestInit) => new Headers(init.headers).get("user-agent")

test.each(modes)("%s validates the transport option at creation", async (mode) => {
    const fetch = vi.fn()
    const cases: [unknown, string | undefined][] = [
        [null, "transport"],
        ["fetch", "transport"],
        [{ agent: "x" }, "transport"],
        [{ fetch: "https://proxy.example.test" }, "fetch"],
        [{ webSocket: {} }, "webSocket"],
        [{ userAgent: "" }, "userAgent"],
        [{ userAgent: " Bot/1.0" }, "userAgent"],
        [{ userAgent: "Bot/1.0 " }, "userAgent"],
        [{ userAgent: "Bot/1.0\r\nX-Injected: 1" }, "userAgent"],
        [{ userAgent: "Bot/1.0 é" }, "userAgent"],
        [{ userAgent: "a".repeat(513) }, "userAgent"],
        [{ userAgent: 1 }, "userAgent"],
        [{}, undefined],
        [{ userAgent: "a".repeat(512), fetch, webSocket: () => undefined }, undefined],
    ]
    for (const [transport, field] of cases)
        expect([transport, await creationField(mode, { transport })]).toEqual([transport, field])
    // Validation starts no network work
    expect(fetch).not.toHaveBeenCalled()
})

function restRequest(mode: Mode, client: Client | NativeClient) {
    return mode === "default"
        ? (client as Client).rest.request({ method: "GET", path: "/users/@me" })
        : (client as NativeClient).rest.request({ method: "GET", path: "/users/@me" })
}

describeBothApis("transport option", (mode) => {
    test("sends discovery and REST through a custom fetch with the default User-Agent", async () => {
        const platform = vi.fn(() => Promise.reject(new Error("The platform fetch must not be used")))
        vi.stubGlobal("fetch", platform)
        const seen: { url: string; userAgent: string | null; authorization: string | null }[] = []
        const client = await setup(mode, {
            transport: {
                fetch: async (url, init) => {
                    const headers = new Headers(init.headers)
                    seen.push({
                        url,
                        userAgent: headers.get("user-agent"),
                        authorization: headers.get("authorization"),
                    })
                    return url === discoveryUrl ? Response.json(hostedDiscoveryDocument) : Response.json({ id: "1" })
                },
            },
        })
        expect((await settle(restRequest(mode, client))).body).toEqual({ id: "1" })
        expect(seen).toEqual([
            { url: discoveryUrl, userAgent: defaultAgent, authorization: null },
            {
                url: "https://api.fluxer.app/v1/users/@me",
                userAgent: defaultAgent,
                authorization: `Bot ${fixtureToken}`,
            },
        ])
        expect(platform).not.toHaveBeenCalled()
    })

    test("sends a token pasted with surrounding quotes and whitespace as the bare token", async () => {
        const authorization: (string | null)[] = []
        const client = await setup(mode, {
            token: ` "${fixtureToken}"
`,
            transport: {
                fetch: async (url, init) => {
                    if (url === discoveryUrl) return Response.json(hostedDiscoveryDocument)
                    authorization.push(new Headers(init.headers).get("authorization"))
                    return Response.json({ id: "1" })
                },
            },
        })
        await settle(restRequest(mode, client))
        expect(authorization).toEqual([`Bot ${fixtureToken}`])
    })

    test("replaces the default User-Agent with the configured value on the platform fetch", async () => {
        const agents: (string | null)[] = []
        const fetch = stubFetchWithHostedDiscovery(() => Response.json({}))
        const client = await setup(mode, { transport: { userAgent: "ExampleBot/2.0 (+https://example.test)" } })
        await settle(restRequest(mode, client))
        for (const [, init] of fetch.mock.calls) agents.push(userAgentOf(init ?? {}))
        expect(agents).toEqual(["ExampleBot/2.0 (+https://example.test)", "ExampleBot/2.0 (+https://example.test)"])
    })

    test("a throwing custom fetch fails the request as a network failure", async () => {
        const clock = sdkClock()
        const client = await setup(mode, {
            transport: {
                fetch: (url) => {
                    if (url === discoveryUrl) return Promise.resolve(Response.json(hostedDiscoveryDocument))
                    throw new TypeError("fixture transport failure")
                },
            },
        })
        expect(await driveSdkTime(clock, expectErr(restRequest(mode, client)))).toMatchObject({
            _tag: "RestRequestError",
            reason: "network",
        })
    })

    test("sends the default User-Agent over real HTTP and the gateway handshake, and opens sockets through webSocket", async () => {
        const fixture = await startInstance()
        const handshakes: (string | undefined)[] = []
        fixture.rest.server.on("upgrade", (request: IncomingMessage) => handshakes.push(request.headers["user-agent"]))
        const opened: { url: string; options: WebSocketOptions }[] = []
        const client = await setup(mode, {
            instance: { url: fixture.instance, allowInsecure: true },
            transport: {
                webSocket: (url, options) => {
                    opened.push({ url, options })
                    return new WebSocket(url, options)
                },
            },
        })
        await settle(client.connect())
        expect(fixture.rest.requests.map((request) => request.headers["user-agent"])).toEqual([defaultAgent])
        expect(opened).toHaveLength(1)
        expect(opened[0]!.url.startsWith(`${fixture.instance.replace("http:", "ws:")}/gateway`)).toBe(true)
        expect(opened[0]!.options).toEqual({
            perMessageDeflate: false,
            followRedirects: false,
            maxPayload: 104_857_600,
            headers: { "User-Agent": defaultAgent },
        })
        expect(handshakes).toEqual([defaultAgent])
    })
})

test("the default socket factory sends the SDK User-Agent in the WebSocket handshake", async () => {
    // A bare server rather than startGatewayServer, because only the factory's upgrade request is under test
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" })
    await once(server, "listening")
    const address = server.address() as { port: number }
    const handshake = new Promise<string | undefined>((resolve) =>
        server.once("connection", (_socket, request) => resolve(request.headers["user-agent"])),
    )
    const socket = defaultSocketFactory(`ws://127.0.0.1:${address.port}`, {
        perMessageDeflate: false,
        followRedirects: false,
        maxPayload: 1024,
    })
    try {
        expect(await handshake).toBe(defaultAgent)
        await once(socket as unknown as WebSocket, "open")
    } finally {
        socket.terminate()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
})

test.each(modes)("%s standalone webhook and OAuth clients send the default User-Agent", async (mode) => {
    const fetch = stubFetchWithHostedDiscovery((url) =>
        Promise.resolve(
            url.includes("/oauth2/")
                ? new Response(null, { status: 200 })
                : Response.json({ id: "10", type: 1, channel_id: "20", name: "hook", token: "fixture-hook-token" }),
        ),
    )
    const webhook = { id: "10", token: "fixture-hook-token" }
    const oauthConfig = { clientId: "123", clientSecret: "fixture-only-secret" }
    if (mode === "default") {
        const hook = createWebhookClient(webhook)
        await hook.fetch()
        await hook.shutdown()
        const client = oauth.create(oauthConfig)
        await client.revoke({ token: "fixture-access-token" })
        await client.shutdown()
    } else {
        await Effect.runPromise(
            Effect.scoped(
                Effect.gen(function* () {
                    const hook = yield* createNativeWebhook(webhook)
                    yield* Effect.exit(hook.fetch())
                    const client = yield* nativeOAuth.create(oauthConfig)
                    yield* Effect.exit(client.revoke({ token: "fixture-access-token" }))
                }),
            ),
        )
    }
    const calls = fetch.mock.calls.map(([url, init]) => ({ url: String(url), userAgent: userAgentOf(init ?? {}) }))
    expect(calls.some((call) => call.url.includes("/webhooks/10/"))).toBe(true)
    expect(calls.some((call) => call.url.includes("/oauth2/token/revoke"))).toBe(true)
    expect(calls.map((call) => call.userAgent)).toEqual(calls.map(() => defaultAgent))
})
