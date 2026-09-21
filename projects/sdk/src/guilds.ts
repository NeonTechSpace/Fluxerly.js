import type { OperationOptions } from "./client.js"
import type { ClientClosedError } from "./errors.js"
import { operationErrorMessage, type ApiErrorDetail } from "./api-errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"

/** Identity and settings of a Fluxer guild, the server that owns channels, members and roles.
 * Reads and gateway events return frozen snapshots, not objects that update as the server changes.
 * Optional settings can be unavailable in this observation. Do not substitute creation defaults for missing fields
 */
export interface Guild {
    /** Decimal guild ID */
    readonly id: string
    /** Current guild name */
    readonly name: string
    /** Decimal owner user ID, not a permission decision */
    readonly ownerId: string
    /** Feature names supplied by Fluxer, including unknown future names */
    readonly features: readonly string[]
    /** Icon asset hash, not an image URL. Null means no icon, omission means unavailable */
    readonly icon?: string | null
    /** Banner asset hash, not an image URL. Null means no banner, omission means unavailable */
    readonly banner?: string | null
    /** Background asset hash for invites. Null means no splash, omission means unavailable */
    readonly splash?: string | null
    /** Background asset hash for embedded invites. Null means no splash, omission means unavailable */
    readonly embedSplash?: string | null
    /** Invite splash-card alignment, omission means unavailable */
    readonly splashCardAlignment?: GuildSplashCardAlignment
    /** System-message channel ID. Null disables it, omission means unavailable */
    readonly systemChannelId?: string | null
    /** System-message suppression flags, omission means unavailable */
    readonly systemChannelFlags?: number
    /** AFK voice-channel ID. Null disables it, omission means unavailable */
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
    /** Custom guild-wide warning text. Null restores Fluxer's localized default, omission means unavailable */
    readonly contentWarningText?: string | null
    /** Explicit-media filtering level, omission means unavailable */
    readonly explicitContentFilter?: GuildExplicitContentFilter
    /** ISO 8601 historical-message cutoff. Null disables history for members without Read Message History */
    readonly messageHistoryCutoff?: string | null
}

/** Gateway notification that a guild is no longer visible to this client
 *
 * This can describe temporary unavailability rather than server deletion or removal of the bot.
 * `unavailable` is true when Fluxer temporarily withholds the guild and false when its field is absent.
 * `unavailableHidden` is true when Fluxer marks that unavailable guild hidden and false when its field is absent
 */
export interface GuildDeletion {
    /** Decimal guild ID */
    readonly id: string
    /** Whether Fluxer reports a temporary unavailable placeholder */
    readonly unavailable: boolean
    /** Whether Fluxer reports that temporary placeholder as hidden */
    readonly unavailableHidden: boolean
}

/** Suppress selected automatic messages in a guild's system channel through GuildEdit.systemChannelFlags */
export const GuildSystemChannelFlags: Readonly<{
    /** Hide automatic member-join notifications */
    SuppressJoinNotifications: 1
}> = Object.freeze({
    SuppressJoinNotifications: 1,
})

/** One known system-channel flag bit. A flags value of zero clears every currently supported suppression */
export type GuildSystemChannelFlag = (typeof GuildSystemChannelFlags)[keyof typeof GuildSystemChannelFlags]

/** Set the initial notification preference for new guild members through GuildEdit.defaultMessageNotifications.
 * Existing members can keep their own notification preferences
 */
export const GuildDefaultMessageNotifications: Readonly<{
    /** Notify for all messages by default */
    AllMessages: 0
    /** Notify only when mentioned by default */
    OnlyMentions: 1
}> = Object.freeze({
    AllMessages: 0,
    OnlyMentions: 1,
})

/** One Fluxer default-notification level */
export type GuildDefaultMessageNotification =
    (typeof GuildDefaultMessageNotifications)[keyof typeof GuildDefaultMessageNotifications]

