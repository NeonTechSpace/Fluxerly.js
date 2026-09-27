/**
 * One uncompressed protocol-v1 gateway session: Socket lifetime, HELLO and heartbeat, authentication, sequence
 * tracking and the attempt outcome the client's recovery loop classifies.
 * Invariant: Readiness requires authentication and READY or RESUMED, not an open socket. The session owns its socket
 * for the calling scope and always awaits its closure, with bounded graceful closure, then forced termination, and
 * immediate termination for a pending handshake. Implements
 * [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
import type { EventMap, EventName } from "#sdk/events"
import type { MessageCore } from "#sdk/messages"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import type * as Redacted from "effect/Redacted"
import {
    AuthenticationError,
    ConnectionError,
    ConnectionTimeoutError,
    RateLimitError,
    type ConnectionFailure,
} from "#sdk/errors"
import { nowMs } from "../clock.js"
import { failingFieldPath } from "../decode/trace.js"
import { TransportError } from "../effect-failures.js"
import type { ClientLogger } from "../logging.js"
import type { MessageDecoder } from "../message-fields.js"
import type { CountGatewayOwner } from "../counts.js"
import type { MemberChunkOwner } from "../member-chunks.js"
import type { PresenceGatewayOwner } from "../presence.js"
import { classifyCloseCode, CloseCode, Opcode, opcodeName } from "../protocol/gateway.js"
import {
    defaultSocketFactory,
    SocketState,
    type GatewaySocket,
    type SocketData,
    type SocketFactory,
} from "../transport/index.js"
import { commandPacer, commandSender, gatewayCommands, type IdentifyFields, type SubmitFailure } from "./commands.js"
import { routeDispatch, type DispatchContext, type DispatchSinks } from "./dispatch-table.js"
import {
    decodeFrame,
    maxGatewayMessageBytes,
    readDispatchEnvelope,
    readHello,
    readReady,
    type FrameRejection,
} from "./frames.js"

/** Graceful WebSocket closure budget before the socket is terminated */
const gracefulCloseMs = 5_000

/** Resumable session state, shared across attempts of one shard and mutated by the session that owns it */
export interface Session {
    id: string | undefined
    sequence: number | null
}

/** Why an attempt ended, for log records. The public failure keeps only reviewed facts */
export type AttemptEnd =
    | "closed"
    | "heartbeatTimeout"
    | "reconnectRequested"
    | "invalidSession"
    | "network"
    | "sendFailed"
    | "protocol"
    | "timeout"

/** Retry metadata is internal, not a promise that arbitrary consumer actions are repeatable */
export class AttemptFailure {
    readonly _tag = "AttemptFailure"
    constructor(
        readonly failure: ConnectionFailure,
        readonly retry: boolean,
        readonly resetSession = false,
        readonly end: AttemptEnd = "network",
        /** WebSocket close code when the attempt ended with a gateway closure */
        readonly closeCode?: number,
    ) {}
}

/** Classify a gateway close through the reviewed close-code table. Unlisted codes enter recovery */
export function classifyClose(code: number, resuming: boolean): AttemptFailure {
    const outcome = classifyCloseCode(code, resuming)
    const failure =
        outcome.failure === "authentication"
            ? new AuthenticationError()
            : outcome.failure === "rateLimit"
              ? new RateLimitError("gateway", null)
              : new ConnectionError("gateway", outcome.failure, code)
    return new AttemptFailure(failure, outcome.retry, outcome.resetSession, "closed", code)
}

/** Logging and malformed-dispatch policy for one shard's gateway session */
export interface GatewayObserver {
    readonly logger: ClientLogger
    readonly shardId: number
    /** The skip policy drops a known dispatch that fails decoding, terminate ends the session as a protocol failure */
    readonly onMalformedDispatch: "skip" | "terminate"
    /** Invalidate cached observations that a skipped dispatch could have changed */
    readonly invalidate: (type: string, body: unknown) => void
}

