import type {
    DirectMessageChannel,
    DirectMessageGroupEdit,
    DirectMessageLatestMessages,
    User,
    UserProfile,
    UserProfileFields,
    UserProfileQuery,
} from "#sdk/users"
import type { Message } from "#sdk/messages"
import { decodeMessage, identifier, record } from "./message.js"

/** Validated requests executed by the client's shared REST scheduler */
export interface UserRequest<A> {
    readonly majorId: string
    readonly path: string
    readonly method: "GET" | "POST" | "PATCH" | "DELETE"
    readonly status: 200 | 204
    readonly json?: string
    readonly decode: (value: unknown) => A | undefined
    readonly resource: "users" | "directMessages"
    readonly id?: string
    readonly replace?: boolean
    readonly verifyType?: "private" | "group"
    /** Skips all user-cache generations and writes while retaining the shared REST scheduler and retries */
    readonly noCache?: boolean
}

const nullableText = (value: unknown): value is string | null => value === null || typeof value === "string"
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value)
const text = (value: unknown, min: number, max: number): value is string =>
    typeof value === "string" && [...value].length >= min && [...value].length <= max

/** Public-field allowlist, shared by explicit reads and complete user observations */
export function decodeUser(value: unknown): User | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        typeof value.username !== "string" ||
        typeof value.discriminator !== "string" ||
        !nullableText(value.global_name) ||
        !nullableText(value.avatar) ||
        !(value.avatar_color === null || integer(value.avatar_color)) ||
        !integer(value.flags) ||
        (value.bot !== undefined && typeof value.bot !== "boolean") ||
        (value.system !== undefined && typeof value.system !== "boolean")
    )
        return undefined
    return Object.freeze({
        id: value.id,
        username: value.username,
        discriminator: value.discriminator,
        displayName: value.global_name,
        avatar: value.avatar,
        avatarColor: value.avatar_color,
        isBot: value.bot === true,
        isSystem: value.system === true,
        flags: value.flags,
    })
}

export function decodeDirectMessage(value: unknown): DirectMessageChannel | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        (value.type !== 1 && value.type !== 3) ||
        (value.guild_id !== undefined && value.guild_id !== null) ||
        (!(value.type === 3 && value.recipients === undefined) && !Array.isArray(value.recipients)) ||
        (value.name !== undefined && !nullableText(value.name)) ||
        (value.icon !== undefined && !nullableText(value.icon)) ||
        (value.owner_id !== undefined && value.owner_id !== null && !identifier(value.owner_id)) ||
        (value.last_message_id !== undefined && value.last_message_id !== null && !identifier(value.last_message_id))
    )
        return undefined
    const recipients: User[] = []
    const ids = new Set<string>()
    for (const input of (value.recipients ?? []) as unknown[]) {
        const user = decodeUser(input)
        if (!user || ids.has(user.id)) return undefined
        ids.add(user.id)
        recipients.push(user)
    }
    const nicknames: Record<string, string> = {}
    if (value.nicks !== undefined) {
        if (!record(value.nicks)) return undefined
        for (const [id, nick] of Object.entries(value.nicks)) {
            if (!identifier(id) || !text(nick, 1, 32)) return undefined
            nicknames[id] = nick
        }
    }
    return Object.freeze({
        id: value.id,
        type: value.type === 1 ? "dm" : "group",
        recipients: Object.freeze(recipients),
        name: value.name ?? null,
        icon: value.icon ?? null,
        ownerId: value.owner_id ?? null,
        lastMessageId: value.last_message_id ?? null,
        nicknames: Object.freeze(nicknames),
    }) as DirectMessageChannel
}

export function userFetch(id: string): UserRequest<User> | undefined {
    if (id !== "@me" && !identifier(id)) return undefined
    return {
        majorId: id,
        path: `/users/${id}`,
        method: "GET",
        status: 200,
        resource: "users",
        ...(id === "@me" ? {} : { id }),
        decode: (value) => {
            const user = decodeUser(value)
            return user && (id === "@me" || user.id === id) ? user : undefined
        },
    }
}

