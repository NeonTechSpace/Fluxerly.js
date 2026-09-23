/**
 * Build Fluxer bots, send webhook messages and use OAuth with Effect.
 * Use this entry point in applications that already use Effect
 *
 * @remarks
 * An Effect is a description of work, not a Promise that has already started.
 * Calling an SDK method usually builds that description without making a request.
 * Inside Effect.gen, `yield*` executes a description and returns its successful result.
 * Effect.runPromise executes a complete program and returns a JavaScript Promise.
 * Executing the same description again repeats its work, including remote writes
 *
 * `Effect.Effect<A, E, R>` describes a successful value A, expected errors E and required services R.
 * Expected errors, such as invalid input or an HTTP rejection, use Effect's error channel.
 * Defects are unexpected faults, such as a throwing property getter or failed cleanup.
 * Interruption is Effect's cancellation mechanism.
 * Cause can represent errors, defects and interruption together.
 * Cancellation waits for SDK-owned cleanup, but cannot undo a request already sent to Fluxer
 *
 * Scope is the cleanup lifetime required by client creation, subscriptions and collectors.
 * Wrap a program in Effect.scoped to provide that lifetime and close its resources when the program ends.
 * Keep a client and its listeners inside their scopes rather than returning handles after their scopes close.
 * Other required services come from the caller's Effect program, including services used by handlers
 *
 * REST means the HTTP API used to read or change resources.
 * HTTP 204 is success with no returned value.
 * Role hierarchy is the ordering that limits which members and roles a bot can manage.
 * MFA means the provider's multi-factor authentication requirements
 *
 * IDs stay decimal strings so large IDs do not lose precision through JavaScript Number.
 * A canonical decimal ID has no sign, surrounding whitespace or leading zeroes.
 * A guild is a Fluxer server.
 * The gateway is the live connection that carries events.
 * A shard is one gateway connection assigned a portion of guild event traffic.
 * A gateway gap is a period when that connection may have missed events, including during recovery.
 * Finalizers are cleanup actions that Effect waits for when work ends
 *
 * Stream values describe sequences. Requests and listeners start when the caller consumes the Stream.
 * Methods returning plain values, such as diagnostics, cache.clear and format.escapeMarkdown, act immediately
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { createClient } from "@neontechspace/fluxerly/effect"
 *
 * export function sendOnce(token: string, channelId: string) {
 *     const program = Effect.scoped(
 *         Effect.gen(function* () {
 *             const client = yield* createClient({ token })
 *             return yield* client.messages.send(channelId, { content: "Hello" })
 *         }),
 *     )
 *     return Effect.runPromise(program)
 * }
 * ```
 *
 * This example sends through HTTP without connecting the gateway.
 * The returned Promise settles after the scoped client finishes cleanup
 *
 * @packageDocumentation
 */
import type { PermissionInput, PermissionTarget } from "./permissions.js"
import type { MemberChunk, MemberChunkQuery, MemberChunkFailure, MemberChunkOptions } from "./member-chunks.js"
import { memberChunkStream } from "#sdk/internal/member-chunks"
export { MemberChunkError } from "./member-chunks.js"
export type {
    MemberChunk,
    MemberChunkQuery,
    MemberChunkFailure,
    MemberChunkOptions,
    DefaultMemberChunkOptions,
} from "./member-chunks.js"
import type {
    CountOperationFailure,
    CountOperationOptions,
    GuildCountsResult,
    ChannelMemberCountsResult,
} from "./counts.js"
export { CountOperationError } from "./counts.js"
export type {
    CountOperation,
    CountOperationFailure,
    CountOperationOptions,
    DefaultCountOperationOptions,
    GuildCount,
    GuildCountsResult,
    ChannelMemberCount,
    ChannelMemberCountsResult,
} from "./counts.js"
import type { Result } from "neverthrow"
import { assets as sharedAssets } from "./assets.js"
import { colors as sharedColors } from "./colors.js"
import { text as sharedText } from "./text.js"
export type { ColorInput, RgbColor } from "./colors.js"
export type { TextSplitOptions } from "./text.js"
import {
    display as sharedDisplay,
    format as sharedFormat,
    links as sharedLinks,
    permissionBits as sharedPermissionBits,
    snowflakes as sharedSnowflakes,
} from "./helpers.js"
import type { AssetUrlError } from "./assets.js"
export { AssetFormats, AssetUrlError } from "./assets.js"
export type { AssetFormat, AssetUrlOptions, StickerAssetUrlOptions } from "./assets.js"
import type { HelperError } from "./helpers.js"
export { HelperError, TimestampStyles } from "./helpers.js"
export type {
    ChannelLinkTarget,
    CustomEmojiMarkup,
    InstallationLinkOptions,
    Mention,
    PermissionName,
    PermissionBitInspection,
    TimestampMarkup,
    TimestampStyle,
} from "./helpers.js"
import type { GuildListQuery, GuildListSummary } from "./guilds.js"
import type { GuildIterationQuery } from "./pagination.js"
export type { GuildListQuery, GuildListSummary } from "./guilds.js"
export type { GuildIterationQuery } from "./pagination.js"
import { guildList } from "#sdk/internal/guild-lifecycle"
export { GuildMemberJoinSourceTypes } from "./member-search.js"
export type { GuildMemberJoinSourceType } from "./member-search.js"
import { GuildOperationError } from "./guilds.js"
export type { PermissionInput, PermissionTarget } from "./permissions.js"
import type { RoleHierarchyInput } from "./role-hierarchy.js"
export type { RoleHierarchyInput } from "./role-hierarchy.js"
import type { GuildRole } from "./guilds.js"
import { compareRoleHierarchy, evaluateMemberHierarchy, isRoleAboveInHierarchy } from "#sdk/internal/role-hierarchy"
import { calculatePermissions, fetchPermissions } from "#sdk/internal/permissions"
import { fetchHierarchyCheck } from "#sdk/internal/role-hierarchy-workflow"

function helperEffect<A>(create: () => Result<A, HelperError>): Effect.Effect<A, HelperError> {
    return Effect.suspend(() => {
        const result = create()
        return result.isOk() ? Effect.succeed(result.value) : Effect.fail(result.error)
    })
}

function assetEffect<A>(create: () => Result<A, AssetUrlError>): Effect.Effect<A, AssetUrlError> {
    return Effect.suspend(() => {
        const result = create()
        return result.isOk() ? Effect.succeed(result.value) : Effect.fail(result.error)
    })
}

/**
 * Create and read Fluxer mention, timestamp and custom-emoji markup without a client or network requests.
 * Methods that can fail return Effects and check inputs when executed.
 * `escapeMarkdown` returns text immediately. Mention markup alone does not enable notifications
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { format, links, type GuildChannel } from "@neontechspace/fluxerly/effect"
 *
 * export const helpersEffectExample = (userId: string, messageId: string, channel: GuildChannel) =>
 *     Effect.gen(function* () {
 *         const mention = yield* format.userMention(userId)
 *         const message = yield* links.message({ id: messageId, channelId: channel.id }, channel)
 *         return { escaped: format.escapeMarkdown("@everyone: **literal**"), mention, message }
 *     })
 * ```
 */
export const format: Readonly<{
    /** Escape Fluxer markup characters so text can be inserted as literal content.
     * Returns the escaped string immediately. This does not change allowedMentions or enable notifications */
    escapeMarkdown: (value: string) => string
    /** Create a user mention such as `<@123>` from a decimal user ID.
     * Invalid IDs fail with HelperError. Set allowedMentions separately to request a notification */
    userMention: (id: string) => Effect.Effect<string, HelperError, never>
    /** Create a role mention such as `<@&123>` from a decimal role ID.
     * Invalid IDs fail with HelperError. Set allowedMentions separately to request notifications */
    roleMention: (id: string) => Effect.Effect<string, HelperError, never>
    /** Create a channel mention such as `<#123>` from a decimal channel ID.
     * The Effect fails with HelperError for an invalid ID, without looking up the channel */
    channelMention: (id: string) => Effect.Effect<string, HelperError, never>
    /** Read the kind and ID from one complete user, role or channel mention.
     * Extra surrounding text, malformed markup or an invalid decimal ID fails with HelperError */
    parseMention: (value: string) => Effect.Effect<import("./helpers.js").Mention, HelperError, never>
    /** Create timestamp markup that Fluxer displays in the reader's local time.
     * Accepts a Date and optional style, defaulting to ShortDateTime. Whole Unix seconds must be 1 through 8_640_000_000_000.
     * Invalid Dates, styles or nonpositive seconds fail with HelperError */
    timestamp: (...args: Parameters<typeof sharedFormat.timestamp>) => Effect.Effect<string, HelperError, never>
    /** Read a Date and style from one complete timestamp markup value.
     * An omitted style becomes ShortDateTime. The Date has whole-second precision.
     * Malformed markup, nonpositive seconds or seconds beyond JavaScript's Date range fail with HelperError */
    parseTimestamp: (value: string) => Effect.Effect<import("./helpers.js").TimestampMarkup, HelperError, never>
    /** Create custom-emoji markup from its name, decimal ID and optional animated flag.
     * Produces `<:name:id>` or `<a:name:id>`. An invalid name or ID fails with HelperError */
    customEmoji: (...args: Parameters<typeof sharedFormat.customEmoji>) => Effect.Effect<string, HelperError, never>
    /** Read the name, ID and animated flag from one complete custom-emoji markup value.
     * Invalid markup fails with HelperError. This does not parse Unicode emoji or resolve shortcodes such as :wave: */
    parseCustomEmoji: (value: string) => Effect.Effect<import("./helpers.js").CustomEmojiMarkup, HelperError, never>
}> = Object.freeze({
    escapeMarkdown: sharedFormat.escapeMarkdown,
    userMention: (id: string) => helperEffect(() => sharedFormat.userMention(id)),
    roleMention: (id: string) => helperEffect(() => sharedFormat.roleMention(id)),
    channelMention: (id: string) => helperEffect(() => sharedFormat.channelMention(id)),
    parseMention: (value: string) => helperEffect(() => sharedFormat.parseMention(value)),
    timestamp: (...args: Parameters<typeof sharedFormat.timestamp>) =>
        helperEffect(() => sharedFormat.timestamp(...args)),
    parseTimestamp: (value: string) => helperEffect(() => sharedFormat.parseTimestamp(value)),
    customEmoji: (...args: Parameters<typeof sharedFormat.customEmoji>) =>
        helperEffect(() => sharedFormat.customEmoji(...args)),
    parseCustomEmoji: (value: string) => helperEffect(() => sharedFormat.parseCustomEmoji(value)),
})

/** Validate Fluxer IDs, read their creation time or create pagination boundaries.
 * A snowflake is Fluxer's time-based decimal-string ID. Conversions return Effects and use bigint to avoid Number precision loss */
export const snowflakes: Readonly<{
    /** Return whether the input is a valid decimal snowflake in Fluxer's signed 64-bit range.
     * Returns a boolean immediately, without converting through Number */
    isValid: (value: unknown) => value is string
    /** Convert a valid decimal snowflake string to bigint without losing precision.
     * The Effect fails with HelperError for invalid IDs */
    parse: (value: string) => Effect.Effect<bigint, HelperError, never>
    /** Read the UTC creation Date encoded in a snowflake's high 41 timestamp bits.
     * The Effect fails with HelperError for an invalid ID, without looking up a resource */
    createdAt: (value: string) => Effect.Effect<Date, HelperError, never>
    /** Create the smallest decimal snowflake for a supplied Date's UTC millisecond, for use as a pagination boundary.
     * Dates before Fluxer's epoch or beyond its timestamp range fail with HelperError. The endpoint determines cursor inclusion */
    boundary: (...args: Parameters<typeof sharedSnowflakes.boundary>) => Effect.Effect<string, HelperError, never>
}> = Object.freeze({
    isValid: sharedSnowflakes.isValid,
    parse: (value: string) => helperEffect(() => sharedSnowflakes.parse(value)),
    createdAt: (value: string) => helperEffect(() => sharedSnowflakes.createdAt(value)),
    boundary: (...args: Parameters<typeof sharedSnowflakes.boundary>) =>
        helperEffect(() => sharedSnowflakes.boundary(...args)),
})

/** Choose a display name from user data and an optional guild member, without a request or cache lookup.
 * The display.name helper prefers the member nickname, then the user's displayName, then username.
 * Only null or undefined trigger a fallback.
 * Supply a member belonging to the same user, because this helper does not check identity */
export const display: typeof sharedDisplay = sharedDisplay

/** Build and inspect permission bitfields from named Fluxer permissions.
 * A bitfield stores permission flags in a bigint. Methods return Effects without fetching resources or deciding whether an action is allowed */
export const permissionBits: Readonly<{
    /** Combine permission names into a bigint bitfield, for role or overwrite inputs.
     * Empty input returns 0n and duplicates have no extra effect. Unknown names fail with HelperError.
     * Administrator remains one flag rather than expanding to all permissions */
    from: (...args: Parameters<typeof sharedPermissionBits.from>) => Effect.Effect<bigint, HelperError, never>
    /** Return whether a named permission flag is set in an unsigned 64-bit bigint.
     * Invalid bits or an unknown name fail with HelperError. This does not calculate inherited permissions or authorize an action */
    has: (...args: Parameters<typeof sharedPermissionBits.has>) => Effect.Effect<boolean, HelperError, never>
    /** Return whether every requested permission flag is set. Empty input returns true.
     * All names are validated, and unknown names or invalid bits fail with HelperError. Unknown bits are unchanged */
    hasAll: (...args: Parameters<typeof sharedPermissionBits.hasAll>) => Effect.Effect<boolean, HelperError, never>
    /** Return whether at least one requested permission flag is set. Empty input returns false.
     * All names are validated even after a match. Unknown names or invalid bits fail with HelperError */
    hasAny: (...args: Parameters<typeof sharedPermissionBits.hasAny>) => Effect.Effect<boolean, HelperError, never>
    /** List requested permission flags that are not set, in first-requested order without duplicates.
     * Returns a frozen array. Invalid bits or unknown names fail with HelperError */
    missing: (
        ...args: Parameters<typeof sharedPermissionBits.missing>
    ) => Effect.Effect<readonly import("./helpers.js").PermissionName[], HelperError, never>
    /** Separate a bigint bitfield into known permission names and unknownBits.
     * Known names use Permissions declaration order. The result is frozen and preserves every bit without expanding Administrator.
     * Invalid unsigned 64-bit bits fail with HelperError */
    inspect: (bits: bigint) => Effect.Effect<import("./helpers.js").PermissionBitInspection, HelperError, never>
    /** Convert an unsigned 64-bit bigint bitfield to the decimal string used in Fluxer JSON requests.
     * Values outside that range fail with HelperError */
    toDecimal: (bits: bigint) => Effect.Effect<string, HelperError, never>
}> = Object.freeze({
    from: (...args: Parameters<typeof sharedPermissionBits.from>) =>
        helperEffect(() => sharedPermissionBits.from(...args)),
    has: (...args: Parameters<typeof sharedPermissionBits.has>) =>
        helperEffect(() => sharedPermissionBits.has(...args)),
    hasAll: (...args: Parameters<typeof sharedPermissionBits.hasAll>) =>
        helperEffect(() => sharedPermissionBits.hasAll(...args)),
    hasAny: (...args: Parameters<typeof sharedPermissionBits.hasAny>) =>
        helperEffect(() => sharedPermissionBits.hasAny(...args)),
    missing: (...args: Parameters<typeof sharedPermissionBits.missing>) =>
        helperEffect(() => sharedPermissionBits.missing(...args)),
    inspect: (bits: bigint) => helperEffect(() => sharedPermissionBits.inspect(bits)),
    toDecimal: (bits: bigint) => helperEffect(() => sharedPermissionBits.toDecimal(bits)),
})

/** Convert RGB colors between integers, hex strings and channel tuples.
 * Methods return Effects. Invalid values fail instead of being coerced or clamped, and CSS color names are not accepted */
export const colors: Readonly<{
    /** Convert an RGB integer, six-digit hex string with optional #, or three integer channels from 0 through 255 to an RGB integer.
     * Invalid inputs fail with HelperError */
    parse: (...args: Parameters<typeof sharedColors.parse>) => Effect.Effect<number, HelperError, never>
    /** Format an RGB integer from 0 through 0xffffff as lowercase #rrggbb, including leading zeroes.
     * Invalid numeric input fails with HelperError */
    toHex: (value: number) => Effect.Effect<string, HelperError, never>
    /** Convert an RGB integer from 0 through 0xffffff to a frozen [red, green, blue] tuple.
     * Invalid numeric input fails with HelperError */
    toRgb: (value: number) => Effect.Effect<import("./colors.js").RgbColor, HelperError, never>
}> = Object.freeze({
    parse: (...args: Parameters<typeof sharedColors.parse>) => helperEffect(() => sharedColors.parse(...args)),
    toHex: (value: number) => helperEffect(() => sharedColors.toHex(value)),
    toRgb: (value: number) => helperEffect(() => sharedColors.toRgb(value)),
})

/**
 * Split long text into length-bounded pieces without losing its contents.
 * The caller chooses the length limit, how to send the pieces and any Markdown handling.
 * The split method returns an Effect that produces text pieces, without sending them
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { permissionBits, colors, text } from "@neontechspace/fluxerly/effect"
 *
 * export function pureHelpersExample(bits: bigint, content: string) {
 *     return Effect.gen(function* () {
 *         return {
 *             required: yield* permissionBits.from(["ManageRoles", "ManageMessages"]),
 *             missing: yield* permissionBits.missing(bits, ["ManageRoles", "ManageMessages"]),
 *             inspection: yield* permissionBits.inspect(bits),
 *             color: yield* colors.parse("#ff8800"),
 *             chunks: yield* text.split(content, { maxLength: 2_000 }),
 *         }
 *     })
 * }
 * ```
 */
export const text: Readonly<{
    /**
     * Split well-formed text into frozen pieces of at most maxLength UTF-16 units, preserving all whitespace.
     * Prefer the last newline, then whitespace, otherwise split a word. Joining with an empty separator is lossless.
     * Empty text gives []. Invalid inputs, lone surrogates or a limit too small for a surrogate pair fail with HelperError.
     * Surrogate pairs stay intact, but a base character and its combining marks or the code points of a joined emoji may land in different pieces.
     * This does not repair Markdown or look up message length limits
     */
    split: (...args: Parameters<typeof sharedText.split>) => Effect.Effect<readonly string[], HelperError, never>
}> = Object.freeze({
    split: (...args: Parameters<typeof sharedText.split>) => helperEffect(() => sharedText.split(...args)),
})

/** Build hosted Fluxer channel, message and bot-installation links from supplied IDs.
 * Methods return Effects and fail with HelperError for invalid input. Building a link does not visit it or check access */
export const links: Readonly<{
    /** Build a hosted channel URL from { id, guildId } for a guild channel or { id } for a private conversation.
     * Invalid decimal IDs fail with HelperError. A URL does not prove the channel exists or the reader can open it */
    channel: (...args: Parameters<typeof sharedLinks.channel>) => Effect.Effect<string, HelperError, never>
    /** Build a hosted message URL from its reference and the channel containing it.
     * Message and channel IDs must match or the Effect fails with HelperError. Channel context is not inferred, and access is not checked */
    message: (...args: Parameters<typeof sharedLinks.message>) => Effect.Effect<string, HelperError, never>
    /** Build Fluxer's hosted bot-installation URL from an application ID and optional unsigned 64-bit permission bits.
     * Uses only the bot scope. Invalid IDs or options fail with HelperError, and alternate addresses or scopes are not accepted.
     * This does not navigate, install the bot, check application existence or authorize permissions */
    installation: (...args: Parameters<typeof sharedLinks.installation>) => Effect.Effect<string, HelperError, never>
}> = Object.freeze({
    channel: (...args: Parameters<typeof sharedLinks.channel>) => helperEffect(() => sharedLinks.channel(...args)),
    message: (...args: Parameters<typeof sharedLinks.message>) => helperEffect(() => sharedLinks.message(...args)),
    installation: (...args: Parameters<typeof sharedLinks.installation>) =>
        helperEffect(() => sharedLinks.installation(...args)),
})

/**
 * Build image URLs for hosted Fluxer from supplied user, member, guild, emoji or sticker data.
 * Methods return Effects and use fixed hosted addresses. Use client.instance.resolve for URLs on a selected self-hosted instance.
 * Invalid targets, IDs, hashes or options fail with AssetUrlError when the Effect executes.
 * Image format defaults to WebP. Omit size to leave pixel size selection to Fluxer.
 * Options are validated even when the supplied asset is absent.
 * These helpers do not fetch profiles, change caches, download bytes, refresh URLs or change attachment or embed URLs.
 * Custom base addresses are not accepted by this hosted namespace.
 * Omitted optional asset hashes become `undefined`. Known absent hashes become `null`. A returned URL does not prove the asset exists
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { assets, AssetFormats, type Guild, type GuildEmoji, type GuildMember, type User, type UserProfile } from "@neontechspace/fluxerly/effect"
 *
 * export const assetsEffectExample = (user: Pick<User, "id" | "avatar">, member: Pick<GuildMember, "guildId" | "userId" | "avatar" | "profileFlags">, guild: Pick<Guild, "id" | "icon">, emoji: Pick<GuildEmoji, "id" | "animated">, profile: UserProfile) =>
 *     Effect.gen(function* () {
 *         const avatar = yield* assets.displayAvatar(user, { size: 256, format: AssetFormats.Webp })
 *         const memberAvatar = yield* assets.displayMemberAvatar(user, member, { size: 256 })
 *         const icon = yield* assets.guildIcon(guild, { format: AssetFormats.Png })
 *         const emojiUrl = yield* assets.emoji(emoji, { animated: emoji.animated })
 *         const banner = yield* assets.userBanner(profile)
 *         return { avatar, memberAvatar, icon, emojiUrl, banner }
 *     })
 * ```
 */
export const assets: Readonly<{
    /** Build an account-banner URL from user.id and profile.banner of a users.fetchProfile snapshot.
     * Null stays null for absent or withheld profile data, without choosing a guild banner or fetching anything.
     * Uses AssetUrlOptions' WebP default and transform validation. A URL does not establish asset existence or access
     */
    userBanner: (
        ...args: Parameters<typeof sharedAssets.userBanner>
    ) => Effect.Effect<string | null, AssetUrlError, never>
    /** Build a user avatar URL, or `null` for a known missing avatar. It only reads the supplied `id` and `avatar` fields and performs no profile lookup */
    avatar: (...args: Parameters<typeof sharedAssets.avatar>) => Effect.Effect<string | null, AssetUrlError, never>
    /** Build Fluxer's static default-avatar URL from a canonical user ID. It has no media transform query and does not depend on profile availability */
    defaultAvatar: (userId: string) => Effect.Effect<string, AssetUrlError, never>
    /** Build a display avatar from the known user avatar or Fluxer's static default. It always resolves to a URL, never `null` */
    displayAvatar: (
        ...args: Parameters<typeof sharedAssets.displayAvatar>
    ) => Effect.Effect<string, AssetUrlError, never>
    /** Build a guild-member avatar URL from guildId, userId and avatar only. It resolves `undefined` for an omitted asset hash and `null` for a known absent hash. It does not choose a fallback */
    memberAvatar: (
        ...args: Parameters<typeof sharedAssets.memberAvatar>
    ) => Effect.Effect<string | null | undefined, AssetUrlError, never>
    /** Build a guild-member banner URL from guildId, userId and banner only. It resolves `undefined` for an omitted asset hash and `null` for a known absent hash */
    memberBanner: (
        ...args: Parameters<typeof sharedAssets.memberBanner>
    ) => Effect.Effect<string | null | undefined, AssetUrlError, never>
    /** Build the member display avatar when its profile state is known: Member avatar, then user avatar, then static default. Reads member guildId, userId, avatar and profileFlags, not banner. `AvatarUnset` selects the static default. Omitted profile flags or an omitted non-unset member avatar resolve `undefined` */
    displayMemberAvatar: (
        ...args: Parameters<typeof sharedAssets.displayMemberAvatar>
    ) => Effect.Effect<string | undefined, AssetUrlError, never>
    /** Build a guild icon URL. It resolves `undefined` for an omitted asset hash and `null` for a known absent hash */
    guildIcon: (
        ...args: Parameters<typeof sharedAssets.guildIcon>
    ) => Effect.Effect<string | null | undefined, AssetUrlError, never>
    /** Build a guild banner URL. It resolves `undefined` for an omitted asset hash and `null` for a known absent hash */
    guildBanner: (
        ...args: Parameters<typeof sharedAssets.guildBanner>
    ) => Effect.Effect<string | null | undefined, AssetUrlError, never>
    /** Build a guild invite-splash URL. It resolves `undefined` for an omitted asset hash and `null` for a known absent hash */
    guildSplash: (
        ...args: Parameters<typeof sharedAssets.guildSplash>
    ) => Effect.Effect<string | null | undefined, AssetUrlError, never>
    /** Build a guild embedded-invite-splash URL. It resolves `undefined` for an omitted asset hash and `null` for a known absent hash */
    guildEmbedSplash: (
        ...args: Parameters<typeof sharedAssets.guildEmbedSplash>
    ) => Effect.Effect<string | null | undefined, AssetUrlError, never>
    /** Build a custom-emoji URL from only its ID and animation metadata. Animated emoji require WebP, GIF, or APNG to retain animation */
    emoji: (...args: Parameters<typeof sharedAssets.emoji>) => Effect.Effect<string, AssetUrlError, never>
    /** Build a custom-sticker URL from only its ID and animation metadata. Stickers do not expose format because Fluxer returns WebP except an animated sticker's GIF source */
    sticker: (...args: Parameters<typeof sharedAssets.sticker>) => Effect.Effect<string, AssetUrlError, never>
}> = Object.freeze({
    userBanner: (...args: Parameters<typeof sharedAssets.userBanner>) =>
        assetEffect(() => sharedAssets.userBanner(...args)),
    avatar: (...args: Parameters<typeof sharedAssets.avatar>) => assetEffect(() => sharedAssets.avatar(...args)),
    defaultAvatar: (userId: string) => assetEffect(() => sharedAssets.defaultAvatar(userId)),
    displayAvatar: (...args: Parameters<typeof sharedAssets.displayAvatar>) =>
        assetEffect(() => sharedAssets.displayAvatar(...args)),
    memberAvatar: (...args: Parameters<typeof sharedAssets.memberAvatar>) =>
        assetEffect(() => sharedAssets.memberAvatar(...args)),
    memberBanner: (...args: Parameters<typeof sharedAssets.memberBanner>) =>
        assetEffect(() => sharedAssets.memberBanner(...args)),
    displayMemberAvatar: (...args: Parameters<typeof sharedAssets.displayMemberAvatar>) =>
        assetEffect(() => sharedAssets.displayMemberAvatar(...args)),
    guildIcon: (...args: Parameters<typeof sharedAssets.guildIcon>) =>
        assetEffect(() => sharedAssets.guildIcon(...args)),
    guildBanner: (...args: Parameters<typeof sharedAssets.guildBanner>) =>
        assetEffect(() => sharedAssets.guildBanner(...args)),
    guildSplash: (...args: Parameters<typeof sharedAssets.guildSplash>) =>
        assetEffect(() => sharedAssets.guildSplash(...args)),
    guildEmbedSplash: (...args: Parameters<typeof sharedAssets.guildEmbedSplash>) =>
        assetEffect(() => sharedAssets.guildEmbedSplash(...args)),
    emoji: (...args: Parameters<typeof sharedAssets.emoji>) => assetEffect(() => sharedAssets.emoji(...args)),
    sticker: (...args: Parameters<typeof sharedAssets.sticker>) => assetEffect(() => sharedAssets.sticker(...args)),
})

/** The selected instance's service addresses and URL helpers, returned as a frozen result by instance.resolve */
export interface ResolvedInstance {
    /** The provider's code version from discovery, not the version in an API path */
    readonly apiCodeVersion: number
    /** Validated base addresses for this client's selected instance */
    readonly endpoints: InstanceEndpoints
    /** Whether this instance advertises presigned attachment upload plans */
    readonly presignedAttachmentUploads: boolean
    /** Asset URL helpers using this instance's addresses rather than hosted Fluxer's.
     * Methods return Effects and follow the assets namespace's input-field and fallback rules */
    readonly assets: typeof assets
    /** Channel, message and installation link helpers using this instance's application address.
     * Methods return Effects and perform no navigation or access check */
    readonly links: typeof links
}

