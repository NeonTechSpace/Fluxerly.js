import { once, type EventEmitter } from "node:events"
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
    /** Model session destruction on client close 1000 or 1001 and replay withheld dispatches on Resume, default false */
    readonly enforceClientClosePolicy?: boolean
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
    /** Received client-initiated close frames, excluding replies to server-initiated closure */
    readonly clientCloses: { readonly connection: number; readonly code: number }[]
    /** Retain a dispatch without sending it, for replay by the opt-in session policy */
    withholdDispatch(event: string, d: unknown): void
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
    const clientCloses: { readonly connection: number; readonly code: number }[] = []
    const withheld: { readonly op: number; readonly s: number; readonly t: string; readonly d: unknown }[] = []
    let retainedSession: string | undefined
    let sequence = 0
    const send = (frame: unknown, socket?: WebSocket) => {
        for (const target of socket ? [socket] : sockets)
            if (target.readyState === target.OPEN) target.send(JSON.stringify(frame))
    }
    gateway.on("connection", (socket) => {
        const connection = sockets.push(socket) - 1
        let attachedSession: string | undefined
        // Inspect the close frame before ws sends its reply and changes the server socket state
        const receiver = (socket as WebSocket & { readonly _receiver: EventEmitter })._receiver
        receiver.prependOnceListener("conclude", (code: number) => {
            if (socket.readyState !== socket.OPEN) return
            clientCloses.push({ connection, code })
            if (
                options.enforceClientClosePolicy &&
                attachedSession === retainedSession &&
                (code === 1000 || code === 1001)
            ) {
                retainedSession = undefined
                withheld.length = 0
            }
        })
        const hello = typeof options.hello === "function" ? options.hello() : options.hello !== false
        if (hello)
            send({ op: GatewayOpcode.hello, d: { heartbeat_interval: options.heartbeatIntervalMs ?? 60_000 } }, socket)
        socket.on("message", (data) => {
            const frame = JSON.parse(data.toString()) as { op: number; d: unknown }
            const command: ReceivedCommand = { connection, op: frame.op, d: frame.d }
            commands.push(command)
            if (frame.op === GatewayOpcode.heartbeat && options.heartbeatAck !== false)
                send({ op: GatewayOpcode.heartbeatAck }, socket)
            const handshake = frame.op === GatewayOpcode.identify || frame.op === GatewayOpcode.resume
            const autoReady =
                handshake &&
                (typeof options.autoReady === "function" ? options.autoReady(command) : options.autoReady !== false)
            if (autoReady && frame.op === GatewayOpcode.identify) {
                const d = { session_id: options.sessionId ?? "fixture-session", ...options.ready?.(command) }
                attachedSession = d.session_id
                retainedSession = d.session_id
                withheld.length = 0
                send({ op: GatewayOpcode.dispatch, s: ++sequence, t: "READY", d }, socket)
            }
            if (autoReady && frame.op === GatewayOpcode.resume) {
                if (
                    options.enforceClientClosePolicy &&
                    (retainedSession === undefined || command.d.session_id !== retainedSession)
                )
                    send({ op: GatewayOpcode.invalidSession, d: false }, socket)
                else {
                    attachedSession = command.d.session_id
                    if (options.enforceClientClosePolicy)
                        for (const replay of withheld) if (replay.s > command.d.seq) send(replay, socket)
                    send({ op: GatewayOpcode.dispatch, s: ++sequence, t: "RESUMED", d: {} }, socket)
                }
            }
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
        clientCloses,
        withholdDispatch: (event, d) => withheld.push({ op: GatewayOpcode.dispatch, s: ++sequence, t: event, d }),
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
