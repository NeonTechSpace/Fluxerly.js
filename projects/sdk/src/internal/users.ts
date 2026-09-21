import type {
    DirectMessageChannel,
    DirectMessageGroupEdit,
    DirectMessageLatestMessages,
    User,
    UserProfile,
    UserProfileFields,
    UserProfileQuery,
} from "#sdk/users"
import type { MessageCore } from "#sdk/messages"
import type { MessageDecoder } from "./message-fields.js"
import { decodeMessage, identifier, record } from "./message.js"
import { InputValidationFailure, inputValidationFailure } from "#sdk/input-validation"
import { channelName, normalizedText } from "./field-text.js"

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
    /** Skips all user-cache conflict guards and writes while retaining the shared REST scheduler and retries */
    readonly noCache?: boolean
}

type UserValidationResult<A> = UserRequest<A> | InputValidationFailure

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

export function userFetch(id: string): UserValidationResult<User> {
    if (id !== "@me" && !identifier(id))
        return inputValidationFailure("userId", "format", "User IDs must be decimal strings or @me")
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
export function userProfile(id: string, query?: UserProfileQuery): UserValidationResult<UserProfile> {
    if (!identifier(id)) return inputValidationFailure("userId", "format", "User IDs must be decimal strings")
    if (query !== undefined && !record(query))
        return inputValidationFailure("query", "type", "User profile query must be an object")
    if (record(query) && Object.keys(query).some((key) => key !== "guildId"))
        return inputValidationFailure("query", "allowedFields", "User profile query may contain only guildId")
    if (record(query) && query.guildId !== undefined && !identifier(query.guildId))
        return inputValidationFailure("query.guildId", "format", "Guild IDs must be decimal strings")
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

export function directMessageOpen(id: string): UserValidationResult<DirectMessageChannel> {
    if (!identifier(id)) return inputValidationFailure("userId", "format", "User IDs must be decimal strings")
    const json = JSON.stringify({ recipient_id: id })
    if (Buffer.byteLength(json) > 4_194_304)
        return inputValidationFailure("userId", "size", "Direct message open input must fit the request byte limit")
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

export function directMessageFetch(id: string): UserValidationResult<DirectMessageChannel> {
    if (!identifier(id)) return inputValidationFailure("channelId", "format", "Channel IDs must be decimal strings")
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
export function directMessageLatestMessages(ids: readonly string[]): UserValidationResult<DirectMessageLatestMessages>
export function directMessageLatestMessages<M extends MessageCore>(
    ids: readonly string[],
    decode: MessageDecoder<M>,
): UserValidationResult<DirectMessageLatestMessages<M>>
export function directMessageLatestMessages(
    ids: readonly string[],
    decode: MessageDecoder<MessageCore> = decodeMessage,
): UserValidationResult<DirectMessageLatestMessages<MessageCore>> {
    if (!Array.isArray(ids)) return inputValidationFailure("channelIds", "type", "Channel IDs must be an array")
    const count = ids.length
    if (count === 0 || count > 100)
        return inputValidationFailure("channelIds", "length", "Latest-message reads require 1 through 100 channel IDs")
    const channelIds = new Array<string>(count)
    for (let index = 0; index < count; index++) channelIds[index] = ids[index]
    if (channelIds.some((id) => !identifier(id)))
        return inputValidationFailure("channelIds[]", "format", "Channel IDs must be decimal strings")
    if (new Set(channelIds).size !== channelIds.length)
        return inputValidationFailure("channelIds", "unique", "Channel IDs must be unique")
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
            const messages: Record<string, MessageCore | null> = {}
            for (const [id, item] of Object.entries(value)) {
                if (item === null) {
                    messages[id] = null
                    continue
                }
                const message = decode(item)
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
): UserValidationResult<DirectMessageChannel> {
    if (!identifier(id)) return inputValidationFailure("channelId", "format", "Channel IDs must be decimal strings")
    if (!record(input)) return inputValidationFailure("input", "type", "Group DM input must be an object")
    if (Object.keys(input).length === 0)
        return inputValidationFailure("input", "required", "Group DM input must contain at least one field")
    if (Object.keys(input).some((key) => !["name", "icon", "ownerId", "nicknames"].includes(key)))
        return inputValidationFailure(
            "input",
            "allowedFields",
            "Group DM input may contain only name, icon, ownerId, and nicknames",
        )
    if (
        (input.name !== undefined && input.name !== null && !channelName(input.name)) ||
        (input.icon !== undefined &&
            input.icon !== null &&
            (typeof input.icon !== "string" ||
                !/^data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/.test(input.icon))) ||
        (input.ownerId !== undefined && !identifier(input.ownerId))
    )
        return inputValidationFailure(
            "input",
            "format",
            "Group DM fields must satisfy their documented types, lengths, image format, and ID format",
        )
    if (
        input.nicknames !== undefined &&
        input.nicknames !== null &&
        (!record(input.nicknames) ||
            Object.entries(input.nicknames).some(
                ([id, value]) => !identifier(id) || (value !== null && (value === "" || !normalizedText(value, 0, 32))),
            ))
    )
        return inputValidationFailure(
            "nicknames",
            "format",
            "Group DM nicknames must map decimal user IDs to null or nonempty strings of at most 32 UTF-16 code units after provider normalization",
        )
    const json = JSON.stringify({ name: input.name, icon: input.icon, owner_id: input.ownerId, nicks: input.nicknames })
    if (json === "{}") return inputValidationFailure("input", "required", "Group DM input must encode a change")
    if (Buffer.byteLength(json) > 4_194_304)
        return inputValidationFailure("input", "size", "Group DM input must not exceed 4,194,304 encoded bytes")
    const current = directMessageFetch(id)
    if (current instanceof InputValidationFailure) return current
    return {
        ...current,
        method: "PATCH",
        json,
        verifyType: "group",
        decode: (value) => {
            const channel = decodeDirectMessage(value)
            return channel?.id === id && channel.type === "group" ? channel : undefined
        },
    }
}

export function directMessageClose(id: string, recipient?: string): UserValidationResult<void> {
    if (!identifier(id)) return inputValidationFailure("channelId", "format", "Channel IDs must be decimal strings")
    if (recipient !== undefined && !identifier(recipient))
        return inputValidationFailure("recipientId", "format", "Recipient IDs must be decimal strings")
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