function effectInstance(value: DefaultResolvedInstance): ResolvedInstance {
    const instanceAssets = value.assets
    const instanceLinks = value.links
    return Object.freeze({
        apiCodeVersion: value.apiCodeVersion,
        endpoints: value.endpoints,
        presignedAttachmentUploads: value.presignedAttachmentUploads,
        assets: Object.freeze({
            userBanner: (...args: Parameters<typeof instanceAssets.userBanner>) =>
                assetEffect(() => instanceAssets.userBanner(...args)),
            avatar: (...args: Parameters<typeof instanceAssets.avatar>) =>
                assetEffect(() => instanceAssets.avatar(...args)),
            defaultAvatar: (userId: string) => assetEffect(() => instanceAssets.defaultAvatar(userId)),
            displayAvatar: (...args: Parameters<typeof instanceAssets.displayAvatar>) =>
                assetEffect(() => instanceAssets.displayAvatar(...args)),
            memberAvatar: (...args: Parameters<typeof instanceAssets.memberAvatar>) =>
                assetEffect(() => instanceAssets.memberAvatar(...args)),
            memberBanner: (...args: Parameters<typeof instanceAssets.memberBanner>) =>
                assetEffect(() => instanceAssets.memberBanner(...args)),
            displayMemberAvatar: (...args: Parameters<typeof instanceAssets.displayMemberAvatar>) =>
                assetEffect(() => instanceAssets.displayMemberAvatar(...args)),
            guildIcon: (...args: Parameters<typeof instanceAssets.guildIcon>) =>
                assetEffect(() => instanceAssets.guildIcon(...args)),
            guildBanner: (...args: Parameters<typeof instanceAssets.guildBanner>) =>
                assetEffect(() => instanceAssets.guildBanner(...args)),
            guildSplash: (...args: Parameters<typeof instanceAssets.guildSplash>) =>
                assetEffect(() => instanceAssets.guildSplash(...args)),
            guildEmbedSplash: (...args: Parameters<typeof instanceAssets.guildEmbedSplash>) =>
                assetEffect(() => instanceAssets.guildEmbedSplash(...args)),
            emoji: (...args: Parameters<typeof instanceAssets.emoji>) =>
                assetEffect(() => instanceAssets.emoji(...args)),
            sticker: (...args: Parameters<typeof instanceAssets.sticker>) =>
                assetEffect(() => instanceAssets.sticker(...args)),
        }),
        links: Object.freeze({
            channel: (...args: Parameters<typeof instanceLinks.channel>) =>
                helperEffect(() => instanceLinks.channel(...args)),
            message: (...args: Parameters<typeof instanceLinks.message>) =>
                helperEffect(() => instanceLinks.message(...args)),
            installation: (...args: Parameters<typeof instanceLinks.installation>) =>
                helperEffect(() => instanceLinks.installation(...args)),
        }),
    })
}
import type { BotApplication, BotApplicationOperationFailure, BotApplicationOperationOptions } from "./application.js"
export { BotApplicationOperationError } from "./application.js"
export type {
    BotApplication,
    BotApplicationOperation,
    BotApplicationOperationFailure,
    BotApplicationOperationOptions,
    DefaultBotApplicationOperationOptions,
} from "./application.js"
import { applicationCurrent } from "#sdk/internal/application"
import type {
    MemberSearchQuery,
    MemberSearchPage,
    MemberSearchHit,
    MemberSearchIterationLimits,
} from "./member-search.js"
export type {
    MemberSearchQuery,
    MemberSearchPage,
    MemberSearchHit,
    MemberSearchIterationLimits,
} from "./member-search.js"
import { searchMembers, searchMemberPagination } from "#sdk/internal/member-search-workflow"
import { searchMessagePagination } from "#sdk/internal/message-search-workflow"
import type {
    MessageSearchContext,
    MessageSearchIterationLimits,
    MessageSearchPage,
    MessageSearchQuery,
} from "./message-search.js"
export type {
    MessageSearchAuthorType,
    MessageSearchChannel,
    MessageSearchContentType,
    MessageSearchContext,
    MessageSearchEmbedType,
    MessageSearchIndexingPage,
    MessageSearchIterationLimits,
    MessageSearchOptions,
    MessageSearchPage,
    MessageSearchQuery,
    MessageSearchResultsPage,
} from "./message-search.js"
import type { AuditLogEntry, AuditLogPage, AuditLogQuery, AuditLogIterationQuery } from "./audit-logs.js"
import type {
    DiscoveryApplication,
    DiscoveryApplicationInput,
    DiscoveryApplicationEdit,
    DiscoveryCategory,
    DiscoverySearchPage,
    DiscoverySearchQuery,
    DiscoveryStatus,
} from "./discovery.js"
export type {
    DiscoveryApplication,
    DiscoveryApplicationInput,
    DiscoveryApplicationEdit,
    DiscoveryCategory,
    DiscoverySearchPage,
    DiscoverySearchQuery,
    DiscoveryStatus,
} from "./discovery.js"
export type { DiscoveryCategoryCount, DiscoveryGuild } from "./discovery.js"
export { DiscoveryCategories } from "./discovery.js"
import {
    discoverySearch,
    discoveryStatus,
    discoveryCategories,
    discoveryWrite,
    discoveryWithdraw,
} from "#sdk/internal/guild-discovery"
export type { AuditLogEntry, AuditLogPage, AuditLogQuery, AuditLogIterationQuery } from "./audit-logs.js"
import { auditLogPage } from "#sdk/internal/audit-logs"
export type {
    GuildCreate,
    GuildEmojisUpdate,
    GuildStickersUpdate,
    GuildLifecycleEvents,
    WebhooksUpdate,
    InviteDeleteEvent,
    GuildAuditLogEntryCreate,
} from "./events.js"
export { AuditLogActions } from "./audit-logs.js"
export type {
    AuditLogActionType,
    AuditLogPermissionsDiff,
    AuditLogChangeValue,
    AuditLogChange,
    AuditLogOptions,
    AuditLogWebhook,
} from "./audit-logs.js"
import type { GuildEdit, GuildVanityUrl, GuildVanityUrlUsage } from "./guilds.js"
export type { GuildEdit, GuildVanityUrl, GuildVanityUrlUsage } from "./guilds.js"
import { vanityUrlEdit, vanityUrlFetch } from "#sdk/internal/vanity-url"
export {
    GuildSystemChannelFlags,
    GuildDefaultMessageNotifications,
    GuildVerificationLevels,
    GuildExplicitContentFilters,
    GuildContentWarningLevels,
    GuildSplashCardAlignments,
    GuildFeatureToggles,
} from "./guilds.js"
export type {
    GuildSystemChannelFlag,
    GuildDefaultMessageNotification,
    GuildVerificationLevel,
    GuildExplicitContentFilter,
    GuildContentWarningLevel,
    GuildSplashCardAlignment,
    GuildFeatureToggle,
} from "./guilds.js"
import { guildEdit } from "#sdk/internal/guild-settings"
import type { Invite, InviteCreate, InviteMetadata } from "./invites.js"
export type { Invite, InviteCreate, InviteMetadata } from "./invites.js"
import { inviteCreate, inviteDelete, inviteFetch, inviteList } from "#sdk/internal/invites"
import type {
    GuildEmoji,
    GuildSticker,
    ExpressionReference,
    ExpressionMetadata,
    EmojiCreate,
    EmojiEdit,
    StickerCreate,
    StickerEdit,
    ExpressionBatch,
    ExpressionDeleteOptions,
} from "./expressions.js"
export type {
    GuildEmoji,
    GuildSticker,
    ExpressionReference,
    ExpressionMetadata,
    EmojiCreate,
    EmojiEdit,
    StickerCreate,
    StickerEdit,
    ExpressionBatch,
    ExpressionDeleteOptions,
    DefaultExpressionDeleteOptions,
} from "./expressions.js"
import {
    expressionList,
    expressionMetadata,
    expressionCreate,
    expressionBatch,
    expressionClone,
    expressionEdit,
    expressionDelete,
} from "#sdk/internal/expressions"

import type { PresenceInput, PresenceFailure } from "./presence.js"
export { PresenceError } from "./presence.js"
export type {
    PresenceInput,
    PresenceStatus,
    CustomStatusInput,
    CustomStatusEmoji,
    PresenceFailure,
} from "./presence.js"
import type { MemberProfileEdit } from "./guilds.js"
export type { MemberProfileEdit, MemberMentionPreference } from "./guilds.js"
export { GuildMemberProfileFlags, MemberMentionPreferences } from "./guilds.js"
import { memberEditSelf, memberNicknameEdit, memberRolesSet } from "#sdk/internal/guilds"
import type {
    User,
    UserProfile,
    UserProfileQuery,
    DirectMessageChannel,
    DirectMessageGroupEdit,
    DirectMessageLatestMessages,
    UserOperationFailure,
    UserOperationOptions,
} from "./users.js"
export { UserOperationError } from "./users.js"
export type {
    User,
    UserProfile,
    UserProfileFields,
    UserProfileQuery,
    DirectMessageChannel,
    DirectMessageGroupEdit,
    DirectMessageLatestMessages,
    DirectMessageRecipientChange,
    UserOperation,
    UserOperationFailure,
    UserOperationOptions,
    DefaultUserOperationOptions,
} from "./users.js"
import {
    userFetch,
    userProfile,
    directMessageOpen,
    directMessageFetch,
    directMessageList,
    directMessageLatestMessages,
    directMessageEdit,
    directMessageClose,
} from "#sdk/internal/users"
import {
    type Webhook,
    type CreatedWebhook,
    type WebhookCreate,
    type WebhookEdit,
    type WebhookTokenEdit,
    type WebhookMessageInput,
    type WebhookMessageEdit,
    type WebhookClientOptions,
    type WebhookOperationFailure,
    type WebhookOperationOptions,
} from "./webhooks.js"
export { WebhookOperationError } from "./webhooks.js"
export type {
    Webhook,
    WebhookCredentials,
    CreatedWebhook,
    WebhookCreate,
    WebhookEdit,
    WebhookTokenEdit,
    WebhookMessageInput,
    WebhookMessageReference,
    WebhookReplyReference,
    WebhookForwardReference,
    WebhookMessageEdit,
    WebhookClientOptions,
    WebhookOperation,
    WebhookOperationOptions,
    DefaultWebhookOperationOptions,
    WebhookOperationFailure,
} from "./webhooks.js"
import {
    makeWebhookClient,
    webhookCreate,
    webhookFetch,
    webhookList,
    webhookEdit,
    webhookDelete,
    webhookTokenFetch,
    webhookTokenEdit,
    webhookTokenDelete,
    webhookSend,
    webhookMessage,
    webhookMessageDelete,
} from "#sdk/internal/webhooks"
import { Deferred, Effect, Scope, Stream } from "effect"
import { runBotCore } from "#sdk/internal/bot-runner"
import { CriticalWorkerStoppedError, type RunBotOptions } from "./bot-runner.js"
export { CriticalWorkerStoppedError } from "./bot-runner.js"
export type { RunBotOptions } from "./bot-runner.js"
import {
    createPkce,
    type OAuthAuthorizationInput,
    type OAuthConnection,
    type OAuthCodeExchangeInput,
    type OAuthConfig,
    type OAuthIdentity,
    type OAuthIntrospection,
    type OAuthOperationFailure,
    type OAuthTokens,
    type OAuthOperationOptions,
} from "./oauth.js"
import { makeOAuthOwner } from "#sdk/internal/oauth"
export { createPkce, OAuthOperationError, OAuthScopes } from "./oauth.js"
export type {
    OAuthAuthorizationInput,
    OAuthActiveIntrospection,
    OAuthConnection,
    OAuthCodeExchangeInput,
    OAuthConfig,
    OAuthIdentity,
    OAuthInactiveIntrospection,
    OAuthIntrospection,
    OAuthOperation,
    OAuthOperationFailure,
    OAuthOperationOptions,
    OAuthPkce,
    OAuthScope,
    OAuthTokens,
} from "./oauth.js"

/**
 * Use OAuth to access a user's Fluxer account with their consent and a server-held client secret.
 * The scope that creates this client shuts it down
 *
 * The application handles consent, browser callbacks, state checks, token storage and refresh coordination
 *
 * The client keeps a copy of the secret until shutdown and allows at most eight concurrent operations, without a queue.
 * Response bodies are capped at 1 MiB. Requests never retry automatically.
 * Discovery throttling fails with OAuthOperationError reason rateLimit, outcome notDispatched, status 429 and the server's retryAfterMs when available
 *
 * Expected failures use Effect's error channel. Interruption and cleanup defects remain in Cause.
 * OAuth response cleanup faults use safe SDK diagnostics. Discovery cleanup faults preserve their original defect in Cause
 *
 * Operation input properties are read during execution, with throwing accessors retained as defects
 */
export interface OAuthClient {
    /** Build the selected instance's authorization-page URL using S256 PKCE, which binds the callback code to the caller's private verifier.
     * Input supplies the redirect URI, scopes, caller-generated state and code challenge. The advertised application path is preserved.
     * Guild and permission parameters are consent hints, not installation or authorization proof.
     * The application stores and checks state and the PKCE verifier */
    authorizationUrl(
        input: OAuthAuthorizationInput,
        options?: OAuthOperationOptions,
    ): Effect.Effect<string, OAuthOperationFailure>
    /** Exchange the callback code and its matching redirect URI and PKCE verifier for access and refresh tokens.
     * The application must store the returned tokens. A lost response or cancellation after dispatch may have consumed the code, so do not retry it */
    exchangeCode(
        input: OAuthCodeExchangeInput,
        options?: OAuthOperationOptions,
    ): Effect.Effect<OAuthTokens, OAuthOperationFailure>
    /** Exchange a refresh token for a new access and refresh token pair.
     * Form tokens must contain 1–256 well-formed UTF-16 units without surrounding whitespace, U+000C or U+202E.
     * Invalid values fail locally rather than being normalized. This also applies to revoke and introspect tokens.
     * Coordinate concurrent refreshes and replace the stored pair atomically after success. Never retry an unknown outcome, which may have rotated the token */
    refresh(refreshToken: string, options?: OAuthOperationOptions): Effect.Effect<OAuthTokens, OAuthOperationFailure>
    /** Revoke one access or refresh token.
     * The token and hint are captured once when the Effect runs, then validated and transmitted from that snapshot.
     * A lost response can still mean the token was revoked
     */
    revoke(
        input: {
            /** Access or refresh token to invalidate. Keep this secret out of logs */
            readonly token: string
            /** Identify the token as an access token or a refresh token. Omit when the kind is unknown */
            readonly tokenTypeHint?: "access_token" | "refresh_token"
        },
        options?: OAuthOperationOptions,
    ): Effect.Effect<void, OAuthOperationFailure>
    /** Read the delegated user's identity using an access token with the identify scope.
     * The SDK does not retain the token. Additional identity fields depend on the token's scopes */
    fetchIdentity(
        accessToken: string,
        options?: OAuthOperationOptions,
    ): Effect.Effect<OAuthIdentity, OAuthOperationFailure>
    /** Read one page of the delegated user's guild memberships using an access token with the guilds scope.
     * Limit defaults to 200, from 1 through 200. Before and after are mutually exclusive cursors.
     * This uses the supplied access token, not a bot token */
    fetchGuilds(
        accessToken: string,
        query?: GuildListQuery,
        options?: OAuthOperationOptions,
    ): Effect.Effect<readonly GuildListSummary[], OAuthOperationFailure>
    /** Read the user's full connections list with an access token that has Fluxer's connections scope.
     * This does not create, verify, reorder or retain connections */
    fetchConnections(
        accessToken: string,
        options?: OAuthOperationOptions,
    ): Effect.Effect<readonly OAuthConnection[], OAuthOperationFailure>
    /** Check whether one access or refresh token is active using this client's Basic credentials.
     * An inactive result does not explain revocation, expiry, ownership or whether the token exists */
    introspect(token: string, options?: OAuthOperationOptions): Effect.Effect<OAuthIntrospection, OAuthOperationFailure>
    /** Clear copied confidential credentials, reject new work, abort active requests, and await their fetch and response-reader cleanup.
     * Active-operation response cleanup defects remain in that operation's Cause. Shutdown waits for its completion and may succeed.
     * Defects encountered by shutdown's own discovery cleanup remain in shutdown's Cause
     */
    shutdown(): Effect.Effect<void>
}

/**
 * Create a server-side OAuth client, or generate an S256 PKCE challenge for an authorization request.
 * The create method returns an Effect that requires Scope. Invalid configuration fails with ConfigurationError.
 * The application owns consent, callback correlation, state validation, token storage, installation policy and coordinated refresh
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { oauth, OAuthScopes } from "@neontechspace/fluxerly/effect"
 *
 * export const oauthEffectExample = Effect.scoped(
 *     Effect.gen(function* () {
 *         const client = yield* oauth.create({ clientId: "123", clientSecret: "server-held-secret" })
 *         const pkce = oauth.createPkce()
 *         return yield* client.authorizationUrl({
 *             redirectUri: "https://app.example.test/oauth/callback",
 *             scopes: [OAuthScopes.Identify, OAuthScopes.Bot],
 *             state: "caller-correlated-state",
 *             codeChallenge: pkce.challenge,
 *             guildId: "456",
 *             permissions: 0n,
 *         })
 *     }),
 * )
 * ```
 */
export const oauth: Readonly<{
    /** Create the OAuth client when this Effect executes, without making a request.
     * ConfigurationError reports invalid client credentials or instance settings. Unexpected failures remain defects in the Cause.
     * Scope closure calls shutdown
     */
    create: (config: OAuthConfig) => Effect.Effect<OAuthClient, ConfigurationError, Scope.Scope>
    /** Generate a random S256 PKCE verifier and challenge immediately.
     * Keep the verifier private until exchangeCode, and put only the challenge in authorizationUrl
     */
    createPkce: typeof createPkce
}> = Object.freeze({
    create: (config: OAuthConfig): Effect.Effect<OAuthClient, ConfigurationError, Scope.Scope> =>
        Effect.gen(function* () {
            const owner = yield* makeOAuthOwner(config, Scope.makeUnsafe())
            yield* Effect.addFinalizer(() => owner.shutdown())
            return Object.freeze({
                authorizationUrl: (input: OAuthAuthorizationInput, options?: OAuthOperationOptions) =>
                    owner.authorizationUrl(input, options),
                exchangeCode: (input: OAuthCodeExchangeInput, options?: OAuthOperationOptions) =>
                    owner.exchangeCode(input, options),
                refresh: (refreshToken: string, options?: OAuthOperationOptions) =>
                    owner.refresh(refreshToken, options),
                revoke: (
                    input: { readonly token: string; readonly tokenTypeHint?: "access_token" | "refresh_token" },
                    options?: OAuthOperationOptions,
                ) => owner.revoke(input, options),
                fetchIdentity: (accessToken: string, options?: OAuthOperationOptions) =>
                    owner.fetchIdentity(accessToken, options),
                fetchGuilds: (accessToken: string, query?: GuildListQuery, options?: OAuthOperationOptions) =>
                    owner.fetchGuilds(accessToken, query, options),
                fetchConnections: (accessToken: string, options?: OAuthOperationOptions) =>
                    owner.fetchConnections(accessToken, options),
                introspect: (token: string, options?: OAuthOperationOptions) => owner.introspect(token, options),
                shutdown: () => owner.shutdown(),
            })
        }),
    createPkce,
})
export { builders, EmbedBuilder, MessageBuilder } from "./builders.js"
export type {
    CommandArgumentSchema,
    CommandArgumentMetadata,
    CommandArgumentMention,
    CommandArgumentType,
    CommandArgumentDescriptor,
    CommandArgumentUser,
    CommandArgumentChannel,
    CommandArgumentRole,
    CommandArgumentText,
    CommandArgumentInteger,
    CommandArgumentNumber,
    CommandArgumentBoolean,
    CommandArgumentId,
    CommandArgumentChoice,
    CommandArgumentUserSelection,
    CommandArgumentChannelSelection,
    CommandArgumentRoleSelection,
    CommandArgumentValues,
    CommandArgumentValue,
    CommandArgumentRejectionReason,
} from "./command-arguments.js"
export type { CommandHelpOptions } from "./command-help.js"
export type {
    CommandCooldownClaim,
    CommandCooldownRequest,
    MemoryCooldownOptions,
    PrefixCommandDefinition,
    PrefixCommandGroupDefinition,
    PrefixCommandGroupMetadata,
    PrefixCommandRegistrationOptions,
    PrefixCommandMetadata,
    PrefixCommandParse,
    PrefixCommandParseInput,
    PrefixCommandPrefix,
    PrefixCommandRejection,
    PrefixCommandUnmatched,
    PrefixCommandsOptions,
} from "./commands.js"
export type {
    NativeCooldownStore,
    MemoryCooldownStore,
    NativePrefixCommand,
    NativePrefixCommandContext,
    NativePrefixCommandExecutionContext,
    NativePrefixCommandCooldown,
    NativePrefixCommandUnmatchedContext,
    NativePrefixCommandsOptions,
    NativePrefixCommandRouter,
} from "./native-commands.js"
import { nativeCommands } from "./native-commands.js"
export { SupervisorChildError, SupervisorError } from "./supervisor.js"
export type {
    SupervisorAssignment,
    SupervisorAssignmentOptions,
    SupervisorChildOptions,
    SupervisorChildState,
    SupervisorChildStatus,
    SupervisorFileUrl,
    SupervisorIdentifyOptions,
    SupervisorOptions,
    SupervisorRestartOptions,
    SupervisorState,
    SupervisorStatus,
    SupervisorWaitOptions,
} from "./supervisor.js"
export type {
    NativeSupervisor,
    NativeSupervisorChildContext,
    NativeSupervisorChildOptions,
    NativeSupervisorTools,
} from "./native-supervisor.js"
import { makeNativeSupervisor } from "./native-supervisor.js"

/**
 * Define text commands, parse their arguments and attach them to an existing client.
 * Commands listen through one bounded messageCreate subscription in the caller's Scope when attach executes.
 * The router does not connect the client or create a separate SDK runtime.
 * The separately exported builders help construct message inputs and return independent plain payload snapshots.
 * Guards, cooldown keys, unmatched feedback and handler Effects remain application-owned. The router does not fetch permissions, send replies or retry failures.
 * Groups optionally organize command paths and help pages.
 * Flat commands remain independent, and each protected command still needs its own guard
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { commands, type Client } from "@neontechspace/fluxerly/effect"
 * export function commandGroupExample(client: Client) {
 *     return Effect.gen(function* () {
 *         const root = yield* commands.create({ prefix: "!" })
 *         const grouped = yield* root.registerGroup({ name: "tools", aliases: ["t"] })
 *         const router = yield* grouped.register({
 *             name: "ping",
 *             execute: ({ client, message }) => client.messages.reply(message, { content: "Pong", allowedMentions: {} }),
 *         }, { group: ["tools"] })
 *         return yield* router.attach(client)
 *     })
 * }
 * ```
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { builders, commands, type Client } from "@neontechspace/fluxerly/effect"
 *
 * export const installPing = (client: Client) => Effect.gen(function* () {
 *     const router = yield* commands.create({
 *         prefix: "!",
 *         parse: commands.parseQuoted,
 *         onUnmatched: ({ client, message }, unmatched) =>
 *             unmatched._tag === "CommandUnknownName"
 *                 ? client.messages.reply(message, builders.message().content(`Unknown command: ${unmatched.name}`).build()).pipe(Effect.asVoid)
 *                 : Effect.void,
 *     })
 *     const registered = yield* router.register({
 *         name: "ping",
 *         execute: ({ client, message }) => client.messages.reply(message, builders.message().content("Pong").build()).pipe(Effect.asVoid),
 *     })
 *     return yield* registered.attach(client)
 * })
 * ```
 * Argument schemas are optional definitions of the values a command expects.
 * Guards see raw input first. Conversion failures call onReject without consuming a cooldown.
 * The execute callback receives inferred frozen values alongside unchanged args
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { commands, type Client } from "@neontechspace/fluxerly/effect"
 *
 * export function typedCommandExample(client: Client) {
 *     return Effect.gen(function* () {
 *         const router = yield* commands.create({ prefix: "!", parse: commands.parseQuoted })
 *         const registered = yield* router.register({
 *             name: "repeat",
 *             arguments: {
 *                 count: { type: "integer" },
 *                 mode: { type: "choice", choices: ["fast", "slow"] },
 *                 note: { type: "text", optional: true, rest: true },
 *             },
 *             onReject: ({ client, message }, rejection) =>
 *                 rejection._tag === "CommandArgumentRejected"
 *                     ? client.messages.reply(message, {
 *                         content: `Argument ${rejection.argument}: ${rejection.reason}`, allowedMentions: {},
 *                     }).pipe(Effect.asVoid)
 *                     : Effect.void,
 *             execute: ({ client, message, values }) => client.messages.reply(message, {
 *                 content: `${values.count} / ${values.mode} / ${values.note ?? "No note"}`, allowedMentions: {},
 *             }).pipe(Effect.asVoid),
 *         })
 *         return yield* registered.attach(client)
 *     })
 * }
 * ```
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { type Client, type NativePrefixCommandRouter } from "@neontechspace/fluxerly/effect"
 *
 * export function commandHelpExample(client: Client, router: NativePrefixCommandRouter, channelId: string) {
 *     return Effect.gen(function* () {
 *         const pages = yield* router.help({ prefix: "!", maxLength: 1_000, include: (command) => command.name !== "admin" })
 *         // Visibility is not authorization. Each command still needs its own policy
 *         for (const content of pages) {
 *             yield* client.messages.send(channelId, { content, allowedMentions: {} })
 *         }
 *         // Earlier pages remain sent if a later send fails or is interrupted. No retries occur
 *     })
 * }
 * ```
 */
export const commands = nativeCommands

/**
 * Run bot workers in separate Node processes on this machine.
 * The create method validates the process plan when executed but starts no children.
 * The start method launches those children once and waits for their assignment and configuration acknowledgements, not gateway READY.
 * The waitForReady method waits for a later all-child READY state without starting or stopping the supervisor.
 * The waitForClose method waits until every owned child exits. Cancelling that wait does not stop the children.
 * The status method returns a frozen snapshot of each child's latest reported gateway state for its current process generation.
 * The snapshot is local, not a simultaneous health check across processes
 *
 * Each child module must execute supervisor.child.run, which owns a nested client and an inter-process communication (IPC) cleanup scope.
 * The helper preserves the caller's Effect services and Cause. It asks the parent for a permit immediately before each fresh gateway Identify.
 * Identify authenticates a new gateway session. Resuming an existing session needs no permit.
 * Only one parent permit can be outstanding. The child confirms its synchronous Identify send or cancels before sending.
 * The parent spaces fresh sends by at least one second.
 * A stalled child must stop and exit before another permit is issued, followed by a full spacing interval
 *
 * The supervisor does not discover shard counts, coordinate other hosts or processes, retain sessions across replacements, or share REST limits across children.
 * It installs no signal handlers and does not terminate the process.
 * After the configured graceful deadline, the parent can terminate only its own unresponsive child and still waits for its exit.
 * Replacement after failure is opt-in through restart, with bounded exponential delays.
 * childEnvironment, args and execArgv configure children but never appear in status or failures.
 * Child stdout and stderr are ignored and not retained
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { supervisor } from "@neontechspace/fluxerly/effect"
 *
 * export const workers = Effect.gen(function* () {
 *     const managed = yield* supervisor.create({
 *         entry: "/srv/bot-worker.js",
 *         totalShards: 2,
 *         assignments: [
 *             { id: "one", shardIds: [0] },
 *             { id: "two", shardIds: [1] },
 *         ],
 *     })
 *     yield* managed.start().pipe(
 *         Effect.andThen(managed.waitForClose()),
 *         Effect.ensuring(managed.shutdown()),
 *     )
 *     return managed.status()
 * })
 * ```
 */
export const supervisor: import("./native-supervisor.js").NativeSupervisorTools = makeNativeSupervisor(createClient)
import type { PaginationError, HistoryIterationQuery, UserIterationQuery, PinIterationQuery } from "./pagination.js"
export { PaginationError } from "./pagination.js"
export type {
    PaginationQuery,
    HistoryIterationQuery,
    UserIterationQuery,
    PinIterationQuery,
    PaginationOperation,
} from "./pagination.js"
import {
    historyPagination,
    memberPagination,
    guildPagination,
    auditLogPagination,
    reactionUserPagination,
    pinPagination,
    paginationStream,
} from "#sdk/internal/pagination"
export type {
    EmbedInput,
    EmbedAuthorInput,
    EmbedFooterInput,
    EmbedMediaInput,
    EmbedFieldInput,
    Embed,
    EmbedChild,
    EmbedAuthor,
    EmbedFooter,
    EmbedMedia,
    EmbedField,
} from "./embeds.js"
export type { MessageBody } from "./messages.js"
export { AttachmentDownloadError, AttachmentRefreshError } from "./attachments.js"
import { AttachmentDownloadError } from "./attachments.js"
export type {
    Attachment,
    AttachmentBytesInput,
    AttachmentDownloadFailure,
    AttachmentDownloadOptions,
    AttachmentFileInput,
    AttachmentFileSource,
    AttachmentInput,
    AttachmentRefreshFailure,
    AttachmentRefreshOperation,
    AttachmentRefreshOptions,
    AttachmentReference,
    AttachmentStreamInput,
    AttachmentStreamReadResult,
    AttachmentStreamReader,
    AttachmentStreamReaderOptions,
    AttachmentStreamSource,
    DefaultAttachmentDownloadOptions,
    DefaultAttachmentRefreshOptions,
    DefaultAttachmentStreamOptions,
    RefreshedAttachmentUrl,
} from "./attachments.js"
import type {
    Attachment,
    AttachmentDownloadFailure,
    AttachmentDownloadOptions,
    AttachmentRefreshFailure,
    AttachmentRefreshOptions,
    RefreshedAttachmentUrl,
} from "./attachments.js"
import type { ReactionEmojiInput, ReactionUsersQuery, ReactionUsersPage } from "./reactions.js"
export type {
    ReactionEmojiInput,
    ReactionUsersQuery,
    ReactionUsersPage,
    ReactionUser,
    ReactionEmoji,
    ReactionTarget,
    MessageReaction,
    MessageReactionBatch,
    MessageReactionEmojiRemoval,
} from "./reactions.js"
import type { Logger } from "effect"
import type { LoggingOptions, DefaultLogger } from "./logging.js"
import { adaptLogger } from "#sdk/internal/logging"
export type {
    LoggingOptions,
    DefaultLogger,
    SdkLifecycleEvent,
    SdkLifecycleLogRecord,
    SdkLogLevel,
    SdkLogRecord,
    SdkMeasurementLogRecord,
    SdkMeasurementOperation,
    SdkMeasurementStage,
    SdkOperationalLogRecord,
} from "./logging.js"

/**
 * Use an Effect logger with the JavaScript & TypeScript API without adding Effect types to that API.
 * Pass the returned value as logging.logger to createClient from the default entry point.
 * Delivery is synchronous. Thrown logger failures are swallowed without retry, while a blocking logger can delay SDK work.
 * Returned promises or thenables are not awaited, and their rejections are discarded.
 * No queue, sink flushing or persistence guarantee is added. Effect callers use their own Effect logger directly.
 * The SDK supplies safe messages and empty causes.
 * The caller remains responsible for any added context and the logger's output destination
 * @throws ConfigurationError with field logger when the value is not an Effect logger
 * @example
 * ```ts
 * import { Logger } from "effect"
 * import { createClient } from "@neontechspace/fluxerly"
 * import { fromEffectLogger } from "@neontechspace/fluxerly/effect"
 * export function loggingExample(token: string, logger: Logger.Logger<unknown, unknown>) {
 *     return createClient({ token, logging: { development: true, logger: fromEffectLogger(logger) } })
 * }
 * ```
 */
export function fromEffectLogger(logger: Logger.Logger<unknown, unknown>): DefaultLogger {
    return adaptLogger(logger)
}
import type {
    CacheEntriesOptions,
    CachedResources,
    CacheKind,
    ClientDiagnostics,
    ClientState,
    ClientOptions as SharedClientOptions,
    ConnectionState,
} from "./client.js"
import type {
    PermissionOverwrite,
    GuildChannel,
    ChannelCreate,
    ChannelEdit,
    ChannelPosition,
    ChannelOperationFailure,
    ChannelOperationOptions,
    ChannelAuditOperationOptions,
} from "./channels.js"
export { ChannelOperationError, ChannelType } from "./channels.js"
export type {
    PermissionOverwrite,
    GuildChannel,
    ChannelCreateBase,
    TextChannelCreate,
    VoiceChannelCreate,
    CategoryChannelCreate,
    LinkChannelCreate,
    ChannelCreate,
    ChannelEdit,
    ChannelPosition,
    GuildChannelUpdateBulk,
    ChannelOperation,
    ChannelOperationFailure,
    ChannelOperationOptions,
    ChannelAuditOperationOptions,
} from "./channels.js"
import {
    channelFetch,
    channelList,
    channelCreate,
    channelEdit,
    channelDelete,
    channelReorder,
    permissionSet,
    permissionRemove,
} from "#sdk/internal/channels"
import type {
    Guild,
    RoleReference,
    RolePosition,
    RoleHoistPosition,
    RoleCreate,
    RoleEdit,
    GuildMember,
    MemberReference,
    VoiceConnectionReference,
    MemberQuery,
    GuildOperationFailure,
    GuildOperationOptions,
    GuildAuditOperationOptions,
} from "./guilds.js"
export { GuildOperationError, Permissions } from "./guilds.js"
export type {
    Guild,
    GuildDeletion,
    GuildRole,
    GuildRoleUpdateBulk,
    RoleReference,
    RolePosition,
    RoleHoistPosition,
    RoleCreate,
    RoleEdit,
    GuildMember,
    MemberReference,
    VoiceConnectionReference,
    MemberQuery,
    GuildOperation,
    GuildOperationFailure,
    GuildOperationOptions,
    GuildAuditOperationOptions,
} from "./guilds.js"
import {
    guildFetch,
    memberFetch,
    memberSelf,
    memberPage,
    memberRole,
    roleList,
    roleCreate,
    roleEdit,
    roleDelete,
    roleReorder,
    roleSetHoistPositions,
    roleResetHoistPositions,
} from "#sdk/internal/guilds"
import {
    memberTimeout,
    memberKick,
    memberVoiceMove,
    memberVoiceFlag,
    guildBan,
    guildUnban,
    guildBans,
} from "#sdk/internal/moderation"
import type { BanInput, GuildBan, ModerationOptions, TimeoutOptions } from "./guilds.js"
export type { BanInput, GuildBan, ModerationOptions, TimeoutOptions } from "./guilds.js"
import type { CachePolicyErrorReport, MessageCacheSettings } from "./cache.js"
export type { CachePolicyErrorReport, MessageCacheSettings } from "./cache.js"
export type { ResourceCacheSettings } from "./cache.js"

