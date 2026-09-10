import { vi } from "vitest"

const hostedDiscoveryUrl = "https://fluxer.app/.well-known/fluxer"

/** The fixed hosted discovery document supplied only to tests that explicitly opt into this fixture */
export const hostedDiscoveryDocument = Object.freeze({
    api_code_version: 1,
    endpoints: Object.freeze({
        api_public: "https://api.fluxer.app",
        gateway: "wss://gateway.fluxer.app",
        media: "https://fluxerusercontent.com",
        static_cdn: "https://fluxerstatic.com",
        webapp: "https://fluxer.app",
        invite: "https://fluxer.gg",
    }),
    features: Object.freeze({ presigned_attachment_uploads: true }),
})

function url(input: RequestInfo | URL): string {
    return typeof input === "string" ? input : input instanceof URL ? input.href : input.url
}

/**
 * Install one explicit hosted discovery fixture beside an operation-specific fetch handler
 *
 * Only the exact bootstrap well-known URL receives this public document. Every other URL is
 * delegated unchanged, so operation fixtures can count their own requests without silently
 * bypassing discovery behavior
 */
export function stubFetchWithHostedDiscovery(
    handler: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
    const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const target = url(input)
        return target === hostedDiscoveryUrl
            ? Promise.resolve(Response.json(hostedDiscoveryDocument))
            : handler(target, init ?? {})
    })
    vi.stubGlobal("fetch", fetch)
    return fetch
}

/** Count only requests delegated to a test's operation handler, excluding its explicit well-known bootstrap */
export function hostedOperationCalls(fetch: ReturnType<typeof stubFetchWithHostedDiscovery>) {
    return fetch.mock.calls.filter(([input]) => url(input as RequestInfo | URL) !== hostedDiscoveryUrl)
}
