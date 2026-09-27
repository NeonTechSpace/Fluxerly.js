import type { Result } from "neverthrow"
import { assets as sharedAssets, type AssetHelpers } from "#sdk/assets"
import { colors as sharedColors, type ColorInput, type RgbColor } from "#sdk/colors"
import { text as sharedText, type TextHelpers } from "#sdk/text"
import {
    display as sharedDisplay,
    format as sharedFormat,
    links as sharedLinks,
    permissionBits as sharedPermissionBits,
    snowflakes as sharedSnowflakes,
    type CustomEmojiMarkup,
    type DisplayHelpers,
    type HelperError,
    type LinkHelpers,
    type Mention,
    type PermissionBitHelpers,
    type TimestampMarkup,
    type TimestampStyle,
} from "#sdk/helpers"
import * as Effect from "effect/Effect"

export type { AssetHelpers, LinkHelpers, PermissionBitHelpers, TextHelpers }

/** Run a try-helper when the Effect executes, moving its Err into the typed error channel */
function resultEffect<A>(create: () => Result<A, HelperError>): Effect.Effect<A, HelperError> {
    return Effect.suspend(() => {
        const result = create()
        return result.isOk() ? Effect.succeed(result.value) : Effect.fail(result.error)
    })
}

/**
 * Methods of the native format helper, which creates and reads mention, timestamp and custom-emoji markup and escapes Markdown.
 * Most methods return plain values and throw HelperError for invalid input, and such a throw inside Effect code becomes a defect.
 * The try-prefixed parsers accept untrusted text and return Effects that fail with HelperError in the error channel
 *
 * @category Builders and formatting
 */
export type FormatHelpers = Readonly<{
    /**
     * Add backslashes so text is treated literally by Fluxer's markup parser, for example escaping `**bold**`.
     * Returns the escaped string immediately and never throws for string input.
     * It does not change a message's `allowedMentions` or enable notifications
     */
    escapeMarkdown: (value: string) => string
    /**
     * Create `<@id>` text for a decimal user ID, such as `<@123>`, and return it directly.
     * Throws HelperError when the ID is not a valid decimal-string snowflake.
     * This does not look up the user, and allowedMentions must be set separately to request a notification
     */
    userMention: (id: string) => string
    /**
     * Create `<@&id>` text for a decimal role ID, such as `<@&123>`, and return it directly.
     * Throws HelperError for an invalid ID.
     * Role members are not notified merely because this text appears in a message, and allowedMentions must be set separately
     */
    roleMention: (id: string) => string
    /**
     * Create `<#id>` text linking to a channel, such as `<#123>`, and return it directly.
     * Throws HelperError for an invalid decimal-string ID, and no channel lookup occurs
     */
    channelMention: (id: string) => string
    /**
     * Read a string containing exactly one user, role or channel mention into a frozen `{ kind, id }` object.
     * Both `<@id>` and `<@!id>` produce kind `"user"`.
     * Throws HelperError for surrounding text, malformed markup or an invalid decimal ID.
     * For text received from users, use tryParseMention, which reports the same HelperError without throwing
     */
    parseMention: (value: string) => Mention
    /**
     * Read a mention with the same rules as parseMention, but report invalid text without throwing.
     * The default API returns a Result holding the frozen `{ kind, id }` object or HelperError.
     * The native API returns an Effect that reads the text when run and fails with HelperError.
     * Use it for text received from users or other untrusted sources
     */
    tryParseMention: (value: string) => Effect.Effect<Mention, HelperError, never>
    /**
     * Create `<t:seconds:style>` message text from a Date, which Fluxer displays in the reader's local time.
     * The style defaults to ShortDateTime, and milliseconds are dropped.
     * The whole Unix second must be from 1 through 8_640_000_000_000.
     * Throws HelperError for an invalid Date, a time outside that range or an unsupported style.
     * The input Date is not changed
     */
    timestamp: (value: Date, style?: TimestampStyle) => string
    /**
     * Read exactly one `<t:seconds:style>` or `<t:seconds>` string into a frozen object with a new Date and style.
     * A missing style becomes ShortDateTime.
     * The Date has whole-second precision.
     * Throws HelperError for malformed markup, nonpositive seconds or dates outside JavaScript's range.
     * For text received from users, use tryParseTimestamp, which reports the same HelperError without throwing
     */
    parseTimestamp: (value: string) => TimestampMarkup
    /**
     * Read timestamp markup with the same rules as parseTimestamp, but report invalid text without throwing.
     * The default API returns a Result holding the frozen date and style or HelperError.
     * The native API returns an Effect that reads the text when run and fails with HelperError.
     * Use it for text received from users or other untrusted sources
     */
    tryParseTimestamp: (value: string) => Effect.Effect<TimestampMarkup, HelperError, never>
    /**
     * Create `<:name:id>` text, or `<a:name:id>` when animated is true.
     * A GuildEmoji can be passed directly.
     * Throws HelperError for invalid names, IDs or animation values.
     * This does not upload or look up an emoji
     */
    customEmoji: (input: CustomEmojiMarkup) => string
    /**
     * Read exactly one `<:name:id>` or `<a:name:id>` string into frozen name, ID and animated fields.
     * Throws HelperError for malformed markup.
     * This does not resolve shortcodes such as `:smile:` or parse Unicode emoji.
     * For text received from users, use tryParseCustomEmoji, which reports the same HelperError without throwing
     */
    parseCustomEmoji: (value: string) => CustomEmojiMarkup
    /**
     * Read custom-emoji markup with the same rules as parseCustomEmoji, but report invalid text without throwing.
     * The default API returns a Result holding the frozen name, ID and animated fields or HelperError.
     * The native API returns an Effect that reads the text when run and fails with HelperError.
     * Use it for text received from users or other untrusted sources
     */
    tryParseCustomEmoji: (value: string) => Effect.Effect<CustomEmojiMarkup, HelperError, never>
}>

