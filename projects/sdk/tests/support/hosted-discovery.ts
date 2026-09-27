import { vi } from "vitest"
import { hostedDiscoveryDocument, hostedDiscoveryUrl } from "../../src/internal/testing/discovery.js"

/** The fixed hosted discovery document, shared with the public test transport, for tests that explicitly opt into it */
export { hostedDiscoveryDocument }

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
