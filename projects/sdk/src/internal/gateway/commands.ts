/**
 * Outbound gateway commands: The one send path for heartbeat, Identify, Resume, presence, request commands and
 * application commands from gateway.send.
 * Invariant: A command is sent only on an open socket while the session is running, every send failure ends the attempt
 * as a retryable send failure, and credentials never reach log records because payload logging masks them.
 * Pacing: Session control (heartbeat, Identify and Resume) is sent immediately and never waits behind other commands.
 * Every other command shares one per-socket budget of applicationCommandBudget sends in any rolling
 * commandWindowMs window, sent in submission order. Fluxer accepts 600 client payloads per WebSocket in a rolling
 * 60-second window and 600 per session in each fixed 60-second bucket, and exceeding either closes with 4008, so the
 * remaining 100 payloads stay reserved for control commands, which the budget does not count.
 * Implements [SDK contracts: Connection and recovery](/docs/SDK-CONTRACTS.md#connection-and-recovery)
 */
import { platform } from "node:os"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import { ConnectionError } from "#sdk/errors"
import { TransportError } from "../effect-failures.js"
import type { ClientLogger } from "../logging.js"
import type { GatewayPresenceMemberSubscriptions, GatewayPresenceUpdate } from "../presence.js"
import { Opcode, opcodeName } from "../protocol/gateway.js"
import { SocketState, type GatewaySocket } from "../transport/index.js"
import type { Session } from "./session.js"

/** Paced sends one socket may make in any rolling commandWindowMs window, leaving 100 of Fluxer's 600 for control */
const applicationCommandBudget = 500
/** Length of the rolling pacing window in milliseconds, matching Fluxer's per-socket window */
const commandWindowMs = 60_000
/** Most gateway.send commands one socket holds while they wait for the pacing budget */
export const maxPendingApplicationCommands = 500

/** Send one command. Failures are reported through the session, never thrown. Returns whether the socket took the frame */
export type SendCommand = (op: number, d: unknown) => boolean

/** A failed send, reported with the transport failure as its cause when one exists */
export interface SendFailure {
    readonly error: ConnectionError
}

/** Build the session's send path over one socket */
export function commandSender(options: {
    readonly socket: GatewaySocket
    readonly logger: ClientLogger | undefined
    readonly shardId: number | undefined
    /** True once the session started closing, after which sends are skipped */
    readonly stopping: () => boolean
    /** End the attempt as a retryable send failure */
    readonly failed: (failure: SendFailure) => void
}): SendCommand {
    const { socket, logger, shardId, stopping, failed } = options
    return (op, d) => {
        if (stopping()) return false
        if (socket.readyState !== SocketState.open) {
            failed({
                error: new ConnectionError("gateway", "network", null, {
                    details: { detail: "the socket was not open for a gateway command" },
                }),
            })
            return false
        }
        if (logger?.enabled("trace", "gateway"))
            logger.log({
                level: "trace",
                category: "gateway",
                code: "gateway.send",
                message: `Sent opcode ${op} (${opcodeName(op) ?? "UNKNOWN"})`,
                shardId,
                fields: { opcode: op },
            })
        logger?.payload("gateway", "gateway.payloadSent", `Sent opcode ${op} payload`, { op, d }, { shardId })
        socket.send(JSON.stringify({ op, d }), (error) => {
            if (error && !stopping())
                failed({
                    error: new ConnectionError("gateway", "network", null, {
                        cause: new TransportError(error, "gateway send"),
                        details: { detail: "sending a gateway command failed" },
                    }),
                })
        })
        return true
    }
}

/** Why a gateway.send submission could not be handed to the socket */
export type SubmitFailure = "closed" | "busy"

/** One socket's paced path for every command except session control */
export interface CommandPacer {
    /** Send now when the budget allows and nothing waits, otherwise queue behind earlier commands */
    readonly send: (op: number, d: unknown) => void
    /** Queue one gateway.send command. Succeeds once the socket took the frame. Interruption withdraws an unsent command */
    readonly submit: (op: number, d: unknown) => Effect.Effect<void, SubmitFailure>
    /** Background loop that sends queued commands as the rolling budget frees. Fork it in the session scope */
    readonly run: Effect.Effect<never>
    /** Stop accepting commands and abandon queued ones, failing waiting submissions with closed */
    readonly close: () => void
}

interface PendingCommand {
    readonly op: number
    readonly d: unknown
    /** Present for gateway.send commands, told whether the socket took the frame */
    readonly settle: ((sent: boolean) => void) | undefined
    cancelled: boolean
}

