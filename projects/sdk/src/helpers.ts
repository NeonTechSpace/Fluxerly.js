import { FluxerlyError, operationDetails } from "./errors.js"
import { operationErrorMessage } from "./api-errors.js"
import { err, ok, type Result } from "neverthrow"
import { Permissions } from "./guilds.js"
import type { GuildMember } from "./guilds.js"
import type { GuildChannel, PermissionOverwrite } from "./channels.js"
import type { DirectMessageChannel, User } from "./users.js"
import type { MessageReference } from "./messages.js"
import { permissionLabel } from "./internal/permission-labels.js"
import { guildShardId, maximumShardCount } from "./internal/sharding.js"

const snowflakeEpochMs = 1_420_070_400_000n
const snowflakeTimestampShift = 22n
const largestSnowflake = (1n << 63n) - 1n
const largestPermissionBits = (1n << 64n) - 1n
const largestTimestampSeconds = 8_640_000_000_000
const markdownEscapable = /[[\]()\\*_~`@#\-|:<>]/gu

/**
 * Choose how Fluxer displays a timestamp in a message. The viewer's locale and timezone control its rendered text
 *
 * @category Builders and formatting
 */
export const TimestampStyles: Readonly<{
    /** Time without seconds */
    ShortTime: "t"
    /** Time including seconds */
    LongTime: "T"
    /** Compact date */
    ShortDate: "d"
    /** Written-out date */
    LongDate: "D"
    /** Date and time, the default used by `format.timestamp` */
    ShortDateTime: "f"
    /** Written-out date and time */
    LongDateTime: "F"
    /** Compact date and short time */
    ShortDateShortTime: "s"
    /** Compact date and time including seconds */
    ShortDateMediumTime: "S"
    /** Time relative to the viewer's current time, such as "a few minutes ago" */
    RelativeTime: "R"
}> = Object.freeze({
    ShortTime: "t",
    LongTime: "T",
    ShortDate: "d",
    LongDate: "D",
    ShortDateTime: "f",
    LongDateTime: "F",
    ShortDateShortTime: "s",
    ShortDateMediumTime: "S",
    RelativeTime: "R",
})

/**
 * One Fluxer timestamp-markup display style
 *
 * @category Builders and formatting
 */
export type TimestampStyle = (typeof TimestampStyles)[keyof typeof TimestampStyles]

/**
 * The result of `format.parseMention`. Read `kind` to identify what was mentioned and `id` to get its decimal ID
 *
 * @category Builders and formatting
 */
export type Mention =
    | {
          /** This mention names a user, including the `<@!id>` spelling */
          readonly kind: "user"
          /** Mentioned user's decimal ID, without surrounding markup */
          readonly id: string
      }
    | {
          /** This mention names a role */
          readonly kind: "role"
          /** Mentioned role's decimal ID */
          readonly id: string
      }
    | {
          /** This mention names a channel */
          readonly kind: "channel"
          /** Mentioned channel's decimal ID */
          readonly id: string
      }

/**
 * Custom-emoji fields used by Fluxer's explicit `<:name:id>` or `<a:name:id>` markup
 *
 * @category Builders and formatting
 */
export interface CustomEmojiMarkup {
    /** ASCII letters, digits, underscores, or hyphens as accepted by Fluxer's message parser */
    readonly name: string
    /** Decimal Fluxer emoji ID */
    readonly id: string
    /** Selects `<a:...>` rather than `<:...>` */
    readonly animated?: boolean
}

/**
 * One parsed timestamp markup value. The `date` field has whole-second precision because Fluxer markup has no milliseconds
 *
 * @category Builders and formatting
 */
export interface TimestampMarkup {
    /** UTC instant represented by the markup */
    readonly date: Date
    /** Explicit style, or Fluxer's default short-date-time style when omitted in the markup */
    readonly style: TimestampStyle
}

/** The channel information needed to make a web link: Its `id` and, for a community channel, its `guildId`.
 * Supply a direct-message channel without `guildId`. Passing `guildId: null` is not the direct-message form
 *
 * @category Builders and formatting
 */
export type ChannelLinkTarget = Pick<GuildChannel, "id" | "guildId"> | Pick<DirectMessageChannel, "id">

/**
 * Optional raw permission bitfield requested by a hosted bot-installation page
 *
 * @category Builders and formatting
 */
export interface InstallationLinkOptions {
    /** Unsigned 64-bit Fluxer permission bitfield. Omit it to leave the provider's requested permissions unspecified */
    readonly permissions?: bigint
}

/** A helper could not use its input.
 * Helpers such as `format.userMention` throw this for invalid input, because passing it is a programming mistake.
 * The try-prefixed helpers, such as `format.tryParseMention`, report the same error without throwing.
 * The default API returns it in a Result, while the native API fails with it in the Effect error channel.
 * Read `operation` and `reason` to identify the problem. The error does not store the rejected value
 *
 * @category Errors
 */
export class HelperError extends FluxerlyError {
    /** Fixed name that identifies this error type */
    readonly _tag = "HelperError"

    constructor(
        /** Helper that rejected the input */
        readonly operation:
            | "format.userMention"
            | "format.roleMention"
            | "format.channelMention"
            | "format.parseMention"
            | "format.timestamp"
            | "format.parseTimestamp"
            | "format.customEmoji"
            | "format.parseCustomEmoji"
            | "snowflakes.parse"
            | "snowflakes.createdAt"
            | "snowflakes.boundary"
            | "snowflakes.shardFor"
            | "permissionBits.has"
            | "permissionBits.from"
            | "permissionBits.hasAll"
            | "permissionBits.hasAny"
            | "permissionBits.missing"
            | "permissionBits.inspect"
            | "permissionBits.toDecimal"
            | "permissionBits.label"
            | "permissionBits.patchOverwrite"
            | "permissionBits.refusedGrants"
            | "permissionBits.sameOverwrites"
            | "colors.parse"
            | "colors.toHex"
            | "colors.toRgb"
            | "text.split"
            | "text.truncate"
            | "errors.isNotFound"
            | "links.channel"
            | "links.message"
            | "links.installation"
            | "embed.color"
            | "embed.timestamp",
        /** Invalid input category, without retaining the rejected value */
        readonly reason:
            | "id"
            | "markup"
            | "time"
            | "permissionBits"
            | "link"
            | "color"
            | "text"
            | "limit"
            | "shardCount"
            | "resource",
        /** Optional underlying failure retained as the error's cause */
        options?: { readonly cause?: unknown },
    ) {
        super(
            operationErrorMessage({
                subject: "Helper",
                operation,
                reason: "input",
                outcome: "notDispatched",
                inputExplanation: helperExplanation(operation, reason),
            }),
            {
                code: `helper.${reason}`,
                cause: options?.cause,
                details: operationDetails({ operation, reason }),
            },
        )
        this.name = this._tag
    }
}

/** What the helper accepts, for the HelperError message. It never includes the rejected value */
function helperExplanation(operation: HelperError["operation"], reason: HelperError["reason"]): string {
    switch (reason) {
        case "id":
            return "IDs must be decimal strings from 0 through 9,223,372,036,854,775,807"
        case "markup":
            if (operation === "format.parseMention")
                return "Text must be a user, role, or channel mention such as <@123>"
            if (operation === "format.parseTimestamp") return "Text must be timestamp markup such as <t:1700000000:R>"
            if (operation === "format.parseCustomEmoji") return "Text must be custom emoji markup such as <:name:123>"
            if (operation === "format.timestamp") return "Timestamp style must be one of the TimestampStyles values"
            return "Custom emoji must have a name of letters, digits, underscores, or hyphens, a decimal id, and an optional boolean animated"
        case "time":
            if (operation === "format.parseTimestamp")
                return "Timestamp markup must hold a time after the Unix epoch that a Date can represent"
            if (operation === "snowflakes.boundary")
                return "The Date must be valid, from 2015-01-01T00:00:00Z (the Fluxer ID epoch) through the largest ID time"
            if (operation === "embed.timestamp")
                return "Timestamp must be a valid Date, or Unix epoch milliseconds within the Date range"
            if (operation === "format.timestamp") return "The Date must be valid and after the Unix epoch"
            return "The Date must be valid"
        case "permissionBits":
            if (operation === "permissionBits.patchOverwrite")
                return "The current overwrite must be undefined or hold allow and deny as bigints from 0 through 18,446,744,073,709,551,615, and the change may hold only allow, deny and inherit lists of Permissions keys, with each permission in at most one list"
            if (operation === "permissionBits.refusedGrants")
                return "The current and next overwrites must each be undefined or hold allow and deny as bigints from 0 through 18,446,744,073,709,551,615, and the held permissions must be a bigint in that range"
            if (operation === "permissionBits.sameOverwrites")
                return "Each list must be an array of overwrites, each with a decimal ID that appears once in the list, a type of role or member, and allow and deny as bigints from 0 through 18,446,744,073,709,551,615"
            return "Permission bits must be a bigint from 0 through 18,446,744,073,709,551,615, and permission names must be keys of Permissions"
        case "link":
            if (operation === "links.installation")
                return "Installation link options must be an object that may contain only permissions"
            if (operation === "links.message")
                return "The message must have a decimal id and belong to the given channel, and the channel must have a decimal id and, for a community channel, a decimal guildId"
            return "The channel must be an object with a decimal id and, for a community channel, a decimal guildId"
        case "color":
            return operation === "colors.parse" || operation === "embed.color"
                ? "Colors must be integers from 0 through 16,777,215, 6-digit hex strings such as #ff8800, or [red, green, blue] arrays of integers from 0 through 255"
                : "Colors must be integers from 0 through 16,777,215"
        case "text":
            return "Text must be a string"
        case "limit":
            if (operation === "text.truncate")
                return "Truncate options must be an object with only maxLength, a positive safe integer, and an optional suffix, a well-formed string of at most maxLength units"
            return "Split options must be an object with only maxLength, a positive safe integer of at least 2 when the text contains surrogate pairs"
        case "shardCount":
            return "The total shard count must be an integer from 1 through 16,384"
        case "resource":
            return 'The resource must be one of the NotFoundResource names, such as "channel" or "message"'
    }
}

/**
 * A key of Permissions, such as `"ManageMessages"`, accepted by the named permissionBits helpers
 *
 * @category Roles and permissions
 */
export type PermissionName = keyof typeof Permissions

/** Known permission names and any unnamed bits found by permissionBits.inspect.
 * This object and its names array are frozen. They do not decide what a user may do
 *
 * @category Roles and permissions
 */
export interface PermissionBitInspection {
    /** Present known names in Permissions declaration order, not sorted by display label */
    readonly names: readonly PermissionName[]
    /** Present bits without a known name, preserved exactly rather than discarded */
    readonly unknownBits: bigint
}

/**
 * Changes for permissionBits.patchOverwrite: Which permissions to allow, deny or return to inheritance.
 * Every list is optional, and a permission may appear in at most one of them
 *
 * @category Roles and permissions
 */
export interface OverwritePatch {
    /** Permissions to allow, which also stops denying them */
    readonly allow?: readonly PermissionName[]
    /** Permissions to deny, which also stops allowing them */
    readonly deny?: readonly PermissionName[]
    /** Permissions to neither allow nor deny, so the role's or member's other permissions decide */
    readonly inherit?: readonly PermissionName[]
}

const permissionNames = Object.freeze(Object.keys(Permissions) as PermissionName[])
const knownPermissionBits = Object.values(Permissions).reduce((bits, flag) => bits | flag, 0n)

function validPermissionBits(bits: unknown): bits is bigint {
    return typeof bits === "bigint" && bits >= 0n && bits <= largestPermissionBits
}

function namedPermissions(
    names: readonly PermissionName[],
    operation: HelperError["operation"],
): Result<bigint, HelperError> {
    if (!Array.isArray(names)) return err(helperError(operation, "permissionBits"))
    let bits = 0n
    for (const name of names) {
        if (typeof name !== "string" || !Object.hasOwn(Permissions, name))
            return err(helperError(operation, "permissionBits"))
        bits |= Permissions[name as PermissionName]
    }
    return ok(bits)
}

const patchKeys = ["allow", "deny", "inherit"] as const

function patchedOverwrite(
    current: Pick<PermissionOverwrite, "allow" | "deny"> | undefined,
    change: OverwritePatch,
): Result<Readonly<Pick<PermissionOverwrite, "allow" | "deny">>, HelperError> {
    const operation = "permissionBits.patchOverwrite"
    if (typeof change !== "object" || change === null || Array.isArray(change))
        return err(helperError(operation, "permissionBits"))
    if (Object.keys(change).some((key) => !patchKeys.includes(key as (typeof patchKeys)[number])))
        return err(helperError(operation, "permissionBits"))
    // Read each caller field once, so the validated lists are the ones applied
    const lists = [change.allow, change.deny, change.inherit]
    const [allowed, denied, inherited] = lists.map((names) =>
        names === undefined ? ok(0n) : namedPermissions(names, operation),
    )
    if (allowed!.isErr()) return err(allowed!.error)
    if (denied!.isErr()) return err(denied!.error)
    if (inherited!.isErr()) return err(inherited!.error)
    const [allow, deny, inherit] = [allowed!.value, denied!.value, inherited!.value]
    if ((allow & deny) !== 0n || (allow & inherit) !== 0n || (deny & inherit) !== 0n)
        return err(helperError(operation, "permissionBits"))
    if (current !== undefined && (typeof current !== "object" || current === null))
        return err(helperError(operation, "permissionBits"))
    const before = current === undefined ? { allow: 0n, deny: 0n } : { allow: current.allow, deny: current.deny }
    if (!validPermissionBits(before.allow) || !validPermissionBits(before.deny))
        return err(helperError(operation, "permissionBits"))
    return ok(
        Object.freeze({
            allow: (before.allow | allow) & ~(deny | inherit),
            deny: (before.deny | deny) & ~(allow | inherit),
        }),
    )
}

type OverwriteBits = Pick<PermissionOverwrite, "allow" | "deny">

/** The allow and deny bits of an overwrite as read, nothing for undefined, or null when the value is not an overwrite */
function overwriteBits(value: unknown): OverwriteBits | null {
    if (value === undefined) return { allow: 0n, deny: 0n }
    if (typeof value !== "object" || value === null) return null
    // Read each caller field once, so the validated bits are the ones used
    const { allow, deny } = value as { readonly allow?: unknown; readonly deny?: unknown }
    return validPermissionBits(allow) && validPermissionBits(deny) ? { allow, deny } : null
}

function refusedGrantBits(current: unknown, next: unknown, held: unknown): Result<bigint, HelperError> {
    const operation = "permissionBits.refusedGrants"
    const before = overwriteBits(current)
    const after = overwriteBits(next)
    if (before === null || after === null || !validPermissionBits(held))
        return err(helperError(operation, "permissionBits"))
    if ((held & Permissions.Administrator) === Permissions.Administrator) return ok(0n)
    // Fluxer's overwriteGrantedBits: Bits the change newly allows, and bits it stops denying
    const granted = (after.allow & ~before.allow) | (before.deny & ~after.deny)
    return ok(granted & ~held)
}

/** The overwrites of a list by target ID, or null when the list is invalid or names a target twice */
function overwritesById(value: unknown): ReadonlyMap<string, PermissionOverwrite> | null {
    if (!Array.isArray(value)) return null
    const byId = new Map<string, PermissionOverwrite>()
    for (const entry of value as unknown[]) {
        if (typeof entry !== "object" || entry === null) return null
        // Read each caller field once, so the validated overwrite is the one compared
        const { id, type, allow, deny } = entry as Partial<Record<keyof PermissionOverwrite, unknown>>
        if (
            !isSnowflake(id) ||
            (type !== "role" && type !== "member") ||
            !validPermissionBits(allow) ||
            !validPermissionBits(deny) ||
            byId.has(id)
        )
            return null
        byId.set(id, { id, type, allow, deny })
    }
    return byId
}

function sameOverwriteLists(first: unknown, second: unknown): Result<boolean, HelperError> {
    const a = overwritesById(first)
    const b = overwritesById(second)
    if (a === null || b === null) return err(helperError("permissionBits.sameOverwrites", "permissionBits"))
    if (a.size !== b.size) return ok(false)
    for (const [id, left] of a) {
        const right = b.get(id)
        if (right === undefined || right.type !== left.type || right.allow !== left.allow || right.deny !== left.deny)
            return ok(false)
    }
    return ok(true)
}

const timestampStyleValues = new Set<string>(Object.values(TimestampStyles))

function helperError(operation: HelperError["operation"], reason: HelperError["reason"]): HelperError {
    return new HelperError(operation, reason)
}

function isSnowflake(value: unknown): value is string {
    if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return false
    try {
        return BigInt(value) <= largestSnowflake
    } catch {
        // allow-silent: a value BigInt cannot parse is not a snowflake
        return false
    }
}

function snowflake(value: unknown, operation: HelperError["operation"]): Result<bigint, HelperError> {
    return isSnowflake(value) ? ok(BigInt(value)) : err(helperError(operation, "id"))
}

function markupId(value: unknown, operation: HelperError["operation"]): Result<string, HelperError> {
    return isSnowflake(value) ? ok(value) : err(helperError(operation, "id"))
}

function timestampDate(value: unknown, operation: HelperError["operation"]): Result<Date, HelperError> {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return err(helperError(operation, "time"))
    return ok(value)
}

function timestampStyle(value: unknown, operation: HelperError["operation"]): Result<TimestampStyle, HelperError> {
    return typeof value === "string" && timestampStyleValues.has(value)
        ? ok(value as TimestampStyle)
        : err(helperError(operation, "markup"))
}

function customEmoji(value: unknown, operation: HelperError["operation"]): Result<CustomEmojiMarkup, HelperError> {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return err(helperError(operation, "markup"))
    const input = value as Record<string, unknown>
    if (typeof input.name !== "string" || !/^[A-Za-z0-9_-]+$/u.test(input.name))
        return err(helperError(operation, "markup"))
    if (!isSnowflake(input.id)) return err(helperError(operation, "id"))
    if (input.animated !== undefined && typeof input.animated !== "boolean")
        return err(helperError(operation, "markup"))
    return ok(Object.freeze({ name: input.name, id: input.id, ...(input.animated === true ? { animated: true } : {}) }))
}

function channelLink(
    value: unknown,
    operation: "links.channel" | "links.message",
): Result<{ readonly id: string; readonly guildId: string | null }, HelperError> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return err(helperError(operation, "link"))
    const input = value as Record<string, unknown>
    if (!isSnowflake(input.id)) return err(helperError(operation, "id"))
    if (!("guildId" in input)) return ok({ id: input.id, guildId: null })
    return isSnowflake(input.guildId)
        ? ok({ id: input.id, guildId: input.guildId })
        : err(helperError(operation, "link"))
}

function installationPermissions(value: unknown): Result<string | undefined, HelperError> {
    if (value === undefined) return ok(undefined)
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return err(helperError("links.installation", "link"))
    const input = value as Record<string, unknown>
    if (Object.keys(input).some((key) => key !== "permissions")) return err(helperError("links.installation", "link"))
    if (input.permissions === undefined) return ok(undefined)
    if (typeof input.permissions !== "bigint") return err(helperError("links.installation", "permissionBits"))
    return validPermissionBits(input.permissions)
        ? ok(input.permissions.toString())
        : err(helperError("links.installation", "permissionBits"))
}

/**
 * Return a successful helper value, or throw the helper's expected error for invalid input.
 * Plain public helpers use this over their Result-returning cores, so both keep identical validation
 */
export function valueOrThrow<A, E>(result: Result<A, E>): A {
    if (result.isErr()) throw result.error
    return result.value
}

function userMention(id: string): Result<string, HelperError> {
    return markupId(id, "format.userMention").map((value) => `<@${value}>`)
}

function roleMention(id: string): Result<string, HelperError> {
    return markupId(id, "format.roleMention").map((value) => `<@&${value}>`)
}

function channelMention(id: string): Result<string, HelperError> {
    return markupId(id, "format.channelMention").map((value) => `<#${value}>`)
}

