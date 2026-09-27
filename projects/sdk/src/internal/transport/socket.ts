/**
 * WebSocket transport seam: The ws-shaped socket factory the gateway session opens its connection through.
 * Invariant: Only this module imports ws, so gateway code depends on the GatewaySocket shape rather than the library,
 * and the default factory applies the SDK's receive limit, redirect policy and User-Agent handshake header exactly as
 * supplied.
 * Implements [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
import WebSocket from "ws"
import { defaultUserAgent } from "./user-agent.js"

/** WebSocket ready states, matching the ws and WHATWG numbering */
export const SocketState = Object.freeze({ connecting: 0, open: 1, closing: 2, closed: 3 } as const)

/** Received message data: The forms ws delivers (a Buffer is a Uint8Array), or a string from another WebSocket implementation */
export type SocketData = Uint8Array | ArrayBuffer | readonly Uint8Array[] | string

/** Options the gateway passes to every socket it opens */
export interface SocketOptions {
    /** Compression is never negotiated, so received sizes are wire sizes */
    readonly perMessageDeflate: false
    /** The gateway URL is trusted as given. Redirects are rejected */
    readonly followRedirects: false
    /** Largest accepted message in bytes, enforced before decoding text or parsing JSON, including fragments */
    readonly maxPayload: number
    /** Handshake headers. The owner's socket factory adds the User-Agent here */
    readonly headers?: Readonly<Record<string, string>>
}

/** Socket options after the owner's factory has added its handshake headers */
export interface HeaderedSocketOptions extends SocketOptions {
    readonly headers: Readonly<Record<string, string>>
}

/** The subset of a ws WebSocket that the gateway session uses */
export interface GatewaySocket {
    readonly readyState: number
    send(data: string, callback: (error?: Error) => void): void
    close(code: number): void
    terminate(): void
    on(event: "message", listener: (data: SocketData, binary: boolean) => void): unknown
    on(event: "error", listener: (error: Error & { code?: string }) => void): unknown
    on(event: "close", listener: (code: number) => void): unknown
    once(event: "close", listener: () => void): unknown
    off(event: "message", listener: (data: SocketData, binary: boolean) => void): unknown
    off(event: "error", listener: (error: Error & { code?: string }) => void): unknown
    off(event: "close", listener: (() => void) | ((code: number) => void)): unknown
}

/** Open one socket. Connection failures arrive as error or close events, and a synchronous throw is treated as an SDK defect */
export type SocketFactory = (url: string, options: SocketOptions) => GatewaySocket

/** The ws library, sending exactly the given options */
export const platformSocketFactory = (url: string, options: HeaderedSocketOptions): GatewaySocket =>
    new WebSocket(url, options)

/** Open every socket with the given User-Agent handshake header, replacing any other User-Agent value */
export function withSocketUserAgent(
    sockets: (url: string, options: HeaderedSocketOptions) => GatewaySocket,
    userAgent: () => string,
): SocketFactory {
    return (url, options) => {
        const headers: Record<string, string> = {}
        for (const [name, value] of Object.entries(options.headers ?? {}))
            if (name.toLowerCase() !== "user-agent") headers[name] = value
        headers["User-Agent"] = userAgent()
        return sockets(url, { ...options, headers: Object.freeze(headers) })
    }
}

/** The ws library with the SDK's default User-Agent */
export const defaultSocketFactory: SocketFactory = withSocketUserAgent(platformSocketFactory, defaultUserAgent)