type HierarchyOperation = "hierarchy.compare" | "hierarchy.isAbove" | "hierarchy.canManage"

const hierarchyInputFailure = (operation: HierarchyOperation, path: string, explanation: string) =>
    new GuildOperationError(
        operation,
        "input",
        "notDispatched",
        null,
        null,
        null,
        inputValidationFailure(path, "format", explanation).detail,
    )

/**
 * Compare two supplied roles to decide which is higher in Fluxer's role hierarchy
 *
 * The Effect returns 1 when left is higher, -1 when right is higher, or 0 for the same role.
 * Larger positions rank higher. At tied positions, the smaller numeric role ID ranks higher.
 * Malformed roles or roles from different guilds fail with GuildOperationError operation hierarchy.compare and reason input.
 * Inputs are not retained. This does not fetch data or check permissions, MFA, membership visibility or whether an action is allowed
 */
export function compareHierarchy(left: GuildRole, right: GuildRole): Effect.Effect<-1 | 0 | 1, GuildOperationError> {
    return Effect.suspend(() => {
        const comparison = compareRoleHierarchy(left, right)
        return comparison === undefined
            ? Effect.fail(
                  hierarchyInputFailure(
                      "hierarchy.compare",
                      "roles",
                      "Role snapshots must contain same-guild decimal IDs and nonnegative 32-bit integer positions",
                  ),
              )
            : Effect.succeed(comparison)
    })
}

/**
 * Test whether the supplied left role is strictly higher than right, using compareHierarchy's ordering
 *
 * Malformed or cross-guild snapshots fail with GuildOperationError hierarchy.isAbove/input without retaining the input.
 * This compares role order locally, without checking permissions or whether a remote action is allowed
 */
export function isAboveInHierarchy(left: GuildRole, right: GuildRole): Effect.Effect<boolean, GuildOperationError> {
    return Effect.suspend(() => {
        const above = isRoleAboveInHierarchy(left, right)
        return above === undefined
            ? Effect.fail(
                  hierarchyInputFailure(
                      "hierarchy.isAbove",
                      "roles",
                      "Role snapshots must contain same-guild decimal IDs and nonnegative 32-bit integer positions",
                  ),
              )
            : Effect.succeed(above)
    })
}

/**
 * Test whether an actor member passes Fluxer's hierarchy rule for managing a target member.
 * Supply the guild, both members and their roles. The Effect performs no reads and retains no inputs
 *
 * The guild owner and a member targeting itself pass. A non-owner cannot manage the owner.
 * Other actors need a strictly higher assigned role. Members with no assigned roles rank below any supplied assigned role.
 * The roles input must contain one same-guild snapshot for every actor and target role ID.
 * The roles.fetchAll result may include the implicit everyone role, which is ignored for rank comparison.
 * Members must not list everyone as an assigned role.
 * Malformed, incomplete, duplicate, cross-guild or inconsistent inputs fail with GuildOperationError operation hierarchy.canManage and reason input.
 * A true result does not authorize an action. Permissions, MFA, endpoint checks, current membership and concurrent changes are not evaluated
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { canManageHierarchy, type Client } from "@neontechspace/fluxerly/effect"
 * export function hierarchyExample(client: Client, guildId: string, actorUserId: string, targetUserId: string) {
 *     return Effect.gen(function* () {
 *         const [guild, actor, target, roles] = yield* Effect.all([
 *             client.guilds.fetch(guildId),
 *             client.members.fetch({ guildId, userId: actorUserId }),
 *             client.members.fetch({ guildId, userId: targetUserId }),
 *             client.roles.fetchAll(guildId),
 *         ])
 *         return yield* canManageHierarchy({ guild, actor, target, roles })
 *     })
 * }
 * ```
 */
export function canManageHierarchy(input: RoleHierarchyInput): Effect.Effect<boolean, GuildOperationError> {
    return Effect.suspend(() => {
        const manageable = evaluateMemberHierarchy(input)
        return manageable === undefined
            ? Effect.fail(
                  hierarchyInputFailure(
                      "hierarchy.canManage",
                      "input",
                      "Hierarchy input must contain consistent guild, member, and unique role snapshots covering both members",
                  ),
              )
            : Effect.succeed(manageable)
    })
}

/** Configure optional in-memory message caching and its error callback.
 * The callback uses the services available when client creation executes and stops when the client closes */
export interface MessageCacheOptions<
    E = never,
    R = never,
    M extends MessageCore = Message,
> extends MessageCacheSettings<M> {
    /**
     * Report failures from the policy that decides which messages to cache, using the services available when client creation executes.
     * This callback is independent of HTTP results and event delivery.
     * Only one custom report runs at a time. Further failures while busy use the shared operational logger.
     * If the reporter fails, the SDK attempts one safe fallback log, without calling the hook again or retrying the policy.
     * Shutdown interrupts report work and awaits finalizers. Uninterruptible user work can delay closure
     */
    readonly onError?: (report: CachePolicyErrorReport) => Effect.Effect<unknown, E, R>
}

/**
 * Choose the client's connection, logging, message fields and optional caches.
 * The createClient function reads these options when its Effect executes, not when the Effect is built.
 * Required services for cache-error callbacks are captured at that time.
 * The sharding option fixes which gateway shards this client owns. Shard zero receives direct-message traffic.
 * HTTP and cache budgets apply to the whole client, not separately to each shard.
 * The messageFields option chooses which optional message fields are returned, including nested results, callbacks and cached messages.
 * Omission returns full Message objects. The selection cannot change after client creation.
 * TypeScript usually infers the type parameters from these options.
 * If supplying error and service types E and R explicitly with messageFields, also supply the selected-field tuple as F
 */
export interface ClientOptions<E = never, R = never, F extends MessageFields | undefined = undefined> extends Omit<
    SharedClientOptions<F>,
    "cache" | "logging"
> {
    /**
     * Set development to true to enable SDK connection logs, and measurements to true for low-cardinality operation timings.
     * Both are disabled when omitted. Logger, level, annotations, spans, tracing and the measurement clock come from the caller's Effect program.
     * Connection logs use connect or run's services, handler logs use registration services and cache reports use creation services.
     * Shutdown logs use shutdown's services. The SDK installs no separate runtime or replacement logger.
     * The logger and minimumLevel options belong to the default API and are rejected here.
     * A throwing logger cannot fail connection diagnostics or measurements
     */
    readonly logging?: LoggingOptions
    /** Optionally keep resource snapshots in memory. Omission keeps none.
     * Every configured budget applies across this client's locally owned shards.
     * A gateway gap invalidates known-scope snapshots from its affected shard. Unknown guild scope invalidates conservatively because the SDK keeps no channel-to-guild index
     */
    readonly cache?: Omit<NonNullable<SharedClientOptions<F>["cache"]>, "messages"> & {
        /**
         * Omit or pass false to disable caching. Pass true or an options object to keep bounded message snapshots in memory across the client.
         * Eligible HTTP responses and gateway events populate the cache.
         * Deletes and writes with unknown outcomes evict affected messages. Gateway gaps clear it even after successful resume.
         * Conflicts can produce misses. No automatic history retrieval. Shutdown releases cached references
         */
        readonly messages?: boolean | MessageCacheOptions<E, R, NoInfer<SelectedMessage<F>>>
    }
}
import type { ConfigurationError, ConnectError, ConnectionFailure } from "./errors.js"
import type {
    InstanceEndpoints,
    InstanceResolveError,
    InstanceResolveOptions,
    ResolvedInstance as DefaultResolvedInstance,
} from "./instance.js"
export type { InstanceEndpoints, InstanceOptions, InstanceResolveError, InstanceResolveOptions } from "./instance.js"
import { makeClient } from "#sdk/internal/client"
import type { MessagePinsQuery, MessagePinsPage } from "./pins.js"
export type { MessagePinsQuery, MessagePinsPage, MessagePin, ChannelPinsUpdate } from "./pins.js"
import { collect, type MessageCollector } from "#sdk/internal/collector"
import { collectReactions, type ReactionCollector as ReactionCollection } from "#sdk/internal/reaction-collector"
import type {
    ReactionCollectorOptions as SharedReactionCollectorOptions,
    ReactionCollectorResult,
} from "./collectors.js"
export type { ReactionCollectorResult } from "./collectors.js"

/** Choose reaction collection limits and an optional callback for each accepted addition.
 * The callback executes with the services available when collection is registered */
export interface ReactionCollectorOptions<E = never, R = never> extends SharedReactionCollectorOptions {
    /** Run once per accepted addition, sequentially, before continuing collection.
     * Failures and defects while active fail collection with CollectorError handler, without exposing the original cause.
     * Stop, timeout, idle completion, scope closure, recovery and shutdown interrupt active work and await its finalizers.
     * Uninterruptible work can delay closure. Do not await this collector's completion inside its handler.
     * Already-dispatched effects are not rolled back. Callbacks are never retried
     */
    readonly onReaction?: (reaction: import("./reactions.js").MessageReaction) => Effect.Effect<unknown, E, R>
}
import type {
    CollectorOptions as SharedCollectorOptions,
    CollectorResult,
    CollectorFailure,
    CollectorRegistrationError,
} from "./collectors.js"
export { CollectorError } from "./collectors.js"
export type { CollectorResult, CollectorFailure, CollectorRegistrationError } from "./collectors.js"

/** Choose message collection limits and an optional callback for each accepted message.
 * The callback executes with the services available when collection is registered */
export interface CollectorOptions<
    E = never,
    R = never,
    M extends MessageCore = Message,
> extends SharedCollectorOptions<M> {
    /** Run once per accepted message ID, sequentially, after filtering and stored-byte limit checks.
     * Failures and defects while active fail collection with CollectorError handler, without exposing the original cause.
     * Stop, timeout, idle completion, scope closure, recovery and shutdown interrupt active work and await its finalizers.
     * Uninterruptible work can delay closure. Do not await this collector's completion or client shutdown inside its handler.
     * Already-dispatched effects are not rolled back. Callbacks are never retried
     */
    readonly onMessage?: (message: M) => Effect.Effect<unknown, E, R>
}
import type { EventSource } from "#sdk/internal/events"
import { waitForEvent } from "#sdk/internal/events"
import {
    type MessageOperationFailure,
    type EventOverflowError,
    type RegistrationError,
    type SendError,
} from "./message-errors.js"
import {
    type MessageCleanupFailure,
    type MessageCleanupOptions,
    type MessageCleanupPlan,
    type MessageCleanupReport,
    type MessageCleanupSelection,
} from "./message-cleanup.js"
import { cleanup, previewCleanup } from "#sdk/internal/message-cleanup"
import type {
    EditMessageInput,
    ForwardMessageInput,
    MessageHistoryQuery,
    Message,
    MessageCore,
    MessageFields,
    SelectedMessage,
    MessageReference,
    MessageInput,
    MessageOperationOptions,
    ReplyInput,
    SendOptions,
} from "./messages.js"
import type {
    EventBufferOptions,
    EventWaitOptions,
    HandlerOptions,
    HandlerErrorReport,
    EventMap,
    EventName,
} from "./events.js"
import type { EventWaitFailure } from "./message-errors.js"

export { EventOverflowError, EventReadBusyError, MessageError, MessageOperationError } from "./message-errors.js"
export { EventWaitError } from "./message-errors.js"
export type { EventWaitFailure } from "./message-errors.js"
export type { EventWaitOptions } from "./events.js"
export type { ApiErrorDetail, ApiValidationErrorDetail } from "./api-errors.js"
export type { InputValidationConstraint, InputValidationDetail } from "./input-validation.js"
import { inputValidationFailure } from "./input-validation.js"
export { MessageCleanupError } from "./message-cleanup.js"
export { MessageFlags } from "./messages.js"
export type { EventReadError, RegistrationError, SendError, MessageOperationFailure } from "./message-errors.js"
export type {
    MessageCleanupBatch,
    MessageCleanupErrorReason,
    MessageCleanupFailure,
    MessageCleanupFailureMetadata,
    MessageCleanupOptions,
    MessageCleanupOutcome,
    MessageCleanupPlan,
    MessageCleanupProgress,
    MessageCleanupReport,
    MessageCleanupSelection,
    MessageCleanupStopReason,
    DefaultMessageCleanupOptions,
} from "./message-cleanup.js"
export type {
    Message,
    MessageCore,
    MessageField,
    MessageFields,
    SelectedMessage,
    ForwardMessageInput,
    MessageSnapshot,
    MessageFlag,
    MessageSticker,
    MessageMention,
    MessageUser,
    ReferencedMessage,
    MessageChannelMention,
    MessageReactionEmoji,
    MessageReactionSummary,
    MessageContextReference,
    MessageHistoryQuery,
    MessageDeletion,
    MessageBulkDeletion,
    MessageReference,
    MessageInput,
    MessageNonce,
    ReplyInput,
    AllowedMentions,
    SendOptions,
    EditMessageInput,
    MessageOperationOptions,
} from "./messages.js"
export type {
    EventBufferOptions,
    HandlerOptions,
    HandlerErrorReport,
    EventMap,
    EventName,
    TypingStart,
    PresenceUpdate,
    PresenceUpdateBulk,
    VoiceState,
    VoiceStateSnapshot,
} from "./events.js"

/**
 * An event subscription registered in a Scope, independent of the client's connection.
 * Use unsubscribe to request a stop and waitForClose to wait for handler cleanup
 */
export interface Subscription {
    /**
     * Stop this subscription when the Effect executes.
     * Discard queued events and interrupt its handlers without waiting for the handler that called unsubscribe to finish
     */
    unsubscribe(): Effect.Effect<void>
    /**
     * Wait for this subscription's retained closure or overflow result after handler cleanup.
     * Cancelling this wait does not unsubscribe or affect other waiters. Unexpected faults remain in Cause.
     * Handlers or finalizers that disable interruption can delay completion.
     * Do not await this subscription's own closure from inside its handler
     */
    waitForClose(): Effect.Effect<void, EventOverflowError>
}

/** Set event-handler queue limits, concurrency and an optional safe error callback.
 * Reporting uses the services available when the handler is registered */
export interface EventHandlerOptions<E = never, R = never> extends HandlerOptions {
    /** Report handler failures or queue overflow with safe metadata.
     * If reporting fails, the SDK attempts one safe fallback log without retrying the handler.
     * Receives event/kind only, not the original Cause. Inspect application failures inside the handler, as shown on Client.on
     */
    readonly onError?: (report: HandlerErrorReport) => Effect.Effect<unknown, E, R>
}

/** Refresh signed attachment URL strings explicitly, or download attachment bytes in one result or as chunks.
 * Methods return Effects or Streams, do not need a gateway connection and use no cached bytes */
export interface Attachments {
    /** Ask Fluxer's bot-authenticated API to reissue signatures for 1 through 50 URL strings.
     * Each string may contain at most 2,048 UTF-16 code units. Strings, duplicates and query parameters are sent unchanged
     *
     * The frozen result has one original/refreshed pair per input in the same order. A string outside this instance's attachment URL space is returned unchanged by Fluxer. Refreshing checks neither attachment existence nor membership, download permission or media availability
     *
     * This Effect starts no media request and sends the bot credential only to the selected instance's API. The POST follows no redirect. Call download explicitly afterward for a returned instance attachment URL
     *
     * The timeoutMs default is 30,000 across discovery, the shared REST queue, rate-limit waits and response reading. A confirmed 429 can retry after its required wait. An uncertain POST or malformed success is not retried automatically. Interruption cancels only this execution and awaits cleanup. HTTP 404 cannot distinguish an older unsupported deployment from an unavailable route or denied access. No hidden refresh occurs while reading messages or downloading
     */
    refreshUrls(
        urls: readonly string[],
        options?: AttachmentRefreshOptions,
    ): Effect.Effect<readonly RefreshedAttachmentUrl[], AttachmentRefreshFailure>
    /** Download attachment.url after matching it against this instance's discovered media `/attachments/` base path.
     * The required maxBytes option limits returned bytes to 50 MiB. Packing can briefly retain response chunks beside that result, so it is not a total memory limit. The SDK sends no Authorization header, follows no redirect, caches nothing and never falls back to proxyUrl.
     * The timeoutMs default is 30,000 across endpoint resolution, the four media download slots and GET. Media slots are separate from the four REST/upload slots and do not wait for bot API rate limits. Interruption awaits response-reader cleanup and cannot undo already received bytes.
     * URL expiry metadata is not an availability check. Failures contain a safe reason/status, including local busy, without a URL or response body
     */
    download(
        attachment: Attachment,
        options: AttachmentDownloadOptions,
    ): Effect.Effect<Uint8Array, AttachmentDownloadFailure>
    /** Read attachment.url as one-use chunks after matching this instance's media `/attachments/` base path.
     * The first pull starts discovery, four-slot media concurrency limits and GET, independently of the four REST/upload slots. Each later pull reads at most one response chunk, with no SDK byte packing, spooling, retry or durable storage
     *
     * The required maxBytes option limits bytes delivered across this consumption to 50 MiB. A declared Content-Length above it fails before the first chunk, while runtime counting remains authoritative
     *
     * The timeoutMs default is 30,000 across opening, consumer pauses and reads. Scope interruption, early stream completion, failures and shutdown cancel the body, await reader cleanup and release the slot
     *
     * This Stream is single-consumption. Expected failures retain their native Effect causes, including safe local busy/network/response/limit/deadline reasons and client closure
     *
     * The GET sends no Authorization header, follows no redirect, caches nothing and never uses proxyUrl. Attachment size and expiry metadata do not establish availability or byte safety
     * @example
     * ```ts
     * import { Effect, Stream } from "effect"
     * import type { Attachment, Client } from "@neontechspace/fluxerly/effect"
     * export function downloadChunks(client: Client, attachment: Attachment) {
     *     return Stream.runForEach(client.attachments.stream(attachment, { maxBytes: 1_024 }), (chunk) =>
     *         Effect.sync(() => void chunk),
     *     )
     * }
     * ```
     */
    stream(
        attachment: Attachment,
        options: AttachmentDownloadOptions,
    ): Stream.Stream<Uint8Array, AttachmentDownloadFailure>
}

/**
 * Send, read, edit or delete messages, collect future replies and reactions, or inspect indexed search results.
 * Methods return Effects or Streams. HTTP requests and local lookups do not require a gateway connection
 *
 * Results use the messageFields chosen at client creation, or full Message objects by default. Nested results, callbacks and cached snapshots use the same selection
 *
 * A collector with guildId requires that guild's local shard to be ready. A channel-only collector requires the client to be Connected. Closing or Closed clients reject new work
 *
 * Up to four REST or upload requests run at once across this client, regardless of shard. Attachment downloads have four separate slots. The shared queue holds at most 256 requests or 4 MiB of JSON bodies.
 * Each remote call has a 30,000 ms total deadline by default. Queue, retry and rate-limit waits count toward it. Cleanup is awaited afterward
 *
 * The fetch, fetchHistory, fetchReactionUsers and fetchPins methods retry transport failures and HTTP 500/502/503/504 at most twice.
 * Retry delays are jittered 125–250 ms then 250–500 ms, or a valid longer Retry-After. Retries never reset the deadline.
 * A retry reads the same target and query, but does not guarantee an unchanged snapshot. Other rejections and malformed successes never retry.
 * Confirmed HTTP 429 responses use the applicable route or client-wide rate-limit wait. They do not count against the two transient-read retries
 *
 * Writes retry only confirmed rate-limit rejections, never requests whose outcome is unknown
 *
 * Successful REST JSON responses are limited to 16 MiB before parsing. This is not a total memory limit. Oversized or malformed responses fail with reason response and do not retry.
 * If a response fails after a write was sent, the write may still have applied. The SDK does not assume rollback
 *
 * Expected failures use Effect's error channel. Defects, interruption and cleanup failures remain in Cause, even when several happen together.
 * Interruption or client closure waits for SDK-owned cleanup but cannot undo a write already sent
 */

