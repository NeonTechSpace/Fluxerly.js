import type { OperationOptions } from "./client.js"
import type { ClientClosedError } from "./errors.js"

/** Frozen guild identity and configuration observation, not a complete wire object or an object that updates in place */
export interface Guild {
    /** Decimal guild ID */
    readonly id: string
    /** Current guild name */
    readonly name: string
    /** Decimal owner user ID, not a permission decision */
    readonly ownerId: string
    /** Feature names supplied by Fluxer, including unknown future names */
    readonly features: readonly string[]
    /** Icon hash; null means no icon, omission means unavailable */
    readonly icon?: string | null
    /** Banner hash; null means no banner, omission means unavailable */
    readonly banner?: string | null
    /** Invite splash hash; null means no splash, omission means unavailable */
    readonly splash?: string | null
    /** Embedded-invite splash hash; null means no splash, omission means unavailable */
    readonly embedSplash?: string | null
    /** Invite splash-card alignment, omission means unavailable */
    readonly splashCardAlignment?: GuildSplashCardAlignment
    /** System-message channel ID; null disables it, omission means unavailable */
    readonly systemChannelId?: string | null
    /** System-message suppression flags, omission means unavailable */
    readonly systemChannelFlags?: number
    /** AFK voice-channel ID; null disables it, omission means unavailable */
    readonly afkChannelId?: string | null
    /** Seconds before Fluxer moves inactive voice participants to the AFK channel, omission means unavailable */
    readonly afkTimeoutSeconds?: number
    /** Default notification level for new members, omission means unavailable */
    readonly defaultMessageNotifications?: GuildDefaultMessageNotification
    /** Required member-verification level, omission means unavailable */
    readonly verificationLevel?: GuildVerificationLevel
    /** Whether Fluxer marks the guild as adult content, omission means unavailable */
    readonly nsfw?: boolean
    /** Whether Fluxer displays a guild-wide content warning, omission means unavailable */
    readonly contentWarningLevel?: GuildContentWarningLevel
    /** Custom guild-wide warning text; null restores Fluxer's localized default, omission means unavailable */
    readonly contentWarningText?: string | null
    /** Explicit-media filtering level, omission means unavailable */
    readonly explicitContentFilter?: GuildExplicitContentFilter
    /** ISO 8601 historical-message cutoff; null disables history for members without Read Message History */
    readonly messageHistoryCutoff?: string | null
}

/** Fluxer's currently supported system-channel flag bits */
export const GuildSystemChannelFlags = Object.freeze({
    SuppressJoinNotifications: 1,
})

/** One known system-channel flag bit. A flags value of zero clears every currently supported suppression */
export type GuildSystemChannelFlag = (typeof GuildSystemChannelFlags)[keyof typeof GuildSystemChannelFlags]

/** Fluxer's default notification levels for new guild members */
export const GuildDefaultMessageNotifications = Object.freeze({
    AllMessages: 0,
    OnlyMentions: 1,
})

/** One Fluxer default-notification level */
export type GuildDefaultMessageNotification =
    (typeof GuildDefaultMessageNotifications)[keyof typeof GuildDefaultMessageNotifications]

/** Fluxer's member-verification levels */
export const GuildVerificationLevels = Object.freeze({
    None: 0,
    Low: 1,
    Medium: 2,
    High: 3,
    VeryHigh: 4,
})

/** One Fluxer member-verification level */
export type GuildVerificationLevel = (typeof GuildVerificationLevels)[keyof typeof GuildVerificationLevels]

/** Fluxer's explicit-media filtering levels */
export const GuildExplicitContentFilters = Object.freeze({
    Disabled: 0,
    MembersWithoutRoles: 1,
    AllMembers: 2,
})

/** One Fluxer explicit-media filtering level */
export type GuildExplicitContentFilter = (typeof GuildExplicitContentFilters)[keyof typeof GuildExplicitContentFilters]