/** Values for the verification policy required before members can participate in a guild.
 * Use GuildEdit.verificationLevel to request a level. Fluxer enforces the account requirements for each level.
 * Fluxer's verification check exempts the guild owner, bots and members with assigned roles.
 * Discoverable guilds enforce at least Low even when the stored setting is None.
 * These describe the verification check only, not all requirements for sending messages or joining voice
 * @see https://github.com/fluxerapp/fluxer/blob/a59b80ce111be8af6e7a65f927a3ebefcfdf99f3/fluxer_api/src/api/utils/GuildVerificationUtils.ts
 */
export const GuildVerificationLevels: Readonly<{
    /** No guild-level verification requirement, except that discoverable guilds still enforce Low */
    None: 0
    /** Require a verified email address for members who are not exempt */
    Low: 1
    /** Require Low and an account at least five minutes old */
    Medium: 2
    /** Require Medium and, when join time is available, at least ten minutes of guild membership */
    High: 3
    /** Require a verified phone number instead of the email and waiting-period checks of the lower levels */
    VeryHigh: 4
}> = Object.freeze({
    None: 0,
    Low: 1,
    Medium: 2,
    High: 3,
    VeryHigh: 4,
})

/** One Fluxer member-verification level */
export type GuildVerificationLevel = (typeof GuildVerificationLevels)[keyof typeof GuildVerificationLevels]

/** Choose whose uploaded media Fluxer filters for explicit content through GuildEdit.explicitContentFilter */
export const GuildExplicitContentFilters: Readonly<{
    /** Do not enable this filtering policy */
    Disabled: 0
    /** Apply filtering to members without assigned roles */
    MembersWithoutRoles: 1
    /** Apply filtering to all members */
    AllMembers: 2
}> = Object.freeze({
    Disabled: 0,
    MembersWithoutRoles: 1,
    AllMembers: 2,
})

/** One Fluxer explicit-media filtering level */
export type GuildExplicitContentFilter = (typeof GuildExplicitContentFilters)[keyof typeof GuildExplicitContentFilters]

/** Choose the guild-wide warning policy through GuildEdit.contentWarningLevel */
export const GuildContentWarningLevels: Readonly<{
    /** Use the inherited warning policy */
    Inherit: 0
    /** Request a guild-wide content warning */
    ContentWarning: 1
}> = Object.freeze({
    Inherit: 0,
    ContentWarning: 1,
})

/** One Fluxer guild-wide content-warning level */
export type GuildContentWarningLevel = (typeof GuildContentWarningLevels)[keyof typeof GuildContentWarningLevels]

/** Position the card over the invite splash image through GuildEdit.splashCardAlignment */
export const GuildSplashCardAlignments: Readonly<{
    /** Center the invitation card over its background image */
    Center: 0
    /** Place the invitation card on the left side of its background image */
    Left: 1
    /** Place the invitation card on the right side of its background image */
    Right: 2
}> = Object.freeze({
    Center: 0,
    Left: 1,
    Right: 2,
})

/** One Fluxer invite splash-card alignment */
export type GuildSplashCardAlignment = (typeof GuildSplashCardAlignments)[keyof typeof GuildSplashCardAlignments]

/** Optional server behaviors that a bot with ManageGuild can replace through GuildEdit.featureToggles.
 * Supply the complete desired set, not just toggles to add. Cloning must be enabled on the source guild
 */
