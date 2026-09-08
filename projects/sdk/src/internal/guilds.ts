import type {
    Guild,
    GuildMember,
    GuildRole,
    RoleCreate,
    RoleEdit,
    MemberQuery,
    MemberReference,
    RolePosition,
    RoleReference,
} from "#sdk/guilds"
import { identifier, record } from "./message.js"
import type { ResourceRequest } from "./guild-cache.js"

/** Validated request description; the shared REST owner retains admission, cleanup and rate state */
export interface GuildRequest<A> {
    readonly guildId: string
    readonly bucket: string
    readonly path: string
    readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
    readonly status: 200 | 204
    readonly json?: string
    readonly decode: (value: unknown) => A | undefined
    readonly cache: ResourceRequest
}

const nullableText = (value: unknown) => value === undefined || value === null || typeof value === "string"

export const guildEvents = {
    GUILD_MEMBER_ADD: "guildMemberAdd",
    GUILD_MEMBER_UPDATE: "guildMemberUpdate",
    GUILD_MEMBER_REMOVE: "guildMemberRemove",
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
    if (event === "GUILD_MEMBER_REMOVE") {
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
        !nullableText(value.banner)
    )
        return undefined
    return Object.freeze({
        id: value.id,
        name: value.name,
        ownerId: value.owner_id,
        features: Object.freeze([...value.features] as string[]),
        ...(value.icon === undefined ? {} : { icon: value.icon as string | null }),
        ...(value.banner === undefined ? {} : { banner: value.banner as string | null }),
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
        !nullableText(value.avatar)
    )
        return undefined
    return Object.freeze({
        guildId,
        userId: value.user.id,
        username: value.user.username,
        isBot: value.user.bot === true,
        roleIds: Object.freeze([...value.roles] as string[]),
        joinedAt: value.joined_at,
        ...(value.nick === undefined ? {} : { nickname: value.nick as string | null }),
        ...(value.avatar === undefined ? {} : { avatar: value.avatar as string | null }),
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

const int32 = (value: unknown): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647
const permission = (value: unknown): value is bigint =>
    typeof value === "bigint" && value >= 0n && value <= 18_446_744_073_709_551_615n

export function decodeRole(value: unknown, guildId: string): GuildRole | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        typeof value.name !== "string" ||
        !int32(value.color) ||
        !int32(value.position) ||
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
