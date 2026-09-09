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

/** Named display styles accepted by Fluxer's timestamp markup */
export const TimestampStyles = Object.freeze({
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

/** One parsed user, role, or channel mention. `userMention` always formats the canonical non-nickname user form */
export type Mention =
    | { readonly kind: "user"; readonly id: string }
    | { readonly kind: "role"; readonly id: string }
    | { readonly kind: "channel"; readonly id: string }

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

/** Exact route context for a hosted channel or message link. Guild channels carry `guildId`; direct messages do not */
export type ChannelLinkTarget = Pick<GuildChannel, "id" | "guildId"> | Pick<DirectMessageChannel, "id">

/** Locally invalid pure-helper input, without retaining or exposing the rejected value */
export class HelperError extends Error {
    /** Stable expected-failure discriminator */
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
            | "permissionBits.toDecimal"
            | "links.channel"
            | "links.message",
        /** Whether the ID, markup, time, bitfield, or route context was invalid */
        readonly reason: "id" | "markup" | "time" | "permissionBits" | "link",
    ) {
        super(`Invalid input for ${operation}`)
        this.name = this._tag
    }
}

/** One known Fluxer permission name, mapped to the raw unsigned-64-bit `Permissions` constant */
export type PermissionName = keyof typeof Permissions

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

/**
 * Pure Fluxer message-markup helpers. Formatting a mention only creates text; it cannot enable notifications.
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
export const format = Object.freeze({
    /** Escape every character that Fluxer's current markup parser accepts after a backslash. This is text-only and never changes allowed mentions */
    escapeMarkdown(value: string): string {
        return value.replace(markdownEscapable, "\\$&")
    },
    /** Format one canonical user mention after validating its decimal snowflake ID. The output alone cannot notify anyone */
    userMention(id: string): Result<string, HelperError> {
        return markupId(id, "format.userMention").map((value) => `<@${value}>`)
    },
    /** Format one canonical role mention after validating its decimal snowflake ID. The output alone cannot notify role members */
    roleMention(id: string): Result<string, HelperError> {
        return markupId(id, "format.roleMention").map((value) => `<@&${value}>`)
    },
    /** Format one canonical channel mention after validating its decimal snowflake ID. It performs no channel lookup */
    channelMention(id: string): Result<string, HelperError> {
        return markupId(id, "format.channelMention").map((value) => `<#${value}>`)
    },
    /** Parse one complete Fluxer user, role, or channel mention. User nickname syntax `<@!id>` parses as the same user ID */
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
    /** Format a Date whose whole Unix second is from 1 through 8_640_000_000_000. Milliseconds are truncated; invalid Dates or nonpositive seconds fail */
    timestamp(value: Date, style: TimestampStyle = TimestampStyles.ShortDateTime): Result<string, HelperError> {
        const date = timestampDate(value, "format.timestamp")
        if (date.isErr()) return err(date.error)
        const resolvedStyle = timestampStyle(style, "format.timestamp")
        if (resolvedStyle.isErr()) return err(resolvedStyle.error)
        const seconds = Math.floor(date.value.getTime() / 1_000)
        if (seconds <= 0 || seconds > largestTimestampSeconds) return err(helperError("format.timestamp", "time"))
        return ok(`<t:${seconds}:${resolvedStyle.value}>`)
    },
    /** Parse complete timestamp markup into a new whole-second UTC Date. Nonpositive seconds and values beyond JavaScript's representable Date range fail */
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
    /** Format one explicit custom emoji. A GuildEmoji snapshot can be supplied directly because it has the required fields */
    customEmoji(input: CustomEmojiMarkup): Result<string, HelperError> {
        return customEmoji(input, "format.customEmoji").map(
            (value) => `<${value.animated === true ? "a" : ""}:${value.name}:${value.id}>`,
        )
    },
    /** Parse one complete explicit custom-emoji markup value. Unicode emoji and shortcode lookup remain outside this helper */
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

/** Pure decimal-string Fluxer snowflake helpers. They use bigint internally and never convert an ID through JavaScript Number */
export const snowflakes = Object.freeze({
    /** Check whether a value is Fluxer's canonical decimal-string snowflake form in the signed 64-bit provider range */
    isValid(value: unknown): value is string {
        return isSnowflake(value)
    },
    /** Parse one canonical decimal snowflake as bigint without Number precision loss */
    parse(value: string): Result<bigint, HelperError> {
        return snowflake(value, "snowflakes.parse")
    },
    /** Extract a snowflake's UTC creation time from its high 41 timestamp bits. The timestamp can precede resource visibility */
    createdAt(value: string): Result<Date, HelperError> {
        return snowflake(value, "snowflakes.createdAt").map(
            (id) => new Date(Number((id >> snowflakeTimestampShift) + snowflakeEpochMs)),
        )
    },
    /** Build the smallest decimal snowflake at a UTC millisecond for an exclusive or inclusive endpoint-specific cursor boundary */
    boundary(value: Date): Result<string, HelperError> {
        const date = timestampDate(value, "snowflakes.boundary")
        if (date.isErr()) return err(date.error)
        const unixMs = BigInt(date.value.getTime())
        if (unixMs < snowflakeEpochMs) return err(helperError("snowflakes.boundary", "time"))
        const boundary = (unixMs - snowflakeEpochMs) << snowflakeTimestampShift
        return boundary <= largestSnowflake ? ok(boundary.toString()) : err(helperError("snowflakes.boundary", "time"))
    },
})

/** Pure display-name fallback for a public user and an optional matching guild-member observation */
export const display = Object.freeze({
    /** Prefer a supplied guild nickname, then the user's global display name, then username. No membership, user, or cache lookup occurs */
    name(user: Pick<User, "username" | "displayName">, member?: Pick<GuildMember, "nickname">): string {
        return member?.nickname ?? user.displayName ?? user.username
    },
})

/** Pure named permission-bit membership and wire-serialization helpers. They do not calculate effective permissions or authorise an action */
export const permissionBits = Object.freeze({
    /** Check whether one named Fluxer permission is present in a valid unsigned-64-bit raw bitfield */
    has(bits: bigint, permission: PermissionName): Result<boolean, HelperError> {
        if (typeof bits !== "bigint" || bits < 0n || bits > largestPermissionBits)
            return err(helperError("permissionBits.has", "permissionBits"))
        if (typeof permission !== "string" || !Object.hasOwn(Permissions, permission))
            return err(helperError("permissionBits.has", "permissionBits"))
        const flag = Permissions[permission as PermissionName]
        return ok((bits & flag) === flag)
    },
    /** Serialize one valid unsigned-64-bit raw bitfield as Fluxer's canonical decimal JSON/path value */
    toDecimal(bits: bigint): Result<string, HelperError> {
        return typeof bits === "bigint" && bits >= 0n && bits <= largestPermissionBits
            ? ok(bits.toString())
            : err(helperError("permissionBits.toDecimal", "permissionBits"))
    },
})

/** Hosted Fluxer application links. They use the verified app routes, not the REST API endpoint, and never check access or resource existence */
export const links = Object.freeze({
    /** Build a hosted guild-channel or direct-message route. DirectMessageChannel inputs use Fluxer's `/channels/@me/:channelId` route */
    channel(target: ChannelLinkTarget): Result<string, HelperError> {
        return channelLink(target, "links.channel").map(({ id, guildId }) =>
            guildId === null ? `https://fluxer.app/channels/@me/${id}` : `https://fluxer.app/channels/${guildId}/${id}`,
        )
    },
    /** Build a hosted message route in the supplied actual guild-channel or direct-message context. It does not infer private versus guild context from the message alone */
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
})
