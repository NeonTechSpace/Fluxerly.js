import { Opcode as GatewayOpcode } from "../../src/internal/protocol/gateway.js"
import { startGatewayServer, type GatewayServer } from "./gateway-server.js"
import { wsTarget } from "./ws-redirect.js"

/** A DISPATCH frame built ahead of delivery, so a test can size a pending-byte limit from it */
export interface PreparedDispatch {
    /** UTF-8 length of the whole frame, as the SDK measures it */
    readonly bytes: number
    /** Emit the frame synchronously on the newest redirected SDK socket */
    deliver(): void
}

export interface SynchronousGateway extends GatewayServer {
    /** Build the next DISPATCH frame now and deliver it later */
    prepare(event: string, d: unknown): PreparedDispatch
}

/**
 * Start a loopback gateway whose READY, RESUMED, network dispatches and synchronous deliveries share one sequence
 * counter, because the SDK rejects dispatch sequences that go backwards.
 * Synchronous delivery makes pending-queue and deadline boundaries deterministic. The test file must redirect SDK
 * sockets through ws-redirect
 */
export async function startSynchronousGateway(
    options: { readonly heartbeatIntervalMs?: number } = {},
): Promise<SynchronousGateway> {
    let sequence = 0
    const frame = (event: string, d: unknown) => ({ op: GatewayOpcode.dispatch, s: ++sequence, t: event, d })
    const server: GatewayServer = await startGatewayServer({
        autoReady: false,
        ...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs }),
        onCommand: (command, socket) => {
            if (command.op === GatewayOpcode.identify) server.send(frame("READY", { session_id: "fixture" }), socket)
            if (command.op === GatewayOpcode.resume) server.send(frame("RESUMED", {}), socket)
        },
    })
    const prepare = (event: string, d: unknown): PreparedDispatch => {
        const data = Buffer.from(JSON.stringify(frame(event, d)))
        return {
            bytes: data.length,
            deliver: () => {
                const client = wsTarget.sockets.at(-1)
                if (!client) throw new Error("No redirected SDK socket to deliver to")
                client.emit("message", data, false)
            },
        }
    }
    return {
        ...server,
        dispatch: (event, d, socket) => server.send(frame(event, d), socket),
        deliverNow: (event, d) => prepare(event, d).deliver(),
        prepare,
    }
}
