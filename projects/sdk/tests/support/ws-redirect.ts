import type * as WsModule from "ws"

export interface WsTarget {
    /**
     * Address redirected sockets connect to. While it is empty, only loopback addresses connect unchanged and any
     * other address throws, so tests never reach the network
     */
    url: string
    /** Client sockets created so far, in order */
    sockets: WsModule.WebSocket[]
    /** Addresses the SDK asked to connect to, in order, before redirection */
    requested: string[]
    /** Observe each frame an SDK socket sends, synchronously before it is written */
    onSend?: ((socket: WsModule.WebSocket, data: unknown) => void) | undefined
}

/**
 * Where redirected SDK gateway sockets connect, and the sockets created so far.
 * startGatewayServer() sets url and clears url, sockets, requested and onSend when its test finishes
 */
export const wsTarget: WsTarget = { url: "", sockets: [], requested: [] }

function isLoopback(url: string | URL): boolean {
    try {
        return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)
    } catch {
        // An unparsable address is not a loopback fixture
        return false
    }
}

/**
 * Build a ws module whose WebSocket connects to wsTarget.url instead of the requested address.
 * Use it from a test file's hoisted mock:
 *
 * vi.mock("ws", (original) => import("./support/ws-redirect.js").then((ws) => ws.redirectWebSocket(original)))
 */
export async function redirectWebSocket(original: () => Promise<typeof WsModule>): Promise<typeof WsModule> {
    const module = await original()
    class RedirectedWebSocket extends module.default {
        constructor(url: string | URL, protocols?: unknown, options?: unknown) {
            wsTarget.requested.push(String(url))
            // A test that dials its own loopback fixture directly needs no target, but nothing may reach the network
            if (!wsTarget.url && !isLoopback(url))
                throw new Error(
                    "No gateway fixture target: start startGatewayServer() or set wsTarget.url before connecting",
                )
            super(wsTarget.url || url, protocols as never, options as never)
            wsTarget.sockets.push(this)
        }

        override send(...args: [data: unknown, ...rest: unknown[]]): void {
            wsTarget.onSend?.(this, args[0])
            Reflect.apply(super.send, this, args)
        }
    }
    return { ...module, default: RedirectedWebSocket as typeof module.default }
}