export interface Messages<M extends MessageCore = Message> {
    /** Traverse remote history newest-to-oldest as a Stream that starts when consumed, without connecting or prefetching another page.
     * Each execution copies inputs and tracks its own progress using the caller's services, without a separate SDK runtime
     *
     * The maxItems option is required. The pageSize and maxPages options follow PaginationQuery. The timeoutMs option applies separately to each remote page
     *
     * Emits frozen snapshots. PaginationError covers input, cursorStalled and pageLimit. Remote failures keep fetchHistory's operation
     *
     * Interruption and defects retain Cause, including cleanup failures. Termination awaits in-flight request finalizers.
     * Stream early termination releases buffered items. Closing/Closed also releases the page and fails the next pull
     *
     * Retains one bounded page, not all results. Enabled message caching follows fetchHistory's normal cache-storage rules.
     * Stops at maxItems or an empty remote page, not a short page. Separate pages are not a consistent snapshot.
     * Delivered items remain caller-owned after a later error. Caller processing is not retried or rolled back
     * @example
     * ```ts
     * import { Effect, Stream } from "effect"
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export const paginationHistoryExample = (client: Client, channelId: string) =>
     *     client.messages.iterateHistory(channelId, { maxItems: 500 }).pipe(
     *         Stream.runForEach(message => Effect.sync(() => message.content.length)),
     *     )
     * ```
     */
    iterateHistory(
        channelId: string,
        query: HistoryIterationQuery,
        options?: MessageOperationOptions,
    ): Stream.Stream<M, MessageOperationFailure | PaginationError>
    /** Search one page of indexed messages in a specified guild or channel, without gateway readiness or cache use.
     * Fluxerly always sends the search scope named current. Completion is either an immutable indexing state or an immutable observed result page.
     * Reads recognized query fields, including inherited and nonenumerable properties, and copies their arrays when the Effect executes.
     * An indexing result never starts polling. The caller decides whether to run another search.
     * Use page numbers from 1 through 400 for later requests, keeping limit unchanged. Fluxer does not honor returned cursors.
     * Invalid input, malformed success and POST failure use MessageOperationError operation search. This POST has no transient-read retry.
     * Confirmed rate limits retain shared REST handling. Interruption retains the Cause and releases only this request
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export const messageSearchPageExample = (client: Client, channelId: string) => Effect.gen(function* () {
     *     return yield* client.messages.search({ channelId }, { content: "release notes" })
     * })
     * ```
     */
    search(
        context: MessageSearchContext,
        query?: MessageSearchQuery,
        options?: MessageOperationOptions,
    ): Effect.Effect<MessageSearchPage<M>, MessageOperationFailure>
    /** Read indexed messages from a specified guild or channel, following numbered pages without polling, prefetching or automatic cache population.
     * The maxItems option is required. The pageSize range is 1–25 and maxPages defaults to 100. Each execution holds input copies and one page at a time.
     * Recognized filter fields, including inherited and nonenumerable properties, are read and their arrays copied per stream consumption.
     * Request capacity stays at the smaller of pageSize and maxItems throughout the scan. Only maxItems hits are delivered.
     * An indexing page ends with PaginationError indexing. An unexpected echoed page number or capacity ends with cursorStalled.
     * Reaching maxPages or Fluxer's 400-page ceiling with more matches fails with pageLimit. Index changes can still skip or repeat observations.
     * Delivered snapshots remain caller-owned after a later failure. Interruption and stream-scope closure await owned request cleanup
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export const messageSearchTraversalExample = (client: Client, guildId: string) =>
     *     client.messages.iterateSearch({ guildId }, { content: "todo" }, { maxItems: 100 })
     * ```
     */
    iterateSearch(
        context: MessageSearchContext,
        filters: Omit<MessageSearchQuery, "limit" | "page">,
        limits: MessageSearchIterationLimits,
        options?: MessageOperationOptions,
    ): Stream.Stream<M, MessageOperationFailure | PaginationError>
    /** Traverse ascending remote user IDs for one message and the selected literal Unicode or custom emoji.
     * Like iterateHistory, this Stream starts when consumed and uses per-page deadlines, the caller's services and the same interruption and cleanup behavior.
     * Stops at maxItems or hasMore=false. Remote errors retain fetchReactionUsers's operation.
     * No reactor cache or automatic member lookup. Concurrent removals can invalidate earlier snapshots
     * @example
     * ```ts
     * import { Stream } from "effect"
     * import type { Client, MessageReference } from "@neontechspace/fluxerly/effect"
     * export const paginationReactionExample = (client: Client, message: MessageReference, userId: string) =>
     *     client.messages.iterateReactionUsers(message, "👍", { maxItems: 500 }).pipe(
     *         Stream.filter(user => user.id === userId), Stream.take(1), Stream.runCollect,
     *     )
     * ```
     * An empty result means not found within this bounded scan, not proof that the user has never reacted
     */
    iterateReactionUsers(
        message: MessageReference,
        emoji: ReactionEmojiInput,
        query: UserIterationQuery,
        options?: MessageOperationOptions,
    ): Stream.Stream<import("./reactions.js").ReactionUser, MessageOperationFailure | PaginationError>
    /** Traverse remote pins in descending timestamp order without populating the message cache.
     * Like iterateHistory, this Stream starts when consumed and uses per-page deadlines, the caller's services and the same interruption and cleanup behavior.
     * PinIterationQuery defines per-run deduplication and completeness limits. Retains at most maxItems deduplication IDs.
     * Remote errors retain fetchPins's operation. Valid stalled-page items may emit before cursorStalled on the next pull.
     * Stops at maxItems or hasMore=false. Timestamp ties can prevent enumerating every pin even without concurrent edits
     * @example
     * ```ts
     * import { Stream } from "effect"
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export const paginationPinsExample = (client: Client, channelId: string) =>
     *     client.messages.iteratePins(channelId, { maxItems: 20 }).pipe(
     *         Stream.map(pin => pin.message.id), Stream.runCollect,
     *     )
     * ```
     */
    iteratePins(
        channelId: string,
        query: PinIterationQuery,
        options?: MessageOperationOptions,
    ): Stream.Stream<import("./pins.js").MessagePin<M>, MessageOperationFailure | PaginationError>
    /**
     * Pin one message identified by decimal id and channelId, without requiring gateway readiness.
     * Execution preserves the caller's services, interruption and unexpected faults
     *
     * Completes on HTTP 204, not event delivery. Fluxer enforces channel access and PIN_MESSAGES for guild pins.
     * A new pin creates a system message and gateway notifications. Already-pinned targets are unchanged
     *
     * Share HTTP concurrency and queue limits and the per-channel pins rate bucket with unpin/fetchPins.
     * Default deadline is 30,000 ms. Only confirmed 429 rejection permits automatic retry within that deadline
     *
     * Expected failures use MessageOperationError operation pin, or ClientClosedError after shutdown.
     * Local invalid input is notDispatched. Lost responses/cancellation cannot prove whether the server applied the pin
     *
     * Confirmed or uncertain mutations evict the cached target, without guessing pinned status or fetching it.
     * No automatic unpin or rollback. No locally synthesized events
     *
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import type { Client, MessageReference } from "@neontechspace/fluxerly/effect"
     *
     * export const pinsExample = (client: Client, message: MessageReference) => Effect.gen(function* () {
     *     yield* client.messages.pin(message)
     *     const page = yield* client.messages.fetchPins(message.channelId, { limit: 25 })
     *     yield* client.messages.unpin(message)
     *     return page
     * })
     * ```
     * The caller owns error recovery and client lifetime. These calls are not an atomic transaction
     */
    pin(message: MessageReference, options?: MessageOperationOptions): Effect.Effect<void, MessageOperationFailure>
    /**
     * Unpin one explicit message using pin's request concurrency and queue limits, deadline, retry, cancellation and cache-invalidation rules.
     * Execution preserves the caller's services, interruption and unexpected faults.
     * Completes on HTTP 204, including an already-unpinned message. Expected failures identify operation unpin.
     * Fluxer enforces the same permissions as pin. Closing/Closed clients fail with ClientClosedError.
     * Unpinning does not delete the message or the system message created by pinning, and does not reset the last-pin timestamp.
     * No gateway readiness, automatic rollback, event synthesis or confirmation fetch
     */
    unpin(message: MessageReference, options?: MessageOperationOptions): Effect.Effect<void, MessageOperationFailure>
    /**
     * Fetch one frozen pin page for a decimal channel ID, without gateway readiness, cache reads or cache population.
     * Execution preserves the caller's services, interruption and unexpected faults
     *
     * Query defaults to limit 50 and the server's current time. Limit is 1 through 50 and before is an ISO timestamp
     *
     * Results use descending pin-time order with preserved pinnedAt values and an explicit nextBefore cursor.
     * Timestamp ties may repeat messages across pages. Deduplicate IDs and stop on a non-advancing cursor.
     * No automatic traversal, complete-list guarantee, pin acknowledgement or snapshot isolation
     *
     * Share pin's request concurrency and queue limits, 30,000 ms default deadline and per-channel rate bucket, using Messages' bounded read-retry policy
     *
     * Invalid input and malformed responses use MessageOperationError operation fetchPins without partial pages.
     * Visibility/history permissions can limit results. An empty page does not prove the channel has no pins.
     * Closing/Closed uses ClientClosedError. Returned messages are snapshots, not live state
     */
    fetchPins(
        channelId: string,
        query?: MessagePinsQuery,
        options?: MessageOperationOptions,
    ): Effect.Effect<MessagePinsPage<M>, MessageOperationFailure>
    /**
     * Remove one named user's reaction, leaving other users and emoji groups untouched.
     * `userId` is a required decimal ID. Naming the bot removes its own reaction
     *
     * Uses addReaction's emoji inputs, HTTP concurrency and queue limits, 30,000 ms default deadline, retry and interruption rules.
     * No gateway readiness is required. Completes on HTTP 204, without waiting for or synthesizing events
     *
     * Fluxer enforces visibility and history access. For another user, the bot must author the message or have MANAGE_MESSAGES in its guild
     *
     * Expected failures use MessageOperationError with operation removeUserReaction, or ClientClosedError.
     * Execution preserves the caller's services and unexpected faults
     *
     * Cleanup is awaited, but cannot undo a deletion request already sent. Only confirmed 429 rejections retry.
     * Success means absent or removed, not proof the reaction existed. Unknown outcomes are not replayed
     *
     * No cache mutation, automatic restoration or per-user state is retained. The bot cannot restore another user's reaction as them
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import type { Client, MessageReference } from "@neontechspace/fluxerly/effect"
     * export const reactionModerationExample = (client: Client, message: MessageReference, userId: string) =>
     *     Effect.gen(function* () {
     *         yield* client.messages.removeUserReaction(message, "👍", userId)
     *         yield* client.messages.clearReaction(message, "👍")
     *         yield* client.messages.clearReactions(message)
     *     })
     * ```
     */
    removeUserReaction(
        message: MessageReference,
        emoji: ReactionEmojiInput,
        userId: string,
        options?: MessageOperationOptions,
    ): Effect.Effect<void, MessageOperationFailure>
    /**
     * Delete every user's reaction for one emoji, preserving other emoji groups.
     * Uses removeUserReaction's execution, permission, deadline, failure and cleanup rules, with operation clearReaction.
     * Complete on HTTP 204. Success does not prove reactions existed or that this call removed them.
     * Fluxer emits a clear-emoji event, not individual removal events. The SDK does not synthesize or await it.
     * Destructive: Other users' reactions cannot be restored by the bot as those users
     */
    clearReaction(
        message: MessageReference,
        emoji: ReactionEmojiInput,
        options?: MessageOperationOptions,
    ): Effect.Effect<void, MessageOperationFailure>
    /**
     * Delete every user's reactions for every emoji on this message, without deleting the message.
     * Uses clearReaction's execution, permission, deadline, failure and cleanup rules, with operation clearReactions.
     * Takes no emoji selector. Complete on HTTP 204, whether reactions were present or absent.
     * Fluxer emits one clear-all event, not per-emoji or per-user events. The SDK does not synthesize or await it.
     * Destructive: Other users' reactions cannot be restored by the bot as those users
     */
    clearReactions(
        message: MessageReference,
        options?: MessageOperationOptions,
    ): Effect.Effect<void, MessageOperationFailure>
    /**
     * Fetch one frozen page of users who currently hold the specified reaction, without requiring gateway readiness.
     * Accept the same literal Unicode or custom emoji input as addReaction
     *
     * Limit defaults to 25 (1–100). After is an exclusive user-ID cursor in ascending order, not reaction time.
     * Empty reactions return an empty terminal page. No automatic pagination, user cache or message-cache changes.
     * Pages are separate snapshots: Reactions may change between requests. No complete or atomic snapshot is promised
     *
     * Use the shared 30,000 ms deadline by default, overridden by options.timeoutMs.
     * Share HTTP concurrency and queue limits, global limits and the channel bucket used by reaction mutations.
     * Uses Messages' bounded read-retry policy within the original deadline, including separate confirmed-429 waits
     *
     * Invalid inputs, malformed pages, HTTP rejections, transport and deadlines use MessageOperationError with operation fetchReactionUsers.
     * HTTP 404 means notFound. Permission/history visibility is enforced by Fluxer. Closed clients use ClientClosedError
     *
     * Execution preserves the caller's services. Interruption awaits request cleanup. Unexpected defects remain in Cause
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import type { Client, MessageReference } from "@neontechspace/fluxerly/effect"
     * export const reactionUsersExample = (client: Client, message: MessageReference) =>
     *     Effect.gen(function* () {
     *         const page = yield* client.messages.fetchReactionUsers(message, "👍", { limit: 25 })
     *         if (page.nextAfter !== null)
     *             return yield* client.messages.fetchReactionUsers(message, "👍", { after: page.nextAfter })
     *         return page
     *     })
     * ```
     */
    fetchReactionUsers(
        message: MessageReference,
        emoji: ReactionEmojiInput,
        query?: ReactionUsersQuery,
        options?: MessageOperationOptions,
    ): Effect.Effect<ReactionUsersPage, MessageOperationFailure>
    /**
     * Add the bot's own reaction and complete after HTTP 204, without waiting for or synthesizing a gateway event.
     * Accept Unicode, static or animated custom markup, a parsed custom emoji, or a received emoji snapshot.
     * ReactionEmojiInput defines local validation. Custom emoji are encoded as name:id. Fluxer checks availability and permissions
     *
     * No gateway readiness is required. Use the shared 30,000 ms deadline by default. `timeoutMs` overrides it.
     * Share HTTP concurrency and queue limits and global rate limits, with a channel reaction bucket separate from message operations.
     * Only confirmed rate-limit rejections retry within the original deadline. Unknown outcomes are never retried
     *
     * Input, queue, rejection, transport and timeout failures use MessageOperationError. Closed clients use ClientClosedError
     *
     * Execution preserves the caller's services. Interruption awaits cleanup but cannot undo a reaction request already sent.
     * Unexpected defects retain Cause
     *
     * Adding the bot's existing reaction again leaves it unchanged on the server.
     * No local reaction state, counts or reactor lists are retained
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import type { Client, MessageReference } from "@neontechspace/fluxerly/effect"
     * export const reactionExample = (client: Client, message: MessageReference) =>
     *     Effect.gen(function* () {
     *         yield* client.messages.addReaction(message, "👍")
     *         yield* client.messages.removeReaction(message, "👍")
     *     })
     * ```
     */
    addReaction(
        message: MessageReference,
        emoji: ReactionEmojiInput,
        options?: MessageOperationOptions,
    ): Effect.Effect<void, MessageOperationFailure>
    /**
     * Remove only the bot's own reaction and complete after HTTP 204.
     * Uses addReaction's input, queue limits, timeout, retry, failure and interruption rules.
     * Success does not prove the reaction previously existed or that this call removed it.
     * Other users' reactions are untouched. Neither this operation nor gateway reaction events alter the message cache
     */
    removeReaction(
        message: MessageReference,
        emoji: ReactionEmojiInput,
        options?: MessageOperationOptions,
    ): Effect.Effect<void, MessageOperationFailure>
    /**
     * Collect future messages from one decimal channel ID within the caller's executing Scope.
     * Each execution returns a ready handle before subsequent sends.
     * Collection does not read history or caches, connect the client or match replies to a prompt automatically
     *
     * With options.guildId, the caller supplies the channel's owning guild and intake accepts only that locally owned ready shard. Known conflicting event guilds are discarded without a channel lookup.
     * Without guildId, channel-only collection retains conservative aggregate recovery: Any gateway gap ends it because its guild scope is unknown
     *
     * Defaults: One accepted message, 30,000 ms total lifetime, 4 MiB retained selected-message JSON.
     * Pending intake separately allows 256 payloads or 4 MiB incoming JSON after channel selection, before synchronous filtering.
     * Options are copied when executed. Budgets are positive safe integers. The timeoutMs and idleMs maximum is 2,147,483,647
     *
     * The deadline starts when registered, never resets, and excludes messages processed at or after it, including slow filter returns.
     * Optional idleMs starts at registration and resets only after each accepted ID, before its callback. Omitted means disabled.
     * Queued, rejected and duplicate messages do not renew idleMs. Callback time counts. The earlier deadline wins, with timeout winning ties
     *
     * Counts each accepted ID once and keeps frozen received snapshots, unaffected by later edits or deletions
     *
     * Filter/overflow failures return no partial messages. Recovery fails with CollectorError connectionLost, without auto restart or resend.
     * Require Connected or fail with CollectorError notConnected. Closing/Closed use ClientClosedError. Invalid settings use ConfigurationError
     *
     * The registration scope stops its collector with partial replies. Client shutdown fails it with ClientClosedError.
     * Interrupting a waiter does not stop collection. Closing its registration scope does. No AbortSignal option or separate SDK runtime.
     * Defects retain Cause. Slow synchronous filters block JavaScript and cannot be preempted or have their side effects undone
     *
     * Optional onMessage runs sequentially in Effect services available at registration after filtering, ID deduplication and stored-byte limit checks.
     * Limit completion waits for the final callback. Idle/timeout/stop may retain a message whose callback was interrupted.
     * Once the accepted count is reached, later messages are ignored while the final callback finishes
     *
     * Handler failure ends collection with CollectorError handler. Terminal cleanup defects remain in Cause.
     * Scope closure and client shutdown await callback cleanup. Pending budgets exclude the active message.
     * Callbacks are never retried and their effects are not rolled back
     *
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import type { Client } from "@neontechspace/fluxerly/effect"
     *
     * export const askName = (client: Client, channelId: string, userId: string) => Effect.scoped(
     *     Effect.gen(function* () {
     *         const collector = yield* client.messages.collect(channelId, { filter: message => message.author.id === userId })
     *         yield* client.messages.send(channelId, { content: "What name should the bot use?" })
     *         return yield* collector.waitForClose()
     *     }),
     * )
     * ```
     * The caller supplies a connected client and handles empty timeout results and client lifetime separately
     *
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import type { Client } from "@neontechspace/fluxerly/effect"
     *
     * export const messageCollectorProgressExample = (client: Client, channelId: string, userId: string) => Effect.scoped(
     *     Effect.gen(function* () {
     *         const collector = yield* client.messages.collect(channelId, {
     *             filter: message => message.author.id === userId,
     *             maxMessages: 3,
     *             idleMs: 5_000,
     *             onMessage: message => client.messages.reply(message, { content: "Received your reply" }),
     *         })
     *         return yield* collector.waitForClose()
     *     }),
     * )
     * ```
     * The author filter must exclude the bot itself to avoid collecting its acknowledgements. Five quiet seconds end intake with reason idle, then await callback cleanup
     */
    collect<E = never, R = never>(
        channelId: string,
        options?: CollectorOptions<E, R, M>,
    ): Effect.Effect<Collector<M>, CollectorRegistrationError, Scope.Scope | R>
    /**
     * Collect future reaction additions for one message with decimal id and channelId in the caller's Scope.
     * Execute before the expected reaction. No REST request, existing-reactor lookup, implicit connect or cache reads
     *
     * With options.guildId, the caller supplies the target channel's owning guild and intake accepts only that locally owned ready shard. Known conflicting event guilds are discarded without a membership lookup.
     * Without guildId, target-only collection retains conservative aggregate recovery: Any gateway gap ends it because its guild scope is unknown
     *
     * Defaults: One accepted addition, 30,000 ms total lifetime and 4 MiB retained MessageReaction JSON.
     * Copy target IDs/options when executed. Pending intake allows 256 payloads or 4 MiB full incoming JSON.
     * Message selection precedes buffering. Synchronous user/emoji filtering follows it
     *
     * Optional emoji uses addReaction's input shape and is copied when executed. Matching precedes filter but follows queue-limit checks.
     * Unicode requires exact text and no custom ID. Custom emoji match by ID, ignoring renames. Invalid selectors use ConfigurationError emoji
     *
     * Single additions and received batches share receive order. Batch entries retain their order and count individually.
     * A batch occupies one pending slot. Repeated user/emoji pairs count again. No batching flag is enabled.
     * Removals, clears and message deletion neither undo snapshots nor stop collection. This is not a vote tally
     *
     * The deadline never resets and excludes snapshots processed at or after it, including slow filter returns.
     * Optional idleMs starts at registration and resets after each accepted addition, before its callback. Omitted means disabled.
     * Excluded, rejected, queued and unprocessed batch entries do not renew it. Callback time counts. The earlier deadline wins, with timeout winning ties.
     * The timeoutMs and idleMs options require integers from 1 through 2,147,483,647
     *
     * Filter/overflow failures use CollectorError without partial results. Recovery fails with connectionLost, without restart.
     * Require Connected or fail with CollectorError notConnected. Closing/Closed use ClientClosedError.
     * Invalid target/options use ConfigurationError. Registration does not verify remote message existence or access
     *
     * Registration scope closure stops collection with partial results. Client shutdown fails it with ClientClosedError.
     * Waiter interruption does not stop collection. No AbortSignal option or separate SDK runtime. Defects retain Cause
     *
     * Optional onReaction runs after acceptance and byte-limit checks, sequentially, in the Effect services available at registration.
     * Limit completion waits for the final callback. Idle/timeout/stop may retain an addition whose callback was interrupted.
     * Pending budgets exclude the active payload, including its unprocessed batch entries. No callback retries or vote reconstruction.
     * Handler failure ends this collector with CollectorError handler. Defects during terminal cleanup remain in Cause
     *
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import type { Client, MessageReference } from "@neontechspace/fluxerly/effect"
     *
     * export const reactionCollectorExample = (client: Client, message: MessageReference, userId: string) => Effect.scoped(
     *     Effect.gen(function* () {
     *         const collector = yield* client.messages.collectReactions(message, {
     *             maxReactions: 3,
     *             idleMs: 5_000,
     *             emoji: "✅",
     *             filter: reaction => reaction.userId === userId,
     *             onReaction: reaction => client.messages.edit(message, { content: `Accepted addition by ${reaction.userId}` }),
     *         })
     *         return yield* collector.waitForClose()
     *     }),
     * )
     * ```
     * The caller supplies a connected client and an existing message. Idle or timeout may return no reactions
     */
    collectReactions<E = never, R = never>(
        message: MessageReference,
        options?: ReactionCollectorOptions<E, R>,
    ): Effect.Effect<ReactionCollector, CollectorRegistrationError, Scope.Scope | R>
    /**
     * Read a frozen local snapshot when executed, never making a request.
     * Disabled, absent, evicted, expired or wrong-channel entries yield undefined, not proof of server absence.
     * Hits update eviction recency without renewing age and do not guarantee current server state.
     * Invalid references fail with MessageOperationError operation get, reason input, outcome notDispatched.
     * Closing/Closed fail with ClientClosedError. Defects and interruption retain Effect's error channel and Cause
     */
    get(message: MessageReference): Effect.Effect<M | undefined, MessageOperationFailure>
    /**
     * Send text, embeds, files or stickers without requiring a connected gateway. Closing/Closed reject new work
     *
     * Embed images/thumbnails may use attachment://filename for a matching new image upload in this execution.
     * Optional flags accept only MessageFlags' non-voice bits. Suppressing previews is distinct from omitting embeds
     *
     * Each attachment uses exactly one source: Bytes in `data`, a sized Blob/File-compatible source, or a finite stream with its exact size.
     * Sources are limited to 50 MiB per file and the separate uploads.maxBytes budget. Servers may impose lower limits
     *
     * Each execution copies data bytes before any wait. Full upload or queue capacity fails with busy before copying.
     * File and stream sources are not copied or spooled. Their supplied references are captured at execution, and readers are acquired when uploading starts.
     * Keep file data stable while it is read. A stream is consumed at most once and must deliver exactly its declared byte count.
     * The SDK accepts no path strings or implicit URL downloads. It owns acquired readers, not caller paths or FileHandles
     *
     * Uploads use presigned planning or an inline multipart fallback. Cleanup cancels unfinished readers and awaits lock release.
     * Failed uploads may leave temporary server data, with no physical-erasure guarantee
     *
     * Returns the created snapshot after an API response, not gateway delivery or recipient acknowledgement.
     * Mention notifications default off. Deadline defaults to 30,000 ms across queue waits, rate-limit waits and HTTP.
     * Enabled caching retains eligible created snapshots without changing send completion or delivery
     *
     * One client admits four REST/upload requests plus four independent attachment downloads. Both pools share at most 256 pending requests or 4 MiB of pending JSON
     *
     * Only confirmed rate-limit rejections can retry within the deadline. Ambiguous sends never retry automatically.
     * An inline multipart HTTP 429 retries copied data only. Any file or stream source instead fails with rateLimit without reopening or rereading it
     *
     * Input nonce accepts a 1-32 character string or nonnegative safe integer. Omission creates one SDK nonce per execution, while an explicit nonce is retained through confirmed rate-limit retries.
     * Fluxer duplicate suppression is best effort for five minutes after persistence. It is not durable idempotency, exactly-once delivery or a concurrent atomicity guarantee
     *
     * Interruption awaits owned HTTP cleanup but cannot undo a server-side creation.
     * Typed failures, defects and interruption retain Effect's error channel and Cause, including cleanup causes
     */
    send(channelId: string, input: MessageInput, options?: SendOptions): Effect.Effect<M, SendError>
    /** Forward an accessible source message into an explicit destination, without fetching or caching the source.
     * Each execution starts a separate send. No gateway connection is required. Closing/Closed fail with ClientClosedError
     *
     * Optional media selections belong to the source. Extra content, files, mentions and flags are rejected
     *
     * Returns the created message after HTTP, with frozen messageSnapshots rather than live views of later source edits.
     * Uses send's shared request concurrency and queue limits, optional destination-message caching and 30,000 ms default total deadline
     *
     * Fluxer checks source access and destination permissions. Only confirmed rate-limit rejection retries
     *
     * Input nonce follows send's 1-32 character string/nonnegative-safe-integer contract, SDK-generated default and retry preservation. Fluxer's five-minute suppression is best effort, not durable idempotency or exactly-once delivery.
     * A lost response or interruption after the request is sent may leave a created forward. No rollback or exactly-once guarantee
     *
     * Expected failures use MessageError or ClientClosedError. Defects and interruption retain Cause and await cleanup
     * @example
     * ```ts
     * import type { Client, MessageReference } from "@neontechspace/fluxerly/effect"
     * export function forwardExample(client: Client, destinationId: string, source: MessageReference) {
     *     return client.messages.forward(destinationId, { source })
     * }
     * ```
     */
    forward(channelId: string, input: ForwardMessageInput, options?: SendOptions): Effect.Effect<M, SendError>
    /**
     * Tell Fluxer that this bot is typing in one decimal channel ID, completing only after HTTP 204.
     * No gateway connection, event confirmation, cache change or local typing state is required or created.
     * Fluxer can restrict delivery to other clients and expires its own ephemeral indicator independently.
     * Uses shared HTTP concurrency and queue limits and a dedicated per-channel typing bucket. The default request deadline is 30,000 ms.
     * Only confirmed rate-limit rejections retry. A lost response or interruption cannot prove whether Fluxer showed the notice.
     * Input, queue and HTTP failures use MessageOperationError operation typing. Closing/Closed uses ClientClosedError.
     * Each execution preserves the caller's services and interruption, awaiting HTTP cleanup. Defects remain in Cause
     */
    typing(channelId: string, options?: MessageOperationOptions): Effect.Effect<void, MessageOperationFailure>
    /**
     * Send one typing notice, run task using the caller's services, then stop the helper and await its refresh cleanup.
     * While task is running, refreshes no sooner than every 8,000 ms, below Fluxer's documented 20 requests per 10 seconds per channel limit
     *
     * The first typing request completes before task starts. Its failure prevents task execution. There is no detached repeating work
     *
     * A later typing or client-close failure stops refreshing but does not interrupt task. After task settles, the retained failure combines with its Cause
     *
     * Interruption stops and awaits the helper. Task's scope, services and errors remain owned by this Effect caller.
     * Client shutdown stops and awaits refresh work, but cannot forcibly cancel arbitrary caller task work. No cache, presence or gateway state is changed
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export const typingExample = (client: Client, channelId: string) =>
     *     client.messages.keepTyping(channelId, Effect.sleep(2_000).pipe(Effect.as("prepared")))
     * ```
     */
    keepTyping<A, E, R>(
        channelId: string,
        task: Effect.Effect<A, E, R>,
        options?: MessageOperationOptions,
    ): Effect.Effect<A, E | MessageOperationFailure, R>
    /**
     * Reply to a message using send's request behavior.
     * Missing references fail instead of sending an unreferenced message. Author notifications are off by default.
     * Target and caller-supplied reference checks run first. Body validation follows send's order, after client-closure checks.
     * Input nonce follows send's caller correlation and retry contract. A lost response remains unknown and the SDK does not replay it.
     * The returned reply is eligible for the same cache intake as send.
     * Attachment sources follow send's per-execution byte copying, file/stream consumption, size, budget and cleanup rules.
     * Inline multipart 429 responses do not replay file or stream sources
     */
    reply(message: MessageReference, input: ReplyInput, options?: SendOptions): Effect.Effect<M, SendError>
    /**
     * Fetch a frozen message snapshot from Fluxer, never from a cache. Accepts a reference or an existing Message.
     * Returns after decoding the API response and checking its message/channel IDs against the requested target.
     * Missing targets fail with MessageOperationError reason notFound rather than returning an empty value.
     * Enabled caching retains eligible responses, but the returned result does not depend on cache storage.
     * Interrupting the Effect releases only this request and awaits its cleanup.
     * Uses Messages' bounded read-retry policy. Callers need no retry loop for its eligible transient failures
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import type { Client, MessageReference } from "@neontechspace/fluxerly/effect"
     * export const readExample = (client: Client, message: MessageReference) => Effect.gen(function* () {
     *     const result = yield* client.messages.fetch(message, { timeoutMs: 2_000 })
     *     return result.content
     * })
     * ```
     */
    fetch(message: MessageReference, options?: MessageOperationOptions): Effect.Effect<M, MessageOperationFailure>
    /**
     * Fetch one remote history page for a decimal channel ID without a gateway connection or cache lookup.
     * Defaults to the latest 50 messages. Query limit is 1 through 100 with at most one before, after or around cursor
     *
     * Each execution returns after HTTP 200 and whole-page validation as a frozen array of frozen Message snapshots, newest first.
     * Empty and short arrays describe currently accessible results, not complete history. Pages are not a shared point-in-time snapshot.
     * No prefetch, automatic traversal or gateway notifications. Use the oldest returned ID as before for an older page
     *
     * Enabled caching admits eligible page members oldest first, so tight limits retain the newest members
     *
     * Invalid input, malformed pages and HTTP rejections are typed MessageOperationError failures with operation fetchHistory. HTTP 404 remains notFound.
     * Shares HTTP concurrency and queue limits and the 30,000 ms default total deadline, using Messages' bounded read-retry policy
     *
     * Runs using the caller's services. Interruption releases only this call and awaits cleanup. Closing/Closed fail with ClientClosedError.
     * Defects and interruption retain Cause rather than becoming typed message-operation failures
     */
    fetchHistory(
        channelId: string,
        query?: MessageHistoryQuery,
        options?: MessageOperationOptions,
    ): Effect.Effect<readonly M[], MessageOperationFailure>
    /** Preview one bounded exact cleanup selection without deleting, rereading cache, or requiring a gateway connection.
     * The maxScanned and maxSelected options each require an integer from 1 through 10,000. Supply authorId, a synchronous filter, or both as combined criteria
     *
     * History is read newest first without prefetch until an empty page, scan bound, or selection bound. A short page is not exhaustion.
     * Underlying history reads can populate an enabled message cache
     *
     * The in-memory plan owns frozen selected snapshots and can only be consumed once by its producing client. JSON reconstruction and another client fail before the request is sent
     *
     * A filter throw, non-boolean result, or thenable fails with MessageCleanupError before deletion. A blocking synchronous filter cannot be preempted
     *
     * One 30,000 ms default deadline covers history reads. Interruption remains interruption and no cleanup request is submitted
     */
    previewCleanup(
        channelId: string,
        selection: MessageCleanupSelection<M>,
        options?: MessageOperationOptions,
    ): Effect.Effect<MessageCleanupPlan<M>, MessageCleanupFailure>
    /** Submit one prior plan's exact IDs in sequential batches of at most 100, without rereading history or rerunning selection criteria.
     * A plan is single-use even after an error or interruption, preventing accidental replay. Preview again or use explicit deleteMany for journaled reconciliation.
     * One 30,000 ms default deadline covers all batch submissions. SubmittedBatches records only earlier HTTP-success submissions.
     * A terminal rejected or unknown batch is reported separately. No report proves individual deletion, a deletion count, atomicity, or safe retry.
     * The onProgress callback runs synchronously on a best-effort basis. Callback throws and thenable rejections are ignored. Interruption retains its cause and can leave a submitting batch unknown.
     * Batches use deleteMany's confirmed rate-limit rejection retries, never automatic replay after an unknown outcome
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export const cleanupWorkflowExample = (client: Client, channelId: string, authorId: string) => Effect.gen(function* () {
     *     const plan = yield* client.messages.previewCleanup(channelId, {
     *         authorId,
     *         filter: message => message.attachments.length > 0,
     *         maxScanned: 500,
     *         maxSelected: 200,
     *     })
     *     return yield* client.messages.cleanup(plan)
     * })
     * ```
     */
    cleanup(
        plan: MessageCleanupPlan<M>,
        options?: MessageCleanupOptions,
    ): Effect.Effect<MessageCleanupReport, MessageCleanupFailure>
    /**
     * Replace text/embeds/files and return the frozen updated snapshot after the API response, without waiting for a gateway event.
     * Existing stickers are preserved. Sticker replacement is not supported by this edit operation.
     * Supplied values replace those fields. Omitted values are not sent. No hidden fetch or cache merge
     *
     * List retained attachment IDs alongside new uploads. Retained title/description may be changed or cleared with null.
     * The supplied attachment list replaces the old list. Unknown IDs may be ignored and a stale list may remove concurrent additions.
     * attachment:// embed images/thumbnails must match a new image upload in this execution, not a retained ID
     *
     * A flags-only edit is supported. Omitted flags preserve them. Flags replaces writable bits and 0 clears both non-voice bits
     *
     * Clear files with attachments: [] and nonempty text or embeds.
     * New uploads follow send's per-execution byte copying, file/stream consumption, size, budget and cleanup rules.
     * Inline multipart 429 responses do not replay file or stream sources.
     * Interruption awaits upload cleanup. Failed edits may leave temporary server data, without physical-erasure guarantees
     *
     * To remove embeds, send nonempty content alongside embeds: []. An empty edit alone is rejected by Fluxer.
     * Empty content requests clearing text, subject to Fluxer validation. Mentions default off.
     * Omitted rich embeds are preserved, but Fluxer may regenerate text-derived link previews
     *
     * Enabled caching retains eligible responses. An uncertain dispatched edit evicts the old local copy
     *
     * Missing targets are typed notFound failures. A lost response or timeout after the request is sent may leave the edit applied.
     * Uncertain edits never retry automatically. Interruption cannot undo a dispatched edit
     */
    edit(
        message: MessageReference,
        input: EditMessageInput,
        options?: MessageOperationOptions,
    ): Effect.Effect<M, MessageOperationFailure>
    /**
     * Delete the target and complete without a value after HTTP 204, without waiting for a gateway event.
     * Missing targets fail with MessageOperationError reason notFound, including a repeated delete.
     * Confirmed deletions and deletions with unknown outcomes evict the local cached copy.
     * A lost response or timeout after the request is sent may leave the target deleted. Uncertain deletes never retry automatically.
     * Interruption awaits owned cleanup but cannot undo a deletion request already sent
     */
    delete(message: MessageReference, options?: MessageOperationOptions): Effect.Effect<void, MessageOperationFailure>
    /** Delete one attachment by decimal ID from a message authored by this bot, without fetching or rewriting the retained attachment list.
     * Copies the target when run, using message HTTP deadlines and failures with the caller's services. No gateway connection is required
     *
     * HTTP 204 returns no value, not event acknowledgement. Deleting the last attachment can delete the whole message if Fluxer considers it otherwise empty.
     * Confirmed or uncertain deletion evicts this message's cached copy. No optimistic events are emitted
     *
     * A notFound failure can mean only that the attachment is missing. It does not prove the message is absent
     *
     * Only confirmed 429 rejections retry. Storage removal and message updates are not atomic. Lost responses can leave either applied.
     * Interruption awaits cleanup but cannot undo deletion or guarantee physical erasure. Defects retain their Cause
     * @example
     * ```ts
     * import type { Client, MessageReference } from "@neontechspace/fluxerly/effect"
     * export function attachmentDeleteExample(client: Client, message: MessageReference, attachmentId: string) {
     *     return client.messages.deleteAttachment(message, attachmentId)
     * }
     * ```
     */
    deleteAttachment(
        message: MessageReference,
        attachmentId: string,
        options?: MessageOperationOptions,
    ): Effect.Effect<void, MessageOperationFailure>
    /**
     * Delete 1–100 distinct decimal message IDs from one guild channel, requiring ManageMessages permission.
     * No gateway connection, hidden selection, chunking, age filter or audit reason. Each run copies the current IDs.
     * HTTP 204 completes with no value, not a deletion count or proof that each ID existed. Missing messages are ignored.
     * Dispatched requests evict selected cached messages even on rejection, since partial deletion is possible.
     * Only confirmed rate-limit rejections retry. Timeout, lost response, interruption or closure cannot undo deletion.
     * Input/queue/HTTP failures use MessageOperationError. Interruption awaits owned cleanup and defects retain Cause
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * const cleanupExample = (client: Client, channelId: string, selectedIds: readonly string[]) =>
     *     client.messages.deleteMany(channelId, selectedIds)
     * ```
     */
    deleteMany(
        channelId: string,
        messageIds: readonly string[],
        options?: MessageOperationOptions,
    ): Effect.Effect<void, MessageOperationFailure>
    /** Permanently delete this bot's message history in one decimal channel ID, without selecting IDs or requiring a gateway connection
     *
     * Each execution completes only after Fluxer returns empty HTTP 202, not a job, count, gateway event or proof that the channel is empty.
     * Other authors' messages are preserved. Fluxer can leave new or concurrent messages. Deletion is not atomic, may be partial, and has no recovery token or automatic reconciliation
     *
     * Bot credentials satisfy Fluxer's sudo checks, with no caller-supplied sudo fields. Fluxer controls attachment removal, without a physical provider-storage or CDN-erasure guarantee
     *
     * The 30,000 ms default total deadline includes queue waits and rate-limit waits. Only confirmed 429 rejection retries. 5xx, transport loss and other writes whose outcome is unknown never replay
     *
     * After dispatch, the optional whole message cache is cleared and older pending reads cannot restore it. The SDK creates no synthetic gateway events
     *
     * Interruption or closure awaits owned cleanup but cannot undo a deletion request already sent. Input/queue/HTTP failures use MessageOperationError operation deleteMine.
     * Defects retain their Cause. This does not leave a guild or alter roles
     */
    deleteMine(channelId: string, options?: MessageOperationOptions): Effect.Effect<void, MessageOperationFailure>
}

/** A running message collector registered in a Scope.
 * Use stop to end collection and waitForClose to receive its result after cleanup */
export interface Collector<M extends MessageCore = Message> {
    /** Request idempotent stop with accepted partial replies. Use waitForClose to await callback cleanup */
    stop(): Effect.Effect<void>
    /**
     * Receive the retained frozen result or error after queue, timer, filter, listener and callback cleanup.
     * Multiple callers, including later callers, share the first outcome.
     * Interruption affects only this waiter and defects retain Cause.
     * Idle, timeout and stop can return empty or partial replies. Failures carry no partial message bodies.
     * Application-held handles and results keep successful snapshots until the application releases them
     */
    waitForClose(): Effect.Effect<CollectorResult<M>, CollectorFailure>
}

/** A running reaction collector registered in a Scope.
 * Use stop to end collection and waitForClose to receive its result after cleanup */
export interface ReactionCollector {
    /** Request idempotent stop with accepted partial snapshots. Use waitForClose to await callback cleanup */
    stop(): Effect.Effect<void>
    /**
     * Receive the frozen result after queue, timer, filter, listener and callback cleanup.
     * Multiple callers, including later callers, share the outcome.
     * Interruption affects only this waiter. Defects retain Cause.
     * Idle, timeout and stop may return empty or partial snapshots.
     * Failures carry no partial snapshots. Application-held handles and results keep successful snapshots until the application releases them
     */
    waitForClose(): Effect.Effect<ReactionCollectorResult, CollectorFailure>
}

export type {
    CacheDiagnostic,
    CacheEntriesOptions,
    CachedResources,
    CacheKind,
    ClientDiagnostics,
    ConnectionState,
    OperationSignal,
} from "./client.js"
export {
    AuthenticationError,
    ShardConnectionError,
    ClientBusyError,
    ClientClosedError,
    ConfigurationError,
    ConnectionError,
    ConnectionTimeoutError,
    RateLimitError,
} from "./errors.js"
export type { ConnectError, ConnectionFailure } from "./errors.js"
export type { ShardingOptions, ShardRecoveryDiagnostic, ShardState } from "./sharding.js"

/** Read a guild's audit log as a page or a bounded sequence of entries.
 * Fluxer requires ViewAuditLog. The SDK does not cache audit entries or connect the gateway.
 * Eligible reads retry transient failures at most twice under the shared guild REST policy.
 * Permission, malformed-response and input failures are typed GuildOperationError values.
 * Effects start when executed and preserve the caller's services, unexpected faults and interruption cleanup.
 * Closing clients fail with ClientClosedError. Audit records can change independently. This is not an archival snapshot
 */
