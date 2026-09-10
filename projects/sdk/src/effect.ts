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
 * Pure Fluxer markup helpers with no client, network, cache, or notification-state ownership.
 * Fallible helpers are lazy Effects; `escapeMarkdown` returns text directly. Mention markup does not enable notifications
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
export const format = Object.freeze({
    /** Escape every character accepted after a Fluxer markup backslash. This returns text immediately and cannot change allowed mentions */
    escapeMarkdown: sharedFormat.escapeMarkdown,
    /** Lazily format a canonical decimal user ID as `<@id>`. Execution fails with HelperError for an invalid ID and never enables notifications */
    userMention: (id: string) => helperEffect(() => sharedFormat.userMention(id)),
    /** Lazily format a canonical decimal role ID as `<@&id>`. Execution fails with HelperError for an invalid ID and never enables notifications */
    roleMention: (id: string) => helperEffect(() => sharedFormat.roleMention(id)),
    /** Lazily format a canonical decimal channel ID as `<#id>`. Execution fails with HelperError for an invalid ID and performs no lookup */
    channelMention: (id: string) => helperEffect(() => sharedFormat.channelMention(id)),
    /** Lazily parse one complete user, role, or channel mention. Execution fails with HelperError for malformed markup or a noncanonical ID */
    parseMention: (value: string) => helperEffect(() => sharedFormat.parseMention(value)),
    /** Lazily format a Date whose whole Unix second is 1 through 8_640_000_000_000. The default style is `ShortDateTime`; invalid Dates and nonpositive seconds fail */
    timestamp: (...args: Parameters<typeof sharedFormat.timestamp>) =>
        helperEffect(() => sharedFormat.timestamp(...args)),
    /** Lazily parse one complete timestamp to a new whole-second UTC Date. Nonpositive seconds and seconds beyond JavaScript's representable Date range fail */
    parseTimestamp: (value: string) => helperEffect(() => sharedFormat.parseTimestamp(value)),
    /** Lazily format explicit `<:name:id>` or `<a:name:id>` markup. Execution fails with HelperError unless the name and canonical decimal ID are valid */
    customEmoji: (...args: Parameters<typeof sharedFormat.customEmoji>) =>
        helperEffect(() => sharedFormat.customEmoji(...args)),
    /** Lazily parse complete explicit custom-emoji markup. Unicode emoji and shortcode resolution are intentionally outside this helper */
    parseCustomEmoji: (value: string) => helperEffect(() => sharedFormat.parseCustomEmoji(value)),
})

/** Pure decimal-string snowflake helpers. Fallible conversions are lazy Effects and never pass IDs through Number */
export const snowflakes = Object.freeze({
    /** Check canonical decimal snowflake form in Fluxer's signed 64-bit range. This returns immediately and does not convert through Number */
    isValid: sharedSnowflakes.isValid,
    /** Lazily parse one canonical decimal snowflake to bigint without precision loss. Execution fails with HelperError for an invalid ID */
    parse: (value: string) => helperEffect(() => sharedSnowflakes.parse(value)),
    /** Lazily derive a snowflake's UTC issuance time from its high 41 timestamp bits. Execution fails with HelperError for an invalid ID */
    createdAt: (value: string) => helperEffect(() => sharedSnowflakes.createdAt(value)),
    /** Lazily create the smallest snowflake at a UTC millisecond for an endpoint-specific cursor boundary. Dates before Fluxer's epoch or beyond its range fail */
    boundary: (...args: Parameters<typeof sharedSnowflakes.boundary>) =>
        helperEffect(() => sharedSnowflakes.boundary(...args)),
})

/** Pure user/member display-name fallback with no remote or cache lookup */
export const display = sharedDisplay

/** Pure raw-permission composition, membership, missing-name inspection and decimal serialization. Calls are lazy Effects, never authorization decisions */
export const permissionBits = Object.freeze({
    /** Lazily combine known names into raw bits without Administrator expansion. Empty input gives zero, duplicates collapse and unknown names fail with HelperError */
    from: (...args: Parameters<typeof sharedPermissionBits.from>) =>
        helperEffect(() => sharedPermissionBits.from(...args)),
    /** Lazily test a named Fluxer permission against an unsigned 64-bit raw bitfield. This is not effective-permission calculation or authorisation */
    has: (...args: Parameters<typeof sharedPermissionBits.has>) =>
        helperEffect(() => sharedPermissionBits.has(...args)),
    /** Lazily test all requested names against valid raw bits. Empty input succeeds. Every name is validated and unknown bits remain untouched */
    hasAll: (...args: Parameters<typeof sharedPermissionBits.hasAll>) =>
        helperEffect(() => sharedPermissionBits.hasAll(...args)),
    /** Lazily test any requested name against valid raw bits. Empty input is false. Every name is validated even after a match */
    hasAny: (...args: Parameters<typeof sharedPermissionBits.hasAny>) =>
        helperEffect(() => sharedPermissionBits.hasAny(...args)),
    /** Lazily return a frozen missing-name list, deduplicated in first-requested order. Invalid bits or names fail with HelperError */
    missing: (...args: Parameters<typeof sharedPermissionBits.missing>) =>
        helperEffect(() => sharedPermissionBits.missing(...args)),
    /** Lazily return frozen known names in Permissions declaration order and exact unknownBits. No raw grants are expanded or discarded */
    inspect: (bits: bigint) => helperEffect(() => sharedPermissionBits.inspect(bits)),
    /** Lazily serialize an unsigned 64-bit raw bitfield as a canonical decimal wire value. Execution fails with HelperError outside that range */
    toDecimal: (bits: bigint) => helperEffect(() => sharedPermissionBits.toDecimal(bits)),
})

/** Pure validated RGB conversions through lazy Effects, without network work, coercion, clamping or a CSS parser */
export const colors = Object.freeze({
    /** Lazily convert an RGB integer, exact six-digit hex with optional #, or three integer channels in 0..255. Invalid inputs fail with HelperError */
    parse: (...args: Parameters<typeof sharedColors.parse>) => helperEffect(() => sharedColors.parse(...args)),
    /** Lazily format an integer in 0..0xffffff as lowercase #rrggbb with leading zeroes. Invalid numeric input fails */
    toHex: (value: number) => helperEffect(() => sharedColors.toHex(value)),
    /** Lazily create a frozen RGB tuple from an integer in 0..0xffffff. Invalid numeric input fails */
    toRgb: (value: number) => helperEffect(() => sharedColors.toRgb(value)),
})

/**
 * Pure lossless splitting into bounded UTF-16 pieces through lazy Effects. Sending and Markdown handling stay explicit
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
export const text = Object.freeze({
    /**
     * Lazily split well-formed text into frozen pieces of at most maxLength UTF-16 units, preserving all whitespace.
     * Prefer the last newline, then whitespace, otherwise split a word. Joining with an empty separator is lossless.
     * Empty text gives []. Invalid inputs, lone surrogates or a limit too small for a surrogate pair fail with HelperError.
     * Surrogate pairs stay intact, but combining/emoji grapheme sequences may split. No Markdown repair or limit lookup occurs
     */
    split: (...args: Parameters<typeof sharedText.split>) => helperEffect(() => sharedText.split(...args)),
})

/** Pure hosted Fluxer guild-channel, direct-message, message, and bot-installation link helpers. Fallible route validation is lazy and retains HelperError */
export const links = Object.freeze({
    /** Lazily create an official hosted guild-channel or direct-message route from `{ id, guildId }` or `{ id }`. It never checks existence or access */
    channel: (...args: Parameters<typeof sharedLinks.channel>) => helperEffect(() => sharedLinks.channel(...args)),
    /** Lazily create an official hosted message route from a matching message and actual channel context. It never infers context, checks existence, or checks access */
    message: (...args: Parameters<typeof sharedLinks.message>) => helperEffect(() => sharedLinks.message(...args)),
    /** Lazily create Fluxer's hosted bot-installation page with only the fixed `bot` scope and optional unsigned-64-bit permissions. It never navigates, authorizes, checks existence, or accepts an alternate origin/scope */
    installation: (...args: Parameters<typeof sharedLinks.installation>) =>
        helperEffect(() => sharedLinks.installation(...args)),
})

/**
 * Pure hosted Fluxer asset URL helpers. Every fallible call is a lazy Effect that constructs a URL using fixed hosted origins.
 * It never fetches profiles, mutates caches, downloads bytes, refreshes URLs, changes attachment/embed URLs, or accepts an origin.
 * Omitted optional source hashes become `undefined`; known absent hashes become `null`. A returned URL does not prove the asset exists
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
export const assets = Object.freeze({
    /** Lazily build an account-banner URL from user.id and profile.banner of a users.fetchProfile observation.
     * Null stays null for absent or withheld profile data, without choosing a guild banner or fetching anything.
     * Uses AssetUrlOptions' WebP default and transform validation. A URL does not establish asset existence or access
     */
    userBanner: (...args: Parameters<typeof sharedAssets.userBanner>) =>
        assetEffect(() => sharedAssets.userBanner(...args)),
    /** Lazily build a user avatar URL, or `null` for a known missing avatar. It only reads the supplied `id` and `avatar` fields and performs no profile lookup */
    avatar: (...args: Parameters<typeof sharedAssets.avatar>) => assetEffect(() => sharedAssets.avatar(...args)),
    /** Lazily build Fluxer's static default-avatar URL from a canonical user ID. It has no media transform query and does not depend on profile availability */
    defaultAvatar: (userId: string) => assetEffect(() => sharedAssets.defaultAvatar(userId)),
    /** Lazily build a display avatar from the known user avatar or Fluxer's static default. It always resolves to a URL, never `null` */
    displayAvatar: (...args: Parameters<typeof sharedAssets.displayAvatar>) =>
        assetEffect(() => sharedAssets.displayAvatar(...args)),
    /** Lazily build a guild-member avatar URL. It resolves `undefined` for an omitted source hash and `null` for a known absent hash; it does not choose a fallback */
    memberAvatar: (...args: Parameters<typeof sharedAssets.memberAvatar>) =>
        assetEffect(() => sharedAssets.memberAvatar(...args)),
    /** Lazily build a guild-member banner URL. It resolves `undefined` for an omitted source hash and `null` for a known absent hash */
    memberBanner: (...args: Parameters<typeof sharedAssets.memberBanner>) =>
        assetEffect(() => sharedAssets.memberBanner(...args)),
    /** Lazily build the member display avatar when its profile state is known: member avatar, then user avatar, then static default. `AvatarUnset` selects the static default; omitted profile flags or an omitted non-unset member avatar resolve `undefined` */
    displayMemberAvatar: (...args: Parameters<typeof sharedAssets.displayMemberAvatar>) =>
        assetEffect(() => sharedAssets.displayMemberAvatar(...args)),
    /** Lazily build a guild icon URL. It resolves `undefined` for an omitted source hash and `null` for a known absent hash */
    guildIcon: (...args: Parameters<typeof sharedAssets.guildIcon>) =>
        assetEffect(() => sharedAssets.guildIcon(...args)),
    /** Lazily build a guild banner URL. It resolves `undefined` for an omitted source hash and `null` for a known absent hash */
    guildBanner: (...args: Parameters<typeof sharedAssets.guildBanner>) =>
        assetEffect(() => sharedAssets.guildBanner(...args)),
    /** Lazily build a guild invite-splash URL. It resolves `undefined` for an omitted source hash and `null` for a known absent hash */
    guildSplash: (...args: Parameters<typeof sharedAssets.guildSplash>) =>
        assetEffect(() => sharedAssets.guildSplash(...args)),
    /** Lazily build a guild embedded-invite-splash URL. It resolves `undefined` for an omitted source hash and `null` for a known absent hash */
    guildEmbedSplash: (...args: Parameters<typeof sharedAssets.guildEmbedSplash>) =>
        assetEffect(() => sharedAssets.guildEmbedSplash(...args)),
    /** Lazily build a custom-emoji URL from only its ID and animation metadata. Animated emoji require WebP, GIF, or APNG to retain animation */
    emoji: (...args: Parameters<typeof sharedAssets.emoji>) => assetEffect(() => sharedAssets.emoji(...args)),
    /** Lazily build a custom-sticker URL from only its ID and animation metadata. Stickers do not expose format because Fluxer returns WebP except an animated sticker's GIF source */
    sticker: (...args: Parameters<typeof sharedAssets.sticker>) => assetEffect(() => sharedAssets.sticker(...args)),
})
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
    DiscoveryStatus,
} from "./discovery.js"
export type {
    DiscoveryApplication,
    DiscoveryApplicationInput,
    DiscoveryApplicationEdit,
    DiscoveryCategory,
    DiscoveryStatus,
} from "./discovery.js"
export { DiscoveryCategories } from "./discovery.js"
import { discoveryStatus, discoveryCategories, discoveryWrite, discoveryWithdraw } from "#sdk/internal/guild-discovery"
export type { AuditLogEntry, AuditLogPage, AuditLogQuery, AuditLogIterationQuery } from "./audit-logs.js"
import { auditLogPage } from "#sdk/internal/audit-logs"
export type {
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
import { vanityUrlFetch, vanityUrlEdit } from "#sdk/internal/vanity-url"
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
import { inviteFetch, inviteCreate, inviteList, inviteDelete } from "#sdk/internal/invites"
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
    directMessageEdit,
    directMessageClose,
} from "#sdk/internal/users"
import {
    type Webhook,
    type CreatedWebhook,
    type WebhookCreate,
    type WebhookEdit,
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
    WebhookMessageInput,
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
    webhookSend,
    webhookMessage,
    webhookMessageDelete,
} from "#sdk/internal/webhooks"
import { Deferred, Effect, Scope, type Stream } from "effect"
export { builders, EmbedBuilder, MessageBuilder } from "./builders.js"
export type {
    CommandCooldownClaim,
    CommandCooldownRequest,
    MemoryCooldownOptions,
    PrefixCommandDefinition,
    PrefixCommandParse,
    PrefixCommandParseInput,
    PrefixCommandPrefix,
    PrefixCommandsOptions,
} from "./commands.js"
export type {
    NativeCooldownStore,
    MemoryCooldownStore,
    NativePrefixCommand,
    NativePrefixCommandContext,
    NativePrefixCommandCooldown,
    NativePrefixCommandRouter,
} from "./native-commands.js"
import { nativeCommands } from "./native-commands.js"