export const GuildFeatureToggles: Readonly<{
    /** Disable guild invitations */
    InvitesDisabled: "INVITES_DISABLED"
    /** Permit flexible text-channel names. Disabling this can sanitize existing channel names */
    TextChannelFlexibleNames: "TEXT_CHANNEL_FLEXIBLE_NAMES"
    /** Display the guild banner in a separate section below the guild header in the Fluxer app */
    DetachedBanner: "DETACHED_BANNER"
    /** Allow eligible callers to clone this guild's emoji into another guild */
    CloneEmojiEnabled: "CLONE_EMOJI_ENABLED"
    /** Allow eligible callers to clone this guild's stickers into another guild */
    CloneStickerEnabled: "CLONE_STICKER_ENABLED"
    /** Hide the guild owner's crown indicator */
    HideOwnerCrown: "HIDE_OWNER_CROWN"
}> = Object.freeze({
    InvitesDisabled: "INVITES_DISABLED",
    TextChannelFlexibleNames: "TEXT_CHANNEL_FLEXIBLE_NAMES",
    DetachedBanner: "DETACHED_BANNER",
    CloneEmojiEnabled: "CLONE_EMOJI_ENABLED",
    CloneStickerEnabled: "CLONE_STICKER_ENABLED",
    HideOwnerCrown: "HIDE_OWNER_CROWN",
})

/** One guild feature that a bot can include in GuildEdit.featureToggles */
export type GuildFeatureToggle = (typeof GuildFeatureToggles)[keyof typeof GuildFeatureToggles]

/** The guild's current custom invitation code and shareable URL, or null fields when no custom code is set.
 * This is distinct from individually created channel invites. The SDK does not retain this frozen result or verify
 * that a later join can succeed
 */
export interface GuildVanityUrl {
    /** Lowercase custom code, or null when removed. Share only with intended recipients */
    readonly code: string | null
    /** Hosted Fluxer invite URL, or null without a code. Never included in SDK diagnostics */
    readonly url: string | null
}

/** Custom invitation details with a use count returned by guilds.fetchVanityUrl.
 * guilds.editVanityUrl returns GuildVanityUrl without a hidden follow-up count read.
 * The observed count can change immediately after the request
 */
export interface GuildVanityUrlUsage extends GuildVanityUrl {
    /** Observed nonnegative use count, not retained or inferred by editVanityUrl */
    readonly uses: number
}

/**
 * Change an existing guild's settings through the bot client
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
    /** Guild name, 1–100 UTF-16 code units after U+000C and U+202E removal and surrounding-whitespace trimming.
     * Normalization is validation-only, and the original string is sent unchanged
     */
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
    /** Bitwise combination of GuildSystemChannelFlags. Zero clears all supported suppression flags */
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
    /** Warning text with 0–200 raw UTF-16 code units, or null to restore Fluxer's localized default.
     * No text normalization is applied before validation
     */
    readonly contentWarningText?: string | null
    /** Explicit-media filtering level */
    readonly explicitContentFilter?: GuildExplicitContentFilter
    /** Invite splash-card alignment */
    readonly splashCardAlignment?: GuildSplashCardAlignment
    /**
     * Complete desired set of bot-toggleable features, replacing every prior toggle in GuildFeatureToggles.
     * Entries are copied by index when the operation starts.
     * Include CloneEmojiEnabled and CloneStickerEnabled to allow cloning from this guild. Omitting them disables
     * that permission. Keep them in the list when changing another toggle if cloning should remain enabled.
     * Deprecated CLONE_EMOJI_DISABLED and CLONE_STICKER_DISABLED values are rejected, not inverted or translated.
     * Fluxer preserves its managed, unknown and deprecated observed features. Disabling TextChannelFlexibleNames
     * makes Fluxer sanitize existing channel names, an external side effect that is not rolled back if the response
     * is lost. The SDK conservatively invalidates retained guild-channel observations when this list disables that toggle
     */
    readonly featureToggles?: readonly GuildFeatureToggle[]
    /**
     * ISO 8601 UTC cutoff for members without Read Message History, or null to disable their historical access.
     * Impossible calendar dates are rejected before dispatch.
     * Fluxer rejects timestamps before guild creation or in the future
     */
    readonly messageHistoryCutoff?: string | null
}

/** Address one user's membership in one guild for member reads and changes.
 * The same account can have different nicknames, roles and moderation state in different guilds.
 * This contains IDs only and does not retain a client or fetch the membership
 */
export interface MemberReference {
    /** Decimal guild ID */
    readonly guildId: string
    /** Decimal user ID */
    readonly userId: string
}