export interface AuditLogs {
    /** Read one filtered page, including referenced users and token-free webhook metadata.
     * Query cursors and filters are defined by AuditLogQuery. Returned data is caller-owned and frozen
     */
    fetchPage(
        guildId: string,
        query: AuditLogQuery,
        options?: GuildOperationOptions,
    ): Effect.Effect<AuditLogPage, GuildOperationFailure>
    /** Traverse filtered records newest-to-oldest on demand, buffering one page and never prefetching.
     * The maxItems option is required. The pageSize default is 50 (1–100), and maxPages defaults to 100. The timeoutMs option applies to each page.
     * Stops at maxItems or an empty page, not merely a short page. Concurrent changes can prevent complete enumeration.
     * Invalid traversal input, a stalled cursor or reaching the page budget fails with PaginationError.
     * Remote failures retain auditLogs.fetchPage's typed errors. Already-delivered entries remain caller-owned.
     * Interruption awaits request cleanup. Termination releases the buffered page.
     * Closing/Closed releases the page and fails the next pull. Use fetchPage when referenced-user/webhook snapshots are needed
     */
    iterate(
        guildId: string,
        query: AuditLogIterationQuery,
        options?: GuildOperationOptions,
    ): Stream.Stream<AuditLogEntry, GuildOperationFailure | PaginationError>
}

/** Inspect, create, list or revoke invite codes without joining their destinations.
 * Methods return Effects and do not connect the gateway or cache invites.
 * Reads retry eligible transient failures at most twice. Writes retry only confirmed 429 rejections.
 * Fluxer checks destination visibility, invite permissions and capacity. Failures use GuildOperationError.
 * Effects start when executed. Interruption waits for owned cleanup and defects remain in Cause.
 * Closing clients fail with ClientClosedError. Lost responses can leave mutations applied. Do not replay them blindly
 */
export interface Invites {
    /** Inspect a code without consuming it or joining its destination. Supply the code, not a URL.
     * Expired, revoked or inaccessible codes fail remotely. The provider can canonicalize vanity-code casing
     */
    fetch(code: string, options?: GuildOperationOptions): Effect.Effect<Invite, GuildOperationFailure>
    /** Create an invite to a channel the bot can access, including an existing group DM.
     * Defaults to a new code, 86400 seconds, unlimited uses and non-temporary membership.
     * Does not send the code, create a group or add members. Cancellation cannot revoke an already-created invite.
     * An unknown create outcome requires listing the destination's invites and caller reconciliation
     */
    create(
        channelId: string,
        input?: InviteCreate,
        options?: ModerationOptions,
    ): Effect.Effect<InviteMetadata, GuildOperationFailure>
    /** List a channel's invites remotely in provider order, subject to channel permissions.
     * Results are not a stable snapshot */
    fetchChannel(
        channelId: string,
        options?: GuildOperationOptions,
    ): Effect.Effect<readonly InviteMetadata[], GuildOperationFailure>
    /** List a guild's invites remotely, requiring ManageGuild and excluding the guild vanity invite */
    fetchGuild(
        guildId: string,
        options?: GuildOperationOptions,
    ): Effect.Effect<readonly InviteMetadata[], GuildOperationFailure>
    /** Revoke a code after HTTP 204, subject to provider creator/management permissions.
     * Does not remove existing members. A missing code is an error, not proof of a previous successful deletion
     */
    delete(code: string, options?: ModerationOptions): Effect.Effect<void, GuildOperationFailure>
}

/** Read, upload, rename, clone or delete custom emoji.
 * Methods return Effects and share guild HTTP concurrency limits, deadlines and GuildOperationError failures.
 * Reads retry eligible transient failures at most twice. Writes retry only confirmed 429 rejections.
 * Input, permission, 404 and malformed responses do not retry. Unknown outcomes may leave writes applied.
 * Effects start when executed, use the caller's services and await cleanup on interruption. Defects remain in Cause.
 * Closing clients fail with ClientClosedError. Snapshots are frozen and HTTP success is not gateway acknowledgement
 */
export interface Emojis {
    /** Read cached metadata without an HTTP request. Disabled, absent, expired or conflicting entries return undefined.
     * Decimal IDs are required. Lookup updates least-recently-used eviction order but not expiry
     */
    get(target: ExpressionReference): Effect.Effect<GuildEmoji | undefined, GuildOperationFailure>
    /** Fetch the guild's full emoji list in provider order, without pagination or a lasting completeness guarantee.
     * Updates the optional bounded metadata cache, excluding image bytes and creator accounts
     */
    fetchAll(
        guildId: string,
        options?: GuildOperationOptions,
    ): Effect.Effect<readonly GuildEmoji[], GuildOperationFailure>
    /** Fetch minimal emoji metadata by decimal ID without requiring membership in its source guild.
     * Does not populate the cache */
    fetchMetadata(id: string, options?: GuildOperationOptions): Effect.Effect<ExpressionMetadata, GuildOperationFailure>
    /** Upload one custom emoji. Fluxer enforces format, dimensions, permissions and capacity.
     * Copies input at execution start, without implicit URL fetching or replay of writes whose outcome is unknown
     */
    create(
        guildId: string,
        input: EmojiCreate,
        options?: ModerationOptions,
    ): Effect.Effect<GuildEmoji, GuildOperationFailure>
    /** Submit 1–50 uploads in one batch, with separate successes and failures and no rollback.
     * The input array is copied by index, then its entries are copied when the Effect is executed.
     * Duplicate names cannot map failures to input positions. No automatic chunking or replay.
     * Unknown outcomes require fresh remote snapshots and caller reconciliation
     */
    createMany(
        guildId: string,
        input: readonly EmojiCreate[],
        options?: ModerationOptions,
    ): Effect.Effect<ExpressionBatch<GuildEmoji>, GuildOperationFailure>
    /** Copy an emoji on the server by source ID, preserving its metadata.
     * Fluxer enforces the source's cloning restrictions */
    clone(
        guildId: string,
        sourceId: string,
        options?: ModerationOptions,
    ): Effect.Effect<GuildEmoji, GuildOperationFailure>
    /** Rename without replacing the image or implicitly reading old metadata */
    edit(
        target: ExpressionReference,
        input: EmojiEdit,
        options?: ModerationOptions,
    ): Effect.Effect<GuildEmoji, GuildOperationFailure>
    /** Remove after HTTP 204, invalidating retained snapshots. A missing target is an error, not proof of prior deletion.
     * Purging defaults false. Explicit true also queues irreversible media removal subject to provider restrictions
     */
    delete(target: ExpressionReference, options?: ExpressionDeleteOptions): Effect.Effect<void, GuildOperationFailure>
}

/** Read, upload, edit, clone or delete custom stickers.
 * Methods return Effects and share guild HTTP concurrency limits, deadlines and GuildOperationError failures.
 * Reads retry eligible transient failures at most twice. Writes retry only confirmed 429 rejections.
 * Input, permission, 404 and malformed responses do not retry. Unknown outcomes may leave writes applied.
 * Effects start when executed, use the caller's services and await cleanup on interruption. Defects remain in Cause.
 * Closing clients fail with ClientClosedError. Snapshots are frozen and HTTP success is not gateway acknowledgement
 */
export interface Stickers {
    /** Replace name, description and tags explicitly, without an implicit fetch or image replacement.
     * A fetched sticker may be spread into the input. Its identity must match the target. Unknown fields fail locally.
     * Empty/null description clears it. [] clears tags. Uses this group's mutation, failure and cancellation rules
     */
    edit(
        target: ExpressionReference,
        input: StickerEdit,
        options?: ModerationOptions,
    ): Effect.Effect<GuildSticker, GuildOperationFailure>
    /** Read cached metadata without an HTTP request. Disabled, absent, expired or conflicting entries return undefined.
     * Decimal IDs are required. Lookup updates least-recently-used eviction order but not expiry
     */
    get(target: ExpressionReference): Effect.Effect<GuildSticker | undefined, GuildOperationFailure>
    /** Fetch the guild's full sticker list in provider order, without pagination or a lasting completeness guarantee.
     * Updates the optional bounded metadata cache, excluding image bytes and creator accounts
     */
    fetchAll(
        guildId: string,
        options?: GuildOperationOptions,
    ): Effect.Effect<readonly GuildSticker[], GuildOperationFailure>
    /** Fetch minimal sticker metadata by decimal ID without requiring membership in its source guild.
     * Does not populate the cache */
    fetchMetadata(id: string, options?: GuildOperationOptions): Effect.Effect<ExpressionMetadata, GuildOperationFailure>
    /** Upload one custom sticker. Fluxer enforces format, dimensions, permissions and capacity.
     * Copies input at execution start, without implicit URL fetching or replay of writes whose outcome is unknown
     */
    create(
        guildId: string,
        input: StickerCreate,
        options?: ModerationOptions,
    ): Effect.Effect<GuildSticker, GuildOperationFailure>
    /** Submit 1–50 uploads in one batch, with separate successes and failures and no rollback.
     * The input array is copied by index, then its entries are copied when the Effect is executed.
     * Duplicate names cannot map failures to input positions. No automatic chunking or replay.
     * Unknown outcomes require fresh remote snapshots and caller reconciliation
     */
    createMany(
        guildId: string,
        input: readonly StickerCreate[],
        options?: ModerationOptions,
    ): Effect.Effect<ExpressionBatch<GuildSticker>, GuildOperationFailure>
    /** Copy a sticker on the server by source ID, preserving its metadata.
     * Fluxer enforces the source's cloning restrictions */
    clone(
        guildId: string,
        sourceId: string,
        options?: ModerationOptions,
    ): Effect.Effect<GuildSticker, GuildOperationFailure>
    /** Remove after HTTP 204, invalidating retained snapshots. A missing target is an error, not proof of prior deletion.
     * Purging defaults false. Explicit true also queues irreversible media removal subject to provider restrictions
     */
    delete(target: ExpressionReference, options?: ExpressionDeleteOptions): Effect.Effect<void, GuildOperationFailure>
}

/** Search Fluxer's public server directory or manage a guild's listing application.
 * This is separate from instance endpoint discovery. HTTP requests share guild limits and directory data is not cached.
 * Effects start when executed and can be run again, using the caller's services without requiring gateway readiness. The total deadline defaults to 30,000 ms.
 * Reads retry transient transport and HTTP 500/502/503/504 failures at most twice. Writes retry only confirmed 429 rejections.
 * Input, HTTP and malformed-response failures use GuildOperationError. Closing clients use ClientClosedError.
 * Interruption waits for owned cleanup. Defects retain Cause.
 * Application writes may publish or unpublish a listing, invalidate guild snapshots and cannot promise rollback.
 * There is no hidden eligibility read, automatic resubmission, review approval or directory-joining operation
 */
export interface Discovery {
    /** Search one current public directory page without a cache, gateway readiness, join operation or stable snapshot.
     * Defaults to limit 24 and offset 0. Each page can change while later offset pages are fetched, so callers must not infer a stable traversal.
     * The shared REST owner retries eligible GET failures. Input, HTTP and malformed-response failures use GuildOperationError
     */
    search(
        query?: DiscoverySearchQuery,
        options?: GuildOperationOptions,
    ): Effect.Effect<DiscoverySearchPage, GuildOperationFailure>
    /** Check a guild's directory eligibility and listing application state remotely, requiring ManageGuild and a decimal guild ID.
     * Returns eligible false when discovery is disabled or the member threshold is unmet, not a diagnosis distinguishing them.
     * Eligibility can change before submission. Reviewed/removed applications include available reasons
     */
    fetchStatus(guildId: string, options?: GuildOperationOptions): Effect.Effect<DiscoveryStatus, GuildOperationFailure>
    /** Fetch directory category IDs and labels in provider order, without keeping a copy.
     * Requires an authenticated client, not membership of a particular guild or ManageGuild
     */
    fetchCategories(options?: GuildOperationOptions): Effect.Effect<readonly DiscoveryCategory[], GuildOperationFailure>
    /** Submit a guild application, requiring ManageGuild, enabled discovery and current provider eligibility.
     * Pending/approved existing applications fail remotely. Eligible verified/partnered guilds can be approved immediately.
     * Success is the stored application snapshot, not a guarantee of approval or search-index visibility.
     * An unknown outcome may already have submitted or published the listing. Inspect fetchStatus before deciding what to do
     */
    apply(
        guildId: string,
        input: DiscoveryApplicationInput,
        options?: GuildOperationOptions,
    ): Effect.Effect<DiscoveryApplication, GuildOperationFailure>
    /** Update a pending or approved listing application with a nonempty patch, requiring ManageGuild and enabled discovery.
     * Omitted fields remain unchanged. Uses the input's documented tag normalization and replacement semantics.
     * This does not fetch or merge existing data. Approved listing updates can become public.
     * Search-index changes may lag or partially fail
     */
    edit(
        guildId: string,
        input: DiscoveryApplicationEdit,
        options?: GuildOperationOptions,
    ): Effect.Effect<DiscoveryApplication, GuildOperationFailure>
    /** Withdraw an application or remove an approved listing, requiring ManageGuild and enabled discovery.
     * HTTP 204 returns no value. An absent application is a remote error, not an assumed successful no-op.
     * Removes the provider record and may separately remove its discoverable feature/search entry.
     * It does not restore the prior application, delete the guild or remove its members.
     * Unknown outcomes require remote reconciliation and can need operator recovery rather than blind retries
     */
    withdraw(guildId: string, options?: GuildOperationOptions): Effect.Effect<void, GuildOperationFailure>
}

/** Read or change guilds, manage bans and obtain gateway counts.
 * A guild is a Fluxer server. HTTP methods return Effects and do not require a gateway connection.
 * The REST rules below exclude fetchCounts, which requires gateway readiness and has its own documented contract
 *
 * Guild requests share this client's four REST or upload slots with messages, members and roles, regardless of shard. Attachment downloads have four separate slots. The shared queue holds at most 256 requests or 4 MiB of JSON bodies
 *
 * The total deadline defaults to 30,000 ms, including waits. Reads retry transport failures and HTTP 500/502/503/504 at most twice.
 * Retry delays are 125–250 ms, then 250–500 ms, or a longer valid Retry-After. Confirmed HTTP 429 waits are separate and never reset the deadline
 *
 * Input, 404, permission failures and malformed successes do not retry. Expected failures use GuildOperationError
 *
 * Successful REST JSON responses are limited to 16 MiB before parsing. This is not a total memory limit. Oversized responses fail with reason response and do not retry.
 * If a response fails after a write was sent, the write may still have applied. The SDK does not assume rollback
 *
 * Interruption awaits owned cleanup. Closing clients use ClientClosedError. Defects retain Cause, including cleanup failures
 */
export interface Guilds {
    /** Fetch fresh counts for 1–100 guilds over the connected gateway, filtered by what the bot can see
     *
     * Supply distinct canonical positive decimal IDs in the unsigned 64-bit range.
     * Copies IDs when run and uses the caller's Effect services. It does not connect, make REST requests, read caches, poll or retry
     *
     * Every requested guild must route to a locally owned ready shard. An unowned or unready guild fails notConnected instead of appearing in omittedGuildIds
     *
     * Returns frozen counts plus omittedGuildIds in input order. Missing entries are not zero and do not explain access or timeout.
     * Observations are not a consistent snapshot across guilds. A missing whole reply fails with timeout instead
     *
     * One logical call holds one client-wide slot across every routed shard command and reply fragment. It shares four slots with channels.fetchMemberCounts and members.iterateChunks, without a queue. Additional calls fail busy.
     * The default 30,000 ms overall deadline covers local registration, all commands and all fragments.
     * Fluxer also shares provider capacity with member/presence requests, so local concurrency limits cannot guarantee a reply
     *
     * Only a gap on a participating shard fails this request with connectionLost. Late replies are ignored.
     * CountOperationError covers input/readiness/queue/timeout/response failures. Closure uses ClientClosedError.
     * Interruption awaits local cleanup but cannot cancel work already sent to Fluxer. Defects retain their Cause
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export function countsExample(client: Client, guildId: string, channelId: string) {
     *     return Effect.gen(function* () {
     *         const guilds = yield* client.guilds.fetchCounts([guildId])
     *         const channels = yield* client.channels.fetchMemberCounts(guildId, [channelId])
     *         return { guilds, channels }
     *     })
     * }
     * ```
     */
    fetchCounts(
        guildIds: readonly string[],
        options?: CountOperationOptions,
    ): Effect.Effect<GuildCountsResult, CountOperationFailure>
    /** Fetch one fresh remote membership page for this bot, ordered by ascending guild ID.
     * Limit defaults to 200 (1–200). Before/after are mutually exclusive existing-membership cursors.
     * The withCounts option defaults to false. Fluxer can omit permission bits or requested approximate counts. Missing means unavailable, not zero.
     * A removed cursor can cause Fluxer to restart the page. Returns frozen summaries without populating or reading the guild cache.
     * Summaries are REST-only snapshots and do not claim a complete membership inventory or gateway consistency.
     * Uses this group's deadlines, retries and failures. No gateway connection or background traversal required
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export const guildListExample = (client: Client) =>
     *     client.guilds.fetchPage({ withCounts: true }).pipe(
     *         Effect.map(page => page.map(({ id, permissions, approximateMemberCount }) => ({ id, permissions, approximateMemberCount }))),
     *     )
     * ```
     */
    fetchPage(
        query?: GuildListQuery,
        options?: GuildOperationOptions,
    ): Effect.Effect<readonly GuildListSummary[], GuildOperationFailure>
    /** Traverse ascending guild IDs, retaining one page and never prefetching.
     * The maxItems option is required. The pageSize default is 200, and maxPages defaults to 100. Stop at maxItems or an empty page, not a short page
     *
     * Repeated/backward IDs after a removed cursor fail with PaginationError cursorStalled before that page is delivered.
     * Other pagination failures are input/pageLimit. Remote failures preserve fetchPage's error and per-page timeout
     *
     * Each stream consumption copies inputs in the caller's scope. Interruption and scope closure await request cleanup.
     * Scope cleanup releases the buffered page. Client closure releases the page and fails the next pull
     *
     * The withCounts option applies to every page. Fluxer can omit permission bits or requested counts. Missing means unavailable, not zero.
     * No automatic cache population, gateway requirement or consistent-inventory guarantee. Previously delivered values remain caller-owned
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export function guildMembershipsExample(client: Client) {
     *     return client.guilds.iterate({ maxItems: 1000 })
     * }
     * ```
     */
    iterate(
        query: GuildIterationQuery,
        options?: GuildOperationOptions,
    ): Stream.Stream<GuildListSummary, GuildOperationFailure | PaginationError>
    /** Leave the named guild as the authenticated bot, explicitly preserving authored messages.
     * HTTP 204 completes membership removal, not gateway delivery. The client stays usable for other guilds.
     * Fluxer rejects owners and restricted memberships. Only confirmed 429 rejection is retried. Cancellation or a lost
     * response can leave membership removed. Refetch/list to reconcile. Rejoining requires external authorization.
     * Successful writes or writes with unknown outcomes invalidate this guild's resource snapshots and pending reads.
     * A confirmed successful leave also forgets this client's member-presence selection. An uncertain result preserves it.
     * Any dispatched attempt conservatively clears channel/message caches because messages need not carry guild IDs.
     * Existing caller-held snapshots remain unchanged. This operation never deletes the guild or shuts down the client
     */
    leave(guildId: string, options?: GuildOperationOptions): Effect.Effect<void, GuildOperationFailure>
    /** Permanently delete this bot's message history across one decimal guild ID, without leaving the guild or changing roles
     *
     * Each execution completes only after Fluxer returns empty HTTP 202, not a job, count, gateway event or proof that the guild is empty.
     * Other authors' messages are preserved. Fluxer can leave new or concurrent messages. Deletion is not atomic, may be partial, and has no recovery token or automatic reconciliation
     *
     * Bot credentials satisfy Fluxer's sudo checks, with no caller-supplied sudo fields or audit reason. Fluxer controls attachment removal, without a physical provider-storage or CDN-erasure guarantee
     *
     * The 30,000 ms default total deadline includes queue waits and rate-limit waits. Only confirmed 429 rejection retries. 5xx, transport loss and other writes whose outcome is unknown never replay
     *
     * After dispatch, the optional whole message cache is cleared and older pending reads cannot restore it. The SDK creates no synthetic gateway events
     *
     * Interruption or closure awaits owned cleanup but cannot undo a deletion request already sent. Input/queue/HTTP failures use GuildOperationError operation guilds.deleteMine.
     * Defects retain their Cause. This operation never removes guild membership or changes roles
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export const deleteMineExample = (client: Client, channelId: string) => client.messages.deleteMine(channelId)
     * export const deleteMineGuildExample = (client: Client, guildId: string) => client.guilds.deleteMine(guildId)
     * ```
     */
    deleteMine(guildId: string, options?: GuildOperationOptions): Effect.Effect<void, GuildOperationFailure>
    /** Read a decimal guild's custom invite and use count, requiring ManageGuild.
     * Always remote, without a vanity cache or gateway requirement. Null code/url means no custom invite.
     * Each execution uses this group's read retries, deadline, interruption and typed failure rules
     */
    fetchVanityUrl(
        guildId: string,
        options?: GuildOperationOptions,
    ): Effect.Effect<GuildVanityUrlUsage, GuildOperationFailure>
    /** Set or replace a guild's custom invite, or explicitly remove it with null.
     * Code must already be lowercase, 2–32 ASCII letters/digits with single internal hyphens. No implicit normalization.
     * Requires ManageGuild and, when setting a code, the server's VANITY_URL feature. Reserved/taken codes fail remotely
     *
     * Changing the code releases the old one and starts a new use count. Neither reclaiming it nor provider rollback is guaranteed.
     * Returns only code/url after HTTP success, without a hidden read, joinability check or event acknowledgement
     *
     * Uses the caller's services with the shared deadline and interruption cleanup. Only confirmed 429 rejections may retry writes.
     * Dispatched writes invalidate guild snapshots
     *
     * If the outcome is unknown, use fetchVanityUrl to check the result instead of blindly replaying the write.
     * Partial provider-side changes can require operator recovery.
     * Uses this group's GuildOperationError and ClientClosedError behavior. Defects retain Cause
     */
    editVanityUrl(
        guildId: string,
        code: string | null,
        options?: ModerationOptions,
    ): Effect.Effect<GuildVanityUrl, GuildOperationFailure>
    /** Patch bot-permitted server settings without a hidden read or merge. Omitted fields remain unchanged.
     * Requires ManageGuild. Fluxer owns feature restrictions and validation beyond GuildEdit's local checks.
     * Dispatched mutations invalidate guild-cache snapshots even when the outcome is unknown.
     * Uses the caller's services, guild HTTP deadlines and interruption cleanup.
     * Success returns the server's observed configuration, not gateway acknowledgement or rollback guarantees.
     * Uncertain writes must be reconciled with fetch rather than blindly replayed
     */
    edit(guildId: string, input: GuildEdit, options?: ModerationOptions): Effect.Effect<Guild, GuildOperationFailure>
    /** Ban a decimal guild/user target, including a user who is not currently a member.
     * Requires BanMembers and provider hierarchy/MFA rules. Defaults to permanent with no message deletion
     *
     * HTTP 204 returns no value, not event acknowledgement. Writes retry only confirmed 429 rejections.
     * Failure after the request is sent may leave a ban and separately queued message deletion applied
     *
     * Dispatched actions invalidate this member's retained snapshot even on rejection.
     * Requested message cleanup deliberately evicts this author's cached messages across all guilds, including known unrelated scope, because messages need not carry guild IDs.
     * The cleanup job can finish later. A later cache hit does not establish that its message survived the job
     *
     * Bans may also block rejoining through provider-side IP/email checks. Unban restores neither messages nor membership
     *
     * Each execution uses the caller's services. Interruption awaits cleanup and defects remain in Cause.
     * Invalid input and HTTP failures use GuildOperationError, while a closed client uses ClientClosedError
     */
    ban(
        target: MemberReference,
        input?: BanInput,
        options?: ModerationOptions,
    ): Effect.Effect<void, GuildOperationFailure>
    /** Remove a ban after HTTP 204, without rejoining the user or cancelling queued message deletion.
     * Requires BanMembers. A user who is not banned is an API failure, not a successful no-op.
     * Uses ban's execution, failure, cleanup and member-cache invalidation rules
     */
    unban(target: MemberReference, options?: ModerationOptions): Effect.Effect<void, GuildOperationFailure>
    /** Fetch the provider's full ban list as frozen snapshots, requiring BanMembers.
     * Always remote, without a ban cache, pagination or guaranteed order. Separate reads are not a consistent snapshot.
     * Each execution uses shared guild read deadlines and retries, rejecting malformed responses as a whole
     */
    fetchBans(
        guildId: string,
        options?: GuildOperationOptions,
    ): Effect.Effect<readonly GuildBan[], GuildOperationFailure>
    /** Read the optional guild cache when executed, without HTTP or requiring a connection.
     * Returns undefined when disabled, absent, expired or evicted. Snapshots may be stale. Use fetch for a remote snapshot.
     * Invalid decimal IDs fail with GuildOperationError(input). Closing/closed clients fail with ClientClosedError.
     * Defects retain Cause. Lookup updates least-recently-used eviction order but never extends expiry
     */
    get(guildId: string): Effect.Effect<Guild | undefined, GuildOperationFailure>
    /** Fetch a frozen guild snapshot containing selected identity and configuration fields by decimal ID.
     * Fluxer requires guild membership.
     * No embedded member/role/channel state is retained and no counts or completeness guarantee are inferred
     */
    fetch(guildId: string, options?: GuildOperationOptions): Effect.Effect<Guild, GuildOperationFailure>
}

/** Read or change guild channels and permission overrides, or request gateway member counts.
 * HTTP methods return Effects and do not connect the gateway.
 * The REST rules below exclude fetchMemberCounts, which requires gateway readiness and has its own documented contract
 *
 * DM operations are outside this API contract. Supply decimal guild-channel IDs. ID-targeted writes do not prefetch or verify their guild type
 *
 * Channel requests share this client's four REST or upload slots with guild, member, role and message requests, regardless of shard. Attachment downloads have four separate slots. The shared queue holds at most 256 requests or 4 MiB of JSON bodies
 *
 * Total deadline defaults to 30,000 ms, including queue waits, retries and rate-limit waits. Reads retry transport failures and HTTP 500/502/503/504 at most twice.
 * Writes retry only confirmed 429 responses. Permission, input, 404 and malformed-response failures do not retry
 *
 * Sending any channel write clears the enabled channel cache. Input failures before dispatch leave it unchanged. The SDK does not fetch channels automatically after a write
 * The create, edit, delete, reorder and permission-overwrite mutations accept ChannelAuditOperationOptions. Read operations reject auditReason
 *
 * Operation inputs are copied when the Effect executes and later caller mutations are not observed. Permission bits are bigint values encoded as decimal JSON strings.
 * Fluxer enforces channel permissions and grant restrictions. Targeted overwrite operations require ManageRoles for role and member targets
 *
 * Expected failures use ChannelOperationError or ClientClosedError. Interruption and defects retain Cause after owned cleanup
 */
export interface Channels {
    /** Fetch fresh counts for 1–25 channels in one guild over the connected gateway
     *
     * Supply distinct canonical positive decimal IDs in the unsigned 64-bit range
     *
     * Copies IDs when run. Requires the guild's locally owned shard to be ready plus ViewChannel and ViewChannelMembers. No hidden connect or REST reads.
     * The guild must route to a locally owned ready shard. An unowned or unready guild fails notConnected instead of appearing in omittedChannelIds
     *
     * Returns frozen counts plus omittedChannelIds in input order. Omission never becomes zero or identifies its cause.
     * Counts are visibility-filtered snapshots, not a subscription or guaranteed cross-channel snapshot
     *
     * Uses guilds.fetchCounts' one-logical-slot four-call concurrency limit, default 30,000 ms overall deadline, no-retry, participant-shard recovery and failure/cleanup rules.
     * No channel/member cache writes. Interruption cannot stop work already sent to Fluxer
     */
    fetchMemberCounts(
        guildId: string,
        channelIds: readonly string[],
        options?: CountOperationOptions,
    ): Effect.Effect<ChannelMemberCountsResult, CountOperationFailure>
    /** Read the enabled channel cache without HTTP or requiring a connection.
     * Returns undefined when disabled, absent, expired or evicted. Snapshots may be stale. Use fetch for a remote snapshot.
     * Invalid decimal IDs fail with ChannelOperationError(input). Closing/closed clients fail with ClientClosedError.
     * Defects retain their Cause. Lookup updates least-recently-used eviction order but never extends expiry
     */
    get(channelId: string): Effect.Effect<GuildChannel | undefined, ChannelOperationFailure>
    /** Fetch one frozen guild-channel snapshot by decimal ID, without connecting or populating a complete guild list.
     * A non-guild response is a typed response failure. The result has explicit overwrites only, not inherited or effective permissions
     */
    fetch(channelId: string, options?: ChannelOperationOptions): Effect.Effect<GuildChannel, ChannelOperationFailure>
    /** Fetch Fluxer's visible guild-channel list for one decimal guild ID, without pagination or a completeness guarantee.
     * The response is a point-in-time snapshot, not a subscription. It does not fetch members, roles, DMs or missing permission-overwrite targets
     */
    fetchAll(
        guildId: string,
        options?: ChannelOperationOptions,
    ): Effect.Effect<readonly GuildChannel[], ChannelOperationFailure>
    /** Create one supported guild channel and return Fluxer's frozen snapshot. Fluxer chooses its initial position.
     * Each overwrite allow and deny mask must be from 0n through 9_223_372_036_854_775_807n. Invalid masks fail before dispatch.
     * Omitted permissionOverwrites inherits the selected parent category's overrides. [] creates no explicit overrides, not private visibility.
     * Explicit overwrite bits include ViewChannelMembers through Fluxer's required feature opt-in
     * @example
     * ```ts
     * import { ChannelType, Permissions, type Client } from "@neontechspace/fluxerly/effect"
     * export const channelExample = (client: Client, guildId: string, botId: string) =>
     *     client.channels.create(guildId, {
     *         type: ChannelType.Text,
     *         name: "private-support",
     *         permissionOverwrites: [
     *             { id: guildId, type: "role", allow: 0n, deny: Permissions.ViewChannel },
     *             { id: botId, type: "member", allow: Permissions.ViewChannel | Permissions.SendMessages, deny: 0n },
     *         ],
     *     })
     * ```
     * The caller owns the created channel and executes the returned Effect. On an unknown outcome, reconcile with fetchAll before deciding whether to create again
     */
    create(
        guildId: string,
        input: ChannelCreate,
        options?: ChannelAuditOperationOptions,
    ): Effect.Effect<GuildChannel, ChannelOperationFailure>
    /** Patch only supplied channel settings and return Fluxer's frozen snapshot. Empty/unknown-field patches are input errors.
     * Each replacement allow and deny mask must be from 0n through 9_223_372_036_854_775_807n.
     * Channel type and parent are intentionally not editable here. Move a channel with reorder. Omitted permissionOverwrites preserves them, while [] clears them.
     * Explicit overwrite replacements opt into Fluxer's ViewChannelMembers permission handling, including clearing that bit
     */
    edit(
        channelId: string,
        input: ChannelEdit,
        options?: ChannelAuditOperationOptions,
    ): Effect.Effect<GuildChannel, ChannelOperationFailure>
    /** Delete a guild channel and complete after HTTP 204, without waiting for a gateway event or proving a prior channel existed.
     * The SDK does not prefetch to verify the ID. A lost response or timeout after the request is sent may leave deletion applied
     */
    delete(channelId: string, options?: ChannelAuditOperationOptions): Effect.Effect<void, ChannelOperationFailure>
    /** Apply submitted guild-channel moves sequentially and complete after HTTP 204, without fabricating a reordered snapshot.
     * The syncPermissionsOnMove option copies the target category's overwrites. A bulk channel event can arrive before that permission copy completes.
     * Fluxer may normalize positions. This bulk mutation is not a transaction, so failures can leave partial movement. Refetch when final order matters.
     * Fluxer currently accepts auditReason on this route without retaining it in an audit entry
     */
    reorder(
        guildId: string,
        positions: readonly ChannelPosition[],
        options?: ChannelAuditOperationOptions,
    ): Effect.Effect<void, ChannelOperationFailure>
    /** Replace one explicit role or member permission overwrite with the supplied raw bigint allow and deny bits.
     * Each mask must be from 0n through 9_223_372_036_854_775_807n. Larger received masks cannot be written unchanged.
     * Completes after HTTP 204.
     * Sets and clears ViewChannelMembers through Fluxer's required feature opt-in, alongside the other raw bits.
     * Fluxer enforces ManageRoles. This does not calculate inherited/effective permissions or prefetch the target
     */
    setPermissionOverwrite(
        channelId: string,
        input: PermissionOverwrite,
        options?: ChannelAuditOperationOptions,
    ): Effect.Effect<void, ChannelOperationFailure>
    /** Remove one explicit role or member permission overwrite by decimal target ID and complete after HTTP 204.
     * Fluxer enforces ManageChannels and ManageRoles. Other overwrites remain unchanged, and an unknown outcome requires an explicit follow-up read
     */
    removePermissionOverwrite(
        channelId: string,
        targetId: string,
        options?: ChannelAuditOperationOptions,
    ): Effect.Effect<void, ChannelOperationFailure>
}

