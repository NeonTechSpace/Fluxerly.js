import { err, ok, type Result } from "neverthrow"
import { Permissions } from "./guilds.js"
import type { GuildMember } from "./guilds.js"
import type { GuildChannel } from "./channels.js"
import type { DirectMessageChannel, User } from "./users.js"
import type { MessageReference } from "./messages.js"

const snowflakeEpochMs = 1_420_070_400_000n
const snowflakeTimestampShift = 22n
const largestSnowflake = (1n << 63n) - 1n
const largestPermissionBits = (1n << 64n) - 1n
const largestTimestampSeconds = 8_640_000_000_000
const markdownEscapable = /[\[\]()\\*_~`@#\-|:<>]/gu

/** Choose how Fluxer displays a timestamp in a message. The viewer's locale and timezone control its rendered text */
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

/** One Fluxer timestamp-markup display style */
export type TimestampStyle = (typeof TimestampStyles)[keyof typeof TimestampStyles]

/** The result of `format.parseMention`. Read `kind` to identify what was mentioned and `id` to get its decimal ID */
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

/** Custom-emoji fields used by Fluxer's explicit `<:name:id>` or `<a:name:id>` markup */
export interface CustomEmojiMarkup {
    /** ASCII letters, digits, underscores, or hyphens as accepted by Fluxer's message parser */
    readonly name: string
    /** Decimal Fluxer emoji ID */
    readonly id: string
    /** Selects `<a:...>` rather than `<:...>` */
    readonly animated?: boolean
}

/** One parsed timestamp markup value. `date` has whole-second precision because Fluxer markup has no milliseconds */
export interface TimestampMarkup {
    /** UTC instant represented by the markup */
    readonly date: Date
    /** Explicit style, or Fluxer's default short-date-time style when omitted in the markup */
    readonly style: TimestampStyle
}

/** The channel information needed to make a web link: Its `id` and, for a server channel, its `guildId`.
 * Supply a direct-message channel without `guildId`. Passing `guildId: null` is not the direct-message form
 */
export type ChannelLinkTarget = Pick<GuildChannel, "id" | "guildId"> | Pick<DirectMessageChannel, "id">

/** Optional raw permission bitfield requested by a hosted bot-installation page */
export interface InstallationLinkOptions {
    /** Unsigned 64-bit Fluxer permission bitfield. Omit it to leave the provider's requested permissions unspecified */
    readonly permissions?: bigint
}

/** A helper could not use its input. Default-API helpers return this in a Result, while native helpers fail with it when run.
 * Read `operation` and `reason` to identify the problem. The error does not store the rejected value
 */
export class HelperError extends Error {
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
            | "permissionBits.has"
            | "permissionBits.from"
            | "permissionBits.hasAll"
            | "permissionBits.hasAny"
            | "permissionBits.missing"
            | "permissionBits.inspect"
            | "permissionBits.toDecimal"
            | "colors.parse"
            | "colors.toHex"
            | "colors.toRgb"
            | "text.split"
            | "links.channel"
            | "links.message"
            | "links.installation",
        /** Invalid input category, without retaining the rejected value */
        readonly reason: "id" | "markup" | "time" | "permissionBits" | "link" | "color" | "text" | "limit",
    ) {
        super(`Invalid input for ${operation}`)
        this.name = this._tag
    }
}

/** A key of Permissions, such as `"ManageMessages"`, accepted by the named permissionBits helpers */
export type PermissionName = keyof typeof Permissions

/** Known permission names and any unnamed bits found by permissionBits.inspect.
 * This object and its names array are frozen. They do not decide what a user may do
 */
export interface PermissionBitInspection {
    /** Present known names in Permissions declaration order, not sorted by display label */
    readonly names: readonly PermissionName[]
    /** Present bits without a known name, preserved exactly rather than discarded */
    readonly unknownBits: bigint
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

const timestampStyleValues = new Set<string>(Object.values(TimestampStyles))

function helperError(operation: HelperError["operation"], reason: HelperError["reason"]): HelperError {
    return new HelperError(operation, reason)
}

function isSnowflake(value: unknown): value is string {
    if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return false
    try {
        return BigInt(value) <= largestSnowflake
    } catch {
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
    const permissions = permissionBits.toDecimal(input.permissions)
    return permissions.isOk() ? ok(permissions.value) : err(helperError("links.installation", "permissionBits"))
}

/**
 * Create or read Fluxer's special message text, such as mentions, timestamps and custom emoji.
 * Fallible methods return a Result immediately. Use `isOk()` before reading `value`, or `isErr()` before reading `error`.
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
export const format: Readonly<{
    /** Add backslashes so text is treated literally by Fluxer's markup parser, for example escaping `**bold**`.
     * Returns a string directly, not a Result. It does not change a message's `allowedMentions`
     */
    escapeMarkdown(value: string): string
    /** Create `<@id>` text for a user ID. Returns HelperError if the ID is not a valid decimal-string snowflake.
     * This does not look up the user or enable notifications when the text is sent
     */
    userMention(id: string): Result<string, HelperError>
    /** Create `<@&id>` text for a role ID. Invalid decimal-string IDs return HelperError.
     * Role members are not notified merely because this text appears in a message
     */
    roleMention(id: string): Result<string, HelperError>
    /** Create `<#id>` text linking to a channel. Invalid decimal-string IDs return HelperError, no channel lookup occurs */
    channelMention(id: string): Result<string, HelperError>
    /** Read a string containing exactly one user, role or channel mention into a frozen `{ kind, id }` object.
     * Both `<@id>` and `<@!id>` produce kind `"user"`. Surrounding text or malformed markup returns HelperError
     */
    parseMention(value: string): Result<Mention, HelperError>
    /** Create `<t:seconds:style>` message text from a Date, using ShortDateTime when style is omitted.
     * Milliseconds are dropped. The whole Unix second must be from 1 through 8_640_000_000_000.
     * Invalid Dates, earlier times or unsupported styles return HelperError. The input Date is not changed
     */
    timestamp(value: Date, style?: TimestampStyle): Result<string, HelperError>
    /** Read exactly one `<t:seconds:style>` or `<t:seconds>` string into a frozen object with a new Date and style.
     * A missing style becomes ShortDateTime. The Date has whole-second precision.
     * Malformed markup, nonpositive seconds or dates outside JavaScript's range return HelperError
     */
    parseTimestamp(value: string): Result<TimestampMarkup, HelperError>
    /** Create `<:name:id>` text, or `<a:name:id>` when animated is true. A GuildEmoji can be passed directly.
     * Invalid names, IDs or animation values return HelperError. This does not upload or look up an emoji
     */
    customEmoji(input: CustomEmojiMarkup): Result<string, HelperError>
    /** Read exactly one `<:name:id>` or `<a:name:id>` string into frozen emoji fields.
     * Malformed markup returns HelperError. This does not resolve shortcodes such as `:smile:` or Unicode emoji
     */
    parseCustomEmoji(value: string): Result<CustomEmojiMarkup, HelperError>
}> = Object.freeze({
    escapeMarkdown(value: string): string {
        return value.replace(markdownEscapable, "\\$&")
    },
    userMention(id: string): Result<string, HelperError> {
        return markupId(id, "format.userMention").map((value) => `<@${value}>`)
    },
    roleMention(id: string): Result<string, HelperError> {
        return markupId(id, "format.roleMention").map((value) => `<@&${value}>`)
    },
    channelMention(id: string): Result<string, HelperError> {
        return markupId(id, "format.channelMention").map((value) => `<#${value}>`)
    },
    parseMention(value: string): Result<Mention, HelperError> {
        if (typeof value !== "string") return err(helperError("format.parseMention", "markup"))
        const user = /^<@!?([0-9]+)>$/u.exec(value)
        const role = /^<@&([0-9]+)>$/u.exec(value)
        const channel = /^<#([0-9]+)>$/u.exec(value)
        if (user && isSnowflake(user[1])) return ok(Object.freeze({ kind: "user" as const, id: user[1] }))
        if (role && isSnowflake(role[1])) return ok(Object.freeze({ kind: "role" as const, id: role[1] }))
        if (channel && isSnowflake(channel[1])) return ok(Object.freeze({ kind: "channel" as const, id: channel[1] }))
        return err(helperError("format.parseMention", "markup"))
    },
    timestamp(value: Date, style: TimestampStyle = TimestampStyles.ShortDateTime): Result<string, HelperError> {
        const date = timestampDate(value, "format.timestamp")
        if (date.isErr()) return err(date.error)
        const resolvedStyle = timestampStyle(style, "format.timestamp")
        if (resolvedStyle.isErr()) return err(resolvedStyle.error)
        const seconds = Math.floor(date.value.getTime() / 1_000)
        if (seconds <= 0 || seconds > largestTimestampSeconds) return err(helperError("format.timestamp", "time"))
        return ok(`<t:${seconds}:${resolvedStyle.value}>`)
    },
    parseTimestamp(value: string): Result<TimestampMarkup, HelperError> {
        if (typeof value !== "string") return err(helperError("format.parseTimestamp", "markup"))
        const match = /^<t:([0-9]+)(?::([tTdDfFsSR]))?>$/u.exec(value)
        if (!match) return err(helperError("format.parseTimestamp", "markup"))
        const seconds = Number(match[1])
        if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > largestTimestampSeconds)
            return err(helperError("format.parseTimestamp", "time"))
        const style = (match[2] ?? TimestampStyles.ShortDateTime) as TimestampStyle
        return ok(Object.freeze({ date: new Date(seconds * 1_000), style }))
    },
    customEmoji(input: CustomEmojiMarkup): Result<string, HelperError> {
        return customEmoji(input, "format.customEmoji").map(
            (value) => `<${value.animated === true ? "a" : ""}:${value.name}:${value.id}>`,
        )
    },
    parseCustomEmoji(value: string): Result<CustomEmojiMarkup, HelperError> {
        if (typeof value !== "string") return err(helperError("format.parseCustomEmoji", "markup"))
        const match = /^<(a?):([A-Za-z0-9_-]+):([0-9]+)>$/u.exec(value)
        if (!match) return err(helperError("format.parseCustomEmoji", "markup"))
        return customEmoji(
            { name: match[2]!, id: match[3]!, ...(match[1] === "a" ? { animated: true } : {}) },
            "format.parseCustomEmoji",
        )
    },
})

