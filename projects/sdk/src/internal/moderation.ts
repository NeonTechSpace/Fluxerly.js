/**
 * Moderation operations: Timeouts, kicks, bans and ban pages.
 * Invariant: A dispatched moderation request invalidates its guarded resources, not only an uncertain one.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import type {
    BanInput,
    GuildBan,
    GuildMember,
    MemberReference,
    ModerationOptions,
    TimeoutOptions,
    VoiceConnectionReference,
} from "#sdk/guilds"
import { identifier, integerInRange as integer, record } from "./decode/primitives.js"
import { decodeMember, memberFetch, type GuildRequest } from "./guilds.js"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"
import { timestamp } from "./decode/timestamp.js"
import { normalizedText as text } from "./field-text.js"
import { auditSettings as validateAuditSettings } from "./audit.js"

export function auditSettings(
    options?: ModerationOptions,
): { readonly moderation: true; readonly auditReason?: string } | InputValidationFailure {
    const settings = validateAuditSettings(options)
    return settings instanceof InputValidationFailure ? settings : { moderation: true as const, ...settings }
}

function timeoutSettings(
    options?: TimeoutOptions,
): { readonly moderation: true; readonly auditReason?: string } | InputValidationFailure {
    const settings = auditSettings(options)
    if (settings instanceof InputValidationFailure) return settings
    const reason = options?.timeoutReason
    if (reason !== undefined && reason !== null && !text(reason, 1, 512))
        return inputValidationFailure(
            "options.timeoutReason",
            "length",
            "Timeout reason must contain 1 through 512 UTF-16 code units after Fluxer's normalization",
        )
    return settings
}

export function memberTimeout(
    target: MemberReference,
    durationMs: number | null,
    options?: TimeoutOptions,
    clear = false,
): GuildRequest<GuildMember> | InputValidationFailure {
    const request = memberFetch(target)
    const extra = timeoutSettings(options)
    if (request instanceof InputValidationFailure) return request
    if (extra instanceof InputValidationFailure) return extra
    if (!clear && !integer(durationMs, 1, 31_536_000_000))
        return inputValidationFailure(
            "durationMs",
            "range",
            "Timeout duration must be an integer from 1 through 31,536,000,000 ms (365 days)",
        )
    const { guildId, userId } = target
    return {
        ...request,
        ...extra,
        timeoutReason: true,
        method: "PATCH",
        json: JSON.stringify({
            communication_disabled_until: clear ? null : new Date(Date.now() + durationMs!).toISOString(),
            ...(options?.timeoutReason === undefined ? {} : { timeout_reason: options.timeoutReason }),
        }),
        cache: { selection: { kind: "members", guildId, id: userId }, mutation: true },
        decode: (value) => {
            const member = decodeMember(value, guildId)
            return member?.userId === userId && member.communicationDisabledUntil !== undefined ? member : undefined
        },
    }
}

export function memberKick(
    target: MemberReference,
    options?: ModerationOptions,
): GuildRequest<void> | InputValidationFailure {
    const request = memberFetch(target)
    const extra = auditSettings(options)
    if (request instanceof InputValidationFailure) return request
    if (extra instanceof InputValidationFailure) return extra
    return {
        ...request,
        ...extra,
        method: "DELETE",
        status: 204,
        decode: () => undefined,
        cache: { selection: { kind: "members", guildId: target.guildId, id: target.userId }, mutation: true },
    }
}

function voiceConnectionId(target: VoiceConnectionReference): string | undefined | InputValidationFailure {
    const connectionId = target.connectionId
    if (connectionId === undefined) return undefined
    if (!text(connectionId, 1, 32))
        return inputValidationFailure(
            "target.connectionId",
            "length",
            "Voice connection IDs must contain 1 through 32 UTF-16 code units after Fluxer's normalization",
        )
    return connectionId
}

export function memberVoiceMove(
    target: VoiceConnectionReference,
    channelId: string | null,
    options?: ModerationOptions,
): GuildRequest<GuildMember> | InputValidationFailure {
    const request = memberFetch(target)
    const extra = auditSettings(options)
    if (request instanceof InputValidationFailure) return request
    if (extra instanceof InputValidationFailure) return extra
    if (channelId !== null && (!identifier(channelId) || channelId === "0"))
        return inputValidationFailure(
            "channelId",
            "format",
            "Voice channel IDs must be positive decimal strings or null",
        )
    const connectionId = voiceConnectionId(target)
    if (connectionId instanceof InputValidationFailure) return connectionId
    return {
        ...request,
        ...extra,
        bucket: "guild:member:voice:update",
        method: "PATCH",
        json: JSON.stringify({
            channel_id: channelId,
            ...(connectionId === undefined ? {} : { connection_id: connectionId }),
        }),
        cache: { ...request.cache!, mutation: true },
    }
}

export function memberVoiceFlag(
    target: MemberReference,
    field: "mute" | "deaf",
    input: unknown,
    options?: ModerationOptions,
): GuildRequest<GuildMember> | InputValidationFailure {
    const request = memberFetch(target)
    const extra = auditSettings(options)
    if (request instanceof InputValidationFailure) return request
    if (extra instanceof InputValidationFailure) return extra
    const key = field === "mute" ? "muted" : "deafened"
    if (!record(input)) return inputValidationFailure("input", "type", "Voice flag input must be an object")
    const unsupported = unsupportedKeyFailure(input, [key], "input", "the voice flag input")
    if (unsupported) return unsupported
    const enabled = input[key]
    if (typeof enabled !== "boolean")
        return inputValidationFailure(`input.${key}`, "type", "Voice flags must be boolean")
    const decode = request.decode
    return {
        ...request,
        ...extra,
        bucket: "guild:member:voice:update",
        method: "PATCH",
        json: JSON.stringify({ [field]: enabled }),
        cache: { ...request.cache!, mutation: true },
        decode: (value) => {
            const member = decode(value)
            if (!member) return undefined
            return field === "mute"
                ? member.isMuted === undefined
                    ? undefined
                    : member
                : member.isDeafened === undefined
                  ? undefined
                  : member
        },
    }
}

/** Whole seconds for a millisecond count that is a multiple of 1,000, otherwise a value every range check rejects */
function wholeSeconds(milliseconds: unknown): unknown {
    return typeof milliseconds === "number" && Number.isSafeInteger(milliseconds) && milliseconds % 1_000 === 0
        ? milliseconds / 1_000
        : Number.NaN
}