/** Read guild members, change their roles and nicknames, or perform moderation actions.
 * HTTP methods return Effects and use the same concurrency limits, deadlines and error rules as Guilds.
 * The iterateChunks method uses the gateway and its own documented Stream rules instead
 *
 * Returned members are frozen snapshots. ClientOptions.cache.members can retain them, but does not predict permissions or download a whole guild
 *
 * Writes retry only confirmed 429 rejections, never unknown outcomes. Interruption cannot undo a write request already sent
 * The setRoles, editSelf, setNickname, addRole and removeRole methods accept GuildAuditOperationOptions.
 * Member reads and searches reject auditReason. Moderation methods retain their more specific audited option types
 */
export interface Members {
    /** Request one guild's gateway members, streaming frozen batches in the consuming Effect scope without accumulating a roster.
     * Each consumption copies inputs and sends one request. Select explicit userIds, a query prefix, or `all: true`
     *
     * Requires the guild's locally owned shard to be ready. Full-list mode is provider-capped at 100,000 members. Its 30-second per-bot/guild limit depends on server enforcement.
     * One member stream is admitted at a time per client, not per gateway connection. It holds one of four client-wide slots shared with gateway counts until consumed or released.
     * The guild must route to a locally owned ready shard. An unowned or unready guild fails notConnected. Only its owning-shard gap fails this stream. Healthy-shard work continues
     *
     * No implicit connection, HTTP fallback, cache writes, presence subscription, raw-event forwarding or automatic retries
     *
     * Delivers provider chunk order, checking indices, advertised count, member uniqueness and presence association.
     * Success means every advertised batch arrived, not a complete or atomic guild snapshot. Missing selected IDs are explicit on the final batch.
     * Optional presences omit unavailable/offline/invisible snapshots. Missing presence never proves offline status
     *
     * The timeoutMs default is 30,000 for the whole reply. The maxPendingBytes default is 4 MiB of accounted unread wire bytes.
     * Fluxer pushes batches without backpressure. Slow readers can overflow. Pausing consumption does not pause intake or its deadline
     *
     * A gap, timeout, malformed reply or overflow discards unread batches and fails with MemberChunkError, never a silent partial success.
     * Previously emitted batches stay caller-owned. Client closure fails with ClientClosedError and releases local buffers
     *
     * Interruption, early stream termination and scope closure release intake, timers and buffers without cancelling Fluxer's dispatched work.
     * Late or unmatched chunks are ignored and chunks are not replayed on Resume. Defects and interruption retain Cause and the caller's services
     * @example
     * ```ts
     * import { Effect, Stream } from "effect"
     * import type { Client, MemberChunk } from "@neontechspace/fluxerly/effect"
     * export function memberChunksExample(client: Client, guildId: string, handleBatch: (chunk: MemberChunk) => Effect.Effect<void>) {
     *     return client.members.iterateChunks(guildId, { all: true, presences: true }).pipe(
     *         Stream.runForEach(handleBatch)
     *     )
     * }
     * ```
     */
    iterateChunks(
        guildId: string,
        query: MemberChunkQuery,
        options?: MemberChunkOptions,
    ): Stream.Stream<MemberChunk, MemberChunkFailure>
    /** Replace the member's entire explicit role set with 0–250 distinct positive decimal role IDs no greater than 9,223,372,036,854,775,807 in one PATCH.
     * Copies IDs by index when run using the caller's Effect services, without prefetching or merging. [] clears assigned roles. The implicit everyone role is rejected as input
     *
     * Requires provider ManageRoles and hierarchy permission for changes. This may overwrite concurrent role changes.
     * Fluxer can silently omit nonexistent or foreign role IDs. Returns its frozen actual member, not a promise that every requested role was accepted
     *
     * Uses shared guild write deadlines/failures and only confirmed 429 retries. No gateway readiness or event acknowledgement is required.
     * Eligible responses update member caching. Writes with unknown outcomes evict it and need explicit fetch reconciliation
     *
     * Interruption awaits cleanup but cannot undo the replacement. Defects retain their Cause
     * @example
     * ```ts
     * import type { Client, MemberReference } from "@neontechspace/fluxerly/effect"
     * export function roleSetExample(client: Client, member: MemberReference, desiredRoles: readonly string[]) {
     *     return client.members.setRoles(member, desiredRoles)
     * }
     * ```
     */
    setRoles(
        member: MemberReference,
        roleIds: readonly string[],
        options?: GuildAuditOperationOptions,
    ): Effect.Effect<GuildMember, GuildOperationFailure>
    /** Search indexed member snapshots remotely, without using the local cache or returning complete member objects.
     * Defaults to page size 25 and offset 0, ordered by descending join time. Results can lag membership changes.
     * indexing=true is not completed emptiness. Empty/indexing=false can also mean an unavailable provider search service
     *
     * Invite-sensitive filters fetch and require the bot's ManageGuild permission first. This is not atomic with search.
     * The three independent precheck reads run concurrently under the same total deadline. A failure interrupts sibling reads.
     * Other filters add no reads. No search hit enters the member cache. Inputs are copied on execution.
     * Includes recognized inherited and nonenumerable filter fields and copies their arrays when the Effect executes
     *
     * The timeoutMs default is 30,000 for the full call. Preflight GETs use shared read retries. The search POST only retries
     * confirmed 429 rejection because it may enqueue indexing. Interruption awaits owned cleanup in the caller's scope
     *
     * GuildOperationError/ClientClosedError remain typed, defects stay in the Cause.
     * Local permission denial is members.search/rejected with outcome notDispatched and no HTTP status
     */
    search(
        guildId: string,
        filters?: MemberSearchQuery,
        options?: GuildOperationOptions,
    ): Effect.Effect<MemberSearchPage, GuildOperationFailure>
    /** Read a bounded Stream of unique indexed member hits, with independent state and copied filters per consumption.
     * Includes recognized inherited and nonenumerable filter fields and copies their arrays per stream consumption.
     * The maxItems option is required, pageSize defaults to 100 (1–100), and maxPages defaults to 100. No prefetch or implicit full-member fetch.
     * Offset advances by received count. Retains at most maxItems user IDs. Changing indexes may skip users despite dedupe.
     * indexing=true fails with PaginationError indexing. An empty page before observed total fails cursorStalled.
     * Reaching maxItems is normal completion, not exhaustion. Input/pageLimit/cursorStalled are other PaginationError reasons.
     * Each page uses search's deadline/preflight/retry rules. Interruption, stream scope closure and client closure release
     * retained state and await owned request cleanup. Delivered snapshots remain caller-owned. Defects remain in the Cause
     */
    iterateSearch(
        guildId: string,
        filters: Omit<MemberSearchQuery, "limit">,
        limits: MemberSearchIterationLimits,
        options?: GuildOperationOptions,
    ): Stream.Stream<MemberSearchHit, GuildOperationFailure | PaginationError>
    /** Edit this bot's server profile, not its global account or another member.
     * Omitted fields remain unchanged and null clears an override. Fluxer enforces permissions and field-specific rate limits.
     * Empty or unknown-key input fails locally.
     * Avatar, banner, bio and accentColor may be silently ignored without the provider's per-guild-profile entitlement.
     * The returned member omits bio and pronouns. Success is not proof those fields were stored.
     * Writes with unknown outcomes and interruption evict affected member retention. Definite rejection preserves prior snapshots
     */
    editSelf(
        guildId: string,
        input: MemberProfileEdit,
        options?: GuildAuditOperationOptions,
    ): Effect.Effect<GuildMember, GuildOperationFailure>
    /** Set or clear one member nickname without replacing that member's roles or profile fields.
     * Null clears it. A raw empty string fails, while a nonempty string containing only trim whitespace is accepted as
     * Fluxer's clear value. Otherwise, validation removes U+000C and U+202E, trims surrounding whitespace, and requires
     * 1–32 UTF-16 code units. The original string is sent unchanged. Fluxer decides ManageNicknames, hierarchy and self rules.
     * The frozen HTTP response is not an event acknowledgement. Interruption awaits request cleanup but cannot undo dispatch.
     * An uncertain result evicts the targeted member cache. A definite rejection preserves its prior snapshot
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import type { Client, MemberReference } from "@neontechspace/fluxerly/effect"
     * export function nicknameExample(client: Client, target: MemberReference) {
     *     return Effect.gen(function* () {
     *         yield* client.members.setNickname(target, "Renamed")
     *         return yield* client.members.setNickname(target, null)
     *     })
     * }
     * ```
     */
    setNickname(
        member: MemberReference,
        nickname: string | null,
        options?: GuildAuditOperationOptions,
    ): Effect.Effect<GuildMember, GuildOperationFailure>
    /** Move an already-connected member to one positive decimal voice-channel ID.
     * Requires MoveMembers plus Fluxer's hierarchy and destination visibility/connect checks. Supplying target.connectionId
     * targets only that observed connection. Omission targets every active connection for the member.
     * HTTP 200 returns a frozen member object containing selected fields after Fluxer accepts the move, not proof that the participant reconnected.
     * A visible move can emit voiceStateUpdate first with channelId null, then with a new connection ID in the destination.
     * Do not repeat an interrupted or unknown write. Interruption awaits cleanup but cannot undo dispatch.
     * Shared moderation deadlines, auditReason validation, confirmed-429 retries and member-cache invalidation apply
     * @example
     * ```ts
     * import type { Client, VoiceConnectionReference } from "@neontechspace/fluxerly/effect"
     * export const moveVoiceConnection = (client: Client, target: VoiceConnectionReference, channelId: string) =>
     *     client.members.move(target, channelId, { auditReason: "Moved to support" })
     * ```
     */
    move(
        target: VoiceConnectionReference,
        channelId: string,
        options?: ModerationOptions,
    ): Effect.Effect<GuildMember, GuildOperationFailure>
    /** Disconnect one observed connection, or every active connection when target.connectionId is omitted.
     * Requires MoveMembers and returns the HTTP member object containing selected fields without waiting for voiceStateUpdate.
     * Repeating after completion can fail because the target is no longer connected. Reconcile an unknown outcome from later
     * snapshots instead of repeating it. Uses move's execution, audit, permission and cache-invalidation rules
     */
    disconnect(
        target: VoiceConnectionReference,
        options?: ModerationOptions,
    ): Effect.Effect<GuildMember, GuildOperationFailure>
    /** Set or clear Fluxer's server mute flag for one currently connected member.
     * Requires MuteMembers and provider hierarchy rules. Returns an HTTP member object containing selected fields with isMuted, without waiting for
     * a voice-state event. This does not control the participant's self-mute state or join a voice channel.
     * Uses move's context, interruption, deadline, audit, retry and member-cache invalidation rules
     */
    setMute(
        target: MemberReference,
        muted: boolean,
        options?: ModerationOptions,
    ): Effect.Effect<GuildMember, GuildOperationFailure>
    /** Set or clear Fluxer's server deafen flag for one currently connected member.
     * Requires DeafenMembers and provider hierarchy rules. Returns an HTTP member object containing selected fields with isDeafened, without waiting
     * for a voice-state event. This does not control the participant's self-deafen state or join a voice channel.
     * Uses move's context, interruption, deadline, audit, retry and member-cache invalidation rules
     */
    setDeaf(
        target: MemberReference,
        deafened: boolean,
        options?: ModerationOptions,
    ): Effect.Effect<GuildMember, GuildOperationFailure>
    /** Set a timeout for integer durationMs in 1–31,536,000,000 milliseconds, calculated when execution starts.
     * The timeoutReason option supplies optional provider audit metadata separately from auditReason. It is not a stored member field or a guarantee that an audit entry is retained
     *
     * Requires ModerateMembers and provider hierarchy rules. The provider rejects self and administrator targets.
     * Queue/network time consumes this duration. An expiry already past at processing time can clear the timeout
     *
     * Returns the frozen HTTP 200 member with communicationDisabledUntil, without waiting for an event.
     * Uses shared guild deadlines and failures. Writes retry only confirmed 429 rejections
     *
     * Each execution preserves the caller's services and defects.
     * Interruption and closure await owned cleanup but cannot undo a timeout request already sent
     *
     * Eligible responses update enabled member caching. Dispatched failures evict the member even on rejection
     * @example
     * ```ts
     * import type { Client, MemberReference } from "@neontechspace/fluxerly/effect"
     * const moderationExample = (client: Client, target: MemberReference) =>
     *     client.members.timeout(target, 5 * 60_000)
     * ```
     */
    timeout(
        target: MemberReference,
        durationMs: number,
        options?: TimeoutOptions,
    ): Effect.Effect<GuildMember, GuildOperationFailure>
    /** Clear a timeout with timeout's permissions, execution, cache and failure rules.
     * Sends null, not a negative duration. Returns the HTTP 200 member without waiting for an event
     */
    clearTimeout(target: MemberReference, options?: TimeoutOptions): Effect.Effect<GuildMember, GuildOperationFailure>
    /** Kick the selected guild member after HTTP 204, without waiting for a removal event.
     * Requires KickMembers and provider hierarchy rules. Does not ban the user or automatically restore membership.
     * Missing membership is a typed API failure. Dispatched actions invalidate the member cache even on rejection.
     * Uses timeout's execution/deadline/failure rules, with no automatic retry after an uncertain result
     */
    kick(target: MemberReference, options?: ModerationOptions): Effect.Effect<void, GuildOperationFailure>
    /** Traverse ascending remote user IDs as a Stream that starts when consumed, without connecting or eagerly downloading the guild.
     * Each execution copies inputs and tracks its own progress using the caller's services
     *
     * The maxItems option is required, pageSize defaults to 100, and maxPages defaults to 100. The timeoutMs option applies separately to each page.
     * Emits frozen members until maxItems or an empty page, not a short page. Pages are not a consistent snapshot
     *
     * PaginationError covers input, cursorStalled and pageLimit. Remote errors retain members.fetchPage's operation/retry policy
     *
     * Interruption and defects retain Cause. Termination awaits request cleanup and releases the buffered page.
     * Closing/Closed releases the page and fails the next pull. Delivered items remain caller-owned after later failure
     *
     * Enabled member caching follows fetchPage's cache-storage rules. No role preloading, permission prediction or full-result retention
     * @example
     * ```ts
     * import { Stream } from "effect"
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export const paginationMembersExample = (client: Client, guildId: string) =>
     *     client.members.iterate(guildId, { maxItems: 1000 }).pipe(
     *         Stream.filter(member => !member.isBot), Stream.take(1), Stream.runCollect,
     *     )
     * ```
     */
    iterate(
        guildId: string,
        query: UserIterationQuery,
        options?: GuildOperationOptions,
    ): Stream.Stream<GuildMember, GuildOperationFailure | PaginationError>
    /** Read the optional member cache by decimal guild and user IDs, following Guilds.get's miss, freshness, failure and least-recently-used eviction rules.
     * Enable cache.members and cache.roles when creating the client. Explicit fetches or subsequent events populate them
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import type { Client, MemberReference } from "@neontechspace/fluxerly/effect"
     * export const cachedRoleNamesExample = (client: Client, target: MemberReference) => Effect.gen(function* () {
     *     const member = yield* client.members.get(target)
     *     if (!member) return undefined
     *     return yield* Effect.forEach(member.roleIds, id =>
     *         client.roles.get({ guildId: target.guildId, id }).pipe(Effect.map(role => role?.name ?? id)))
     * })
     * ```
     * Repeated rendering makes no requests. A missing member returns undefined and missing role names fall back to IDs.
     * This displays observed names, not effective permissions or a completeness guarantee
     */
    get(member: MemberReference): Effect.Effect<GuildMember | undefined, GuildOperationFailure>
    /** Fetch one member by decimal guild/user IDs. HTTP 404 uses notFound rather than an empty result */
    fetch(member: MemberReference, options?: GuildOperationOptions): Effect.Effect<GuildMember, GuildOperationFailure>
    /** Fetch the authenticated bot's membership directly, without requiring READY or a known bot ID */
    fetchSelf(guildId: string, options?: GuildOperationOptions): Effect.Effect<GuildMember, GuildOperationFailure>
    /** Fetch fresh guild, authenticated-bot member, target member and role snapshots in parallel, then evaluate canManageHierarchy.
     * One 30,000 ms default deadline covers the whole composition. Sibling cleanup is awaited on failure or interruption.
     * This never reads a guild cache, retains no helper snapshot, evaluates no permissions or MFA, and does not authorize or perform an action.
     * Like its underlying explicit fetches, enabled guild-resource caches can receive these fresh responses.
     * A true result is only the hierarchy rule over four independently observed resources, which can change before an endpoint request
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export const hierarchyCheckExample = (client: Client, guildId: string, userId: string) =>
     *     client.members.fetchHierarchyCheck({ guildId, userId })
     * ```
     */
    fetchHierarchyCheck(
        target: MemberReference,
        options?: GuildOperationOptions,
    ): Effect.Effect<boolean, GuildOperationFailure>
    /** Fetch an ascending user-ID page. Default limit 100, range 1–1000.
     * Use the last userId as after. An empty page ends traversal. Separate pages are not a consistent snapshot.
     * No hasMore guarantee, automatic traversal or partial malformed page. Inputs are copied on execution, not Effect construction
     */
    fetchPage(
        guildId: string,
        query?: MemberQuery,
        options?: GuildOperationOptions,
    ): Effect.Effect<readonly GuildMember[], GuildOperationFailure>
    /** Grant one decimal role ID without replacing other roles. Reject the implicit everyone role locally.
     * Fluxer enforces MANAGE_ROLES and hierarchy. HTTP 204 is completion, not event acknowledgement or proof the role was previously absent
     * Fluxer currently accepts auditReason on member-role add/remove routes without retaining it in an audit entry
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import type { Client, MessageReference } from "@neontechspace/fluxerly/effect"
     * export const assignRoleExample = (client: Client, message: MessageReference, guildId: string, roleId: string) => Effect.scoped(
     *     Effect.gen(function* () {
     *         const collector = yield* client.messages.collectReactions(message, {
     *             emoji: "✅",
     *             onReaction: reaction => client.members.addRole({ guildId, userId: reaction.userId }, roleId),
     *         })
     *         return yield* collector.waitForClose()
     *     }),
     * )
     * ```
     * Supply a connected client, a message in this guild and a role the bot may assign. Timeout may collect nothing.
     * This bounded one-addition example is not a persistent reaction-role system and does not revoke on reaction removal
     */
    addRole(
        member: MemberReference,
        roleId: string,
        options?: GuildAuditOperationOptions,
    ): Effect.Effect<void, GuildOperationFailure>
    /** Revoke one role with addRole's permission/completion rules. Other roles remain untouched.
     * No local snapshot suppresses the request. Success does not prove a previously assigned role was removed
     */
    removeRole(
        member: MemberReference,
        roleId: string,
        options?: GuildAuditOperationOptions,
    ): Effect.Effect<void, GuildOperationFailure>
}

/** Calculate permission bits from supplied snapshots or freshly fetched resources.
 * These results do not account for timeouts or role hierarchy and do not prove an action will succeed */
export interface PermissionHelpers {
    /** Calculate permissions from supplied snapshots, without requests or cache reads.
     * Connection state is irrelevant, including after shutdown. Missing/inconsistent required data fails with
     * GuildOperationError permissions.calculate/input. Owner/base Administrator grants all unsigned 64 bits.
     * Otherwise applies everyone, aggregated role and member overwrites, preserving unknown bits.
     * Uses the target channel's stored overrides, not its parent category. Inputs read on execution, defects stay in Cause
     */
    calculate(input: PermissionInput): Effect.Effect<bigint, GuildOperationError>
    /** Fetch fresh guild, member, role and optional channel data, then calculate permission bits.
     * No gateway or cache-first lookup. Existing caches may admit fetched resources, but permission results are not retained.
     * Sequential reads are not atomic or an authorization guarantee. `timeoutMs` defaults to 30,000 across the workflow.
     * Shared read retries apply. Interruption awaits owned cleanup in the caller's scope.
     * Invalid inputs use permissions.fetch/input, resource failures retain their GuildOperationError/ChannelOperationError,
     * client closure uses ClientClosedError and defects remain in Cause. Cross-guild channel snapshots fail
     */
    fetch(
        target: PermissionTarget,
        options?: GuildOperationOptions,
    ): Effect.Effect<bigint, GuildOperationFailure | ChannelOperationFailure>
}

/** Read or change guild roles, their permission bits and their ordering.
 * Methods return Effects and share Guilds' HTTP concurrency limits, deadlines and read retries.
 * Writes retry only confirmed 429 rejections. Server permissions/hierarchy apply. No local permission prediction.
 * Interruption waits for owned cleanup but cannot undo write requests already sent. Success is not a gateway acknowledgement.
 * Expected failures use GuildOperationError or ClientClosedError. Defects and interruption retain Cause.
 * Inputs are copied on execution, not Effect construction. Returned roles contain bigint permissions and require explicit JSON conversion
 * Every remote role mutation accepts GuildAuditOperationOptions. The fetchAll method rejects auditReason
 */
export interface Roles {
    /** Read the optional role cache by decimal guild and role IDs, including everyone.
     * Follows Guilds.get's miss, freshness, failure and least-recently-used eviction rules */
    get(role: RoleReference): Effect.Effect<GuildRole | undefined, GuildOperationFailure>
    /** Fetch the current role list, including everyone, in server order. Always remote, without pagination or automatic refresh */
    fetchAll(
        guildId: string,
        options?: GuildOperationOptions,
    ): Effect.Effect<readonly GuildRole[], GuildOperationFailure>
    /** Create a role with name, color and permissions. Permissions default to 0n, not Fluxer's inherited everyone grants.
     * Supplied permissions must be from 0n through 9_223_372_036_854_775_807n.
     * Explicit permissions include ViewChannelMembers through Fluxer's required feature opt-in.
     * Returns the server's actual grants, which can differ from the request. Hoist/mentionable changes require a separate edit
     * @example
     * ```ts
     * import { Permissions, type Client } from "@neontechspace/fluxerly/effect"
     * export const createRoleExample = (client: Client, guildId: string) =>
     *     client.roles.create(guildId, {
     *         name: "Readers",
     *         permissions: Permissions.ViewChannel | Permissions.ReadMessageHistory,
     *     })
     * ```
     * The caller owns the created role. On an unknown outcome, reconcile with fetchAll before deciding whether to create again
     */
    create(
        guildId: string,
        input: RoleCreate,
        options?: GuildAuditOperationOptions,
    ): Effect.Effect<GuildRole, GuildOperationFailure>
    /** Patch only defined fields and return the server's snapshot. Empty/unknown-field patches are input errors.
     * Replacement permissions must be from 0n through 9_223_372_036_854_775_807n. Larger received masks cannot be written unchanged.
     * The permissions input replaces the raw grants, including setting or clearing ViewChannelMembers. It is not an additive grant.
     * The default/everyone role accepts only color and permissions. Other defined fields fail locally, including mixed patches */
    edit(
        role: RoleReference,
        input: RoleEdit,
        options?: GuildAuditOperationOptions,
    ): Effect.Effect<GuildRole, GuildOperationFailure>
    /** Delete a role, also removing its assignments upstream. Everyone cannot be deleted.
     * HTTP 204 is completion, not proof of member-event delivery. Old member/role snapshots remain unchanged */
    delete(role: RoleReference, options?: GuildAuditOperationOptions): Effect.Effect<void, GuildOperationFailure>
    /** Reorder distinct role IDs using nonnegative safe-integer positions. Everyone cannot move.
     * Fluxer normalizes manageable positions, so fetchAll afterward when final order matters. HTTP 204 carries no list.
     * This operation and multi-step workflows are not transactions: Failures can leave partial state. Refetch before reconciliation */
    reorder(
        guildId: string,
        positions: readonly RolePosition[],
        options?: GuildAuditOperationOptions,
    ): Effect.Effect<void, GuildOperationFailure>
    /** Set display positions for distinct roles without changing permission hierarchy or enabling hoist.
     * Requires a nonempty list of signed 32-bit positions, excluding everyone. Fluxer enforces ManageRoles and hierarchy.
     * HTTP 204 returns no roles. Successful writes or writes with unknown outcomes invalidate retained guild roles, including pending reads.
     * Failures or cancellation can leave partial changes. Refetch before reconciliation rather than replaying blindly
     * @example
     * ```ts
     * import { type Client } from "@neontechspace/fluxerly/effect"
     * export function orderRoleDisplay(client: Client, guildId: string, roleId: string) {
     *     return client.roles.setHoistPositions(guildId, [{ id: roleId, hoistPosition: 0 }])
     * }
     * ```
     */
    setHoistPositions(
        guildId: string,
        positions: readonly RoleHoistPosition[],
        options?: GuildAuditOperationOptions,
    ): Effect.Effect<void, GuildOperationFailure>
    /** Clear display-position assignments for every role in the guild, not just roles below the bot.
     * Fluxer enforces ManageRoles. Permission hierarchy and hoist flags remain unchanged.
     * HTTP 204 has no role list. This is not transactional. A failure can leave partial changes.
     * Successful writes or writes with unknown outcomes invalidate retained guild roles. Refetch to reconcile an unknown outcome
     */
    resetHoistPositions(
        guildId: string,
        options?: GuildAuditOperationOptions,
    ): Effect.Effect<void, GuildOperationFailure>
}

/** Create and manage webhooks with the bot token, without a gateway connection.
 * No webhook cache, hidden credential persistence or synthesized events.
 * Successful JSON responses are limited to 16 MiB before parsing. This is not a total memory limit. Malformed or larger responses fail with reason response.
 * If a response fails after a write was sent, the write may still have applied. The SDK does not retry it automatically.
 * Each Effect starts when executed, with Effect interruption and defects.
 * Requests default to a 30-second total deadline, allow bounded read retries and retry writes only after confirmed rate-limit rejection.
 * Shutdown rejects new work and awaits accepted request cleanup. Separate clients do not coordinate rate limits
 */
export interface Webhooks {
    /** Create one webhook using bot permissions. Returns redacted credentials separately from metadata. An uncertain result may have created it */
    create(
        channelId: string,
        input: WebhookCreate,
        options?: WebhookOperationOptions,
    ): Effect.Effect<CreatedWebhook, WebhookOperationFailure>
    /** Fetch metadata remotely by decimal ID, discarding the returned token. HTTP 404 reports notFound */
    fetch(id: string, options?: WebhookOperationOptions): Effect.Effect<Webhook, WebhookOperationFailure>
    /** Read the channel's complete accessible webhook list remotely, without caching, token retention or pagination */
    fetchChannel(
        channelId: string,
        options?: WebhookOperationOptions,
    ): Effect.Effect<readonly Webhook[], WebhookOperationFailure>
    /** Read the guild's accessible webhook list remotely. Server permissions determine visibility, and concurrent changes prevent snapshot guarantees */
    fetchGuild(
        guildId: string,
        options?: WebhookOperationOptions,
    ): Effect.Effect<readonly Webhook[], WebhookOperationFailure>
    /** Update explicit settings, including destination moves. Returned metadata omits credentials. Failure does not guarantee rollback */
    edit(
        id: string,
        input: WebhookEdit,
        options?: WebhookOperationOptions,
    ): Effect.Effect<Webhook, WebhookOperationFailure>
    /** Delete the webhook and revoke its credential. Does not delete its old messages or restore the credential after a failure */
    delete(id: string, options?: WebhookOperationOptions): Effect.Effect<void, WebhookOperationFailure>
}

/** Send and manage one webhook's messages using its webhook token.
 * This client does not use a bot token, connect the gateway, cache resources or store tokens persistently
 *
 * Operations start when executed and preserve unexpected faults/interruption.
 * Cleanup defects stop retries and preserve any operation failure or interruption alongside the defect in Cause
 *
 * Requests default to a 30-second total deadline across queue waits, rate-limit waits, retries and HTTP.
 * Confirmed HTTP 429 responses use this client's shared rate-limit state as described on Client.
 * Cancellation interrupts only that operation and awaits request/body cleanup, without rolling back remote effects
 *
 * Errors contain only safe categories and status, never credential-bearing paths or upstream bodies
 *
 * Successful JSON bodies are capped at 16 MiB of response-body bytes before parsing, not total heap usage. Oversized successes fail with reason response.
 * A response failure after a mutation request was sent leaves an unknown outcome and never retries automatically
 *
 * Other client caches are not updated by this token-only client
 */
export interface WebhookClient {
    /** This webhook's decimal ID, without its token or a token-bearing URL */
    readonly id: string
    /** Immutable endpoint discovery and pure URL helpers for this webhook client's selected instance */
    readonly instance: Instance
    /** Fetch this credential's current remote metadata without bot authentication or retaining creator/private fields */
    fetch(options?: MessageOperationOptions): Effect.Effect<Webhook, WebhookOperationFailure>
    /** Update only this webhook's name or avatar through its credential. Channel moves require bot webhooks.edit.
     * A failed or interrupted write can have applied and does not close this client
     */
    edit(input: WebhookTokenEdit, options?: MessageOperationOptions): Effect.Effect<Webhook, WebhookOperationFailure>
    /** Delete this remote webhook through its credential. HTTP 204 does not close this client or erase its local credential reference.
     * Later remote operations normally fail notFound after revocation. Use shutdown separately to release local resources
     */
    delete(options?: MessageOperationOptions): Effect.Effect<void, WebhookOperationFailure>
    /** Send through this webhook and return the created message using wait=true. Mentions default off.
     * Reply references can include files. Forwarded references preserve only their source snapshot and reject new content/uploads
     *
     * Attachments use inline multipart streaming with a 50 MiB maximum per file and the configured upload-byte budget.
     * Each attachment supplies data bytes, a sized Blob/File-compatible source, or a finite stream with its exact size
     *
     * Inputs are prepared when the Effect executes. data bytes are copied before waiting, while file and stream sources are not copied or spooled.
     * Readers are acquired when multipart upload begins. Keep file data stable and supply a fresh stream for a new operation.
     * Streams are consumed at most once and must deliver exactly their declared size. Cleanup cancels unfinished readers and awaits lock release, without closing caller paths or FileHandles
     *
     * A confirmed HTTP 429 can retry copied data only. File and stream sources fail with rateLimit instead of being reopened or reread
     *
     * Image/thumbnail attachment URLs must match a new upload in this execution. flags accepts only the two non-voice MessageFlags bits.
     * Never retry an unknown send outcome, which may already have posted
     */
    send(input: WebhookMessageInput, options?: MessageOperationOptions): Effect.Effect<Message, WebhookOperationFailure>
    /** Fetch a decimal message ID authored by this webhook in its current channel, with bounded transient read retries */
    fetchMessage(messageId: string, options?: MessageOperationOptions): Effect.Effect<Message, WebhookOperationFailure>
    /** Edit this webhook's message and return its snapshot. Omitted fields remain unchanged, mentions default off, and attachments cannot be replaced.
     * flags-only edits replace the two writable non-voice bits. Zero clears them. Existing file references are not resolved for embed inputs
     */
    editMessage(
        messageId: string,
        input: WebhookMessageEdit,
        options?: MessageOperationOptions,
    ): Effect.Effect<Message, WebhookOperationFailure>
    /** Delete this webhook's message. 204 is success without proving earlier existence, and uncertain failures may follow deletion */
    deleteMessage(messageId: string, options?: MessageOperationOptions): Effect.Effect<void, WebhookOperationFailure>
    /** Permanently reject new work, cancel accepted work, await transport cleanup and release the owned token reference.
     * Does not delete the remote webhook or invalidate caller-held credentials. Concurrent calls share the same pending cleanup
     */
    shutdown(): Effect.Effect<void>
}

