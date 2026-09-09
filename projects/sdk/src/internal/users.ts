import type { DirectMessageChannel, DirectMessageGroupEdit, User } from "#sdk/users"
import { identifier, record } from "./message.js"

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
