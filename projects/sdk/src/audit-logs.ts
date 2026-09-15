import type { PaginationQuery } from "./pagination.js"
import type { User } from "./users.js"

/** Event categories for filtering a guild's audit log, such as role changes, bans or invite creation.
 * Pass a value as AuditLogQuery.actionType. These values describe recorded administrative actions, not gateway events
 */
export const AuditLogActions: Readonly<{
    /** Guild-wide settings changed */
    readonly GuildUpdate: 1
    /** A guild channel was created */
    readonly ChannelCreate: 10
    /** A guild channel's settings changed */
    readonly ChannelUpdate: 11
    /** A guild channel was deleted */
    readonly ChannelDelete: 12
    /** A channel-specific role or member permission overwrite was added */
    readonly ChannelOverwriteCreate: 13
    /** An existing channel-specific permission overwrite changed */
    readonly ChannelOverwriteUpdate: 14
    /** A channel-specific permission overwrite was removed */
    readonly ChannelOverwriteDelete: 15
    /** A member was removed from the guild without a ban */
    readonly MemberKick: 20
    /** A bulk membership-pruning action was recorded */
    readonly MemberPrune: 21
    /** An account was banned from the guild */
    readonly MemberBanAdd: 22
    /** An account's guild ban was lifted */
    readonly MemberBanRemove: 23
    /** A member's guild-specific settings or moderation state changed */
    readonly MemberUpdate: 24
    /** A member's assigned roles changed */
    readonly MemberRoleUpdate: 25
    /** A member was moved between voice channels */
    readonly MemberMove: 26
    /** A member was disconnected from voice */
    readonly MemberDisconnect: 27
    /** A bot was added to the guild */
    readonly BotAdd: 28
    /** A guild role was created */
    readonly RoleCreate: 30
    /** A guild role's settings changed */
    readonly RoleUpdate: 31
    /** A guild role was deleted */
    readonly RoleDelete: 32
    /** An invitation code was created */
    readonly InviteCreate: 40
    /** An existing invitation's settings changed */
    readonly InviteUpdate: 41
    /** An invitation code was revoked */
    readonly InviteDelete: 42
    /** A webhook was created */
    readonly WebhookCreate: 50
    /** An existing webhook's settings changed */
    readonly WebhookUpdate: 51
    /** A webhook was deleted */
    readonly WebhookDelete: 52
    /** A custom guild emoji was created */
    readonly EmojiCreate: 60
    /** A custom guild emoji's metadata changed */
    readonly EmojiUpdate: 61
    /** A custom guild emoji was deleted */
    readonly EmojiDelete: 62
    /** A message deletion was recorded, potentially with a consolidated count */
    readonly MessageDelete: 72
    /** A bulk message-deletion action was recorded */
    readonly MessageBulkDelete: 73
    /** A message was pinned */
    readonly MessagePin: 74
    /** A message was unpinned */
    readonly MessageUnpin: 75
    /** A custom guild sticker was created */
    readonly StickerCreate: 90
    /** A custom guild sticker's metadata changed */
    readonly StickerUpdate: 91
    /** A custom guild sticker was deleted */
    readonly StickerDelete: 92
}> = Object.freeze({
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

/** Permission names added or removed by a recorded role change */
export interface AuditLogPermissionsDiff {
    /** Permission names added by the change */
    readonly added: readonly string[]
    /** Permission names removed by the change */
    readonly removed: readonly string[]
}

/** A JSON value the SDK accepts as a recorded setting before or after an audit-log change */
export type AuditLogChangeValue =
    string | number | boolean | null | readonly string[] | readonly number[] | AuditLogPermissionsDiff

/** Before-and-after information for one field recorded by an audit entry.
 * Inspect key to identify the setting, then oldValue and newValue for the recorded values.
 * An omitted side is unavailable, not equivalent to null or an unchanged value
 */
export interface AuditLogChange {
    /** Provider-defined field key, including future field names */
    readonly key: string
    /** Value before the change. Omission is distinct from null */
    readonly oldValue?: AuditLogChangeValue
    /** Value after the change. Omission is distinct from null */
    readonly newValue?: AuditLogChangeValue
}

/** Action-specific details explaining an audit record, such as the destination channel or affected entity count.
 * Context fields remain absent when Fluxer did not supply them.
 * Their meaning depends on the entry's actionType
 */
export interface AuditLogOptions {
    /** Decimal channel ID relevant to the action */
    readonly channelId?: string
    /** Number of affected entities, including a consolidated deletion count */
    readonly count?: number
    /** Legacy whole-day deletion value recorded for a member ban */
    readonly deleteMemberDays?: string
    /** Seconds of messages deleted for a member ban, present only when Fluxer recorded a positive duration */
    readonly deleteMessageSeconds?: number
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

/** One recorded administrative action in a guild, with available actor, target, reason and changed settings.
 * The record is frozen. Fetch current resources when a decision depends on their present state.
 * The targetId field can contain an invite code, and reason can contain caller-authored text. Treat both as potentially sensitive
 */
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

/** A filtered page of administrative records with public user and token-free webhook details referenced by the page.
 * Match an entry's userId to users when that account was supplied. Related resources are page-local observations,
 * not cache writes or a complete directory of guild users and webhooks
 */
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

/** Choose an actor filter, action filter or both to read the audit log without changing it */
type AuditLogFilter =
    | {
          /** Only actions recorded for this acting account, identified by decimal user ID */
          readonly userId: string
          /** Narrow the actor's records to this AuditLogActions category. Omit to include all their action categories */
          readonly actionType?: AuditLogActionType
      }
    | {
          /** Narrow this action category to records for one acting account, identified by decimal user ID */
          readonly userId?: string
          /** Only records in this AuditLogActions category. Required when no acting-user filter is supplied */
          readonly actionType: AuditLogActionType
      }

/** Inspect one page of recorded guild activity, filtered by actor, action category or both.
 * At least one filter is required because an unfiltered provider read can change the log rather than only observe it.
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

/** Settings for reading filtered audit entries from newest to oldest, with explicit limits */
interface AuditLogIterationQueryBase extends PaginationQuery {
    /** Exclusive decimal audit-entry cursor selecting older entries */
    readonly before?: string
}

/** Read filtered administrative entries from newest to oldest across bounded pages.
 * maxItems is required through PaginationQuery. Related page users and webhooks are not yielded by this traversal.
 * Filters prevent Fluxer's unfiltered message-delete consolidation behavior, but concurrent activity can still change
 * the observed log between pages
 */
export type AuditLogIterationQuery = AuditLogIterationQueryBase & AuditLogFilter