/** Inspect Fluxer IDs, called snowflakes, or make time-based pagination boundaries.
 * IDs stay decimal strings or bigint because JavaScript numbers cannot represent every 64-bit ID exactly
 */
export const snowflakes: Readonly<{
    /** Return true for a decimal string from `"0"` through `"9223372036854775807"`, with no extra leading zeroes.
     * Returns false for numbers, whitespace and invalid strings rather than returning an error
     */
    isValid(value: unknown): value is string
    /** Convert a valid decimal-string ID to bigint without losing precision. An invalid ID returns HelperError */
    parse(value: string): Result<bigint, HelperError>
    /** Return a new Date for the creation time encoded in an ID. An invalid ID returns HelperError.
     * This decodes the ID's high timestamp bits relative to 2015-01-01 UTC, it does not fetch the resource or prove it is visible
     */
    createdAt(value: string): Result<Date, HelperError>
    /** Make the smallest ID for a Date's exact millisecond, useful as a time-based pagination boundary.
     * Returns HelperError for an invalid Date, a date before 2015-01-01 UTC or a result outside the ID range.
     * This does not create a resource. Whether the boundary is included depends on the endpoint using it
     */
    boundary(value: Date): Result<string, HelperError>
}> = Object.freeze({
    isValid(value: unknown): value is string {
        return isSnowflake(value)
    },
    parse(value: string): Result<bigint, HelperError> {
        return snowflake(value, "snowflakes.parse")
    },
    createdAt(value: string): Result<Date, HelperError> {
        return snowflake(value, "snowflakes.createdAt").map(
            (id) => new Date(Number((id >> snowflakeTimestampShift) + snowflakeEpochMs)),
        )
    },
    boundary(value: Date): Result<string, HelperError> {
        const date = timestampDate(value, "snowflakes.boundary")
        if (date.isErr()) return err(date.error)
        const unixMs = BigInt(date.value.getTime())
        if (unixMs < snowflakeEpochMs) return err(helperError("snowflakes.boundary", "time"))
        const boundary = (unixMs - snowflakeEpochMs) << snowflakeTimestampShift
        return boundary <= largestSnowflake ? ok(boundary.toString()) : err(helperError("snowflakes.boundary", "time"))
    },
})

