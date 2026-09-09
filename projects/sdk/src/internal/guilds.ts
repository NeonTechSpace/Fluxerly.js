import type {
    Guild,
    GuildContentWarningLevel,
    GuildDefaultMessageNotification,
    GuildExplicitContentFilter,
    GuildMember,
    MemberProfileEdit,
    GuildSplashCardAlignment,
    GuildVerificationLevel,
    GuildRole,
    RoleCreate,
    RoleEdit,
    MemberQuery,
    MemberReference,
    RolePosition,
    RoleHoistPosition,
    RoleReference,
} from "#sdk/guilds"
import { identifier, record } from "./message.js"
import type { ResourceRequest } from "./guild-cache.js"
import type { ChannelCacheRequest } from "./channel-cache.js"

/** Validated request description; the shared REST owner retains admission, cleanup and rate state */
export interface GuildRequest<A> {
    readonly guildId: string
    readonly bucket: string
    readonly path: string
    readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
    readonly status: 200 | 204
    readonly json?: string
    readonly moderation?: true
    readonly auditReason?: string
    readonly deleteAuthorId?: string
    readonly decode: (value: unknown) => A | undefined
    readonly cache?: ResourceRequest
    readonly channelCache?: ChannelCacheRequest
}

const nullableText = (value: unknown) => value === undefined || value === null || typeof value === "string"
const int32 = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647
const nonNegativeInt32 = (value: unknown): value is number => int32(value) && value >= 0
const color = (value: unknown): value is number => nonNegativeInt32(value) && value <= 0xffffff
const mentionPreference = (value: unknown): value is 0 | 1 | 2 => value === 0 || value === 1 || value === 2
const guildDefaultMessageNotification = (value: unknown): value is GuildDefaultMessageNotification =>
    value === 0 || value === 1
const guildVerificationLevel = (value: unknown): value is GuildVerificationLevel =>
    value === 0 || value === 1 || value === 2 || value === 3 || value === 4
const guildExplicitContentFilter = (value: unknown): value is GuildExplicitContentFilter =>
    value === 0 || value === 1 || value === 2
const guildContentWarningLevel = (value: unknown): value is GuildContentWarningLevel => value === 0 || value === 1
const guildSplashCardAlignment = (value: unknown): value is GuildSplashCardAlignment =>
    value === 0 || value === 1 || value === 2
const text = (value: unknown, minimum: number, maximum: number): value is string =>
    typeof value === "string" && [...value].length >= minimum && [...value].length <= maximum
const imageDataUri = (value: unknown): value is string =>
    typeof value === "string" && /^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
const timestamp = (value: unknown): value is string =>
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))

export const guildEvents = {
    GUILD_MEMBER_ADD: "guildMemberAdd",
    GUILD_MEMBER_UPDATE: "guildMemberUpdate",
    GUILD_MEMBER_REMOVE: "guildMemberRemove",
    GUILD_BAN_ADD: "guildBanAdd",
    GUILD_BAN_REMOVE: "guildBanRemove",
    GUILD_ROLE_DELETE: "guildRoleDelete",
    GUILD_ROLE_CREATE: "guildRoleCreate",
    GUILD_ROLE_UPDATE: "guildRoleUpdate",
    GUILD_ROLE_UPDATE_BULK: "guildRoleUpdateBulk",
} as const

export function decodeGuildEvent(event: keyof typeof guildEvents, value: unknown) {
    if (!record(value) || !identifier(value.guild_id)) return undefined
    if (event === "GUILD_ROLE_CREATE" || event === "GUILD_ROLE_UPDATE") return decodeRole(value.role, value.guild_id)
    if (event === "GUILD_ROLE_UPDATE_BULK") {
        const roles = decodeRoles(value.roles, value.guild_id)
        return roles ? Object.freeze({ guildId: value.guild_id, roles }) : undefined
    }
    if (event === "GUILD_ROLE_DELETE") {
        if (!identifier(value.role_id)) return undefined
        return Object.freeze({ guildId: value.guild_id, id: value.role_id })
    }
    if (event === "GUILD_MEMBER_REMOVE" || event === "GUILD_BAN_ADD" || event === "GUILD_BAN_REMOVE") {
        if (!record(value.user) || !identifier(value.user.id)) return undefined
        return Object.freeze({ guildId: value.guild_id, userId: value.user.id })
    }
    return decodeMember(value, value.guild_id)
}

