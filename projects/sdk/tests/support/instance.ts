import { expect, onTestFinished } from "vitest"
import { startGatewayServer, type GatewayServerOptions } from "./gateway-server.js"
import { stubFetchWithHostedDiscovery } from "./hosted-discovery.js"
import { sendJson, startRestServer, type RouteHandler } from "./rest-server.js"
import { wsTarget } from "./ws-redirect.js"

export { hostedDiscoveryDocument, hostedOperationCalls, stubFetchWithHostedDiscovery } from "./hosted-discovery.js"

/** The gateway address that the hosted discovery document announces */
export const hostedGateway = "wss://gateway.fluxer.app/?v=1&encoding=json"
const nativeFetch = globalThis.fetch

/** An instance discovery document whose endpoints all point at one loopback origin */
export function instanceDocument(origin: string) {
    return {
        api_code_version: 1,
        endpoints: {
            api_public: origin,
            gateway: `${origin.replace("http:", "ws:")}/gateway`,
            media: `${origin}/media`,
            static_cdn: `${origin}/static`,
            webapp: `${origin}/web`,
            invite: `${origin}/invites`,
        },
        features: { presigned_attachment_uploads: false },
    }
}

/**
 * Start a self-contained loopback instance: discovery at /.well-known/fluxer, the given REST routes and a scripted
 * gateway on the same port. Pass `instance` to createClient. Every other fetch is rejected, so a test cannot reach
 * the hosted service by accident
 */
export async function startInstance(
    options: {
        readonly routes?: Readonly<Record<string, RouteHandler>>
        readonly gateway?: Omit<GatewayServerOptions, "server" | "redirect">
    } = {},
) {
    const rest = await startRestServer({
        routes: {
            "GET /.well-known/fluxer": (_request, response) => sendJson(response, instanceDocument(rest.origin)),
            ...options.routes,
        },
    })
    const gateway = await startGatewayServer({ ...options.gateway, server: rest.server, redirect: false })
    const nativeFetch = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const target = new URL(input instanceof Request ? input.url : input.toString())
        if (target.origin !== rest.origin) throw new Error(`Unexpected non-loopback fixture fetch: ${target.origin}`)
        return nativeFetch(input, init)
    }) as typeof fetch
    onTestFinished(() => {
        globalThis.fetch = nativeFetch
    })
    return { instance: rest.origin, rest, gateway }
}

/**
 * Serve the hosted service from loopback: a REST fixture and a scripted gateway share one port, fetch receives the
 * hosted discovery document, and hosted API URLs are rewritten to the REST fixture. Requires the ws-redirect mock.
 * When the test finishes it also checks that every SDK socket asked for the discovered hosted gateway
 */
export async function startHostedLoopback(
    options: {
        readonly routes?: Readonly<Record<string, RouteHandler>>
        readonly fallback?: RouteHandler
        readonly gateway?: Omit<GatewayServerOptions, "server">
    } = {},
) {
    const { gateway: gatewayOptions, ...restOptions } = options
    const rest = await startRestServer(restOptions)
    const gateway = await startGatewayServer({ ...gatewayOptions, server: rest.server })
    // The fixture replaces this array when the test finishes, so keep the current test's list
    const requested = wsTarget.requested
    onTestFinished(() => {
        expect(requested.filter((url) => url !== hostedGateway)).toEqual([])
    })
    const fetch = stubFetchWithHostedDiscovery((url, init) =>
        nativeFetch(url.replace("https://api.fluxer.app", rest.origin), init),
    )
    return { rest, gateway, fetch }
}