/** Build one explicit profile read with only a caller-selected guild context and no relationship-expansion flags */
export function userProfile(id: string, query?: UserProfileQuery): UserRequest<UserProfile> | undefined {
    if (
        !identifier(id) ||
        (query !== undefined &&
            (!record(query) ||
                Object.keys(query).some((key) => key !== "guildId") ||
                (query.guildId !== undefined && !identifier(query.guildId))))
    )
        return undefined
    const guildId = typeof query?.guildId === "string" ? query.guildId : undefined
    const path = `/users/${id}/profile${guildId === undefined ? "" : `?guild_id=${encodeURIComponent(guildId)}`}`
    return {
        majorId: id,
        path,
        method: "GET",
        status: 200,
        resource: "users",
        noCache: true,
        decode: (value) => {
            if (
                !record(value) ||
                !record(value.user) ||
                !record(value.user_profile) ||
                (value.profile_limited !== undefined && typeof value.profile_limited !== "boolean")
            )
                return undefined
            const user = decodeUser(value.user)
            const profile = decodeUserProfileFields(value.user_profile, true)
            if (!user || user.id !== id || !profile) return undefined

            const member = value.guild_member
            if (member !== undefined) {
                if (!record(member)) return undefined
                if (member.guild_id !== undefined && (!identifier(member.guild_id) || member.guild_id !== guildId))
                    return undefined
                if (member.user !== undefined && (!record(member.user) || member.user.id !== id)) return undefined
            }

            let guildProfile: UserProfileFields | null = null
            if (value.guild_member_profile !== undefined && value.guild_member_profile !== null) {
                if (guildId === undefined) return undefined
                const decodedGuildProfile = decodeUserProfileFields(value.guild_member_profile, false)
                if (!decodedGuildProfile) return undefined
                guildProfile = decodedGuildProfile
            }
            return Object.freeze({ user, profile, guildProfile, isLimited: value.profile_limited === true })
        },
    }
}

function decodeUserProfileFields(value: unknown, accountProfile: boolean): UserProfileFields | undefined {
    if (
        !record(value) ||
        !nullableText(value.bio) ||
        !nullableText(value.pronouns) ||
        !nullableText(value.banner) ||
        !(value.accent_color === null || integer(value.accent_color))
    )
        return undefined
    let bannerColor: number | null | undefined
    if (accountProfile && value.banner_color !== undefined) {
        if (!(value.banner_color === null || integer(value.banner_color))) return undefined
        bannerColor = value.banner_color
    }
    const profile: UserProfileFields = {
        bio: value.bio,
        pronouns: value.pronouns,
        banner: value.banner,
        ...(bannerColor === undefined ? {} : { bannerColor }),
        accentColor: value.accent_color,
    }
    return Object.freeze(profile)
}

export function directMessageOpen(id: string): UserRequest<DirectMessageChannel> | undefined {
    if (!identifier(id)) return undefined
    const json = JSON.stringify({ recipient_id: id })
    if (Buffer.byteLength(json) > 4_194_304) return undefined
    return {
        majorId: "@me",
        path: "/users/@me/channels",
        method: "POST",
        status: 200,
        resource: "directMessages",
        json,
        decode: (value) => {
            const channel = decodeDirectMessage(value)
            return channel?.type === "dm" && channel.recipients.some((user) => user.id === id) ? channel : undefined
        },
    }
}

export function directMessageFetch(id: string): UserRequest<DirectMessageChannel> | undefined {
    if (!identifier(id)) return undefined
    return {
        majorId: id,
        id,
        path: `/channels/${id}`,
        method: "GET",
        status: 200,
        resource: "directMessages",
        decode: (value) => {
            const channel = decodeDirectMessage(value)
            return channel?.id === id ? channel : undefined
        },
    }
}