/** Choose a name to show from user and optional server-member information already held by the application */
export const display: Readonly<{
    /** Return the member's nickname, otherwise the user's displayName, otherwise username.
     * Only null or undefined trigger a fallback. Supply a member for the same user, this helper does not check identity or fetch data
     */
    name(user: Pick<User, "username" | "displayName">, member?: Pick<GuildMember, "nickname">): string
}> = Object.freeze({
    name(user: Pick<User, "username" | "displayName">, member?: Pick<GuildMember, "nickname">): string {
        return member?.nickname ?? user.displayName ?? user.username
    },
})

/** Work with sets of named permissions stored in a bigint bitfield, without writing bitwise expressions yourself.
 * Each method returns a Result. Invalid names or values outside unsigned 64-bit bigint range return HelperError.
 * These inspect stored flags only, they do not expand Administrator, apply channel overrides or decide whether an action is allowed
 */
export const permissionBits: Readonly<{
    /** Combine names such as `["ManageMessages", "ManageRoles"]` into one bigint permission set.
     * An empty array gives 0n, duplicates have no extra effect. An unknown name returns HelperError
     */
    from(names: readonly PermissionName[]): Result<bigint, HelperError>
    /** Return whether bits contains one named permission. Invalid bigint values or an unknown permission name return HelperError */
    has(bits: bigint, permission: PermissionName): Result<boolean, HelperError>
    /** Return true if bits contains every requested permission, including true for an empty names array.
     * Validates every name even if a permission is missing. Invalid bits or unknown names return HelperError
     */
    hasAll(bits: bigint, names: readonly PermissionName[]): Result<boolean, HelperError>
    /** Return true if bits contains at least one requested permission, or false for an empty names array.
     * Validates every name even after finding a match. Invalid bits or unknown names return HelperError
     */
    hasAny(bits: bigint, names: readonly PermissionName[]): Result<boolean, HelperError>
    /** List requested permissions absent from bits, in the order first requested and without duplicates.
     * Returns a frozen array, empty if nothing is missing. Invalid bits or unknown names return HelperError, input arrays are not changed
     */
    missing(bits: bigint, names: readonly PermissionName[]): Result<readonly PermissionName[], HelperError>
    /** Return a frozen object listing present known names and any remaining flags as unknownBits.
     * Names follow Permissions declaration order. Unknown flags are preserved, Administrator does not add other names.
     * Invalid bits return HelperError
     */
    inspect(bits: bigint): Result<PermissionBitInspection, HelperError>
    /** Convert bigint permission bits to a decimal string for JSON or a URL. Invalid unsigned-64-bit bigint values return HelperError */
    toDecimal(bits: bigint): Result<string, HelperError>
}> = Object.freeze({
    from(names: readonly PermissionName[]): Result<bigint, HelperError> {
        return namedPermissions(names, "permissionBits.from")
    },
    has(bits: bigint, permission: PermissionName): Result<boolean, HelperError> {
        if (typeof bits !== "bigint" || bits < 0n || bits > largestPermissionBits)
            return err(helperError("permissionBits.has", "permissionBits"))
        if (typeof permission !== "string" || !Object.hasOwn(Permissions, permission))
            return err(helperError("permissionBits.has", "permissionBits"))
        const flag = Permissions[permission as PermissionName]
        return ok((bits & flag) === flag)
    },
    hasAll(bits: bigint, names: readonly PermissionName[]): Result<boolean, HelperError> {
        if (!validPermissionBits(bits)) return err(helperError("permissionBits.hasAll", "permissionBits"))
        return namedPermissions(names, "permissionBits.hasAll").map((required) => (bits & required) === required)
    },
    hasAny(bits: bigint, names: readonly PermissionName[]): Result<boolean, HelperError> {
        if (!validPermissionBits(bits)) return err(helperError("permissionBits.hasAny", "permissionBits"))
        return namedPermissions(names, "permissionBits.hasAny").map((required) => (bits & required) !== 0n)
    },
    missing(bits: bigint, names: readonly PermissionName[]): Result<readonly PermissionName[], HelperError> {
        if (!validPermissionBits(bits)) return err(helperError("permissionBits.missing", "permissionBits"))
        const required = namedPermissions(names, "permissionBits.missing")
        if (required.isErr()) return err(required.error)
        return ok(Object.freeze([...new Set(names)].filter((name) => (bits & Permissions[name]) !== Permissions[name])))
    },
    inspect(bits: bigint): Result<PermissionBitInspection, HelperError> {
        if (!validPermissionBits(bits)) return err(helperError("permissionBits.inspect", "permissionBits"))
        return ok(
            Object.freeze({
                names: Object.freeze(
                    permissionNames.filter((name) => (bits & Permissions[name]) === Permissions[name]),
                ),
                unknownBits: bits & (largestPermissionBits ^ knownPermissionBits),
            }),
        )
    },
    toDecimal(bits: bigint): Result<string, HelperError> {
        return typeof bits === "bigint" && bits >= 0n && bits <= largestPermissionBits
            ? ok(bits.toString())
            : err(helperError("permissionBits.toDecimal", "permissionBits"))
    },
})