function parseMention(value: string): Result<Mention, HelperError> {
    if (typeof value !== "string") return err(helperError("format.parseMention", "markup"))
    const user = /^<@!?([0-9]+)>$/u.exec(value)
    const role = /^<@&([0-9]+)>$/u.exec(value)
    const channel = /^<#([0-9]+)>$/u.exec(value)
    if (user && isSnowflake(user[1])) return ok(Object.freeze({ kind: "user" as const, id: user[1] }))
    if (role && isSnowflake(role[1])) return ok(Object.freeze({ kind: "role" as const, id: role[1] }))
    if (channel && isSnowflake(channel[1])) return ok(Object.freeze({ kind: "channel" as const, id: channel[1] }))
    return err(helperError("format.parseMention", "markup"))
}

function timestamp(value: Date, style: TimestampStyle = TimestampStyles.ShortDateTime): Result<string, HelperError> {
    const date = timestampDate(value, "format.timestamp")
    if (date.isErr()) return err(date.error)
    const resolvedStyle = timestampStyle(style, "format.timestamp")
    if (resolvedStyle.isErr()) return err(resolvedStyle.error)
    const seconds = Math.floor(date.value.getTime() / 1_000)
    if (seconds <= 0 || seconds > largestTimestampSeconds) return err(helperError("format.timestamp", "time"))
    return ok(`<t:${seconds}:${resolvedStyle.value}>`)
}