export function directMessageList(): UserRequest<readonly DirectMessageChannel[]> {
    return {
        majorId: "@me",
        path: "/users/@me/channels",
        method: "GET",
        status: 200,
        resource: "directMessages",
        replace: true,
        decode: (value) => {
            if (!Array.isArray(value)) return undefined
            const result: DirectMessageChannel[] = []
            const ids = new Set<string>()
            for (const item of value) {
                // Personal notes are not conversations and are deliberately excluded
                if (record(item) && item.type === 999) continue
                const channel = decodeDirectMessage(item)
                if (!channel || ids.has(channel.id)) return undefined
                ids.add(channel.id)
                result.push(channel)
            }
            return Object.freeze(result)
        },
    }
}

/** Request latest messages only for explicit private-channel IDs, without cache admission or conversation enumeration */
export function directMessageLatestMessages(
    ids: readonly string[],
): UserRequest<DirectMessageLatestMessages> | undefined {
    if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        ids.length > 100 ||
        Array.from(ids).some((id) => !identifier(id)) ||
        new Set(ids).size !== ids.length
    )
        return undefined
    const channelIds = [...ids]
    const json = JSON.stringify({ channels: channelIds })
    return {
        majorId: "@me",
        path: "/users/@me/channels/messages/preload",
        method: "POST",
        status: 200,
        resource: "directMessages",
        json,
        noCache: true,
        decode: (value) => {
            if (!record(value) || Object.keys(value).some((id) => !channelIds.includes(id))) return undefined
            const messages: Record<string, Message | null> = {}
            for (const [id, item] of Object.entries(value)) {
                if (item === null) {
                    messages[id] = null
                    continue
                }
                const message = decodeMessage(item)
                if (!message || message.channelId !== id) return undefined
                messages[id] = message
            }
            const omittedChannelIds = channelIds.filter((id) => !(id in messages))
            return Object.freeze({
                messages: Object.freeze(messages),
                omittedChannelIds: Object.freeze(omittedChannelIds),
            })
        },
    }
}

export function directMessageEdit(
    id: string,
    input: DirectMessageGroupEdit,
): UserRequest<DirectMessageChannel> | undefined {
    if (
        !identifier(id) ||
        !record(input) ||
        Object.keys(input).length === 0 ||
        Object.keys(input).some((key) => !["name", "icon", "ownerId", "nicknames"].includes(key)) ||
        (input.name !== undefined && !text(input.name, 1, 100)) ||
        (input.icon !== undefined &&
            input.icon !== null &&
            (typeof input.icon !== "string" ||
                !/^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/.test(input.icon))) ||
        (input.ownerId !== undefined && !identifier(input.ownerId))
    )
        return undefined
    if (
        input.nicknames !== undefined &&
        input.nicknames !== null &&
        (!record(input.nicknames) ||
            Object.entries(input.nicknames).some(
                ([id, value]) => !identifier(id) || (value !== null && !text(value, 1, 32)),
            ))
    )
        return undefined
    const json = JSON.stringify({ name: input.name, icon: input.icon, owner_id: input.ownerId, nicks: input.nicknames })
    if (json === "{}" || Buffer.byteLength(json) > 4_194_304) return undefined
    return {
        ...directMessageFetch(id)!,
        method: "PATCH",
        json,
        verifyType: "group",
        decode: (value) => {
            const channel = decodeDirectMessage(value)
            return channel?.id === id && channel.type === "group" ? channel : undefined
        },
    }
}

export function directMessageClose(id: string, recipient?: string): UserRequest<void> | undefined {
    if (!identifier(id) || (recipient !== undefined && !identifier(recipient))) return undefined
    return {
        majorId: id,
        id,
        path: `/channels/${id}${recipient === undefined ? "" : `/recipients/${recipient}`}`,
        method: "DELETE",
        status: 204,
        resource: "directMessages",
        verifyType: recipient === undefined ? "private" : "group",
        decode: () => undefined,
    }
}
