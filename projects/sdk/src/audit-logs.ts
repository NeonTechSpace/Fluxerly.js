import type { ForumDefaultReaction, ForumTag, GuildThreadChannel } from "./channels.js"
import type { PaginationQuery } from "./pagination.js"
import type { User } from "./users.js"

/** Event categories for filtering a community's audit log, such as role changes, bans or invite creation.
 * Pass a value as AuditLogQuery.actionType. These values describe recorded administrative actions, not gateway events
 *
 * @category Guilds and members
 */
export const AuditLogActions: Readonly<{
    /** Community-wide settings changed */
    readonly GuildUpdate: 1
    /** A community channel was created */
    readonly ChannelCreate: 10
    /** A community channel's settings changed */
    readonly ChannelUpdate: 11
    /** A community channel was deleted */
    readonly ChannelDelete: 12
    /** A channel-specific role or member permission overwrite was added */
    readonly ChannelOverwriteCreate: 13
    /** An existing channel-specific permission overwrite changed */
    readonly ChannelOverwriteUpdate: 14
    /** A channel-specific permission overwrite was removed */
    readonly ChannelOverwriteDelete: 15
    /** A member was removed from the community without a ban */
    readonly MemberKick: 20
    /** A bulk membership-pruning action was recorded */
    readonly MemberPrune: 21
    /** An account was banned from the community */
    readonly MemberBanAdd: 22
    /** An account's community ban was lifted */
    readonly MemberBanRemove: 23
    /** A member's community-specific settings or moderation state changed */
    readonly MemberUpdate: 24
    /** A member's assigned roles changed */
    readonly MemberRoleUpdate: 25
    /** A member was moved between voice channels */
    readonly MemberMove: 26
    /** A member was disconnected from voice */
    readonly MemberDisconnect: 27
    /** A bot was added to the community */
    readonly BotAdd: 28
    /** A community role was created */
    readonly RoleCreate: 30
    /** A community role's settings changed */
    readonly RoleUpdate: 31
    /** A community role was deleted */
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
    /** A custom community emoji was created */
    readonly EmojiCreate: 60
    /** A custom community emoji's metadata changed */
    readonly EmojiUpdate: 61
    /** A custom community emoji was deleted */
    readonly EmojiDelete: 62
    /** A message deletion was recorded, potentially with a consolidated count */
    readonly MessageDelete: 72
    /** A bulk message-deletion action was recorded */
    readonly MessageBulkDelete: 73
    /** A message was pinned */
    readonly MessagePin: 74
    /** A message was unpinned */
    readonly MessageUnpin: 75
    /** A custom community sticker was created */
    readonly StickerCreate: 90
    /** A custom community sticker's metadata changed */
    readonly StickerUpdate: 91
    /** A custom community sticker was deleted */
    readonly StickerDelete: 92
    /** A thread was created */
    readonly ThreadCreate: 110
    /** A thread's settings changed */
    readonly ThreadUpdate: 111
    /** A thread was deleted */
    readonly ThreadDelete: 112
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
    ThreadCreate: 110,
    ThreadUpdate: 111,
    ThreadDelete: 112,
} as const)

/**
 * One currently supported Fluxer audit-action value
 *
 * @category Guilds and members
 */
export type AuditLogActionType = (typeof AuditLogActions)[keyof typeof AuditLogActions]

/**
 * Permission names added or removed by a recorded role change
 *
 * @category Guilds and members
 */
export interface AuditLogPermissionsDiff {
    /** Permission names added by the change */
    readonly added: readonly string[]
    /** Permission names removed by the change */
    readonly removed: readonly string[]
}

/** A value recorded as a setting before or after an audit-log change.
 * The forum shapes come from forum and media channel changes: The available_tags key records ForumTag values, and
 * default_reaction_emoji records a ForumDefaultReaction
 *
 * @category Guilds and members
 */
export type AuditLogChangeValue =
    | string
    | number
    | boolean
    | null
    | readonly string[]
    | readonly number[]
    | AuditLogPermissionsDiff
    | readonly ForumTag[]
    | ForumDefaultReaction

/** Before-and-after information for one field recorded by an audit entry.
 * Inspect key to identify the setting, then oldValue and newValue for the recorded values.
 * An omitted side is unavailable, not equivalent to null or an unchanged value
 *
 * @category Guilds and members
 */