/** Identifies one member and, optionally, one of that member's active voice connections */
export interface VoiceConnectionReference extends MemberReference {
    /** Connection ID from a voice-state observation, 1–32 UTF-16 code units after U+000C and U+202E removal
     * and surrounding-whitespace trimming. The original string is sent unchanged. Omit to target every active
     * connection for this member
     */
    readonly connectionId?: string
}

/** A user's membership in one guild, including assigned roles, guild-profile settings and available moderation state.
 * This frozen snapshot comes from REST or member-add/update events. It does not update in place or calculate
 * permissions. Account identity and guild-specific customization are distinct
 */
export interface GuildMember extends MemberReference {
    /** ISO 8601 timeout expiry, null when cleared, omitted when unavailable. A past timestamp is not an active timeout */
    readonly communicationDisabledUntil?: string | null
    /** Account username */
    readonly username: string
    /** Omitted upstream bot flags mean false */
    readonly isBot: boolean
    /** Roles assigned to this member. The implicit everyone role is not listed and grants are not expanded here */
    readonly roleIds: readonly string[]
    /** ISO 8601 guild join timestamp */
    readonly joinedAt: string
    /** Guild-specific display name. Null means no nickname, omission means unavailable */
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
    /** Whether Fluxer reports this member as server-muted, omitted when the returned member data excludes voice flags */
    readonly isMuted?: boolean
    /** Whether Fluxer reports this member as server-deafened, omitted when the returned member data excludes voice flags */
    readonly isDeafened?: boolean
}

/** Known Fluxer guild-profile bit flags. Other nonnegative 32-bit bits can be observed for forward compatibility */
export const GuildMemberProfileFlags: Readonly<{
    /** Mark the guild-profile avatar as explicitly unset */
    AvatarUnset: 1
    /** Mark the guild-profile banner as explicitly unset */
    BannerUnset: 2
}> = Object.freeze({
    AvatarUnset: 1,
    BannerUnset: 2,
})

/** Fluxer's per-guild reply-mention preferences */
export const MemberMentionPreferences: Readonly<{
    /** Express no preference about mentions on replies */
    NoPreference: 0
    /** Prefer replies to mention this member */
    PreferMention: 1
    /** Prefer replies not to mention this member */
    PreferNoMention: 2
}> = Object.freeze({
    NoPreference: 0,
    PreferMention: 1,
    PreferNoMention: 2,
})

/** One of Fluxer's currently defined per-guild reply-mention preferences */
export type MemberMentionPreference = (typeof MemberMentionPreferences)[keyof typeof MemberMentionPreferences]

/**
 * Change this bot's nickname and guild-specific profile in one guild
 *
 * Omitted properties are not sent and leave the provider value unchanged. Null clears the corresponding property.
 * Fluxer can silently ignore avatar, banner, bio and accentColor when its per-guild-profile customization feature is
 * unavailable, so an HTTP success does not establish those changes. Its response does not expose bio or pronouns,
 * leaving those fields write-only through this SDK. Fluxer performs its own image, content, verification and
 * permission checks after this SDK validates the input shape
 */
export interface MemberProfileEdit {
    /** Guild nickname, or null to clear. A raw empty string fails. A nonempty string containing only trim whitespace
     * is accepted as Fluxer's clear value. Otherwise, validation removes U+000C and U+202E, trims surrounding
     * whitespace, and requires 1–32 UTF-16 code units. The original string is sent unchanged
     */
    readonly nickname?: string | null
    /** Image data URI, or null to clear. Fluxer validates the decoded image and may silently ignore it */
    readonly avatar?: string | null
    /** Image data URI, or null to clear. Fluxer validates the decoded image and may silently ignore it */
    readonly banner?: string | null
    /** Guild-profile biography, 1–320 normalized UTF-16 code units, or null to clear. The response does not return it.
     * Validation removes U+000C and U+202E and trims surrounding whitespace. The original string is sent unchanged
     */
    readonly bio?: string | null
    /** Guild-profile pronouns, 1–40 normalized UTF-16 code units, or null to clear. The response does not return them.
     * Validation removes U+000C and U+202E and trims surrounding whitespace. The original string is sent unchanged
     */
    readonly pronouns?: string | null
    /** RGB integer from 0 through 16,777,215, or null to clear. Fluxer may silently ignore it */
    readonly accentColor?: number | null
    /** Nonnegative 32-bit profile bitfield, or null to clear. Known values are GuildMemberProfileFlags */
    readonly profileFlags?: number | null
    /** Per-guild reply-mention preference, or null to clear the override */
    readonly mentionFlags?: MemberMentionPreference | null
}

