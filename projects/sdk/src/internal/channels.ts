import type {
    ChannelCreate,
    ChannelEdit,
    ChannelPosition,
    GuildChannel,
    GuildChannelUpdateBulk,
    PermissionOverwrite,
} from "#sdk/channels"
import { identifier, record } from "./message.js"

/** Validated request description, with the shared REST owner retaining admission, cleanup and rate state */
export interface ChannelRequest<A> {
    /** Scheduler major resource, the guild for guild routes and otherwise the channel */
    readonly majorId: string
    readonly bucket: string
    readonly path: string
    readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
    readonly status: 200 | 204
    readonly json?: string
    readonly decode: (value: unknown) => A | undefined
    /** Cache ownership hints consumed by the channel cache owner */
    readonly cache: {
        readonly channelId?: string
        readonly guildId?: string
        readonly mutation?: boolean
        readonly replace?: boolean
    }
}

const maxPermission = 18_446_744_073_709_551_615n
const maxRequestBytes = 4_194_304

const int32 = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647
const nonNegativeInt32 = (value: unknown): value is number => int32(value) && value >= 0
const nullableText = (value: unknown): value is string | null => value === null || typeof value === "string"
const nullableIdentifier = (value: unknown): value is string | null => value === null || identifier(value)
const permission = (value: unknown): value is bigint =>
    typeof value === "bigint" && value >= 0n && value <= maxPermission
const timestamp = (value: unknown): value is string =>
    typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value))

export const channelEvents = {
    CHANNEL_CREATE: "guildChannelCreate",
    CHANNEL_UPDATE: "guildChannelUpdate",
    CHANNEL_DELETE: "guildChannelDelete",
    CHANNEL_UPDATE_BULK: "guildChannelUpdateBulk",
} as const

function decodeOverwrite(value: unknown): PermissionOverwrite | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        (value.type !== 0 && value.type !== 1) ||
        typeof value.allow !== "string" ||
        typeof value.deny !== "string" ||
        !/^(0|[1-9][0-9]{0,19})$/.test(value.allow) ||
        !/^(0|[1-9][0-9]{0,19})$/.test(value.deny)
    )
        return undefined
    const allow = BigInt(value.allow)
    const deny = BigInt(value.deny)
    if (!permission(allow) || !permission(deny)) return undefined
    return Object.freeze({ id: value.id, type: value.type === 0 ? "role" : "member", allow, deny })
}

function decodeOverwrites(value: unknown): readonly PermissionOverwrite[] | undefined {
    if (!Array.isArray(value)) return undefined
    const overwrites: PermissionOverwrite[] = []
    const ids = new Set<string>()
    for (const item of value) {
        const overwrite = decodeOverwrite(item)
        if (!overwrite || ids.has(overwrite.id)) return undefined
        ids.add(overwrite.id)
        overwrites.push(overwrite)
    }
    return Object.freeze(overwrites)
}