/**
 * Create and read Fluxer mention, timestamp and custom-emoji markup without a client or network requests.
 * Most methods return plain values immediately, the same as in the default API, and throw HelperError for invalid input.
 * Inside Effect code such a throw becomes a defect rather than a typed failure, because invalid input is a programming mistake.
 * For text received from users, tryParseMention, tryParseTimestamp and tryParseCustomEmoji return Effects that read the text when run and fail with HelperError.
 * Mention markup alone does not enable notifications
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { format, links, type GuildChannel } from "@neontechspace/fluxerly/effect"
 *
 * export const helpersEffectExample = (userId: string, messageId: string, channel: GuildChannel, userText: string) =>
 *     Effect.gen(function* () {
 *         const mentioned = yield* format.tryParseMention(userText)
 *         return {
 *             escaped: format.escapeMarkdown("@everyone: **literal**"),
 *             mention: format.userMention(userId),
 *             message: links.message({ id: messageId, channelId: channel.id }, channel),
 *             mentionedId: mentioned.id,
 *         }
 *     })
 * ```
 *
 * @category Builders and formatting
 */
export const format: FormatHelpers = Object.freeze({
    escapeMarkdown: sharedFormat.escapeMarkdown,
    userMention: sharedFormat.userMention,
    roleMention: sharedFormat.roleMention,
    channelMention: sharedFormat.channelMention,
    parseMention: sharedFormat.parseMention,
    tryParseMention: (value: string) => resultEffect(() => sharedFormat.tryParseMention(value)),
    timestamp: sharedFormat.timestamp,
    parseTimestamp: sharedFormat.parseTimestamp,
    tryParseTimestamp: (value: string) => resultEffect(() => sharedFormat.tryParseTimestamp(value)),
    customEmoji: sharedFormat.customEmoji,
    parseCustomEmoji: sharedFormat.parseCustomEmoji,
    tryParseCustomEmoji: (value: string) => resultEffect(() => sharedFormat.tryParseCustomEmoji(value)),
})

/**
 * Methods of the native snowflakes helper, which reads and converts decimal Fluxer IDs without losing precision.
 * Conversions return plain values and throw HelperError for invalid input, and such a throw inside Effect code becomes a defect.
 * The tryParse method returns an Effect that fails with HelperError in the error channel
 *
 * @category Builders and formatting
 */
