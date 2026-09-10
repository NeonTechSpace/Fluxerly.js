import type { Invite, InviteCreate, InviteMetadata } from "#sdk/invites"
import type { InviteDeleteEvent } from "#sdk/events"
import type { ModerationOptions } from "#sdk/guilds"
import type { GuildRequest } from "./guilds.js"
import { identifier, record } from "./message.js"
import { auditSettings } from "./moderation.js"

const hostedInvite = "https://fluxer.gg"

const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max
const timestamp = (value: unknown): value is string =>
    typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value))
const codeValue = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    value.isWellFormed() &&
    !/[\s\x00-\x1f\x7f/?#\\]/u.test(value) &&
    value !== "." &&
    value !== ".."

function decode(value: unknown, inviteBase = hostedInvite): Invite | undefined {
    if (
        !record(value) ||
        !codeValue(value.code) ||
        (value.type !== 0 && value.type !== 1) ||
        !record(value.channel) ||
        !identifier(value.channel.id) ||
        !integer(value.channel.type) ||
        (value.channel.name !== undefined && value.channel.name !== null && typeof value.channel.name !== "string") ||
        !integer(value.member_count) ||
        typeof value.temporary !== "boolean" ||
        (value.expires_at !== undefined && value.expires_at !== null && !timestamp(value.expires_at)) ||
        (value.inviter !== undefined &&
            value.inviter !== null &&
            (!record(value.inviter) || !identifier(value.inviter.id)))
    )
        return undefined
    if (
        value.type === 0 &&
        (!record(value.guild) ||
            !identifier(value.guild.id) ||
            typeof value.guild.name !== "string" ||
            !integer(value.presence_count))
    )
        return undefined
    return Object.freeze({
        code: value.code,
        url: `${inviteBase}/${encodeURIComponent(value.code)}`,
        type: value.type === 0 ? "guild" : "group",
        channel: Object.freeze({
            id: value.channel.id,
            type: value.channel.type,
            ...(value.channel.name === undefined ? {} : { name: value.channel.name as string | null }),
        }),
        ...(value.type === 0
            ? {
                  guild: Object.freeze({
                      id: (value.guild as { id: string }).id,
                      name: (value.guild as { name: string }).name,
                  }),
                  presenceCount: value.presence_count as number,
              }
            : {}),
        ...(value.inviter === undefined
            ? {}
            : { inviterId: value.inviter === null ? null : (value.inviter as { id: string }).id }),
        memberCount: value.member_count,
        ...(value.expires_at === undefined ? {} : { expiresAt: value.expires_at as string | null }),
        temporary: value.temporary,
    })
}

function metadata(value: unknown, inviteBase = hostedInvite): InviteMetadata | undefined {
    const base = decode(value, inviteBase)
    if (
        !base ||
        !record(value) ||
        !timestamp(value.created_at) ||
        !integer(value.uses) ||
        !integer(value.max_uses) ||
        (base.type === "guild" && !integer(value.max_age))
    )
        return undefined
    return Object.freeze({
        ...base,
        createdAt: value.created_at,
        uses: value.uses,
        maxUses: value.max_uses,
        ...(base.type === "guild" ? { maxAgeSeconds: value.max_age as number } : {}),
    })
}

/** Decode the complete metadata emitted by INVITE_CREATE without retaining it */
export function decodeInviteMetadata(value: unknown, inviteBase = hostedInvite): InviteMetadata | undefined {
    return metadata(value, inviteBase)
}

/** Decode INVITE_DELETE's intentionally smaller terminal identity without retaining it */
export function decodeInviteDelete(value: unknown): InviteDeleteEvent | undefined {
    if (
        !record(value) ||
        !codeValue(value.code) ||
        (value.channel_id !== undefined && !identifier(value.channel_id)) ||
        (value.guild_id !== undefined && !identifier(value.guild_id))
    )
        return undefined
    return Object.freeze({
        code: value.code,
        ...(value.channel_id === undefined ? {} : { channelId: value.channel_id }),
        ...(value.guild_id === undefined ? {} : { guildId: value.guild_id }),
    })
}

export function inviteFetch(code: string, inviteBase = hostedInvite): GuildRequest<Invite> | undefined {
    if (!codeValue(code)) return undefined
    return {
        guildId: "invites",
        bucket: "invites:code",
        path: `/invites/${encodeURIComponent(code)}`,
        method: "GET",
        status: 200,
        // Fluxer can resolve a vanity code using a lowercase fallback
        decode: (value, instance) => {
            const item = decode(value, instance?.invite ?? inviteBase)
            return item && (item.code === code || item.code === code.toLowerCase()) ? item : undefined
        },
    }
}

export function inviteList(
    kind: "guilds" | "channels",
    id: string,
    inviteBase = hostedInvite,
): GuildRequest<readonly InviteMetadata[]> | undefined {
    if (!identifier(id)) return undefined
    return {
        guildId: id,
        bucket: `${kind}:invites`,
        path: `/${kind}/${id}/invites`,
        method: "GET",
        status: 200,
        decode: (value, instance) => {
            if (!Array.isArray(value)) return undefined
            const result: InviteMetadata[] = []
            const codes = new Set<string>()
            for (const entry of value) {
                const item = metadata(entry, instance?.invite ?? inviteBase)
                if (
                    !item ||
                    codes.has(item.code) ||
                    (kind === "guilds" ? item.guild?.id !== id : item.channel.id !== id)
                )
                    return undefined
                codes.add(item.code)
                result.push(item)
            }
            return Object.freeze(result)
        },
    }
}

export function inviteCreate(
    channelId: string,
    input?: InviteCreate,
    options?: ModerationOptions,
    inviteBase = hostedInvite,
): GuildRequest<InviteMetadata> | undefined {
    const value = input === undefined ? {} : input
    const base = inviteList("channels", channelId, inviteBase)
    const audit = auditSettings(options)
    if (
        !base ||
        !audit ||
        !record(value) ||
        Object.keys(value).some((key) => !["maxAgeSeconds", "maxUses", "unique", "temporary"].includes(key))
    )
        return undefined
    const maxAgeSeconds = value.maxAgeSeconds === undefined ? 86_400 : value.maxAgeSeconds
    const maxUses = value.maxUses === undefined ? 0 : value.maxUses
    const unique = value.unique === undefined ? true : value.unique
    const temporary = value.temporary === undefined ? false : value.temporary
    if (
        !integer(maxAgeSeconds, 604_800) ||
        !integer(maxUses, 100) ||
        typeof unique !== "boolean" ||
        typeof temporary !== "boolean"
    )
        return undefined
    return {
        ...base,
        ...audit,
        method: "POST",
        json: JSON.stringify({ max_age: maxAgeSeconds, max_uses: maxUses, unique, temporary }),
        decode: (value, instance) => {
            const item = metadata(value, instance?.invite ?? inviteBase)
            return item?.channel.id === channelId ? item : undefined
        },
    }
}

export function inviteDelete(
    code: string,
    options?: ModerationOptions,
    inviteBase = hostedInvite,
): GuildRequest<void> | undefined {
    const base = inviteFetch(code, inviteBase)
    const audit = auditSettings(options)
    if (!base || !audit) return undefined
    return { ...base, ...audit, method: "DELETE", status: 204, decode: () => undefined }
}