function parseTimestamp(value: string): Result<TimestampMarkup, HelperError> {
    if (typeof value !== "string") return err(helperError("format.parseTimestamp", "markup"))
    const match = /^<t:([0-9]+)(?::([tTdDfFsSR]))?>$/u.exec(value)
    if (!match) return err(helperError("format.parseTimestamp", "markup"))
    const seconds = Number(match[1])
    if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > largestTimestampSeconds)
        return err(helperError("format.parseTimestamp", "time"))
    const style = (match[2] ?? TimestampStyles.ShortDateTime) as TimestampStyle
    return ok(Object.freeze({ date: new Date(seconds * 1_000), style }))
}

function customEmojiMarkup(input: CustomEmojiMarkup): Result<string, HelperError> {
    return customEmoji(input, "format.customEmoji").map(
        (value) => `<${value.animated === true ? "a" : ""}:${value.name}:${value.id}>`,
    )
}

function parseCustomEmoji(value: string): Result<CustomEmojiMarkup, HelperError> {
    if (typeof value !== "string") return err(helperError("format.parseCustomEmoji", "markup"))
    const match = /^<(a?):([A-Za-z0-9_-]+):([0-9]+)>$/u.exec(value)
    if (!match) return err(helperError("format.parseCustomEmoji", "markup"))
    return customEmoji(
        { name: match[2]!, id: match[3]!, ...(match[1] === "a" ? { animated: true } : {}) },
        "format.parseCustomEmoji",
    )
}