export function decodeGuild(value: unknown): Guild | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        !identifier(value.owner_id) ||
        typeof value.name !== "string" ||
        !Array.isArray(value.features) ||
        !value.features.every((item) => typeof item === "string") ||
        !nullableText(value.icon) ||
        !nullableText(value.banner) ||
        !nullableText(value.splash) ||
        !nullableText(value.embed_splash) ||
        (value.splash_card_alignment !== undefined && !guildSplashCardAlignment(value.splash_card_alignment)) ||
        (value.system_channel_id !== undefined &&
            value.system_channel_id !== null &&
            !identifier(value.system_channel_id)) ||
        (value.system_channel_flags !== undefined && !nonNegativeInt32(value.system_channel_flags)) ||
        (value.afk_channel_id !== undefined && value.afk_channel_id !== null && !identifier(value.afk_channel_id)) ||
        (value.afk_timeout !== undefined && !nonNegativeInt32(value.afk_timeout)) ||
        (value.default_message_notifications !== undefined &&
            !guildDefaultMessageNotification(value.default_message_notifications)) ||
        (value.verification_level !== undefined && !guildVerificationLevel(value.verification_level)) ||
        (value.nsfw !== undefined && typeof value.nsfw !== "boolean") ||
        (value.content_warning_level !== undefined && !guildContentWarningLevel(value.content_warning_level)) ||
        !nullableText(value.content_warning_text) ||
        (value.explicit_content_filter !== undefined && !guildExplicitContentFilter(value.explicit_content_filter)) ||
        (value.message_history_cutoff !== undefined &&
            value.message_history_cutoff !== null &&
            !timestamp(value.message_history_cutoff))
    )
        return undefined
    return Object.freeze({
        id: value.id,
        name: value.name,
        ownerId: value.owner_id,
        features: Object.freeze([...value.features] as string[]),
        ...(value.icon === undefined ? {} : { icon: value.icon as string | null }),
        ...(value.banner === undefined ? {} : { banner: value.banner as string | null }),
        ...(value.splash === undefined ? {} : { splash: value.splash as string | null }),
        ...(value.embed_splash === undefined ? {} : { embedSplash: value.embed_splash as string | null }),
        ...(value.splash_card_alignment === undefined
            ? {}
            : { splashCardAlignment: value.splash_card_alignment as GuildSplashCardAlignment }),
        ...(value.system_channel_id === undefined ? {} : { systemChannelId: value.system_channel_id as string | null }),
        ...(value.system_channel_flags === undefined
            ? {}
            : { systemChannelFlags: value.system_channel_flags as number }),
        ...(value.afk_channel_id === undefined ? {} : { afkChannelId: value.afk_channel_id as string | null }),
        ...(value.afk_timeout === undefined ? {} : { afkTimeoutSeconds: value.afk_timeout as number }),
        ...(value.default_message_notifications === undefined
            ? {}
            : { defaultMessageNotifications: value.default_message_notifications as GuildDefaultMessageNotification }),
        ...(value.verification_level === undefined
            ? {}
            : { verificationLevel: value.verification_level as GuildVerificationLevel }),
        ...(value.nsfw === undefined ? {} : { nsfw: value.nsfw as boolean }),
        ...(value.content_warning_level === undefined
            ? {}
            : { contentWarningLevel: value.content_warning_level as GuildContentWarningLevel }),
        ...(value.content_warning_text === undefined
            ? {}
            : { contentWarningText: value.content_warning_text as string | null }),
        ...(value.explicit_content_filter === undefined
            ? {}
            : { explicitContentFilter: value.explicit_content_filter as GuildExplicitContentFilter }),
        ...(value.message_history_cutoff === undefined
            ? {}
            : { messageHistoryCutoff: value.message_history_cutoff as string | null }),
    })
}

