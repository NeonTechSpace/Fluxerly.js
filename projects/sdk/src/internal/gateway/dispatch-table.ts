/**
 * Gateway dispatch table: One entry per known dispatch type with its decoder, cache effects and projection.
 * Invariant: An entry delivers nothing unless its decoder accepts the whole body, and cache effects always run before
 * subscriber delivery. Unknown types are counted and ignored, never treated as protocol failures.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import type { EventMap, EventName } from "#sdk/events"
import type { MessageCore } from "#sdk/messages"
import type { MessageDecoder } from "../message-fields.js"
import { decodeDeletion, decodeBulkDeletion } from "../message.js"
import { identifier, record } from "../decode/primitives.js"
import { decodeUser, decodeDirectMessage } from "../users.js"
import { decodeReaction, reactionEvents } from "../reactions.js"
import { decodePinsUpdate } from "../pins.js"
import {
    decodeGuildEvent,
    decodeGuildLifecycleEvent,
    decodeVoiceState,
    decodeVoiceStateSnapshot,
    guildEvents,
    guildLifecycleEvents,
} from "../guilds.js"
import { decodeChannelEvent, channelEvents } from "../channels.js"
import { decodeExpressionUpdate } from "../expressions.js"
import { decodeInviteDelete, decodeInviteMetadata } from "../invites.js"
import { decodeAuditLogEntry } from "../audit-logs.js"
import { decodePresenceUpdate, decodePresenceUpdateBulk, type PresenceGatewayOwner } from "../presence.js"
import type { CountGatewayOwner } from "../counts.js"
import type { MemberChunkOwner } from "../member-chunks.js"
import { decodeCallCreate, decodeCallDelete, decodeCallUpdate, decodeEntranceSoundPlay } from "../calls.js"

/** Decoder result for a well-formed dispatch the SDK deliberately does not deliver */
const ignored: unique symbol = Symbol("ignored dispatch")

/** Values a dispatch decoder depends on besides the body */
export interface DispatchContext {
    readonly messageDecoder: MessageDecoder<MessageCore>
    /** Invite URL base from instance discovery */
    readonly inviteBase: string
}

/** Where decoded dispatches go. Every sink is optional except subscriber delivery */
export interface DispatchSinks {
    /** Deliver a decoded event to the client's intake, which updates caches before subscribers see it */
    readonly emit: <K extends EventName>(event: K, value: EventMap<MessageCore>[K]) => void
    /** Guild and channel cache intake over the raw body. Present only when a resource cache is enabled */
    readonly guildCache?: ((type: string, body: unknown) => void) | undefined
    readonly presence?: Pick<PresenceGatewayOwner, "guildCreate"> | undefined
    readonly counts?: Pick<CountGatewayOwner, "receiveGuildCounts" | "receiveChannelMemberCounts"> | undefined
    readonly memberChunks?: Pick<MemberChunkOwner, "receive" | "rateLimited"> | undefined
    /** Received byte length of the whole frame, charged against subscriber and member-chunk budgets */
    readonly bytes: number
}

/** One dispatch type's handling */
interface DispatchEntry<V> {
    /** Cache intake that validates the raw body itself and runs before this entry's decoder */
    readonly rawCache?: (body: unknown, sinks: DispatchSinks, type: string) => void
    /** Validate and convert the body. A result of undefined marks it malformed, and ignored marks a valid body that is not delivered */
    readonly decode: (body: unknown, context: DispatchContext, type: string) => V | undefined | typeof ignored
    /** Cache intake that runs after successful decoding and before projection */
    readonly cache?: (value: V, body: unknown, sinks: DispatchSinks, type: string) => void
    /** Deliver the decoded value */
    readonly project: (value: V, sinks: DispatchSinks, type: string) => void
}

const entry = <V>(value: DispatchEntry<V>) => value as DispatchEntry<unknown>

/** Hand the raw body to an owner that validates it itself, including an absent body */
const passThrough = (body: unknown) => ({ body })

const guildCache = (body: unknown, sinks: DispatchSinks, type: string) => sinks.guildCache?.(type, body)