/** Select one REST page of guild members, for example to inspect a bounded set or continue after a previous user ID.
 * Use members.iterate for bounded multi-page traversal. A page alone is not a complete guild snapshot
 */
export interface MemberQuery {
    /** Maximum member count, integer 1–1000, default 100 */
    readonly limit?: number
    /** Return user IDs greater than this decimal ID */
    readonly after?: string
}

/** Details of one guild this bot belongs to, freshly returned by the REST membership list.
 * This is not a cached Guild and does not update a cached Guild. permissions and approximate counts remain absent
 * when Fluxer omits them, including provider lookup failures. Absence is not zero or a complete-membership claim
 */
export interface GuildListSummary extends Guild {
    /** Raw unsigned permission bits that Fluxer made available for this membership. Omission is unavailable, not zero */
    readonly permissions?: bigint
    /** Provider-supplied approximate member count when withCounts was requested and Fluxer could obtain it */
    readonly approximateMemberCount?: number
    /** Provider-supplied approximate presence count when withCounts was requested and Fluxer could obtain it */
    readonly approximatePresenceCount?: number
}

/** One remote page of the authenticated bot's guild memberships */
export interface GuildListQuery {
    /** Page size, integer 1–200, default 200 */
    readonly limit?: number
    /** Existing membership cursor before which to list. Cannot be combined with after.
     * If the cursor membership no longer exists, Fluxer can restart the page from the beginning
     */
    readonly before?: string
    /** Existing membership cursor after which to list. Cannot be combined with before.
     * If the cursor membership no longer exists, Fluxer can restart the page from the beginning
     */
    readonly after?: string
    /** Request provider-supplied approximate member and presence counts. Defaults to false.
     * Fluxer can omit requested counts and permissions, so omitted fields remain unavailable rather than zero
     */
    readonly withCounts?: boolean
}

/** Settings shared by remote guild, member and role operations */
export interface GuildOperationOptions {
    /** Total milliseconds across local queueing, rate waits, retries and HTTP. Integer 1–2,147,483,647, default 30,000.
     * Owned cleanup is awaited afterward, so completion can take longer
     */
    readonly timeoutMs?: number
}

/** Default API calls start immediately. Abort cancels only this call and awaits owned cleanup */
export interface DefaultGuildOperationOptions extends GuildOperationOptions, OperationOptions {}

/** Moderation-only request settings, with the same deadline and cleanup ownership as guild operations */
export interface ModerationOptions extends GuildOperationOptions {
    /** Optional audit-log reason, 1–512 printable ASCII characters after trimming.
     * Sent as a raw header because Fluxer does not decode URL escapes. Non-ASCII and control characters fail before dispatch.
     * Omission sends no header. Never included in SDK errors or diagnostics
     */
    readonly auditReason?: string
}

/** Default API moderation starts immediately. Aborting waits for owned cleanup but cannot roll back a dispatched action */
export interface DefaultModerationOptions extends ModerationOptions, OperationOptions {}

/** Timeout-only request settings. A timeoutReason is provider audit metadata, not a stored GuildMember field */
export interface TimeoutOptions extends ModerationOptions {
    /** Optional timeout audit metadata. Null or omission sends no meaningful reason. A string must contain 1–512
     * UTF-16 code units after U+000C and U+202E removal and surrounding-whitespace trimming. The original string is sent unchanged
     */
    readonly timeoutReason?: string | null
}