/**
 * Methods of the format helper, which creates and reads mention, timestamp and custom-emoji markup and escapes Markdown.
 * Most methods return plain values and throw HelperError for invalid input.
 * The try-prefixed parsers accept untrusted text and return a Result instead of throwing
 *
 * @category Builders and formatting
 */
export type FormatHelpers = Readonly<{
    /**
     * Add backslashes so text is treated literally by Fluxer's markup parser, for example escaping `**bold**`.
     * Returns the escaped string immediately and never throws for string input.
     * It does not change a message's `allowedMentions` or enable notifications
     */
    escapeMarkdown(value: string): string
    /**
     * Create `<@id>` text for a decimal user ID, such as `<@123>`, and return it directly.
     * Throws HelperError when the ID is not a valid decimal-string snowflake.
     * This does not look up the user, and allowedMentions must be set separately to request a notification
     */
    userMention(id: string): string
    /**
     * Create `<@&id>` text for a decimal role ID, such as `<@&123>`, and return it directly.
     * Throws HelperError for an invalid ID.
     * Role members are not notified merely because this text appears in a message, and allowedMentions must be set separately
     */
    roleMention(id: string): string
    /**
     * Create `<#id>` text linking to a channel, such as `<#123>`, and return it directly.
     * Throws HelperError for an invalid decimal-string ID, and no channel lookup occurs
     */
    channelMention(id: string): string
    /**
     * Read a string containing exactly one user, role or channel mention into a frozen `{ kind, id }` object.
     * Both `<@id>` and `<@!id>` produce kind `"user"`.
     * Throws HelperError for surrounding text, malformed markup or an invalid decimal ID.
     * For text received from users, use tryParseMention, which reports the same HelperError without throwing
     */
    parseMention(value: string): Mention
    /**
     * Read a mention with the same rules as parseMention, but report invalid text without throwing.
     * The default API returns a Result holding the frozen `{ kind, id }` object or HelperError.
     * The native API returns an Effect that reads the text when run and fails with HelperError.
     * Use it for text received from users or other untrusted sources
     */
    tryParseMention(value: string): Result<Mention, HelperError>
    /**
     * Create `<t:seconds:style>` message text from a Date, which Fluxer displays in the reader's local time.
     * The style defaults to ShortDateTime, and milliseconds are dropped.
     * The whole Unix second must be from 1 through 8_640_000_000_000.
     * Throws HelperError for an invalid Date, a time outside that range or an unsupported style.
     * The input Date is not changed
     */
    timestamp(value: Date, style?: TimestampStyle): string
    /**
     * Read exactly one `<t:seconds:style>` or `<t:seconds>` string into a frozen object with a new Date and style.
     * A missing style becomes ShortDateTime.
     * The Date has whole-second precision.
     * Throws HelperError for malformed markup, nonpositive seconds or dates outside JavaScript's range.
     * For text received from users, use tryParseTimestamp, which reports the same HelperError without throwing
     */
    parseTimestamp(value: string): TimestampMarkup
    /**
     * Read timestamp markup with the same rules as parseTimestamp, but report invalid text without throwing.
     * The default API returns a Result holding the frozen date and style or HelperError.
     * The native API returns an Effect that reads the text when run and fails with HelperError.
     * Use it for text received from users or other untrusted sources
     */
    tryParseTimestamp(value: string): Result<TimestampMarkup, HelperError>
    /**
     * Create `<:name:id>` text, or `<a:name:id>` when animated is true.
     * A GuildEmoji can be passed directly.
     * Throws HelperError for invalid names, IDs or animation values.
     * This does not upload or look up an emoji
     */
    customEmoji(input: CustomEmojiMarkup): string
    /**
     * Read exactly one `<:name:id>` or `<a:name:id>` string into frozen name, ID and animated fields.
     * Throws HelperError for malformed markup.
     * This does not resolve shortcodes such as `:smile:` or parse Unicode emoji.
     * For text received from users, use tryParseCustomEmoji, which reports the same HelperError without throwing
     */
    parseCustomEmoji(value: string): CustomEmojiMarkup
    /**
     * Read custom-emoji markup with the same rules as parseCustomEmoji, but report invalid text without throwing.
     * The default API returns a Result holding the frozen name, ID and animated fields or HelperError.
     * The native API returns an Effect that reads the text when run and fails with HelperError.
     * Use it for text received from users or other untrusted sources
     */
    tryParseCustomEmoji(value: string): Result<CustomEmojiMarkup, HelperError>
}>