/** Everything one gateway attempt needs. Callbacks run synchronously on the socket's event turn */
export interface GatewaySessionOptions<M extends MessageCore> {
    readonly messageDecoder: MessageDecoder<M>
    /** Complete gateway URL, including the protocol version and encoding query */
    readonly url: string
    readonly token: Redacted.Redacted<string>
    /** Resumed when it holds an ID and sequence, and updated by READY and each dispatch sequence */
    readonly session: Session
    /** Budget for HELLO, authentication and READY or RESUMED together */
    readonly timeoutMs: number
    /** Called once when the session is ready, after request owners are attached */
    readonly onReady: (mode: "identify" | "resume") => void
    /** Heartbeat round trip in milliseconds, or null when the session stops having a current measurement */
    readonly onLatency: (milliseconds: number | null) => void
    /** Called when a ready session ends with a retryable failure */
    readonly onRecovering: () => void
    /** Deliver one decoded event with the received byte length of its frame */
    readonly onDispatch: <K extends EventName>(event: K, message: EventMap<M>[K], bytes: number) => void
    /**
     * Observe every accepted dispatch before decoding, including READY, RESUMED and types without a table entry.
     * Called after envelope, readiness and sequence validation, and before the dispatch updates caches or reaches
     * decoded-event subscribers
     */
    readonly onRaw?: ((type: string, sequence: number, body: unknown, bytes: number) => void) | undefined
    /** Optional Identify fields, read each time this session sends Identify */
    readonly identifyFields?: (() => IdentifyFields) | undefined
    /** Lend the paced gateway.send path to the client once ready, and withdraw it when the session ends */
    readonly application?:
        | {
              readonly attach: (submit: (op: number, d: unknown) => Effect.Effect<void, SubmitFailure>) => void
              readonly detach: () => void
          }
        | undefined
    /** Guild and channel cache intake for guild lifecycle and expression dispatches, when a resource cache is enabled */
    readonly onGuild?: ((event: string, value: unknown) => void) | undefined
    readonly presence?: PresenceGatewayOwner | undefined
    readonly counts?: CountGatewayOwner | undefined
    readonly memberChunks?: Pick<MemberChunkOwner, "attach" | "detach" | "receive" | "rateLimited"> | undefined
    /** Shard ID and count sent with Identify and required in READY, when sharding is configured */
    readonly shard?: readonly [number, number] | undefined
    /** Pace a fresh Identify send. Resume is never paced */
    readonly identify?: ((send: () => void) => Effect.Effect<void, AttemptFailure>) | undefined
    /** Invite URL base from discovery, defaulting to the hosted instance */
    readonly inviteBase?: string | undefined
    readonly observer?: GatewayObserver | undefined
    /** Socket implementation, defaulting to the selected ws transport */
    readonly sockets?: SocketFactory | undefined
}

function closeSocket(socket: GatewaySocket) {
    return Effect.gen(function* () {
        if (socket.readyState === SocketState.closed) return
        const closed = Effect.callback<void>((resume) => {
            const onClose = () => resume(Effect.void)
            socket.once("close", onClose)
            if (socket.readyState === SocketState.closed) onClose()
            return Effect.sync(() => socket.off("close", onClose))
        })
        yield* Effect.sync(() => {
            if (socket.readyState === SocketState.connecting) socket.terminate()
            else socket.close(CloseCode.normal)
        }).pipe(
            Effect.onExit((exit) =>
                exit._tag === "Failure"
                    ? Effect.sync(() => socket.terminate()).pipe(Effect.andThen(closed))
                    : Effect.void,
            ),
        )
        yield* closed.pipe(
            Effect.timeoutOrElse({
                duration: gracefulCloseMs,
                orElse: () =>
                    Effect.gen(function* () {
                        socket.terminate()
                        yield* closed
                    }),
            }),
        )
    })
}

