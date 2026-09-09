import type { PaginationQuery } from "./pagination.js"
import type { User } from "./users.js"

/** Known Fluxer audit-action values accepted by the audit-log route */
export const AuditLogActions = Object.freeze({
    GuildUpdate: 1,
    ChannelCreate: 10,
    ChannelUpdate: 11,
    ChannelDelete: 12,
    ChannelOverwriteCreate: 13,
    ChannelOverwriteUpdate: 14,
    ChannelOverwriteDelete: 15,
    MemberKick: 20,
    MemberPrune: 21,
    MemberBanAdd: 22,
    MemberBanRemove: 23,
    MemberUpdate: 24,
    MemberRoleUpdate: 25,
    MemberMove: 26,
    MemberDisconnect: 27,
    BotAdd: 28,
    RoleCreate: 30,
    RoleUpdate: 31,
    RoleDelete: 32,
    InviteCreate: 40,
    InviteUpdate: 41,
    InviteDelete: 42,
    WebhookCreate: 50,
    WebhookUpdate: 51,
    WebhookDelete: 52,
    EmojiCreate: 60,
    EmojiUpdate: 61,
    EmojiDelete: 62,
    MessageDelete: 72,
    MessageBulkDelete: 73,
    MessagePin: 74,
    MessageUnpin: 75,
    StickerCreate: 90,
    StickerUpdate: 91,
    StickerDelete: 92,
} as const)

/** One currently supported Fluxer audit-action value */
export type AuditLogActionType = (typeof AuditLogActions)[keyof typeof AuditLogActions]

/** Explicit permission-name delta in a role audit-log change */
export interface AuditLogPermissionsDiff {
    /** Permission names added by the change */
    readonly added: readonly string[]
    /** Permission names removed by the change */
    readonly removed: readonly string[]
}

/** One allowlisted JSON value recorded on either side of an audit-log change */
export type AuditLogChangeValue =
    string | number | boolean | null | readonly string[] | readonly number[] | AuditLogPermissionsDiff

/** One changed audit field, preserving a missing old or new value */
export interface AuditLogChange {
    /** Provider-defined field key, including future field names */
    readonly key: string
    /** Value before the change; omission is distinct from null */
    readonly oldValue?: AuditLogChangeValue
    /** Value after the change; omission is distinct from null */
    readonly newValue?: AuditLogChangeValue
}

/** Context fields that Fluxer supplies only for applicable audit actions */
export interface AuditLogOptions {
    /** Decimal channel ID relevant to the action */
    readonly channelId?: string
    /** Number of affected entities, including a consolidated deletion count */
    readonly count?: number
    /** Legacy whole-day deletion value recorded for a member ban */
    readonly deleteMemberDays?: string
    /** Decimal overwrite target or other action-specific ID */
    readonly id?: string
    /** Provider integration-type value */
    readonly integrationType?: number
    /** Decimal message ID relevant to the action */
    readonly messageId?: string
    /** Number of memberships removed by a prune action */
    readonly membersRemoved?: number
    /** Role name recorded by an applicable action */
    readonly roleName?: string
    /** Channel or permission-overwrite type recorded by an applicable action */
    readonly type?: number
    /** Decimal ID of an invite creator */
    readonly inviterId?: string
    /** Configured invite lifetime in seconds */
    readonly maxAgeSeconds?: number
    /** Configured maximum invite uses */
    readonly maxUses?: number
    /** Whether the applicable recorded entity is temporary */
    readonly temporary?: boolean
    /** Invite use count recorded by an applicable action */
    readonly uses?: number
}

/** Frozen remote audit-log entry, not a live record or a permission decision */
export interface AuditLogEntry {
    /** Decimal audit-entry ID */
    readonly id: string
    /** Recorded Fluxer action */
    readonly actionType: AuditLogActionType
    /** Acting user ID when Fluxer supplied one */
    readonly userId?: string | null
    /** Affected entity ID or invite code when Fluxer supplied one, not necessarily a decimal ID */
    readonly targetId?: string | null
    /** Recorded audit reason, omitted when the action had none */
    readonly reason?: string
    /** Action-specific context, omitted when no published option applies */
    readonly options?: AuditLogOptions
    /** Changed fields, omitted when the action recorded none */
    readonly changes?: readonly AuditLogChange[]
}

/** Frozen, token-free webhook metadata accompanying an audit-log page */
export interface AuditLogWebhook {
    /** Decimal webhook ID */
    readonly id: string
    /** Fluxer webhook type: 1 incoming or 2 channel follower */
    readonly type: 1 | 2
    /** Decimal owning guild ID, or null when Fluxer supplied none */
    readonly guildId?: string | null
    /** Decimal destination channel ID, or null when Fluxer supplied none */
    readonly channelId?: string | null
    /** Webhook display name */
    readonly name: string
    /** Webhook avatar hash, or null when Fluxer supplied none */
    readonly avatarHash?: string | null
}

/** One remote audit-log page. Related users and webhooks are page-local observations, not SDK caches */
export interface AuditLogPage {
    /** Entries in descending entry-ID order for filtered requests */
    readonly entries: readonly AuditLogEntry[]
    /** Public user snapshots referenced by this page, without a user-cache write */
    readonly users: readonly User[]
    /** Token-free webhook snapshots referenced by this page */
    readonly webhooks: readonly AuditLogWebhook[]
}

/** Common settings for one filtered remote audit-log page request */
interface AuditLogQueryBase {
    /** Maximum returned entries, 1–100, default 50 */
    readonly limit?: number
    /** Exclusive decimal audit-entry cursor selecting older entries. Cannot be combined with after */
    readonly before?: string
    /** Exclusive decimal audit-entry cursor selecting newer entries. Cannot be combined with before */
    readonly after?: string
    /** Acting-user filter. Omit only with actionType: Fluxer rewrites unfiltered message-delete records */
    readonly userId?: string
    /** Action filter. Omit only with userId: Fluxer rewrites unfiltered message-delete records */
    readonly actionType?: AuditLogActionType
}

/** At least one provider filter required for a non-mutating audit-log read */
type AuditLogFilter =
    | { readonly userId: string; readonly actionType?: AuditLogActionType }
    | { readonly userId?: string; readonly actionType: AuditLogActionType }

/** One filtered remote audit-log page request.
 * Fluxer can delete individual message-delete records and write a replacement when neither filter is supplied
 * @example
 * ```ts
 * import { AuditLogActions, type Client } from "@neontechspace/fluxerly"
 * export function auditExample(client: Client, guildId: string) {
 *     return client.auditLogs.fetchPage(guildId, { actionType: AuditLogActions.GuildUpdate })
 * }
 * export function auditTraversalExample(client: Client, guildId: string) {
 *     return client.auditLogs.iterate(guildId, { actionType: AuditLogActions.GuildUpdate, maxItems: 100 })
 * }
 * ```
 */
export type AuditLogQuery = AuditLogQueryBase & AuditLogFilter

/** Bounded newest-to-oldest traversal over filtered audit entries */
interface AuditLogIterationQueryBase extends PaginationQuery {
    /** Exclusive decimal audit-entry cursor selecting older entries */
    readonly before?: string
}

/** Bounded newest-to-oldest traversal over filtered audit entries */
export type AuditLogIterationQuery = AuditLogIterationQueryBase & AuditLogFilter