/**
 * Create or read Fluxer's special message text, such as mentions, timestamps and custom emoji.
 * Most methods return plain values and throw HelperError for invalid input, which indicates a programming mistake.
 * For text received from users, the try-prefixed parsers return a Result instead.
 * Use `isOk()` before reading `value`, or `isErr()` before reading `error`.
 * Formatting a mention only creates text, it cannot enable notifications.
 * Keep message notification intent explicit with `allowedMentions` when sending that text
 *
 * @example
 * ```ts
 * import { format, links, type GuildChannel } from "@neontechspace/fluxerly"
 *
 * export function helpersExample(userId: string, messageId: string, channel: GuildChannel) {
 *     return {
 *         escaped: format.escapeMarkdown("@everyone: **literal**"),
 *         mention: format.userMention(userId),
 *         message: links.message({ id: messageId, channelId: channel.id }, channel),
 *     }
 * }
 * ```
 */
export const format: FormatHelpers = Object.freeze({
    escapeMarkdown(value: string): string {
        return value.replace(markdownEscapable, "\\$&")
    },
    userMention: (id: string): string => valueOrThrow(userMention(id)),
    roleMention: (id: string): string => valueOrThrow(roleMention(id)),
    channelMention: (id: string): string => valueOrThrow(channelMention(id)),
    parseMention: (value: string): Mention => valueOrThrow(parseMention(value)),
    tryParseMention: parseMention,
    timestamp: (value: Date, style?: TimestampStyle): string => valueOrThrow(timestamp(value, style)),
    parseTimestamp: (value: string): TimestampMarkup => valueOrThrow(parseTimestamp(value)),
    tryParseTimestamp: parseTimestamp,
    customEmoji: (input: CustomEmojiMarkup): string => valueOrThrow(customEmojiMarkup(input)),
    parseCustomEmoji: (value: string): CustomEmojiMarkup => valueOrThrow(parseCustomEmoji(value)),
    tryParseCustomEmoji: parseCustomEmoji,
})

/**
 * Methods of the snowflakes helper, which reads and converts decimal Fluxer IDs without losing precision
 *
 * @category Builders and formatting
 */
export type SnowflakeHelpers = Readonly<{
    /**
     * Return true for a decimal string from `"0"` through `"9223372036854775807"`, with no extra leading zeroes.
     * Returns false immediately for numbers, whitespace and invalid strings, without converting through Number or failing
     */
    isValid(value: unknown): value is string
    /**
     * Convert a valid decimal-string ID to bigint without losing precision.
     * Throws HelperError for an invalid ID.
     * For IDs received from users, use tryParse, which reports the same HelperError without throwing
     */
    parse(value: string): bigint
    /**
     * Convert a decimal-string ID with the same rules as parse, but report an invalid ID without throwing.
     * The default API returns a Result holding the bigint or HelperError.
     * The native API returns an Effect that reads the ID when run and fails with HelperError.
     * Use it for IDs received from users or other untrusted sources
     */
    tryParse(value: string): Result<bigint, HelperError>
    /**
     * Return a new UTC Date for the creation time encoded in an ID.
     * Throws HelperError for an invalid ID.
     * This decodes the ID's high 41 timestamp bits relative to 2015-01-01 UTC, and does not fetch the resource or prove it is visible
     */
    createdAt(value: string): Date
    /**
     * Make the smallest ID for a Date's exact UTC millisecond, useful as a time-based pagination boundary.
     * Throws HelperError for an invalid Date, a date before 2015-01-01 UTC or a result outside the ID range.
     * This does not create a resource.
     * Whether the boundary is included depends on the endpoint using it
     */
    boundary(value: Date): string
    /**
     * Return the shard that receives a community's gateway events when the bot runs totalShards shards.
     * Fluxer calls a community a guild, so the first argument is a guild ID.
     * Fluxer routes each community with (guildId >> 22) % totalShards, and this helper applies the same formula.
     * Use it to find which process owns a community when shards run in several processes.
     * Throws HelperError for an invalid ID or a totalShards outside 1 through 16,384.
     * It does not check whether the bot belongs to that community
     */
    shardFor(guildId: string, totalShards: number): number
}>