/** Make URLs for opening channels, messages or bot installation in the hosted Fluxer app.
 * Each method returns a Result containing the URL or HelperError for invalid input. No browser is opened and no access or existence check is made
 */
export const links: Readonly<{
    /** Build a hosted guild-channel or direct-message route. DirectMessageChannel inputs use Fluxer's `/channels/@me/:channelId` route */
    channel(target: ChannelLinkTarget): Result<string, HelperError>
    /** Build a hosted message route in the supplied actual guild-channel or direct-message context. It does not infer private versus guild context from the message alone */
    message(message: MessageReference, channel: ChannelLinkTarget): Result<string, HelperError>
    /** Build a URL for Fluxer's hosted bot-installation page with the fixed `bot` scope and optional unsigned-64-bit permissions.
     * This does not open the page, authorize installation or check whether the application exists.
     * An alternate origin or scope is not accepted
     */
    installation(applicationId: string, options?: InstallationLinkOptions): Result<string, HelperError>
}> = Object.freeze({
    channel(target: ChannelLinkTarget): Result<string, HelperError> {
        return channelLink(target, "links.channel").map(({ id, guildId }) =>
            guildId === null ? `https://fluxer.app/channels/@me/${id}` : `https://fluxer.app/channels/${guildId}/${id}`,
        )
    },
    message(message: MessageReference, channel: ChannelLinkTarget): Result<string, HelperError> {
        const resolvedChannel = channelLink(channel, "links.message")
        if (resolvedChannel.isErr()) return err(resolvedChannel.error)
        const id = markupId(message?.id, "links.message")
        if (id.isErr() || message?.channelId !== resolvedChannel.value.id)
            return err(helperError("links.message", "link"))
        return ok(
            resolvedChannel.value.guildId === null
                ? `https://fluxer.app/channels/@me/${resolvedChannel.value.id}/${id.value}`
                : `https://fluxer.app/channels/${resolvedChannel.value.guildId}/${resolvedChannel.value.id}/${id.value}`,
        )
    },
    installation(applicationId: string, options?: InstallationLinkOptions): Result<string, HelperError> {
        const id = markupId(applicationId, "links.installation")
        if (id.isErr()) return err(id.error)
        const permissions = installationPermissions(options)
        if (permissions.isErr()) return err(permissions.error)
        const query = new URLSearchParams({ client_id: id.value, scope: "bot" })
        if (permissions.value !== undefined) query.set("permissions", permissions.value)
        return ok(`https://fluxer.app/oauth2/authorize?${query}`)
    },
})

/**
 * Make channel, message and installation URLs for a validated instance web-app base
 *
 * The hosted `links` export is unchanged.
 * This factory keeps its local input checks and replaces only the hosted application base in successful URLs.
 * No network request occurs
 */
export function createInstanceLinks(webapp: string): typeof links {
    const project = (value: Result<string, HelperError>): Result<string, HelperError> =>
        value.map((url) => `${webapp}${url.slice("https://fluxer.app".length)}`)
    return Object.freeze({
        channel: (...input: Parameters<typeof links.channel>) => project(links.channel(...input)),
        message: (...input: Parameters<typeof links.message>) => project(links.message(...input)),
        installation: (...input: Parameters<typeof links.installation>) => project(links.installation(...input)),
    })
}