/**
 * Optional builders and prefix-command routing above direct client primitives.
 * Builders return independent plain payload snapshots. Command routing is lazy, attaches one existing bounded messageCreate subscription in the caller’s scope and never connects the client or creates a detached runtime.
 * Guards, cooldown keys and handler Effects remain application-owned. Commands do not fetch permissions, send replies or retry failures
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { builders, commands, type Client } from "@neontechspace/fluxerly/effect"
 *
 * export const installPing = (client: Client) => Effect.gen(function* () {
 *     const router = yield* commands.create({ prefix: "!" })
 *     const registered = yield* router.register({
 *         name: "ping",
 *         execute: ({ client, message }) => client.messages.reply(message, builders.message().content("Pong").build()).pipe(Effect.asVoid),
 *     })
 *     return yield* registered.attach(client)
 * })
 * ```
 */
export const commands = nativeCommands
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
export type { Attachment, AttachmentInput, AttachmentReference } from "./attachments.js"
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
export type { LoggingOptions, DefaultLogger } from "./logging.js"

/**
 * Adapt an Effect logger for the default API without exposing Effect types to default consumers.
 * Pass the returned value as logging.logger to default createClient.
 * Delivery is synchronous. Thrown logger failures are swallowed without retry, while a blocking logger can delay SDK work.
 * No queue, sink flushing or persistence guarantee is added. Native callers use their own Effect logger directly.
 * The SDK supplies safe messages and empty causes, but caller-owned context and sink behavior remain the caller's responsibility
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
    MemberQuery,
    GuildOperationFailure,
    GuildOperationOptions,
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
    MemberQuery,
    GuildOperation,
    GuildOperationFailure,
    GuildOperationOptions,
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
import { memberTimeout, memberKick, guildBan, guildUnban, guildBans } from "#sdk/internal/moderation"
import type { BanInput, GuildBan, ModerationOptions } from "./guilds.js"
export type { BanInput, GuildBan, ModerationOptions } from "./guilds.js"
import type { CachePolicyErrorReport, MessageCacheSettings } from "./cache.js"
export type { CachePolicyErrorReport, MessageCacheSettings } from "./cache.js"
export type { ResourceCacheSettings } from "./cache.js"

type HierarchyOperation = "hierarchy.compare" | "hierarchy.isAbove" | "hierarchy.canManage"

const hierarchyInputFailure = (operation: HierarchyOperation) =>
    new GuildOperationError(operation, "input", "notDispatched")

/**
 * Lazily compares two role snapshots in Fluxer's local hierarchy order
 *
 * `1` means left is higher, `-1` means right is higher, and `0` means the same role. A larger position is higher;
 * tied positions use the smaller numeric role ID as higher. Malformed or cross-guild snapshots fail with
 * GuildOperationError hierarchy.compare/input without retaining the input. This reports local ordering only; it does
 * not evaluate permissions, MFA, membership visibility, or whether a provider endpoint accepts an action
 */
export function compareHierarchy(left: GuildRole, right: GuildRole): Effect.Effect<-1 | 0 | 1, GuildOperationError> {
    return Effect.suspend(() => {
        const comparison = compareRoleHierarchy(left, right)
        return comparison === undefined
            ? Effect.fail(hierarchyInputFailure("hierarchy.compare"))
            : Effect.succeed(comparison)
    })
}

/**
 * Lazily reports whether left is strictly higher than right in supplied role snapshots
 *
 * Malformed or cross-guild snapshots fail with GuildOperationError hierarchy.isAbove/input without retaining the input.
 * This is a local ordering helper, not a permission or endpoint-authorization check
 */
export function isAboveInHierarchy(left: GuildRole, right: GuildRole): Effect.Effect<boolean, GuildOperationError> {
    return Effect.suspend(() => {
        const above = isRoleAboveInHierarchy(left, right)
        return above === undefined ? Effect.fail(hierarchyInputFailure("hierarchy.isAbove")) : Effect.succeed(above)
    })
}

/**
 * Lazily evaluates Fluxer's local member-target hierarchy rule from explicit snapshots without fetching or retaining anything
 *
 * The guild owner and a member targeting itself pass. A non-owner cannot manage the owner. Other members need a
 * strictly higher explicit role; no explicit roles rank below any supplied explicit role. `roles` must include one
 * same-guild observation for every actor and target role ID. `roles.fetchAll` output may include the implicit everyone
 * role; it is ignored for rank comparison. Members must not list everyone as an explicit role. Malformed, incomplete,
 * duplicate, cross-guild, or inconsistent snapshots fail with GuildOperationError hierarchy.canManage/input without retaining the input. This
 * deliberately excludes permissions, MFA, endpoint-specific checks, provider membership state, and concurrent remote
 * changes, so a successful true result is not action authorization
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
            ? Effect.fail(hierarchyInputFailure("hierarchy.canManage"))
            : Effect.succeed(manageable)
    })
}

/** Native cache controls, with a scoped reporter in the client's creation context */
export interface MessageCacheOptions<E = never, R = never> extends MessageCacheSettings {
    /**
     * Safe policy reporting in the creation context, independent of REST/event delivery.
     * One custom report at a time. Further failures while busy use the shared operational logger.
     * Reporter failure attempts one safe fallback log. No recursive hook invocation or policy retry.
     * Shutdown interrupts report work and awaits finalizers. Uninterruptible user work can delay closure
     */
    readonly onError?: (report: CachePolicyErrorReport) => Effect.Effect<unknown, E, R>
}

/**
 * Creation-time native settings. Reporting services are captured when creation executes.
 * Sharding uses the shared immutable local assignment, including shard zero for direct-message traffic. Client-wide REST and cache budgets are not multiplied by local shard count
 */
export interface ClientOptions<E = never, R = never> extends Omit<SharedClientOptions, "cache" | "logging"> {
    /**
     * Explicit SDK development-log opt-in. Logger, level and tracing remain owned by the executing Effect context.
     * Connection work inherits connect/run context, handler work inherits registration context and cache reports inherit creation context.
     * Shutdown diagnostics use shutdown's execution context. No detached native runtime or logger replacement is installed.
     * Default-only logger/minimumLevel settings are rejected. A throwing logger cannot fail connection diagnostics
     */
    readonly logging?: LoggingOptions
    /** Optional resource retention. Omission retains no resource snapshots. Every configured budget is client-wide across locally owned shards.
     * A gateway gap invalidates known-scope observations from its affected shard. Unknown guild scope invalidates conservatively because the SDK keeps no channel-to-guild index
     */
    readonly cache?: Omit<NonNullable<SharedClientOptions["cache"]>, "messages"> & {
        /**
         * Omitted/false disables caching. True or an options object enables global bounded memory-only message snapshots.
         * Eligible REST/events populate, deletes/uncertain writes evict, and gateway gaps clear even after successful resume.
         * Conflicts can produce misses. No automatic history retrieval. Shutdown releases cached references
         */
        readonly messages?: boolean | MessageCacheOptions<E, R>
    }
}
import type { ConfigurationError, ConnectError, ConnectionFailure } from "./errors.js"
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

/** Bounded native reaction collection with progress work in the registration context */
export interface ReactionCollectorOptions<E = never, R = never> extends SharedReactionCollectorOptions {
    /** Run once per accepted addition, sequentially, before continuing collection.
     * Failures and defects while active fail collection with CollectorError handler, without exposing the original cause.
     * Stop, timeout, scope closure, recovery and shutdown interrupt active work and await its finalizers.
     * Uninterruptible work can delay closure. Do not await this collector's completion inside its handler.
     * Already-dispatched effects are not rolled back; callbacks are never retried
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

/** Bounded native message collection with progress work in the registration context */
export interface CollectorOptions<E = never, R = never> extends SharedCollectorOptions {
    /** Run once per accepted message ID, sequentially, after filtering and retained-byte admission.
     * Failures and defects while active fail collection with CollectorError handler, without exposing the original cause.
     * Stop, timeout, scope closure, recovery and shutdown interrupt active work and await its finalizers.
     * Uninterruptible work can delay closure. Do not await this collector's completion or client shutdown inside its handler.
     * Already-dispatched effects are not rolled back. Callbacks are never retried
     */
    readonly onMessage?: (message: Message) => Effect.Effect<unknown, E, R>
}
import { replyInput } from "#sdk/internal/message"
import type { EventSource } from "#sdk/internal/events"
import {
    MessageError,
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
    MessageReference,
    MessageInput,
    MessageOperationOptions,
    ReplyInput,
    SendOptions,
} from "./messages.js"
import type { EventBufferOptions, HandlerOptions, HandlerErrorReport, EventMap, EventName } from "./events.js"

export { EventOverflowError, EventReadBusyError, MessageError, MessageOperationError } from "./message-errors.js"
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
    ForwardMessageInput,
    MessageSnapshot,
    MessageFlag,
    MessageSticker,
    MessageMention,
    MessageChannelMention,
    MessageReactionEmoji,
    MessageReactionSummary,
    MessageContextReference,
    MessageHistoryQuery,
    MessageDeletion,
    MessageBulkDeletion,
    MessageReference,
    MessageInput,
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
} from "./events.js"

/** Scoped subscription controls, separate from client ownership */
export interface Subscription {
    /** Lazy stop request: Discard pending events and interrupt owned handlers without waiting on the invoking handler */
    unsubscribe(): Effect.Effect<void>
    /**
     * Observe retained closure/overflow after native handler cleanup. Interruption cancels only this wait.
     * Defects retain native Cause. Uninterruptible handlers/finalizers can delay closure.
     * Do not await your own completed closure inside a handler
     */
    waitForClose(): Effect.Effect<void, EventOverflowError>
}

/** Native reporting runs in the registration caller's context, not an SDK-owned runtime */
export interface EventHandlerOptions<E = never, R = never> extends HandlerOptions {
    /** Safe handler/overflow reporting. Failure invokes one safe fallback log without retrying the handler */
    readonly onError?: (report: HandlerErrorReport) => Effect.Effect<unknown, E, R>
}

/**
 * Lazy message operations preserving caller context and interruption. REST/local lookup work without a gateway.
 * Collection with guildId requires its locally owned shard to be ready; channel-only collection requires aggregate Connected. Closing/Closed reject new work.
 * Remote calls share four active HTTP slots and 256 queued requests or 4 MiB of queued JSON bodies, client-wide across locally owned shards.
 * Each remote call defaults to a 30,000 ms total deadline, including admission, retry and rate waits, with cleanup awaited afterward
 *
 * fetch, fetchHistory, fetchReactionUsers and fetchPins retry fetch transport failures and HTTP 500/502/503/504 at most twice.
 * Retry delays are jittered 125–250 ms then 250–500 ms, or a valid longer Retry-After. Retries never reset the deadline.
 * Reads retry the same target/query through the bounded queue, without snapshot isolation. Other rejections and malformed successes never retry.
 * Confirmed 429 retries retain their existing route/global waits and do not consume the two transient-read retries.
 * Mutations retry only confirmed rate-limit rejections, never uncertain writes.
 * Typed failures, defects and interruption retain native channels, including combined cleanup causes.
 * Interruption or client closure awaits owned cleanup but cannot undo a dispatched mutation
 */
