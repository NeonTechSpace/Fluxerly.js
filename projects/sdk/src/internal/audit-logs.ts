import type {
    AuditLogActionType,
    AuditLogChange,
    AuditLogChangeValue,
    AuditLogEntry,
    AuditLogOptions,
    AuditLogPage,
    AuditLogPermissionsDiff,
    AuditLogWebhook,
} from "#sdk/audit-logs"
import { AuditLogActions } from "#sdk/audit-logs"
import { decodeUser } from "./users.js"
import type { GuildRequest } from "./guilds.js"
import { identifier, record } from "./message.js"

const actionTypes = new Set<number>(Object.values(AuditLogActions))
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
const actionType = (value: unknown): value is AuditLogActionType => typeof value === "number" && actionTypes.has(value)
const nullableIdentifier = (value: unknown): value is string | null => value === null || identifier(value)
const nullableText = (value: unknown): value is string | null => value === null || typeof value === "string"

function changeValue(value: unknown): AuditLogChangeValue | undefined {
    if (typeof value === "string" || typeof value === "boolean" || value === null) return value
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined
    if (Array.isArray(value)) {
        if (value.every((item) => typeof item === "string")) return Object.freeze([...value] as string[])
        if (value.every((item) => typeof item === "number" && Number.isFinite(item)))
            return Object.freeze([...value] as number[])
        return undefined
    }
    if (!record(value) || !Array.isArray(value.added) || !Array.isArray(value.removed)) return undefined
    if (
        !value.added.every((item) => typeof item === "string") ||
        !value.removed.every((item) => typeof item === "string")
    )
        return undefined
    return Object.freeze({
        added: Object.freeze([...value.added]),
        removed: Object.freeze([...value.removed]),
    }) as AuditLogPermissionsDiff
}

function changes(value: unknown): readonly AuditLogChange[] | undefined {
    if (!Array.isArray(value)) return undefined
    const result: AuditLogChange[] = []
    for (const item of value) {
        if (!record(item) || typeof item.key !== "string") return undefined
        const oldValue = item.old_value === undefined ? undefined : changeValue(item.old_value)
        const newValue = item.new_value === undefined ? undefined : changeValue(item.new_value)
        if (
            (item.old_value !== undefined && oldValue === undefined) ||
            (item.new_value !== undefined && newValue === undefined)
        )
            return undefined
        result.push(
            Object.freeze({
                key: item.key,
                ...(oldValue === undefined ? {} : { oldValue }),
                ...(newValue === undefined ? {} : { newValue }),
            }),
        )
    }
    return Object.freeze(result)
}

function options(value: unknown): AuditLogOptions | undefined {
    if (!record(value)) return undefined
    if (
        (value.channel_id !== undefined && typeof value.channel_id !== "string") ||
        (value.count !== undefined && !finite(value.count)) ||
        (value.delete_member_days !== undefined && typeof value.delete_member_days !== "string") ||
        (value.id !== undefined && typeof value.id !== "string") ||
        (value.integration_type !== undefined && !finite(value.integration_type)) ||
        (value.message_id !== undefined && typeof value.message_id !== "string") ||
        (value.members_removed !== undefined && !finite(value.members_removed)) ||
        (value.role_name !== undefined && typeof value.role_name !== "string") ||
        (value.type !== undefined && !finite(value.type)) ||
        (value.inviter_id !== undefined && typeof value.inviter_id !== "string") ||
        (value.max_age !== undefined && !finite(value.max_age)) ||
        (value.max_uses !== undefined && !finite(value.max_uses)) ||
        (value.temporary !== undefined && typeof value.temporary !== "boolean") ||
        (value.uses !== undefined && !finite(value.uses))
    )
        return undefined
    return Object.freeze({
        ...(value.channel_id === undefined ? {} : { channelId: value.channel_id }),
        ...(value.count === undefined ? {} : { count: value.count }),
        ...(value.delete_member_days === undefined ? {} : { deleteMemberDays: value.delete_member_days }),
        ...(value.id === undefined ? {} : { id: value.id }),
        ...(value.integration_type === undefined ? {} : { integrationType: value.integration_type }),
        ...(value.message_id === undefined ? {} : { messageId: value.message_id }),
        ...(value.members_removed === undefined ? {} : { membersRemoved: value.members_removed }),
        ...(value.role_name === undefined ? {} : { roleName: value.role_name }),
        ...(value.type === undefined ? {} : { type: value.type }),
        ...(value.inviter_id === undefined ? {} : { inviterId: value.inviter_id }),
        ...(value.max_age === undefined ? {} : { maxAgeSeconds: value.max_age }),
        ...(value.max_uses === undefined ? {} : { maxUses: value.max_uses }),
        ...(value.temporary === undefined ? {} : { temporary: value.temporary }),
        ...(value.uses === undefined ? {} : { uses: value.uses }),
    })
}