/** Inspect or clear this client's optional in-memory caches.
 * These controls do not request fresh data, change remote resources or retain Effect services */
export interface ClientCache<M extends MessageCore = Message> {
    /**
     * List up to limit frozen snapshots containing selected fields from one configured cache category.
     * Results contain only data already observed by this client, in current eviction order.
     * Entries use least-to-most-recent order. Local lookups promote recency, while enumeration does not
     *
     * Omit limit for 100 entries. A positive safe integer from 1 through 1,000 is required.
     * Execution releases expired entries before the snapshot and does not refresh data or change the eviction order
     *
     * The frozen array can be partial because retention, expiry, conflicts, gaps, clear and shutdown discard snapshots.
     * Entries contain the requested cached data, unlike client.diagnostics. No network request or remote completeness claim is made
     *
     * A closed client succeeds with an empty array. Invalid kind or limit fails with ConfigurationError without exposing the rejected value.
     * It captures no service or scope. Interruption before execution leaves cache state unchanged. Once started it completes synchronously
     */
    entries<K extends CacheKind>(
        kind: K,
        options?: CacheEntriesOptions,
    ): Effect.Effect<readonly CachedResources<M>[K][], ConfigurationError>
    /**
     * Synchronously release every SDK-held cache snapshot without changing configuration, requests or remote resources.
     * Frozen snapshots held by the application remain unchanged.
     * In-flight reads that began before this call cannot repopulate cleared snapshots. Later reads can cache normally.
     * Existing mutation guards retain their conservative invalidation behavior. Safe to repeat, including after closure.
     * It takes no cancellation signal and completes synchronously
     */
    clear(): void
}

/**
 * A bot client whose asynchronous methods return descriptions of work as Effects or Streams.
 * Execute Effects with yield* inside Effect.gen or with an Effect runner. Consume Streams to start their work.
 * Each operation uses the caller's Effect services and cancellation.
 * The scope that creates the client owns its connection work and permanent cleanup.
 * Expected errors use Effect's error channel. Unexpected faults and cancellation remain in Cause.
 * Cleanup defects stop retries and preserve any operation failure or interruption alongside the defect in Cause.
 * Successful REST JSON responses are limited to 16 MiB before parsing. This is not a total memory limit. Upload planning and completion responses have a separate 1 MiB limit
 *
 * A confirmed HTTP 429 response with a valid retry delay pauses all API routes on this client when
 * X-RateLimit-Global is true, X-RateLimit-Scope is global, or the JSON body has global: true.
 * A valid global indicator takes priority over conflicting route-specific metadata. Malformed scope values are ignored.
 * A global header with a valid Retry-After starts the pause before body inspection, including when
 * the body is missing, malformed, oversized or too slow. Body inspection stays bounded to 8 KiB and 100 ms before awaited cleanup.
 * Without global metadata, only requests in the same rate-limit group wait. Without a usable delay, the call fails rather than guessing how long to wait.
 * Rate-limit waits count toward each call's original deadline. Interruption removes only that call from the queue, not the shared pause.
 * Separate clients do not coordinate these waits. Attachment downloads do not wait for API rate limits.
 * Writes retry only confirmed rate-limit rejection, never an uncertain outcome
 *
 * Valid X-RateLimit-Bucket metadata updates how this client groups rate-limited routes, without application configuration.
 * Known Fluxer templates retain their channel, guild, user, webhook or invite resource partitions.
 * Unknown route templates share one rate-limit bucket when they report the same identifier, to avoid exceeding a possible shared limit.
 * Initial requests can still receive 429 before the server's grouping is learned.
 * Each client tracks at most 2,048 route aliases and 2,048 bucket states. Idle aliases expire after five minutes unless they preserve an active pause.
 * Old responses cannot undo newer mappings or reopen an exhausted window. A changed mapping preserves any known prior pause until it expires.
 * When tracking reaches capacity, the client drops observations that are not blocking requests first. If active pauses fill capacity or a route cannot be grouped safely,
 * the client waits rather than ignoring a known limit. Closing the client clears this temporary state
 *
 * Each gateway connection accepts uncompressed text messages up to 100 MiB (104,857,600 bytes), counting all fragments together.
 * The transport checks this size before decoding UTF-8 or parsing JSON. This keeps the previous transport default.
 * This is not a Fluxer server-to-client maximum, an outbound command limit, a subscription budget or a JavaScript heap bound.
 * Larger messages fail with ConnectionError, phase gateway, reason protocol and status 1009. Invalid UTF-8 uses status 1007.
 * Neither failure retries automatically. A failed standalone connect waits for cleanup and allows another explicit connect.
 * A failed managed run or established connection ends the client lifetime. Use waitForClose to observe later failures
 */
export interface Client<M extends MessageCore = Message> extends ClientState {
    /** Immutable endpoint discovery and pure URL helpers for this client's selected instance */
    readonly instance: Instance
    /** Public server-directory management, not instance endpoint discovery or directory joining */
    readonly discovery: Discovery
    /** Process-local requested presence, restored after gateway reconnects and never stored across process restarts */
    readonly presence: Presence
    /** Read documented fields for this bot token's application, without owner details or application-management operations */
    readonly application: CurrentBotApplication
    /** Read public account information or look up an optionally cached account */
    readonly users: Users
    /** Open private conversations, send messages or manage existing groups */
    readonly directMessages: DirectMessages<M>
    /** Bot-authenticated webhook management with token-free metadata */
    readonly webhooks: Webhooks
    /** Manage roles remotely or look up optionally cached roles */
    readonly roles: Roles
    /** Explicit local and remote permission-bit helpers, without cached decisions */
    readonly permissions: PermissionHelpers
    /** Read guilds and manage bans remotely, or look up optionally cached guilds */
    readonly guilds: Guilds
    /** Inspect and manage invites remotely, without accepting them or retaining codes */
    readonly invites: Invites
    /** Read filtered audit-log pages or a bounded sequence of entries, without an audit cache */
    readonly auditLogs: AuditLogs
    /** Create, read or change custom emoji, with optional metadata caching */
    readonly emojis: Emojis
    /** Create, read or change custom stickers, with optional metadata caching */
    readonly stickers: Stickers
    /** Read or change guild channels remotely, or look up optionally cached channels */
    readonly channels: Channels
    /** Read members, moderate them or assign specific roles */
    readonly members: Members
    /** Explicit signed-URL refresh and bounded attachment downloads for this selected instance */
    readonly attachments: Attachments
    /** Send, read or change messages, use the optional message cache, or collect future gateway messages and reactions */
    readonly messages: Messages<M>
    /** Local cache enumeration and release controls. Caching remains opt-in through ClientOptions.cache */
    readonly cache: ClientCache<M>
    /**
     * Register one EventMap event in the caller's scope and context, before or after connect.
     * No cache or REST-generated events. Bulk deletions do not also invoke messageDelete handlers.
     * Enabled cache changes happen before user dispatch, independently of subscriptions and their overflow
     *
     * Defaults: One active invocation, 256 queued payloads, 4 MiB queued incoming JSON per registration.
     * A bulk payload counts once, including its full bytes. Ordering is per subscription, not across event types.
     * Explicit concurrency permits out-of-order completion. No history or exactly-once delivery is promised
     *
     * Handler failures are isolated and reported without retrying the invocation.
     * Inspect the original application Cause inside the handler with Effect.tapCause before SDK isolation.
     * The onError callback and SDK logs receive only safe event/kind metadata, not original failures, defects or stacks.
     * Keep credentials, payloads and arbitrary Cause text out of logs. An application inspector must not fail or throw
     *
     * Overflow stops only this subscription and remains observable through the returned handle.
     * Client or registration-scope closure interrupts handlers and awaits handler cleanup.
     * Observe subscription failure alongside client.run/waitForClose. No separate SDK runtime is created
     * @example
     * ```ts
     * import { Cause, Effect } from "effect"
     * import type { Client, Message } from "@neontechspace/fluxerly/effect"
     * export function debugHandlerExample<E, R>(
     *     client: Client,
     *     handle: (message: Message) => Effect.Effect<void, E, R>,
     *     inspectFailure: (cause: Cause.Cause<E>) => void,
     * ) {
     *     return client.on("messageCreate", (message) =>
     *         Effect.suspend(() => handle(message)).pipe(
     *             // Inspect locally without raw logging, preserving the failure for SDK isolation
     *             Effect.tapCause((cause) => Effect.sync(() => inspectFailure(cause))),
     *         ),
     *     )
     * }
     * ```
     */
    on<E, R, E2 = never, R2 = never, K extends EventName = "messageCreate">(
        event: K,
        handler: (message: EventMap<M>[K]) => Effect.Effect<unknown, E, R>,
        options?: EventHandlerOptions<E2, R2>,
    ): Effect.Effect<Subscription, RegistrationError, R | R2 | Scope.Scope>
    /**
     * Receive one event type as a bounded Stream in receive order.
     * Each execution owns a subscription without history or splitting bulk events into individual events.
     * Enabled cache changes happen before delivery, independently of this subscription and its overflow.
     * Stream scope releases its subscription. Overflow fails this stream rather than silently dropping events.
     * Consumers choose stream concurrency and supervision. Options govern source buffers only
     */
    events<K extends EventName>(
        event: K,
        options?: EventBufferOptions,
    ): Stream.Stream<EventMap<M>[K], RegistrationError | EventOverflowError>
    /**
     * Observe one event type and return the first future payload accepted by a synchronous filter.
     * Each execution owns a separate bounded subscription in its executing fiber, with no separate SDK runtime, connection or remote request.
     * No history or cache lookup occurs. Recovery can miss events, and reconnecting does not restart the deadline
     *
     * The default deadline is 30,000 ms from registration. Timeout or an invalid/throwing filter fails with EventWaitError without raw input or exception text.
     * Inspect application-owned filter exceptions locally before rethrowing. Overflow, invalid configuration and client closure remain distinct failures
     *
     * Interruption releases the subscription, timer, queued payloads and filter without shutting down the client. SDK/cleanup defects remain in Cause
     *
     * Creating or forking this Effect is not a registration barrier. Use a scoped on subscription or collector when registration must finish before an action
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export function eventWaitExample(client: Client, channelId: string, userId: string) {
     *     return client.waitFor("typingStart", {
     *         filter: event => event.channelId === channelId && event.userId === userId,
     *         timeoutMs: 10_000,
     *     })
     * }
     * ```
     */
    waitFor<K extends EventName>(
        event: K,
        options?: EventWaitOptions<K, M>,
    ): Effect.Effect<EventMap<M>[K], EventWaitFailure>
    /**
     * Read a frozen snapshot of this client's local resource usage.
     * Event counts include open sources, message/reaction collectors and executing subscription handlers, not an enforced client-wide admission quota.
     * This performs no network work, telemetry or persistence and includes no tokens, remote routes, resource IDs or payloads.
     * Counts cover this client's owned shards and accepted local work only. Accounted bytes are cache/queue budgets, not heap, process memory or remote storage.
     * Configured cache bounds remain visible after closure, while retained counts report actual owner release progress. This does not establish remote completeness or readiness.
     * It takes no cancellation signal and completes synchronously
     */
    diagnostics(): ClientDiagnostics
    /**
     * Open the gateway when this Effect executes, and return after every locally assigned shard authenticates and receives READY.
     * READY does not mean that every GUILD_CREATE event, member roster or resource has arrived
     *
     * Use connect when startup must finish separately from the client's lifetime.
     * Connection and recovery continue in the client's creation Scope after connect succeeds.
     * Before initial readiness, cancellation or an expected startup failure waits for assigned-shard cleanup.
     * The caller can then try connect again while that Scope remains open.
     * After initial readiness, a permanent required-shard failure in a multi-shard plan closes the client.
     * The waitForClose method retains that failure as ShardConnectionError with the shardId and underlying failure
     *
     * An already-connected client succeeds without opening another socket unless run owns its lifetime.
     * Competing startup or run work fails with ClientBusyError without taking ownership.
     * Closing or Closed clients fail with ClientClosedError. Other expected startup failures use ConnectError.
     * Unexpected faults and interruption remain in Cause
     */
    connect(): Effect.Effect<void, ConnectError>
    /**
     * Start the gateway and keep this Effect pending for the client's lifetime, including transient recovery.
     * Use run for a program that should own startup, lifetime observation and permanent cleanup together.
     * Once accepted, run leaves the client Closed when it ends, including on failure or cancellation
     *
     * Only a Disconnected client without competing work accepts run.
     * A busy or closed rejection leaves existing work untouched.
     * Cancelling an accepted run stops its whole lifetime and waits for cleanup.
     * After initial readiness, a permanent required-shard failure in a multi-shard plan closes the client and reports ShardConnectionError.
     * Success means normal shutdown. Expected connection, busy or closed errors use ConnectError.
     * Unexpected faults and interruption remain in Cause, alongside any cleanup faults
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import { createClient } from "@neontechspace/fluxerly/effect"
     *
     * export const runBot = (token: string) => Effect.scoped(
     *     Effect.gen(function* () {
     *         const client = yield* createClient({ token })
     *         yield* client.run()
     *     }),
     * )
     * ```
     * The application executes this Effect and handles its typed failures and Cause
     */
    run(): Effect.Effect<void, ConnectError>
    /**
     * Wait for this client's terminal result without starting or owning its connection.
     * Transient recovery keeps the wait pending. Multiple and late waiters receive the retained result.
     * An expected connect failure before initial readiness also leaves this wait pending, because the caller can try connecting again.
     * Cancelling this wait removes only that waiter, not the connection or other waiters.
     * Closing the client's creation Scope still shuts down the client
     *
     * Success means normal shutdown. Permanent connection failure uses ConnectionFailure.
     * After initial readiness, a permanent required-shard failure in a multi-shard plan is retained as ShardConnectionError.
     * Background and cleanup faults remain in Cause, alongside any expected failure
     */
    waitForClose(): Effect.Effect<void, ConnectionFailure>
    /**
     * Permanently stop this client and wait for its owned resources to finish cleanup.
     * Once shutdown starts, it disables interruption so the caller cannot abandon cleanup.
     * Repeated or concurrent calls share the same shutdown result. A Closed client cannot restart
     *
     * Stop startup and recovery, release cached references and timers, and interrupt handlers, collectors and cache-error callbacks.
     * Their finalizers must finish before closure. User work that disables interruption can delay shutdown.
     * If an owned handler, collector callback or cache-error callback calls shutdown, the client Scope performs shutdown and interrupts that invocation.
     * That invocation does not resume afterward, avoiding a wait on its own cleanup.
     * Explicit shutdown makes a pending connect fail with ClientClosedError rather than interruption
     *
     * An established socket gets up to 5,000 ms to close gracefully.
     * Afterward it is force-terminated, and shutdown still waits for the close event.
     * Pending handshakes terminate immediately. Forced termination may discard unsent data.
     * The SDK releases its credential reference but does not terminate the process or undo remote writes.
     * No expected error is returned. Cleanup faults remain defects in Cause.
     * When shutdown interrupts an owned worker, that interruption and any cleanup defect remain separate Cause reasons
     */
    shutdown(): Effect.Effect<void>
    /**
     * Observe the current connection state, then later updates.
     * Each consumer gets a coordinated initial snapshot and at most one newest pending update.
     * Slow consumers can miss intermediate states. Closed ends the Stream.
     * Ending consumption releases that subscription without stopping the client.
     * Use waitForClose to observe a terminal error, rather than inferring success from this status Stream
     */
    observeState(): Stream.Stream<ConnectionState>
}

/**
 * Resolve the service addresses and URL helpers for the instance selected at client creation
 *
 * `resolve` starts when executed and uses the caller's Effect services. Concurrent callers share one document read
 * that runs in the client Scope. Interrupting one caller releases only that caller's wait. A successful immutable
 * result is reused without refresh until client shutdown
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import type { Client } from "@neontechspace/fluxerly/effect"
 * export const instanceExample = (client: Client) => Effect.gen(function* () {
 *     const resolved = yield* client.instance.resolve({ timeoutMs: 10_000 })
 *     const channel = yield* resolved.links.channel({ id: "1750000000000000000" })
 *     const avatar = yield* resolved.assets.defaultAvatar("1750000000000000000")
 *     return { api: resolved.endpoints.apiPublic, channel, avatar }
 * })
 * ```
 */
export interface Instance {
    /** Resolve this client's immutable selected-instance endpoint map and pure asset/link helpers.
     * The unauthenticated bootstrap has a 30,000 ms deadline for this caller's wait unless overridden. Interruption releases only this caller's wait, while another resolve, REST request or gateway connection can keep the shared read alive.
     * Expected document, rate-limit, timeout, closure and local timeout-setting failures use Effect's failure channel. Cleanup defects remain in Cause with any failure or interruption
     */
    resolve(options?: InstanceResolveOptions): Effect.Effect<ResolvedInstance, InstanceResolveError>
}

/**
 * Create a webhook-only client for hosted Fluxer or an explicitly selected self-hosted instance, from { id, token } or redacted creation credentials.
 * Validate the inputs locally without requests. The client copies the credential into its own redacted reference.
 * Creation starts when the Effect executes. Closing its Scope shuts down the client.
 * The Effect Clock available when creation executes owns this client's request queue and deadlines. Providing a
 * different Clock around a later operation does not replace that owner Clock.
 * The SDK does not persist the token, connect a gateway or authenticate as a bot. Reuse one client per credential to share request slots, queue limits and rate-limit waits.
 * Invalid configuration fails with ConfigurationError, while defects retain their Cause
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { createWebhookClient } from "@neontechspace/fluxerly/effect"
 * export const webhookExample = (id: string, token: string) => Effect.scoped(Effect.gen(function* () {
 *     const webhook = yield* createWebhookClient({ id, token })
 *     const message = yield* webhook.send({ content: "Deploying…" })
 *     return yield* webhook.editMessage(message.id, { content: "Deployed" })
 * }))
 * ```
 */
export function createWebhookClient(
    options: WebhookClientOptions,
): Effect.Effect<WebhookClient, ConfigurationError, Scope.Scope> {
    return Effect.gen(function* () {
        const owner = yield* makeWebhookClient(options)
        yield* Effect.addFinalizer(() => owner.shutdown())
        let instance: ResolvedInstance | undefined
        return Object.freeze({
            id: owner.id,
            instance: Object.freeze({
                resolve: (options?: InstanceResolveOptions) =>
                    owner.instance
                        .resolveInfo(options)
                        .pipe(Effect.map((value) => (instance ??= effectInstance(value)))),
            }),
            fetch: (options?: MessageOperationOptions) =>
                owner.run("webhooks.fetchToken", () => webhookTokenFetch(owner.id), options),
            edit: (input: WebhookTokenEdit, options?: MessageOperationOptions) =>
                owner.run("webhooks.editToken", () => webhookTokenEdit(owner.id, input), options),
            delete: (options?: MessageOperationOptions) =>
                owner.run("webhooks.deleteToken", () => webhookTokenDelete(owner.id), options),
            send: (input: WebhookMessageInput, options?: MessageOperationOptions) =>
                owner.run("webhooks.send", () => webhookSend(owner.id, input), options),
            fetchMessage: (id: string, options?: MessageOperationOptions) =>
                owner.run("webhooks.fetchMessage", () => webhookMessage(owner.id, id, "GET"), options),
            editMessage: (id: string, input: WebhookMessageEdit, options?: MessageOperationOptions) =>
                owner.run("webhooks.editMessage", () => webhookMessage(owner.id, id, "PATCH", input), options),
            deleteMessage: (id: string, options?: MessageOperationOptions) =>
                owner.run("webhooks.deleteMessage", () => webhookMessageDelete(owner.id, id), options),
            shutdown: () => owner.shutdown(),
        })
    })
}

/** Set the bot's status or select guild members whose presence updates the bot should receive.
 * The client retains these requests in memory, not across process restarts.
 * Outgoing status updates send to every live locally owned shard and are spaced by at least four seconds per shard. Member selections are separate bounded gateway presence requests.
 * No provider acknowledgement or recipient-delivery guarantee is available. The SDK performs no remote membership lookup or self filtering. Fluxer owns access and filtering
 */
export interface Presence {
    /** Validate and freeze the latest requested status/custom status, including before connect.
     * Omitted customStatus preserves this client's previous request. Null clears it, and expired custom statuses are not restored.
     * Success means local acceptance and scheduled updates to each shard, not an atomic provider acknowledgement across shards. Shutdown releases the intent and pending timer
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import { MemberMentionPreferences, type Client } from "@neontechspace/fluxerly/effect"
     * export const botProfileExample = (client: Client, guildId: string) => Effect.gen(function* () {
     *     yield* client.presence.set({ status: "online", customStatus: { text: "Ready", emoji: { name: "🌱" } } })
     *     return yield* client.members.editSelf(guildId, { nickname: "Support", mentionFlags: MemberMentionPreferences.PreferNoMention })
     * })
     * ```
     * Unexpected defects remain in the Effect cause
     */
    set(input: PresenceInput): Effect.Effect<void, PresenceFailure>
    /**
     * Validate, copy and retain this guild's selected member IDs when run. Pass `[]` to clear its selection.
     * The SDK neither fetches members nor subscribes all guild members. Select accessible non-self members deliberately. Fluxer remains authoritative for access and filtering
     *
     * The guild must route to a shard assigned to this client. An unassigned guild fails PresenceError input instead of retaining an unsent selection
     *
     * Input accepts at most 1,000 distinct decimal IDs, but the full UTF-8 gateway presence-request frame must be at most 4,096 bytes, so long IDs lower the effective per-guild maximum.
     * This client retains selections for at most 100 guilds and 10,000 IDs. A cleared selection that was already sent retains one bounded session slot until a fresh identify or a confirmed leave, because a local socket write has no provider acknowledgement. Clearing an unsent selection releases its slot immediately
     *
     * After READY or RESUMED, the latest selection or clear is coalesced and attempted at most once per 125 ms. Calling setMembers with the same list deliberately requests a caller-controlled refresh. Matching guild creation also reattempts the latest selection or a previously sent clear. This neither establishes that Fluxer applied it nor that `on("presenceUpdate")` will deliver anything
     *
     * A subscription can yield an initial visible state or later transitions. Recovery gaps can miss both. Presence is never cached or looked up.
     * Loss of shared channel visibility can drop provider subscriptions. Resend the set after access returns
     *
     * Listener scope closure does not clear the selection. Clear explicitly or shut down the client to release its local intent
     *
     * Input and limit failures fail with PresenceError, while a closing client fails with ClientClosedError. Unexpected defects remain in the Effect cause
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export const watchSelectedMember = (client: Client, guildId: string, memberId: string) => Effect.gen(function* () {
     *     const subscription = yield* client.on("presenceUpdate", (presence) =>
     *         Effect.sync(() => { if (presence.guildId === guildId && presence.userId === memberId) void presence.status }),
     *     )
     *     return yield* client.presence.setMembers(guildId, [memberId]).pipe(
     *         Effect.as(subscription),
     *         Effect.onError(() => subscription.unsubscribe()),
     *     )
     * })
     * ```
     */
    setMembers(guildId: string, memberIds: readonly string[]): Effect.Effect<void, PresenceFailure>
}

/** Read the application associated with this bot token through GET `/oauth2/applications/@me`.
 * No gateway connection is required.
 * Effects start when executed and can be run again, using the caller's services with the shared 30-second total deadline and at most two transient read retries.
 * Returns a frozen set of documented application fields, without caching. Owner identity, redirect URIs, verification keys, client secrets, and nested bot fields are never exposed.
 * Fluxer remains authoritative for application visibility and installability. This read neither manages an application nor opens an authorization page.
 * Input, HTTP, and malformed-response failures use BotApplicationOperationError. Closure uses ClientClosedError. Interruption and defects remain in the Cause
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { links, type Client } from "@neontechspace/fluxerly/effect"
 * export const applicationExample = (client: Client) => Effect.gen(function* () {
 *     const application = yield* client.application.fetchCurrent()
 *     return yield* links.installation(application.id, { permissions: 0n })
 * })
 * ```
 */
export interface CurrentBotApplication {
    /** Fetch this token's frozen documented application fields remotely, without cache writes, gateway events, owner lookup, or hidden follow-up requests */
    fetchCurrent(
        options?: BotApplicationOperationOptions,
    ): Effect.Effect<BotApplication, BotApplicationOperationFailure>
}

/** Read public account information or a privacy-filtered profile.
 * Methods return Effects with shared 30-second default deadlines and at most two eligible transient read retries.
 * Writes retry only confirmed rate-limit rejection, never an unknown outcome. No gateway connection is required.
 * Cancellation and unexpected faults remain in Cause rather than becoming UserOperationError
 */
export interface Users {
    /** Look up a decimal ID in the optional local cache without a request. A hit marks the entry recently used but does not refresh its data. Results may be absent or stale. Closed clients fail */
    get(id: string): Effect.Effect<User | undefined, UserOperationFailure>
    /** Fetch a public account snapshot remotely by decimal ID. Unknown IDs fail with notFound.
     * An enabled user cache can store this ID even when other user IDs are being read
     */
    fetch(id: string, options?: UserOperationOptions): Effect.Effect<User, UserOperationFailure>
    /** Fetch one frozen privacy-filtered profile by decimal user ID, optionally in an explicit guild context.
     * Each execution issues a separate read, without gateway readiness, automatic related-resource reads or account or profile cache changes.
     * Returns only the documented account identity and profile fields. `isLimited` reports Fluxer's privacy restriction, not missing membership.
     * A null guildProfile means no contextual profile was supplied, not proof that the account is outside the guild.
     * Uses Users' shared deadline and bounded read retries. Fluxer may clear expired premium state while serving this GET.
     * Invalid IDs/query, denied access and malformed responses fail with UserOperationError operation users.fetchProfile.
     * Closing/Closed fail with ClientClosedError. Interruption awaits cleanup. Defects and interruption retain Cause
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export function profileExample(client: Client, userId: string, guildId: string) {
     *     return client.users.fetchProfile(userId, { guildId })
     * }
     * ```
     */
    fetchProfile(
        id: string,
        query?: UserProfileQuery,
        options?: UserOperationOptions,
    ): Effect.Effect<UserProfile, UserOperationFailure>
    /** Fetch the authenticated bot remotely, stripping private account fields.
     * Because the ID is unknown before the response, this read checks for changes across the whole user cache. A later cache change can prevent its result from being stored
     */
    fetchSelf(options?: UserOperationOptions): Effect.Effect<User, UserOperationFailure>
}

/** Open private conversations, send messages or manage existing groups.
 * Methods return Effects with shared 30-second default deadlines and at most two eligible transient read retries.
 * Writes retry only confirmed rate-limit rejection, never an unknown outcome. No gateway connection is required.
 * Cancellation and unexpected faults remain in Cause rather than becoming UserOperationError
 */
export interface DirectMessages<M extends MessageCore = Message> {
    /** Open or reopen a DM and send using one total deadline, with mentions disabled by default.
     * Each execution prepares the message metadata and copies data byte inputs before opening the conversation.
     * File and stream sources are captured, not copied. Their readers are acquired later when uploads start, after any presigned planning.
     * Sources follow messages.send's size, upload-budget and reader-cleanup rules. An inline multipart 429 does not replay file or stream sources.
     * MessageError(notSent) does not mean opening was undone. Unknown sends are never repeated automatically.
     * Opening by user ID uses collection-wide direct-message cache conflict handling because the channel ID is not known yet.
     * No reply reference is accepted here. Use messages.reply after obtaining a channel/message reference
     * @example
     * ```ts
     * import { Effect } from "effect"
     * import type { Client } from "@neontechspace/fluxerly/effect"
     * export const notifyUserExample = (client: Client, userId: string) => Effect.gen(function* () {
     *     const user = yield* client.users.fetch(userId)
     *     return yield* client.directMessages.send(user.id, { content: `Hello ${user.displayName ?? user.username}` })
     * })
     * ```
     */
    send(userId: string, input: ReplyInput, options?: SendOptions): Effect.Effect<M, SendError>
    /** Look up a decimal ID in the optional local cache without a request. A hit marks the entry recently used but does not refresh its data. Results may be absent or stale. Closed clients fail */
    get(id: string): Effect.Effect<DirectMessageChannel | undefined, UserOperationFailure>
    /** Open or reopen a one-to-one conversation. Privacy checks may prevent delivery even after opening succeeds.
     * Because the channel ID is unknown before the response, this read checks for changes across the whole direct-message cache. A later cache change can prevent its result from being stored
     */
    open(userId: string, options?: UserOperationOptions): Effect.Effect<DirectMessageChannel, UserOperationFailure>
    /** Fetch a private channel remotely. Guild channels are rejected as invalid responses.
     * An enabled cache can store this ID even when other private-channel IDs are being read
     */
    fetch(id: string, options?: UserOperationOptions): Effect.Effect<DirectMessageChannel, UserOperationFailure>
    /** Read open one-to-one and group conversations remotely, excluding personal notes. This is not an atomic snapshot or a complete message history.
     * The enabled cache does not replace data changed by a newer targeted request or channel event
     */
    fetchAll(options?: UserOperationOptions): Effect.Effect<readonly DirectMessageChannel[], UserOperationFailure>
    /** Fetch the latest message for 1–100 explicitly selected distinct DM/group-DM IDs through Fluxer's batch endpoint.
     * IDs are copied by index when the Effect is executed.
     * POST is read-shaped but is not retried after a dispatched uncertain failure. It does not enumerate conversations or populate any cache.
     * Returned null is ambiguous. The omittedChannelIds field preserves requested IDs Fluxer omitted, with no inference about channel content or access
     */
    fetchLatestMessages(
        channelIds: readonly string[],
        options?: UserOperationOptions,
    ): Effect.Effect<DirectMessageLatestMessages<M>, UserOperationFailure>
    /** Edit settings of an existing group. A null name clears it. Omission leaves it unchanged. Fluxer enforces member/owner permissions. Failure does not guarantee rollback.
     * Normally invalidates only this conversation's cached data. A cache-wide conflict check can also prevent older in-flight results from being stored
     */
    editGroup(
        id: string,
        input: DirectMessageGroupEdit,
        options?: UserOperationOptions,
    ): Effect.Effect<DirectMessageChannel, UserOperationFailure>
    /** Close a DM for this bot or leave a group. Does not erase another recipient's conversation. Owner departure may transfer ownership.
     * Normally invalidates only this conversation's cached data. A cache-wide conflict check can also prevent older in-flight results from being stored
     */
    close(id: string, options?: UserOperationOptions): Effect.Effect<void, UserOperationFailure>
    /** Remove a group recipient as owner, or remove self. Does not request deletion of that user's messages. A last-recipient departure deletes the group.
     * Normally invalidates only this conversation's cached data. A cache-wide conflict check can also prevent older in-flight results from being stored
     */
    removeRecipient(
        id: string,
        userId: string,
        options?: UserOperationOptions,
    ): Effect.Effect<void, UserOperationFailure>
}