/** Fluxer's guild-wide content-warning levels */
export const GuildContentWarningLevels = Object.freeze({
    Inherit: 0,
    ContentWarning: 1,
})

/** One Fluxer guild-wide content-warning level */
export type GuildContentWarningLevel = (typeof GuildContentWarningLevels)[keyof typeof GuildContentWarningLevels]

/** Fluxer's invite splash-card alignments */
export const GuildSplashCardAlignments = Object.freeze({
    Center: 0,
    Left: 1,
    Right: 2,
})

/** One Fluxer invite splash-card alignment */
export type GuildSplashCardAlignment = (typeof GuildSplashCardAlignments)[keyof typeof GuildSplashCardAlignments]

/** Guild features that bots with ManageGuild may toggle */
export const GuildFeatureToggles = Object.freeze({
    InvitesDisabled: "INVITES_DISABLED",
    TextChannelFlexibleNames: "TEXT_CHANNEL_FLEXIBLE_NAMES",
    DetachedBanner: "DETACHED_BANNER",
    CloneEmojiDisabled: "CLONE_EMOJI_DISABLED",
    CloneStickerDisabled: "CLONE_STICKER_DISABLED",
    HideOwnerCrown: "HIDE_OWNER_CROWN",
})

/** One guild feature that a bot can include in GuildEdit.featureToggles */
export type GuildFeatureToggle = (typeof GuildFeatureToggles)[keyof typeof GuildFeatureToggles]

/** Frozen observation of a guild's custom invite, without SDK retention or guaranteed joinability */
export interface GuildVanityUrl {
    /** Lowercase custom code, or null when removed. Share only with intended recipients */
    readonly code: string | null
    /** Hosted Fluxer invite URL, or null without a code. Never included in SDK diagnostics */
    readonly url: string | null
}

/** Remote custom-invite observation. The use count can change immediately after the read */
export interface GuildVanityUrlUsage extends GuildVanityUrl {
    /** Observed nonnegative use count, not retained or inferred by editVanityUrl */
    readonly uses: number
}

/**
 * Bot-permitted patch for existing guild settings
 *
 * Omitted properties remain unchanged and null clears the applicable setting. Fluxer requires ManageGuild and can
 * reject feature-gated assets, invalid channel types, content, discoverability or historical-cutoff values after local
 * validation. The encoded JSON body, including data URIs, cannot exceed 4,194,304 bytes. This does not create,
 * delete, transfer ownership of, or change MFA requirements for a guild
 *
 * @example
 * ```ts
 * import { GuildDefaultMessageNotifications, type Client } from "@neontechspace/fluxerly"
 *
 * export function guildSettingsExample(client: Client, guildId: string) {
 *     return client.guilds.edit(guildId, {
 *         defaultMessageNotifications: GuildDefaultMessageNotifications.OnlyMentions,
 *     })
 * }
 * export function inspectCustomInvite(client: Client, guildId: string) {
 *     return client.guilds.fetchVanityUrl(guildId)
 * }
 * export function setCustomInvite(client: Client, guildId: string, code: string) {
 *     return client.guilds.editVanityUrl(guildId, code)
 * }
 * export function removeCustomInvite(client: Client, guildId: string) {
 *     return client.guilds.editVanityUrl(guildId, null)
 * }
 * ```
 */