/** GUILD_CREATE carries an optional voice-state snapshot that is delivered after the guild itself */
interface GuildCreateDispatch {
    readonly guild: EventMap["guildCreate"]
    readonly voice: ReturnType<typeof decodeVoiceStateSnapshot>
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

function decodeRecipientChange(value: unknown) {
    if (!record(value) || !identifier(value.channel_id) || !record(value.user) || !identifier(value.user.id))
        return undefined
    return Object.freeze({ channelId: value.channel_id, userId: value.user.id })
}

function decodeWebhooksUpdate(value: unknown) {
    if (!record(value) || !identifier(value.guild_id) || !identifier(value.channel_id)) return undefined
    return Object.freeze({ guildId: value.guild_id, channelId: value.channel_id })
}

function decodeAuditLogEntryCreate(value: unknown): EventMap["guildAuditLogEntryCreate"] | undefined {
    const audit = decodeAuditLogEntry(value)
    if (
        !audit ||
        !record(value) ||
        !identifier(value.guild_id) ||
        !identifier(value.user_id) ||
        (value.target_id !== null && typeof value.target_id !== "string")
    )
        return undefined
    return Object.freeze({ ...audit, guildId: value.guild_id, userId: value.user_id, targetId: value.target_id })
}

/** Private conversations share the channel dispatch names, distinguished by an absent or null guild ID */
type ChannelDispatch =
    | { readonly kind: "directDelete"; readonly id: string }
    | { readonly kind: "direct"; readonly channel: NonNullable<ReturnType<typeof decodeDirectMessage>> }
    | { readonly kind: "guild"; readonly event: keyof typeof channelEvents; readonly value: unknown }

function decodeChannelDispatch(body: unknown, type: string): ChannelDispatch | undefined | typeof ignored {
    const event = type as keyof typeof channelEvents
    if (record(body) && (body.guild_id === undefined || body.guild_id === null)) {
        // Type 999 is a private conversation kind this SDK version does not project
        if (body.type === 999) return ignored
        if (type === "CHANNEL_DELETE" && identifier(body.id)) return { kind: "directDelete", id: body.id }
        const channel = decodeDirectMessage(body)
        return channel ? { kind: "direct", channel } : undefined
    }
    const value = decodeChannelEvent(event, body)
    return value ? { kind: "guild", event, value } : undefined
}

const entries: Record<string, DispatchEntry<unknown>> = {
    // Correlated request replies are validated by their owners, which match them to pending requests
    GUILD_MEMBERS_CHUNK: entry({
        decode: passThrough,
        project: ({ body }, sinks) => sinks.memberChunks?.receive(body, sinks.bytes),
    }),
    RATE_LIMITED: entry({
        decode: passThrough,
        project: ({ body }, sinks) => sinks.memberChunks?.rateLimited(body),
    }),
    GUILD_COUNTS_UPDATE: entry({
        decode: passThrough,
        project: ({ body }, sinks) => sinks.counts?.receiveGuildCounts(body),
    }),
    CHANNEL_MEMBER_COUNTS_UPDATE: entry({
        decode: passThrough,
        project: ({ body }, sinks) => sinks.counts?.receiveChannelMemberCounts(body),
    }),
    USER_UPDATE: entry({
        decode: (body) => decodeUser(body),
        project: (user, sinks) => sinks.emit("userUpdate", user),
    }),
    GUILD_CREATE: entry<GuildCreateDispatch>({
        decode: (body) => {
            // GUILD_CREATE decodes to the snapshot form with its new-join flag
            const guild = decodeGuildLifecycleEvent("GUILD_CREATE", body) as EventMap["guildCreate"] | undefined
            if (!guild) return undefined
            if (!record(body) || !Object.hasOwn(body, "voice_states")) return { guild, voice: undefined }
            const voice = decodeVoiceStateSnapshot(body)
            return voice ? { guild, voice } : undefined
        },
        cache: (_value, body, sinks, type) => guildCache(body, sinks, type),
        project: ({ guild, voice }, sinks) => {
            sinks.emit("guildCreate", guild)
            sinks.presence?.guildCreate(guild.id)
            if (voice) sinks.emit("voiceStateSnapshot", voice)
        },
    }),
    ...Object.fromEntries(
        (["GUILD_UPDATE", "GUILD_DELETE"] as const).map((type) => [
            type,
            entry({
                rawCache: guildCache,
                decode: (body) => decodeGuildLifecycleEvent(type, body),
                project: (update, sinks) => sinks.emit(guildLifecycleEvents[type], update),
            }),
        ]),
    ),
    VOICE_STATE_UPDATE: entry({
        // Private calls use the same dispatch name with an explicit null guild ID
        decode: (body) => (record(body) && body.guild_id === null ? ignored : decodeVoiceState(body)),
        project: (voiceState, sinks) => sinks.emit("voiceStateUpdate", voiceState),
    }),
    // Private calls and entrance sounds are notices only and never write a cache
    CALL_CREATE: entry({
        decode: decodeCallCreate,
        project: (call, sinks) => sinks.emit("callCreate", call),
    }),
    CALL_UPDATE: entry({
        decode: decodeCallUpdate,
        project: (call, sinks) => sinks.emit("callUpdate", call),
    }),
    CALL_DELETE: entry({
        decode: decodeCallDelete,
        project: (call, sinks) => sinks.emit("callDelete", call),
    }),
    ENTRANCE_SOUND_PLAY: entry({
        decode: decodeEntranceSoundPlay,
        project: (sound, sinks) => sinks.emit("entranceSoundPlay", sound),
    }),
    PRESENCE_UPDATE: entry({
        decode: (body) => decodePresenceUpdate(body),
        project: (presence, sinks) => sinks.emit("presenceUpdate", presence),
    }),
    PRESENCE_UPDATE_BULK: entry({
        decode: (body) => decodePresenceUpdateBulk(body),
        project: (presences, sinks) => sinks.emit("presenceUpdateBulk", presences),
    }),
    GUILD_EMOJIS_UPDATE: entry({
        rawCache: guildCache,
        decode: (body) => decodeExpressionUpdate("emojis", body),
        project: (update, sinks) => sinks.emit("guildEmojisUpdate", update),
    }),
    GUILD_STICKERS_UPDATE: entry({
        rawCache: guildCache,
        decode: (body) => decodeExpressionUpdate("stickers", body),
        project: (update, sinks) => sinks.emit("guildStickersUpdate", update),
    }),
    CHANNEL_RECIPIENT_ADD: entry({
        decode: decodeRecipientChange,
        project: (change, sinks) => sinks.emit("directMessageRecipientAdd", change),
    }),
    CHANNEL_RECIPIENT_REMOVE: entry({
        decode: decodeRecipientChange,
        project: (change, sinks) => sinks.emit("directMessageRecipientRemove", change),
    }),
    WEBHOOKS_UPDATE: entry({
        decode: decodeWebhooksUpdate,
        project: (update, sinks) => sinks.emit("webhooksUpdate", update),
    }),
    INVITE_CREATE: entry({
        decode: (body, context) => decodeInviteMetadata(body, context.inviteBase),
        project: (invite, sinks) => sinks.emit("inviteCreate", invite),
    }),
    INVITE_DELETE: entry({
        decode: (body) => decodeInviteDelete(body),
        project: (invite, sinks) => sinks.emit("inviteDelete", invite),
    }),
    GUILD_AUDIT_LOG_ENTRY_CREATE: entry({
        decode: decodeAuditLogEntryCreate,
        project: (audit, sinks) => sinks.emit("guildAuditLogEntryCreate", audit),
    }),
    MESSAGE_CREATE: entry({
        decode: (body, context) => context.messageDecoder(body),
        project: (message, sinks) => sinks.emit("messageCreate", message),
    }),
    MESSAGE_UPDATE: entry({
        decode: (body, context) => context.messageDecoder(body),
        project: (message, sinks) => sinks.emit("messageUpdate", message),
    }),
    TYPING_START: entry({
        decode: decodeTypingStart,
        project: (typing, sinks) => sinks.emit("typingStart", typing),
    }),
    ...Object.fromEntries(
        (Object.keys(guildEvents) as (keyof typeof guildEvents)[]).map((type) => [
            type,
            entry({
                decode: (body) => decodeGuildEvent(type, body),
                project: (update, sinks) => sinks.emit(guildEvents[type], update as never),
            }),
        ]),
    ),
    ...Object.fromEntries(
        Object.keys(channelEvents).map((type) => [
            type,
            entry<ChannelDispatch>({
                decode: (body, _context, type) => decodeChannelDispatch(body, type),
                project: (value, sinks, type) => {
                    if (value.kind === "directDelete")
                        sinks.emit("directMessageDelete", Object.freeze({ id: value.id }))
                    else if (value.kind === "direct")
                        sinks.emit(
                            type === "CHANNEL_CREATE" ? "directMessageCreate" : "directMessageUpdate",
                            value.channel,
                        )
                    else sinks.emit(channelEvents[value.event], value.value as never)
                },
            }),
        ]),
    ),
    CHANNEL_PINS_UPDATE: entry({
        decode: (body) => decodePinsUpdate(body),
        project: (update, sinks) => sinks.emit("channelPinsUpdate", update),
    }),
    MESSAGE_DELETE: entry({
        decode: (body) => decodeDeletion(body),
        project: (deletion, sinks) => sinks.emit("messageDelete", deletion),
    }),
    MESSAGE_DELETE_BULK: entry({
        decode: (body) => decodeBulkDeletion(body),
        project: (deletion, sinks) => sinks.emit("messageDeleteBulk", deletion),
    }),
    ...Object.fromEntries(
        (Object.keys(reactionEvents) as (keyof typeof reactionEvents)[]).map((type) => [
            type,
            entry({
                decode: (body) => decodeReaction(type, body),
                project: (reaction, sinks) => sinks.emit(reactionEvents[type], reaction as never),
            }),
        ]),
    ),
}

/** Dispatch types the SDK knows. READY and RESUMED are session control, handled before this table */
const dispatchTable: Readonly<Record<string, DispatchEntry<unknown>>> = Object.freeze(entries)

/** Result of routing one dispatch through the table */
export type DispatchResult =
    | { readonly kind: "delivered" | "ignored" | "unknown" }
    /** The body failed its decoder. The decode step re-runs it on a copy to locate the failing field */
    | { readonly kind: "malformed"; readonly decode: (body: unknown) => unknown }

/** Decode, apply cache effects and project one dispatch in that order */
export function routeDispatch(
    type: string,
    body: unknown,
    context: DispatchContext,
    sinks: DispatchSinks,
): DispatchResult {
    if (!Object.hasOwn(dispatchTable, type)) return { kind: "unknown" }
    const handler = dispatchTable[type]!
    handler.rawCache?.(body, sinks, type)
    const value = handler.decode(body, context, type)
    if (value === ignored) return { kind: "ignored" }
    if (value === undefined) return { kind: "malformed", decode: (copy) => handler.decode(copy, context, type) }
    handler.cache?.(value, body, sinks, type)
    handler.project(value, sinks, type)
    return { kind: "delivered" }
}