/**
 * Create a bot client from the supplied token when this Effect executes
 *
 * Use `Effect.scoped` to keep the client open while the bot works and shut it down when the Scope closes.
 * The client starts disconnected. Call `connect` or `run` to receive gateway events
 *
 * @remarks
 * **Client lifetime**
 *
 * Calling `createClient` does not create a client yet. Each execution creates a separate client in the caller's Scope and validates configuration locally, without authenticating the token
 *
 * Creation starts no networking or background work. HTTP operations work without `connect`.
 * Closing the scope permanently shuts down the client and releases its credential reference.
 * Cache-error callbacks capture the Effect services available when creation executes
 * The Effect Clock supplied at creation controls this client's REST queue and deadlines, cache expiry, collectors,
 * presence pacing and gateway lifetime. Supplying a different Clock for a later operation does not replace it.
 * Operation-specific waits and utilities document which Clock they use. Logging durations never control deadlines
 *
 * **Instance and caching**
 *
 * Omit `instance` for hosted Fluxer. For a self-hosted instance, pass its root. The unauthenticated well-known document supplies HTTP, gateway, image and application addresses when needed.
 * HTTPS and WSS are required unless that explicit instance sets `allowInsecure: true` for HTTP and WS
 *
 * Caching is disabled by default. Cache settings are copied and validated without invoking retention policies or reporters.
 * Unknown cache or message-cache option keys fail validation
 *
 * **Connection and sharding**
 *
 * Connection settings default to a 30,000 ms overall startup budget and three total attempts per assigned shard.
 * A sharding plan fixes this client's local IDs for its lifetime. Shard zero receives direct-message gateway traffic.
 * REST and cache budgets apply across the whole client, not separately to each shard
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { createClient } from "@neontechspace/fluxerly/effect"
 *
 * export function shardingExample(token: string) {
 *     return Effect.scoped(Effect.gen(function* () {
 *         const client = yield* createClient({ token, sharding: { totalShards: 4, shardIds: [0, 2] } })
 *         yield* client.connect()
 *         return client.shards
 *     }))
 * }
 * ```
 *
 * @returns A scoped, lazy creation Effect with ConfigurationError for invalid input.
 * Unexpected creation defects retain their Cause
 */
export function createClient<E = never, R = never, const F extends MessageFields | undefined = undefined>(
    options: ClientOptions<E, R, F>,
): Effect.Effect<Client<SelectedMessage<F>>, ConfigurationError, Scope.Scope | R> {
    type M = SelectedMessage<F>
    return Effect.gen(function* () {
        // One client-owned scope lets shutdown mark Closing before interrupting its worker
        const scope = Scope.makeUnsafe()
        const owner = yield* makeClient<F>(options, scope, true)
        yield* Effect.addFinalizer((exit) => owner.shutdown().pipe(Effect.ensuring(Scope.close(scope, exit))))
        let instance: ResolvedInstance | undefined
        return Object.freeze({
            instance: Object.freeze({
                resolve: (options?: InstanceResolveOptions) =>
                    owner.instance
                        .resolveInfo(options)
                        .pipe(Effect.map((value) => (instance ??= effectInstance(value)))),
            }),
            presence: Object.freeze({
                set: (input: PresenceInput) => owner.setPresence(input),
                setMembers: (guildId: string, memberIds: readonly string[]) =>
                    owner.setPresenceMembers(guildId, memberIds),
            }),
            cache: Object.freeze({
                entries: <K extends CacheKind>(kind: K, options?: CacheEntriesOptions) =>
                    owner.cacheEntries(kind, options),
                clear: () => owner.clearCache(),
            }),
            application: Object.freeze({
                fetchCurrent: (options?: BotApplicationOperationOptions) =>
                    owner.application("application.fetchCurrent", () => applicationCurrent(), options),
            }),
            users: Object.freeze({
                get: (id: string) => owner.getUserResource("users", id),
                fetch: (id: string, options?: UserOperationOptions) =>
                    owner.user("users.fetch", () => userFetch(id), options),
                fetchSelf: (options?: UserOperationOptions) =>
                    owner.user("users.fetchSelf", () => userFetch("@me"), options),
                fetchProfile: (id: string, query?: UserProfileQuery, options?: UserOperationOptions) =>
                    owner.user("users.fetchProfile", () => userProfile(id, query), options),
            }),
            directMessages: Object.freeze({
                send: (userId: string, input: ReplyInput, options?: SendOptions) =>
                    owner.sendDirectMessage(userId, input, options),
                get: (id: string) => owner.getUserResource("directMessages", id),
                open: (userId: string, options?: UserOperationOptions) =>
                    owner.user("directMessages.open", () => directMessageOpen(userId), options),
                fetch: (id: string, options?: UserOperationOptions) =>
                    owner.user("directMessages.fetch", () => directMessageFetch(id), options),
                fetchAll: (options?: UserOperationOptions) =>
                    owner.user("directMessages.fetchAll", () => directMessageList(), options),
                fetchLatestMessages: (ids: readonly string[], options?: UserOperationOptions) =>
                    owner.user(
                        "directMessages.fetchLatestMessages",
                        () => directMessageLatestMessages(ids, owner.decodeMessage),
                        options,
                    ),
                editGroup: (id: string, input: DirectMessageGroupEdit, options?: UserOperationOptions) =>
                    owner.user("directMessages.editGroup", () => directMessageEdit(id, input), options),
                close: (id: string, options?: UserOperationOptions) =>
                    owner.user("directMessages.close", () => directMessageClose(id), options),
                removeRecipient: (id: string, userId: string, options?: UserOperationOptions) =>
                    owner.user("directMessages.removeRecipient", () => directMessageClose(id, userId), options),
            }),
            webhooks: Object.freeze({
                create: (id: string, input: WebhookCreate, options?: WebhookOperationOptions) =>
                    owner.webhook("webhooks.create", () => webhookCreate(id, input, options), options),
                fetch: (id: string, options?: WebhookOperationOptions) =>
                    owner.webhook("webhooks.fetch", () => webhookFetch(id), options),
                fetchChannel: (id: string, options?: WebhookOperationOptions) =>
                    owner.webhook("webhooks.fetchChannel", () => webhookList(id, "channels"), options),
                fetchGuild: (id: string, options?: WebhookOperationOptions) =>
                    owner.webhook("webhooks.fetchGuild", () => webhookList(id, "guilds"), options),
                edit: (id: string, input: WebhookEdit, options?: WebhookOperationOptions) =>
                    owner.webhook("webhooks.edit", () => webhookEdit(id, input, options), options),
                delete: (id: string, options?: WebhookOperationOptions) =>
                    owner.webhook("webhooks.delete", () => webhookDelete(id, options), options),
            }),
            emojis: Object.freeze({
                get: (target: ExpressionReference) => owner.getResource("emojis", target),
                fetchAll: (id: string, options?: GuildOperationOptions) =>
                    owner.guild("emojis.fetchAll", () => expressionList("emojis", id), options),
                fetchMetadata: (id: string, options?: GuildOperationOptions) =>
                    owner.guild("emojis.fetchMetadata", () => expressionMetadata("emojis", id), options),
                create: (id: string, input: EmojiCreate, options?: ModerationOptions) =>
                    owner.guild("emojis.create", () => expressionCreate("emojis", id, input, options), options),
                createMany: (id: string, input: readonly EmojiCreate[], options?: ModerationOptions) =>
                    owner.guild("emojis.createMany", () => expressionBatch("emojis", id, input, options), options),
                clone: (id: string, sourceId: string, options?: ModerationOptions) =>
                    owner.guild("emojis.clone", () => expressionClone("emojis", id, sourceId, options), options),
                edit: (target: ExpressionReference, input: EmojiEdit, options?: ModerationOptions) =>
                    owner.guild("emojis.edit", () => expressionEdit("emojis", target, input, options), options),
                delete: (target: ExpressionReference, options?: ExpressionDeleteOptions) =>
                    owner.guild("emojis.delete", () => expressionDelete("emojis", target, options), options),
            }),
            stickers: Object.freeze({
                edit: (target: ExpressionReference, input: StickerEdit, options?: ModerationOptions) =>
                    owner.guild("stickers.edit", () => expressionEdit("stickers", target, input, options), options),
                get: (target: ExpressionReference) => owner.getResource("stickers", target),
                fetchAll: (id: string, options?: GuildOperationOptions) =>
                    owner.guild("stickers.fetchAll", () => expressionList("stickers", id), options),
                fetchMetadata: (id: string, options?: GuildOperationOptions) =>
                    owner.guild("stickers.fetchMetadata", () => expressionMetadata("stickers", id), options),
                create: (id: string, input: StickerCreate, options?: ModerationOptions) =>
                    owner.guild("stickers.create", () => expressionCreate("stickers", id, input, options), options),
                createMany: (id: string, input: readonly StickerCreate[], options?: ModerationOptions) =>
                    owner.guild("stickers.createMany", () => expressionBatch("stickers", id, input, options), options),
                clone: (id: string, sourceId: string, options?: ModerationOptions) =>
                    owner.guild("stickers.clone", () => expressionClone("stickers", id, sourceId, options), options),
                delete: (target: ExpressionReference, options?: ExpressionDeleteOptions) =>
                    owner.guild("stickers.delete", () => expressionDelete("stickers", target, options), options),
            }),
            auditLogs: Object.freeze({
                fetchPage: (id: string, query: AuditLogQuery, options?: GuildOperationOptions) =>
                    owner.guild("auditLogs.fetchPage", () => auditLogPage(id, query), options),
                iterate: (id: string, query: AuditLogIterationQuery, options?: GuildOperationOptions) =>
                    paginationStream(auditLogPagination(owner, id, query, options)),
            }),
            invites: Object.freeze({
                fetch: (code: string, options?: GuildOperationOptions) =>
                    owner.guild("invites.fetch", () => inviteFetch(code), options),
                create: (channelId: string, input?: InviteCreate, options?: ModerationOptions) =>
                    owner.guild("invites.create", () => inviteCreate(channelId, input, options), options),
                fetchChannel: (channelId: string, options?: GuildOperationOptions) =>
                    owner.guild("invites.fetchChannel", () => inviteList("channels", channelId), options),
                fetchGuild: (guildId: string, options?: GuildOperationOptions) =>
                    owner.guild("invites.fetchGuild", () => inviteList("guilds", guildId), options),
                delete: (code: string, options?: ModerationOptions) =>
                    owner.guild("invites.delete", () => inviteDelete(code, options), options),
            }),
            discovery: Object.freeze({
                search: (query?: DiscoverySearchQuery, options?: GuildOperationOptions) =>
                    owner.guild("discovery.search", () => discoverySearch(query), options),
                fetchStatus: (id: string, options?: GuildOperationOptions) =>
                    owner.guild("discovery.fetchStatus", () => discoveryStatus(id), options),
                fetchCategories: (options?: GuildOperationOptions) =>
                    owner.guild("discovery.fetchCategories", discoveryCategories, options),
                apply: (id: string, input: DiscoveryApplicationInput, options?: GuildOperationOptions) =>
                    owner.guild("discovery.apply", () => discoveryWrite(id, input), options),
                edit: (id: string, input: DiscoveryApplicationEdit, options?: GuildOperationOptions) =>
                    owner.guild("discovery.edit", () => discoveryWrite(id, input, true), options),
                withdraw: (id: string, options?: GuildOperationOptions) =>
                    owner.guild("discovery.withdraw", () => discoveryWithdraw(id), options),
            }),
            guilds: Object.freeze({
                fetchCounts: (ids: readonly string[], options?: CountOperationOptions) =>
                    owner.counts.fetchGuilds(ids, options),
                fetchPage: (query?: GuildListQuery, options?: GuildOperationOptions) =>
                    owner.guild("guilds.fetchPage", () => guildList(query), options),
                iterate: (query: GuildIterationQuery, options?: GuildOperationOptions) =>
                    paginationStream(guildPagination(owner, query, options)),
                leave: (id: string, options?: GuildOperationOptions) => owner.leaveGuild(id, options),
                deleteMine: (id: string, options?: GuildOperationOptions) => owner.deleteGuildMessages(id, options),
                fetchVanityUrl: (id: string, options?: GuildOperationOptions) =>
                    owner.guild("guilds.fetchVanityUrl", () => vanityUrlFetch(id), options),
                editVanityUrl: (id: string, code: string | null, options?: ModerationOptions) =>
                    owner.guild("guilds.editVanityUrl", () => vanityUrlEdit(id, code, options), options),
                edit: (id: string, input: GuildEdit, options?: ModerationOptions) =>
                    owner.guild("guilds.edit", () => guildEdit(id, input, options), options),
                ban: (target: MemberReference, input?: BanInput, options?: ModerationOptions) =>
                    owner.guild("guilds.ban", () => guildBan(target, input, options), options),
                unban: (target: MemberReference, options?: ModerationOptions) =>
                    owner.guild("guilds.unban", () => guildUnban(target, options), options),
                fetchBans: (id: string, options?: GuildOperationOptions) =>
                    owner.guild("guilds.fetchBans", () => guildBans(id), options),
                get: (id: string) => owner.getResource("guilds", id),
                fetch: (id: string, options?: GuildOperationOptions) =>
                    owner.guild("guilds.fetch", () => guildFetch(id), options),
            }),
            channels: Object.freeze({
                fetchMemberCounts: (guildId: string, ids: readonly string[], options?: CountOperationOptions) =>
                    owner.counts.fetchChannels(guildId, ids, options),
                get: (id: string) => owner.getChannel(id),
                fetch: (id: string, options?: ChannelOperationOptions) =>
                    owner.channel("channels.fetch", () => channelFetch(id), options),
                fetchAll: (id: string, options?: ChannelOperationOptions) =>
                    owner.channel("channels.fetchAll", () => channelList(id), options),
                create: (id: string, input: ChannelCreate, options?: ChannelAuditOperationOptions) =>
                    owner.channel("channels.create", () => channelCreate(id, input), options),
                edit: (id: string, input: ChannelEdit, options?: ChannelAuditOperationOptions) =>
                    owner.channel("channels.edit", () => channelEdit(id, input), options),
                delete: (id: string, options?: ChannelAuditOperationOptions) =>
                    owner.channel("channels.delete", () => channelDelete(id), options),
                reorder: (id: string, positions: readonly ChannelPosition[], options?: ChannelAuditOperationOptions) =>
                    owner.channel("channels.reorder", () => channelReorder(id, positions), options),
                setPermissionOverwrite: (
                    id: string,
                    input: PermissionOverwrite,
                    options?: ChannelAuditOperationOptions,
                ) => owner.channel("channels.setPermissionOverwrite", () => permissionSet(id, input), options),
                removePermissionOverwrite: (id: string, targetId: string, options?: ChannelAuditOperationOptions) =>
                    owner.channel("channels.removePermissionOverwrite", () => permissionRemove(id, targetId), options),
            }),
            members: Object.freeze({
                iterateChunks: (guildId: string, query: MemberChunkQuery, options?: MemberChunkOptions) =>
                    memberChunkStream(owner.memberChunks.open(guildId, query, options)),
                setRoles: (target: MemberReference, roleIds: readonly string[], options?: GuildAuditOperationOptions) =>
                    owner.guild("members.setRoles", () => memberRolesSet(target, roleIds), options),
                search: (id: string, query?: MemberSearchQuery, options?: GuildOperationOptions) =>
                    searchMembers(owner, id, query, options),
                iterateSearch: (
                    id: string,
                    filters: Omit<MemberSearchQuery, "limit">,
                    limits: MemberSearchIterationLimits,
                    options?: GuildOperationOptions,
                ) => paginationStream(searchMemberPagination(owner, id, filters, limits, options)),
                editSelf: (guildId: string, input: MemberProfileEdit, options?: GuildAuditOperationOptions) =>
                    owner.guild("members.editSelf", () => memberEditSelf(guildId, input), options),
                setNickname: (target: MemberReference, nickname: string | null, options?: GuildAuditOperationOptions) =>
                    owner.guild("members.setNickname", () => memberNicknameEdit(target, nickname), options),
                move: (target: VoiceConnectionReference, channelId: string, options?: ModerationOptions) =>
                    owner.guild("members.move", () => memberVoiceMove(target, channelId, options), options),
                disconnect: (target: VoiceConnectionReference, options?: ModerationOptions) =>
                    owner.guild("members.disconnect", () => memberVoiceMove(target, null, options), options),
                setMute: (target: MemberReference, muted: boolean, options?: ModerationOptions) =>
                    owner.guild("members.setMute", () => memberVoiceFlag(target, "mute", muted, options), options),
                setDeaf: (target: MemberReference, deafened: boolean, options?: ModerationOptions) =>
                    owner.guild("members.setDeaf", () => memberVoiceFlag(target, "deaf", deafened, options), options),
                timeout: (target: MemberReference, durationMs: number, options?: TimeoutOptions) =>
                    owner.guild("members.timeout", () => memberTimeout(target, durationMs, options), options),
                clearTimeout: (target: MemberReference, options?: TimeoutOptions) =>
                    owner.guild("members.clearTimeout", () => memberTimeout(target, null, options, true), options),
                kick: (target: MemberReference, options?: ModerationOptions) =>
                    owner.guild("members.kick", () => memberKick(target, options), options),
                iterate: (id: string, query: UserIterationQuery, options?: GuildOperationOptions) =>
                    paginationStream(memberPagination(owner, id, query, options)),
                get: (target: MemberReference) => owner.getResource("members", target),
                fetch: (target: MemberReference, options?: GuildOperationOptions) =>
                    owner.guild("members.fetch", () => memberFetch(target), options),
                fetchSelf: (id: string, options?: GuildOperationOptions) =>
                    owner.guild("members.fetchSelf", () => memberSelf(id), options),
                fetchHierarchyCheck: (target: MemberReference, options?: GuildOperationOptions) =>
                    fetchHierarchyCheck(owner, target, options),
                fetchPage: (id: string, query?: MemberQuery, options?: GuildOperationOptions) =>
                    owner.guild("members.fetchPage", () => memberPage(id, query), options),
                addRole: (target: MemberReference, id: string, options?: GuildAuditOperationOptions) =>
                    owner.guild("members.addRole", () => memberRole(target, id, true), options),
                removeRole: (target: MemberReference, id: string, options?: GuildAuditOperationOptions) =>
                    owner.guild("members.removeRole", () => memberRole(target, id, false), options),
            }),
            permissions: Object.freeze({
                calculate: (input: PermissionInput) => calculatePermissions(input),
                fetch: (target: PermissionTarget, options?: GuildOperationOptions) =>
                    fetchPermissions(owner, target, options),
            }),
            roles: Object.freeze({
                setHoistPositions: (
                    id: string,
                    positions: readonly RoleHoistPosition[],
                    options?: GuildAuditOperationOptions,
                ) => owner.guild("roles.setHoistPositions", () => roleSetHoistPositions(id, positions), options),
                resetHoistPositions: (id: string, options?: GuildAuditOperationOptions) =>
                    owner.guild("roles.resetHoistPositions", () => roleResetHoistPositions(id), options),
                get: (target: RoleReference) => owner.getResource("roles", target),
                fetchAll: (id: string, options?: GuildOperationOptions) =>
                    owner.guild("roles.fetchAll", () => roleList(id), options),
                create: (id: string, input: RoleCreate, options?: GuildAuditOperationOptions) =>
                    owner.guild("roles.create", () => roleCreate(id, input), options),
                edit: (target: RoleReference, input: RoleEdit, options?: GuildAuditOperationOptions) =>
                    owner.guild("roles.edit", () => roleEdit(target, input), options),
                delete: (target: RoleReference, options?: GuildAuditOperationOptions) =>
                    owner.guild("roles.delete", () => roleDelete(target), options),
                reorder: (id: string, positions: readonly RolePosition[], options?: GuildAuditOperationOptions) =>
                    owner.guild("roles.reorder", () => roleReorder(id, positions), options),
            }),
            attachments: Object.freeze({
                refreshUrls: (urls: readonly string[], options?: AttachmentRefreshOptions) =>
                    owner.refreshAttachmentUrls(urls, options),
                download: (attachment: Attachment, options: AttachmentDownloadOptions) =>
                    owner.downloadAttachment(attachment, options),
                stream: (attachment: Attachment, options: AttachmentDownloadOptions) => {
                    let consumed = false
                    return Stream.unwrap(
                        Effect.suspend(() => {
                            if (consumed) return Effect.fail(new AttachmentDownloadError("busy"))
                            consumed = true
                            return Effect.gen(function* () {
                                const source = yield* Effect.acquireRelease(
                                    Effect.interruptible(owner.streamAttachment(attachment, options)),
                                    (source) => source.closeEffect,
                                )
                                return Stream.unfold(undefined, () =>
                                    source.next.pipe(
                                        Effect.map((chunk) =>
                                            chunk === undefined ? undefined : ([chunk, undefined] as const),
                                        ),
                                    ),
                                )
                            })
                        }),
                    )
                },
            }),
            messages: Object.freeze({
                iterateHistory: (id: string, query: HistoryIterationQuery, options?: MessageOperationOptions) =>
                    paginationStream(historyPagination(owner, id, query, options)),
                search: (
                    context: MessageSearchContext,
                    query?: MessageSearchQuery,
                    options?: MessageOperationOptions,
                ) => owner.searchMessages(context, query, options),
                iterateSearch: (
                    context: MessageSearchContext,
                    filters: Omit<MessageSearchQuery, "limit" | "page">,
                    limits: MessageSearchIterationLimits,
                    options?: MessageOperationOptions,
                ) => paginationStream(searchMessagePagination(owner, context, filters, limits, options)),
                iterateReactionUsers: (
                    target: MessageReference,
                    emoji: ReactionEmojiInput,
                    query: UserIterationQuery,
                    options?: MessageOperationOptions,
                ) => paginationStream(reactionUserPagination(owner, target, emoji, query, options)),
                iteratePins: (id: string, query: PinIterationQuery, options?: MessageOperationOptions) =>
                    paginationStream(pinPagination(owner, id, query, options)),
                removeUserReaction: (
                    target: MessageReference,
                    emoji: ReactionEmojiInput,
                    userId: string,
                    options?: MessageOperationOptions,
                ) => owner.reaction("removeUserReaction", target, emoji, options, userId),
                clearReaction: (
                    target: MessageReference,
                    emoji: ReactionEmojiInput,
                    options?: MessageOperationOptions,
                ) => owner.reaction("clearReaction", target, emoji, options),
                clearReactions: (target: MessageReference, options?: MessageOperationOptions) =>
                    owner.reaction("clearReactions", target, undefined, options),
                pin: (target: MessageReference, options?: MessageOperationOptions) => owner.pin("pin", target, options),
                unpin: (target: MessageReference, options?: MessageOperationOptions) =>
                    owner.pin("unpin", target, options),
                fetchPins: (channel: string, query?: MessagePinsQuery, options?: MessageOperationOptions) =>
                    owner.fetchPins(channel, query, options),
                fetchReactionUsers: (
                    target: MessageReference,
                    emoji: ReactionEmojiInput,
                    query?: ReactionUsersQuery,
                    options?: MessageOperationOptions,
                ) => owner.fetchReactionUsers(target, emoji, query, options),
                addReaction: (target: MessageReference, emoji: ReactionEmojiInput, options?: MessageOperationOptions) =>
                    owner.reaction("addReaction", target, emoji, options),
                removeReaction: (
                    target: MessageReference,
                    emoji: ReactionEmojiInput,
                    options?: MessageOperationOptions,
                ) => owner.reaction("removeReaction", target, emoji, options),
                collect: <E = never, R = never>(channelId: string, options?: CollectorOptions<E, R, M>) =>
                    Effect.uninterruptible(
                        Effect.gen(function* () {
                            const callerScope = yield* Effect.scope
                            const source = yield* collect(owner, channelId, options, false, options?.onMessage)
                            // A scoped waiter releases its registration when done, rather than retaining every completed collector until scope closure
                            yield* Effect.forkIn(
                                Deferred.await(source.closed).pipe(
                                    Effect.asVoid,
                                    Effect.interruptible,
                                    Effect.onExit(() =>
                                        Effect.sync(() => source.stop()).pipe(
                                            Effect.andThen(Effect.exit(Deferred.await(source.closed))),
                                        ),
                                    ),
                                    Effect.catchCause(() => Effect.void),
                                ),
                                callerScope,
                                { uninterruptible: true },
                            )
                            return nativeCollector(source)
                        }),
                    ),
                get: (target: MessageReference) => owner.get(target),
                collectReactions: <E = never, R = never>(
                    target: MessageReference,
                    options?: ReactionCollectorOptions<E, R>,
                ) =>
                    Effect.uninterruptible(
                        Effect.gen(function* () {
                            const callerScope = yield* Effect.scope
                            const source = yield* collectReactions(owner, target, options, false, options?.onReaction)
                            yield* Effect.forkIn(
                                Deferred.await(source.closed).pipe(
                                    Effect.asVoid,
                                    Effect.interruptible,
                                    Effect.onExit(() =>
                                        Effect.sync(() => source.stop()).pipe(
                                            Effect.andThen(Effect.exit(Deferred.await(source.closed))),
                                        ),
                                    ),
                                    Effect.catchCause(() => Effect.void),
                                ),
                                callerScope,
                                { uninterruptible: true },
                            )
                            return nativeReactionCollector(source)
                        }),
                    ),
                send: (channelId: string, input: MessageInput, options?: SendOptions) =>
                    owner.send(channelId, input, options),
                forward: (channelId: string, input: ForwardMessageInput, options?: SendOptions) =>
                    owner.forward(channelId, input, options),
                typing: (channelId: string, options?: MessageOperationOptions) => owner.typing(channelId, options),
                keepTyping: <A, E, R>(
                    channelId: string,
                    task: Effect.Effect<A, E, R>,
                    options?: MessageOperationOptions,
                ) => owner.keepTyping(channelId, task, options),
                reply: (target: MessageReference, input: ReplyInput, options?: SendOptions) =>
                    owner.reply(target, input, options),
                fetch: (target: MessageReference, options?: MessageOperationOptions) => owner.fetch(target, options),
                fetchHistory: (channelId: string, query?: MessageHistoryQuery, options?: MessageOperationOptions) =>
                    owner.fetchHistory(channelId, query, options),
                previewCleanup: (
                    channelId: string,
                    selection: MessageCleanupSelection<M>,
                    options?: MessageOperationOptions,
                ) => previewCleanup(owner, channelId, selection, options),
                cleanup: (plan: MessageCleanupPlan<M>, options?: MessageCleanupOptions) =>
                    cleanup(owner, plan, options),
                edit: (target: MessageReference, input: EditMessageInput, options?: MessageOperationOptions) =>
                    owner.edit(target, input, options),
                delete: (target: MessageReference, options?: MessageOperationOptions) => owner.delete(target, options),
                deleteAttachment: (target: MessageReference, attachmentId: string, options?: MessageOperationOptions) =>
                    owner.deleteAttachment(target, attachmentId, options),
                deleteMany: (channelId: string, ids: readonly string[], options?: MessageOperationOptions) =>
                    owner.deleteMany(channelId, ids, options),
                deleteMine: (channelId: string, options?: MessageOperationOptions) =>
                    owner.deleteMine(channelId, options),
            }),
            on: <E, R, E2 = never, R2 = never, K extends EventName = "messageCreate">(
                event: K,
                handler: (message: EventMap<M>[K]) => Effect.Effect<unknown, E, R>,
                options?: EventHandlerOptions<E2, R2>,
            ) =>
                Effect.gen(function* () {
                    const callerScope = yield* Effect.scope
                    const source = yield* owner.events.on(event, handler, options, options?.onError, callerScope)
                    return nativeSubscription(source)
                }),
            events: <K extends EventName>(event: K, options?: EventBufferOptions) =>
                owner.events.stream(event, options),
            waitFor: <K extends EventName>(event: K, options?: EventWaitOptions<K, M>) =>
                waitForEvent(owner.events, event, options),
            diagnostics: () => owner.diagnostics(),
            get state() {
                return owner.state
            },
            get gatewayLatencyMs() {
                return owner.gatewayLatencyMs
            },
            get shards() {
                return owner.shards
            },
            connect: () => owner.connect(),
            run: () => owner.run(),
            waitForClose: () => owner.waitForClose(),
            shutdown: () => owner.shutdown(),
            observeState: () => owner.observeState(),
        })
    })
}

function nativeSubscription(source: Pick<EventSource, "stop" | "closed">): Subscription {
    return Object.freeze({
        unsubscribe: () => Effect.sync(() => source.stop()),
        waitForClose: () => Deferred.await(source.closed),
    })
}

function nativeCollector<M extends MessageCore>(source: MessageCollector<M>): Collector<M> {
    return Object.freeze({
        stop: () => Effect.sync(() => source.stop()),
        waitForClose: () => Deferred.await(source.closed),
    })
}

// Keep completed handles outside the registration closure so they do not retain options or the caller's scope
function nativeReactionCollector(source: ReactionCollection): ReactionCollector {
    return Object.freeze({
        stop: () => Effect.sync(() => source.stop()),
        waitForClose: () => Deferred.await(source.closed),
    })
}

/**
 * Build an Effect that runs a bot in the application's context. Execute it once to create the client,
 * install subscriptions and start the gateway, in that order. The runner's Scope keeps subscriptions open
 * and cleans them up. Subscriptions returned by install must stay running. The runner does not restart them
 *
 * Aborting the optional signal, or receiving SIGINT/SIGTERM when enabled, stops the bot successfully after cleanup.
 * Interrupting the Effect fiber instead reports interruption, with any cleanup failure in Effect's Cause.
 * Expected creation, installation, connection and subscription failures use the error channel. A required subscription
 * that closes normally before the bot stops causes CriticalWorkerStoppedError. When several operations fail,
 * Cause keeps their failures together, including cleanup defects. The runner does not log or replace them.
 * It uses the application's services, logger, tracing and interruption, without creating a separate runtime or
 * exiting the process
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { runBot } from "@neontechspace/fluxerly/effect"
 *
 * const bot = runBot({ token: "YOUR_BOT_TOKEN" }, (client) =>
 *     Effect.gen(function* () {
 *         const subscription = yield* client.on("messageCreate", () => Effect.void)
 *         return [subscription]
 *     }), { processSignals: true })
 * await Effect.runPromise(bot)
 * ```
 */
export function runBot<
    OptionsError = never,
    OptionsServices = never,
    InstallError = never,
    InstallServices = never,
    const F extends MessageFields | undefined = undefined,
>(
    options: ClientOptions<OptionsError, OptionsServices, F>,
    install: (
        client: Client<SelectedMessage<F>>,
    ) => Effect.Effect<readonly Subscription[], InstallError, InstallServices | Scope.Scope>,
    runOptions: RunBotOptions = {},
): Effect.Effect<
    void,
    ConfigurationError | ConnectError | EventOverflowError | CriticalWorkerStoppedError | InstallError,
    OptionsServices | Exclude<InstallServices, Scope.Scope>
> {
    return runBotCore(createClient(options), install, runOptions) as Effect.Effect<
        void,
        ConfigurationError | ConnectError | EventOverflowError | CriticalWorkerStoppedError | InstallError,
        OptionsServices | Exclude<InstallServices, Scope.Scope>
    >
}