export interface GuildEdit {
    /** Guild name, 1–100 Unicode code points */
    readonly name?: string
    /** Image data URI for the guild icon, or null to clear it */
    readonly icon?: string | null
    /** Image data URI for the guild banner, or null to clear it */
    readonly banner?: string | null
    /** Image data URI for the invite splash, or null to clear it */
    readonly splash?: string | null
    /** Image data URI for the embedded-invite splash, or null to clear it */
    readonly embedSplash?: string | null
    /** System-message channel ID, or null to disable system messages */
    readonly systemChannelId?: string | null
    /** Bitwise combination of GuildSystemChannelFlags; zero clears all supported suppression flags */
    readonly systemChannelFlags?: number
    /** AFK voice-channel ID, or null to disable automatic AFK moves */
    readonly afkChannelId?: string | null
    /** Integer AFK timeout in seconds from 60 through 3600 */
    readonly afkTimeoutSeconds?: number
    /** Default notification level for new members */
    readonly defaultMessageNotifications?: GuildDefaultMessageNotification
    /** Verification required before members can participate */
    readonly verificationLevel?: GuildVerificationLevel
    /** Mark or unmark the guild as adult content */
    readonly nsfw?: boolean
    /** Whether Fluxer displays a guild-wide content warning before entry */
    readonly contentWarningLevel?: GuildContentWarningLevel
    /** Warning text up to 200 Unicode code points, or null to restore Fluxer's localized default */
    readonly contentWarningText?: string | null
    /** Explicit-media filtering level */
    readonly explicitContentFilter?: GuildExplicitContentFilter
    /** Invite splash-card alignment */
    readonly splashCardAlignment?: GuildSplashCardAlignment
    /**
     * Complete desired set of bot-toggleable features, replacing every prior toggle in GuildFeatureToggles.
     * Fluxer preserves its managed and unknown features. Disabling TextChannelFlexibleNames makes Fluxer sanitize
     * existing channel names, an external side effect that is not rolled back if the response is lost. The SDK
     * conservatively invalidates retained guild-channel observations when this list disables that toggle
     */
    readonly featureToggles?: readonly GuildFeatureToggle[]
    /**
     * ISO 8601 UTC cutoff for members without Read Message History, or null to disable their historical access.
     * Fluxer rejects timestamps before guild creation or in the future
     */
    readonly messageHistoryCutoff?: string | null
}

/** Identifies a guild membership without retaining a client */
export interface MemberReference {
    /** Decimal guild ID */
    readonly guildId: string
    /** Decimal user ID */
    readonly userId: string
}

/** Frozen member projection shared by REST and member-add/update events, not a live permission result */
export interface GuildMember extends MemberReference {
    /** ISO 8601 timeout expiry, null when cleared, omitted when unavailable. A past timestamp is not an active timeout */
    readonly communicationDisabledUntil?: string | null
    /** Account username */
    readonly username: string
    /** Omitted upstream bot flags mean false */
    readonly isBot: boolean
    /** Explicit assigned role IDs, not an expanded permission set or implicit everyone role */
    readonly roleIds: readonly string[]
    /** ISO 8601 guild join timestamp */
    readonly joinedAt: string
    /** Guild nickname, preserving absent versus null */
    readonly nickname?: string | null
    /** Guild avatar hash, preserving absent versus null */
    readonly avatar?: string | null
    /** Guild banner hash, preserving absent versus null */
    readonly banner?: string | null
    /** Guild-profile RGB accent color, preserving absent versus null */
    readonly accentColor?: number | null
    /** Guild-profile bitfield supplied by Fluxer, preserving absent versus null */
    readonly profileFlags?: number | null
    /** Guild reply-mention preference, preserving absent versus null */
    readonly mentionFlags?: MemberMentionPreference | null
}

/** Known Fluxer guild-profile bit flags. Other nonnegative 32-bit bits can be observed for forward compatibility */
export const GuildMemberProfileFlags = Object.freeze({
    AvatarUnset: 1,
    BannerUnset: 2,
})

/** Fluxer's per-guild reply-mention preferences */
export const MemberMentionPreferences = Object.freeze({
    NoPreference: 0,
    PreferMention: 1,
    PreferNoMention: 2,
})

/** One of Fluxer's currently defined per-guild reply-mention preferences */
export type MemberMentionPreference = (typeof MemberMentionPreferences)[keyof typeof MemberMentionPreferences]