export interface AuditLogChange {
    /** Provider-defined field key, including future field names */
    readonly key: string
    /** Value before the change. Omission is distinct from null */
    readonly oldValue?: AuditLogChangeValue
    /** Value after the change. Omission is distinct from null */
    readonly newValue?: AuditLogChangeValue
}

/** Extra details for an audit record, such as the destination channel or number of affected items.
 * Context fields remain absent when Fluxer did not supply them.
 * Their meaning depends on the entry's actionType
 *
 * @category Guilds and members
 */
export interface AuditLogOptions {
    /** Decimal channel ID relevant to the action */
    readonly channelId?: string
    /** Number of affected entities, including a consolidated deletion count */
    readonly count?: number
    /** Legacy whole-day deletion value recorded for a member ban */
    readonly deleteMemberDays?: string
    /**
     * Milliseconds of recent messages deleted for a member ban, in the unit of BanInput deleteMessagesMs.
     * Present only when Fluxer recorded a positive duration.
     * The value is rounded to whole milliseconds. A source duration whose milliseconds are not a safe integer rejects the REST page or is a malformed gateway dispatch
     */
    readonly deleteMessagesMs?: number
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

/** One recorded administrative action in a community, with any available actor, target, reason and changed settings.
 * The record is frozen. Fetch current resources when a decision depends on their present state.
 * The targetId field can contain an invite code, and reason can contain caller-authored text. Treat both as potentially sensitive
 *
 * @category Guilds and members
 */
export interface AuditLogEntry {
    /** Decimal audit-entry ID */
    readonly id: string
    /** Recorded Fluxer action, compared with AuditLogActions values. An action Fluxer adds later keeps its number here */
    readonly actionType: number
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

/**
 * Frozen, token-free webhook metadata accompanying an audit-log page
 *
 * @category Guilds and members
 */
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

/** One filtered page of administrative records, with public user, token-free webhook and thread details used by that page.
 * Match an entry's userId against users when Fluxer supplied that account. The related resources describe this page only.
 * They do not update the cache or list every community user, webhook and thread
 *
 * @category Guilds and members
 */
export interface AuditLogPage {
    /** Entries in descending entry-ID order for filtered requests */
    readonly entries: readonly AuditLogEntry[]
    /** Public user snapshots referenced by this page, without a user-cache write */
    readonly users: readonly User[]
    /** Token-free webhook snapshots referenced by this page */
    readonly webhooks: readonly AuditLogWebhook[]
    /** Snapshots of the threads that this page's thread actions target and that still exist, without a cache write.
     * Match an entry's targetId against their IDs. Empty when Fluxer listed none
     */
    readonly threads: readonly GuildThreadChannel[]
}

/**
 * Common settings for one filtered remote audit-log page request
 *
 * @category Guilds and members
 */
export interface AuditLogQueryBase {
    /** Maximum returned entries, 1–100, default 50 */
    readonly limit?: number
    /** Audit-entry ID for reading older entries, excluding the entry itself. Cannot be combined with after */
    readonly before?: string
    /** Audit-entry ID for reading newer entries, excluding the entry itself. Cannot be combined with before */
    readonly after?: string
    /** Acting-user filter. Omit only with actionType: Fluxer rewrites unfiltered message-delete records */
    readonly userId?: string
    /** Action filter. Omit only with userId: Fluxer rewrites unfiltered message-delete records */
    readonly actionType?: AuditLogActionType
}

/**
 * Choose an actor filter, action filter or both to read the audit log without changing it
 *
 * @category Guilds and members
 */
export type AuditLogFilter =
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

/** Read one page of community audit records for an actor, action category or both.
 * At least one filter is required because an unfiltered Fluxer read can change the log.
 * Without either filter, Fluxer can replace individual message-deletion records with a combined record
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
 *
 * @category Guilds and members
 */
export type AuditLogQuery = AuditLogQueryBase & AuditLogFilter

/**
 * Settings for reading filtered audit entries from newest to oldest, with explicit limits
 *
 * @category Guilds and members
 */
export interface AuditLogIterationQueryBase extends PaginationQuery {
    /** Exclusive decimal audit-entry cursor selecting older entries */
    readonly before?: string
}

/** Read filtered audit entries from newest to oldest, bounded by the requested page and item limits.
 * PaginationQuery requires maxItems. This iterator yields entries, not the related users and webhooks in each page.
 * Filters prevent Fluxer from combining message-deletion records during this read. Other activity can still change the log between pages
 *
 * @category Guilds and members
 */
export type AuditLogIterationQuery = AuditLogIterationQueryBase & AuditLogFilter