export function guildBan(
    target: MemberReference,
    input?: BanInput,
    options?: ModerationOptions,
): GuildRequest<void> | InputValidationFailure {
    const request = memberKick(target, options)
    const value = input === undefined ? {} : input
    if (request instanceof InputValidationFailure) return request
    if (!record(value)) return inputValidationFailure("input", "type", "Ban input must be an object")
    const unsupported = unsupportedKeyFailure(
        value,
        ["reason", "durationMs", "deleteMessagesMs"],
        "input",
        "the ban input",
    )
    if (unsupported) return unsupported
    // Callers supply milliseconds, like timeouts, command cooldowns and the duration command argument, and Fluxer
    // takes whole seconds
    const duration = wholeSeconds(value.durationMs === undefined ? 0 : value.durationMs)
    const removal = wholeSeconds(value.deleteMessagesMs === undefined ? 0 : value.deleteMessagesMs)
    if (duration !== 0 && !integer(duration, 60, 63_072_000))
        return inputValidationFailure(
            "input.durationMs",
            "range",
            "Ban duration must be 0 (permanent) or 60,000 through 63,072,000,000 ms (1 minute through 2 years), in whole seconds",
        )
    if (!integer(removal, 0, 604_800))
        return inputValidationFailure(
            "input.deleteMessagesMs",
            "range",
            "Ban message deletion window must be 0 through 604,800,000 ms (7 days), in whole seconds",
        )
    if (value.reason !== undefined && !text(value.reason, 0, 512))
        return inputValidationFailure(
            "input.reason",
            "range",
            "Ban reason must be a string of at most 512 UTF-16 code units after Fluxer's normalization",
        )
    return {
        ...request,
        method: "PUT",
        bucket: "guild:bans",
        path: `/guilds/${target.guildId}/bans/${target.userId}`,
        json: JSON.stringify({
            ban_duration_seconds: duration,
            delete_message_seconds: removal,
            ...(value.reason === undefined ? {} : { reason: value.reason }),
        }),
        ...(removal === 0 ? {} : { deleteAuthorId: target.userId }),
    }
}

export function guildUnban(
    target: MemberReference,
    options?: ModerationOptions,
): GuildRequest<void> | InputValidationFailure {
    const request = memberKick(target, options)
    if (request instanceof InputValidationFailure) return request
    return { ...request, bucket: "guild:bans", path: `/guilds/${target.guildId}/bans/${target.userId}` }
}

export function guildBans(guildId: string): GuildRequest<readonly GuildBan[]> | InputValidationFailure {
    if (!identifier(guildId)) return inputValidationFailure("guildId", "format", "Guild IDs must be decimal strings")
    return {
        guildId,
        bucket: "guild:bans",
        path: `/guilds/${guildId}/bans`,
        method: "GET",
        status: 200,
        decode: (value) => {
            if (!Array.isArray(value)) return undefined
            const ids = new Set<string>()
            const bans: GuildBan[] = []
            for (const item of value) {
                if (
                    !record(item) ||
                    !record(item.user) ||
                    !identifier(item.user.id) ||
                    ids.has(item.user.id) ||
                    typeof item.user.username !== "string" ||
                    (item.user.bot !== undefined && typeof item.user.bot !== "boolean") ||
                    !identifier(item.moderator_id) ||
                    !timestamp(item.banned_at) ||
                    (item.expires_at !== undefined && item.expires_at !== null && !timestamp(item.expires_at)) ||
                    (item.reason !== undefined && item.reason !== null && typeof item.reason !== "string")
                )
                    return undefined
                ids.add(item.user.id)
                bans.push(
                    Object.freeze({
                        guildId,
                        userId: item.user.id,
                        username: item.user.username,
                        isBot: item.user.bot === true,
                        moderatorId: item.moderator_id,
                        bannedAt: item.banned_at,
                        ...(item.reason === undefined ? {} : { reason: item.reason as string | null }),
                        ...(item.expires_at === undefined ? {} : { expiresAt: item.expires_at as string | null }),
                    }),
                )
            }
            return Object.freeze(bans)
        },
    }
}