/** Decode a complete guild-channel response, with private channels and malformed payloads returning undefined */
export function decodeGuildChannel(value: unknown): GuildChannel | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        !identifier(value.guild_id) ||
        !nonNegativeInt32(value.type) ||
        (value.name !== undefined && typeof value.name !== "string") ||
        (value.topic !== undefined && !nullableText(value.topic)) ||
        (value.url !== undefined && value.url !== null && !url(value.url)) ||
        (value.position !== undefined && !int32(value.position)) ||
        (value.parent_id !== undefined && !nullableIdentifier(value.parent_id)) ||
        (value.bitrate !== undefined && value.bitrate !== null && !int32(value.bitrate)) ||
        (value.user_limit !== undefined && value.user_limit !== null && !int32(value.user_limit)) ||
        (value.voice_connection_limit !== undefined &&
            value.voice_connection_limit !== null &&
            !int32(value.voice_connection_limit)) ||
        (value.rtc_region !== undefined && !nullableText(value.rtc_region)) ||
        (value.last_message_id !== undefined && !nullableIdentifier(value.last_message_id)) ||
        (value.last_pin_timestamp !== undefined &&
            value.last_pin_timestamp !== null &&
            !timestamp(value.last_pin_timestamp)) ||
        (value.nsfw !== undefined && typeof value.nsfw !== "boolean") ||
        (value.nsfw_override !== undefined &&
            value.nsfw_override !== null &&
            typeof value.nsfw_override !== "boolean") ||
        (value.content_warning_level !== undefined &&
            value.content_warning_level !== 0 &&
            value.content_warning_level !== 1) ||
        (value.content_warning_text !== undefined &&
            value.content_warning_text !== null &&
            !text(value.content_warning_text, 0, 200)) ||
        (value.rate_limit_per_user !== undefined && !int32(value.rate_limit_per_user))
    )
        return undefined
    const permissionOverwrites =
        value.permission_overwrites === undefined ? undefined : decodeOverwrites(value.permission_overwrites)
    if (value.permission_overwrites !== undefined && permissionOverwrites === undefined) return undefined
    return Object.freeze({
        id: value.id,
        guildId: value.guild_id,
        type: value.type,
        ...(value.name === undefined ? {} : { name: value.name }),
        ...(value.topic === undefined ? {} : { topic: value.topic as string | null }),
        ...(value.url === undefined ? {} : { url: value.url as string | null }),
        ...(value.position === undefined ? {} : { position: value.position }),
        ...(value.parent_id === undefined ? {} : { parentId: value.parent_id as string | null }),
        ...(value.bitrate === undefined ? {} : { bitrate: value.bitrate as number | null }),
        ...(value.user_limit === undefined ? {} : { userLimit: value.user_limit as number | null }),
        ...(value.voice_connection_limit === undefined
            ? {}
            : { voiceConnectionLimit: value.voice_connection_limit as number | null }),
        ...(value.rtc_region === undefined ? {} : { rtcRegion: value.rtc_region as string | null }),
        ...(value.last_message_id === undefined ? {} : { lastMessageId: value.last_message_id as string | null }),
        ...(value.last_pin_timestamp === undefined
            ? {}
            : { lastPinTimestamp: value.last_pin_timestamp as string | null }),
        ...(permissionOverwrites === undefined ? {} : { permissionOverwrites }),
        ...(value.nsfw === undefined ? {} : { nsfw: value.nsfw }),
        ...(value.nsfw_override === undefined ? {} : { nsfwOverride: value.nsfw_override as boolean | null }),
        ...(value.content_warning_level === undefined ? {} : { contentWarningLevel: value.content_warning_level }),
        ...(value.content_warning_text === undefined
            ? {}
            : { contentWarningText: value.content_warning_text as string | null }),
        ...(value.rate_limit_per_user === undefined ? {} : { rateLimitPerUser: value.rate_limit_per_user }),
    })
}

function decodeGuildChannels(value: unknown, guildId: string): readonly GuildChannel[] | undefined {
    if (!Array.isArray(value)) return undefined
    const channels: GuildChannel[] = []
    const ids = new Set<string>()
    for (const item of value) {
        const channel = decodeGuildChannel(item)
        if (!channel || channel.guildId !== guildId || ids.has(channel.id)) return undefined
        ids.add(channel.id)
        channels.push(channel)
    }
    return Object.freeze(channels)
}

/** Decode only guild-scoped channel events, with private-channel events intentionally returning undefined */
export function decodeChannelEvent(event: keyof typeof channelEvents, value: unknown) {
    if (event !== "CHANNEL_UPDATE_BULK") return decodeGuildChannel(value)
    if (!record(value) || !identifier(value.guild_id)) return undefined
    const channels = decodeGuildChannels(value.channels, value.guild_id)
    return channels === undefined
        ? undefined
        : Object.freeze({ guildId: value.guild_id, channels } satisfies GuildChannelUpdateBulk)
}

function text(value: unknown, minimum: number, maximum: number): value is string {
    return typeof value === "string" && [...value].length >= minimum && [...value].length <= maximum
}