/** Map a local ws receive rejection to its WebSocket close status, or null for other transport failures */
function localRejectionStatus(code: string | undefined): number | null {
    if (code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" || code === "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH")
        return CloseCode.messageTooBig
    if (code === "WS_ERR_INVALID_UTF8") return CloseCode.invalidPayload
    return null
}

/** Run one session in the calling Effect scope. It fails with the AttemptFailure that ended it and never succeeds */
export const runGatewaySession = <M extends MessageCore>(options: GatewaySessionOptions<M>) =>
    Effect.scoped(
        Effect.gen(function* () {
            const {
                messageDecoder,
                url,
                token,
                session,
                timeoutMs,
                onReady,
                onLatency,
                onRecovering,
                onDispatch,
                onGuild,
                presence,
                counts,
                memberChunks,
                shard,
                identify,
                onRaw,
                identifyFields,
                application,
                inviteBase = "https://fluxer.gg",
                observer,
                sockets = defaultSocketFactory,
            } = options
            const clock = yield* Clock.Clock
            const now = () => nowMs(clock)
            const hello = Deferred.makeUnsafe<number, AttemptFailure>()
            const ready = Deferred.makeUnsafe<void, AttemptFailure>()
            const ended = Deferred.makeUnsafe<never, AttemptFailure>()
            let stopping = false
            let receivedHello = false
            let receivedReady = false
            let pendingHeartbeat: number | undefined
            const resuming = session.id !== undefined && session.sequence !== null
            const fail = (error: AttemptFailure) => {
                if (Deferred.doneUnsafe(ended, Effect.fail(error))) {
                    onLatency(null)
                    if (receivedReady && error.retry) onRecovering()
                }
            }
            const logger = observer?.logger
            const shardId = observer?.shardId
            /**
             * End the attempt for invalid data. A server anomaly retries with a new session, which the shard loop bounds.
             * A local policy, such as binary frames or onMalformedDispatch terminate, ends the shard instead
             */
            const protocolFailure = (rejection: Omit<FrameRejection, "rejected">, retry = true) => {
                logger?.count("protocolFailures")
                const details: Record<string, string | number> = { detail: rejection.detail }
                if (rejection.opcode !== undefined) details.opcode = rejection.opcode
                if (rejection.dispatch !== undefined) details.dispatch = rejection.dispatch
                if (rejection.field !== undefined) details.field = rejection.field
                fail(
                    new AttemptFailure(
                        new ConnectionError("gateway", "protocol", null, { details }),
                        retry,
                        retry,
                        "protocol",
                    ),
                )
            }
            const dispatchContext: DispatchContext = { messageDecoder, inviteBase }
            let frameBytes = 0
            const sinks: DispatchSinks = {
                emit: (event, value) => onDispatch(event, value as EventMap<M>[typeof event], frameBytes),
                guildCache: onGuild,
                presence,
                counts,
                memberChunks,
                get bytes() {
                    return frameBytes
                },
            }
            const socket = yield* Effect.acquireRelease(
                Effect.sync(() => {
                    const socket = sockets(url, {
                        perMessageDeflate: false,
                        followRedirects: false,
                        maxPayload: maxGatewayMessageBytes,
                    })
                    const send = commandSender({
                        socket,
                        logger,
                        shardId,
                        stopping: () => stopping,
                        failed: ({ error }) => fail(new AttemptFailure(error, true, false, "sendFailed")),
                    })
                    const pacer = commandPacer({ send, now, logger, shardId })
                    const commands = gatewayCommands(send, pacer.send, {
                        token,
                        session,
                        resuming,
                        shard,
                        identify: identifyFields,
                    })
                    const heartbeat = () => {
                        // Server requests must be answered even while a previous ACK is pending
                        pendingHeartbeat ??= now()
                        send(Opcode.heartbeat, session.sequence)
                    }
                    const malformed = (
                        type: string,
                        body: unknown,
                        sequence: number,
                        decode: (body: unknown) => unknown,
                    ) => {
                        const field = failingFieldPath(decode, body)
                        if (!observer || observer.onMalformedDispatch === "terminate")
                            return protocolFailure(
                                {
                                    detail: "a dispatch did not match the expected shape",
                                    opcode: Opcode.dispatch,
                                    dispatch: type,
                                    ...(field === undefined ? {} : { field }),
                                },
                                false,
                            )
                        observer.logger.count("protocolFailures")
                        observer.logger.drop(
                            { event: "malformed" },
                            {
                                level: "warn",
                                category: "gateway",
                                code: "gateway.dispatchRejected",
                                message: `Skipped a ${type} dispatch because its data did not match the expected shape${field === undefined ? "" : ` at ${field}`}. Handlers do not receive it, and cache entries it could have changed were cleared`,
                                shardId,
                                fields: { dispatch: type, field: field ?? null, sequence },
                            },
                        )
                        observer.invalidate(type, body)
                    }
                    const dispatch = (payload: Readonly<Record<string, unknown>>, body: unknown, bytes: number) => {
                        const envelope = readDispatchEnvelope(payload, receivedHello)
                        if (envelope.rejected) return protocolFailure(envelope)
                        const { type, sequence } = envelope
                        if (type === "READY") {
                            const sessionId = readReady(body, { receivedReady, resuming, shard })
                            if (typeof sessionId !== "string") return protocolFailure(sessionId)
                            session.id = sessionId
                            receivedReady = true
                        } else if (type === "RESUMED") {
                            if (!resuming || receivedReady)
                                return protocolFailure({
                                    detail: "received an unexpected RESUMED",
                                    opcode: Opcode.dispatch,
                                    dispatch: "RESUMED",
                                })
                            receivedReady = true
                        } else if (!resuming && !receivedReady)
                            return protocolFailure({
                                detail: "received a dispatch before READY",
                                opcode: Opcode.dispatch,
                                dispatch: type,
                            })
                        if (session.sequence !== null && sequence < session.sequence)
                            return protocolFailure({
                                detail: "the dispatch sequence went backwards",
                                opcode: Opcode.dispatch,
                                dispatch: type,
                                field: "s",
                            })
                        session.sequence = sequence
                        onRaw?.(type, sequence, body, bytes)
                        if (logger?.enabled("debug", "gateway"))
                            logger.log({
                                level: "debug",
                                category: "gateway",
                                code: "gateway.dispatch",
                                message: `Received ${type}`,
                                shardId,
                                fields: { dispatch: type, sequence, bytes },
                            })
                        if (type === "READY" || type === "RESUMED") {
                            Deferred.doneUnsafe(ready, Effect.void)
                            return
                        }
                        frameBytes = bytes
                        const result = routeDispatch(type, body, dispatchContext, sinks)
                        if (result.kind === "malformed") malformed(type, body, sequence, result.decode)
                        else if (result.kind === "unknown")
                            logger?.drop("unknownDispatches", {
                                level: "debug",
                                category: "gateway",
                                code: "gateway.unknownDispatch",
                                message: `Ignored dispatch type ${type}, which this SDK version does not handle`,
                                shardId,
                                fields: { dispatch: type },
                            })
                    }
                    const processMessage = (data: SocketData, binary: boolean) => {
                        if (stopping) return
                        const frame = decodeFrame(data, binary)
                        // A binary frame is refused by local policy, so reconnecting would receive it again
                        if (frame.rejected) return protocolFailure(frame, !binary)
                        const { op, body, bytes, payload } = frame
                        if (logger?.enabled("trace", "gateway"))
                            logger.log({
                                level: "trace",
                                category: "gateway",
                                code: "gateway.receive",
                                message: `Received opcode ${op} (${opcodeName(op) ?? "UNKNOWN"})`,
                                shardId,
                                fields: { opcode: op, bytes },
                            })
                        logger?.payload(
                            "gateway",
                            "gateway.payloadReceived",
                            `Received opcode ${op} payload`,
                            payload,
                            {
                                shardId,
                            },
                        )
                        switch (op) {
                            case Opcode.hello: {
                                const interval = readHello(body, receivedHello)
                                if (typeof interval !== "number") return protocolFailure(interval)
                                receivedHello = true
                                Deferred.doneUnsafe(hello, Effect.succeed(interval))
                                break
                            }
                            case Opcode.dispatch:
                                dispatch(payload, body, bytes)
                                break
                            case Opcode.heartbeat:
                                heartbeat()
                                break
                            case Opcode.heartbeatAck:
                                if (pendingHeartbeat !== undefined) {
                                    const latency = Math.max(0, now() - pendingHeartbeat)
                                    onLatency(latency)
                                    pendingHeartbeat = undefined
                                    if (logger?.enabled("trace", "gateway"))
                                        logger.log({
                                            level: "trace",
                                            category: "gateway",
                                            code: "gateway.heartbeatAck",
                                            message: "Heartbeat acknowledged",
                                            shardId,
                                            durationMs: latency,
                                        })
                                }
                                break
                            case Opcode.reconnect:
                                fail(
                                    new AttemptFailure(
                                        new ConnectionError("gateway", "closed", null, {
                                            details: { detail: "the gateway requested a reconnect" },
                                        }),
                                        true,
                                        false,
                                        "reconnectRequested",
                                    ),
                                )
                                break
                            case Opcode.invalidSession:
                                // Fluxer never sends d: true (opcodes-and-close-codes.md in fluxerapp/fluxer fluxer_docs)
                                if (body !== false)
                                    return protocolFailure(
                                        {
                                            detail: "received INVALID_SESSION with a resumable flag this SDK does not support",
                                            opcode: Opcode.invalidSession,
                                            field: "d",
                                        },
                                        false,
                                    )
                                fail(
                                    new AttemptFailure(
                                        new ConnectionError("gateway", "closed", null, {
                                            details: { detail: "the gateway invalidated the session" },
                                        }),
                                        true,
                                        true,
                                        "invalidSession",
                                    ),
                                )
                                break
                            default:
                                // Unknown server opcodes do not force a reconnect
                                logger?.drop("unknownOpcodes", {
                                    level: "debug",
                                    category: "gateway",
                                    code: "gateway.unknownOpcode",
                                    message: `Ignored opcode ${op}, which this SDK version does not handle`,
                                    shardId,
                                    fields: { opcode: op },
                                })
                        }
                    }
                    const onMessage = (data: SocketData, binary: boolean) => {
                        try {
                            processMessage(data, binary)
                        } catch (defect) {
                            Deferred.doneUnsafe(ended, Effect.die(defect))
                        }
                    }
                    const onError = (error: Error & { code?: string }) => {
                        if (stopping) return
                        const status = localRejectionStatus(error.code)
                        const transportCode =
                            typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)
                                ? error.code
                                : undefined
                        // Retrying a local receive rejection can replay the same rejected message indefinitely
                        fail(
                            new AttemptFailure(
                                new ConnectionError("gateway", status === null ? "network" : "protocol", status, {
                                    cause: new TransportError(error, "gateway connection"),
                                    details: {
                                        detail:
                                            status === null
                                                ? "the WebSocket transport failed"
                                                : "a received frame was rejected locally",
                                        ...(transportCode === undefined ? {} : { transportCode }),
                                    },
                                }),
                                status === null,
                                false,
                                status === null ? "network" : "protocol",
                            ),
                        )
                    }
                    const onClose = (code: number) => {
                        if (!stopping) fail(classifyClose(code, resuming && !receivedReady))
                    }
                    socket.on("message", onMessage)
                    socket.on("error", onError)
                    socket.on("close", onClose)
                    return {
                        socket,
                        heartbeat,
                        commands,
                        pacer,
                        detach: () => {
                            socket.off("message", onMessage)
                            socket.off("error", onError)
                            socket.off("close", onClose)
                        },
                    }
                }),
                (transport) =>
                    Effect.gen(function* () {
                        stopping = true
                        transport.pacer.close()
                        onLatency(null)
                        yield* closeSocket(transport.socket).pipe(Effect.ensuring(Effect.sync(transport.detach)))
                    }),
            )
            yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                    application?.detach()
                    presence?.detach()
                    counts?.detach()
                    memberChunks?.detach()
                }),
            )
            const { commands, pacer } = socket
            yield* Effect.forkScoped(pacer.run)
            const startup = Effect.gen(function* () {
                const interval = yield* Deferred.await(hello)
                yield* Effect.forkScoped(
                    Effect.forever(
                        Effect.gen(function* () {
                            yield* Effect.sleep(interval)
                            if (pendingHeartbeat !== undefined && now() - pendingHeartbeat >= interval) {
                                fail(
                                    new AttemptFailure(
                                        new ConnectionError("gateway", "network", null, {
                                            details: { detail: "the heartbeat acknowledgement timed out" },
                                        }),
                                        true,
                                        false,
                                        "heartbeatTimeout",
                                    ),
                                )
                            } else if (pendingHeartbeat === undefined) socket.heartbeat()
                        }),
                    ),
                )
                yield* !resuming && identify ? identify(commands.authenticate) : Effect.sync(commands.authenticate)
                yield* Deferred.await(ready)
            }).pipe(
                Effect.withSpan("fluxerly.gateway.connect", {
                    attributes: {
                        "fluxerly.mode": resuming ? "resume" : "identify",
                        ...(shardId === undefined ? {} : { "fluxerly.shard": shardId }),
                    },
                }),
                Effect.timeoutOrElse({
                    duration: timeoutMs,
                    orElse: () =>
                        Effect.fail(new AttemptFailure(new ConnectionTimeoutError(timeoutMs), true, false, "timeout")),
                }),
            )
            yield* Effect.raceFirst(startup, Deferred.await(ended))
            presence?.attach(commands.presence, commands.memberSubscriptions, resuming ? "resume" : "identify")
            counts?.attach(commands.guildCounts, commands.channelMemberCounts)
            memberChunks?.attach(commands.memberChunks)
            application?.attach(pacer.submit)
            onReady(resuming ? "resume" : "identify")
            return yield* Deferred.await(ended)
        }),
    )
