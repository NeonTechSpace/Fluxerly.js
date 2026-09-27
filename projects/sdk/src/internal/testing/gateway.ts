/**
 * In-memory protocol-v1 gateway for test clients: Fake sockets shaped like ws sockets, the scripted handshake and dispatch delivery.
 * Invariant: Every socket opens without I/O, receives HELLO after the SDK attaches its listeners, gets READY for Identify
 * (with the requested shard pair) and RESUMED for Resume, and has every heartbeat acknowledged. Dispatches carry
 * increasing sequence numbers per shard session. No timers run and closing the gateway closes every socket.
 * Implements [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
import { EventEmitter } from "node:events"
import { ClientClosedError, ConfigurationError } from "#sdk/errors"
import type { WebSocketLike, WebSocketOptions } from "#sdk/rest"
import { CloseCode, Opcode } from "../protocol/gateway.js"
import { SocketState } from "../transport/index.js"
import type { WireUser } from "./fixtures.js"
import type { TestDisconnectOptions, TestEmitOptions, TestGatewayCommand } from "./types.js"

interface ShardSession {
    socket: FakeSocket | undefined
    ready: boolean
    sessionId: string
    sequence: number
}

/** A ws-compatible socket whose server side is the test gateway */
class FakeSocket extends EventEmitter {
    readyState: number = SocketState.open
    shardId: number | null = null

    constructor(private readonly gateway: TestGateway) {
        super()
    }

    send(data: string, callback: (error?: Error) => void) {
        if (this.readyState !== SocketState.open) {
            queueMicrotask(() => callback(new Error("The test gateway socket is not open")))
            return
        }
        queueMicrotask(() => callback())
        this.gateway.receive(this, data)
    }

    close(code: number) {
        this.#close(code)
    }

    terminate() {
        this.#close(CloseCode.abnormal)
    }

    /** Deliver a frame synchronously, as one received text message */
    deliver(frame: unknown) {
        if (this.readyState !== SocketState.open) return
        this.emit("message", Buffer.from(JSON.stringify(frame)), false)
    }

    /** Close from either side. The close event follows in a microtask, exactly once */
    #close(code: number) {
        if (this.readyState === SocketState.closing || this.readyState === SocketState.closed) return
        this.readyState = SocketState.closing
        this.gateway.detach(this)
        queueMicrotask(() => {
            this.readyState = SocketState.closed
            this.emit("close", code, Buffer.alloc(0))
        })
    }

    /** End the connection from the server side */
    serverClose(code: number) {
        this.#close(code)
    }
}

/** Redact the token in Identify and Resume data before recording */
function recordedData(op: number, d: unknown): unknown {
    if ((op !== Opcode.identify && op !== Opcode.resume) || typeof d !== "object" || d === null) return d
    return { ...d, token: "[redacted]" }
}

/** Fluxer's shard for a guild ID under a shard count */
function guildShard(guildId: string, totalShards: number): number {
    return Number((BigInt(guildId) >> 22n) % BigInt(totalShards))
}

/** The scripted gateway shared by one test client's shards */
export class TestGateway {
    readonly #sockets = new Set<FakeSocket>()
    readonly #shards = new Map<number, ShardSession>()
    readonly #commands: TestGatewayCommand[] = []
    #totalShards = 1
    #sessions = 0
    #closed = false

    constructor(
        private readonly settings: {
            readonly user: WireUser
            readonly heartbeatIntervalMs: number
        },
    ) {}

    /** The socket factory passed to the client's transport option */
    readonly webSocket = (_url: string, _options: WebSocketOptions): WebSocketLike => {
        const socket = new FakeSocket(this)
        if (this.#closed) {
            // A socket requested after cleanup closes like a refused connection instead of reaching any network
            socket.serverClose(CloseCode.abnormal)
            return socket
        }
        this.#sockets.add(socket)
        queueMicrotask(() =>
            socket.deliver({ op: Opcode.hello, d: { heartbeat_interval: this.settings.heartbeatIntervalMs } }),
        )
        return socket
    }