/** Build the rolling-window pacer over a socket's send path */
export function commandPacer(options: {
    readonly send: SendCommand
    /** Monotonic milliseconds from the session's Clock */
    readonly now: () => number
    readonly logger: ClientLogger | undefined
    readonly shardId: number | undefined
    readonly budget?: number
    readonly windowMs?: number
}): CommandPacer {
    const { send, now, logger, shardId, budget = applicationCommandBudget, windowMs = commandWindowMs } = options
    /** Send times inside the current window, oldest first */
    const sentAt: number[] = []
    const queue: PendingCommand[] = []
    let pendingApplication = 0
    let closed = false
    let wake = Deferred.makeUnsafe<void>()
    const prune = (time: number) => {
        while (sentAt.length > 0 && sentAt[0]! <= time - windowMs) sentAt.shift()
    }
    const dispatch = (item: PendingCommand) => {
        const sent = send(item.op, item.d)
        if (sent) sentAt.push(now())
        if (item.settle) {
            pendingApplication -= 1
            if (sent)
                logger?.log({
                    level: "debug",
                    category: "gateway",
                    code: "gateway.commandSent",
                    message: `Sent a gateway.send command with opcode ${item.op} (${opcodeName(item.op) ?? "UNKNOWN"})`,
                    shardId,
                    fields: { opcode: item.op },
                })
            item.settle(sent)
        }
    }
    const enqueue = (item: PendingCommand) => {
        if (item.settle) pendingApplication += 1
        if (closed) {
            // Queued SDK commands are re-sent by their owners after the next READY, and waiting submissions fail
            if (item.settle) {
                pendingApplication -= 1
                item.settle(false)
            }
            return
        }
        if (queue.length === 0) {
            prune(now())
            if (sentAt.length < budget) return dispatch(item)
        }
        queue.push(item)
        Deferred.doneUnsafe(wake, Effect.void)
    }
    const run = Effect.gen(function* () {
        while (true) {
            yield* Deferred.await(wake)
            wake = Deferred.makeUnsafe<void>()
            while (queue.length > 0 && !closed) {
                const head = queue[0]!
                if (head.cancelled) {
                    queue.shift()
                    pendingApplication -= 1
                    continue
                }
                const time = now()
                prune(time)
                if (sentAt.length >= budget) {
                    yield* Effect.sleep(Math.max(1, sentAt[0]! + windowMs - time))
                    continue
                }
                queue.shift()
                dispatch(head)
            }
        }
    })
    return {
        send: (op, d) => enqueue({ op, d, settle: undefined, cancelled: false }),
        submit: (op, d) =>
            Effect.suspend(() => {
                if (closed) return Effect.fail("closed" as const)
                if (pendingApplication >= maxPendingApplicationCommands) return Effect.fail("busy" as const)
                const done = Deferred.makeUnsafe<boolean>()
                const item: PendingCommand = {
                    op,
                    d,
                    settle: (sent) => Deferred.doneUnsafe(done, Effect.succeed(sent)),
                    cancelled: false,
                }
                enqueue(item)
                return Deferred.await(done).pipe(
                    Effect.onInterrupt(() =>
                        Effect.sync(() => {
                            item.cancelled = true
                        }),
                    ),
                    Effect.flatMap((sent) => (sent ? Effect.void : Effect.fail("closed" as const))),
                )
            }),
        run: run as Effect.Effect<never>,
        close: () => {
            if (closed) return
            closed = true
            for (const item of queue.splice(0))
                if (item.settle && !item.cancelled) {
                    pendingApplication -= 1
                    item.settle(false)
                }
        },
    }
}

/** Optional Identify fields read when Identify is sent */
export interface IdentifyFields {
    /** Initial presence, from the latest presence.set intent or the configured gateway.presence */
    readonly presence?: GatewayPresenceUpdate | undefined
    /** Upper-case dispatch names Fluxer suppresses for this session. Omitted when empty */
    readonly ignoredEvents?: readonly string[] | undefined
    /** Session flags bitfield. Omitted when zero */
    readonly flags?: number | undefined
}

/** The commands a session sends after HELLO, and those it lends to presence, count and member-chunk owners */
export interface GatewayCommands {
    /** Send Resume when the session retained an ID and sequence at attempt start, otherwise Identify */
    readonly authenticate: () => void
    readonly presence: (update: GatewayPresenceUpdate) => void
    readonly memberSubscriptions: (subscriptions: GatewayPresenceMemberSubscriptions) => void
    readonly guildCounts: (guildIds: readonly string[], nonce: string) => void
    readonly memberChunks: (payload: Readonly<Record<string, unknown>>, nonce: string) => void
    readonly channelMemberCounts: (guildId: string, channelIds: readonly string[], nonce: string) => void
}

/** Build the typed commands over the immediate control path and the paced path */
export function gatewayCommands(
    control: SendCommand,
    paced: (op: number, d: unknown) => void,
    identity: {
        readonly token: Redacted.Redacted<string>
        /** Read at send time, so Resume carries the latest session ID and sequence */
        readonly session: Session
        readonly resuming: boolean
        /** Shard ID and count sent with Identify, when sharding is configured */
        readonly shard: readonly [number, number] | undefined
        /** Optional Identify fields, read when Identify is sent */
        readonly identify?: (() => IdentifyFields) | undefined
    },
): GatewayCommands {
    const { token, session, resuming, shard, identify } = identity
    return {
        authenticate: () => {
            if (resuming) {
                control(Opcode.resume, {
                    token: Redacted.value(token),
                    session_id: session.id,
                    seq: session.sequence,
                })
                return
            }
            const fields = identify?.() ?? {}
            control(Opcode.identify, {
                token: Redacted.value(token),
                properties: { os: platform(), browser: "Fluxerly.js", device: "Fluxerly.js" },
                ...(shard ? { shard } : {}),
                ...(fields.presence ? { presence: fields.presence } : {}),
                ...(fields.ignoredEvents?.length ? { ignored_events: fields.ignoredEvents } : {}),
                ...(fields.flags ? { flags: fields.flags } : {}),
            })
        },
        presence: (update) => paced(Opcode.presenceUpdate, update),
        memberSubscriptions: (subscriptions) => paced(Opcode.memberSubscriptions, subscriptions),
        guildCounts: (guildIds, nonce) => paced(Opcode.requestGuildCounts, { guild_ids: guildIds, nonce }),
        memberChunks: (payload, nonce) => paced(Opcode.requestGuildMembers, { ...payload, nonce }),
        channelMemberCounts: (guildId, channelIds, nonce) =>
            paced(Opcode.requestChannelMemberCounts, { guild_id: guildId, channel_ids: channelIds, nonce }),
    }
}