export type SnowflakeHelpers = Readonly<{
    /**
     * Return true for a decimal string from `"0"` through `"9223372036854775807"`, with no extra leading zeroes.
     * Returns false immediately for numbers, whitespace and invalid strings, without converting through Number or failing
     */
    isValid: (value: unknown) => value is string
    /**
     * Convert a valid decimal-string ID to bigint without losing precision.
     * Throws HelperError for an invalid ID.
     * For IDs received from users, use tryParse, which reports the same HelperError without throwing
     */
    parse: (value: string) => bigint
    /**
     * Convert a decimal-string ID with the same rules as parse, but report an invalid ID without throwing.
     * The default API returns a Result holding the bigint or HelperError.
     * The native API returns an Effect that reads the ID when run and fails with HelperError.
     * Use it for IDs received from users or other untrusted sources
     */
    tryParse: (value: string) => Effect.Effect<bigint, HelperError, never>
    /**
     * Return a new UTC Date for the creation time encoded in an ID.
     * Throws HelperError for an invalid ID.
     * This decodes the ID's high 41 timestamp bits relative to 2015-01-01 UTC, and does not fetch the resource or prove it is visible
     */
    createdAt: (value: string) => Date
    /**
     * Make the smallest ID for a Date's exact UTC millisecond, useful as a time-based pagination boundary.
     * Throws HelperError for an invalid Date, a date before 2015-01-01 UTC or a result outside the ID range.
     * This does not create a resource.
     * Whether the boundary is included depends on the endpoint using it
     */
    boundary: (value: Date) => string
    /**
     * Return the shard that receives a community's gateway events when the bot runs totalShards shards.
     * Fluxer calls a community a guild, so the first argument is a guild ID.
     * Fluxer routes each community with (guildId >> 22) % totalShards, and this helper applies the same formula.
     * Use it to find which process owns a community when shards run in several processes.
     * Throws HelperError for an invalid ID or a totalShards outside 1 through 16,384.
     * It does not check whether the bot belongs to that community
     */
    shardFor: (guildId: string, totalShards: number) => number
}>

/** Validate Fluxer IDs, read their creation time or create pagination boundaries.
 * A snowflake is Fluxer's time-based decimal-string ID. Conversions use bigint to avoid Number precision loss.
 * They return plain values and throw HelperError for invalid input, which becomes a defect inside Effect code.
 * For IDs received from users, tryParse returns an Effect that fails with HelperError instead
 *
 * @category Builders and formatting
 */
export const snowflakes: SnowflakeHelpers = Object.freeze({
    isValid: sharedSnowflakes.isValid,
    parse: sharedSnowflakes.parse,
    tryParse: (value: string) => resultEffect(() => sharedSnowflakes.tryParse(value)),
    createdAt: sharedSnowflakes.createdAt,
    boundary: sharedSnowflakes.boundary,
    shardFor: sharedSnowflakes.shardFor,
})

/** Choose a display name from user data and an optional community member, without a request or cache lookup.
 * The display.name helper prefers the member nickname, then the user's displayName, then username.
 * Only null or undefined trigger a fallback.
 * Supply a member belonging to the same user, because this helper does not check identity
 *
 * @category Builders and formatting
 */
export const display: DisplayHelpers = sharedDisplay

/** Build and inspect permission bitfields from named Fluxer permissions.
 * A bitfield stores permission flags in a bigint. Methods return plain values immediately, the same as in the default API, without fetching resources or deciding whether an action is allowed.
 * Unknown names or bits outside the unsigned 64-bit range throw HelperError, and such a throw inside Effect code becomes a defect
 *
 * @category Roles and permissions
 */
export const permissionBits: PermissionBitHelpers = sharedPermissionBits

/**
 * Methods of the native colors helper, which converts RGB numbers, hex strings and tuples.
 * Most methods return plain values and throw HelperError for invalid input, and such a throw inside Effect code becomes a defect.
 * The tryParse method returns an Effect that fails with HelperError in the error channel
 *
 * @category Builders and formatting
 */
export type ColorHelpers = Readonly<{
    /**
     * Convert a six-digit hexadecimal string, an RGB array of three integer channels from 0 through 255, or a color number to the integer used by embeds and roles.
     * The leading `#` is optional.
     * CSS names, three-digit shorthand, alpha channels and surrounding whitespace are rejected.
     * Values are never rounded or clamped, and invalid input throws HelperError.
     * For colors received from users, use tryParse, which reports the same HelperError without throwing
     */
    parse: (value: ColorInput) => number
    /**
     * Convert a color with the same rules as parse, but report invalid input without throwing.
     * The default API returns a Result holding the color integer or HelperError.
     * The native API returns an Effect that reads the input when run and fails with HelperError.
     * Use it for colors received from users or other untrusted sources
     */
    tryParse: (value: ColorInput) => Effect.Effect<number, HelperError, never>
    /**
     * Turn a color integer into a lowercase six-digit string such as `"#000001"`, including leading zeroes.
     * Accepts only integers from 0 through 0xffffff, not the strings or arrays accepted by `parse`.
     * Throws HelperError for invalid numbers
     */
    toHex: (value: number) => string
    /**
     * Split a color integer into a new frozen `[red, green, blue]` array, each from 0 through 255.
     * Accepts only integers from 0 through 0xffffff.
     * Throws HelperError for invalid numbers
     */
    toRgb: (value: number) => RgbColor
}>