function url(value: unknown): value is string {
    if (typeof value !== "string" || value.length === 0) return false
    try {
        new URL(value)
        return true
    } catch {
        return false
    }
}

function nullableValue(value: unknown, guard: (candidate: unknown) => boolean): boolean {
    return value === null || guard(value)
}

function validOptionalFields(
    input: Record<string, unknown>,
    create: boolean,
): input is Record<string, unknown> & { type?: number; name?: string } {
    const allowed = create
        ? [
              "type",
              "name",
              "topic",
              "url",
              "parentId",
              "bitrate",
              "userLimit",
              "voiceConnectionLimit",
              "permissionOverwrites",
              "nsfw",
              "nsfwOverride",
              "contentWarningLevel",
              "contentWarningText",
              "rateLimitPerUser",
          ]
        : [
              "name",
              "topic",
              "url",
              "bitrate",
              "userLimit",
              "voiceConnectionLimit",
              "nsfw",
              "nsfwOverride",
              "contentWarningLevel",
              "contentWarningText",
              "rateLimitPerUser",
              "permissionOverwrites",
              "rtcRegion",
          ]
    if (Object.keys(input).some((key) => !allowed.includes(key))) return false
    if (create && input.type !== 0 && input.type !== 2 && input.type !== 4 && input.type !== 998) return false
    if (create && !text(input.name, 1, 100)) return false
    if (input.name !== undefined && (!text(input.name, 1, 100) || input.name.trim().length === 0)) return false
    if (input.topic !== undefined && !nullableValue(input.topic, (candidate) => text(candidate, 1, 1024))) return false
    if (input.url !== undefined && !nullableValue(input.url, url)) return false
    if (input.parentId !== undefined && !nullableIdentifier(input.parentId)) return false
    if (
        input.bitrate !== undefined &&
        !nullableValue(input.bitrate, (candidate) => int32(candidate) && candidate >= 8_000 && candidate <= 320_000)
    )
        return false
    if (
        input.userLimit !== undefined &&
        !nullableValue(input.userLimit, (candidate) => int32(candidate) && candidate >= 0 && candidate <= 99)
    )
        return false
    if (
        input.voiceConnectionLimit !== undefined &&
        !nullableValue(
            input.voiceConnectionLimit,
            (candidate) => int32(candidate) && candidate >= 1 && candidate <= 100,
        )
    )
        return false
    if (input.nsfw !== undefined && !(typeof input.nsfw === "boolean" || (!create && input.nsfw === null))) return false
    if (input.nsfwOverride !== undefined && !(typeof input.nsfwOverride === "boolean" || input.nsfwOverride === null))
        return false
    if (input.contentWarningLevel !== undefined && input.contentWarningLevel !== 0 && input.contentWarningLevel !== 1)
        return false
    if (
        input.contentWarningText !== undefined &&
        !nullableValue(input.contentWarningText, (candidate) => text(candidate, 0, 200))
    )
        return false
    if (
        input.rateLimitPerUser !== undefined &&
        !nullableValue(input.rateLimitPerUser, (candidate) => int32(candidate) && candidate >= 0 && candidate <= 21_600)
    )
        return false
    if (input.rtcRegion !== undefined && !nullableValue(input.rtcRegion, (candidate) => text(candidate, 1, 64)))
        return false
    return true
}

function encodeOverwrites(value: unknown): readonly Record<string, string | number>[] | undefined {
    if (!Array.isArray(value)) return undefined
    const overwrites: Array<Record<string, string | number>> = []
    const ids = new Set<string>()
    for (const item of value) {
        if (
            !record(item) ||
            Object.keys(item).some((key) => key !== "id" && key !== "type" && key !== "allow" && key !== "deny") ||
            !identifier(item.id) ||
            ids.has(item.id) ||
            (item.type !== "role" && item.type !== "member") ||
            !permission(item.allow) ||
            !permission(item.deny)
        )
            return undefined
        ids.add(item.id)
        overwrites.push({
            id: item.id,
            type: item.type === "role" ? 0 : 1,
            allow: item.allow.toString(),
            deny: item.deny.toString(),
        })
    }
    return overwrites
}