export function decodeMember(value: unknown, guildId: string): GuildMember | undefined {
    if (
        !record(value) ||
        !record(value.user) ||
        !identifier(value.user.id) ||
        typeof value.user.username !== "string" ||
        (value.user.bot !== undefined && typeof value.user.bot !== "boolean") ||
        !Array.isArray(value.roles) ||
        value.roles.length > 250 ||
        !value.roles.every(identifier) ||
        new Set(value.roles).size !== value.roles.length ||
        typeof value.joined_at !== "string" ||
        !/^\d{4}-\d\d-\d\dT/.test(value.joined_at) ||
        !Number.isFinite(Date.parse(value.joined_at)) ||
        !nullableText(value.nick) ||
        !nullableText(value.avatar) ||
        !nullableText(value.banner) ||
        (value.accent_color !== undefined && value.accent_color !== null && !color(value.accent_color)) ||
        (value.profile_flags !== undefined && value.profile_flags !== null && !nonNegativeInt32(value.profile_flags)) ||
        (value.mention_flags !== undefined &&
            value.mention_flags !== null &&
            !mentionPreference(value.mention_flags)) ||
        (value.communication_disabled_until !== undefined &&
            value.communication_disabled_until !== null &&
            (typeof value.communication_disabled_until !== "string" ||
                !/^\d{4}-\d\d-\d\dT/.test(value.communication_disabled_until) ||
                !Number.isFinite(Date.parse(value.communication_disabled_until))))
    )
        return undefined
    return Object.freeze({
        guildId,
        userId: value.user.id,
        username: value.user.username,
        isBot: value.user.bot === true,
        roleIds: Object.freeze([...value.roles] as string[]),
        joinedAt: value.joined_at,
        ...(value.communication_disabled_until === undefined
            ? {}
            : { communicationDisabledUntil: value.communication_disabled_until as string | null }),
        ...(value.nick === undefined ? {} : { nickname: value.nick as string | null }),
        ...(value.avatar === undefined ? {} : { avatar: value.avatar as string | null }),
        ...(value.banner === undefined ? {} : { banner: value.banner as string | null }),
        ...(value.accent_color === undefined ? {} : { accentColor: value.accent_color as number | null }),
        ...(value.profile_flags === undefined ? {} : { profileFlags: value.profile_flags as number | null }),
        ...(value.mention_flags === undefined ? {} : { mentionFlags: value.mention_flags as 0 | 1 | 2 | null }),
    })
}

export function guildFetch(guildId: string): GuildRequest<Guild> | undefined {
    if (!identifier(guildId)) return undefined
    return {
        guildId,
        bucket: "guild:read",
        cache: { selection: { kind: "guilds", guildId } },
        path: `/guilds/${guildId}`,
        method: "GET",
        status: 200,
        decode: (value) => {
            const guild = decodeGuild(value)
            return guild?.id === guildId ? guild : undefined
        },
    }
}

export function memberFetch(target: MemberReference): GuildRequest<GuildMember> | undefined {
    if (!record(target) || !identifier(target.guildId) || !identifier(target.userId)) return undefined
    const { guildId, userId } = target
    return {
        guildId,
        bucket: "guild:members",
        path: `/guilds/${guildId}/members/${userId}`,
        cache: { selection: { kind: "members", guildId, id: userId } },
        method: "GET",
        status: 200,
        decode: (value) => {
            const member = decodeMember(value, guildId)
            return member?.userId === userId ? member : undefined
        },
    }
}

export function memberSelf(guildId: string): GuildRequest<GuildMember> | undefined {
    if (!identifier(guildId)) return undefined
    return {
        guildId,
        bucket: "guild:members",
        path: `/guilds/${guildId}/members/@me`,
        cache: { selection: { kind: "members", guildId } },
        method: "GET",
        status: 200,
        decode: (value) => decodeMember(value, guildId),
    }
}