/** Convert RGB colors between integers, hex strings and channel tuples.
 * Methods return plain values immediately. Invalid values throw HelperError instead of being coerced or clamped, and CSS color names are not accepted.
 * Such a throw inside Effect code becomes a defect. For colors received from users, tryParse returns an Effect that fails with HelperError instead
 *
 * @category Builders and formatting
 */
export const colors: ColorHelpers = Object.freeze({
    parse: sharedColors.parse,
    tryParse: (value: ColorInput) => resultEffect(() => sharedColors.tryParse(value)),
    toHex: sharedColors.toHex,
    toRgb: sharedColors.toRgb,
})

/**
 * Split long text into length-bounded pieces without losing its contents.
 * The caller chooses the length limit, how to send the pieces and any Markdown handling.
 * The split method returns the pieces directly, without sending them.
 * Invalid text or options throw HelperError, and such a throw inside Effect code becomes a defect
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { permissionBits, colors, text } from "@neontechspace/fluxerly/effect"
 *
 * export function pureHelpersExample(bits: bigint, content: string, colorText: string) {
 *     return Effect.gen(function* () {
 *         const color = yield* colors.tryParse(colorText)
 *         return {
 *             required: permissionBits.from(["ManageRoles", "ManageMessages"]),
 *             missing: permissionBits.missing(bits, ["ManageRoles", "ManageMessages"]),
 *             inspection: permissionBits.inspect(bits),
 *             color,
 *             chunks: text.split(content, { maxLength: 2_000 }),
 *         }
 *     })
 * }
 * ```
 *
 * @category Builders and formatting
 */
export const text: TextHelpers = sharedText

/** Build hosted Fluxer channel, message and bot-installation links from supplied IDs.
 * Methods return URLs immediately, the same as in the default API, and throw HelperError for invalid input.
 * Such a throw inside Effect code becomes a defect. Building a link does not visit it or check access
 *
 * @category Builders and formatting
 */
export const links: LinkHelpers = sharedLinks

/**
 * Build image URLs for hosted Fluxer from supplied user, member, community, emoji or sticker data.
 * Methods return URLs immediately, the same as in the default API, and use fixed hosted addresses. Use client.instance.resolve for URLs on a selected self-hosted instance.
 * Invalid targets, IDs, hashes or options throw AssetUrlError, and such a throw inside Effect code becomes a defect.
 * Image format defaults to WebP. Omit size to leave pixel size selection to Fluxer.
 * Options are validated even when the supplied asset is absent.
 * These helpers do not fetch profiles, change caches, download bytes, refresh URLs or change attachment or embed URLs.
 * Custom base addresses are not accepted by this hosted namespace.
 * Omitted optional asset hashes become `undefined`. Known absent hashes become `null`. A returned URL does not prove the asset exists
 *
 * @example
 * ```ts
 * import { assets, AssetFormats, type Guild, type GuildEmoji, type GuildMember, type User, type UserProfile } from "@neontechspace/fluxerly/effect"
 *
 * export const assetsEffectExample = (user: Pick<User, "id" | "avatar">, member: Pick<GuildMember, "guildId" | "userId" | "avatar" | "profileFlags">, guild: Pick<Guild, "id" | "icon">, emoji: Pick<GuildEmoji, "id" | "animated">, profile: UserProfile) => ({
 *     avatar: assets.displayAvatar(user, { size: 256, format: AssetFormats.Webp }),
 *     memberAvatar: assets.displayMemberAvatar(user, member, { size: 256 }),
 *     icon: assets.guildIcon(guild, { format: AssetFormats.Png }),
 *     emojiUrl: assets.emoji(emoji, { animated: emoji.animated }),
 *     banner: assets.userBanner(profile),
 * })
 * ```
 *
 * @category Builders and formatting
 */
export const assets: AssetHelpers = sharedAssets
