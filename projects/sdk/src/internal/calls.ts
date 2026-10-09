/**
 * Private-call and entrance-sound gateway decoders: CALL_CREATE, CALL_UPDATE, CALL_DELETE and ENTRANCE_SOUND_PLAY.
 * Invariant: A decoder accepts the whole body or nothing, projects frozen camelCase copies, and drops the call voice-state
 * routing fields region_id and server_id, which Fluxer requires clients to ignore. None of these events touch a cache.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import type { CallCreate, CallDelete, CallUpdate, CallVoiceState, EntranceSoundPlay } from "#sdk/events"
import { identifier, nonNegativeInteger, record } from "./decode/primitives.js"
import { decodeVoiceState } from "./guilds.js"

/** Stand-in server ID that lets the shared voice-state decoder validate a call entry, removed again after decoding */
const callScope = "0"

/**
 * Decode one call participant with the shared voice-state rules. The entry's guild ID must be null or absent.
 * A call has no community, so the member field is ignored rather than decoded against the stand-in server ID
 */
function decodeCallVoiceState(value: unknown): CallVoiceState | undefined {
    if (!record(value) || (value.guild_id !== undefined && value.guild_id !== null)) return undefined
    const state = decodeVoiceState({ ...value, guild_id: callScope, member: null })
    if (!state) return undefined
    const { guildId: _guildId, ...call } = state
    return Object.freeze(call)
}

/** A frozen copy of an array of decimal IDs, or undefined when any entry is not one */
function identifiers(value: unknown): readonly string[] | undefined {
    if (!Array.isArray(value)) return undefined
    const ids: string[] = []
    for (const item of value as readonly unknown[]) {
        if (!identifier(item)) return undefined
        ids.push(item)
    }
    return Object.freeze(ids)
}

function decodeCallState(value: unknown): CallUpdate | undefined {
    if (
        !record(value) ||
        !identifier(value.channel_id) ||
        !identifier(value.message_id) ||
        (value.region !== null && typeof value.region !== "string") ||
        !Array.isArray(value.voice_states)
    )
        return undefined
    const ringingUserIds = identifiers(value.ringing)
    if (!ringingUserIds) return undefined
    const voiceStates: CallVoiceState[] = []
    for (const item of value.voice_states as readonly unknown[]) {
        const state = decodeCallVoiceState(item)
        if (!state) return undefined
        voiceStates.push(state)
    }
    return {
        channelId: value.channel_id,
        messageId: value.message_id,
        region: value.region,
        ringingUserIds,
        voiceStates: Object.freeze(voiceStates),
    }
}

/** CALL_UPDATE: The current ringing set, participants and region. Recipient and creation fields are not part of an update */
export function decodeCallUpdate(value: unknown): CallUpdate | undefined {
    const call = decodeCallState(value)
    return call && Object.freeze(call)
}

/** CALL_CREATE: Current call state plus the recipients and creation time that initial or recovered state carries */
export function decodeCallCreate(value: unknown): CallCreate | undefined {
    const call = decodeCallState(value)
    if (!call || !record(value)) return undefined
    const recipientIds = value.recipients === undefined ? undefined : identifiers(value.recipients)
    if (value.recipients !== undefined && !recipientIds) return undefined
    if (value.created_at !== undefined && !nonNegativeInteger(value.created_at)) return undefined
    return Object.freeze({
        ...call,
        ...(recipientIds === undefined ? {} : { recipientIds }),
        ...(typeof value.created_at === "number" ? { createdAtMs: value.created_at } : {}),
    })
}

/** CALL_DELETE: An absent unavailable flag means the call ended */
export function decodeCallDelete(value: unknown): CallDelete | undefined {
    if (
        !record(value) ||
        !identifier(value.channel_id) ||
        (value.unavailable !== undefined && typeof value.unavailable !== "boolean")
    )
        return undefined
    return Object.freeze({ channelId: value.channel_id, unavailable: value.unavailable === true })
}

/** ENTRANCE_SOUND_PLAY: A null guild ID marks a private call */
export function decodeEntranceSoundPlay(value: unknown): EntranceSoundPlay | undefined {
    if (
        !record(value) ||
        !identifier(value.user_id) ||
        !identifier(value.channel_id) ||
        (value.guild_id !== null && !identifier(value.guild_id)) ||
        !identifier(value.sound_id) ||
        typeof value.hash !== "string" ||
        typeof value.url !== "string" ||
        value.url.length === 0 ||
        !nonNegativeInteger(value.duration_ms) ||
        typeof value.content_type !== "string"
    )
        return undefined
    return Object.freeze({
        userId: value.user_id,
        channelId: value.channel_id,
        guildId: value.guild_id,
        soundId: value.sound_id,
        hash: value.hash,
        url: value.url,
        durationMs: value.duration_ms,
        contentType: value.content_type,
    })
}