function parseSnowflake(value: string): Result<bigint, HelperError> {
    return snowflake(value, "snowflakes.parse")
}

function snowflakeBoundary(value: Date): Result<string, HelperError> {
    const date = timestampDate(value, "snowflakes.boundary")
    if (date.isErr()) return err(date.error)
    const unixMs = BigInt(date.value.getTime())
    if (unixMs < snowflakeEpochMs) return err(helperError("snowflakes.boundary", "time"))
    const boundary = (unixMs - snowflakeEpochMs) << snowflakeTimestampShift
    return boundary <= largestSnowflake ? ok(boundary.toString()) : err(helperError("snowflakes.boundary", "time"))
}

/** Inspect Fluxer IDs, called snowflakes, or make time-based pagination boundaries.
 * IDs stay decimal strings or bigint because JavaScript numbers cannot represent every 64-bit ID exactly.
 * Conversions return plain values and throw HelperError for invalid input, while tryParse returns a Result
 */
export const snowflakes: SnowflakeHelpers = Object.freeze({
    isValid(value: unknown): value is string {
        return isSnowflake(value)
    },
    parse: (value: string): bigint => valueOrThrow(parseSnowflake(value)),
    tryParse: parseSnowflake,
    createdAt: (value: string): Date =>
        valueOrThrow(
            snowflake(value, "snowflakes.createdAt").map(
                (id) => new Date(Number((id >> snowflakeTimestampShift) + snowflakeEpochMs)),
            ),
        ),
    boundary: (value: Date): string => valueOrThrow(snowflakeBoundary(value)),
    shardFor: (guildId: string, totalShards: number): number => {
        valueOrThrow(snowflake(guildId, "snowflakes.shardFor"))
        if (
            typeof totalShards !== "number" ||
            !Number.isSafeInteger(totalShards) ||
            totalShards < 1 ||
            totalShards > maximumShardCount
        )
            throw helperError("snowflakes.shardFor", "shardCount")
        return guildShardId(guildId, totalShards)
    },
})

/**
 * Methods of the display helper, which chooses a display name from supplied user or member data
 *
 * @category Builders and formatting
 */
export type DisplayHelpers = Readonly<{
    /** Return the member's nickname, otherwise the user's displayName, otherwise username.
     * Only null or undefined trigger a fallback. Supply a member for the same user, this helper does not check identity or fetch data
     */
    name(
        user: Pick<User, "username"> & { readonly displayName?: string | null },
        member?: Pick<GuildMember, "nickname">,
    ): string
}>

/** Choose a name to show from user and optional community member information already held by the application */
export const display: DisplayHelpers = Object.freeze({
    name(
        user: Pick<User, "username"> & { readonly displayName?: string | null },
        member?: Pick<GuildMember, "nickname">,
    ): string {
        return member?.nickname ?? user.displayName ?? user.username
    },
})

/**
 * Methods of the permissionBits helper, which builds and inspects raw bigint permission flags.
 * Each method returns a plain value and throws HelperError for invalid input
 *
 * @category Roles and permissions
 */