export interface Messages {
    /** Traverse remote history newest-to-oldest as a lazy Stream, without connecting or prefetching another page.
     * Each execution copies inputs and owns independent progress in the caller's context, without a detached runtime
     *
     * maxItems is required. pageSize/maxPages follow PaginationQuery. timeoutMs applies separately to each remote page
     *
     * Emits frozen snapshots. PaginationError covers input, cursorStalled and pageLimit; remote failures keep fetchHistory's operation.
     * Interruption and defects retain native causes, including cleanup failures. Termination awaits in-flight request finalizers.
     * Stream early termination releases buffered items. Closing/Closed also releases the page and fails the next pull
     *
     * Retains one bounded page, not all results. Enabled message caching follows fetchHistory's normal admission.
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
    ): Stream.Stream<Message, MessageOperationFailure | PaginationError>
    /** Lazily search one current-scope indexed page in an explicit guild or channel context, without gateway readiness, cache lookup or cache admission.
     * Fluxerly always sends scope current. Completion is either an immutable indexing state or an immutable observed result page.
     * Indexing never polls: the caller chooses whether to run another explicit search. Cursor is opaque and only belongs in a later search call.
     * Invalid input, malformed success and POST failure use MessageOperationError operation search. This POST has no transient-read retry.
     * Confirmed rate limits retain shared REST handling. Interruption retains the native Cause and releases only this request
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
    ): Effect.Effect<MessageSearchPage, MessageOperationFailure>
    /** Lazily traverse current-scope indexed messages through opaque provider cursors, without polling, prefetching or cache hydration.
     * maxItems is required. pageSize is 1–25 and maxPages defaults to 100. Each execution owns input copies and one bounded page.
     * An indexing page ends with PaginationError indexing. Repeated opaque cursors end with cursorStalled rather than snowflake comparison.
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
        filters: Omit<MessageSearchQuery, "limit" | "page" | "cursor">,
        limits: MessageSearchIterationLimits,
        options?: MessageOperationOptions,
    ): Stream.Stream<Message, MessageOperationFailure | PaginationError>
    /** Traverse ascending remote user IDs for one message and the selected literal Unicode or custom emoji.
     * Shares iterateHistory's lazy Stream, per-page deadlines, caller context, interruption and release behavior.
     * Stops at maxItems or hasMore=false. Remote errors retain fetchReactionUsers's operation.
     * No reactor cache or automatic member lookup. Concurrent removals can invalidate earlier observations
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
     * Shares iterateHistory's lazy Stream, per-page deadlines, caller context, interruption and release behavior.
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
    ): Stream.Stream<import("./pins.js").MessagePin, MessageOperationFailure | PaginationError>
    /**
     * Pin one message identified by decimal id and channelId, without requiring gateway readiness.
     * Lazy execution preserves caller context, interruption and native defects.
     * Complete on HTTP 204, not event delivery. Fluxer enforces channel access and PIN_MESSAGES for guild pins.
     * A new pin creates a system message and gateway notifications. Already-pinned targets are unchanged.
     * Share bounded REST admission and the per-channel pins rate bucket with unpin/fetchPins.
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
     * Unpin one explicit message using pin's admission, deadline, retry, cancellation and cache-invalidation rules.
     * Lazy execution preserves caller context, interruption and native defects.
     * Complete on HTTP 204, including an already-unpinned message. Expected failures identify operation unpin.
     * Fluxer enforces the same permissions as pin. Closing/Closed clients fail with ClientClosedError.
     * Unpinning does not delete the message or the system message created by pinning, and does not reset the last-pin timestamp.
     * No gateway readiness, automatic rollback, event synthesis or confirmation fetch
     */
    unpin(message: MessageReference, options?: MessageOperationOptions): Effect.Effect<void, MessageOperationFailure>
    /**
     * Fetch one frozen pin page for a decimal channel ID, without gateway readiness, cache reads or cache population.
     * Lazy execution preserves caller context, interruption and native defects
     *
     * Query defaults to limit 50 and the server's current time. Limit is 1 through 50 and before is an ISO timestamp
     *
     * Results use descending pin-time order with preserved pinnedAt values and an explicit nextBefore cursor.
     * Timestamp ties may repeat messages across pages. Deduplicate IDs and stop on a non-advancing cursor.
     * No automatic traversal, complete-list guarantee, pin acknowledgement or snapshot isolation.
     * Share pin's admission, 30,000 ms default deadline and per-channel rate bucket, using Messages' bounded read-retry policy
     *
     * Invalid input and malformed responses use MessageOperationError operation fetchPins without partial pages.
     * Visibility/history permissions can limit results. An empty page does not prove the channel has no pins.
     * Closing/Closed uses ClientClosedError. Returned messages are observations, not live state
     */
    fetchPins(
        channelId: string,
        query?: MessagePinsQuery,
        options?: MessageOperationOptions,
    ): Effect.Effect<MessagePinsPage, MessageOperationFailure>
    /**
     * Remove one named user's reaction, leaving other users and emoji groups untouched.
     * userId is a required decimal ID; naming the bot removes its own reaction.
     * Uses addReaction's emoji inputs, REST admission, 30,000 ms default deadline, retry and interruption rules.
     * No gateway readiness is required. Complete on HTTP 204, without waiting for or synthesizing events.
     * Fluxer enforces visibility and history access; for another user, the bot must author the message or have MANAGE_MESSAGES in its guild
     *
     * Expected failures use MessageOperationError with operation removeUserReaction, or ClientClosedError.
     * Lazy execution preserves caller context and native defects.
     * Cleanup is awaited, but cannot undo a dispatched deletion. Only confirmed 429 rejections retry.
     * Success means absent or removed, not proof the reaction existed. Unknown outcomes are not replayed.
     * No cache mutation, automatic restoration or per-user state is retained; the bot cannot restore another user's reaction as them
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
     * Fluxer emits a clear-emoji event, not individual removal events; the SDK does not synthesize or await it.
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
     * Fluxer emits one clear-all event, not per-emoji or per-user events; the SDK does not synthesize or await it.
     * Destructive: Other users' reactions cannot be restored by the bot as those users
     */
    clearReactions(
        message: MessageReference,
        options?: MessageOperationOptions,
    ): Effect.Effect<void, MessageOperationFailure>
    /**
     * Fetch one frozen page of users who currently hold the specified reaction, without requiring gateway readiness.
     * Accept the same literal Unicode or custom emoji input as addReaction.
     * limit defaults to 25 (1–100); after is an exclusive user-ID cursor in ascending order, not reaction time.
     * Empty reactions return an empty terminal page. No automatic pagination, user cache or message-cache changes.
     * Pages are separate observations: Reactions may change between requests; no complete or atomic snapshot is promised
     *
     * Use the shared 30,000 ms deadline by default, overridden by options.timeoutMs.
     * Share bounded REST admission, global limits and the channel bucket used by reaction mutations.
     * Uses Messages' bounded read-retry policy within the original deadline, including separate confirmed-429 waits
     *
     * Invalid inputs, malformed pages, HTTP rejections, transport and deadlines use MessageOperationError with operation fetchReactionUsers.
     * HTTP 404 means notFound; permission/history visibility is enforced by Fluxer. Closed clients use ClientClosedError.
     * Lazy execution preserves caller context; interruption awaits owned request cleanup. Unexpected defects retain native causes
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
     * Accept literal Unicode or a custom { name, id }; Fluxer owns emoji availability and permission checks
     *
     * No gateway readiness is required. Use the shared 30,000 ms deadline by default; timeoutMs overrides it.
     * Share bounded REST admission and global rate limits, with a channel reaction bucket separate from message operations.
     * Only confirmed rate-limit rejections retry within the original deadline; uncertain outcomes are never retried
     *
     * Input, admission, rejection, transport and timeout failures use MessageOperationError; closed clients use ClientClosedError.
     * Lazy execution preserves caller context. Interruption awaits owned cleanup but cannot undo a dispatched reaction.
     * Unexpected defects retain native causes
     *
     * Existing own reactions are idempotent server-side. No local reaction state, counts or reactor lists are retained
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
     * Uses addReaction's input, admission, timeout, retry, failure and interruption rules.
     * Success does not prove the reaction previously existed or that this call removed it.
     * Other users' reactions are untouched. Neither this operation nor gateway reaction events alter the message cache
     */
    removeReaction(
        message: MessageReference,
        emoji: ReactionEmojiInput,
        options?: MessageOperationOptions,
    ): Effect.Effect<void, MessageOperationFailure>
    /**
     * Lazily register future messageCreate collection in one decimal channel ID within the execution caller's scope.
     * Each execution returns a ready handle before subsequent sends. No history, cache reads, implicit connect or prompt correlation
     *
     * With options.guildId, the caller supplies the channel's owning guild and intake accepts only that locally owned ready shard. Known conflicting event guilds are discarded without a channel lookup.
     * Without guildId, channel-only collection retains conservative aggregate recovery: any gateway gap ends it because its guild scope is unknown
     *
     * Defaults: One accepted message, 30,000 ms total lifetime, 4 MiB retained Message JSON.
     * Pending intake separately allows 256 payloads or 4 MiB source JSON after channel selection, before synchronous filtering.
     * Options are copied when executed. Budgets are positive safe integers. The timeoutMs maximum is 2,147,483,647
     *
     * The deadline starts when registered, never resets, and excludes messages processed at or after it, including slow filter returns.
     * Count accepted IDs once and retain frozen received snapshots, unaffected by later edits/deletions
     *
     * Filter/overflow failures return no partial messages. Recovery fails with CollectorError connectionLost, without auto restart or resend.
     * Require Connected or fail with CollectorError notConnected. Closing/Closed use ClientClosedError. Invalid settings use ConfigurationError
     *
     * The registration scope stops its collector with partial replies. Client shutdown fails it with ClientClosedError.
     * Interrupting a waiter does not stop collection. Closing its registration scope does. No AbortSignal option or detached runtime.
     * Defects retain native Cause. Slow synchronous filters block JavaScript and cannot be preempted or have their side effects undone.
     * Optional onMessage runs sequentially in registration context after filtering, ID deduplication and retained-byte admission.
     * Limit completion waits for the final callback. Timeout/stop may retain a message whose callback was interrupted.
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
     *         yield* client.messages.send(channelId, { content: "What should I call you?" })
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
     *             onMessage: message => client.messages.reply(message, { content: "Received your reply" }),
     *         })
     *         return yield* collector.waitForClose()
     *     }),
     * )
     * ```
     * The author filter must exclude the bot itself to avoid collecting its acknowledgements
     */
    collect<E = never, R = never>(
        channelId: string,
        options?: CollectorOptions<E, R>,
    ): Effect.Effect<Collector, CollectorRegistrationError, Scope.Scope | R>
    /**
     * Lazily register future reaction additions for one message with decimal id and channelId in the caller's scope.
     * Execute before the expected reaction. No REST request, existing-reactor lookup, implicit connect or cache reads
     *
     * With options.guildId, the caller supplies the target channel's owning guild and intake accepts only that locally owned ready shard. Known conflicting event guilds are discarded without a membership lookup.
     * Without guildId, target-only collection retains conservative aggregate recovery: any gateway gap ends it because its guild scope is unknown
     *
     * Defaults: One accepted addition, 30,000 ms total lifetime and 4 MiB retained MessageReaction JSON.
     * Copy target IDs/options when executed. Pending intake allows 256 payloads or 4 MiB full source JSON.
     * Message selection precedes buffering; synchronous user/emoji filtering follows it
     *
     * Optional emoji uses addReaction's input shape and is copied when executed; matching precedes filter but follows queue admission.
     * Unicode requires exact text and no custom ID; custom emoji match by ID, ignoring renames. Invalid selectors use ConfigurationError emoji
     *
     * Single additions and received batches share receive order; batch entries retain their order and count individually.
     * A batch occupies one pending slot. Repeated user/emoji pairs count again. No batching flag is enabled.
     * Removals, clears and message deletion neither undo observations nor stop collection. This is not a vote tally
     *
     * The deadline never resets and excludes observations processed at or after it, including slow filter returns
     *
     * Filter/overflow failures use CollectorError without partial results. Recovery fails with connectionLost, without restart.
     * Require Connected or fail with CollectorError notConnected. Closing/Closed use ClientClosedError.
     * Invalid target/options use ConfigurationError. Registration does not verify remote message existence or access
     *
     * Registration scope closure stops collection with partial results; client shutdown fails it with ClientClosedError.
     * Waiter interruption does not stop collection. No AbortSignal option or detached runtime; defects retain native Cause
     *
     * Optional onReaction runs after acceptance and byte admission, sequentially, in the registration context.
     * Limit completion waits for the final callback. Timeout/stop may retain an addition whose callback was interrupted.
     * Pending budgets exclude the active payload, including its unprocessed batch entries. No callback retries or vote reconstruction.
     * Handler failure ends this collector with CollectorError handler; defects during terminal cleanup remain in Cause
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
     *             emoji: "✅",
     *             filter: reaction => reaction.userId === userId,
     *             onReaction: reaction => client.messages.edit(message, { content: `Accepted addition by ${reaction.userId}` }),
     *         })
     *         return yield* collector.waitForClose()
     *     }),
     * )
     * ```
     * The caller supplies a connected client and an existing message; timeout may return no reactions
     */
    collectReactions<E = never, R = never>(
        message: MessageReference,
        options?: ReactionCollectorOptions<E, R>,
    ): Effect.Effect<ReactionCollector, CollectorRegistrationError, Scope.Scope | R>
    /**
     * Lazily read a frozen local observation when executed, never making a request.
     * Disabled, absent, evicted, expired or wrong-channel entries yield undefined, not proof of server absence.
     * Hits update LRU recency without renewing age and do not guarantee current server state.
     * Invalid references fail with MessageOperationError operation get, reason input, outcome notDispatched.
     * Closing/Closed fail with ClientClosedError. Defects and interruption retain native channels
     */
    get(message: MessageReference): Effect.Effect<Message | undefined, MessageOperationFailure>
    /**
     * Send text, embeds, files and/or stickers without requiring a connected gateway. Closing/Closed reject new work
     *
     * Embed images/thumbnails may use attachment://filename for a matching new image upload in this execution.
     * Optional flags accept only MessageFlags' non-voice bits; suppressing previews is distinct from omitting embeds.
     * Each execution snapshots file bytes before waiting, up to 50 MiB per file and the separate uploads.maxBytes budget.
     * Full upload admission fails with busy before copying. No path access or downloads; servers may impose lower limits.
     * Cleanup releases owned bytes; failed uploads may leave temporary server data, with no physical-erasure guarantee
     *
     * Returns the created snapshot after an API response, not gateway delivery or recipient acknowledgement.
     * Mention notifications default off. Deadline defaults to 30,000 ms across admission, rate waits and HTTP.
     * Enabled caching retains eligible created snapshots without changing send completion or delivery.
     * Shared admission allows four active requests and 256 pending bodies or 4 MiB of pending JSON.
     * Only confirmed rate-limit rejections retry within the deadline. Ambiguous sends never retry automatically
     *
     * Interruption awaits owned HTTP cleanup but cannot undo a server-side creation.
     * Typed failures, defects and interruption retain native channels, including cleanup causes
     */
    send(channelId: string, input: MessageInput, options?: SendOptions): Effect.Effect<Message, SendError>
    /** Lazily forward an accessible source message into an explicit destination, without fetching or caching the source.
     * Each execution starts a separate send. No gateway connection is required; Closing/Closed fail with ClientClosedError
     *
     * Optional media selections belong to the source. Extra content, files, mentions and flags are rejected
     *
     * Returns the created message after HTTP, with frozen messageSnapshots rather than live views of later source edits.
     * Uses send's shared admission, optional destination-message caching and 30,000 ms default total deadline
     *
     * Fluxer checks source access and destination permissions. Only confirmed rate-limit rejection retries.
     * A lost response or interruption after dispatch may leave a created forward. No rollback or exactly-once guarantee.
     * Expected failures use MessageError or ClientClosedError. Defects and interruption retain native causes and await cleanup
     * @example
     * ```ts
     * import type { Client, MessageReference } from "@neontechspace/fluxerly/effect"
     * export function forwardExample(client: Client, destinationId: string, source: MessageReference) {
     *     return client.messages.forward(destinationId, { source })
     * }
     * ```
     */
    forward(channelId: string, input: ForwardMessageInput, options?: SendOptions): Effect.Effect<Message, SendError>
    /**
     * Lazily tell Fluxer that this bot is typing in one decimal channel ID, completing only after HTTP 204.
     * No gateway connection, event confirmation, cache change or local typing state is required or created.
     * Fluxer can restrict delivery to other clients and expires its own ephemeral indicator independently.
     * Uses shared REST admission and a dedicated per-channel typing bucket. The default request deadline is 30,000 ms.
     * Only confirmed rate-limit rejections retry; a lost response or interruption cannot prove whether Fluxer showed the notice.
     * Input, admission and HTTP failures use MessageOperationError operation typing. Closing/Closed uses ClientClosedError.
     * Each execution preserves caller context and interruption, awaiting HTTP cleanup. Defects retain their native Cause
     */
    typing(channelId: string, options?: MessageOperationOptions): Effect.Effect<void, MessageOperationFailure>
    /**
     * Lazily send one typing notice, run task in this caller's context, then stop the helper and await its refresh cleanup.
     * While task is running, refreshes no sooner than every 8,000 ms, below Fluxer's documented 20 requests per 10 seconds per channel limit
     *
     * The first typing request completes before task starts. Its failure prevents task execution. There is no detached repeating work.
     * A later typing or client-close failure stops refreshing but does not interrupt task; after task settles, the retained failure combines with its Cause.
     * Interruption stops and awaits the helper; task's scope, services and errors remain owned by this Effect caller.
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
     * Lazy reply helper over send. Missing references fail, without unreferenced fallback or default author notification.
     * The returned reply is eligible for the same cache intake as send.
     * File inputs use send's per-execution snapshot, size, budget and cleanup rules
     */
    reply(message: MessageReference, input: ReplyInput, options?: SendOptions): Effect.Effect<Message, SendError>
    /**
     * Fetch a frozen message snapshot from Fluxer, never from a cache. Accepts a reference or an existing Message.
     * Returns after decoding the API response and checking its message/channel IDs against the requested target.
     * Missing targets fail with MessageOperationError reason notFound rather than returning an empty value.
     * Enabled caching retains eligible responses, but the returned result does not depend on cache admission.
     * Interrupting the Effect releases only this request and awaits its cleanup.
     * Uses Messages' bounded read-retry policy; callers need no retry loop for its eligible transient failures
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
    fetch(message: MessageReference, options?: MessageOperationOptions): Effect.Effect<Message, MessageOperationFailure>
    /**
     * Lazily fetch one remote history page for a decimal channel ID without a gateway connection or cache lookup.
     * Defaults to the latest 50 messages. Query limit is 1 through 100 with at most one before, after or around cursor
     *
     * Each execution returns after HTTP 200 and whole-page validation as a frozen array of frozen Message snapshots, newest first.
     * Empty and short arrays describe currently accessible results, not complete history. Pages are not a shared point-in-time snapshot.
     * No prefetch, automatic traversal or gateway notifications. Use the oldest returned ID as before for an older page
     *
     * Enabled caching admits eligible page members oldest first, so tight limits retain the newest members
     *
     * Invalid input, malformed pages and HTTP rejections are typed MessageOperationError failures with operation fetchHistory. HTTP 404 remains notFound.
     * Shares REST admission and the 30,000 ms default total deadline, using Messages' bounded read-retry policy.
     * Runs in caller context. Interruption releases only this call and awaits cleanup. Closing/Closed fail with ClientClosedError.
     * Defects and interruption retain native causes rather than becoming typed message-operation failures
     */
    fetchHistory(
        channelId: string,
        query?: MessageHistoryQuery,
        options?: MessageOperationOptions,
    ): Effect.Effect<readonly Message[], MessageOperationFailure>
    /** Lazily preview one bounded exact cleanup selection without deleting, rereading cache, or requiring a gateway connection.
     * maxScanned and maxSelected are each required integers from 1 through 10,000. Supply authorId, a synchronous filter, or both as combined criteria
     *
     * History is read newest first without prefetch until an empty page, scan bound, or selection bound. A short page is not exhaustion.
     * Underlying history reads can populate an enabled message cache.
     * The in-memory plan owns frozen selected snapshots and can only be consumed once by its producing client. JSON reconstruction and another client fail before dispatch
     *
     * A filter throw, non-boolean result, or thenable fails with MessageCleanupError before deletion. A blocking synchronous filter cannot be preempted.
     * One 30,000 ms default deadline covers history reads. Native interruption remains interruption and no cleanup request is submitted
     */
    previewCleanup(
        channelId: string,
        selection: MessageCleanupSelection,
        options?: MessageOperationOptions,
    ): Effect.Effect<MessageCleanupPlan, MessageCleanupFailure>
    /** Lazily submit one prior plan's exact IDs in sequential batches of at most 100, without rereading history or rerunning selection criteria.
     * A plan is single-use even after an error or interruption, preventing accidental replay. Preview again or use explicit deleteMany for journaled reconciliation.
     * One 30,000 ms default deadline covers all batch submissions. submittedBatches records only earlier HTTP-success submissions.
     * A terminal rejected or unknown batch is reported separately. No report proves individual deletion, a deletion count, atomicity, or safe retry.
     * onProgress is synchronous best effort. Callback throws and thenable rejections are ignored. Native interruption retains its cause and can leave a submitting batch unknown.
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
        plan: MessageCleanupPlan,
        options?: MessageCleanupOptions,
    ): Effect.Effect<MessageCleanupReport, MessageCleanupFailure>
    /**
     * Replace text/embeds/files and return the frozen updated snapshot after the API response, without waiting for a gateway event.
     * Existing stickers are preserved; sticker replacement is not supported by this edit operation.
     * Supplied values replace those fields; omitted values are not sent. No hidden fetch or cache merge
     *
     * List retained attachment IDs alongside new uploads; retained title/description may be changed or cleared with null.
     * The supplied attachment list replaces the old list. Unknown IDs may be ignored and a stale list may remove concurrent additions.
     * attachment:// embed images/thumbnails must match a new image upload in this execution, not a retained ID
     *
     * A flags-only edit is supported. Omitted flags preserve them; flags replaces writable bits and 0 clears both non-voice bits
     *
     * Clear files with attachments: [] and nonempty text or embeds. Uploads use send's per-execution snapshot and budget.
     * Interruption awaits upload cleanup; failed edits may leave temporary server data, without physical-erasure guarantees
     *
     * To remove embeds, send nonempty content alongside embeds: []; an empty edit alone is rejected by Fluxer.
     * Empty content requests clearing text, subject to Fluxer validation. Mentions default off.
     * Omitted rich embeds are preserved, but Fluxer may regenerate text-derived link previews
     *
     * Enabled caching retains eligible responses. An uncertain dispatched edit evicts the old local copy.
     * Missing targets are typed notFound failures. A lost response or timeout after dispatch may leave the edit applied.
     * Uncertain edits never retry automatically. Native interruption cannot undo a dispatched edit
     */
    edit(
        message: MessageReference,
        input: EditMessageInput,
        options?: MessageOperationOptions,
    ): Effect.Effect<Message, MessageOperationFailure>
    /**
     * Delete the target and complete without a value after HTTP 204, without waiting for a gateway event.
     * Missing targets fail with MessageOperationError reason notFound, including a repeated delete.
     * Confirmed deletion and uncertain dispatched deletion evict the local cached copy.
     * A lost response or timeout after dispatch may leave the target deleted. Uncertain deletes never retry automatically.
     * Native interruption awaits owned cleanup but cannot undo a dispatched deletion
     */
    delete(message: MessageReference, options?: MessageOperationOptions): Effect.Effect<void, MessageOperationFailure>
    /** Lazily delete one attachment by decimal ID from a message authored by this bot, without fetching or rewriting the retained attachment list.
     * Copies the target when run, using message REST deadlines/failures in caller context; no gateway connection is required
     *
     * HTTP 204 returns no value, not event acknowledgement. Deleting the last attachment can delete the whole message if Fluxer considers it otherwise empty.
     * Confirmed or uncertain deletion evicts this message's cached copy. No optimistic events are emitted.
     * A notFound failure can mean only that the attachment is missing; it does not prove the message is absent.
     * Only confirmed 429 rejections retry. Storage removal and message updates are not atomic; lost responses can leave either applied.
     * Interruption awaits cleanup but cannot undo deletion or guarantee physical erasure; defects retain their Cause
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
     * Lazily delete 1–100 distinct decimal message IDs from one guild channel, requiring ManageMessages permission.
     * No gateway connection, hidden selection, chunking, age filter or audit reason. Each run copies the current IDs.
     * HTTP 204 completes with no value, not a deletion count or proof that each ID existed. Missing messages are ignored.
     * Dispatched requests evict selected cached messages even on rejection, since partial deletion is possible.
     * Only confirmed rate-limit rejections retry. Timeout, lost response, interruption or closure cannot undo deletion.
     * Input/admission/HTTP failures use MessageOperationError. Interruption awaits owned cleanup and defects retain Cause
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
}

/** A scoped native collection, separate from each caller observing it */
export interface Collector {
    /** Lazily request idempotent stop with accepted partial replies. Use waitForClose to await callback cleanup */
    stop(): Effect.Effect<void>
    /**
     * Lazily observe the retained frozen result/error after queue, timer, filter, listener and callback cleanup.
     * Multiple/late callers share the first outcome. Interruption affects only this waiter and defects retain Cause.
     * Timeout and stop can return empty/partial replies. Failures carry no partial message bodies.
     * Application-held handles/results retain successful snapshots until released
     */
    waitForClose(): Effect.Effect<CollectorResult, CollectorFailure>
}

/** A scoped native reaction collection, separate from each result observer */
export interface ReactionCollector {
    /** Lazily request idempotent stop with accepted partial observations. Use waitForClose to await callback cleanup */
    stop(): Effect.Effect<void>
    /**
     * Lazily observe the frozen result after queue, timer, filter, listener and callback cleanup; late/multiple observers share the outcome.
     * Interruption affects only this waiter; defects retain Cause. Timeout/stop may return empty or partial observations.
     * Failures carry no partial observations. Application-held handles/results retain successful snapshots until released
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
export type { ShardingOptions, ShardState } from "./sharding.js"

/** Remote audit observations requiring ViewAuditLog, without SDK retention or gateway startup.
 * Eligible reads retry transient failures at most twice under the shared guild REST policy.
 * Permission, malformed-response and input failures are typed GuildOperationError values.
 * Effects are lazy and preserve native defects, caller context and interruption cleanup.
 * Closing clients fail with ClientClosedError. Audit records can change independently; this is not an archival snapshot
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
     * maxItems is required; pageSize defaults to 50 (1–100), maxPages to 100. timeoutMs applies to each page.
     * Stops at maxItems or an empty page, not merely a short page. Concurrent changes can prevent complete enumeration.
     * Invalid traversal input, a stalled cursor or reaching the page budget fails with PaginationError.
     * Remote failures retain auditLogs.fetchPage's typed errors. Already-delivered entries remain caller-owned.
     * Interruption awaits request cleanup; termination releases the buffered page.
     * Closing/Closed releases the page and fails the next pull. Use fetchPage when referenced-user/webhook snapshots are needed
     */
    iterate(
        guildId: string,
        query: AuditLogIterationQuery,
        options?: GuildOperationOptions,
    ): Stream.Stream<AuditLogEntry, GuildOperationFailure | PaginationError>
}

/** Remote invite operations, without invite retention or gateway readiness requirements.
 * Reads retry eligible transient failures at most twice; writes retry only confirmed 429 rejections.
 * Fluxer checks destination visibility, invite permissions and capacity. Failures use GuildOperationError.
 * Effects are lazy; interruption waits for owned cleanup and defects remain native causes.
 * Closing clients fail with ClientClosedError. Lost responses can leave mutations applied; do not replay them blindly
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
    /** Remote management list in provider order, subject to channel permissions; not a stable snapshot */
    fetchChannel(
        channelId: string,
        options?: GuildOperationOptions,
    ): Effect.Effect<readonly InviteMetadata[], GuildOperationFailure>
    /** Remote guild management list, requiring ManageGuild and excluding the guild vanity invite */
    fetchGuild(
        guildId: string,
        options?: GuildOperationOptions,
    ): Effect.Effect<readonly InviteMetadata[], GuildOperationFailure>
    /** Revoke a code after HTTP 204, subject to provider creator/management permissions.
     * Does not remove existing members. A missing code is an error, not proof of a previous successful deletion
     */
    delete(code: string, options?: ModerationOptions): Effect.Effect<void, GuildOperationFailure>
}

