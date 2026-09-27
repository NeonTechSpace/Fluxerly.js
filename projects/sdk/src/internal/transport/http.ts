/**
 * HTTP transport seam: The one fetch-shaped function that REST, instance discovery, OAuth and attachment transfers call.
 * Invariant: The platform implementation looks up the global fetch on every request, so no module captures a transport
 * at import time. Callers always pass their own redirect policy and abort signal, and every transport an SDK owner uses
 * adds exactly one User-Agent header, replacing any caller-built value.
 * Implements [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
import { defaultUserAgent } from "./user-agent.js"

/** Fetch-shaped HTTP transport. It must honor init.signal and init.redirect like the platform fetch */
export type HttpTransport = (url: string, init: RequestInit) => Promise<Response>

/** Platform fetch, resolved at call time */
export const platformHttpTransport: HttpTransport = (url, init) => globalThis.fetch(url, init)

/** Copy request headers into a plain record without any User-Agent, keeping the SDK's header-name spelling */
function headerRecord(headers: RequestInit["headers"]): Record<string, string> {
    const result: Record<string, string> = {}
    if (headers === undefined) return result
    if (headers instanceof Headers || Array.isArray(headers)) {
        new Headers(headers).forEach((value, name) => {
            result[name] = value
        })
    } else Object.assign(result, headers)
    for (const name of Object.keys(result)) if (name.toLowerCase() === "user-agent") delete result[name]
    return result
}

/**
 * Send every request through a transport with the given User-Agent. A synchronous throw from the wrapped transport
 * becomes a rejected promise, so callers see one failure path for replaced implementations
 */
export function withUserAgent(http: HttpTransport, userAgent: () => string): HttpTransport {
    return (url, init) => {
        try {
            return Promise.resolve(
                http(url, { ...init, headers: { ...headerRecord(init.headers), "User-Agent": userAgent() } }),
            )
        } catch (error) {
            return Promise.reject(error)
        }
    }
}

/** Platform fetch with the SDK's default User-Agent, used by every owner created without a caller transport */
export const defaultHttpTransport: HttpTransport = withUserAgent(platformHttpTransport, defaultUserAgent)
