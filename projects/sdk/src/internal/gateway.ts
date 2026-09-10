import { platform } from "node:os"
import type { EventMap, EventName } from "#sdk/events"
import { decodeMessage, decodeDeletion, decodeBulkDeletion, record, identifier } from "./message.js"
import { decodeUser, decodeDirectMessage } from "./users.js"
import { decodeReaction, reactionEvents } from "./reactions.js"
import { decodePinsUpdate } from "./pins.js"
import { decodeGuildEvent, decodeGuildLifecycleEvent, guildEvents, guildLifecycleEvents } from "./guilds.js"
import { decodeChannelEvent, channelEvents } from "./channels.js"
import { decodeExpressionUpdate } from "./expressions.js"
import { decodeInviteDelete, decodeInviteMetadata } from "./invites.js"
import { decodeAuditLogEntry } from "./audit-logs.js"
import {
    decodePresenceUpdate,
    decodePresenceUpdateBulk,
    type GatewayPresenceMemberSubscriptions,
    type GatewayPresenceUpdate,
    type PresenceGatewayOwner,
} from "./presence.js"
import type { CountGatewayOwner } from "./counts.js"
import type { MemberChunkOwner } from "./member-chunks.js"
import { Clock, Deferred, Effect, Redacted } from "effect"
import WebSocket from "ws"
import {
    AuthenticationError,
    ConnectionError,
    ConnectionTimeoutError,
    RateLimitError,
    type ConnectionFailure,
} from "#sdk/errors"

export interface Session {
    id: string | undefined
    sequence: number | null
}

function decodeTypingStart(value: unknown): EventMap["typingStart"] | undefined {
    if (
        !record(value) ||
        !identifier(value.channel_id) ||
        !identifier(value.user_id) ||
        typeof value.timestamp !== "number" ||
        !Number.isSafeInteger(value.timestamp) ||
        value.timestamp < 0 ||
        (value.guild_id !== undefined && value.guild_id !== null && !identifier(value.guild_id))
    )
        return undefined
    return Object.freeze({
        channelId: value.channel_id,
        userId: value.user_id,
        timestamp: value.timestamp,
        ...(typeof value.guild_id === "string" ? { guildId: value.guild_id } : {}),
    })
}

/** Retry metadata is internal, not a promise that arbitrary consumer actions are repeatable */
export class AttemptFailure {
    readonly _tag = "AttemptFailure"
    constructor(
        readonly failure: ConnectionFailure,
        readonly retry: boolean,
        readonly resetSession = false,
    ) {}
}

export function classifyClose(code: number, resuming: boolean): AttemptFailure {
    if (code === 4004) return new AttemptFailure(new AuthenticationError(), false)
    if (code === 4008) return new AttemptFailure(new RateLimitError("gateway", null), true)
    const permanent = [4001, 4002, 4003, 4005, 4010, 4011, 4012].includes(code)
    return new AttemptFailure(
        new ConnectionError("gateway", permanent ? "protocol" : "closed", code),
        !permanent,
        code === 4007 && resuming,
    )
}

function closeSocket(socket: WebSocket) {
    return Effect.gen(function* () {
        if (socket.readyState === WebSocket.CLOSED) return
        const closed = Effect.callback<void>((resume) => {
            const onClose = () => resume(Effect.void)
            socket.once("close", onClose)
            if (socket.readyState === WebSocket.CLOSED) onClose()
            return Effect.sync(() => socket.off("close", onClose))
        })
        yield* Effect.sync(() => {
            if (socket.readyState === WebSocket.CONNECTING) socket.terminate()
            else socket.close(1000)
        }).pipe(
            Effect.onExit((exit) =>
                exit._tag === "Failure"
                    ? Effect.sync(() => socket.terminate()).pipe(Effect.andThen(closed))
                    : Effect.void,
            ),
        )
        yield* closed.pipe(
            Effect.timeoutOrElse({
                duration: 5_000,
                orElse: () =>
                    Effect.gen(function* () {
                        socket.terminate()
                        yield* closed
                    }),
            }),
        )
    })
}

