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

/** Guild-area operation identified by expected failures and default defects */
export type GuildOperation =
    | "guilds.get"
    | "members.get"
    | "roles.get"
    | "guilds.fetch"
    | "members.fetch"
    | "members.fetchSelf"
    | "members.fetchPage"
    | "members.addRole"
    | "members.removeRole"
    | "roles.fetchAll"
    | "roles.create"
    | "roles.edit"
    | "roles.delete"
    | "roles.reorder"

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