/** Emojis share guild REST admission, deadlines and typed GuildOperationError failures.
 * Reads retry eligible transient failures at most twice; writes retry only confirmed 429 rejections.
 * Input, permission, 404 and malformed responses do not retry. Unknown outcomes may leave writes applied.
 * Effects are lazy, preserve caller context and await cleanup on interruption; defects remain in the cause.
 * Closing clients fail with ClientClosedError. Snapshots are frozen and HTTP success is not gateway acknowledgement
 */
export interface Emojis {
    /** Local metadata lookup, never HTTP. Disabled, absent, expired or conflicting entries return undefined.
     * Decimal IDs are required; lookup updates LRU order but not expiry. Lazy in the caller's context
     */
    get(target: ExpressionReference): Effect.Effect<GuildEmoji | undefined, GuildOperationFailure>
    /** Remote full guild list in provider order, without pagination or an enduring completeness guarantee.
     * Populates optional bounded metadata retention, excluding image bytes and creator accounts
     */
    fetchAll(
        guildId: string,
        options?: GuildOperationOptions,
    ): Effect.Effect<readonly GuildEmoji[], GuildOperationFailure>
    /** Remote minimal metadata by decimal ID without source-guild membership. Does not populate the cache */
    fetchMetadata(id: string, options?: GuildOperationOptions): Effect.Effect<ExpressionMetadata, GuildOperationFailure>
    /** Upload one expression. Fluxer enforces format, dimensions, permissions and capacity.
     * Copies input at execution start, without implicit URL fetching or replay of uncertain writes
     */
    create(
        guildId: string,
        input: EmojiCreate,
        options?: ModerationOptions,
    ): Effect.Effect<GuildEmoji, GuildOperationFailure>
    /** Submit 1–50 uploads in one batch, with separate successes and failures and no rollback.
     * Duplicate names cannot map failures to input positions. No automatic chunking or replay.
     * Unknown outcomes require fresh remote observations and caller reconciliation
     */
    createMany(
        guildId: string,
        input: readonly EmojiCreate[],
        options?: ModerationOptions,
    ): Effect.Effect<ExpressionBatch<GuildEmoji>, GuildOperationFailure>
    /** Server-side copy by source ID, preserving source metadata. Fluxer enforces source cloning restrictions */
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
    /** Remove after HTTP 204, invalidating retained observations. A missing target is an error, not proof of prior deletion.
     * Purging defaults false; explicit true also queues irreversible media removal subject to provider restrictions
     */
    delete(target: ExpressionReference, options?: ExpressionDeleteOptions): Effect.Effect<void, GuildOperationFailure>
}

/** Stickers share guild REST admission, deadlines and typed GuildOperationError failures.
 * Reads retry eligible transient failures at most twice; writes retry only confirmed 429 rejections.
 * Input, permission, 404 and malformed responses do not retry. Unknown outcomes may leave writes applied.
 * Effects are lazy, preserve caller context and await cleanup on interruption; defects remain in the cause.
 * Closing clients fail with ClientClosedError. Snapshots are frozen and HTTP success is not gateway acknowledgement
 */