export type PermissionBitHelpers = Readonly<{
    /**
     * Combine names such as `["ManageMessages", "ManageRoles"]` into one bigint permission set for role or overwrite inputs.
     * An empty array gives 0n, and duplicates have no extra effect.
     * Administrator remains one flag rather than expanding to all permissions.
     * Throws HelperError for an unknown name
     */
    from(names: readonly PermissionName[]): bigint
    /**
     * Return whether bits contains one named permission.
     * Throws HelperError for bits outside the unsigned 64-bit bigint range or an unknown permission name.
     * This does not calculate inherited permissions or authorize an action
     */
    has(bits: bigint, permission: PermissionName): boolean
    /**
     * Return true if bits contains every requested permission, including true for an empty names array.
     * Every name is validated even if a permission is missing, and unknown bits are unchanged.
     * Throws HelperError for invalid bits or unknown names
     */
    hasAll(bits: bigint, names: readonly PermissionName[]): boolean
    /**
     * Return true if bits contains at least one requested permission, or false for an empty names array.
     * Every name is validated even after finding a match.
     * Throws HelperError for invalid bits or unknown names
     */
    hasAny(bits: bigint, names: readonly PermissionName[]): boolean
    /**
     * List requested permissions absent from bits, in the order first requested and without duplicates.
     * Returns a frozen array, empty if nothing is missing, and input arrays are not changed.
     * Throws HelperError for invalid bits or unknown names
     */
    missing(bits: bigint, names: readonly PermissionName[]): readonly PermissionName[]
    /**
     * Return a frozen object listing present known names and any remaining flags as unknownBits.
     * Names follow Permissions declaration order.
     * Unknown flags are preserved, and Administrator does not add other names.
     * Throws HelperError for bits outside the unsigned 64-bit range
     */
    inspect(bits: bigint): PermissionBitInspection
    /**
     * Convert unsigned 64-bit bigint permission bits to the decimal string used in Fluxer JSON requests and URLs.
     * Throws HelperError for values outside that range
     */
    toDecimal(bits: bigint): string
    /**
     * Return the English label that Fluxer's own app shows for a permission, such as "Manage community" for ManageGuild
     * and "Time out members" for ModerateMembers.
     * Use it to show a permission to people, because the identifier is not a readable name. The labels are fixed English text
     * and are not translated.
     * They are Fluxer's community-scope titles. Inside a channel's permission screen, Fluxer titles ManageChannels
     * "Manage channel" and ManageRoles "Manage permissions", and every other title is the same there.
     * Throws HelperError for an unknown permission name
     */
    label(name: PermissionName): string
    /**
     * Change some permissions of a channel overwrite's allow and deny bits and keep the rest, for channels.setPermissionOverwrite,
     * which replaces both bit sets.
     * `current` is the overwrite as read, or undefined when there is none, which counts as nothing allowed or denied.
     * In `change`, `allow` sets the permissions in allow and clears them from deny, `deny` does the reverse, and
     * `inherit` clears them from both. Every other bit stays as it was, including bits without a known name.
     * Returns a frozen object with the new allow and deny.
     * Throws HelperError when a permission is in more than one list, a name is unknown, `change` has another key or
     * `current` holds bits outside the unsigned 64-bit range.
     * An overwrite with both allow and deny at 0n has no effect, so remove it with channels.removePermissionOverwrite.
     * An overwrite read from Fluxer can carry bit 63, which cannot be written back, and Fluxer can still refuse bits
     * that the bot itself lacks
     *
     * @example
     * ```ts
     * import { permissionBits, type Client, type PermissionOverwrite } from "@neontechspace/fluxerly"
     * export async function muteChannelExample(
     *     client: Client,
     *     channelId: string,
     *     current: PermissionOverwrite | undefined,
     * ) {
     *     const { allow, deny } = permissionBits.patchOverwrite(current, {
     *         deny: ["SendMessages", "AddReactions"],
     *         inherit: ["ViewChannel"],
     *     })
     *     return await client.channels.setPermissionOverwrite(channelId, { id: "20", type: "role", allow, deny })
     * }
     * ```
     */
    patchOverwrite(
        current: Pick<PermissionOverwrite, "allow" | "deny"> | undefined,
        change: OverwritePatch,
    ): Readonly<Pick<PermissionOverwrite, "allow" | "deny">>
    /**
     * Return the permission bits that Fluxer would refuse when an overwrite changes from `current` to `next`, so the
     * change can be checked before the request is sent.
     * Unless the bot has Administrator, Fluxer lets it allow, or stop denying, only permissions it has in the overwrite's
     * channel, and answers missingPermissions otherwise. Removing an overwrite stops all of its denies.
     * Pass the overwrite as read as `current` and the one to write as `next`, with undefined for no overwrite, so a `next`
     * of undefined is a removal. Pass the bot's permission bits in that channel as `held`, such as the result of
     * `permissions.fetch` with a `channelId` or an entry of `permissions.fetchChannels`.
     * Returns 0n when nothing would be refused. That is always the case when `held` includes Administrator, and when the
     * change only denies bits or stops allowing them.
     * One call covers one overwrite. For `channels.edit` with a new list, call it for each target ID in either list. For a
     * category move with syncPermissionsOnMove, call it for each target ID in the channel's or the category's overwrites,
     * with the channel's bits. For `channels.create`, pass undefined as `current` and the parent category's bits as
     * `held`, or the community-wide bits when there is no parent, because Fluxer checks only the allow bits there.
     * Throws HelperError when an overwrite or `held` has the wrong type or bits outside the unsigned 64-bit range
     *
     * @example
     * ```ts
     * import { permissionBits, type Client, type PermissionOverwrite } from "@neontechspace/fluxerly"
     * export async function allowTtsExample(
     *     client: Client,
     *     guildId: string,
     *     channelId: string,
     *     botId: string,
     *     current: PermissionOverwrite | undefined,
     * ) {
     *     const held = await client.permissions.fetch({ guildId, userId: botId, channelId })
     *     if (held.isErr()) return held
     *     const next = permissionBits.patchOverwrite(current, { allow: ["SendTtsMessages"] })
     *     const refused = permissionBits.refusedGrants(current, next, held.value)
     *     if (refused !== 0n) return permissionBits.inspect(refused).names
     *     return await client.channels.setPermissionOverwrite(channelId, { id: "20", type: "role", ...next })
     * }
     * ```
     */
    refusedGrants(
        current: Pick<PermissionOverwrite, "allow" | "deny"> | undefined,
        next: Pick<PermissionOverwrite, "allow" | "deny"> | undefined,
        held: bigint,
    ): bigint
    /**
     * Return whether two overwrite lists are equal the way Fluxer compares them: The same target IDs, and for each ID the same type, allow and deny.
     * Order and other fields of the entries are ignored.
     * A channel whose overwrites equal its category's is synced with it. When `channels.edit`,
     * `channels.setPermissionOverwrite` or `channels.removePermissionOverwrite` changes the category's overwrites, Fluxer
     * copies the change to exactly those children, with no opt-out. Compare each child with the category before the
     * change to learn which channels it will rewrite.
     * Two empty lists are equal, so a category without overwrites also syncs every child without overwrites.
     * Throws HelperError for a value that is not an array, an entry with an invalid ID, type or bits, or a list that names
     * the same ID twice. Fluxer rejects duplicate IDs on write, so a list read from Fluxer never has one
     */
    sameOverwrites(first: readonly PermissionOverwrite[], second: readonly PermissionOverwrite[]): boolean
}>

/** Work with sets of named permissions stored in a bigint bitfield, without writing bitwise expressions by hand.
 * Each method returns a plain value. Invalid names or values outside unsigned 64-bit bigint range throw HelperError.
 * These inspect stored flags only, they do not expand Administrator, apply channel overrides or decide whether an action is allowed
 */