export function memberEditSelf(guildId: string, input: MemberProfileEdit): GuildRequest<GuildMember> | undefined {
    if (
        !identifier(guildId) ||
        !record(input) ||
        Object.keys(input).length === 0 ||
        Object.keys(input).some(
            (key) =>
                ![
                    "nickname",
                    "avatar",
                    "banner",
                    "bio",
                    "pronouns",
                    "accentColor",
                    "profileFlags",
                    "mentionFlags",
                ].includes(key),
        ) ||
        (input.nickname !== undefined && input.nickname !== null && !text(input.nickname, 1, 32)) ||
        (input.avatar !== undefined && input.avatar !== null && !imageDataUri(input.avatar)) ||
        (input.banner !== undefined && input.banner !== null && !imageDataUri(input.banner)) ||
        (input.bio !== undefined && input.bio !== null && !text(input.bio, 1, 320)) ||
        (input.pronouns !== undefined && input.pronouns !== null && !text(input.pronouns, 1, 40)) ||
        (input.accentColor !== undefined && input.accentColor !== null && !color(input.accentColor)) ||
        (input.profileFlags !== undefined && input.profileFlags !== null && !nonNegativeInt32(input.profileFlags)) ||
        (input.mentionFlags !== undefined && input.mentionFlags !== null && !mentionPreference(input.mentionFlags))
    )
        return undefined
    const json = JSON.stringify({
        nick: input.nickname,
        avatar: input.avatar,
        banner: input.banner,
        bio: input.bio,
        pronouns: input.pronouns,
        accent_color: input.accentColor,
        profile_flags: input.profileFlags,
        mention_flags: input.mentionFlags,
    })
    if (json === "{}" || Buffer.byteLength(json) > 4_194_304) return undefined
    return {
        guildId,
        bucket: "guild:member:self:update",
        cache: { selection: { kind: "members", guildId }, mutation: true },
        path: `/guilds/${guildId}/members/@me`,
        method: "PATCH",
        status: 200,
        json,
        decode: (value) => decodeMember(value, guildId),
    }
}

/** Build the one-field member PATCH used for a moderator-controlled nickname change. */
export function memberNicknameEdit(
    target: MemberReference,
    nickname: string | null,
): GuildRequest<GuildMember> | undefined {
    if (
        !record(target) ||
        !identifier(target.guildId) ||
        !identifier(target.userId) ||
        (nickname !== null && !text(nickname, 1, 32))
    )
        return undefined
    const { guildId, userId } = target
    return {
        guildId,
        bucket: "guild:member:nickname:update",
        cache: { selection: { kind: "members", guildId, id: userId }, mutation: true },
        path: `/guilds/${guildId}/members/${userId}`,
        method: "PATCH",
        status: 200,
        json: JSON.stringify({ nick: nickname }),
        decode: (value) => {
            const member = decodeMember(value, guildId)
            return member?.userId === userId ? member : undefined
        },
    }
}

export function memberPage(guildId: string, query?: MemberQuery): GuildRequest<readonly GuildMember[]> | undefined {
    const input = query === undefined ? {} : query
    if (!identifier(guildId) || !record(input) || Object.keys(input).some((key) => key !== "limit" && key !== "after"))
        return undefined
    const limit = input.limit === undefined ? 100 : input.limit
    if (
        typeof limit !== "number" ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 1000 ||
        (input.after !== undefined && !identifier(input.after))
    )
        return undefined
    const after = input.after as string | undefined
    const params = new URLSearchParams({ limit: String(limit) })
    if (after !== undefined) params.set("after", after)
    return {
        guildId,
        bucket: "guild:members",
        path: `/guilds/${guildId}/members?${params}`,
        cache: { selection: { kind: "members", guildId } },
        method: "GET",
        status: 200,
        decode: (value) => {
            if (!Array.isArray(value) || value.length > limit) return undefined
            const members: GuildMember[] = []
            let previous = after === undefined ? undefined : BigInt(after)
            for (const item of value) {
                const member = decodeMember(item, guildId)
                if (!member || (previous !== undefined && BigInt(member.userId) <= previous)) return undefined
                previous = BigInt(member.userId)
                members.push(member)
            }
            return Object.freeze(members)
        },
    }
}

export function memberRole(target: MemberReference, roleId: string, add: boolean): GuildRequest<void> | undefined {
    if (
        !record(target) ||
        !identifier(target.guildId) ||
        !identifier(target.userId) ||
        !identifier(roleId) ||
        roleId === target.guildId
    )
        return undefined
    const { guildId, userId } = target
    return {
        guildId,
        bucket: add ? "guild:member:role:add" : "guild:member:role:remove",
        path: `/guilds/${guildId}/members/${userId}/roles/${roleId}`,
        cache: { selection: { kind: "members", guildId, id: userId }, mutation: true },
        method: add ? "PUT" : "DELETE",
        status: 204,
        decode: () => undefined,
    }
}