/** Default API timeout operations begin immediately. Aborting waits for owned cleanup but cannot roll back a dispatched timeout change */
export interface DefaultTimeoutOptions extends TimeoutOptions, OperationOptions {}

/** Ban an account from a guild permanently or for a provider-managed duration, optionally deleting recent messages.
 * The server owns expiry and any requested deletion job. Removing or expiring a ban does not restore membership
 * or deleted messages
 */
export interface BanInput {
    /** Stored ban reason, up to 512 UTF-16 code units after U+000C and U+202E removal and surrounding-whitespace
     * trimming. The original string is sent unchanged. Omit to use auditReason when supplied, otherwise no reason
     */
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

/** Recorded ban details returned by guilds.fetchBans, including available reason, moderator and expiry.
 * This frozen observation does not establish that the ban is still active at a later time
 */
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

/** Address one role inside its owning guild for role reads and changes, without fetching it or retaining a client */
export interface RoleReference {
    /** Decimal guild ID */
    readonly guildId: string
    /** Decimal role ID */
    readonly id: string
}

/** A guild role that groups members and supplies permission grants, hierarchy rank and display settings.
 * Every guild also has an implicit everyone role whose ID equals the guild ID.
 * This frozen snapshot is not a member's effective permissions and does not update as roles change
 */
export interface GuildRole extends RoleReference {
    /** Role display name */
    readonly name: string
    /** RGB integer, zero means no explicit color */
    readonly color: number
    /** Server hierarchy position. Positions can tie, including newly created roles */
    readonly position: number
    /** Raw grants from Fluxer, including unknown future bits, as an unsigned 64-bit bigint */
    readonly permissions: bigint
    /** Whether members with this role are displayed as a separate group in the member list */
    readonly hoist: boolean
    /** Whether anyone can mention the role */
    readonly mentionable: boolean
    /** Separate member-list ordering, preserving absent versus null */
    readonly hoistPosition?: number | null
    /** Role emoji, preserving absent versus null */
    readonly unicodeEmoji?: string | null
}

/** Create a named guild role with an optional color and permission grants.
 * New roles have no grants by default in this SDK. Use roles.edit afterward for hoist and mentionable settings.
 * Role creation does not assign the role to a member, and Fluxer chooses its initial hierarchy position
 */
export interface RoleCreate {
    /** Role name, 1–100 UTF-16 code units after U+000C and U+202E removal and surrounding-whitespace trimming.
     * The original string is sent unchanged
     */
    readonly name: string
    /** RGB integer 0–16,777,215, default 0 */
    readonly color?: number
    /** Bigint from 0n through 9_223_372_036_854_775_807n, default 0n: Unlike raw Fluxer, never inherit everyone's grants implicitly. Explicit ViewChannelMembers replacements are advertised to Fluxer by the SDK */
    readonly permissions?: bigint
}

/** Change the name, grants or display settings of an existing role.
 * Omitted fields stay unchanged and at least one defined field is required. permissions replaces grants instead of
 * adding to them. The implicit everyone role accepts only color and permissions. Use roles.reorder for hierarchy rank
 */
export interface RoleEdit {
    /** Role name, 1–100 UTF-16 code units after U+000C and U+202E removal and surrounding-whitespace trimming.
     * The original string is sent unchanged
     */
    readonly name?: string
    /** RGB integer 0–16,777,215 */
    readonly color?: number
    /** Replace raw grants with a bigint from 0n through 9_223_372_036_854_775_807n, not an incremental grant. Explicit ViewChannelMembers replacements are advertised to Fluxer by the SDK */
    readonly permissions?: bigint
    /** Display members separately */
    readonly hoist?: boolean
    /** Signed 32-bit member-list position. Null clears it */
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

/** Named permission grants for role inputs, channel overwrites and raw permission checks
 *
 * Combine bigint values with |, such as Permissions.ViewChannel | Permissions.SendMessages.
 * Test a grant with (bits & Permissions.SendMessages) === Permissions.SendMessages.
 * Convert bigint to a decimal string before JSON serialization, which cannot serialize bigint directly.
 * These are raw grants, not effective-permission calculations: Hierarchy, channel overwrites and server rules still apply.
 * Unknown unsigned 64-bit bits can be passed explicitly. Fluxer may mask or reject grants
 */
export const Permissions: Readonly<{
    /** Create invitation links to a guild or channel */
    CreateInstantInvite: bigint
    /** Remove members from a guild without banning them from joining again */
    KickMembers: bigint
    /** Ban accounts from a guild and optionally remove their recent messages */
    BanMembers: bigint
    /** Grant all permission bits and bypass channel overwrites. Hierarchy and other server checks still apply */
    Administrator: bigint
    /** Create, edit or delete guild channels and categories */
    ManageChannels: bigint
    /** Change guild-wide settings, such as its name and icon */
    ManageGuild: bigint
    /** Start a new emoji reaction on a message, rather than only join an existing reaction */
    AddReactions: bigint
    /** Read the guild's recorded administrative and moderation activity */
    ViewAuditLog: bigint
    /** Use the priority push-to-talk key binding to make your voice stand out over other speakers */
    PrioritySpeaker: bigint
    /** Share a camera or screen in a voice channel */
    Stream: bigint
    /** See a channel, subject to the channel's applicable overwrites */
    ViewChannel: bigint
    /** Post messages in a channel */
    SendMessages: bigint
    /** Send text-to-speech messages that enabled recipients can hear read aloud */
    SendTtsMessages: bigint
    /** Delete other members' messages. Pinning and unpinning use PinMessages separately */
    ManageMessages: bigint
    /** Show automatic embedded previews for links in messages */
    EmbedLinks: bigint
    /** Upload files and media with messages */
    AttachFiles: bigint
    /** Read earlier messages in a channel, subject to guild history-cutoff rules */
    ReadMessageHistory: bigint
    /** Use @everyone and @here, and mention roles even when they are not marked mentionable */
    MentionEveryone: bigint
    /** Use custom emoji owned by other guilds */
    UseExternalEmojis: bigint
    /** Join a voice channel and listen to participants */
    Connect: bigint
    /** Transmit speech in a voice channel */
    Speak: bigint
    /** Server-mute other voice participants, preventing them from speaking to everyone */
    MuteMembers: bigint
    /** Server-deafen other voice participants, preventing them from hearing or speaking */
    DeafenMembers: bigint
    /** Move members between voice channels they can access, or disconnect them from voice */
    MoveMembers: bigint
    /** Use voice activity detection to transmit speech without holding a push-to-talk key */
    UseVad: bigint
    /** Change your own nickname in the guild */
    ChangeNickname: bigint
    /** Change other members' guild nicknames */
    ManageNicknames: bigint
    /** Manage roles below your highest role and edit channel permission overwrites */
    ManageRoles: bigint
    /** Create, edit or delete webhooks in the applicable guild or channel */
    ManageWebhooks: bigint
    /** Edit or delete custom emoji and stickers created by other members */
    ManageExpressions: bigint
    /** Use custom stickers owned by other guilds */
    UseExternalStickers: bigint
    /** Apply member timeouts that temporarily restrict messaging, reactions and voice participation */
    ModerateMembers: bigint
    /** Upload custom emoji and stickers and manage your own creations */
    CreateExpressions: bigint
    /** Pin or unpin messages, including messages written by other members */
    PinMessages: bigint
    /** Send messages without waiting for the channel's per-user slowmode delay */
    BypassSlowmode: bigint
    /** Change the voice-server region used by a voice channel */
    UpdateRtcRegion: bigint
    /** See the member list for the applicable channel */
    ViewChannelMembers: bigint
}> = Object.freeze({
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
    /** Nonnegative safe integer ordering value. Fluxer normalizes positions and applies manageable-role constraints */
    readonly position: number
}

/** One display-order assignment, independent of permission hierarchy and the role's hoist flag */
export interface RoleHoistPosition {
    /** Decimal role ID, excluding everyone */
    readonly id: string
    /** Signed 32-bit display ordering value, not the permission-hierarchy position */
    readonly hoistPosition: number
}

/** The guild or related-resource action named in an expected failure or SdkDefect */
export type GuildOperation =
    | "permissions.calculate"
    | "permissions.fetch"
    | `hierarchy.${"compare" | "isAbove" | "canManage"}`
    | "members.search"
    | `discovery.${"search" | "fetchStatus" | "fetchCategories" | "apply" | "edit" | "withdraw"}`
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
    | "guilds.fetchPage"
    | "guilds.leave"
    | "guilds.deleteMine"
    | "guilds.ban"
    | "guilds.unban"
    | "guilds.fetchBans"
    | "members.timeout"
    | "members.clearTimeout"
    | "members.kick"
    | "members.fetch"
    | "members.fetchSelf"
    | "members.fetchHierarchyCheck"
    | "members.fetchPage"
    | "members.editSelf"
    | "members.setNickname"
    | "members.move"
    | "members.disconnect"
    | "members.setMute"
    | "members.setDeaf"
    | "members.setRoles"
    | "members.addRole"
    | "members.removeRole"
    | "roles.fetchAll"
    | "roles.create"
    | "roles.edit"
    | "roles.delete"
    | "roles.reorder"
    | "roles.setHoistPositions"
    | "roles.resetHoistPositions"

/** Expected failure from guild, member, role and related resource operations.
 * Inspect operation for the failed step, reason for the failure category and outcome before deciding whether to retry.
 * Safe metadata excludes tokens, private input values and upstream response bodies. Default API methods return this
 * error in an Err, while Effect-native methods fail in the typed error channel. Cancellation and client closure use
 * separate error types. An HTTP response does not establish that a corresponding gateway event was delivered
 */
export class GuildOperationError extends Error {
    /** Stable expected-failure discriminator */
    readonly _tag = "GuildOperationError"
    /** Safe explanation of the locally invalid property, or null when no input problem could be identified */
    readonly inputValidation: InputValidationDetail | null
    constructor(
        /** Requested operation */
        readonly operation: GuildOperation,
        /** input means local validation failed, busy means local request capacity was full, and notFound means HTTP 404.
         * rejected is an API rejection, network is a transport failure, and response means unusable success data.
         * timeout means the deadline expired, and rateLimit means the provider's required wait could not be completed.
         * A 404 does not prove that an earlier deletion succeeded
         */
        readonly reason: "input" | "busy" | "notFound" | "rejected" | "network" | "response" | "timeout" | "rateLimit",
        /** notDispatched means no request was submitted, rejected means an API rejection was observed,
         * and unknown means the remote result is uncertain. Unknown writes may already have applied, so reconcile
         * remote state before repeating them. An API rejection is not proof of rollback
         */
        readonly outcome: "notDispatched" | "rejected" | "unknown",
        /** HTTP status when available, otherwise null */
        readonly status: number | null = null,
        /** Usable server-required retry wait in milliseconds, otherwise null */
        readonly retryAfterMs: number | null = null,
        /** Safe classification of why Fluxer rejected the request, or null when the response could not be classified */
        readonly apiError: ApiErrorDetail | null = null,
        inputValidation: InputValidationDetail | null = null,
    ) {
        super(
            operationErrorMessage(
                "Guild",
                operation,
                reason,
                outcome,
                status,
                apiError,
                inputValidation?.explanation ?? null,
                retryAfterMs,
            ),
        )
        this.name = this._tag
        this.inputValidation = freezeInputValidationDetail(inputValidation)
    }
}

/** Native interruption is outside this union. Default API methods additionally return CancelledError */
export type GuildOperationFailure = GuildOperationError | ClientClosedError