export interface Stickers {
    /** Replace name, description and tags explicitly, without an implicit fetch or image replacement.
     * A fetched sticker may be spread into the input. Its identity must match the target; unknown fields fail locally.
     * Empty/null description clears it; [] clears tags. Uses this group's mutation, failure and cancellation rules
     */
    edit(
        target: ExpressionReference,
        input: StickerEdit,
        options?: ModerationOptions,
    ): Effect.Effect<GuildSticker, GuildOperationFailure>
    /** Local metadata lookup, never HTTP. Disabled, absent, expired or conflicting entries return undefined.
     * Decimal IDs are required; lookup updates LRU order but not expiry. Lazy in the caller's context
     */
    get(target: ExpressionReference): Effect.Effect<GuildSticker | undefined, GuildOperationFailure>
    /** Remote full guild list in provider order, without pagination or an enduring completeness guarantee.
     * Populates optional bounded metadata retention, excluding image bytes and creator accounts
     */
    fetchAll(
        guildId: string,
        options?: GuildOperationOptions,
    ): Effect.Effect<readonly GuildSticker[], GuildOperationFailure>
    /** Remote minimal metadata by decimal ID without source-guild membership. Does not populate the cache */
    fetchMetadata(id: string, options?: GuildOperationOptions): Effect.Effect<ExpressionMetadata, GuildOperationFailure>
    /** Upload one expression. Fluxer enforces format, dimensions, permissions and capacity.
     * Copies input at execution start, without implicit URL fetching or replay of uncertain writes
     */
    create(
        guildId: string,
        input: StickerCreate,
        options?: ModerationOptions,
    ): Effect.Effect<GuildSticker, GuildOperationFailure>
    /** Submit 1–50 uploads in one batch, with separate successes and failures and no rollback.
     * Duplicate names cannot map failures to input positions. No automatic chunking or replay.
     * Unknown outcomes require fresh remote observations and caller reconciliation
     */
    createMany(
        guildId: string,
        input: readonly StickerCreate[],
        options?: ModerationOptions,
    ): Effect.Effect<ExpressionBatch<GuildSticker>, GuildOperationFailure>
    /** Server-side copy by source ID, preserving source metadata. Fluxer enforces source cloning restrictions */
    clone(
        guildId: string,
        sourceId: string,
        options?: ModerationOptions,
    ): Effect.Effect<GuildSticker, GuildOperationFailure>
    /** Remove after HTTP 204, invalidating retained observations. A missing target is an error, not proof of prior deletion.
     * Purging defaults false; explicit true also queues irreversible media removal subject to provider restrictions
     */
    delete(target: ExpressionReference, options?: ExpressionDeleteOptions): Effect.Effect<void, GuildOperationFailure>
}

/** Public server-directory management through the shared guild REST owner, without a discovery cache.
 * Effects are lazy and repeatable in caller context, independent of gateway readiness. Default total deadline is 30,000 ms.
 * Reads retry transient transport and HTTP 500/502/503/504 failures at most twice. Writes retry only confirmed 429 rejections.
 * Input, HTTP and malformed-response failures use GuildOperationError; closing clients use ClientClosedError.
 * Interruption waits for owned cleanup. Defects retain native causes.
 * Application writes may publish or unpublish a listing, invalidate guild observations and cannot promise rollback.
 * There is no hidden eligibility read, automatic resubmission, review approval or directory-joining operation
 */