/**
 * Requested profile changes for the authenticated bot's membership in one guild
 *
 * Omitted properties are not sent and leave the provider value unchanged. Null clears the corresponding property.
 * Fluxer can silently ignore avatar, banner, bio and accentColor when its per-guild-profile customization feature is
 * unavailable, so an HTTP success does not establish those changes. Its response does not expose bio or pronouns,
 * leaving those fields write-only through this SDK. Fluxer performs its own image, content, verification and
 * permission checks after this SDK validates the input shape
 */
export interface MemberProfileEdit {
    /** Guild nickname, 1–32 Unicode code points, or null to clear */
    readonly nickname?: string | null
    /** Image data URI, or null to clear. Fluxer validates the decoded image and may silently ignore it */
    readonly avatar?: string | null
    /** Image data URI, or null to clear. Fluxer validates the decoded image and may silently ignore it */
    readonly banner?: string | null
    /** Guild-profile biography, 1–320 Unicode code points, or null to clear. The response does not return it */
    readonly bio?: string | null
    /** Guild-profile pronouns, 1–40 Unicode code points, or null to clear. The response does not return them */
    readonly pronouns?: string | null
    /** RGB integer from 0 through 16,777,215, or null to clear. Fluxer may silently ignore it */
    readonly accentColor?: number | null
    /** Nonnegative 32-bit profile bitfield, or null to clear. Known values are GuildMemberProfileFlags */
    readonly profileFlags?: number | null
    /** Per-guild reply-mention preference, or null to clear the override */
    readonly mentionFlags?: MemberMentionPreference | null
}

/** One explicit member page. No background traversal or complete guild snapshot */
export interface MemberQuery {
    /** Maximum member count, integer 1–1000, default 100 */
    readonly limit?: number
    /** Return user IDs greater than this decimal ID */
    readonly after?: string
}

/** Settings shared by remote guild, member and role operations */
export interface GuildOperationOptions {
    /** Total milliseconds across admission, rate waits, retries and HTTP; integer 1–2,147,483,647, default 30,000.
     * Owned cleanup is awaited afterward, so completion can take longer
     */
    readonly timeoutMs?: number
}

/** Default calls start immediately; abort cancels only this call and awaits owned cleanup */
export interface DefaultGuildOperationOptions extends GuildOperationOptions, OperationOptions {}

/** Moderation-only request settings, with the same deadline and cleanup ownership as guild operations */
export interface ModerationOptions extends GuildOperationOptions {
    /** Optional audit-log reason, 1–512 printable ASCII characters after trimming.
     * Sent as a raw header because Fluxer does not decode URL escapes. Non-ASCII and control characters fail before dispatch.
     * Omission sends no header. Never included in SDK errors or diagnostics
     */
    readonly auditReason?: string
}

/** Default moderation starts immediately. Aborting waits for owned cleanup but cannot roll back a dispatched action */
export interface DefaultModerationOptions extends ModerationOptions, OperationOptions {}

/** Explicit ban settings. The server owns expiry and any requested message-deletion job */
export interface BanInput {
    /** Stored ban reason, up to 512 Unicode code points. Omit to use auditReason when supplied, otherwise no reason */
    readonly reason?: string
    /** Integer seconds, zero/default for permanent or 60–63,072,000 for a provider-managed temporary ban.
     * Expiry does not rejoin the user. No SDK timer or automatic unban request is created.
     * Provider database TTL expiry need not emit guildBanRemove. Reconcile with fetchBans rather than waiting for that event
     */
    readonly durationSeconds?: number
    /** Integer seconds of recent messages to remove, 0–604,800, default zero.
     * Destructive asynchronous server job, separate from ban completion and not undone by unbanning
     */
    readonly deleteMessageSeconds?: number
}

