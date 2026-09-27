/**
 * Transport seam entry: The HTTP and WebSocket implementations one SDK owner uses for all network I/O.
 * Invariant: REST, instance discovery, OAuth and the gateway reach the network only through a Transport, every owner
 * created without an explicit one uses the platform fetch and the selected ws library, and every Transport sends one
 * User-Agent with each HTTP request and gateway handshake.
 * Implements [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
import { defaultHttpTransport, type HttpTransport } from "./http.js"
import { defaultSocketFactory, type SocketFactory } from "./socket.js"

export { defaultHttpTransport, platformHttpTransport, withUserAgent, type HttpTransport } from "./http.js"
export type { GatewaySocket, SocketData, SocketFactory } from "./socket.js"
export { defaultSocketFactory, platformSocketFactory, SocketState, withSocketUserAgent } from "./socket.js"
export { defaultUserAgent, userAgentMaxLength, validUserAgent } from "./user-agent.js"

/** Network implementations shared by one client, OAuth client or webhook client */
export interface Transport {
    readonly http: HttpTransport
    readonly sockets: SocketFactory
}

/** Platform fetch and the selected ws transport, both with the SDK's default User-Agent */
export const defaultTransport: Transport = Object.freeze({ http: defaultHttpTransport, sockets: defaultSocketFactory })
