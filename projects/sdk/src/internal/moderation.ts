import type {
    BanInput,
    GuildBan,
    GuildMember,
    MemberReference,
    ModerationOptions,
    VoiceConnectionReference,
} from "#sdk/guilds"
import { identifier, record } from "./message.js"
import { decodeMember, memberFetch, type GuildRequest } from "./guilds.js"
import { InputValidationFailure, inputValidationFailure } from "#sdk/input-validation"

const integer = (value: unknown, min: number, max: number): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
const timestamp = (value: unknown): value is string =>
    typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value))

export function auditSettings(
    options?: ModerationOptions,
): { readonly moderation: true; readonly auditReason?: string } | InputValidationFailure {
    if (options !== undefined && !record(options))
        return inputValidationFailure("options", "type", "Moderation options must be an object")
    const reason = options?.auditReason
    if (reason === undefined) return { moderation: true as const }
    if (typeof reason !== "string" || !/^[\x20-\x7E]+$/.test(reason))
        return inputValidationFailure(
            "options.auditReason",
            "format",
            "Audit reason must contain printable ASCII characters",
        )
    const trimmed = reason.trim()
    if (!trimmed || trimmed.length > 512)
        return inputValidationFailure(
            "options.auditReason",
            "length",
            "Audit reason must contain 1 through 512 characters",
        )
    return { moderation: true as const, auditReason: trimmed }
}

export function memberTimeout(
    target: MemberReference,
    durationMs: number | null,
    options?: ModerationOptions,
    clear = false,
): GuildRequest<GuildMember> | InputValidationFailure {
    const request = memberFetch(target)
    const extra = auditSettings(options)
    if (request instanceof InputValidationFailure) return request
    if (extra instanceof InputValidationFailure) return extra
    if (!clear && !integer(durationMs, 1, 31_536_000_000))
        return inputValidationFailure(
            "durationMs",
            "range",
            "Timeout duration must be an integer from 1 through 31,536,000,000 milliseconds",
        )
    const { guildId, userId } = target
    return {
        ...request,
        ...extra,
        method: "PATCH",
        json: JSON.stringify({
            communication_disabled_until: clear ? null : new Date(Date.now() + durationMs!).toISOString(),
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
    if (typeof connectionId !== "string" || [...connectionId].length < 1 || [...connectionId].length > 32)
        return inputValidationFailure(
            "target.connectionId",
            "length",
            "Voice connection IDs must contain 1 through 32 Unicode code points",
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
    enabled: boolean,
    options?: ModerationOptions,
): GuildRequest<GuildMember> | InputValidationFailure {
    const request = memberFetch(target)
    const extra = auditSettings(options)
    if (request instanceof InputValidationFailure) return request
    if (extra instanceof InputValidationFailure) return extra
    if (typeof enabled !== "boolean")
        return inputValidationFailure(field === "mute" ? "muted" : "deafened", "type", "Voice flags must be boolean")
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

export function guildBan(
    target: MemberReference,
    input?: BanInput,
    options?: ModerationOptions,
): GuildRequest<void> | InputValidationFailure {
    const request = memberKick(target, options)
    const value = input === undefined ? {} : input
    if (request instanceof InputValidationFailure) return request
    if (!record(value)) return inputValidationFailure("input", "type", "Ban input must be an object")
    if (Object.keys(value).some((key) => !["reason", "durationSeconds", "deleteMessageSeconds"].includes(key)))
        return inputValidationFailure(
            "input",
            "allowedFields",
            "Ban input may contain only reason, durationSeconds, and deleteMessageSeconds",
        )
    const duration = value.durationSeconds === undefined ? 0 : value.durationSeconds
    const removal = value.deleteMessageSeconds === undefined ? 0 : value.deleteMessageSeconds
    if (
        (duration !== 0 && !integer(duration, 60, 63_072_000)) ||
        !integer(removal, 0, 604_800) ||
        (value.reason !== undefined && (typeof value.reason !== "string" || [...value.reason].length > 512))
    )
        return inputValidationFailure(
            "input",
            "range",
            "Ban fields must satisfy their documented duration, message deletion, and reason limits",
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
