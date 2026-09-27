/**
 * Inbound gateway frame decoding: Text frames to payloads, and HELLO, dispatch-envelope and READY validation.
 * Invariant: Each accepted message is decoded once and keeps its received byte length for downstream admission.
 * Binary frames, invalid JSON and envelopes missing required fields are protocol failures that name the field.
 * Size rule: The socket enforces maxGatewayMessageBytes before decoding text or parsing JSON, including fragmented
 * messages. This compatibility ceiling stays separate from Fluxer's outbound command limits, replay retention,
 * subscription byte accounting and actual heap usage. Local size and UTF-8 rejections are terminal protocol failures,
 * never transient network failures replayed through automatic recovery. Public limits and failure behavior are documented on the
 * default and native Client and on ConnectionError. Implements [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
import { Opcode } from "../protocol/gateway.js"
import type { SocketData } from "../transport/index.js"

/** Preserve the selected transport's 100 MiB compatibility ceiling explicitly.
 * Fluxer's outbound-command and replay-retention limits do not bound live inbound messages
 */
export const maxGatewayMessageBytes = 100 * 1024 * 1024

/** Largest heartbeat interval a timer can represent */
const maximumHeartbeatIntervalMs = 2_147_483_647

/** Safe facts about a rejected frame, recorded in ConnectionError details */
export interface FrameRejection {
    readonly rejected: true
    readonly detail: string
    readonly opcode?: number
    readonly dispatch?: string
    readonly field?: string
}

/** One decoded frame with an integer opcode */
export interface Frame {
    readonly rejected: false
    readonly op: number
    /** The frame's d field, or undefined when it has none */
    readonly body: unknown
    /** The whole decoded frame, used only for unsafe payload logging */
    readonly payload: Readonly<Record<string, unknown>>
    /** Received UTF-8 byte length of the message */
    readonly bytes: number
}

const rejection = (value: Omit<FrameRejection, "rejected">): FrameRejection => ({ rejected: true, ...value })

/** Decode one received message into a frame, or reject it before any opcode handling */
export function decodeFrame(data: SocketData, binary: boolean): Frame | FrameRejection {
    if (binary) return rejection({ detail: "received a binary frame" })
    const buffer =
        typeof data === "string"
            ? Buffer.from(data, "utf8")
            : Buffer.isBuffer(data)
              ? data
              : Array.isArray(data)
                ? Buffer.concat(data)
                : data instanceof ArrayBuffer
                  ? Buffer.from(data)
                  : Buffer.from(
                        (data as Uint8Array).buffer,
                        (data as Uint8Array).byteOffset,
                        (data as Uint8Array).byteLength,
                    )
    const bytes = buffer.byteLength
    let payload: unknown
    try {
        payload = JSON.parse(buffer.toString("utf8"))
    } catch {
        // allow-silent: The returned rejection becomes a recorded protocol failure for the invalid JSON frame
        return rejection({ detail: "received a frame that is not valid JSON" })
    }
    if (typeof payload !== "object" || payload === null || !("op" in payload) || !Number.isInteger(payload.op))
        return rejection({ detail: "received a frame without an integer opcode", field: "op" })
    return {
        rejected: false,
        op: payload.op as number,
        body: "d" in payload ? payload.d : undefined,
        payload: payload as Readonly<Record<string, unknown>>,
        bytes,
    }
}

/** Validate HELLO and return its heartbeat interval in milliseconds */
export function readHello(body: unknown, receivedHello: boolean): number | FrameRejection {
    if (
        receivedHello ||
        typeof body !== "object" ||
        body === null ||
        !("heartbeat_interval" in body) ||
        typeof body.heartbeat_interval !== "number" ||
        !Number.isSafeInteger(body.heartbeat_interval) ||
        body.heartbeat_interval <= 0 ||
        body.heartbeat_interval > maximumHeartbeatIntervalMs
    )
        return rejection({
            detail: receivedHello ? "received a second HELLO" : "received an invalid HELLO",
            opcode: Opcode.hello,
            field: receivedHello ? "op" : "d.heartbeat_interval",
        })
    return body.heartbeat_interval
}

/** A dispatch frame's sequence and type */
export interface DispatchEnvelope {
    readonly rejected: false
    readonly sequence: number
    readonly type: string
}

/** Validate that a dispatch arrived after HELLO with a non-negative sequence and a string type */
export function readDispatchEnvelope(
    payload: Readonly<Record<string, unknown>>,
    receivedHello: boolean,
): DispatchEnvelope | FrameRejection {
    const sequence = payload.s
    const type = payload.t
    if (
        !receivedHello ||
        !("s" in payload) ||
        typeof sequence !== "number" ||
        !Number.isSafeInteger(sequence) ||
        sequence < 0 ||
        !("t" in payload) ||
        typeof type !== "string"
    )
        return rejection({
            detail: !receivedHello
                ? "received a dispatch before HELLO"
                : "received a dispatch without a valid sequence and type",
            opcode: Opcode.dispatch,
            field: !receivedHello ? "op" : !("s" in payload) || typeof sequence !== "number" ? "s" : "t",
        })
    return { rejected: false, sequence, type }
}

/** Validate READY for a fresh session and return its session ID.
 * READY is invalid when a session is already ready or resuming, or when it names a different shard than requested
 */
export function readReady(
    body: unknown,
    state: {
        readonly receivedReady: boolean
        readonly resuming: boolean
        readonly shard: readonly [number, number] | undefined
    },
): string | FrameRejection {
    const { receivedReady, resuming, shard } = state
    const sessionId =
        typeof body === "object" &&
        body !== null &&
        "session_id" in body &&
        typeof body.session_id === "string" &&
        body.session_id
            ? body.session_id
            : undefined
    if (
        receivedReady ||
        resuming ||
        sessionId === undefined ||
        (shard !== undefined &&
            (!("shard" in (body as object)) ||
                !Array.isArray((body as { shard: unknown }).shard) ||
                (body as { shard: unknown[] }).shard.length !== 2 ||
                (body as { shard: unknown[] }).shard[0] !== shard[0] ||
                (body as { shard: unknown[] }).shard[1] !== shard[1]))
    )
        return rejection({
            detail: receivedReady
                ? "received a second READY"
                : resuming
                  ? "received READY while resuming"
                  : "received an invalid READY",
            opcode: Opcode.dispatch,
            dispatch: "READY",
            field: sessionId === undefined ? "d.session_id" : "d.shard",
        })
    return sessionId
}