export const permissionBits: PermissionBitHelpers = Object.freeze({
    from: (names: readonly PermissionName[]): bigint => valueOrThrow(namedPermissions(names, "permissionBits.from")),
    has(bits: bigint, permission: PermissionName): boolean {
        if (typeof bits !== "bigint" || bits < 0n || bits > largestPermissionBits)
            throw helperError("permissionBits.has", "permissionBits")
        if (typeof permission !== "string" || !Object.hasOwn(Permissions, permission))
            throw helperError("permissionBits.has", "permissionBits")
        const flag = Permissions[permission as PermissionName]
        return (bits & flag) === flag
    },
    hasAll(bits: bigint, names: readonly PermissionName[]): boolean {
        if (!validPermissionBits(bits)) throw helperError("permissionBits.hasAll", "permissionBits")
        const required = valueOrThrow(namedPermissions(names, "permissionBits.hasAll"))
        return (bits & required) === required
    },
    hasAny(bits: bigint, names: readonly PermissionName[]): boolean {
        if (!validPermissionBits(bits)) throw helperError("permissionBits.hasAny", "permissionBits")
        return (bits & valueOrThrow(namedPermissions(names, "permissionBits.hasAny"))) !== 0n
    },
    missing(bits: bigint, names: readonly PermissionName[]): readonly PermissionName[] {
        if (!validPermissionBits(bits)) throw helperError("permissionBits.missing", "permissionBits")
        valueOrThrow(namedPermissions(names, "permissionBits.missing"))
        return Object.freeze([...new Set(names)].filter((name) => (bits & Permissions[name]) !== Permissions[name]))
    },
    inspect(bits: bigint): PermissionBitInspection {
        if (!validPermissionBits(bits)) throw helperError("permissionBits.inspect", "permissionBits")
        return Object.freeze({
            names: Object.freeze(permissionNames.filter((name) => (bits & Permissions[name]) === Permissions[name])),
            unknownBits: bits & (largestPermissionBits ^ knownPermissionBits),
        })
    },
    toDecimal(bits: bigint): string {
        if (!validPermissionBits(bits)) throw helperError("permissionBits.toDecimal", "permissionBits")
        return bits.toString()
    },
    label(name: PermissionName): string {
        if (typeof name !== "string" || !Object.hasOwn(Permissions, name))
            throw helperError("permissionBits.label", "permissionBits")
        return permissionLabel(name)
    },
    patchOverwrite: (
        current: Pick<PermissionOverwrite, "allow" | "deny"> | undefined,
        change: OverwritePatch,
    ): Readonly<Pick<PermissionOverwrite, "allow" | "deny">> => valueOrThrow(patchedOverwrite(current, change)),
    refusedGrants: (
        current: Pick<PermissionOverwrite, "allow" | "deny"> | undefined,
        next: Pick<PermissionOverwrite, "allow" | "deny"> | undefined,
        held: bigint,
    ): bigint => valueOrThrow(refusedGrantBits(current, next, held)),
    sameOverwrites: (first: readonly PermissionOverwrite[], second: readonly PermissionOverwrite[]): boolean =>
        valueOrThrow(sameOverwriteLists(first, second)),
})

/**
 * Methods of the links helper, which builds Fluxer channel, message and installation URLs.
 * Each method returns the URL directly and throws HelperError for invalid input
 *
 * @category Builders and formatting
 */
export type LinkHelpers = Readonly<{
    /**
     * Build a hosted community-channel or direct-message URL from `{ id, guildId }` for a community channel or `{ id }` for a private conversation.
     * DirectMessageChannel inputs use Fluxer's `/channels/@me/:channelId` route.
     * Throws HelperError for invalid decimal IDs.
     * A URL does not prove the channel exists or the reader can open it
     */
    channel(target: ChannelLinkTarget): string
    /**
     * Build a hosted message URL in the supplied actual community-channel or direct-message context.
     * Message and channel IDs must match, otherwise the call throws HelperError.
     * Private versus community context is not inferred from the message alone, and access is not checked
     */
    message(message: MessageReference, channel: ChannelLinkTarget): string
    /**
     * Build a URL for Fluxer's bot-installation flow from an application ID, with the fixed `bot` scope and optional unsigned 64-bit permissions.
     * For the hosted `links` export, the URL starts at Fluxer's API authorization route, which redirects to the web app's installation page wherever Fluxer currently serves it.
     * Instance links open the instance web app's installation page directly.
     * Throws HelperError for invalid IDs or options, and an alternate origin or scope is not accepted.
     * This does not open the page, install the bot, authorize permissions or check whether the application exists
     */
    installation(applicationId: string, options?: InstallationLinkOptions): string
}>

/** Make URLs for opening channels, messages or bot installation in the hosted Fluxer app.
 * Each method returns the URL directly and throws HelperError for invalid input. No browser is opened and no access or existence check is made
 */
export const links: LinkHelpers = Object.freeze({
    channel(target: ChannelLinkTarget): string {
        const { id, guildId } = valueOrThrow(channelLink(target, "links.channel"))
        return guildId === null
            ? `https://fluxer.app/channels/@me/${id}`
            : `https://fluxer.app/channels/${guildId}/${id}`
    },
    message(message: MessageReference, channel: ChannelLinkTarget): string {
        const resolvedChannel = valueOrThrow(channelLink(channel, "links.message"))
        const id = markupId(message?.id, "links.message")
        if (id.isErr() || message?.channelId !== resolvedChannel.id) throw helperError("links.message", "link")
        return resolvedChannel.guildId === null
            ? `https://fluxer.app/channels/@me/${resolvedChannel.id}/${id.value}`
            : `https://fluxer.app/channels/${resolvedChannel.guildId}/${resolvedChannel.id}/${id.value}`
    },
    installation(applicationId: string, options?: InstallationLinkOptions): string {
        return `https://api.fluxer.app/v1/oauth2/authorize?${installationQuery(applicationId, options)}`
    },
})

// The hosted marketing site has no installation page, so hosted links start at the API route that redirects to the web app
function installationQuery(applicationId: string, options: InstallationLinkOptions | undefined): URLSearchParams {
    const id = valueOrThrow(markupId(applicationId, "links.installation"))
    const permissions = valueOrThrow(installationPermissions(options))
    const query = new URLSearchParams({ client_id: id, scope: "bot" })
    if (permissions !== undefined) query.set("permissions", permissions)
    return query
}

/**
 * Make channel, message and installation URLs for a validated instance web-app base
 *
 * The hosted `links` export is unchanged.
 * This factory keeps its local input checks, including thrown HelperError. Channel and message URLs replace only the
 * hosted application base, and installation URLs open the instance web app's installation page directly.
 * No network request occurs
 */
export function createInstanceLinks(webapp: string): LinkHelpers {
    const project = (url: string): string => `${webapp}${url.slice("https://fluxer.app".length)}`
    return Object.freeze({
        channel: (...input: Parameters<typeof links.channel>) => project(links.channel(...input)),
        message: (...input: Parameters<typeof links.message>) => project(links.message(...input)),
        installation: (...input: Parameters<typeof links.installation>) =>
            `${webapp}/oauth2/authorize?${installationQuery(...input)}`,
    })
}