function channelBody(input: ChannelCreate | ChannelEdit, create: boolean): string | undefined {
    if (!record(input) || !validOptionalFields(input, create)) return undefined
    const permissionOverwrites =
        input.permissionOverwrites === undefined ? undefined : encodeOverwrites(input.permissionOverwrites)
    if (input.permissionOverwrites !== undefined && permissionOverwrites === undefined) return undefined
    const body = {
        ...(create ? { type: input.type } : {}),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.topic === undefined ? {} : { topic: input.topic }),
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(create && input.parentId !== undefined ? { parent_id: input.parentId } : {}),
        ...(input.bitrate === undefined ? {} : { bitrate: input.bitrate }),
        ...(input.userLimit === undefined ? {} : { user_limit: input.userLimit }),
        ...(input.voiceConnectionLimit === undefined ? {} : { voice_connection_limit: input.voiceConnectionLimit }),
        ...(permissionOverwrites === undefined ? {} : { permission_overwrites: permissionOverwrites }),
        ...(input.nsfw === undefined ? {} : { nsfw: input.nsfw }),
        ...(input.nsfwOverride === undefined ? {} : { nsfw_override: input.nsfwOverride }),
        ...(input.contentWarningLevel === undefined ? {} : { content_warning_level: input.contentWarningLevel }),
        ...(input.contentWarningText === undefined ? {} : { content_warning_text: input.contentWarningText }),
        ...(input.rateLimitPerUser === undefined ? {} : { rate_limit_per_user: input.rateLimitPerUser }),
        ...(!create && input.rtcRegion !== undefined ? { rtc_region: input.rtcRegion } : {}),
    }
    const json = JSON.stringify(body)
    return json === "{}" || Buffer.byteLength(json) > maxRequestBytes ? undefined : json
}

export function channelFetch(channelId: string): ChannelRequest<GuildChannel> | undefined {
    if (!identifier(channelId)) return undefined
    return {
        majorId: channelId,
        bucket: "channel:read",
        path: `/channels/${channelId}`,
        method: "GET",
        status: 200,
        cache: { channelId },
        decode: (value) => {
            const channel = decodeGuildChannel(value)
            return channel?.id === channelId ? channel : undefined
        },
    }
}

export function channelList(guildId: string): ChannelRequest<readonly GuildChannel[]> | undefined {
    if (!identifier(guildId)) return undefined
    return {
        majorId: guildId,
        bucket: "guild:channels:list",
        path: `/guilds/${guildId}/channels`,
        method: "GET",
        status: 200,
        cache: { guildId, replace: true },
        decode: (value) => decodeGuildChannels(value, guildId),
    }
}

export function channelCreate(guildId: string, input: ChannelCreate): ChannelRequest<GuildChannel> | undefined {
    if (!identifier(guildId)) return undefined
    const json = channelBody(input, true)
    if (!json) return undefined
    return {
        majorId: guildId,
        bucket: "guild:channel:create",
        path: `/guilds/${guildId}/channels`,
        method: "POST",
        status: 200,
        json,
        cache: { guildId, mutation: true },
        decode: (value) => {
            const channel = decodeGuildChannel(value)
            return channel?.guildId === guildId ? channel : undefined
        },
    }
}

export function channelEdit(channelId: string, input: ChannelEdit): ChannelRequest<GuildChannel> | undefined {
    if (!identifier(channelId)) return undefined
    const json = channelBody(input, false)
    if (!json) return undefined
    return {
        majorId: channelId,
        bucket: "channel:update",
        path: `/channels/${channelId}`,
        method: "PATCH",
        status: 200,
        json,
        cache: { channelId, mutation: true },
        decode: (value) => {
            const channel = decodeGuildChannel(value)
            return channel?.id === channelId ? channel : undefined
        },
    }
}