const permission = (value: unknown): value is bigint =>
    typeof value === "bigint" && value >= 0n && value <= 18_446_744_073_709_551_615n

export function decodeRole(value: unknown, guildId: string): GuildRole | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        typeof value.name !== "string" ||
        !nonNegativeInt32(value.color) ||
        !nonNegativeInt32(value.position) ||
        typeof value.permissions !== "string" ||
        !/^(0|[1-9][0-9]{0,19})$/.test(value.permissions) ||
        !permission(BigInt(value.permissions)) ||
        typeof value.hoist !== "boolean" ||
        typeof value.mentionable !== "boolean" ||
        (value.hoist_position !== undefined && value.hoist_position !== null && !int32(value.hoist_position)) ||
        !nullableText(value.unicode_emoji)
    )
        return undefined
    return Object.freeze({
        guildId,
        id: value.id,
        name: value.name,
        color: value.color,
        position: value.position,
        permissions: BigInt(value.permissions),
        hoist: value.hoist,
        mentionable: value.mentionable,
        ...(value.hoist_position === undefined ? {} : { hoistPosition: value.hoist_position as number | null }),
        ...(value.unicode_emoji === undefined ? {} : { unicodeEmoji: value.unicode_emoji as string | null }),
    })
}

function decodeRoles(value: unknown, guildId: string): readonly GuildRole[] | undefined {
    if (!Array.isArray(value)) return undefined
    const roles: GuildRole[] = []
    const ids = new Set<string>()
    for (const item of value) {
        const role = decodeRole(item, guildId)
        if (!role || ids.has(role.id)) return undefined
        ids.add(role.id)
        roles.push(role)
    }
    return Object.freeze(roles)
}

export function roleList(guildId: string): GuildRequest<readonly GuildRole[]> | undefined {
    if (!identifier(guildId)) return undefined
    return {
        guildId,
        bucket: "guild:role:list",
        cache: { selection: { kind: "roles", guildId }, replace: true },
        path: `/guilds/${guildId}/roles`,
        method: "GET",
        status: 200,
        decode: (value) => decodeRoles(value, guildId),
    }
}

function roleBody(input: RoleCreate | RoleEdit, create: boolean): string | undefined {
    if (!record(input)) return undefined
    const keys = create
        ? ["name", "color", "permissions"]
        : ["name", "color", "permissions", "hoist", "hoistPosition", "mentionable"]
    if (Object.keys(input).some((key) => !keys.includes(key))) return undefined
    const { name, color, permissions, hoist, hoistPosition, mentionable } = input
    if (
        (create && name === undefined) ||
        (name !== undefined &&
            (typeof name !== "string" || name.length > 200 || name.trim().length === 0 || [...name].length > 100)) ||
        (color !== undefined && (!int32(color) || color < 0 || color > 0xffffff)) ||
        (permissions !== undefined && !permission(permissions)) ||
        (hoist !== undefined && typeof hoist !== "boolean") ||
        (mentionable !== undefined && typeof mentionable !== "boolean") ||
        (hoistPosition !== undefined && hoistPosition !== null && !int32(hoistPosition))
    )
        return undefined
    const body = {
        name,
        color: create ? (color ?? 0) : color,
        permissions: create ? (permissions ?? 0n).toString() : permissions?.toString(),
        hoist,
        hoist_position: hoistPosition,
        mentionable,
    }
    const json = JSON.stringify(body)
    return json === "{}" ? undefined : json
}

export function roleCreate(guildId: string, input: RoleCreate): GuildRequest<GuildRole> | undefined {
    if (!identifier(guildId)) return undefined
    const json = roleBody(input, true)
    if (!json) return undefined
    return {
        guildId,
        bucket: "guild:role:create",
        cache: { selection: { kind: "roles", guildId }, mutation: true },
        path: `/guilds/${guildId}/roles`,
        method: "POST",
        status: 200,
        json,
        decode: (value) => {
            const role = decodeRole(value, guildId)
            return role?.id !== guildId ? role : undefined
        },
    }
}