    /** Commands received so far, in order */
    commands(): readonly TestGatewayCommand[] {
        return Object.freeze([...this.#commands])
    }

    /** Handle one command a client socket sent */
    receive(socket: FakeSocket, data: string) {
        let frame: { op?: unknown; d?: unknown }
        try {
            frame = JSON.parse(data) as { op?: unknown; d?: unknown }
        } catch {
            // allow-silent: A non-JSON command is an SDK defect the real gateway would answer with close code 4002
            socket.serverClose(CloseCode.decodeError)
            return
        }
        const op = typeof frame.op === "number" ? frame.op : -1
        if (op === Opcode.identify) this.#identify(socket, frame.d)
        else if (op === Opcode.resume) this.#resume(socket, frame.d)
        this.#commands.push(Object.freeze({ shardId: socket.shardId, op, d: recordedData(op, frame.d) }))
        if (op === Opcode.heartbeat) queueMicrotask(() => socket.deliver({ op: Opcode.heartbeatAck }))
    }

    #identify(socket: FakeSocket, d: unknown) {
        const shard = (d as { shard?: unknown } | null)?.shard
        const pair =
            Array.isArray(shard) && shard.length === 2 && shard.every((value) => Number.isSafeInteger(value))
                ? (shard as [number, number])
                : undefined
        const shardId = pair?.[0] ?? 0
        this.#totalShards = pair?.[1] ?? 1
        socket.shardId = shardId
        const session: ShardSession = {
            socket,
            ready: false,
            sessionId: `fixture-session-${shardId}-${++this.#sessions}`,
            sequence: 1,
        }
        this.#shards.set(shardId, session)
        queueMicrotask(() => {
            if (session.socket !== socket) return
            // Ready first: The client can finish connecting and emit synchronously inside this delivery
            session.ready = true
            socket.deliver({
                op: Opcode.dispatch,
                s: 1,
                t: "READY",
                d: {
                    session_id: session.sessionId,
                    version: 1,
                    user: this.settings.user,
                    // No guilds list: Tests add communities later, so the connected record reports no count and no invite warning
                    private_channels: [],
                    presences: [],
                    users: [],
                    ...(pair ? { shard: pair } : {}),
                },
            })
        })
    }

    #resume(socket: FakeSocket, d: unknown) {
        const sessionId = (d as { session_id?: unknown } | null)?.session_id
        const entry = [...this.#shards].find(([, session]) => session.sessionId === sessionId)
        if (!entry) {
            queueMicrotask(() => socket.deliver({ op: Opcode.invalidSession, d: false }))
            return
        }
        const [shardId, session] = entry
        socket.shardId = shardId
        session.socket = socket
        session.ready = false
        queueMicrotask(() => {
            if (session.socket !== socket) return
            session.ready = true
            socket.deliver({ op: Opcode.dispatch, s: ++session.sequence, t: "RESUMED", d: {} })
        })
    }

    /** Forget a closing socket */
    detach(socket: FakeSocket) {
        this.#sockets.delete(socket)
        for (const session of this.#shards.values())
            if (session.socket === socket) {
                session.socket = undefined
                session.ready = false
            }
    }

    #connected(shardId: number, operation: string): ShardSession & { socket: FakeSocket } {
        if (this.#closed) throw new ClientClosedError()
        const session = this.#shards.get(shardId)
        if (!session?.ready || session.socket?.readyState !== SocketState.open)
            throw new ConfigurationError(
                "shardIds",
                `Test gateway shard ${shardId} is not connected, so ${operation} cannot deliver to it`,
                {
                    hint: "Await ready() before emitting, and pass a shardId this client owns",
                },
            )
        return session as ShardSession & { socket: FakeSocket }
    }

    /** Deliver one dispatch synchronously to a connected shard with the next sequence number */
    emit(type: unknown, payload: unknown, options: TestEmitOptions | undefined) {
        if (typeof type !== "string" || !/^[A-Z0-9_]+$/.test(type))
            throw new ConfigurationError(
                "event",
                "Emitted dispatch types must be upper-case Fluxer dispatch names, such as MESSAGE_CREATE",
            )
        if (type === "READY" || type === "RESUMED")
            throw new ConfigurationError("event", `The test gateway sends ${type} itself during the handshake`, {
                hint: "Await ready() to connect, or use disconnect() to exercise a resume",
            })
        if (options !== undefined && (typeof options !== "object" || options === null))
            throw new ConfigurationError("event", "Emit options must be an object")
        const requested = options?.shardId
        if (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 0))
            throw new ConfigurationError("shardIds", "Emit shardId must be a non-negative integer")
        const guildId = (payload as { guild_id?: unknown } | null)?.guild_id
        const shardId =
            requested ??
            (typeof guildId === "string" && /^[0-9]+$/.test(guildId) ? guildShard(guildId, this.#totalShards) : 0)
        let text: string | undefined
        try {
            text = JSON.stringify(payload)
        } catch (cause) {
            throw new ConfigurationError("event", "Emitted payloads must be JSON-serializable wire data", { cause })
        }
        const session = this.#connected(shardId, `emit(${JSON.stringify(type)})`)
        session.sequence += 1
        const frame = {
            op: Opcode.dispatch,
            s: session.sequence,
            t: type,
            ...(text === undefined ? {} : { d: payload }),
        }
        session.socket.deliver(frame)
    }

    /** Close one shard's current connection from the server side with a close code */
    disconnect(options: TestDisconnectOptions | undefined) {
        if (options !== undefined && (typeof options !== "object" || options === null))
            throw new ConfigurationError("connection", "Disconnect options must be an object")
        const shardId = options?.shardId ?? 0
        const code = options?.code ?? CloseCode.unknownError
        if (!Number.isSafeInteger(shardId) || shardId < 0)
            throw new ConfigurationError("shardIds", "Disconnect shardId must be a non-negative integer")
        if (!Number.isSafeInteger(code) || code < 1000 || code > 4999)
            throw new ConfigurationError(
                "connection",
                "Disconnect code must be a WebSocket close code from 1000 through 4999",
            )
        this.#connected(shardId, "disconnect").socket.serverClose(code)
    }

    /** Close every remaining socket and refuse later connections. Returns how many sockets were still open */
    close(): number {
        this.#closed = true
        const open = [...this.#sockets]
        for (const socket of open) socket.serverClose(CloseCode.goingAway)
        return open.length
    }
}