function entry(value: unknown): AuditLogEntry | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        !actionType(value.action_type) ||
        (value.user_id !== undefined && !nullableIdentifier(value.user_id)) ||
        (value.target_id !== undefined && !nullableText(value.target_id)) ||
        (value.reason !== undefined && typeof value.reason !== "string")
    )
        return undefined
    const itemOptions = value.options === undefined ? undefined : options(value.options)
    const itemChanges = value.changes === undefined ? undefined : changes(value.changes)
    if ((value.options !== undefined && !itemOptions) || (value.changes !== undefined && !itemChanges)) return undefined
    return Object.freeze({
        id: value.id,
        actionType: value.action_type,
        ...(value.user_id === undefined ? {} : { userId: value.user_id }),
        ...(value.target_id === undefined ? {} : { targetId: value.target_id }),
        ...(value.reason === undefined ? {} : { reason: value.reason }),
        ...(itemOptions === undefined ? {} : { options: itemOptions }),
        ...(itemChanges === undefined ? {} : { changes: itemChanges }),
    })
}

function webhook(value: unknown): AuditLogWebhook | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        (value.type !== 1 && value.type !== 2) ||
        (value.guild_id !== undefined && !nullableIdentifier(value.guild_id)) ||
        (value.channel_id !== undefined && !nullableIdentifier(value.channel_id)) ||
        typeof value.name !== "string" ||
        (value.avatar_hash !== undefined && !nullableText(value.avatar_hash))
    )
        return undefined
    return Object.freeze({
        id: value.id,
        type: value.type,
        ...(value.guild_id === undefined ? {} : { guildId: value.guild_id }),
        ...(value.channel_id === undefined ? {} : { channelId: value.channel_id }),
        name: value.name,
        ...(value.avatar_hash === undefined ? {} : { avatarHash: value.avatar_hash }),
    })
}

interface EncodedAuditLogQuery {
    readonly limit: number
    readonly before?: string
    readonly after?: string
    readonly userId?: string
    readonly actionType?: AuditLogActionType
    readonly params: URLSearchParams
}

function encodeQuery(query?: unknown): EncodedAuditLogQuery | undefined {
    const input = query === undefined ? {} : query
    if (
        !record(input) ||
        Object.keys(input).some((key) => !["limit", "before", "after", "userId", "actionType"].includes(key))
    )
        return undefined
    const limit = input.limit === undefined ? 50 : input.limit
    if (
        typeof limit !== "number" ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (input.before !== undefined && !identifier(input.before)) ||
        (input.after !== undefined && !identifier(input.after)) ||
        (input.before !== undefined && input.after !== undefined) ||
        (input.userId !== undefined && !identifier(input.userId)) ||
        (input.actionType !== undefined && !actionType(input.actionType)) ||
        (input.userId === undefined && input.actionType === undefined)
    )
        return undefined
    const params = new URLSearchParams({ limit: String(limit) })
    if (input.before !== undefined) params.set("before", input.before)
    if (input.after !== undefined) params.set("after", input.after)
    if (input.userId !== undefined) params.set("user_id", input.userId)
    if (input.actionType !== undefined) params.set("action_type", String(input.actionType))
    return {
        limit,
        ...(input.before === undefined ? {} : { before: input.before }),
        ...(input.after === undefined ? {} : { after: input.after }),
        ...(input.userId === undefined ? {} : { userId: input.userId }),
        ...(input.actionType === undefined ? {} : { actionType: input.actionType }),
        params,
    }
}

export function decodeAuditLogPage(value: unknown, query: EncodedAuditLogQuery): AuditLogPage | undefined {
    if (!record(value) || !Array.isArray(value.audit_log_entries) || value.audit_log_entries.length > query.limit)
        return undefined
    if (!Array.isArray(value.users) || !Array.isArray(value.webhooks)) return undefined
    const entries: AuditLogEntry[] = []
    let previous = query.before === undefined ? undefined : BigInt(query.before)
    for (const source of value.audit_log_entries) {
        const item = entry(source)
        if (
            !item ||
            (previous !== undefined && BigInt(item.id) >= previous) ||
            (query.userId !== undefined && item.userId !== query.userId) ||
            (query.actionType !== undefined && item.actionType !== query.actionType)
        )
            return undefined
        previous = BigInt(item.id)
        entries.push(item)
    }
    if (query.after !== undefined && entries.some((item) => BigInt(item.id) <= BigInt(query.after!))) return undefined
    const users = []
    const userIds = new Set<string>()
    for (const source of value.users) {
        const user = decodeUser(source)
        if (!user || userIds.has(user.id)) return undefined
        userIds.add(user.id)
        users.push(user)
    }
    const webhooks = []
    const webhookIds = new Set<string>()
    for (const source of value.webhooks) {
        const item = webhook(source)
        if (!item || webhookIds.has(item.id)) return undefined
        webhookIds.add(item.id)
        webhooks.push(item)
    }
    return Object.freeze({
        entries: Object.freeze(entries),
        users: Object.freeze(users),
        webhooks: Object.freeze(webhooks),
    })
}

/** Builds a remote-only, filtered audit-log page request without cache admission or a provider-side consolidation write */
export function auditLogPage(guildId: string, query?: unknown): GuildRequest<AuditLogPage> | undefined {
    const encoded = encodeQuery(query)
    if (!identifier(guildId) || !encoded) return undefined
    return {
        guildId,
        bucket: "guild:audit-logs",
        path: `/guilds/${guildId}/audit-logs?${encoded.params}`,
        method: "GET",
        status: 200,
        decode: (value) => decodeAuditLogPage(value, encoded),
    }
}