export function channelDelete(channelId: string): ChannelRequest<void> | undefined {
    if (!identifier(channelId)) return undefined
    return {
        majorId: channelId,
        bucket: "channel:delete",
        path: `/channels/${channelId}`,
        method: "DELETE",
        status: 204,
        cache: { channelId, mutation: true },
        decode: () => undefined,
    }
}

function channelPositionBody(positions: readonly ChannelPosition[]): string | undefined {
    if (!Array.isArray(positions) || positions.length === 0) return undefined
    const ids = new Set<string>()
    const updates: Array<Record<string, string | number | boolean | null>> = []
    let bytes = 2
    for (const item of positions) {
        if (
            !record(item) ||
            Object.keys(item).some(
                (key) =>
                    key !== "id" &&
                    key !== "position" &&
                    key !== "parentId" &&
                    key !== "precedingSiblingId" &&
                    key !== "syncPermissionsOnMove",
            ) ||
            !identifier(item.id) ||
            ids.has(item.id) ||
            (item.position !== undefined &&
                (typeof item.position !== "number" || !Number.isSafeInteger(item.position) || item.position < 0)) ||
            (item.parentId !== undefined && !nullableIdentifier(item.parentId)) ||
            (item.precedingSiblingId !== undefined && !nullableIdentifier(item.precedingSiblingId)) ||
            (item.syncPermissionsOnMove !== undefined && typeof item.syncPermissionsOnMove !== "boolean")
        )
            return undefined
        const update = {
            id: item.id,
            ...(item.position === undefined ? {} : { position: item.position }),
            ...(item.parentId === undefined ? {} : { parent_id: item.parentId }),
            ...(item.precedingSiblingId === undefined ? {} : { preceding_sibling_id: item.precedingSiblingId }),
            ...(item.syncPermissionsOnMove === undefined ? {} : { lock_permissions: item.syncPermissionsOnMove }),
        }
        bytes += Buffer.byteLength(JSON.stringify(update)) + (updates.length ? 1 : 0)
        if (bytes > maxRequestBytes) return undefined
        ids.add(item.id)
        updates.push(update)
    }
    return JSON.stringify(updates)
}

export function channelReorder(
    guildId: string,
    positions: readonly ChannelPosition[],
): ChannelRequest<void> | undefined {
    if (!identifier(guildId)) return undefined
    const json = channelPositionBody(positions)
    if (!json) return undefined
    return {
        majorId: guildId,
        bucket: "guild:channel:positions",
        path: `/guilds/${guildId}/channels`,
        method: "PATCH",
        status: 204,
        json,
        cache: { guildId, mutation: true },
        decode: () => undefined,
    }
}

function permissionSetBody(input: PermissionOverwrite): string | undefined {
    if (
        !record(input) ||
        Object.keys(input).some((key) => key !== "id" && key !== "type" && key !== "allow" && key !== "deny") ||
        !identifier(input.id) ||
        (input.type !== "role" && input.type !== "member") ||
        !permission(input.allow) ||
        !permission(input.deny)
    )
        return undefined
    return JSON.stringify({
        type: input.type === "role" ? 0 : 1,
        allow: input.allow.toString(),
        deny: input.deny.toString(),
    })
}

export function permissionSet(channelId: string, input: PermissionOverwrite): ChannelRequest<void> | undefined {
    if (!identifier(channelId)) return undefined
    const json = permissionSetBody(input)
    if (!json) return undefined
    return {
        majorId: channelId,
        bucket: "channel:update",
        path: `/channels/${channelId}/permissions/${input.id}`,
        method: "PUT",
        status: 204,
        json,
        cache: { channelId, mutation: true },
        decode: () => undefined,
    }
}

export function permissionRemove(channelId: string, targetId: string): ChannelRequest<void> | undefined {
    if (!identifier(channelId) || !identifier(targetId)) return undefined
    return {
        majorId: channelId,
        bucket: "channel:update",
        path: `/channels/${channelId}/permissions/${targetId}`,
        method: "DELETE",
        status: 204,
        cache: { channelId, mutation: true },
        decode: () => undefined,
    }
}
