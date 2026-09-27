import { once } from "node:events"
import type { Server } from "node:http"
import { onTestFinished } from "vitest"
import { WebSocketServer, type WebSocket } from "ws"
import { Opcode as GatewayOpcode } from "../../src/internal/protocol/gateway.js"
import { wsTarget } from "./ws-redirect.js"

/** A command frame the fixture received from a client, with the index of the connection that sent it */
export interface ReceivedCommand {
    readonly connection: number
    readonly op: number
    readonly d: any
}

export interface GatewayServerOptions {
    /** Share an existing HTTP server, such as a REST fixture, instead of listening on a separate port */
    readonly server?: Server
    /** Heartbeat interval sent in HELLO, default 60,000 ms so heartbeats stay out of short tests */
    readonly heartbeatIntervalMs?: number
    /** Send HELLO when a connection opens, default true. A function is read for each new connection */
    readonly hello?: boolean | (() => boolean)
    /** Answer HEARTBEAT with HEARTBEAT_ACK, default true */
    readonly heartbeatAck?: boolean
    /** Answer IDENTIFY with READY and RESUME with RESUMED, default true. A function is read for each such command */
    readonly autoReady?: boolean | ((command: ReceivedCommand) => boolean)
    /** Session ID reported in READY */
    readonly sessionId?: string
    /** Extra READY fields for an IDENTIFY command */
    readonly ready?: (identify: ReceivedCommand) => Record<string, unknown>
    /** Point redirected SDK sockets at this fixture through wsTarget, default true */
    readonly redirect?: boolean
    /** Observe each command after the scripted replies */
    readonly onCommand?: (command: ReceivedCommand, socket: WebSocket) => void
}

export interface GatewayServer {
    /** ws:// address of the fixture */
    readonly url: string
    /** Accepted client connections in order */
    readonly sockets: WebSocket[]
    /** Every received command in order */
    readonly commands: ReceivedCommand[]
    /** Commands with one opcode, such as GatewayOpcode.identify */
    commandsWithOp(op: number): ReceivedCommand[]
    /** Send a DISPATCH frame with the next sequence number to every open connection, or one connection */
    dispatch(event: string, d: unknown, socket?: WebSocket): void
    /**
     * Deliver a DISPATCH frame synchronously to the newest redirected SDK client socket, bypassing the network.
     * It shares dispatch()'s sequence counter, for fixtures whose assertions need delivery before the call returns
     */
    deliverNow(event: string, d: unknown): void
    /** Send a raw frame to every open connection, or one connection */
    send(frame: unknown, socket?: WebSocket): void
    /** Close the newest connection with a gateway close code */
    closeCurrent(code?: number, reason?: string): void
}

/**
 * Start a scripted Fluxer gateway using the SDK's protocol constants.
 * By default it sends HELLO, answers heartbeats, IDENTIFY and RESUME, and closes with the current test
 */
export async function startGatewayServer(options: GatewayServerOptions = {}): Promise<GatewayServer> {
    const gateway = options.server
        ? new WebSocketServer({ server: options.server })
        : new WebSocketServer({ port: 0, host: "127.0.0.1" })
    if (!options.server) await once(gateway, "listening")
    const address = (options.server ?? gateway).address()
    if (!address || typeof address === "string") throw new Error("Missing gateway fixture port")
    const url = `ws://127.0.0.1:${address.port}`
    const sockets: WebSocket[] = []
    const commands: ReceivedCommand[] = []
    let sequence = 0
    const send = (frame: unknown, socket?: WebSocket) => {
        for (const target of socket ? [socket] : sockets)
            if (target.readyState === target.OPEN) target.send(JSON.stringify(frame))
    }
    gateway.on("connection", (socket) => {
        const connection = sockets.push(socket) - 1
        const hello = typeof options.hello === "function" ? options.hello() : options.hello !== false
        if (hello)
            send({ op: GatewayOpcode.hello, d: { heartbeat_interval: options.heartbeatIntervalMs ?? 60_000 } }, socket)
        socket.on("message", (data) => {
            const frame = JSON.parse(data.toString()) as { op: number; d: unknown }
            const command = { connection, op: frame.op, d: frame.d }
            commands.push(command)
            if (frame.op === GatewayOpcode.heartbeat && options.heartbeatAck !== false)
                send({ op: GatewayOpcode.heartbeatAck }, socket)
            const handshake = frame.op === GatewayOpcode.identify || frame.op === GatewayOpcode.resume
            const autoReady =
                handshake &&
                (typeof options.autoReady === "function" ? options.autoReady(command) : options.autoReady !== false)
            if (autoReady && frame.op === GatewayOpcode.identify)
                send(
                    {
                        op: GatewayOpcode.dispatch,
                        s: ++sequence,
                        t: "READY",
                        d: { session_id: options.sessionId ?? "fixture-session", ...options.ready?.(command) },
                    },
                    socket,
                )
            if (autoReady && frame.op === GatewayOpcode.resume)
                send({ op: GatewayOpcode.dispatch, s: ++sequence, t: "RESUMED", d: {} }, socket)
            options.onCommand?.(command, socket)
        })
    })
    if (options.redirect !== false) wsTarget.url = url
    onTestFinished(async () => {
        if (wsTarget.url === url) wsTarget.url = ""
        wsTarget.sockets = []
        wsTarget.requested = []
        wsTarget.onSend = undefined
        for (const socket of sockets) socket.terminate()
        await new Promise<void>((resolve) => gateway.close(() => resolve()))
    })
    return {
        url,
        sockets,
        commands,
        commandsWithOp: (op) => commands.filter((command) => command.op === op),
        dispatch: (event, d, socket) => send({ op: GatewayOpcode.dispatch, s: ++sequence, t: event, d }, socket),
        deliverNow: (event, d) => {
            const client = wsTarget.sockets.at(-1)
            if (!client) throw new Error("No redirected SDK socket to deliver to")
            const frame = { op: GatewayOpcode.dispatch, s: ++sequence, t: event, d }
            client.emit("message", Buffer.from(JSON.stringify(frame)), false)
        },
        send,
        closeCurrent: (code = 4000, reason = "") => sockets.at(-1)?.close(code, reason),
    }
}