export interface Discovery {
    /** Remote eligibility and application state for a decimal guild ID, requiring ManageGuild.
     * Returns eligible false when discovery is disabled or the member threshold is unmet, not a diagnosis distinguishing them.
     * Eligibility can change before submission. Reviewed/removed applications include available reasons
     */
    fetchStatus(guildId: string, options?: GuildOperationOptions): Effect.Effect<DiscoveryStatus, GuildOperationFailure>
    /** Remote category IDs and provider labels in provider order, without a retained copy.
     * Requires an authenticated client, not membership of a particular guild or ManageGuild
     */
    fetchCategories(options?: GuildOperationOptions): Effect.Effect<readonly DiscoveryCategory[], GuildOperationFailure>
    /** Submit a guild application, requiring ManageGuild, enabled discovery and current provider eligibility.
     * Pending/approved existing applications fail remotely. Eligible verified/partnered guilds can be approved immediately.
     * Success is the stored application observation, not a guarantee of approval or search-index visibility.
     * An unknown outcome may already have submitted or published the listing; inspect fetchStatus before deciding what to do
     */
    apply(
        guildId: string,
        input: DiscoveryApplicationInput,
        options?: GuildOperationOptions,
    ): Effect.Effect<DiscoveryApplication, GuildOperationFailure>
    /** Nonempty patch of a pending or approved application, requiring ManageGuild and enabled discovery.
     * Omitted fields remain unchanged. Uses the input's documented tag normalization and replacement semantics.
     * No hidden fetch/merge. Approved listing updates can become public, and search-index changes may lag or partially fail
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

/** Lazy guild REST operations, gateway counts and optional local lookup in caller context.
 * The REST rules below exclude fetchCounts, which requires gateway readiness and has its own documented contract.
 * Shares the client's four HTTP slots, 256 pending requests and 4 MiB pending JSON budget with message/member/role operations, client-wide across locally owned shards
 *
 * Total deadline defaults to 30,000 ms including waits. Reads retry transport failures and HTTP 500/502/503/504 at most twice.
 * Backoff is 125–250 ms then 250–500 ms, honoring longer Retry-After. Confirmed 429 waits are separate and never reset the deadline
 *
 * Input, 404, permission failures and malformed successes do not retry. Expected failures use GuildOperationError.
 * Interruption awaits owned cleanup; closing clients use ClientClosedError. Defects retain native causes, including cleanup failures
 */
export interface Guilds {
    /** Lazily fetch fresh, visibility-filtered counts for 1–100 distinct canonical positive uint64 decimal guild IDs over the connected gateway.
     * Copies IDs when run, in the caller's Effect context. No implicit connection, REST read, cache, polling or retries
     *
     * Every requested guild must route to a locally owned ready shard. An unowned or unready guild fails notConnected instead of appearing in omittedGuildIds
     *
     * Returns frozen counts plus omittedGuildIds in input order. Missing entries are not zero and do not explain access or timeout.
     * Observations are not a consistent snapshot across guilds. A missing whole reply fails with timeout instead
     *
     * One logical call holds one client-wide slot across every routed shard command and reply fragment. It shares four slots with channels.fetchMemberCounts and members.iterateChunks, without a queue; additional calls fail busy.
     * The default 30,000 ms overall deadline covers local registration, all commands and all fragments.
     * Fluxer also shares provider capacity with member/presence requests, so local admission cannot guarantee a reply
     *
     * Only a gap on a participating shard fails this request with connectionLost; late replies are ignored.
     * CountOperationError covers input/readiness/admission/timeout/response failures; closure uses ClientClosedError.
     * Interruption awaits local cleanup but cannot cancel dispatched provider work; defects retain their Cause
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
    /** Lazily fetch one fresh remote membership page for this bot, ordered by ascending guild ID.
     * limit defaults to 200 (1–200); before/after are mutually exclusive existing-membership cursors.
     * withCounts defaults to false. Fluxer can omit permission bits or requested approximate counts. Missing means unavailable, not zero.
     * A removed cursor can cause Fluxer to restart the page. Returns frozen summaries without populating or reading the guild cache.
     * Summaries are REST-only observations and do not claim a complete membership inventory or gateway consistency.
     * Uses this group's deadlines, retries and failures; no gateway connection or background traversal required
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
    /** Lazily traverse ascending guild IDs, retaining one page and never prefetching.
     * maxItems is required; pageSize defaults to 200 and maxPages to 100. Stop at maxItems or an empty page, not a short page
     *
     * Repeated/backward IDs after a removed cursor fail with PaginationError cursorStalled before that page is delivered.
     * Other pagination failures are input/pageLimit; remote failures preserve fetchPage's error and per-page timeout.
     * Each stream consumption copies inputs in the caller's scope; interruption and scope closure await request cleanup.
     * Scope cleanup releases the buffered page. Client closure releases the page and fails the next pull
     *
     * withCounts applies to every page. Fluxer can omit permission bits or requested counts. Missing means unavailable, not zero.
     * No cache hydration, gateway requirement or consistent-inventory guarantee. Previously delivered values remain caller-owned
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
    /** Lazily leave the named guild as the authenticated bot, explicitly preserving authored messages.
     * HTTP 204 completes membership removal, not gateway delivery. The client stays usable for other guilds.
     * Fluxer rejects owners and restricted memberships. Only confirmed 429 rejection is retried; cancellation or a lost
     * response can leave membership removed. Refetch/list to reconcile; rejoining requires external authorization.
     * Successful or uncertain writes invalidate this guild's resource observations and pending reads.
     * A confirmed successful leave also forgets this client's member-presence selection; an uncertain result preserves it.
     * Any dispatched attempt conservatively clears channel/message caches because messages need not carry guild IDs.
     * Existing caller-held snapshots remain unchanged. This operation never deletes the guild or shuts down the client
     */
    leave(guildId: string, options?: GuildOperationOptions): Effect.Effect<void, GuildOperationFailure>
    /** Read a decimal guild's custom invite and use count, requiring ManageGuild.
     * Always remote, without a vanity cache or gateway requirement. Null code/url means no custom invite.
     * Lazy and repeatable, using this group's read retries, deadline, interruption and typed failure rules
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
     * Returns only code/url after HTTP success, without a hidden read, joinability check or event acknowledgement.
     * Lazy in caller context with the shared deadline and interruption cleanup. Only confirmed 429 rejections may retry writes.
     * Dispatched writes invalidate guild observations. Unknown outcomes require fetchVanityUrl and caller reconciliation,
     * not blind replay; provider-side partial changes can require operator recovery.
     * Uses this group's GuildOperationError and ClientClosedError behavior; defects retain native causes
     */
    editVanityUrl(
        guildId: string,
        code: string | null,
        options?: ModerationOptions,
    ): Effect.Effect<GuildVanityUrl, GuildOperationFailure>
    /** Patch bot-permitted server settings without a hidden read or merge; omitted fields remain unchanged.
     * Requires ManageGuild. Fluxer owns feature restrictions and validation beyond GuildEdit's local checks.
     * Dispatched mutations invalidate guild-cache observations even when the outcome is unknown.
     * Lazy in caller context, using guild REST deadlines and interruption cleanup.
     * Success returns the server's observed configuration, not gateway acknowledgement or rollback guarantees.
     * Uncertain writes must be reconciled with fetch rather than blindly replayed
     */
    edit(guildId: string, input: GuildEdit, options?: ModerationOptions): Effect.Effect<Guild, GuildOperationFailure>
    /** Ban a decimal guild/user target, including a user who is not currently a member.
     * Requires BanMembers and provider hierarchy/MFA rules. Defaults to permanent with no message deletion
     *
     * HTTP 204 returns no value, not event acknowledgement. Writes retry only confirmed 429 rejections.
     * Failure after dispatch may leave a ban and separately queued message deletion applied
     *
     * Dispatched actions invalidate this member's retained snapshot even on rejection.
     * Requested message cleanup evicts this author's cached messages across guilds, since messages lack guild IDs.
     * The cleanup job can finish later. A later cache hit does not establish that its message survived the job
     *
     * Bans may also block rejoining through provider-side IP/email checks. Unban restores neither messages nor membership.
     * Lazy, repeatable and caller-owned. Interruption awaits cleanup and defects retain Cause.
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
    /** Fetch the provider's full ban list as frozen observations, requiring BanMembers.
     * Always remote, without a ban cache, pagination or guaranteed order. Separate reads are not a consistent snapshot.
     * Lazy and repeatable. Uses shared guild read deadline/retry rules, rejecting malformed responses as a whole
     */
    fetchBans(
        guildId: string,
        options?: GuildOperationOptions,
    ): Effect.Effect<readonly GuildBan[], GuildOperationFailure>
    /** Lazy local-only guild lookup, evaluated when run, without HTTP or requiring a connection.
     * Returns undefined when disabled, absent, expired or evicted. Snapshots may be stale. Use fetch for a remote observation.
     * Invalid decimal IDs fail with GuildOperationError(input). Closing/closed clients fail with ClientClosedError.
     * Defects retain native causes. Lookup updates LRU order but never extends expiry
     */
    get(guildId: string): Effect.Effect<Guild | undefined, GuildOperationFailure>
    /** Fetch a frozen identity/configuration projection for a decimal guild ID. Fluxer requires guild membership.
     * No embedded member/role/channel state is retained and no counts or completeness guarantee are inferred
     */
    fetch(guildId: string, options?: GuildOperationOptions): Effect.Effect<Guild, GuildOperationFailure>
}

/** Lazy guild-channel REST operations, gateway member counts and optional local lookup in caller context.
 * The REST rules below exclude fetchMemberCounts, which requires gateway readiness and has its own documented contract
 *
 * DM operations are outside this API contract. Supply decimal guild-channel IDs. ID-targeted writes do not prefetch or verify their guild type.
 * Shares the client's four HTTP slots, 256 pending requests and 4 MiB pending JSON budget with guild/member/role/message operations, client-wide across locally owned shards.
 * Total deadline defaults to 30,000 ms, including admission, retry and rate waits. Reads retry transport failures and HTTP 500/502/503/504 at most twice.
 * Writes retry only confirmed 429 responses. Permission, input, 404 and malformed-response failures do not retry
 *
 * All dispatched channel mutations invalidate the whole enabled channel cache. Pre-dispatch input failures preserve it, and this API never follows a write with an implicit fetch
 *
 * Operation inputs are copied when the Effect executes and later caller mutations are not observed. Permission bits are bigint values encoded as decimal JSON strings.
 * Fluxer enforces channel permissions and grant restrictions. Targeted overwrite operations require ManageRoles for role and member targets.
 * Expected failures use ChannelOperationError or ClientClosedError. Interruption and defects retain native causes after owned cleanup
 */
export interface Channels {
    /** Lazily fetch fresh counts for 1–25 distinct channel IDs in one guild, using canonical positive uint64 decimal IDs over the connected gateway.
     * Copies IDs when run. Requires the guild's locally owned shard to be ready plus ViewChannel and ViewChannelMembers; no hidden connect or REST reads.
     * The guild must route to a locally owned ready shard. An unowned or unready guild fails notConnected instead of appearing in omittedChannelIds
     *
     * Returns frozen counts plus omittedChannelIds in input order. Omission never becomes zero or identifies its cause.
     * Counts are visibility-filtered observations, not a subscription or guaranteed cross-channel snapshot.
     * Uses guilds.fetchCounts' one-logical-slot four-call admission, default 30,000 ms overall deadline, no-retry, participant-shard recovery and failure/cleanup rules.
     * No channel/member cache writes. Native interruption cannot stop dispatched provider work
     */
    fetchMemberCounts(
        guildId: string,
        channelIds: readonly string[],
        options?: CountOperationOptions,
    ): Effect.Effect<ChannelMemberCountsResult, CountOperationFailure>
    /** Lazily read the enabled channel cache without HTTP or requiring a connection.
     * Returns undefined when disabled, absent, expired or evicted. Snapshots may be stale. Use fetch for a remote observation.
     * Invalid decimal IDs fail with ChannelOperationError(input). Closing/closed clients fail with ClientClosedError.
     * Defects retain their native cause. Lookup updates LRU order but never extends expiry
     */
    get(channelId: string): Effect.Effect<GuildChannel | undefined, ChannelOperationFailure>
    /** Fetch one frozen guild-channel observation by decimal ID, without connecting or populating a complete guild list.
     * A non-guild response is a typed response failure. The result has explicit overwrites only, not inherited or effective permissions
     */
    fetch(channelId: string, options?: ChannelOperationOptions): Effect.Effect<GuildChannel, ChannelOperationFailure>
    /** Fetch Fluxer's visible guild-channel list for one decimal guild ID, without pagination or a completeness guarantee.
     * The response is a point-in-time observation, not a subscription. It does not fetch members, roles, DMs or missing permission-overwrite targets
     */
    fetchAll(
        guildId: string,
        options?: ChannelOperationOptions,
    ): Effect.Effect<readonly GuildChannel[], ChannelOperationFailure>
    /** Create one supported guild channel and return Fluxer's frozen observation. Fluxer chooses its initial position.
     * Omitted permissionOverwrites inherits the selected parent category's overrides. [] creates no explicit overrides, not private visibility
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
        options?: ChannelOperationOptions,
    ): Effect.Effect<GuildChannel, ChannelOperationFailure>
    /** Patch only supplied channel settings and return Fluxer's frozen observation. Empty/unknown-field patches are input errors.
     * Channel type and parent are intentionally not editable here. Move a channel with reorder. Omitted permissionOverwrites preserves them, while [] clears them
     */
    edit(
        channelId: string,
        input: ChannelEdit,
        options?: ChannelOperationOptions,
    ): Effect.Effect<GuildChannel, ChannelOperationFailure>
    /** Delete a guild channel and complete after HTTP 204, without waiting for a gateway event or proving a prior channel existed.
     * The SDK does not prefetch to verify the ID. A lost response or timeout after dispatch may leave deletion applied
     */
    delete(channelId: string, options?: ChannelOperationOptions): Effect.Effect<void, ChannelOperationFailure>
    /** Apply submitted guild-channel moves sequentially and complete after HTTP 204, without fabricating a reordered snapshot.
     * syncPermissionsOnMove copies the target category's overwrites. A bulk channel event can arrive before that permission copy completes.
     * Fluxer may normalize positions. This bulk mutation is not a transaction, so failures can leave partial movement. Refetch when final order matters
     */
    reorder(
        guildId: string,
        positions: readonly ChannelPosition[],
        options?: ChannelOperationOptions,
    ): Effect.Effect<void, ChannelOperationFailure>
    /** Replace one explicit role/member overwrite with its supplied raw bigint allow and deny bits, then complete after HTTP 204.
     * Fluxer enforces ManageRoles. This does not calculate inherited/effective permissions or prefetch the target
     */
    setPermissionOverwrite(
        channelId: string,
        input: PermissionOverwrite,
        options?: ChannelOperationOptions,
    ): Effect.Effect<void, ChannelOperationFailure>
    /** Remove one explicit role/member overwrite by decimal target ID and complete after HTTP 204.
     * Fluxer enforces ManageChannels and ManageRoles. Other overwrites remain unchanged, and an unknown outcome requires an explicit follow-up read
     */
    removePermissionOverwrite(
        channelId: string,
        targetId: string,
        options?: ChannelOperationOptions,
    ): Effect.Effect<void, ChannelOperationFailure>
}

/** Lazy membership reads, moderation and targeted role writes with Guilds' REST admission, deadlines and failure rules.
 * iterateChunks uses the gateway and its own documented stream rules instead.
 * Returned members are frozen observations. Optional retention follows ClientOptions.cache.members, without permission prediction or automatic guild download.
 * Writes retry only confirmed 429 rejections, never uncertain outcomes. Interruption cannot undo a dispatched write
 */
export interface Members {
    /** Lazily request one guild's gateway members, streaming frozen batches in the consuming Effect scope without accumulating a roster.
     * Each consumption copies inputs and sends one request. Select explicit userIds, a query prefix, or all: true
     *
     * Requires the guild's locally owned shard to be ready. Full-list mode is provider-capped at 100,000 members; its 30-second per-bot/guild limit depends on server enforcement.
     * One member stream is admitted at a time per client, not per gateway connection. It holds one of four client-wide slots shared with gateway counts until consumed or released
     *
     * The guild must route to a locally owned ready shard. An unowned or unready guild fails notConnected. Only its owning-shard gap fails this stream; healthy-shard work continues.
     * No implicit connection, REST fallback, cache writes, presence subscription, raw-event forwarding or automatic retries
     *
     * Delivers provider chunk order, checking indices, advertised count, member uniqueness and presence association.
     * Success means every advertised batch arrived, not a complete or atomic guild snapshot. Missing selected IDs are explicit on the final batch.
     * Optional presences omit unavailable/offline/invisible observations. Missing presence never proves offline status
     *
     * timeoutMs defaults to 30,000 for the whole reply. maxPendingBytes defaults to 4 MiB of accounted unread wire bytes.
     * Fluxer pushes batches without backpressure; slow readers can overflow. Pausing consumption does not pause intake or its deadline
     *
     * A gap, timeout, malformed reply or overflow discards unread batches and fails with MemberChunkError, never a silent partial success.
     * Previously emitted batches stay caller-owned. Client closure fails with ClientClosedError and releases local buffers
     *
     * Interruption, early stream termination and scope closure release intake, timers and buffers without cancelling Fluxer's dispatched work.
     * Late/unmatched chunks are ignored and chunks are not replayed on Resume. Defects and interruption retain native causes and caller context
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
    /** Lazily replace the member's entire explicit role set with 0–250 distinct positive decimal role IDs in one PATCH.
     * Copies IDs when run in the caller's Effect context, with no prefetch or merge. [] clears assigned roles; the implicit everyone role is rejected as input
     *
     * Requires provider ManageRoles and hierarchy permission for changes. This may overwrite concurrent role changes.
     * Fluxer can silently omit nonexistent or foreign role IDs. Returns its frozen actual member, not a promise that every requested role was accepted
     *
     * Uses shared guild write deadlines/failures and only confirmed 429 retries. No gateway readiness or event acknowledgement is required.
     * Eligible responses update member caching; uncertain dispatched writes evict it and need explicit fetch reconciliation.
     * Interruption awaits cleanup but cannot undo the replacement; defects retain their Cause
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
        options?: GuildOperationOptions,
    ): Effect.Effect<GuildMember, GuildOperationFailure>
    /** Lazy remote search of indexed snapshots, not the local member cache or full hydrated members.
     * Default page size 25, offset 0, join-time descending. Results can lag membership changes.
     * indexing=true is not completed emptiness; empty/indexing=false can also mean an unavailable provider search service
     *
     * Invite-sensitive filters fetch and require the bot's ManageGuild permission first. This is not atomic with search.
     * Other filters add no reads. No search hit enters the member cache. Inputs are copied on execution.
     * timeoutMs defaults to 30,000 for the full call. Preflight GETs use shared read retries; the search POST only retries
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
    /** Lazy bounded Stream of unique indexed hits, with independent state and copied filters per consumption.
     * maxItems required, pageSize defaults to 100 (1–100), maxPages to 100. No prefetch or implicit full-member fetch.
     * Offset advances by received count; retains at most maxItems user IDs. Changing indexes may skip users despite dedupe.
     * indexing=true fails with PaginationError indexing. An empty page before observed total fails cursorStalled.
     * Reaching maxItems is normal completion, not exhaustion. Input/pageLimit/cursorStalled are other PaginationError reasons.
     * Each page uses search's deadline/preflight/retry rules. Interruption, stream scope closure and client closure release
     * retained state and await owned request cleanup. Delivered snapshots remain caller-owned; defects remain in the Cause
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
     * The returned member omits bio and pronouns; success is not proof those fields were stored.
     * Uncertain dispatched writes and interruption evict affected member retention; definite rejection preserves prior snapshots
     */
    editSelf(
        guildId: string,
        input: MemberProfileEdit,
        options?: GuildOperationOptions,
    ): Effect.Effect<GuildMember, GuildOperationFailure>
    /** Lazily set or clear one member nickname without replacing that member's roles or profile fields.
     * nickname is 1–32 Unicode code points; null clears it. Fluxer decides ManageNicknames, hierarchy and self rules.
     * The frozen HTTP response is not an event acknowledgement. Interruption awaits request cleanup but cannot undo dispatch.
     * An uncertain result evicts the targeted member cache; a definite rejection preserves its prior snapshot
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
        options?: GuildOperationOptions,
    ): Effect.Effect<GuildMember, GuildOperationFailure>
    /** Set a timeout for integer durationMs in 1–31,536,000,000 milliseconds, calculated when execution starts
     *
     * Requires ModerateMembers and provider hierarchy rules. The provider rejects self and administrator targets.
     * Queue/network time consumes this duration. An expiry already past at processing time can clear the timeout
     *
     * Returns the frozen HTTP 200 member with communicationDisabledUntil, without waiting for an event.
     * Uses shared guild deadlines and failures. Writes retry only confirmed 429 rejections.
     * Lazy, repeatable effects preserve caller context and defects.
     * Interruption and closure await owned cleanup but cannot undo a dispatched timeout
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
        options?: ModerationOptions,
    ): Effect.Effect<GuildMember, GuildOperationFailure>
    /** Clear a timeout with timeout's permissions, execution, cache and failure rules.
     * Sends null, not a negative duration. Returns the HTTP 200 member without waiting for an event
     */
    clearTimeout(
        target: MemberReference,
        options?: ModerationOptions,
    ): Effect.Effect<GuildMember, GuildOperationFailure>
    /** Kick the selected guild member after HTTP 204, without waiting for a removal event.
     * Requires KickMembers and provider hierarchy rules. Does not ban the user or automatically restore membership.
     * Missing membership is a typed API failure. Dispatched actions invalidate the member cache even on rejection.
     * Uses timeout's execution/deadline/failure rules, with no automatic retry after an uncertain result
     */
    kick(target: MemberReference, options?: ModerationOptions): Effect.Effect<void, GuildOperationFailure>
    /** Traverse ascending remote user IDs as a lazy Stream, without connecting or eagerly downloading the guild.
     * Each execution copies inputs and owns independent progress in the caller's context.
     * maxItems is required, pageSize defaults to 100 and maxPages to 100. timeoutMs applies separately to each page.
     * Emits frozen members until maxItems or an empty page, not a short page. Pages are not a consistent snapshot
     *
     * PaginationError covers input, cursorStalled and pageLimit. Remote errors retain members.fetchPage's operation/retry policy.
     * Interruption and defects retain native causes. Termination awaits request cleanup and releases the buffered page.
     * Closing/Closed releases the page and fails the next pull. Delivered items remain caller-owned after later failure.
     * Enabled member caching follows fetchPage admission. No role preloading, permission prediction or full-result retention
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
    /** Lazy local-only lookup by decimal guild/user IDs, with Guilds.get's miss, freshness, failure and LRU rules.
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
    /** Fetch one member by decimal guild/user IDs; HTTP 404 uses notFound rather than an empty result */
    fetch(member: MemberReference, options?: GuildOperationOptions): Effect.Effect<GuildMember, GuildOperationFailure>
    /** Fetch the authenticated bot's membership directly, without requiring READY or a known bot ID */
    fetchSelf(guildId: string, options?: GuildOperationOptions): Effect.Effect<GuildMember, GuildOperationFailure>
    /** Lazily fetch fresh guild, authenticated-bot member, target member and role observations in parallel, then evaluate canManageHierarchy.
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
    /** Fetch an ascending user-ID page; default limit 100, range 1–1000.
     * Use the last userId as after. An empty page ends traversal; separate pages are not a consistent snapshot.
     * No hasMore guarantee, automatic traversal or partial malformed page. Inputs are copied on execution, not Effect construction
     */
    fetchPage(
        guildId: string,
        query?: MemberQuery,
        options?: GuildOperationOptions,
    ): Effect.Effect<readonly GuildMember[], GuildOperationFailure>
    /** Grant one decimal role ID without replacing other roles. Reject the implicit everyone role locally.
     * Fluxer enforces MANAGE_ROLES and hierarchy. HTTP 204 is completion, not event acknowledgement or proof the role was previously absent
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
        options?: GuildOperationOptions,
    ): Effect.Effect<void, GuildOperationFailure>
    /** Revoke one role with addRole's permission/completion rules. Other roles remain untouched.
     * No local snapshot suppresses the request; success does not prove a previously assigned role was removed
     */
    removeRole(
        member: MemberReference,
        roleId: string,
        options?: GuildOperationOptions,
    ): Effect.Effect<void, GuildOperationFailure>
}

/** Permission-bit calculations only, not timeout, hierarchy, channel visibility or action-success decisions */
export interface PermissionHelpers {
    /** Lazy local calculation from supplied snapshots, no requests or cache reads.
     * Connection state is irrelevant, including after shutdown. Missing/inconsistent required data fails with
     * GuildOperationError permissions.calculate/input. Owner/base Administrator grants all unsigned 64 bits.
     * Otherwise applies everyone, aggregated role and member overwrites, preserving unknown bits.
     * Uses the target channel's stored overrides, not its parent category. Inputs read on execution, defects stay in Cause
     */
    calculate(input: PermissionInput): Effect.Effect<bigint, GuildOperationError>
    /** Lazy composition of fresh guild/member/role and optional target-channel reads, then local calculation.
     * No gateway or cache-first lookup. Existing caches may admit fetched resources, but permission results are not retained.
     * Sequential reads are not atomic or an authorization guarantee. timeoutMs defaults to 30,000 across the workflow.
     * Shared read retries apply. Interruption awaits owned cleanup in the caller's scope.
     * Invalid inputs use permissions.fetch/input, resource failures retain their GuildOperationError/ChannelOperationError,
     * client closure uses ClientClosedError and defects remain in Cause. Cross-guild channel snapshots fail
     */
    fetch(
        target: PermissionTarget,
        options?: GuildOperationOptions,
    ): Effect.Effect<bigint, GuildOperationFailure | ChannelOperationFailure>
}

/** Lazy caller-context role operations sharing Guilds' admission, deadlines and read retries.
 * Writes retry only confirmed 429 rejections. Server permissions/hierarchy apply; no local permission prediction.
 * Interruption waits for owned cleanup but cannot undo dispatched writes. Success is not a gateway acknowledgement.
 * Expected failures use GuildOperationError or ClientClosedError; defects and interruption retain native causes.
 * Inputs are copied on execution, not Effect construction; returned roles contain bigint permissions and require explicit JSON conversion
 */
export interface Roles {
    /** Lazy local-only lookup by decimal guild/role IDs, including everyone, with Guilds.get's miss, freshness, failure and LRU rules */
    get(role: RoleReference): Effect.Effect<GuildRole | undefined, GuildOperationFailure>
    /** Fetch the current role list, including everyone, in server order. Always remote, without pagination or automatic refresh */
    fetchAll(
        guildId: string,
        options?: GuildOperationOptions,
    ): Effect.Effect<readonly GuildRole[], GuildOperationFailure>
    /** Create a role with name, color and permissions. Permissions default to 0n, not Fluxer's inherited everyone grants.
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
        options?: GuildOperationOptions,
    ): Effect.Effect<GuildRole, GuildOperationFailure>
    /** Patch only defined fields and return the server's observation. Empty/unknown-field patches are input errors.
     * permissions replaces the raw grants; it is not an additive grant. Everyone edits remain subject to server rules */
    edit(
        role: RoleReference,
        input: RoleEdit,
        options?: GuildOperationOptions,
    ): Effect.Effect<GuildRole, GuildOperationFailure>
    /** Delete a role, also removing its assignments upstream. Everyone cannot be deleted.
     * HTTP 204 is completion, not proof of member-event delivery; old member/role observations remain unchanged */
    delete(role: RoleReference, options?: GuildOperationOptions): Effect.Effect<void, GuildOperationFailure>
    /** Reorder distinct role IDs using nonnegative safe-integer positions; everyone cannot move.
     * Fluxer normalizes manageable positions, so fetchAll afterward when final order matters. HTTP 204 carries no list.
     * This operation and multi-step workflows are not transactions: Failures can leave partial state; refetch before reconciliation */
    reorder(
        guildId: string,
        positions: readonly RolePosition[],
        options?: GuildOperationOptions,
    ): Effect.Effect<void, GuildOperationFailure>
    /** Set display positions for distinct roles without changing permission hierarchy or enabling hoist.
     * Requires a nonempty list of signed 32-bit positions, excluding everyone. Fluxer enforces ManageRoles and hierarchy.
     * HTTP 204 returns no roles. Successful or uncertain writes invalidate retained guild roles, including pending reads.
     * Failures or cancellation can leave partial changes; refetch before reconciliation rather than replaying blindly
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
        options?: GuildOperationOptions,
    ): Effect.Effect<void, GuildOperationFailure>
    /** Clear display-position assignments for every role in the guild, not just roles below the bot.
     * Fluxer enforces ManageRoles. Permission hierarchy and hoist flags remain unchanged.
     * HTTP 204 has no role list. This is not transactional; a failure can leave partial changes.
     * Successful or uncertain writes invalidate retained guild roles. Refetch to reconcile an unknown outcome
     */
    resetHoistPositions(guildId: string, options?: GuildOperationOptions): Effect.Effect<void, GuildOperationFailure>
}

/** Bot-authenticated remote webhook management, available before connect.
 * No webhook cache, hidden credential persistence or synthesized events.
 * JSON responses are bounded to 1 MiB and malformed or larger responses fail with reason response.
 * Each Effect is lazy, with native interruption and defects.
 * Requests default to a 30-second total deadline, allow bounded read retries and retry writes only after confirmed rate-limit rejection.
 * Shutdown rejects new work and awaits admitted request cleanup. Separate clients do not coordinate rate limits
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

/** Token-only HTTP client, without a bot token, gateway, caches or persistent storage.
 * Operations are lazy and preserve native defects/interruption.
 * Cleanup defects stop retries and preserve any operation failure or interruption alongside the defect in Cause.
 * Requests default to a 30-second total deadline across admission, rate waits, retries and HTTP.
 * Cancellation interrupts only that operation and awaits request/body cleanup, without rolling back remote effects
 *
 * Errors contain only safe categories and status, never credential-bearing paths or upstream bodies.
 * JSON responses exceeding 1 MiB fail with reason response. Other client caches are not updated by this token-only client
 */
export interface WebhookClient {
    /** Credential identity, never a token-bearing URL */
    readonly id: string
    /** Send with wait=true and return the created message. Mentions default off. Files use bounded multipart streaming, with 50 MiB maximum per file.
     * Image/thumbnail attachment URLs match a new upload in this execution. flags accepts only the two non-voice MessageFlags bits.
     * Snapshot inputs at execution, including admitted file bytes. Never retry an uncertain send, which may already have posted */
    send(input: WebhookMessageInput, options?: MessageOperationOptions): Effect.Effect<Message, WebhookOperationFailure>
    /** Fetch a decimal message ID authored by this webhook in its current channel, with bounded transient read retries */
    fetchMessage(messageId: string, options?: MessageOperationOptions): Effect.Effect<Message, WebhookOperationFailure>
    /** Edit this webhook's message and return its snapshot. Omitted fields remain unchanged, mentions default off, and attachments cannot be replaced.
     * flags-only edits replace the two writable non-voice bits; zero clears them. Existing file references are not resolved for embed inputs
     */
    editMessage(
        messageId: string,
        input: WebhookMessageEdit,
        options?: MessageOperationOptions,
    ): Effect.Effect<Message, WebhookOperationFailure>
    /** Delete this webhook's message. 204 is success without proving earlier existence, and uncertain failures may follow deletion */
    deleteMessage(messageId: string, options?: MessageOperationOptions): Effect.Effect<void, WebhookOperationFailure>
    /** Permanently reject new work, cancel admitted work, await transport cleanup and release the owned token reference.
     * Does not delete the remote webhook or invalidate caller-held credentials. Concurrent calls share the same pending cleanup
     */
    shutdown(): Effect.Effect<void>
}

/** Native local cache controls. They never fetch, refresh, mutate remote resources, or capture a service context */
export interface ClientCache {
    /**
     * Lazily return up to limit already-observed frozen projections from one configured cache category in current eviction order.
     * Users/directMessages use observation order. Other categories use least-to-most-recent order
     *
     * Omit limit for 100 entries. A positive safe integer from 1 through 1,000 is required.
     * Execution releases expired entries before the snapshot and does not refresh data or change the eviction order.
     * The frozen array can be partial because retention, expiry, conflicts, gaps, clear and shutdown discard observations.
     * Entries contain the requested cached data, unlike client.diagnostics. No network request or remote completeness claim is made
     *
     * A closed client succeeds with an empty array. Invalid kind or limit fails with ConfigurationError without exposing the rejected value.
     * It captures no service or scope. Interruption before execution leaves cache state unchanged. Once started it completes synchronously
     */
    entries<K extends CacheKind>(
        kind: K,
        options?: CacheEntriesOptions,
    ): Effect.Effect<readonly CachedResources[K][], ConfigurationError>
    /**
     * Synchronously release every SDK-held cache observation without changing configuration, caller-held frozen projections, requests or remote resources.
     * In-flight reads that began before this call cannot repopulate cleared observations. Later reads can cache normally.
     * Existing mutation guards retain their conservative invalidation behavior. Safe to repeat, including after closure.
     * It takes no cancellation signal and completes synchronously
     */
    clear(): void
}

/**
 * Native client with lazy operations in the caller's Effect context.
 * The scope that creates the client owns its connection work and permanent cleanup.
 * Expected errors use the typed failure channel, while defects and interruption remain in the native cause.
 * Cleanup defects stop retries and preserve any operation failure or interruption alongside the defect in Cause
 */
export interface Client extends ClientState {
    /** Public server-directory management, not gateway service discovery or directory joining */
    readonly discovery: Discovery
    /** Process-local requested presence, restored after gateway reconnects and never stored across process restarts */
    readonly presence: Presence
    /** Current authenticated bot application allowlist, without owner or application-management operations */
    readonly application: CurrentBotApplication
    /** Public account reads and optional local lookup */
    readonly users: Users
    /** One-to-one and group conversations, composed with messages for content operations */
    readonly directMessages: DirectMessages
    /** Bot-authenticated webhook management with token-free metadata */
    readonly webhooks: Webhooks
    /** Remote role management and explicitly enabled local role lookup */
    readonly roles: Roles
    /** Explicit local and remote permission-bit helpers, without cached decisions */
    readonly permissions: PermissionHelpers
    /** Remote guild reads and ban management, with explicitly enabled local guild lookup */
    readonly guilds: Guilds
    /** Remote invite inspection and management, without accepting invites or retaining codes */
    readonly invites: Invites
    /** Remote filtered audit pages and bounded traversal; no audit cache */
    readonly auditLogs: AuditLogs
    /** Custom emoji lifecycle and optional local metadata lookup */
    readonly emojis: Emojis
    /** Custom sticker lifecycle and optional local metadata lookup */
    readonly stickers: Stickers
    /** Remote guild-channel reads, mutations and explicitly enabled local lookup */
    readonly channels: Channels
    /** Remote member reads, moderation and targeted role assignment */
    readonly members: Members
    /** REST, local lookup and live collection owned by this client */
    readonly messages: Messages
    /** Local cache enumeration and release controls. Caching remains opt-in through ClientOptions.cache */
    readonly cache: ClientCache
    /**
     * Lazily register one EventMap event in the caller's scope and context, before or after connect.
     * No cache or REST-generated events. Bulk deletions do not also invoke messageDelete handlers.
     * Enabled cache changes happen before user dispatch, independently of subscriptions and their overflow.
     * Defaults: One active invocation, 256 queued payloads, 4 MiB queued source JSON per registration.
     * A bulk payload counts once, including its full bytes. Ordering is per subscription, not across event types.
     * Explicit concurrency permits out-of-order completion. No history or exactly-once delivery is promised
     *
     * Handler failures are isolated and reported without retrying the invocation
     *
     * Overflow stops only this subscription and remains observable through the returned handle.
     * Client or registration-scope closure interrupts handlers and awaits native cleanup.
     * Observe subscription failure alongside client.run/waitForClose. No detached native runtime is created
     */
    on<E, R, E2 = never, R2 = never, K extends EventName = "messageCreate">(
        event: K,
        handler: (message: EventMap[K]) => Effect.Effect<unknown, E, R>,
        options?: EventHandlerOptions<E2, R2>,
    ): Effect.Effect<Subscription, RegistrationError, R | R2 | Scope.Scope>
    /**
     * Lazy bounded stream for one event type in receive order. Each execution owns a subscription without history or bulk fan-out.
     * Enabled cache changes happen before delivery, independently of this subscription and its overflow.
     * Stream scope releases its subscription. Overflow fails this stream rather than silently dropping events.
     * Consumers choose stream concurrency and supervision. Options govern source buffers only
     */
    events<K extends EventName>(
        event: K,
        options?: EventBufferOptions,
    ): Stream.Stream<EventMap[K], RegistrationError | EventOverflowError>
    /**
     * Read an immutable point-in-time local occupancy snapshot without network work, telemetry, persistence, tokens, remote routes, resource IDs or payloads.
     * Counts cover this client's owned shards and admitted local work only. Accounted bytes are cache/queue budgets, not heap, process memory or remote storage.
     * Configured cache bounds remain visible after closure, while retained counts report actual owner release progress. This does not establish remote completeness or readiness.
     * It takes no cancellation signal and completes synchronously
     */
    diagnostics(): ClientDiagnostics
    /**
     * Connect when this Effect executes and complete after every locally assigned shard authenticates and completes READY.
     * Readiness does not wait for GUILD_CREATE, a guild roster, or every resource to load
     *
     * Owns startup only, using the client's connection settings.
     * Interruption or an expected failure before initial group readiness waits for assigned-shard cleanup and permits reuse while the owning scope stays open.
     * After success the connection and recovery remain owned by that scope, not by this completed operation.
     * After all assigned shards are ready, a permanent required-shard failure in a multi-shard plan closes the client. waitForClose retains `ShardConnectionError { shardId, failure }`
     *
     * @returns A lazy Effect with connection, busy or closed failures.
     * An already connected unmanaged client succeeds without opening another socket.
     * Competing calls fail without taking ownership, and defects retain the native cause
     */
    connect(): Effect.Effect<void, ConnectError>
    /**
     * Own startup, lifetime observation and permanent cleanup in one lazy Effect.
     * Remains pending through established operation and transient recovery.
     * An accepted run leaves the client Closed when it ends, including failure or interruption.
     * After all assigned shards are ready, a permanent required-shard failure in a multi-shard plan closes the client and reports `ShardConnectionError { shardId, failure }`
     *
     * Accepts only a Disconnected client without competing work.
     * Rejection before admission leaves existing work untouched.
     * Interruption controls the accepted run's whole lifetime and waits for cleanup
     *
     * @returns Success after normal shutdown, with connection, busy or closed typed failures.
     * Interruption and defects remain native, including combined operation and cleanup causes
     *
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
     * The application executes this Effect and handles its typed failures and native cause
     */
    run(): Effect.Effect<void, ConnectError>
    /**
     * Observe the retained terminal outcome without starting or owning the connection.
     * Transient recovery keeps the Effect pending, and late observers receive the retained outcome.
     * Interrupting this wait releases only its observation, not the client or other waiters.
     * Closing the client's owning scope still shuts down the connection.
     * After all assigned shards are ready, a permanent required-shard failure in a multi-shard plan closes the client and is retained as `ShardConnectionError { shardId, failure }`.
     * Background and cleanup defects remain in the native Cause alongside a retained typed failure
     *
     * @returns Success after normal shutdown or the retained permanent connection failure.
     * Unexpected background and cleanup defects retain their native cause
     */
    waitForClose(): Effect.Effect<void, ConnectionFailure>
    /**
     * Permanently stop startup and recovery and await owned-resource cleanup.
     * This lazy Effect is uninterruptible once shutdown starts, so callers cannot abandon cleanup.
     * Release cached references and expiry timers, interrupt the cache reporter and await its finalizers.
     * Interrupt message/reaction collector callbacks and await their finalizers. Uninterruptible work can delay shutdown.
     * Uninterruptible reporter work can delay closure.
     * Inside an owned event handler, collector callback or cache reporter, the client scope performs shutdown and interrupts that invocation.
     * Such an invocation does not resume after shutdown. This avoids waiting on its own cleanup.
     * Repeated and concurrent calls observe the same shutdown outcome.
     * Explicit shutdown makes pending connect fail with ClientClosedError rather than interruption
     *
     * Established sockets get up to 5,000 ms for graceful closure, then termination and an awaited close event.
     * Pending handshakes terminate immediately, and forced termination may discard unsent data.
     * Credentials are released, the client cannot restart, and the consumer process is not terminated
     *
     * @returns An Effect without expected failures, while cleanup defects remain native defects
     */
    shutdown(): Effect.Effect<void>
    /**
     * Stream the current state first, then retain only the newest pending update.
     * Subscription setup and its initial snapshot are coordinated, with bounded buffering per subscriber.
     * Slow consumers may miss intermediate states, and Closed ends the stream
     *
     * The stream's scope releases its subscription without stopping the client.
     * The client's owning scope remains responsible for connection cleanup.
     * Use waitForClose rather than this status stream to observe terminal failure
     */
    observeState(): Stream.Stream<ConnectionState>
}

/**
 * Create a webhook-only client for hosted Fluxer, from { id, token } or redacted creation credentials.
 * Validate locally without requests, copying the credential into an independently owned redacted reference.
 * Creation is lazy and scope closure shuts down the client.
 * No token storage, gateway or bot authentication. Keep one client per credential for shared admission and rate waits.
 * Invalid configuration fails with ConfigurationError, while defects retain their native cause
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
        return Object.freeze({
            id: owner.id,
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

/** Process-local outgoing bot presence and explicitly selected inbound member-presence intent.
 * Outgoing status updates fan out to every live locally owned shard and are spaced by at least four seconds per shard. Member selections are separate bounded Op14 requests.
 * No provider acknowledgement or recipient-delivery guarantee is available. The SDK performs no remote membership lookup or self filtering; Fluxer owns access and filtering
 */
export interface Presence {
    /** Lazily validate and freeze the latest requested status/custom status, including before connect.
     * Omitted customStatus preserves this client's previous request; null clears it, and expired custom statuses are not restored.
     * Success means local acceptance and scheduled per-shard fanout, not an atomic provider acknowledgement across shards. Shutdown releases the intent and pending timer
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
     * Lazily validate, copy and retain this guild's selected member IDs when run. Pass `[]` to clear its selection.
     * The SDK neither fetches members nor subscribes all guild members. Select accessible non-self members deliberately; Fluxer remains authoritative for access and filtering
     *
     * The guild must route to a shard assigned to this client. An unassigned guild fails PresenceError input instead of retaining an unsent selection
     *
     * Input accepts at most 1,000 distinct decimal IDs, but the full UTF-8 Op14 frame must be at most 4,096 bytes, so long IDs lower the effective per-guild maximum.
     * This client retains selections for at most 100 guilds and 10,000 IDs. A cleared selection that was already sent retains one bounded session slot until a fresh identify or a confirmed leave, because a local socket write has no provider acknowledgement. Clearing an unsent selection releases its slot immediately
     *
     * After READY or RESUMED, the latest selection or clear is coalesced and attempted at most once per 125 ms. Calling setMembers with the same list deliberately requests a caller-controlled refresh; matching guild creation also reattempts the latest selection or a previously sent clear. This neither establishes that Fluxer applied it nor that `on("presenceUpdate")` will deliver anything.
     * A subscription can yield an initial visible state or later transitions; recovery gaps can miss both. Presence is never cached or looked up.
     * Loss of shared channel visibility can drop provider subscriptions; resend the set after access returns
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

/** Authenticated current-bot application read through GET `/oauth2/applications/@me`, independent of gateway readiness.
 * Effects are lazy and repeatable in the caller context with the shared 30-second total deadline and at most two transient read retries.
 * Returns a frozen no-cache allowlist only. Owner identity, redirect URIs, verification keys, client secrets, and nested bot fields are never exposed.
 * Fluxer remains authoritative for application visibility and installability; this read neither manages an application nor opens an authorization page.
 * Input, HTTP, and malformed-response failures use BotApplicationOperationError; closure uses ClientClosedError; interruption and defects remain in the native cause
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
    /** Lazily fetch this token's frozen application allowlist remotely, without cache writes, gateway events, owner lookup, or hidden follow-up requests */
    fetchCurrent(
        options?: BotApplicationOperationOptions,
    ): Effect.Effect<BotApplication, BotApplicationOperationFailure>
}

/** Lazy Effect operations with shared 30-second default deadlines and bounded read retries.
 * Writes retry only confirmed rate-limit rejection, never an unknown outcome. No gateway connection is required.
 * Interruptions remain in the Effect cause and defects die
 */
export interface Users {
    /** Local optional-cache lookup by decimal ID, without a request. May miss or be stale; closed clients fail */
    get(id: string): Effect.Effect<User | undefined, UserOperationFailure>
    /** Fetch a public account snapshot remotely by decimal ID; unknown IDs fail with notFound */
    fetch(id: string, options?: UserOperationOptions): Effect.Effect<User, UserOperationFailure>
    /** Lazily fetch one frozen privacy-filtered profile by decimal user ID, optionally in an explicit guild context.
     * Each execution issues a separate read, without gateway readiness, hidden hydration or account/profile cache effects.
     * Returns allowlisted account identity and profile fields. isLimited reports Fluxer's privacy restriction, not missing membership.
     * A null guildProfile means no contextual profile was supplied, not proof that the account is outside the guild.
     * Uses Users' shared deadline and bounded read retries. Fluxer may clear expired premium state while serving this GET.
     * Invalid IDs/query, denied access and malformed responses fail with UserOperationError operation users.fetchProfile.
     * Closing/Closed fail with ClientClosedError. Interruption awaits cleanup; defects and interruption retain native causes
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
    /** Fetch the authenticated bot remotely, stripping private account fields */
    fetchSelf(options?: UserOperationOptions): Effect.Effect<User, UserOperationFailure>
}

/** Lazy Effect operations with shared 30-second default deadlines and bounded read retries.
 * Writes retry only confirmed rate-limit rejection, never an unknown outcome. No gateway connection is required.
 * Interruptions remain in the Effect cause and defects die
 */
export interface DirectMessages {
    /** Open/reopen a DM and send using one total deadline, with mentions disabled by default and files snapshotted before opening.
     * MessageError(notSent) does not mean opening was undone. Unknown sends are never repeated automatically.
     * No reply reference is accepted here; use messages.reply after obtaining a channel/message reference
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
    send(userId: string, input: ReplyInput, options?: SendOptions): Effect.Effect<Message, SendError>
    /** Local optional-cache lookup by decimal ID, without a request. May miss or be stale; closed clients fail */
    get(id: string): Effect.Effect<DirectMessageChannel | undefined, UserOperationFailure>
    /** Open or reopen a one-to-one conversation. Privacy checks may prevent delivery even after opening succeeds */
    open(userId: string, options?: UserOperationOptions): Effect.Effect<DirectMessageChannel, UserOperationFailure>
    /** Fetch a private channel remotely. Guild channels are rejected as invalid responses */
    fetch(id: string, options?: UserOperationOptions): Effect.Effect<DirectMessageChannel, UserOperationFailure>
    /** Read open one-to-one and group conversations remotely, excluding personal notes. This is not an atomic snapshot or a complete message history */
    fetchAll(options?: UserOperationOptions): Effect.Effect<readonly DirectMessageChannel[], UserOperationFailure>
    /** Edit explicit group settings. Fluxer enforces member/owner permissions; failure does not guarantee rollback */
    editGroup(
        id: string,
        input: DirectMessageGroupEdit,
        options?: UserOperationOptions,
    ): Effect.Effect<DirectMessageChannel, UserOperationFailure>
    /** Close a DM for this bot or leave a group. Does not erase another recipient's conversation; owner departure may transfer ownership */
    close(id: string, options?: UserOperationOptions): Effect.Effect<void, UserOperationFailure>
    /** Remove a group recipient as owner, or remove self. Does not request deletion of that user's messages; a last-recipient departure deletes the group */
    removeRecipient(
        id: string,
        userId: string,
        options?: UserOperationOptions,
    ): Effect.Effect<void, UserOperationFailure>
}

/**
 * Create a Disconnected client when this Effect executes, without networking or background activity
 *
 * Validate configuration locally without authenticating the token
 *
 * Hosted Fluxer only; self-hosted instances and custom REST or gateway endpoints are not supported
 *
 * Cache settings are copied and validated here without invoking retention policies or reporters.
 * Unknown cache or message-cache option keys fail validation. Caching is disabled by default.
 * Connection settings default to a 30,000 ms overall startup budget and three total attempts per assigned shard
 *
 * Each execution creates a separate client in the caller's owning scope.
 * Cache reporters capture this creation context, including their required services.
 * Closing that scope permanently shuts down the client and releases its credential reference
 *
 * A sharded plan fixes this client's local IDs for its lifetime. Shard zero receives direct-message gateway traffic, and REST/cache budgets remain client-wide
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
 * Unexpected creation defects retain their native cause
 */
export function createClient<E = never, R = never>(
    options: ClientOptions<E, R>,
): Effect.Effect<Client, ConfigurationError, Scope.Scope | R> {
    return Effect.gen(function* () {
        // One client-owned scope lets shutdown mark Closing before interrupting its worker
        const scope = Scope.makeUnsafe()
        const owner = yield* makeClient(options, scope, true)
        yield* Effect.addFinalizer((exit) => owner.shutdown().pipe(Effect.ensuring(Scope.close(scope, exit))))
        return Object.freeze({
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
                create: (id: string, input: ChannelCreate, options?: ChannelOperationOptions) =>
                    owner.channel("channels.create", () => channelCreate(id, input), options),
                edit: (id: string, input: ChannelEdit, options?: ChannelOperationOptions) =>
                    owner.channel("channels.edit", () => channelEdit(id, input), options),
                delete: (id: string, options?: ChannelOperationOptions) =>
                    owner.channel("channels.delete", () => channelDelete(id), options),
                reorder: (id: string, positions: readonly ChannelPosition[], options?: ChannelOperationOptions) =>
                    owner.channel("channels.reorder", () => channelReorder(id, positions), options),
                setPermissionOverwrite: (id: string, input: PermissionOverwrite, options?: ChannelOperationOptions) =>
                    owner.channel("channels.setPermissionOverwrite", () => permissionSet(id, input), options),
                removePermissionOverwrite: (id: string, targetId: string, options?: ChannelOperationOptions) =>
                    owner.channel("channels.removePermissionOverwrite", () => permissionRemove(id, targetId), options),
            }),
            members: Object.freeze({
                iterateChunks: (guildId: string, query: MemberChunkQuery, options?: MemberChunkOptions) =>
                    memberChunkStream(owner.memberChunks.open(guildId, query, options)),
                setRoles: (target: MemberReference, roleIds: readonly string[], options?: GuildOperationOptions) =>
                    owner.guild("members.setRoles", () => memberRolesSet(target, roleIds), options),
                search: (id: string, query?: MemberSearchQuery, options?: GuildOperationOptions) =>
                    searchMembers(owner, id, query, options),
                iterateSearch: (
                    id: string,
                    filters: Omit<MemberSearchQuery, "limit">,
                    limits: MemberSearchIterationLimits,
                    options?: GuildOperationOptions,
                ) => paginationStream(searchMemberPagination(owner, id, filters, limits, options)),
                editSelf: (guildId: string, input: MemberProfileEdit, options?: GuildOperationOptions) =>
                    owner.guild("members.editSelf", () => memberEditSelf(guildId, input), options),
                setNickname: (target: MemberReference, nickname: string | null, options?: GuildOperationOptions) =>
                    owner.guild("members.setNickname", () => memberNicknameEdit(target, nickname), options),
                timeout: (target: MemberReference, durationMs: number, options?: ModerationOptions) =>
                    owner.guild("members.timeout", () => memberTimeout(target, durationMs, options), options),
                clearTimeout: (target: MemberReference, options?: ModerationOptions) =>
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
                addRole: (target: MemberReference, id: string, options?: GuildOperationOptions) =>
                    owner.guild("members.addRole", () => memberRole(target, id, true), options),
                removeRole: (target: MemberReference, id: string, options?: GuildOperationOptions) =>
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
                    options?: GuildOperationOptions,
                ) => owner.guild("roles.setHoistPositions", () => roleSetHoistPositions(id, positions), options),
                resetHoistPositions: (id: string, options?: GuildOperationOptions) =>
                    owner.guild("roles.resetHoistPositions", () => roleResetHoistPositions(id), options),
                get: (target: RoleReference) => owner.getResource("roles", target),
                fetchAll: (id: string, options?: GuildOperationOptions) =>
                    owner.guild("roles.fetchAll", () => roleList(id), options),
                create: (id: string, input: RoleCreate, options?: GuildOperationOptions) =>
                    owner.guild("roles.create", () => roleCreate(id, input), options),
                edit: (target: RoleReference, input: RoleEdit, options?: GuildOperationOptions) =>
                    owner.guild("roles.edit", () => roleEdit(target, input), options),
                delete: (target: RoleReference, options?: GuildOperationOptions) =>
                    owner.guild("roles.delete", () => roleDelete(target), options),
                reorder: (id: string, positions: readonly RolePosition[], options?: GuildOperationOptions) =>
                    owner.guild("roles.reorder", () => roleReorder(id, positions), options),
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
                    filters: Omit<MessageSearchQuery, "limit" | "page" | "cursor">,
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
                collect: <E = never, R = never>(channelId: string, options?: CollectorOptions<E, R>) =>
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
                    Effect.suspend(() => {
                        const data = replyInput(target, input)
                        return data instanceof MessageError
                            ? Effect.fail(data)
                            : owner.send(target.channelId, data, options)
                    }),
                fetch: (target: MessageReference, options?: MessageOperationOptions) => owner.fetch(target, options),
                fetchHistory: (channelId: string, query?: MessageHistoryQuery, options?: MessageOperationOptions) =>
                    owner.fetchHistory(channelId, query, options),
                previewCleanup: (
                    channelId: string,
                    selection: MessageCleanupSelection,
                    options?: MessageOperationOptions,
                ) => previewCleanup(owner, channelId, selection, options),
                cleanup: (plan: MessageCleanupPlan, options?: MessageCleanupOptions) => cleanup(owner, plan, options),
                edit: (target: MessageReference, input: EditMessageInput, options?: MessageOperationOptions) =>
                    owner.edit(target, input, options),
                delete: (target: MessageReference, options?: MessageOperationOptions) => owner.delete(target, options),
                deleteAttachment: (target: MessageReference, attachmentId: string, options?: MessageOperationOptions) =>
                    owner.deleteAttachment(target, attachmentId, options),
                deleteMany: (channelId: string, ids: readonly string[], options?: MessageOperationOptions) =>
                    owner.deleteMany(channelId, ids, options),
            }),
            on: <E, R, E2 = never, R2 = never, K extends EventName = "messageCreate">(
                event: K,
                handler: (message: EventMap[K]) => Effect.Effect<unknown, E, R>,
                options?: EventHandlerOptions<E2, R2>,
            ) =>
                Effect.gen(function* () {
                    const callerScope = yield* Effect.scope
                    const source = yield* owner.events.on(event, handler, options, options?.onError, callerScope)
                    return nativeSubscription(source)
                }),
            events: <K extends EventName>(event: K, options?: EventBufferOptions) =>
                owner.events.stream(event, options),
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

function nativeCollector(source: MessageCollector): Collector {
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
