import type { BanInput, GuildBan, GuildMember, MemberReference, ModerationOptions } from "#sdk/guilds"
import { identifier, record } from "./message.js"
import { decodeMember, memberFetch, type GuildRequest } from "./guilds.js"

const integer = (value: unknown, min: number, max: number): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
const timestamp = (value: unknown): value is string =>
    typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value))

export function auditSettings(options?: ModerationOptions): { moderation: true; auditReason?: string } | undefined {
    if (options !== undefined && !record(options)) return undefined
    const reason = options?.auditReason
    if (reason === undefined) return { moderation: true }
    if (typeof reason !== "string" || !/^[\x20-\x7E]+$/.test(reason)) return undefined
    const trimmed = reason.trim()
    if (!trimmed || trimmed.length > 512) return undefined
    return { moderation: true, auditReason: trimmed }
}

export function memberTimeout(
    target: MemberReference,
    durationMs: number | null,
    options?: ModerationOptions,
    clear = false,
): GuildRequest<GuildMember> | undefined {
    const request = memberFetch(target)
    const extra = auditSettings(options)
    if (!request || !extra || (!clear && !integer(durationMs, 1, 31_536_000_000))) return undefined
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

export function memberKick(target: MemberReference, options?: ModerationOptions): GuildRequest<void> | undefined {
    const request = memberFetch(target)
    const extra = auditSettings(options)
    if (!request || !extra) return undefined
    return {
        ...request,
        ...extra,
        method: "DELETE",
        status: 204,
        decode: () => undefined,
        cache: { selection: { kind: "members", guildId: target.guildId, id: target.userId }, mutation: true },
    }
}

export function guildBan(
    target: MemberReference,
    input?: BanInput,
    options?: ModerationOptions,
): GuildRequest<void> | undefined {
    const request = memberKick(target, options)
    const value = input === undefined ? {} : input
    if (
        !request ||
        !record(value) ||
        Object.keys(value).some((key) => !["reason", "durationSeconds", "deleteMessageSeconds"].includes(key))
    )
        return undefined
    const duration = value.durationSeconds === undefined ? 0 : value.durationSeconds
    const removal = value.deleteMessageSeconds === undefined ? 0 : value.deleteMessageSeconds
    if (
        (duration !== 0 && !integer(duration, 60, 63_072_000)) ||
        !integer(removal, 0, 604_800) ||
        (value.reason !== undefined && (typeof value.reason !== "string" || [...value.reason].length > 512))
    )
        return undefined
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

export function guildUnban(target: MemberReference, options?: ModerationOptions): GuildRequest<void> | undefined {
    const request = memberKick(target, options)
    if (!request) return undefined
    return { ...request, bucket: "guild:bans", path: `/guilds/${target.guildId}/bans/${target.userId}` }
}

export function guildBans(guildId: string): GuildRequest<readonly GuildBan[]> | undefined {
    if (!identifier(guildId)) return undefined
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