/** Frozen remote ban observation, not a membership or a guarantee that the ban is still active */
export interface GuildBan extends MemberReference {
    /** Account username returned with this ban */
    readonly username: string
    /** Omitted upstream bot flag means false */
    readonly isBot: boolean
    /** Stored reason, preserving absent versus null */
    readonly reason?: string | null
    /** Decimal user ID of the moderator */
    readonly moderatorId: string
    /** ISO 8601 time the ban was recorded */
    readonly bannedAt: string
    /** ISO 8601 expiry, null for permanent, omitted when unavailable. Database expiry need not emit a removal event */
    readonly expiresAt?: string | null
}

/** Identifies a role without retaining a client */
export interface RoleReference {
    /** Decimal guild ID */
    readonly guildId: string
    /** Decimal role ID */
    readonly id: string
}

/** Frozen role observation, not a member's effective permissions or a live hierarchy cache */
export interface GuildRole extends RoleReference {
    /** Role display name */
    readonly name: string
    /** RGB integer, zero means no explicit color */
    readonly color: number
    /** Server hierarchy position. Positions can tie, including newly created roles */
    readonly position: number
    /** Raw grants, including unknown future bits. Convert to a decimal string before JSON serialization */
    readonly permissions: bigint
    /** Whether members are displayed separately */
    readonly hoist: boolean
    /** Whether anyone can mention the role */
    readonly mentionable: boolean
    /** Separate member-list ordering, preserving absent versus null */
    readonly hoistPosition?: number | null
    /** Role emoji, preserving absent versus null */
    readonly unicodeEmoji?: string | null
}

/** Create only the fields Fluxer's creation endpoint supports */
export interface RoleCreate {
    /** Nonblank role name, 1–100 Unicode code points */
    readonly name: string
    /** RGB integer 0–16,777,215, default 0 */
    readonly color?: number
    /** Unsigned 64-bit bigint, default 0n: Unlike raw Fluxer, never inherit everyone's grants implicitly */
    readonly permissions?: bigint
}

/** Explicit role patch. Omitted fields stay unchanged; at least one defined field is required */
export interface RoleEdit {
    /** Nonblank role name, 1–100 Unicode code points */
    readonly name?: string
    /** RGB integer 0–16,777,215 */
    readonly color?: number
    /** Replace raw grants with this unsigned 64-bit bigint, not an incremental grant */
    readonly permissions?: bigint
    /** Display members separately */
    readonly hoist?: boolean
    /** Signed 32-bit member-list position; null clears it */
    readonly hoistPosition?: number | null
    /** Allow anyone to mention this role */
    readonly mentionable?: boolean
}

/** One bulk role update, not individual update events or a complete role list. Unchanged roles may be omitted */
export interface GuildRoleUpdateBulk {
    /** Decimal guild ID */
    readonly guildId: string
    /** Frozen role observations delivered together */
    readonly roles: readonly GuildRole[]
}

/** Fluxer permission bits, combined with bigint | and tested with &.
 * These are raw grants, not effective-permission calculations: Hierarchy, channel overwrites and server rules still apply.
 * Unknown unsigned 64-bit bits can be passed explicitly; Fluxer may mask or reject grants
 */
export const Permissions = Object.freeze({
    CreateInstantInvite: 1n << 0n,
    KickMembers: 1n << 1n,
    BanMembers: 1n << 2n,
    Administrator: 1n << 3n,
    ManageChannels: 1n << 4n,
    ManageGuild: 1n << 5n,
    AddReactions: 1n << 6n,
    ViewAuditLog: 1n << 7n,
    PrioritySpeaker: 1n << 8n,
    Stream: 1n << 9n,
    ViewChannel: 1n << 10n,
    SendMessages: 1n << 11n,
    SendTtsMessages: 1n << 12n,
    ManageMessages: 1n << 13n,
    EmbedLinks: 1n << 14n,
    AttachFiles: 1n << 15n,
    ReadMessageHistory: 1n << 16n,
    MentionEveryone: 1n << 17n,
    UseExternalEmojis: 1n << 18n,
    Connect: 1n << 20n,
    Speak: 1n << 21n,
    MuteMembers: 1n << 22n,
    DeafenMembers: 1n << 23n,
    MoveMembers: 1n << 24n,
    UseVad: 1n << 25n,
    ChangeNickname: 1n << 26n,
    ManageNicknames: 1n << 27n,
    ManageRoles: 1n << 28n,
    ManageWebhooks: 1n << 29n,
    ManageExpressions: 1n << 30n,
    UseExternalStickers: 1n << 37n,
    ModerateMembers: 1n << 40n,
    CreateExpressions: 1n << 43n,
    PinMessages: 1n << 51n,
    BypassSlowmode: 1n << 52n,
    UpdateRtcRegion: 1n << 53n,
    ViewChannelMembers: 1n << 54n,
})