/** One uncompressed protocol-v1 session, owned by the calling Effect scope */
export const runGateway = (
    url: string,
    token: Redacted.Redacted<string>,
    session: Session,
    timeoutMs: number,
    onReady: (mode: "identify" | "resume") => void,
    onLatency: (milliseconds: number | null) => void,
    onRecovering: () => void,
    onDispatch: <K extends EventName>(event: K, message: EventMap[K], bytes: number) => void,
    onGuild?: (event: string, value: unknown) => void,
    presence?: PresenceGatewayOwner,
    counts?: CountGatewayOwner,
    memberChunks?: Pick<MemberChunkOwner, "attach" | "detach" | "receive" | "rateLimited">,
    shard?: readonly [number, number],
    identify?: (send: () => void) => Effect.Effect<void>,
    inviteBase = "https://fluxer.gg",
) =>
    Effect.scoped(
        Effect.gen(function* () {
            const clock = yield* Clock.Clock
            const now = () => Number(clock.monotonicTimeNanosUnsafe()) / 1_000_000
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
            const protocolFailure = () => fail(new AttemptFailure(new ConnectionError("gateway", "protocol"), false))
            const socket = yield* Effect.acquireRelease(
                Effect.sync(() => {
                    const socket = new WebSocket(url, { perMessageDeflate: false, followRedirects: false })
                    const send = (op: number, d: unknown) => {
                        if (stopping) return
                        if (socket.readyState !== WebSocket.OPEN) {
                            fail(new AttemptFailure(new ConnectionError("gateway", "network"), true))
                            return
                        }
                        socket.send(JSON.stringify({ op, d }), (error) => {
                            if (error && !stopping)
                                fail(new AttemptFailure(new ConnectionError("gateway", "network"), true))
                        })
                    }
                    const heartbeat = () => {
                        // Server requests must be answered even while a previous ACK is pending
                        pendingHeartbeat ??= now()
                        send(1, session.sequence)
                    }
                    const processMessage = (data: WebSocket.RawData, binary: boolean) => {
                        if (stopping) return
                        if (binary) {
                            protocolFailure()
                            return
                        }
                        let payload: unknown
                        try {
                            payload = JSON.parse(data.toString())
                        } catch {
                            protocolFailure()
                            return
                        }
                        if (
                            typeof payload !== "object" ||
                            payload === null ||
                            !("op" in payload) ||
                            !Number.isInteger(payload.op)
                        ) {
                            protocolFailure()
                            return
                        }
                        const body = "d" in payload ? payload.d : undefined
                        switch (payload.op) {
                            case 10: {
                                if (
                                    receivedHello ||
                                    typeof body !== "object" ||
                                    body === null ||
                                    !("heartbeat_interval" in body) ||
                                    typeof body.heartbeat_interval !== "number" ||
                                    !Number.isSafeInteger(body.heartbeat_interval) ||
                                    body.heartbeat_interval <= 0 ||
                                    body.heartbeat_interval > 2_147_483_647
                                ) {
                                    protocolFailure()
                                    return
                                }
                                receivedHello = true
                                Deferred.doneUnsafe(hello, Effect.succeed(body.heartbeat_interval))
                                break
                            }
                            case 0: {
                                if (
                                    !receivedHello ||
                                    !("s" in payload) ||
                                    typeof payload.s !== "number" ||
                                    !Number.isSafeInteger(payload.s) ||
                                    payload.s < 0 ||
                                    !("t" in payload) ||
                                    typeof payload.t !== "string"
                                ) {
                                    protocolFailure()
                                    return
                                }
                                if (payload.t === "READY") {
                                    if (
                                        receivedReady ||
                                        resuming ||
                                        typeof body !== "object" ||
                                        body === null ||
                                        !("session_id" in body) ||
                                        typeof body.session_id !== "string" ||
                                        !body.session_id ||
                                        (shard !== undefined &&
                                            (!("shard" in body) ||
                                                !Array.isArray(body.shard) ||
                                                body.shard.length !== 2 ||
                                                body.shard[0] !== shard[0] ||
                                                body.shard[1] !== shard[1]))
                                    ) {
                                        protocolFailure()
                                        return
                                    }
                                    session.id = body.session_id
                                    receivedReady = true
                                } else if (payload.t === "RESUMED") {
                                    if (!resuming || receivedReady) {
                                        protocolFailure()
                                        return
                                    }
                                    receivedReady = true
                                } else if (!resuming && !receivedReady) {
                                    protocolFailure()
                                    return
                                }
                                if (session.sequence !== null && payload.s < session.sequence) {
                                    protocolFailure()
                                    return
                                }
                                session.sequence = payload.s
                                if (
                                    payload.t === "GUILD_CREATE" ||
                                    payload.t === "GUILD_UPDATE" ||
                                    payload.t === "GUILD_DELETE" ||
                                    payload.t === "GUILD_EMOJIS_UPDATE" ||
                                    payload.t === "GUILD_STICKERS_UPDATE"
                                )
                                    onGuild?.(payload.t, body)
                                if (payload.t === "GUILD_MEMBERS_CHUNK") {
                                    memberChunks?.receive(body, Buffer.byteLength(data.toString()))
                                } else if (payload.t === "RATE_LIMITED") {
                                    memberChunks?.rateLimited(body)
                                } else if (payload.t === "GUILD_COUNTS_UPDATE") {
                                    counts?.receiveGuildCounts(body)
                                } else if (payload.t === "CHANNEL_MEMBER_COUNTS_UPDATE") {
                                    counts?.receiveChannelMemberCounts(body)
                                } else if (payload.t === "USER_UPDATE") {
                                    const user = decodeUser(body)
                                    if (!user) {
                                        protocolFailure()
                                        return
                                    }
                                    onDispatch("userUpdate", user, Buffer.byteLength(data.toString()))
                                } else if (Object.hasOwn(guildLifecycleEvents, payload.t)) {
                                    const event = payload.t as keyof typeof guildLifecycleEvents
                                    const update = decodeGuildLifecycleEvent(event, body)
                                    if (!update) {
                                        protocolFailure()
                                        return
                                    }
                                    onDispatch(guildLifecycleEvents[event], update, Buffer.byteLength(data.toString()))
                                    if (payload.t === "GUILD_CREATE") presence?.guildCreate(update.id)
                                } else if (payload.t === "PRESENCE_UPDATE") {
                                    const presence = decodePresenceUpdate(body)
                                    if (!presence) {
                                        protocolFailure()
                                        return
                                    }
                                    onDispatch("presenceUpdate", presence, Buffer.byteLength(data.toString()))
                                } else if (payload.t === "PRESENCE_UPDATE_BULK") {
                                    const presences = decodePresenceUpdateBulk(body)
                                    if (!presences) {
                                        protocolFailure()
                                        return
                                    }
                                    onDispatch("presenceUpdateBulk", presences, Buffer.byteLength(data.toString()))
                                } else if (
                                    payload.t === "GUILD_EMOJIS_UPDATE" ||
                                    payload.t === "GUILD_STICKERS_UPDATE"
                                ) {
                                    const update = decodeExpressionUpdate(
                                        payload.t === "GUILD_EMOJIS_UPDATE" ? "emojis" : "stickers",
                                        body,
                                    )
                                    if (!update) {
                                        protocolFailure()
                                        return
                                    }
                                    onDispatch(
                                        payload.t === "GUILD_EMOJIS_UPDATE"
                                            ? "guildEmojisUpdate"
                                            : "guildStickersUpdate",
                                        update,
                                        Buffer.byteLength(data.toString()),
                                    )
                                } else if (
                                    payload.t === "CHANNEL_RECIPIENT_ADD" ||
                                    payload.t === "CHANNEL_RECIPIENT_REMOVE"
                                ) {
                                    if (
                                        !record(body) ||
                                        !identifier(body.channel_id) ||
                                        !record(body.user) ||
                                        !identifier(body.user.id)
                                    ) {
                                        protocolFailure()
                                        return
                                    }
                                    onDispatch(
                                        payload.t === "CHANNEL_RECIPIENT_ADD"
                                            ? "directMessageRecipientAdd"
                                            : "directMessageRecipientRemove",
                                        Object.freeze({ channelId: body.channel_id, userId: body.user.id }),
                                        Buffer.byteLength(data.toString()),
                                    )
                                } else if (payload.t === "WEBHOOKS_UPDATE") {
                                    if (!record(body) || !identifier(body.guild_id) || !identifier(body.channel_id)) {
                                        protocolFailure()
                                        return
                                    }
                                    onDispatch(
                                        "webhooksUpdate",
                                        Object.freeze({ guildId: body.guild_id, channelId: body.channel_id }),
                                        Buffer.byteLength(data.toString()),
                                    )
                                } else if (payload.t === "INVITE_CREATE") {
                                    const invite = decodeInviteMetadata(body, inviteBase)
                                    if (!invite) {
                                        protocolFailure()
                                        return
                                    }
                                    onDispatch("inviteCreate", invite, Buffer.byteLength(data.toString()))
                                } else if (payload.t === "INVITE_DELETE") {
                                    const invite = decodeInviteDelete(body)
                                    if (!invite) {
                                        protocolFailure()
                                        return
                                    }
                                    onDispatch("inviteDelete", invite, Buffer.byteLength(data.toString()))
                                } else if (payload.t === "GUILD_AUDIT_LOG_ENTRY_CREATE") {
                                    const audit = decodeAuditLogEntry(body)
                                    if (
                                        !audit ||
                                        !record(body) ||
                                        !identifier(body.guild_id) ||
                                        !identifier(body.user_id) ||
                                        (body.target_id !== null && typeof body.target_id !== "string")
                                    ) {
                                        protocolFailure()
                                        return
                                    }
                                    onDispatch(
                                        "guildAuditLogEntryCreate",
                                        Object.freeze({
                                            ...audit,
                                            guildId: body.guild_id,
                                            userId: body.user_id,
                                            targetId: body.target_id,
                                        }),
                                        Buffer.byteLength(data.toString()),
                                    )
                                } else if (payload.t === "MESSAGE_CREATE" || payload.t === "MESSAGE_UPDATE") {
                                    const message = decodeMessage(body)
                                    if (!message) {
                                        protocolFailure()
                                        return
                                    }
                                    onDispatch(
                                        payload.t === "MESSAGE_CREATE" ? "messageCreate" : "messageUpdate",
                                        message,
                                        Buffer.byteLength(data.toString()),
                                    )
                                } else if (payload.t === "TYPING_START") {
                                    const typing = decodeTypingStart(body)
                                    if (!typing) {
                                        protocolFailure()
                                        return
                                    }
                                    onDispatch("typingStart", typing, Buffer.byteLength(data.toString()))
                                } else if (Object.hasOwn(guildEvents, payload.t)) {
                                    const event = payload.t as keyof typeof guildEvents
                                    const update = decodeGuildEvent(event, body)
                                    if (!update) {
                                        protocolFailure()
                                        return
                                    }
                                    onDispatch(guildEvents[event], update, Buffer.byteLength(data.toString()))
                                } else if (Object.hasOwn(channelEvents, payload.t)) {
                                    if (record(body) && (body.guild_id === undefined || body.guild_id === null)) {
                                        if (body.type === 999) return
                                        if (payload.t === "CHANNEL_DELETE" && identifier(body.id))
                                            onDispatch(
                                                "directMessageDelete",
                                                Object.freeze({ id: body.id }),
                                                Buffer.byteLength(data.toString()),
                                            )
                                        else {
                                            const channel = decodeDirectMessage(body)
                                            if (!channel) {
                                                protocolFailure()
                                                return
                                            }
                                            onDispatch(
                                                payload.t === "CHANNEL_CREATE"
                                                    ? "directMessageCreate"
                                                    : "directMessageUpdate",
                                                channel,
                                                Buffer.byteLength(data.toString()),
                                            )
                                        }
                                        return
                                    }
                                    const event = payload.t as keyof typeof channelEvents
                                    const update = decodeChannelEvent(event, body)
                                    if (!update) {
                                        protocolFailure()
                                        return
                                    }
                                    onDispatch(channelEvents[event], update, Buffer.byteLength(data.toString()))
                                } else if (payload.t === "CHANNEL_PINS_UPDATE") {
                                    const update = decodePinsUpdate(body)
                                    if (!update) {
                                        protocolFailure()
                                        return
                                    }
                                    onDispatch("channelPinsUpdate", update, Buffer.byteLength(data.toString()))
                                } else if (payload.t === "MESSAGE_DELETE") {
                                    const deletion = decodeDeletion(body)
                                    if (!deletion) {
                                        protocolFailure()
                                        return
                                    }
                                    onDispatch("messageDelete", deletion, Buffer.byteLength(data.toString()))
                                } else if (payload.t === "MESSAGE_DELETE_BULK") {
                                    const deletion = decodeBulkDeletion(body)
                                    if (!deletion) {
                                        protocolFailure()
                                        return
                                    }
                                    onDispatch("messageDeleteBulk", deletion, Buffer.byteLength(data.toString()))
                                } else if (Object.hasOwn(reactionEvents, payload.t)) {
                                    const event = payload.t as keyof typeof reactionEvents
                                    const reaction = decodeReaction(event, body)
                                    if (!reaction) {
                                        protocolFailure()
                                        return
                                    }
                                    onDispatch(reactionEvents[event], reaction, Buffer.byteLength(data.toString()))
                                }
                                if (payload.t === "READY" || payload.t === "RESUMED")
                                    Deferred.doneUnsafe(ready, Effect.void)
                                break
                            }
                            case 1:
                                heartbeat()
                                break
                            case 11:
                                if (pendingHeartbeat !== undefined) {
                                    onLatency(Math.max(0, now() - pendingHeartbeat))
                                    pendingHeartbeat = undefined
                                }
                                break
                            case 7:
                                fail(new AttemptFailure(new ConnectionError("gateway", "closed"), true))
                                break
                            case 9:
                                if (body !== false) {
                                    protocolFailure()
                                    return
                                }
                                fail(new AttemptFailure(new ConnectionError("gateway", "closed"), true, true))
                                break
                            // Unknown server opcodes do not force a reconnect
                        }
                    }
                    const onMessage = (data: WebSocket.RawData, binary: boolean) => {
                        try {
                            processMessage(data, binary)
                        } catch (defect) {
                            Deferred.doneUnsafe(ended, Effect.die(defect))
                        }
                    }
                    const onError = () => {
                        if (!stopping) fail(new AttemptFailure(new ConnectionError("gateway", "network"), true))
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
                        authenticate: () => {
                            if (resuming)
                                send(6, {
                                    token: Redacted.value(token),
                                    session_id: session.id,
                                    seq: session.sequence,
                                })
                            else
                                send(2, {
                                    token: Redacted.value(token),
                                    properties: { os: platform(), browser: "Fluxerly.js", device: "Fluxerly.js" },
                                    ...(shard ? { shard } : {}),
                                })
                        },
                        presence: (update: GatewayPresenceUpdate) => send(3, update),
                        memberSubscriptions: (subscriptions: GatewayPresenceMemberSubscriptions) =>
                            send(14, subscriptions),
                        guildCounts: (guildIds: readonly string[], nonce: string) =>
                            send(15, { guild_ids: guildIds, nonce }),
                        memberChunks: (payload: Readonly<Record<string, unknown>>, nonce: string) =>
                            send(8, { ...payload, nonce }),
                        channelMemberCounts: (guildId: string, channelIds: readonly string[], nonce: string) =>
                            send(16, { guild_id: guildId, channel_ids: channelIds, nonce }),
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
                        onLatency(null)
                        yield* closeSocket(transport.socket).pipe(Effect.ensuring(Effect.sync(transport.detach)))
                    }),
            )
            yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                    presence?.detach()
                    counts?.detach()
                    memberChunks?.detach()
                }),
            )
            const startup = Effect.gen(function* () {
                const interval = yield* Deferred.await(hello)
                yield* Effect.forkScoped(
                    Effect.forever(
                        Effect.gen(function* () {
                            yield* Effect.sleep(interval)
                            if (pendingHeartbeat !== undefined && now() - pendingHeartbeat >= interval) {
                                fail(new AttemptFailure(new ConnectionError("gateway", "network"), true))
                            } else if (pendingHeartbeat === undefined) socket.heartbeat()
                        }),
                    ),
                )
                yield* !resuming && identify ? identify(socket.authenticate) : Effect.sync(socket.authenticate)
                yield* Deferred.await(ready)
            }).pipe(
                Effect.timeoutOrElse({
                    duration: timeoutMs,
                    orElse: () => Effect.fail(new AttemptFailure(new ConnectionTimeoutError(timeoutMs), true)),
                }),
            )
            yield* Effect.raceFirst(startup, Deferred.await(ended))
            presence?.attach(socket.presence, socket.memberSubscriptions, resuming ? "resume" : "identify")
            counts?.attach(socket.guildCounts, socket.channelMemberCounts)
            memberChunks?.attach(socket.memberChunks)
            onReady(resuming ? "resume" : "identify")
            return yield* Deferred.await(ended)
        }),
    )