export function roleEdit(target: RoleReference, input: RoleEdit): GuildRequest<GuildRole> | undefined {
    if (!record(target) || !identifier(target.guildId) || !identifier(target.id)) return undefined
    const { guildId, id } = target
    const json = roleBody(input, false)
    if (!json) return undefined
    return {
        guildId,
        bucket: "guild:role:update",
        cache: {
            selection: { kind: "roles", guildId, ...(input.hoistPosition === undefined ? { id } : {}) },
            mutation: true,
        },
        path: `/guilds/${guildId}/roles/${id}`,
        method: "PATCH",
        status: 200,
        json,
        decode: (value) => {
            const role = decodeRole(value, guildId)
            return role?.id === id ? role : undefined
        },
    }
}

export function roleDelete(target: RoleReference): GuildRequest<void> | undefined {
    if (!record(target) || !identifier(target.guildId) || !identifier(target.id) || target.id === target.guildId)
        return undefined
    return {
        guildId: target.guildId,
        bucket: "guild:role:delete",
        cache: { selection: { kind: "roles", guildId: target.guildId }, mutation: true, members: true },
        path: `/guilds/${target.guildId}/roles/${target.id}`,
        method: "DELETE",
        status: 204,
        decode: () => undefined,
    }
}

export function roleReorder(guildId: string, positions: readonly RolePosition[]): GuildRequest<void> | undefined {
    if (!identifier(guildId) || !Array.isArray(positions) || positions.length === 0) return undefined
    const ids = new Set<string>()
    const updates: RolePosition[] = []
    let bytes = 2
    for (const item of positions) {
        if (
            !record(item) ||
            Object.keys(item).some((key) => key !== "id" && key !== "position") ||
            !identifier(item.id) ||
            item.id === guildId ||
            ids.has(item.id) ||
            typeof item.position !== "number" ||
            !Number.isSafeInteger(item.position) ||
            item.position < 0
        )
            return undefined
        const copy = { id: item.id, position: item.position }
        bytes += Buffer.byteLength(JSON.stringify(copy)) + (updates.length ? 1 : 0)
        if (bytes > 4_194_304) return undefined
        ids.add(item.id)
        updates.push(copy)
    }
    return {
        guildId,
        bucket: "guild:role:positions",
        cache: { selection: { kind: "roles", guildId }, mutation: true },
        path: `/guilds/${guildId}/roles`,
        method: "PATCH",
        status: 204,
        json: JSON.stringify(updates),
        decode: () => undefined,
    }
}

export function roleSetHoistPositions(
    guildId: string,
    positions: readonly RoleHoistPosition[],
): GuildRequest<void> | undefined {
    if (!identifier(guildId) || !Array.isArray(positions) || positions.length === 0) return undefined
    const ids = new Set<string>()
    const updates: { id: string; hoist_position: number }[] = []
    let bytes = 2
    for (const item of positions) {
        if (
            !record(item) ||
            Object.keys(item).some((key) => key !== "id" && key !== "hoistPosition") ||
            !identifier(item.id) ||
            item.id === guildId ||
            ids.has(item.id) ||
            !int32(item.hoistPosition)
        )
            return undefined
        const copy = { id: item.id, hoist_position: item.hoistPosition }
        bytes += Buffer.byteLength(JSON.stringify(copy)) + (updates.length ? 1 : 0)
        if (bytes > 4_194_304) return undefined
        ids.add(item.id)
        updates.push(copy)
    }
    return {
        guildId,
        bucket: "guild:role:hoist-positions",
        cache: { selection: { kind: "roles", guildId }, mutation: true },
        path: `/guilds/${guildId}/roles/hoist-positions`,
        method: "PATCH",
        status: 204,
        json: JSON.stringify(updates),
        decode: () => undefined,
    }
}

export function roleResetHoistPositions(guildId: string): GuildRequest<void> | undefined {
    if (!identifier(guildId)) return undefined
    return {
        guildId,
        bucket: "guild:role:hoist-positions",
        cache: { selection: { kind: "roles", guildId }, mutation: true },
        path: `/guilds/${guildId}/roles/hoist-positions`,
        method: "DELETE",
        status: 204,
        decode: () => undefined,
    }
}