/** One requested hierarchy position, not an absolute final-position guarantee */
export interface RolePosition {
    /** Decimal role ID, excluding the implicit everyone role */
    readonly id: string
    /** Nonnegative safe integer ordering value; Fluxer normalizes positions and applies manageable-role constraints */
    readonly position: number
}

/** One display-order assignment, independent of permission hierarchy and the role's hoist flag */
export interface RoleHoistPosition {
    /** Decimal role ID, excluding everyone */
    readonly id: string
    /** Signed 32-bit display ordering value, not the permission-hierarchy position */
    readonly hoistPosition: number
}

/** Guild-area operation identified by expected failures and default defects */
export type GuildOperation =
    | "permissions.calculate"
    | "permissions.fetch"
    | `hierarchy.${"compare" | "isAbove" | "canManage"}`
    | "members.search"
    | `discovery.${"fetchStatus" | "fetchCategories" | "apply" | "edit" | "withdraw"}`
    | `invites.${"fetch" | "create" | "fetchChannel" | "fetchGuild" | "delete"}`
    | `${"emojis" | "stickers"}.${"get" | "fetchAll" | "fetchMetadata" | "create" | "createMany" | "clone" | "edit" | "delete"}`
    | "guilds.get"
    | "guilds.edit"
    | "guilds.fetchVanityUrl"
    | "guilds.editVanityUrl"
    | "auditLogs.fetchPage"
    | "members.get"
    | "roles.get"
    | "guilds.fetch"
    | "guilds.ban"
    | "guilds.unban"
    | "guilds.fetchBans"
    | "members.timeout"
    | "members.clearTimeout"
    | "members.kick"
    | "members.fetch"
    | "members.fetchSelf"
    | "members.fetchPage"
    | "members.editSelf"
    | "members.setNickname"
    | "members.addRole"
    | "members.removeRole"
    | "roles.fetchAll"
    | "roles.create"
    | "roles.edit"
    | "roles.delete"
    | "roles.reorder"
    | "roles.setHoistPositions"
    | "roles.resetHoistPositions"

/** Expected guild-area failure with safe metadata, never a token, input value or upstream response body.
 * HTTP completion is not gateway delivery. Cancellation and client closure use separate error types
 */
export class GuildOperationError extends Error {
    /** Stable expected-failure discriminator */
    readonly _tag = "GuildOperationError"
    constructor(
        /** Requested operation */
        readonly operation: GuildOperation,
        /** notFound is HTTP 404, not proof that an earlier deletion succeeded */
        readonly reason: "input" | "busy" | "notFound" | "rejected" | "network" | "response" | "timeout" | "rateLimit",
        /** unknown means a write may have applied; rejected is an API rejection, not rollback proof */
        readonly outcome: "notDispatched" | "rejected" | "unknown",
        /** HTTP status when available, otherwise null */
        readonly status: number | null = null,
        /** Usable server-required retry wait in milliseconds, otherwise null */
        readonly retryAfterMs: number | null = null,
    ) {
        super(`Guild operation ${operation} failed (${reason}; outcome ${outcome})`)
        this.name = this._tag
    }
}

/** Native interruption is outside this union; default methods additionally return CancelledError */
export type GuildOperationFailure = GuildOperationError | ClientClosedError
