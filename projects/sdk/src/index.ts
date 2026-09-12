import type { PermissionInput, PermissionTarget } from "./permissions.js"
import { operationSignalError } from "#sdk/internal/operation-signal"
import {
    MemberChunkError,
    type MemberChunk,
    type MemberChunkQuery,
    type MemberChunkFailure,
    type DefaultMemberChunkOptions,
} from "./member-chunks.js"
import { memberChunkIterationOptions } from "#sdk/internal/member-chunks"
import type { AttachmentDownloadSource } from "#sdk/internal/rest"
export { MemberChunkError } from "./member-chunks.js"
export type {
    MemberChunk,
    MemberChunkQuery,
    MemberChunkFailure,
    MemberChunkOptions,
    DefaultMemberChunkOptions,
} from "./member-chunks.js"
import {
    CountOperationError,
    type CountOperationFailure,
    type DefaultCountOperationOptions,
    type GuildCountsResult,
    type ChannelMemberCountsResult,
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
export { AssetFormats, AssetUrlError } from "./assets.js"
export type { AssetFormat, AssetUrlOptions, StickerAssetUrlOptions } from "./assets.js"
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
export type { PermissionInput, PermissionTarget } from "./permissions.js"
export { canManageHierarchy, compareHierarchy, isAboveInHierarchy } from "./role-hierarchy.js"
export type { RoleHierarchyInput } from "./role-hierarchy.js"
import { calculatePermissions, fetchPermissions } from "#sdk/internal/permissions"
import { fetchHierarchyCheck } from "#sdk/internal/role-hierarchy-workflow"

function oauthOwnerOptions(options: DefaultOAuthOperationOptions | undefined) {
    if (typeof options !== "object" || options === null || !("signal" in options)) return options
    const { signal: _signal, ...ownerOptions } = options
    return ownerOptions
}

/**
 * Pure Fluxer markup helpers with no client, network, cache, or notification-state ownership.
 * Fallible helpers return `Result`; `escapeMarkdown` returns text directly. Mention markup does not enable notifications
 */
export const format: typeof sharedFormat = sharedFormat

/** Pure decimal-string snowflake helpers. Fallible conversions return `Result` and never pass IDs through Number */
export const snowflakes: typeof sharedSnowflakes = sharedSnowflakes

/** Pure user/member display-name fallback with no remote or cache lookup */
export const display: typeof sharedDisplay = sharedDisplay

/** Pure raw-permission composition, membership, missing-name inspection and decimal serialization, not an authorization decision */
export const permissionBits: typeof sharedPermissionBits = sharedPermissionBits

/** Pure validated numeric RGB, six-digit hex and RGB-tuple conversions. Fallible calls return Result without coercion or network work */
export const colors: typeof sharedColors = sharedColors

/**
 * Pure lossless splitting into bounded UTF-16 pieces. Results are frozen. Sending and Markdown handling remain explicit
 *
 * @example
 * ```ts
 * import { permissionBits, colors, text } from "@neontechspace/fluxerly"
 *
 * export function pureHelpersExample(bits: bigint, content: string) {
 *     return {
 *         required: permissionBits.from(["ManageRoles", "ManageMessages"]),
 *         missing: permissionBits.missing(bits, ["ManageRoles", "ManageMessages"]),
 *         inspection: permissionBits.inspect(bits),
 *         color: colors.parse("#ff8800"),
 *         chunks: text.split(content, { maxLength: 2_000 }),
 *     }
 * }
 * ```
 */
export const text: typeof sharedText = sharedText

/** Pure hosted Fluxer guild-channel, direct-message, message, and bot-installation link helpers. Fallible route validation returns `Result` */
export const links: typeof sharedLinks = sharedLinks

/** Pure hosted Fluxer avatar, member, guild, emoji, and sticker URL helpers. Fallible calls return `Result` without a client, network, cache, or arbitrary origin */
export const assets: typeof sharedAssets = sharedAssets
import {
    BotApplicationOperationError,
    type BotApplication,
    type BotApplicationOperationFailure,
    type DefaultBotApplicationOperationOptions,
} from "./application.js"
export { BotApplicationOperationError }
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
    DefaultMessageSearchOptions,
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
    DefaultMessageSearchOptions,
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
    DefaultExpressionDeleteOptions,
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

import { PresenceError, type PresenceInput, type PresenceFailure } from "./presence.js"
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
import {
    UserOperationError,
    type User,
    type UserProfile,
    type UserProfileQuery,
    type DirectMessageChannel,
    type DirectMessageGroupEdit,
    type DirectMessageLatestMessages,
    type UserOperationFailure,
    type DefaultUserOperationOptions,
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
    type WebhookOperationError,
    type Webhook,
    type CreatedWebhook,
    type WebhookCreate,
    type WebhookEdit,
    type WebhookTokenEdit,
    type WebhookMessageInput,
    type WebhookMessageEdit,
    type WebhookClientOptions,
    type WebhookOperationFailure,
    type DefaultWebhookOperationOptions,
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
import { Cause, Deferred, Effect, Exit, Scope } from "effect"
import {
    PaginationError,
    type HistoryIterationQuery,
    type UserIterationQuery,
    type PinIterationQuery,
    type PaginationOperation,
} from "./pagination.js"
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
    iterationOptions,
    type Pagination,
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
export { AttachmentDownloadError } from "./attachments.js"
import { AttachmentDownloadError } from "./attachments.js"
export type {
    Attachment,
    AttachmentBytesInput,
    AttachmentDownloadFailure,
    AttachmentDownloadOptions,
    AttachmentFileInput,
    AttachmentFileSource,
    AttachmentInput,
    AttachmentReference,
    AttachmentStreamInput,
    AttachmentStreamReadResult,
    AttachmentStreamReader,
    AttachmentStreamReaderOptions,
    AttachmentStreamSource,
    DefaultAttachmentDownloadOptions,
    DefaultAttachmentStreamOptions,
} from "./attachments.js"
import type {
    Attachment,
    AttachmentDownloadFailure,
    DefaultAttachmentDownloadOptions,
    DefaultAttachmentStreamOptions,
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
import { err, ok, ResultAsync, type Result } from "neverthrow"
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
    type DefaultOAuthOperationOptions,
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
    DefaultOAuthOperationOptions,
} from "./oauth.js"
export { builders, EmbedBuilder, MessageBuilder } from "./builders.js"
export type {
    CommandArgumentSchema,
    CommandArgumentMetadata,
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
    PrefixCommandMetadata,
    PrefixCommandParse,
    PrefixCommandParseInput,
    PrefixCommandPrefix,
    PrefixCommandRejection,
    PrefixCommandUnmatched,
    PrefixCommandsOptions,
} from "./commands.js"
export type {
    DefaultCooldownStore,
    MemoryCooldownStore,
    DefaultPrefixCommand,
    DefaultPrefixCommandContext,
    DefaultPrefixCommandExecutionContext,
    DefaultPrefixCommandCooldown,
    DefaultPrefixCommandUnmatchedContext,
    DefaultPrefixCommandsOptions,
    DefaultPrefixCommandRouter,
} from "./default-commands.js"
import { defaultCommands } from "./default-commands.js"
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
    DefaultSupervisor,
    DefaultSupervisorChildContext,
    DefaultSupervisorChildOptions,
    DefaultSupervisorTools,
} from "./default-supervisor.js"
import { makeDefaultSupervisor } from "./default-supervisor.js"

/**
 * Optional builders and prefix-command routing above direct client primitives.
 * Builders return independent plain payload snapshots. Command routing remains inactive until attach and reuses one existing bounded messageCreate subscription without connecting the client.
 * Guards, cooldown keys, unmatched feedback and handlers remain application-owned. The router does not fetch permissions, send replies or retry failures
 *
 * @example
 * ```ts
 * import { builders, commands, type Client } from "@neontechspace/fluxerly"
 *
 * export function installPing(client: Client) {
 *     const created = commands.create({
 *         prefix: "!",
 *         parse: commands.parseQuoted,
 *         onUnmatched: async ({ client, message }, unmatched) => {
 *             if (unmatched._tag !== "CommandUnknownName") return
 *             const sent = await client.messages.reply(message, builders.message().content(`Unknown command: ${unmatched.name}`).build())
 *             if (sent.isErr()) throw sent.error
 *         },
 *     })
 *     if (created.isErr()) return created
 *     const router = created.value
 *     const registered = router.register({
 *         name: "ping",
 *         execute: async ({ client, message }) => {
 *             const sent = await client.messages.reply(message, builders.message().content("Pong").build())
 *             if (sent.isErr()) throw sent.error
 *         },
 *     })
 *     return registered.isErr() ? registered : registered.value.attach(client)
 * }
 * ```
 * Argument schemas are opt-in. Guards see raw input first, conversion failures call onReject without consuming a cooldown, and execute receives inferred frozen values alongside unchanged args
 *
 * @example
 * ```ts
 * import { commands, type Client } from "@neontechspace/fluxerly"
 *
 * export function typedCommandExample(client: Client) {
 *     const created = commands.create({ prefix: "!", parse: commands.parseQuoted })
 *     if (created.isErr()) return created
 *     const registered = created.value.register({
 *         name: "repeat",
 *         arguments: {
 *             count: { type: "integer" },
 *             mode: { type: "choice", choices: ["fast", "slow"] },
 *             note: { type: "text", optional: true, rest: true },
 *         },
 *         onReject: async ({ client, message }, rejection) => {
 *             if (rejection._tag !== "CommandArgumentRejected") return
 *             const sent = await client.messages.reply(message, {
 *                 content: `Argument ${rejection.argument}: ${rejection.reason}`, allowedMentions: {},
 *             })
 *             if (sent.isErr()) throw sent.error
 *         },
 *         execute: async ({ client, message, values }) => {
 *             const sent = await client.messages.reply(message, {
 *                 content: `${values.count} / ${values.mode} / ${values.note ?? "No note"}`, allowedMentions: {},
 *             })
 *             if (sent.isErr()) throw sent.error
 *         },
 *     })
 *     return registered.isErr() ? registered : registered.value.attach(client)
 * }
 * ```
 *
 * @example
 * ```ts
 * import { type Client, type DefaultPrefixCommandRouter } from "@neontechspace/fluxerly"
 *
 * export async function commandHelpExample(client: Client, router: DefaultPrefixCommandRouter, channelId: string) {
 *     const pages = router.help({ prefix: "!", maxLength: 1_000, include: (command) => command.name !== "admin" })
 *     if (pages.isErr()) return pages
 *     // Visibility is not authorization. Each command still needs its own policy
 *     for (const content of pages.value) {
 *         const sent = await client.messages.send(channelId, { content, allowedMentions: {} })
 *         if (sent.isErr()) return sent
 *     }
 *     // Earlier pages remain sent if a later send fails. This example never retries
 * }
 * ```
 */
export const commands = defaultCommands

/**
 * Optional local Node process supervision above independently usable clients.
 * create snapshots fixed non-overlapping local shard assignments without starting work. start starts the configured children once and waits for their assignment and configuration acknowledgements, not gateway READY. waitForReady observes a later all-child READY state without starting or owning the supervisor. waitForClose observes the terminal local lifetime after every owned child exits. status returns a frozen safe snapshot, including each child’s last received current-generation gateway state, not atomic cross-process health
 *
 * Each child module must call supervisor.child.run. That helper receives the parent assignment and a cooperative stop signal, creates and runs its client, and obtains a parent permit immediately before every fresh gateway Identify. Resumes bypass the permit. A parent stop returns without waiting for an uncooperative default configure promise and never starts the client after that stop
 *
 * One parent permit remains outstanding until the child confirms its synchronous Identify send or cancels before sending. The parent then spaces fresh sends by at least one second. A stalled child is stopped and must exit before another permit, after a full interval
 *
 * It does not discover shard counts, coordinate another process or host, preserve sessions across replacement, or manage distributed REST limits. The helper installs no signal handlers or process termination. After its graceful deadline, the parent may terminate only its own unresponsive child and still waits for its exit
 *
 * restart is opt-in, with bounded exponential replacement when supplied. childEnvironment, args and execArgv select the owned child process but never appear in status or failures. stdout and stderr are ignored and never retained
 *
 * @example
 * ```ts
 * import { supervisor } from "@neontechspace/fluxerly"
 *
 * export const workers = supervisor.create({
 *     entry: "/srv/bot-worker.js",
 *     totalShards: 2,
 *     assignments: [
 *         { id: "one", shardIds: [0] },
 *         { id: "two", shardIds: [1] },
 *     ],
 * })
 * ```
 */
export const supervisor = makeDefaultSupervisor(createClient)
export type { LoggingOptions, DefaultLoggingOptions, DefaultLogger } from "./logging.js"
export type { CachePolicyErrorReport, MessageCacheSettings, MessageCacheOptions } from "./cache.js"
export type { ResourceCacheSettings } from "./cache.js"
import type {
    CacheEntriesOptions,
    CachedResources,
    CacheKind,
    ClientDiagnostics,
    ClientState,
    ClientOptions,
    ConnectionState,
    OperationOptions,
} from "./client.js"
import type { InstanceResolveError, InstanceResolveOptions, ResolvedInstance } from "./instance.js"
import type {
    PermissionOverwrite,
    GuildChannel,
    ChannelCreate,
    ChannelEdit,
    ChannelPosition,
    ChannelOperationError,
    ChannelOperationFailure,
    DefaultChannelOperationOptions,
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
    DefaultChannelOperationOptions,
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
import {
    GuildOperationError,
    type Guild,
    type GuildRole,
    type RoleReference,
    type RolePosition,
    type RoleHoistPosition,
    type RoleCreate,
    type RoleEdit,
    type GuildMember,
    type MemberReference,
    type VoiceConnectionReference,
    type MemberQuery,
    type GuildOperationFailure,
    type DefaultGuildOperationOptions,
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
    DefaultGuildOperationOptions,
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
import type { BanInput, GuildBan, DefaultModerationOptions } from "./guilds.js"
export type { BanInput, GuildBan, ModerationOptions, DefaultModerationOptions } from "./guilds.js"
import {
    CancelledError,
    ConfigurationError,
    SdkDefect,
    type ConnectError,
    type ConnectionFailure,
    type DefectReason,
    type Operation,
} from "./errors.js"
import { makeClient } from "#sdk/internal/client"
import type { MessagePinsQuery, MessagePinsPage } from "./pins.js"
export type { MessagePinsQuery, MessagePinsPage, MessagePin, ChannelPinsUpdate } from "./pins.js"
import { collect, type MessageCollector } from "#sdk/internal/collector"
import { collectReactions } from "#sdk/internal/reaction-collector"
import type { DefaultReactionCollectorOptions, ReactionCollectorResult } from "./collectors.js"
export type {
    ReactionCollectorOptions,
    DefaultReactionCollectorOptions,
    ReactionCollectorResult,
} from "./collectors.js"
import {
    CollectorError,
    type CollectorFailure,
    type CollectorRegistrationError,
    type CollectorResult,
    type DefaultCollectorOptions,
} from "./collectors.js"
export { CollectorError } from "./collectors.js"
export type {
    CollectorOptions,
    DefaultCollectorOptions,
    CollectorResult,
    CollectorFailure,
    CollectorRegistrationError,
} from "./collectors.js"
import { replyInput } from "#sdk/internal/message"
import type { EventSource } from "#sdk/internal/events"
import { waitForEvent } from "#sdk/internal/events"
import {
    MessageError,
    MessageOperationError,
    type MessageOperationFailure,
    type EventOverflowError,
    type EventReadError,
    type RegistrationError,
    type SendError,
} from "./message-errors.js"
import {
    MessageCleanupError,
    type MessageCleanupFailure,
    type MessageCleanupPlan,
    type MessageCleanupReport,
    type MessageCleanupSelection,
    type DefaultMessageCleanupOptions,
} from "./message-cleanup.js"
import { cleanup, previewCleanup } from "#sdk/internal/message-cleanup"
import type {
    EditMessageInput,
    ForwardMessageInput,
    MessageHistoryQuery,
    Message,
    MessageReference,
    MessageInput,
    ReplyInput,
    DefaultMessageOperationOptions,
    DefaultSendOptions,
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
import { InputValidationFailure, inputValidationFailure } from "./input-validation.js"
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
    MessageNonce,
    ReplyInput,
    AllowedMentions,
    SendOptions,
    DefaultSendOptions,
    EditMessageInput,
    MessageOperationOptions,
    DefaultMessageOperationOptions,
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

/** Subscription-local controls. Closing a subscription does not close the client */
export interface Subscription {
    /** Stop new deliveries, discard pending events and signal active callbacks. Cannot forcibly stop application promises */
    unsubscribe(): void
    /**
     * Observe retained closure or overflow after SDK cleanup, not completion of arbitrary application promises.
     * Cancelling this wait affects only the wait. Late observers retain the same outcome.
     * Unexpected cleanup defects reject with SdkDefect
     */
    waitForClose(
        options?: OperationOptions,
    ): ResultAsync<void, EventOverflowError | CancelledError | ConfigurationError>
}

/** Live subscription for one event type without subscription history. The default type preserves existing messageCreate annotations */
export interface EventSubscription<K extends EventName = "messageCreate"> extends Subscription {
    /**
     * Read the next payload for this event name, or null after normal closure. Only one pending read is accepted.
     * Concurrent reads return EventReadBusyError. Cancellation releases only this read.
     * Overflow remains a typed failure after the queue is discarded. SDK defects reject with SdkDefect
     */
    next(
        options?: OperationOptions,
    ): ResultAsync<EventMap[K] | null, EventReadError | CancelledError | ConfigurationError>
}

/** Default callback scheduling and optional safe error reporting */
export interface EventHandlerOptions extends HandlerOptions {
    /**
     * Report failures without payloads. Reporter failure produces one safe fallback log, never a retry.
     * At most one custom report is outstanding per registration. Further reports use the default logger while it is busy.
     * Reporter promises remain application-owned and do not delay subscription closure.
     * This hook receives event/kind only, not the original exception or its stack.
     * Inspect application exceptions inside the callback before rethrowing them, as shown on Client.on
     */
    readonly onError?: (report: HandlerErrorReport) => void | Promise<void>
}

/** Bounded remote attachment retrieval without a gateway, cache, proxy URL or credential-bearing request */
export interface Attachments {
    /** Download attachment.url after matching it against this instance's discovered media `/attachments/` base path.
     * maxBytes is required and caps returned bytes at 50 MiB. Packing can briefly retain response chunks beside that result, so it is not a total heap limit. The SDK sends no Authorization header, follows no redirect, caches nothing and never falls back to proxyUrl.
     * timeoutMs defaults to 30,000 across endpoint resolution, local four-slot media admission and GET. Media shares that slot limit but does not wait for bot API rate limits. AbortSignal cancellation awaits response-reader cleanup and cannot undo already received bytes.
     * URL expiry metadata is not an availability check. Failures contain a safe reason/status, including local busy, without a URL or response body
     */
    download(
        attachment: Attachment,
        options: DefaultAttachmentDownloadOptions,
    ): ResultAsync<Uint8Array, AttachmentDownloadFailure | CancelledError | ConfigurationError>
    /** Lazily read attachment.url as one-use chunks after matching this instance's media `/attachments/` base path.
     * The first next starts discovery, shared four-slot media admission and GET. Each later next reads at most one response chunk, with no SDK byte packing, spooling, retry or durable storage
     *
     * maxBytes is required and bounds bytes delivered across this consumption at 50 MiB. A declared Content-Length above it fails before the first chunk, while runtime counting remains authoritative.
     * timeoutMs defaults to 30,000 across opening, consumer pauses and reads. Early loop exit, return, throw, signal cancellation, failures and shutdown cancel the body, await reader cleanup and release the slot.
     * This iterable is single-consumption. Expected failures yield one Err, including safe local busy/network/response/limit/deadline reasons. Defects reject with SdkDefect and retain cleanup defects.
     * Overlapping next calls return a local busy error without starting another read or cancelling the pending pull
     *
     * The GET sends no Authorization header, follows no redirect, caches nothing and never uses proxyUrl. Attachment size and expiry metadata do not establish availability or byte safety
     * @example
     * ```ts
     * import type { Attachment, Client } from "@neontechspace/fluxerly"
     * export async function downloadChunks(client: Client, attachment: Attachment) {
     *     for await (const chunk of client.attachments.stream(attachment, { maxBytes: 1_024 })) {
     *         if (chunk.isErr()) return chunk
     *         void chunk.value
     *     }
     * }
     * ```
     */
    stream(
        attachment: Attachment,
        options: DefaultAttachmentStreamOptions,
    ): AsyncIterable<Result<Uint8Array, AttachmentDownloadFailure | CancelledError | ConfigurationError>>
}

/**
 * Client-owned message operations. REST and local lookup work without a gateway connection.
 * Collection with guildId requires its locally owned shard to be ready; channel-only collection requires aggregate Connected.
 * Remote calls share four active HTTP slots and at most 256 queued requests or 4 MiB of queued JSON bodies, client-wide across locally owned shards.
 * Each remote call defaults to a 30,000 ms total deadline, including admission, retry and rate waits, with cleanup awaited afterward
 *
 * fetch, fetchHistory, fetchReactionUsers and fetchPins retry fetch transport failures and HTTP 500/502/503/504 at most twice.
 * Retry delays are jittered 125–250 ms then 250–500 ms, or a valid longer Retry-After. Retries never reset the deadline.
 * Reads retry the same target/query through the bounded queue, without snapshot isolation. Other rejections and malformed successes never retry.
 * Confirmed 429 retries retain their existing route/global waits and do not consume the two transient-read retries.
 * Mutations retry only confirmed rate-limit rejections, never uncertain writes.
 * Expected failures use Err. SDK/cleanup defects reject remote calls with SdkDefect and throw from synchronous get.
 * Cancellation fails this operation with CancelledError. Client closure fails pending/new operations with ClientClosedError.
 * Neither failure proves that a dispatched mutation was undone
 */

export interface Messages {
    /** Traverse remote history newest-to-oldest, without connecting or prefetching another page.
     * Returns a reusable AsyncIterable, not a started request. Each consumption copies inputs and owns independent progress
     *
     * maxItems is required. pageSize/maxPages follow PaginationQuery. timeoutMs applies separately to each remote page
     *
     * Yields frozen snapshots as Ok values. One expected failure or cancellation is yielded as Err, then iteration ends.
     * PaginationError identifies invalid traversal input, cursorStalled or pageLimit. Remote errors keep fetchHistory's operation.
     * SDK defects reject with SdkDefect, including combined failure/cleanup defects. Already-emitted items are not rolled back
     *
     * break/return releases buffered items. To interrupt an in-flight next call, abort the supplied signal and await it.
     * Closing/Closed fail on the next pull and release buffered snapshots. No listener is retained after completion or early exit
     *
     * Retains one bounded page, not the full result. Enabled message caching follows fetchHistory's normal admission.
     * Stops on an empty remote page or maxItems, not on a short page. Separate pages are not a consistent snapshot
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export async function paginationHistoryExample(client: Client, channelId: string) {
     *     for await (const result of client.messages.iterateHistory(channelId, { maxItems: 500 })) {
     *         if (result.isErr()) return result
     *         if (result.value.content === "stop") break
     *     }
     * }
     * ```
     */
    iterateHistory(
        channelId: string,
        query: HistoryIterationQuery,
        options?: DefaultMessageOperationOptions,
    ): AsyncIterable<Result<Message, MessageOperationFailure | PaginationError | CancelledError | ConfigurationError>>
    /** Search one current-scope indexed page in an explicit guild or channel context, without gateway readiness, cache lookup or cache admission.
     * Starts immediately and completes with a frozen indexing state or frozen result page. Fluxerly always sends scope current.
     * Indexing means Fluxer accepted the request but is not ready; retry is caller-controlled and never happens automatically.
     * Cursor is opaque and only belongs in a later explicit search call. Results and channel context are observations, not a stable snapshot.
     * POST failures, malformed success and invalid input use MessageOperationError operation search. Cancellation uses CancelledError.
     * Search does not use Messages' transient-read retries; confirmed rate limits retain shared REST handling within the supplied deadline
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export async function messageSearchPageExample(client: Client, channelId: string) {
     *     const page = await client.messages.search({ channelId }, { content: "release notes" })
     *     return page.isOk() && !page.value.indexing ? page.value.messages : page
     * }
     * ```
     */
    search(
        context: MessageSearchContext,
        query?: MessageSearchQuery,
        options?: DefaultMessageSearchOptions,
    ): ResultAsync<MessageSearchPage, MessageOperationFailure | CancelledError | ConfigurationError>
    /** Lazily traverse indexed messages from the first contextual page through opaque provider cursors, without polling or prefetching.
     * Each consumption copies inputs and retains one bounded page. maxItems is required; pageSize is 1–25 and maxPages defaults to 100.
     * An indexing page ends traversal with PaginationError indexing so the caller decides whether and when to retry.
     * Opaque cursor progress is checked as opaque text, never as a history snowflake. Indexed hits never hydrate or admit message cache entries.
     * Expected operation, pagination and cancellation failures yield one Err after delivered items. Defects reject with SdkDefect
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export async function messageSearchTraversalExample(client: Client, guildId: string) {
     *     for await (const hit of client.messages.iterateSearch({ guildId }, { content: "todo" }, { maxItems: 100 })) {
     *         if (hit.isErr()) return hit
     *     }
     * }
     * ```
     */
    iterateSearch(
        context: MessageSearchContext,
        filters: Omit<MessageSearchQuery, "limit" | "page" | "cursor">,
        limits: MessageSearchIterationLimits,
        options?: DefaultMessageSearchOptions,
    ): AsyncIterable<Result<Message, MessageOperationFailure | PaginationError | CancelledError | ConfigurationError>>
    /** Traverse ascending remote user IDs for one message and the selected literal Unicode or custom emoji.
     * Uses iterateHistory's lazy Result, cancellation, deadline, failure and release rules, with fetchReactionUsers remote errors.
     * Stops at maxItems or the server's hasMore=false. No reactor cache or automatic member lookup is added.
     * These observations are not a stable voter list. A later removal can invalidate an earlier observation
     * @example
     * ```ts
     * import type { Client, MessageReference } from "@neontechspace/fluxerly"
     * export async function paginationReactionExample(client: Client, message: MessageReference, userId: string) {
     *     for await (const result of client.messages.iterateReactionUsers(message, "👍", { maxItems: 500 })) {
     *         if (result.isErr()) return result
     *         if (result.value.id === userId) return result
     *     }
     *     return undefined
     * }
     * ```
     * An undefined result means not found within the bounded scan, not proof that the user has never reacted
     */
    iterateReactionUsers(
        message: MessageReference,
        emoji: ReactionEmojiInput,
        query: UserIterationQuery,
        options?: DefaultMessageOperationOptions,
    ): AsyncIterable<
        Result<
            import("./reactions.js").ReactionUser,
            MessageOperationFailure | PaginationError | CancelledError | ConfigurationError
        >
    >
    /** Traverse remote pins in descending timestamp order, without populating the message cache.
     * Uses iterateHistory's lazy Result, cancellation, deadline, failure and release rules, with fetchPins remote errors.
     * PinIterationQuery defines per-run deduplication and completeness limits. Retains at most maxItems deduplication IDs.
     * Valid items from a stalled page can be emitted before cursorStalled appears on the next pull.
     * Stop at maxItems or hasMore=false. Timestamp ties can prevent enumerating every pin, even without concurrent edits
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export async function paginationPinsExample(client: Client, channelId: string) {
     *     const ids: string[] = []
     *     for await (const result of client.messages.iteratePins(channelId, { maxItems: 20 })) {
     *         if (result.isErr()) return result
     *         ids.push(result.value.message.id)
     *     }
     *     return ids
     * }
     * ```
     */
    iteratePins(
        channelId: string,
        query: PinIterationQuery,
        options?: DefaultMessageOperationOptions,
    ): AsyncIterable<
        Result<
            import("./pins.js").MessagePin,
            MessageOperationFailure | PaginationError | CancelledError | ConfigurationError
        >
    >
    /**
     * Pin one message identified by decimal id and channelId, without requiring gateway readiness.
     * Starts immediately. AbortSignal cancellation returns CancelledError and unexpected defects reject with SdkDefect.
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
     * import type { Client, MessageReference } from "@neontechspace/fluxerly"
     *
     * export async function pinsExample(client: Client, message: MessageReference) {
     *     const pinned = await client.messages.pin(message)
     *     if (pinned.isErr()) throw pinned.error
     *     const page = await client.messages.fetchPins(message.channelId, { limit: 25 })
     *     if (page.isErr()) throw page.error
     *     const unpinned = await client.messages.unpin(message)
     *     if (unpinned.isErr()) throw unpinned.error
     *     return page.value
     * }
     * ```
     * The caller owns error recovery and client lifetime. These calls are not an atomic transaction
     */
    pin(
        message: MessageReference,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Unpin one explicit message using pin's admission, deadline, retry, cancellation and cache-invalidation rules.
     * Starts immediately. AbortSignal cancellation returns CancelledError and unexpected defects reject with SdkDefect.
     * Complete on HTTP 204, including an already-unpinned message. Expected failures identify operation unpin.
     * Fluxer enforces the same permissions as pin. Closing/Closed clients fail with ClientClosedError.
     * Unpinning does not delete the message or the system message created by pinning, and does not reset the last-pin timestamp.
     * No gateway readiness, automatic rollback, event synthesis or confirmation fetch
     */
    unpin(
        message: MessageReference,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch one frozen pin page for a decimal channel ID, without gateway readiness, cache reads or cache population.
     * Starts immediately. AbortSignal cancellation returns CancelledError and unexpected defects reject with SdkDefect
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
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<MessagePinsPage, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Remove one named user's reaction, leaving other users and emoji groups untouched.
     * userId is a required decimal ID; naming the bot removes its own reaction.
     * Uses addReaction's emoji inputs, REST admission, 30,000 ms default deadline, retry and cancellation rules.
     * No gateway readiness is required. Complete on HTTP 204, without waiting for or synthesizing events.
     * Fluxer enforces visibility and history access; for another user, the bot must author the message or have MANAGE_MESSAGES in its guild
     *
     * Expected failures use MessageOperationError with operation removeUserReaction, or ClientClosedError.
     * Calls start immediately; AbortSignal cancellation returns CancelledError and defects reject with SdkDefect.
     * Cleanup is awaited, but cannot undo a dispatched deletion. Only confirmed 429 rejections retry.
     * Success means absent or removed, not proof the reaction existed. Unknown outcomes are not replayed.
     * No cache mutation, automatic restoration or per-user state is retained; the bot cannot restore another user's reaction as them
     * @example
     * ```ts
     * import type { Client, MessageReference } from "@neontechspace/fluxerly"
     * export async function reactionModerationExample(client: Client, message: MessageReference, userId: string) {
     *     const removed = await client.messages.removeUserReaction(message, "👍", userId)
     *     if (removed.isErr()) return removed
     *     const cleared = await client.messages.clearReaction(message, "👍")
     *     if (cleared.isErr()) return cleared
     *     return client.messages.clearReactions(message)
     * }
     * ```
     */
    removeUserReaction(
        message: MessageReference,
        emoji: ReactionEmojiInput,
        userId: string,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
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
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Delete every user's reactions for every emoji on this message, without deleting the message.
     * Uses clearReaction's execution, permission, deadline, failure and cleanup rules, with operation clearReactions.
     * Takes no emoji selector. Complete on HTTP 204, whether reactions were present or absent.
     * Fluxer emits one clear-all event, not per-emoji or per-user events; the SDK does not synthesize or await it.
     * Destructive: Other users' reactions cannot be restored by the bot as those users
     */
    clearReactions(
        message: MessageReference,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
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
     * Calls start immediately; AbortSignal cancellation awaits owned request cleanup and returns CancelledError. Unexpected defects reject with SdkDefect
     * @example
     * ```ts
     * import type { Client, MessageReference } from "@neontechspace/fluxerly"
     * export async function reactionUsersExample(client: Client, message: MessageReference) {
     *     const result = await client.messages.fetchReactionUsers(message, "👍", { limit: 25 })
     *     if (result.isErr() || result.value.nextAfter === null) return result
     *     return client.messages.fetchReactionUsers(message, "👍", { after: result.value.nextAfter })
     * }
     * ```
     */
    fetchReactionUsers(
        message: MessageReference,
        emoji: ReactionEmojiInput,
        query?: ReactionUsersQuery,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<ReactionUsersPage, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Add the bot's own reaction and complete after HTTP 204, without waiting for or synthesizing a gateway event.
     * Accept literal Unicode or a custom { name, id }; Fluxer owns emoji availability and permission checks
     *
     * No gateway readiness is required. Use the shared 30,000 ms deadline by default; timeoutMs overrides it.
     * Share bounded REST admission and global rate limits, with a channel reaction bucket separate from message operations.
     * Only confirmed rate-limit rejections retry within the original deadline; uncertain outcomes are never retried
     *
     * Input, admission, rejection, transport and timeout failures use MessageOperationError; closed clients use ClientClosedError.
     * Calls start immediately. Cancellation awaits owned cleanup but cannot undo a dispatched reaction.
     * Unexpected defects reject with SdkDefect
     *
     * Existing own reactions are idempotent server-side. No local reaction state, counts or reactor lists are retained
     * @example
     * ```ts
     * import type { Client, MessageReference } from "@neontechspace/fluxerly"
     * export async function reactionExample(client: Client, message: MessageReference) {
     *     const added = await client.messages.addReaction(message, "👍")
     *     if (added.isErr()) return added
     *     return client.messages.removeReaction(message, "👍")
     * }
     * ```
     */
    addReaction(
        message: MessageReference,
        emoji: ReactionEmojiInput,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Remove only the bot's own reaction and complete after HTTP 204.
     * Uses addReaction's input, admission, timeout, retry, failure and cancellation rules.
     * Success does not prove the reaction previously existed or that this call removed it.
     * Other users' reactions are untouched. Neither this operation nor gateway reaction events alter the message cache
     */
    removeReaction(
        message: MessageReference,
        emoji: ReactionEmojiInput,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Start a bounded collection of future messageCreate observations in one decimal channel ID.
     * Returns a ready handle synchronously. Register before sending a prompt. No history, cache reads or implicit connection
     *
     * With options.guildId, the caller supplies the owning guild and intake accepts only that locally owned ready shard. Known conflicting event guilds are discarded without a channel lookup.
     * Without guildId, channel-only collection retains conservative aggregate recovery: any gateway gap ends it because its guild scope is unknown
     *
     * Defaults: One accepted message, 30,000 ms total lifetime, 4 MiB retained Message JSON.
     * Pending intake is separately bounded to 256 payloads or 4 MiB source JSON, after channel selection and before filtering.
     * Options are copied at registration. Positive safe integer budgets are required. The timeoutMs maximum is 2,147,483,647.
     * Timeout starts at registration, never resets, and excludes messages processed at or after the deadline
     *
     * Selection is synchronous and counts each accepted ID once. Edits/deletions leave received snapshots unchanged.
     * Filter failure or either byte/queue overflow ends only this collector, without partial messages in the error.
     * Recovery fails collection with CollectorError connectionLost even if the client later resumes. No automatic restart or resend
     *
     * Non-connected registration fails with CollectorError notConnected. Closing/Closed use ClientClosedError.
     * Invalid settings use ConfigurationError. The optional signal controls collection and abort returns CancelledError.
     * An already-aborted signal starts no collection. Unexpected registration defects throw SdkDefect
     *
     * Optional onMessage runs sequentially after filtering, ID deduplication and retained-byte admission.
     * Limit completion waits for the final callback. Timeout/stop may retain a message whose callback was cancelled.
     * Once the accepted count is reached, later messages are ignored while the final callback finishes.
     * Handler failure ends this collector with CollectorError handler. Closure waits for returned callback work.
     * Pending budgets exclude the active message. Callbacks are never retried and their effects are not rolled back
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     *
     * export async function askName(client: Client, channelId: string, userId: string) {
     *     const opened = client.messages.collect(channelId, { filter: message => message.author.id === userId })
     *     if (opened.isErr()) throw opened.error
     *     const collector = opened.value
     *     try {
     *         const sent = await client.messages.send(channelId, { content: "What should I call you?" })
     *         if (sent.isErr()) throw sent.error
     *         const result = await collector.waitForClose()
     *         if (result.isErr()) throw result.error
     *         return result.value
     *     } finally {
     *         collector.stop()
     *     }
     * }
     * ```
     * The caller supplies a connected client and handles empty timeout results and client lifetime separately
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     *
     * export async function messageCollectorProgressExample(client: Client, channelId: string, userId: string) {
     *     const opened = client.messages.collect(channelId, {
     *         filter: message => message.author.id === userId,
     *         maxMessages: 3,
     *         onMessage: async (message, signal) => {
     *             const reply = await client.messages.reply(message, { content: "Received your reply" }, { signal })
     *             if (reply.isErr()) throw reply.error
     *         },
     *     })
     *     if (opened.isErr()) throw opened.error
     *     return await opened.value.waitForClose()
     * }
     * ```
     * The author filter must exclude the bot itself to avoid collecting its acknowledgements
     */
    collect(
        channelId: string,
        options?: DefaultCollectorOptions,
    ): Result<Collector, CollectorRegistrationError | CancelledError | ConfigurationError>
    /**
     * Synchronously register future reaction additions on one message with decimal id and channelId.
     * Register before the expected reaction. No REST request, existing-reactor lookup, implicit connect or cache reads
     *
     * With options.guildId, the caller supplies the target channel's owning guild and intake accepts only that locally owned ready shard. Known conflicting event guilds are discarded without a membership lookup.
     * Without guildId, target-only collection retains conservative aggregate recovery: any gateway gap ends it because its guild scope is unknown
     *
     * Defaults: One accepted addition, 30,000 ms total lifetime and 4 MiB retained MessageReaction JSON.
     * Copy target IDs and options at registration. Pending intake allows 256 payloads or 4 MiB full source JSON.
     * Message selection precedes buffering; synchronous user/emoji filtering follows it
     *
     * Optional emoji uses addReaction's input shape and matches before filter, after queue admission.
     * Unicode requires exact text and no custom ID; custom emoji match by ID, ignoring renames. Invalid selectors use ConfigurationError emoji
     *
     * Single additions and received batches share receive order; batch entries retain their order and count individually.
     * A batch occupies one pending slot. Repeated user/emoji pairs count again. No batching flag is enabled.
     * Removals, clears and message deletion neither undo observations nor stop collection. This is not a vote tally
     *
     * The total deadline never resets and excludes observations processed at or after it, including slow filter returns
     *
     * Filter/overflow failures use CollectorError without partial results. Recovery fails with connectionLost, without restart.
     * Require Connected or return CollectorError notConnected. Closing/Closed use ClientClosedError.
     * Invalid target/options use ConfigurationError. Signal abort returns CancelledError; pre-abort starts no collection.
     * Unexpected registration defects throw SdkDefect. Registration does not verify remote message existence or access.
     * Optional onReaction runs after acceptance and byte admission, sequentially, before the next addition is processed.
     * The final accepted callback must finish before limit completion. Timeout/stop can retain an addition whose callback was cancelled.
     * Pending budgets exclude the active payload, including its unprocessed batch entries. No callback retries or vote reconstruction.
     * Callback failure ends this collector with CollectorError handler. Terminal completion waits for returned callback work
     *
     * @example
     * ```ts
     * import type { Client, MessageReference } from "@neontechspace/fluxerly"
     *
     * export async function reactionCollectorExample(client: Client, message: MessageReference, userId: string) {
     *     let count = 0
     *     const opened = client.messages.collectReactions(message, {
     *         maxReactions: 3,
     *         emoji: "✅",
     *         filter: reaction => reaction.userId === userId,
     *         onReaction: async (_reaction, signal) => {
     *             const edited = await client.messages.edit(message, { content: `Accepted additions: ${++count}` }, { signal })
     *             if (edited.isErr()) throw edited.error
     *         },
     *     })
     *     if (opened.isErr()) throw opened.error
     *     try {
     *         const result = await opened.value.waitForClose()
     *         if (result.isErr()) throw result.error
     *         return result.value
     *     } finally {
     *         opened.value.stop()
     *     }
     * }
     * ```
     * The caller supplies a connected client and an existing message; timeout may return no reactions
     */
    collectReactions(
        message: MessageReference,
        options?: DefaultReactionCollectorOptions,
    ): Result<ReactionCollector, CollectorRegistrationError | CancelledError | ConfigurationError>
    /**
     * Read this client's local retained snapshot synchronously, never making a request.
     * Disabled caching, absent/evicted/expired entries and a mismatched channel return Ok(undefined), not server absence.
     * Hits return frozen observations, not guaranteed current server state, and update LRU recency without renewing age.
     * Invalid references return MessageOperationError with operation get, reason input and outcome notDispatched.
     * Closing/Closed return ClientClosedError. Unexpected synchronous defects throw SdkDefect
     */
    get(message: MessageReference): Result<Message | undefined, MessageOperationFailure>
    /**
     * Send text, embeds, files and/or stickers and return the decoded message after HTTP, not gateway delivery or recipient acknowledgement.
     * Embed images/thumbnails may use attachment://filename for a matching new image upload in this request.
     * Optional flags accept only MessageFlags' non-voice bits; suppressing previews is distinct from omitting embeds
     *
     * File bytes are snapshotted on invocation, up to 50 MiB per file and the separate uploads.maxBytes client budget.
     * Full upload admission fails with busy before copying. No path access or downloads; servers may impose lower limits.
     * Cleanup releases owned bytes; failed uploads may leave temporary server data, with no physical-erasure guarantee
     *
     * Mentions are disabled by default. Total budget defaults to 30,000 ms including admission and rate waits.
     * Enabled caching retains eligible created snapshots without changing send completion or delivery
     *
     * One client admits four active HTTP requests and at most 256 pending bodies or 4 MiB of pending JSON.
     * Confirmed rate-limit rejections may retry within that budget. Uncertain sends never retry automatically
     *
     * Input nonce accepts a 1-32 character string or nonnegative safe integer. Omission creates one SDK nonce per send, while an explicit nonce is retained through confirmed rate-limit retries.
     * Fluxer duplicate suppression is best effort for five minutes after persistence. It is not durable idempotency, exactly-once delivery or a concurrent atomicity guarantee
     *
     * Cancellation after dispatch may leave a created message. There is no rollback or exactly-once guarantee.
     * Expected failures use Err. SDK/cleanup defects reject with SdkDefect
     */
    send(
        channelId: string,
        input: MessageInput,
        options?: DefaultSendOptions,
    ): ResultAsync<Message, SendError | CancelledError | ConfigurationError>
    /** Forward an accessible source message into an explicit destination, without fetching or caching the source.
     * Starts immediately and returns the created message after HTTP, not gateway delivery or recipient acknowledgement
     *
     * Optional media selections belong to the source. Extra content, files, mentions and flags are rejected.
     * The returned messageSnapshots contain frozen copied content, not live views of later source edits.
     * Uses send's shared admission, optional destination-message caching and 30,000 ms default total deadline
     *
     * Fluxer checks source access and destination permissions. Only confirmed rate-limit rejection retries
     *
     * Input nonce follows send's 1-32 character string/nonnegative-safe-integer contract, SDK-generated default and retry preservation. Fluxer's five-minute suppression is best effort, not durable idempotency or exactly-once delivery.
     * Expected failures return Err with MessageError or ClientClosedError; cancellation returns CancelledError after cleanup.
     * A lost response or cancellation after dispatch may leave a created forward. No rollback or exactly-once guarantee.
     * SDK and cleanup defects reject with SdkDefect
     * @example
     * ```ts
     * import type { Client, MessageReference } from "@neontechspace/fluxerly"
     * export function forwardExample(client: Client, destinationId: string, source: MessageReference) {
     *     return client.messages.forward(destinationId, { source })
     * }
     * ```
     */
    forward(
        channelId: string,
        input: ForwardMessageInput,
        options?: DefaultSendOptions,
    ): ResultAsync<Message, SendError | CancelledError | ConfigurationError>
    /**
     * Tell Fluxer that this bot is typing in one decimal channel ID, completing after HTTP 204.
     * No gateway connection, event confirmation, cache entry, presence update or retained local typing state is created.
     * Fluxer may limit delivery to other clients and expires this ephemeral indicator independently.
     * Shares REST admission with other work and uses a dedicated per-channel typing bucket. timeoutMs defaults to 30,000 ms.
     * Confirmed rate-limit rejections retry; cancellation, a lost response or timeout cannot prove Fluxer did not show the notice.
     * Invalid input, admission and HTTP failures return MessageOperationError operation typing. Closing/Closed returns ClientClosedError.
     * Cancellation affects only this request and waits for cleanup. Unexpected defects reject with SdkDefect
     */
    typing(
        channelId: string,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Start one typing request, run task, and refresh typing no sooner than every 8,000 ms until task settles.
     * The first request completes before task starts; an initial typing failure returns Err and never calls task.
     * Later typing or client-close failure stops refreshes but does not claim to cancel application work. It is returned after task settlement.
     * task receives a signal aborted on caller cancellation or helper cleanup. Its promise remains application-owned, so non-cooperative work can delay cancellation.
     * A rejected or thrown task is an unexpected application defect. If it and refresh cleanup fail, SdkDefect retains both safe causes.
     * Client shutdown stops and awaits only helper refresh work, never a detached loop. No cache, presence or gateway state is changed
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export async function typingExample(client: Client, channelId: string) {
     *     return await client.messages.keepTyping(channelId, async signal => {
     *         if (signal.aborted) throw new Error("work cancelled")
     *         return "prepared"
     *     })
     * }
     * ```
     */
    keepTyping<A>(
        channelId: string,
        task: (signal: NonNullable<OperationOptions["signal"]>) => PromiseLike<A>,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<A, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Reference an existing message through send. Missing targets fail rather than falling back to an unreferenced send.
     * Input nonce follows send's caller correlation and retry contract. A lost response remains unknown and the SDK does not replay it.
     * The returned reply is eligible for the same cache intake as send.
     * File inputs use send's snapshot, size, budget and cleanup rules
     */
    reply(
        message: MessageReference,
        input: ReplyInput,
        options?: DefaultSendOptions,
    ): ResultAsync<Message, SendError | CancelledError | ConfigurationError>
    /**
     * Fetch a frozen message snapshot from Fluxer, never from a cache. Accepts a reference or an existing Message.
     * Returns after the API response is decoded and its message/channel IDs match the requested target.
     * Missing targets fail with MessageOperationError reason notFound rather than returning an empty value.
     * Enabled caching retains eligible responses, but the returned result does not depend on cache admission.
     * Cancellation releases only this request and awaits its cleanup.
     * Uses Messages' bounded read-retry policy; callers need no retry loop for its eligible transient failures
     * @example
     * ```ts
     * import type { Client, MessageReference } from "@neontechspace/fluxerly"
     * export async function readExample(client: Client, message: MessageReference) {
     *     const result = await client.messages.fetch(message, { timeoutMs: 2_000 })
     *     if (result.isErr()) throw result.error
     *     return result.value.content
     * }
     * ```
     */
    fetch(
        message: MessageReference,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<Message, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch one remote history page for a decimal channel ID, without requiring a gateway connection or consulting a cache.
     * Defaults to the latest 50 messages. Query limit is 1 through 100 with at most one before, after or around cursor
     *
     * Returns after HTTP 200 and validation of the entire page as a frozen array of frozen Message snapshots, newest first.
     * Empty and short arrays describe currently accessible results, not complete history. Pages are not a shared point-in-time snapshot.
     * No prefetch, automatic traversal or gateway notifications. Use the oldest returned ID as before for an older page
     *
     * Enabled caching admits eligible page members oldest first, so tight limits retain the newest members
     *
     * Invalid input, malformed pages and HTTP rejections use MessageOperationError with operation fetchHistory. HTTP 404 remains notFound.
     * Shares REST admission and the 30,000 ms default total deadline, using Messages' bounded read-retry policy.
     * Cancellation affects only this call and awaits cleanup. Closing/Closed fail with ClientClosedError and defects reject with SdkDefect
     */
    fetchHistory(
        channelId: string,
        query?: MessageHistoryQuery,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<readonly Message[], MessageOperationFailure | CancelledError | ConfigurationError>
    /** Preview one bounded exact cleanup selection without deleting, rereading cache, or requiring a gateway connection.
     * maxScanned and maxSelected are each required integers from 1 through 10,000. Supply authorId, a synchronous filter, or both as combined criteria
     *
     * History is read newest first without prefetch until an empty page, scan bound, or selection bound. A short page is not exhaustion.
     * Underlying history reads can populate an enabled message cache.
     * The returned in-memory plan owns frozen selected snapshots and can only be consumed once by this client. It cannot be JSON-rebuilt or used by another client
     *
     * A filter throw, non-boolean result, or thenable fails with MessageCleanupError before deletion. A blocking synchronous filter cannot be preempted.
     * This call uses one 30,000 ms default deadline across its history reads. Cancellation returns CancelledError and no cleanup request is submitted
     */
    previewCleanup(
        channelId: string,
        selection: MessageCleanupSelection,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<MessageCleanupPlan, MessageCleanupFailure | CancelledError | ConfigurationError>
    /** Submit one prior plan's exact IDs in sequential batches of at most 100, without rereading history or rerunning selection criteria.
     * A plan is single-use even after an error or cancellation, preventing accidental replay. Preview again or use explicit deleteMany for journaled reconciliation.
     * One 30,000 ms default deadline covers all batch submissions. submittedBatches in a report or MessageCleanupError records only earlier HTTP-success submissions.
     * A terminal rejected or unknown batch is reported separately. No report proves individual deletion, a deletion count, atomicity, or safe retry.
     * onProgress is synchronous best effort. Callback throws and thenable rejections are ignored. Cancellation remains CancelledError and can leave a submitting batch unknown.
     * Batches use deleteMany's confirmed rate-limit rejection retries, never automatic replay after an unknown outcome
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export async function cleanupWorkflowExample(client: Client, channelId: string, authorId: string) {
     *     const preview = await client.messages.previewCleanup(channelId, {
     *         authorId,
     *         filter: message => message.attachments.length > 0,
     *         maxScanned: 500,
     *         maxSelected: 200,
     *     })
     *     return preview.isErr() ? preview : client.messages.cleanup(preview.value)
     * }
     * ```
     */
    cleanup(
        plan: MessageCleanupPlan,
        options?: DefaultMessageCleanupOptions,
    ): ResultAsync<MessageCleanupReport, MessageCleanupFailure | CancelledError | ConfigurationError>
    /**
     * Replace text/embeds/files and return the frozen updated snapshot after the API response, without waiting for a gateway event.
     * Existing stickers are preserved; sticker replacement is not supported by this edit operation.
     * Supplied values replace those fields; omitted values are not sent. No hidden fetch or cache merge
     *
     * List retained attachment IDs alongside new uploads; retained title/description may be changed or cleared with null.
     * The supplied attachment list replaces the old list. Unknown IDs may be ignored and a stale list may remove concurrent additions.
     * attachment:// embed images/thumbnails must match a new image upload in this request, not a retained ID
     *
     * A flags-only edit is supported. Omitted flags preserve them; flags replaces writable bits and 0 clears both non-voice bits
     *
     * Clear files with attachments: [] and nonempty text or embeds. Uploads use send's snapshot, budget and cleanup rules
     *
     * To remove embeds, send nonempty content alongside embeds: []; an empty edit alone is rejected by Fluxer.
     * Empty content requests clearing text, subject to Fluxer validation. Mentions default off.
     * Omitted rich embeds are preserved, but Fluxer may regenerate text-derived link previews
     *
     * Enabled caching retains eligible responses. An uncertain dispatched edit evicts the old local copy.
     * A lost response or timeout after dispatch may leave the edit applied. Uncertain edits never retry automatically.
     * Missing targets remain typed notFound failures. Cancellation/closure cannot undo a dispatched edit
     */
    edit(
        message: MessageReference,
        input: EditMessageInput,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<Message, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Delete the target and complete without a value after HTTP 204, without waiting for a gateway event.
     * Missing targets fail with MessageOperationError reason notFound, including a repeated delete.
     * Confirmed deletion and uncertain dispatched deletion evict the local cached copy.
     * A lost response or timeout after dispatch may leave the target deleted. Uncertain deletes never retry automatically.
     * Cancellation/closure awaits owned cleanup but cannot undo a dispatched deletion
     */
    delete(
        message: MessageReference,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /** Delete one attachment by decimal ID from a message authored by this bot, without fetching or rewriting the retained attachment list.
     * Starts immediately, copies the target and uses message REST deadlines and failures; no gateway connection is required
     *
     * HTTP 204 returns no value, not event acknowledgement. Deleting the last attachment can delete the whole message if Fluxer considers it otherwise empty.
     * Confirmed or uncertain deletion evicts this message's cached copy. No optimistic events are emitted.
     * A notFound failure can mean only that the attachment is missing; it does not prove the message is absent.
     * Only confirmed 429 rejections retry. Storage removal and message updates are not atomic; lost responses can leave either applied.
     * Cancellation returns CancelledError after cleanup but cannot undo deletion or guarantee physical erasure; defects reject SdkDefect
     * @example
     * ```ts
     * import type { Client, MessageReference } from "@neontechspace/fluxerly"
     * export function attachmentDeleteExample(client: Client, message: MessageReference, attachmentId: string) {
     *     return client.messages.deleteAttachment(message, attachmentId)
     * }
     * ```
     */
    deleteAttachment(
        message: MessageReference,
        attachmentId: string,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Delete 1–100 distinct decimal message IDs from one guild channel, requiring ManageMessages permission.
     * Starts immediately without a gateway connection. No hidden selection, chunking, age filter or audit reason.
     * HTTP 204 completes with no value, not a deletion count or proof that each ID existed. Missing messages are ignored.
     * Dispatched requests evict selected cached messages even on rejection, since partial deletion is possible.
     * Only confirmed rate-limit rejections retry. A timeout, lost response, cancellation or closure cannot undo deletion.
     * Input/admission/HTTP failures use MessageOperationError. Cancellation returns CancelledError after owned cleanup.
     * Unexpected defects reject with SdkDefect. The IDs are copied when execution starts
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * async function cleanupExample(client: Client, channelId: string, selectedIds: readonly string[]) {
     *     return await client.messages.deleteMany(channelId, selectedIds)
     * }
     * ```
     */
    deleteMany(
        channelId: string,
        messageIds: readonly string[],
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /** Irreversibly delete this bot's whole authored history in one decimal channel ID, without selecting IDs or requiring a gateway connection.
     * Starts immediately and completes only after Fluxer returns empty HTTP 202, not a job, count, gateway event or proof that the channel is empty.
     * Other authors' messages are preserved. Fluxer can leave new or concurrent messages. Deletion is not atomic, may be partial, and has no recovery token or automatic reconciliation
     *
     * Bot credentials satisfy Fluxer's sudo checks, with no caller-supplied sudo fields. Fluxer controls attachment removal, without a physical provider-storage or CDN-erasure guarantee.
     * The 30,000 ms default total deadline includes admission and rate-limit waits. Only confirmed 429 rejection retries. 5xx, transport loss and other uncertain writes never replay
     *
     * After dispatch, the optional whole message cache is cleared and older pending reads cannot restore it. The SDK creates no synthetic gateway events.
     * Cancellation or closure awaits owned cleanup but cannot undo a dispatched deletion. Input/admission/HTTP failures use MessageOperationError operation deleteMine.
     * Unexpected defects reject with SdkDefect. This does not leave a guild or alter roles
     */
    deleteMine(
        channelId: string,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
}

/** One default collection, independent of observers and the client's connection lifetime */
export interface Collector {
    /** Request stop synchronously with accepted partial replies. Use waitForClose to await callback cleanup. Repeated calls preserve the first outcome */
    stop(): void
    /**
     * Observe the retained frozen result after timer, queue, filter, listener and callback cleanup.
     * Multiple and late observers share the same result/error. Cancelling this wait affects only this observer.
     * Timeout/stop may return empty results. Collection cancellation, filter/handler/overflow/gap failure or client closure returns Err without partial replies.
     * Unexpected SDK defects reject with SdkDefect. Keeping the handle/result retains successful message snapshots in memory
     */
    waitForClose(
        options?: OperationOptions,
    ): ResultAsync<CollectorResult, CollectorFailure | CancelledError | ConfigurationError>
}

/** One default reaction collection, independent of each result observer */
export interface ReactionCollector {
    /** Stop synchronously with accepted partial observations. Repeated calls preserve the first outcome */
    stop(): void
    /**
     * Observe the frozen result after queue, timer, filter, listener and callback cleanup; late/multiple observers share the outcome.
     * Cancelling this wait stops only this observer. Timeout/stop may succeed with empty or partial observations.
     * Collection abort, filter/handler/overflow/gap failure and client shutdown return Err without partial observations.
     * Unexpected defects reject with SdkDefect. Keeping the handle/result retains successful snapshots in memory
     */
    waitForClose(
        options?: OperationOptions,
    ): ResultAsync<ReactionCollectorResult, CollectorFailure | CancelledError | ConfigurationError>
}

export type {
    CacheDiagnostic,
    CacheEntriesOptions,
    CachedResources,
    CacheKind,
    ClientDiagnostics,
    ClientOptions,
    ConnectionState,
    OperationSignal,
    OperationOptions,
} from "./client.js"
export type {
    InstanceEndpoints,
    InstanceOptions,
    InstanceResolveError,
    InstanceResolveOptions,
    ResolvedInstance,
} from "./instance.js"
export {
    AuthenticationError,
    ShardConnectionError,
    CancelledError,
    ClientBusyError,
    ClientClosedError,
    ConfigurationError,
    ConnectionError,
    ConnectionTimeoutError,
    RateLimitError,
    SdkDefect,
} from "./errors.js"
export type { ConnectError, ConnectionFailure, DefectReason } from "./errors.js"
export type { ShardingOptions, ShardRecoveryDiagnostic, ShardState } from "./sharding.js"

/** Remote audit observations requiring ViewAuditLog, without SDK retention or gateway startup.
 * Eligible reads retry transient failures at most twice under the shared guild REST policy.
 * Permission, malformed-response and input failures are typed GuildOperationError values.
 * Page calls start immediately; abort returns CancelledError after cleanup, defects reject with SdkDefect.
 * Closing clients fail with ClientClosedError. Audit records can change independently; this is not an archival snapshot
 */
export interface AuditLogs {
    /** Read one filtered page, including referenced users and token-free webhook metadata.
     * Query cursors and filters are defined by AuditLogQuery. Returned data is caller-owned and frozen
     */
    fetchPage(
        guildId: string,
        query: AuditLogQuery,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<AuditLogPage, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Traverse filtered records newest-to-oldest on demand, buffering one page and never prefetching.
     * maxItems is required; pageSize defaults to 50 (1–100), maxPages to 100. timeoutMs applies to each page.
     * Stops at maxItems or an empty page, not merely a short page. Concurrent changes can prevent complete enumeration.
     * Invalid traversal input, a stalled cursor or reaching the page budget fails with PaginationError.
     * Remote failures retain auditLogs.fetchPage's typed errors. Already-delivered entries remain caller-owned.
     * Each consumption is independent and lazy; breaking the loop releases its buffered page, abort awaits request cleanup.
     * Closing/Closed releases the page and fails the next pull. Use fetchPage when referenced-user/webhook snapshots are needed
     */
    iterate(
        guildId: string,
        query: AuditLogIterationQuery,
        options?: DefaultGuildOperationOptions,
    ): AsyncIterable<
        Result<AuditLogEntry, GuildOperationFailure | PaginationError | CancelledError | ConfigurationError>
    >
}

/** Remote invite operations, without invite retention or gateway readiness requirements.
 * Reads retry eligible transient failures at most twice; writes retry only confirmed 429 rejections.
 * Fluxer checks destination visibility, invite permissions and capacity. Failures use GuildOperationError.
 * Calls start immediately; abort returns CancelledError after cleanup and defects reject with SdkDefect.
 * Closing clients fail with ClientClosedError. Lost responses can leave mutations applied; do not replay them blindly
 */
export interface Invites {
    /** Inspect a code without consuming it or joining its destination. Supply the code, not a URL.
     * Expired, revoked or inaccessible codes fail remotely. The provider can canonicalize vanity-code casing
     */
    fetch(
        code: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<Invite, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Create an invite to a channel the bot can access, including an existing group DM.
     * Defaults to a new code, 86400 seconds, unlimited uses and non-temporary membership.
     * Does not send the code, create a group or add members. Cancellation cannot revoke an already-created invite.
     * An unknown create outcome requires listing the destination's invites and caller reconciliation
     */
    create(
        channelId: string,
        input?: InviteCreate,
        options?: DefaultModerationOptions,
    ): ResultAsync<InviteMetadata, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Remote management list in provider order, subject to channel permissions; not a stable snapshot */
    fetchChannel(
        channelId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly InviteMetadata[], GuildOperationFailure | CancelledError | ConfigurationError>
    /** Remote guild management list, requiring ManageGuild and excluding the guild vanity invite */
    fetchGuild(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly InviteMetadata[], GuildOperationFailure | CancelledError | ConfigurationError>
    /** Revoke a code after HTTP 204, subject to provider creator/management permissions.
     * Does not remove existing members. A missing code is an error, not proof of a previous successful deletion
     */
    delete(
        code: string,
        options?: DefaultModerationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
}

/** Emojis share guild REST admission, deadlines and typed GuildOperationError failures.
 * Reads retry eligible transient failures at most twice; writes retry only confirmed 429 rejections.
 * Input, permission, 404 and malformed responses do not retry. Unknown outcomes may leave writes applied.
 * Calls start immediately; abort returns CancelledError after cleanup, defects reject with SdkDefect.
 * Closing clients fail with ClientClosedError. Snapshots are frozen and HTTP success is not gateway acknowledgement
 */
export interface Emojis {
    /** Local metadata lookup, never HTTP. Disabled, absent, expired or conflicting entries return undefined.
     * Decimal IDs are required; lookup updates LRU order but not expiry. Synchronous; defects throw SdkDefect
     */
    get(target: ExpressionReference): Result<GuildEmoji | undefined, GuildOperationFailure>
    /** Remote full guild list in provider order, without pagination or an enduring completeness guarantee.
     * Populates optional bounded metadata retention, excluding image bytes and creator accounts
     */
    fetchAll(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly GuildEmoji[], GuildOperationFailure | CancelledError | ConfigurationError>
    /** Remote minimal metadata by decimal ID without source-guild membership. Does not populate the cache */
    fetchMetadata(
        id: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<ExpressionMetadata, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Upload one expression. Fluxer enforces format, dimensions, permissions and capacity.
     * Copies input at execution start, without implicit URL fetching or replay of uncertain writes
     */
    create(
        guildId: string,
        input: EmojiCreate,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildEmoji, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Submit 1–50 uploads in one batch, with separate successes and failures and no rollback.
     * Duplicate names cannot map failures to input positions. No automatic chunking or replay.
     * Unknown outcomes require fresh remote observations and caller reconciliation
     */
    createMany(
        guildId: string,
        input: readonly EmojiCreate[],
        options?: DefaultModerationOptions,
    ): ResultAsync<ExpressionBatch<GuildEmoji>, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Server-side copy by source ID, preserving source metadata. Fluxer enforces source cloning restrictions */
    clone(
        guildId: string,
        sourceId: string,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildEmoji, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Rename without replacing the image or implicitly reading old metadata */
    edit(
        target: ExpressionReference,
        input: EmojiEdit,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildEmoji, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Remove after HTTP 204, invalidating retained observations. A missing target is an error, not proof of prior deletion.
     * Purging defaults false; explicit true also queues irreversible media removal subject to provider restrictions
     */
    delete(
        target: ExpressionReference,
        options?: DefaultExpressionDeleteOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
}

/** Stickers share guild REST admission, deadlines and typed GuildOperationError failures.
 * Reads retry eligible transient failures at most twice; writes retry only confirmed 429 rejections.
 * Input, permission, 404 and malformed responses do not retry. Unknown outcomes may leave writes applied.
 * Calls start immediately; abort returns CancelledError after cleanup, defects reject with SdkDefect.
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
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildSticker, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Local metadata lookup, never HTTP. Disabled, absent, expired or conflicting entries return undefined.
     * Decimal IDs are required; lookup updates LRU order but not expiry. Synchronous; defects throw SdkDefect
     */
    get(target: ExpressionReference): Result<GuildSticker | undefined, GuildOperationFailure>
    /** Remote full guild list in provider order, without pagination or an enduring completeness guarantee.
     * Populates optional bounded metadata retention, excluding image bytes and creator accounts
     */
    fetchAll(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly GuildSticker[], GuildOperationFailure | CancelledError | ConfigurationError>
    /** Remote minimal metadata by decimal ID without source-guild membership. Does not populate the cache */
    fetchMetadata(
        id: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<ExpressionMetadata, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Upload one expression. Fluxer enforces format, dimensions, permissions and capacity.
     * Copies input at execution start, without implicit URL fetching or replay of uncertain writes
     */
    create(
        guildId: string,
        input: StickerCreate,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildSticker, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Submit 1–50 uploads in one batch, with separate successes and failures and no rollback.
     * Duplicate names cannot map failures to input positions. No automatic chunking or replay.
     * Unknown outcomes require fresh remote observations and caller reconciliation
     */
    createMany(
        guildId: string,
        input: readonly StickerCreate[],
        options?: DefaultModerationOptions,
    ): ResultAsync<ExpressionBatch<GuildSticker>, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Server-side copy by source ID, preserving source metadata. Fluxer enforces source cloning restrictions */
    clone(
        guildId: string,
        sourceId: string,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildSticker, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Remove after HTTP 204, invalidating retained observations. A missing target is an error, not proof of prior deletion.
     * Purging defaults false; explicit true also queues irreversible media removal subject to provider restrictions
     */
    delete(
        target: ExpressionReference,
        options?: DefaultExpressionDeleteOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
}

/** Public server-directory management through the shared guild REST owner, without a discovery cache.
 * Operations start immediately and do not require gateway readiness. The default 30,000 ms total deadline includes waits.
 * Reads retry transient transport and HTTP 500/502/503/504 failures at most twice. Writes retry only confirmed 429 rejections.
 * Input, HTTP and malformed-response failures use GuildOperationError; closing clients use ClientClosedError.
 * Abort waits for cleanup and returns CancelledError. Unexpected defects reject with SdkDefect.
 * Application writes may publish or unpublish a listing, invalidate guild observations and cannot promise rollback.
 * There is no hidden eligibility read, automatic resubmission, review approval or directory-joining operation
 */
export interface Discovery {
    /** Search one current public directory page without a cache, gateway readiness, join operation or stable snapshot.
     * Defaults to limit 24 and offset 0. Each page can change while later offset pages are fetched, so callers must not infer a stable traversal.
     * The shared REST owner retries eligible GET failures. Input, HTTP and malformed-response failures use GuildOperationError
     */
    search(
        query?: DiscoverySearchQuery,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<DiscoverySearchPage, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Remote eligibility and application state for a decimal guild ID, requiring ManageGuild.
     * Returns eligible false when discovery is disabled or the member threshold is unmet, not a diagnosis distinguishing them.
     * Eligibility can change before submission. Reviewed/removed applications include available reasons
     */
    fetchStatus(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<DiscoveryStatus, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Remote category IDs and provider labels in provider order, without a retained copy.
     * Requires an authenticated client, not membership of a particular guild or ManageGuild
     */
    fetchCategories(
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly DiscoveryCategory[], GuildOperationFailure | CancelledError | ConfigurationError>
    /** Submit a guild application, requiring ManageGuild, enabled discovery and current provider eligibility.
     * Pending/approved existing applications fail remotely. Eligible verified/partnered guilds can be approved immediately.
     * Success is the stored application observation, not a guarantee of approval or search-index visibility.
     * An unknown outcome may already have submitted or published the listing; inspect fetchStatus before deciding what to do
     */
    apply(
        guildId: string,
        input: DiscoveryApplicationInput,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<DiscoveryApplication, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Nonempty patch of a pending or approved application, requiring ManageGuild and enabled discovery.
     * Omitted fields remain unchanged. Uses the input's documented tag normalization and replacement semantics.
     * No hidden fetch/merge. Approved listing updates can become public, and search-index changes may lag or partially fail
     */
    edit(
        guildId: string,
        input: DiscoveryApplicationEdit,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<DiscoveryApplication, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Withdraw an application or remove an approved listing, requiring ManageGuild and enabled discovery.
     * HTTP 204 returns no value. An absent application is a remote error, not an assumed successful no-op.
     * Removes the provider record and may separately remove its discoverable feature/search entry.
     * It does not restore the prior application, delete the guild or remove its members.
     * Unknown outcomes require remote reconciliation and can need operator recovery rather than blind retries
     */
    withdraw(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
}

/** Guild REST operations, gateway counts and optional local lookup.
 * The REST rules below exclude fetchCounts, which requires gateway readiness and has its own documented contract.
 * Shares the client's four HTTP slots, 256 pending requests and 4 MiB pending JSON budget with message/member/role operations, client-wide across locally owned shards.
 * Total deadline defaults to 30,000 ms, including waits. Reads retry transport failures and HTTP 500/502/503/504 at most twice.
 * Backoff is 125–250 ms then 250–500 ms, honoring longer Retry-After. Confirmed 429 waits are separate and never reset the deadline
 *
 * Input, 404, permission failures and malformed successes do not retry. Expected failures use GuildOperationError.
 * Abort returns CancelledError after cleanup; closing clients use ClientClosedError and unexpected defects reject with SdkDefect
 */
export interface Guilds {
    /** Fetch fresh, visibility-filtered counts for 1–100 distinct canonical positive uint64 decimal guild IDs over the connected gateway.
     * Starts immediately and copies input IDs. No implicit connection, REST read, cache, polling or retries
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
     * Abort returns CancelledError after local cleanup but cannot cancel dispatched provider work; defects reject SdkDefect
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export async function countsExample(client: Client, guildId: string, channelId: string) {
     *     const guilds = await client.guilds.fetchCounts([guildId])
     *     const channels = await client.channels.fetchMemberCounts(guildId, [channelId])
     *     return { guilds, channels }
     * }
     * ```
     */
    fetchCounts(
        guildIds: readonly string[],
        options?: DefaultCountOperationOptions,
    ): ResultAsync<GuildCountsResult, CountOperationFailure | CancelledError | ConfigurationError>
    /** Fetch one fresh remote membership page for this bot, ordered by ascending guild ID.
     * limit defaults to 200 (1–200); before/after are mutually exclusive existing-membership cursors.
     * withCounts defaults to false. Fluxer can omit permission bits or requested approximate counts. Missing means unavailable, not zero.
     * A removed cursor can cause Fluxer to restart the page. Returns frozen summaries without populating or reading the guild cache.
     * Summaries are REST-only observations and do not claim a complete membership inventory or gateway consistency.
     * Uses this group's deadlines, retries and failures; no gateway connection or background traversal required
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export async function guildListExample(client: Client) {
     *     const page = await client.guilds.fetchPage({ withCounts: true })
     *     if (page.isErr()) return page
     *     return page.value.map(({ id, permissions, approximateMemberCount }) => ({ id, permissions, approximateMemberCount }))
     * }
     * ```
     */
    fetchPage(
        query?: GuildListQuery,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly GuildListSummary[], GuildOperationFailure | CancelledError | ConfigurationError>
    /** Lazily traverse ascending guild IDs, retaining one page and never prefetching.
     * maxItems is required; pageSize defaults to 200 and maxPages to 100. Stop at maxItems or an empty page, not a short page
     *
     * Repeated/backward IDs after a removed cursor fail with PaginationError cursorStalled before that page is delivered.
     * Other pagination failures are input/pageLimit; remote failures preserve fetchPage's error and per-page timeout.
     * Each consumption copies inputs and yields Ok guilds or one terminal Err; abort yields CancelledError after request cleanup.
     * break/return releases the page; abort the signal to interrupt a pending next. Client closure releases the page and fails the next pull
     *
     * withCounts applies to every page. Fluxer can omit permission bits or requested counts. Missing means unavailable, not zero.
     * No cache hydration, gateway requirement or consistent-inventory guarantee. Previously delivered values remain caller-owned
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export function guildMembershipsExample(client: Client) {
     *     return client.guilds.iterate({ maxItems: 1000 })
     * }
     * ```
     */
    iterate(
        query: GuildIterationQuery,
        options?: DefaultGuildOperationOptions,
    ): AsyncIterable<
        Result<GuildListSummary, GuildOperationFailure | PaginationError | CancelledError | ConfigurationError>
    >
    /** Leave the named guild as the authenticated bot, explicitly preserving authored messages.
     * HTTP 204 completes membership removal, not gateway delivery. The client stays usable for other guilds.
     * Fluxer rejects owners and restricted memberships. Only confirmed 429 rejection is retried; cancellation or a lost
     * response can leave membership removed. Refetch/list to reconcile; rejoining requires external authorization.
     * Successful or uncertain writes invalidate this guild's resource observations and pending reads.
     * A confirmed successful leave also forgets this client's member-presence selection; an uncertain result preserves it.
     * Any dispatched attempt conservatively clears channel/message caches because messages need not carry guild IDs.
     * Existing caller-held snapshots remain unchanged. This operation never deletes the guild or shuts down the client
     */
    leave(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Irreversibly delete this bot's whole authored history across one decimal guild ID, without leaving the guild or changing roles.
     * Starts immediately and completes only after Fluxer returns empty HTTP 202, not a job, count, gateway event or proof that the guild is empty.
     * Other authors' messages are preserved. Fluxer can leave new or concurrent messages. Deletion is not atomic, may be partial, and has no recovery token or automatic reconciliation
     *
     * Bot credentials satisfy Fluxer's sudo checks, with no caller-supplied sudo fields or audit reason. Fluxer controls attachment removal, without a physical provider-storage or CDN-erasure guarantee.
     * The 30,000 ms default total deadline includes admission and rate-limit waits. Only confirmed 429 rejection retries. 5xx, transport loss and other uncertain writes never replay
     *
     * After dispatch, the optional whole message cache is cleared and older pending reads cannot restore it. The SDK creates no synthetic gateway events.
     * Cancellation or closure awaits owned cleanup but cannot undo a dispatched deletion. Input/admission/HTTP failures use GuildOperationError operation guilds.deleteMine.
     * Unexpected defects reject with SdkDefect. This operation never removes guild membership or changes roles
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export function deleteMineExample(client: Client, channelId: string) {
     *     return client.messages.deleteMine(channelId)
     * }
     * export function deleteMineGuildExample(client: Client, guildId: string) {
     *     return client.guilds.deleteMine(guildId)
     * }
     * ```
     */
    deleteMine(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Read a decimal guild's custom invite and use count, requiring ManageGuild.
     * Always remote, without a vanity cache or gateway requirement. Null code/url means no custom invite.
     * Starts immediately, using this group's read retries, deadline, cancellation and typed failure rules
     */
    fetchVanityUrl(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<GuildVanityUrlUsage, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Set or replace a guild's custom invite, or explicitly remove it with null.
     * Code must already be lowercase, 2–32 ASCII letters/digits with single internal hyphens. No implicit normalization.
     * Requires ManageGuild and, when setting a code, the server's VANITY_URL feature. Reserved/taken codes fail remotely
     *
     * Changing the code releases the old one and starts a new use count. Neither reclaiming it nor provider rollback is guaranteed.
     * Returns only code/url after HTTP success, without a hidden read, joinability check or event acknowledgement.
     * Starts immediately with the shared deadline and abort cleanup. Only confirmed 429 rejections may retry writes.
     * Dispatched writes invalidate guild observations. Unknown outcomes require fetchVanityUrl and caller reconciliation,
     * not blind replay; provider-side partial changes can require operator recovery.
     * Uses this group's GuildOperationError, ClientClosedError, CancelledError and defect behavior
     */
    editVanityUrl(
        guildId: string,
        code: string | null,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildVanityUrl, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Patch bot-permitted server settings without a hidden read or merge; omitted fields remain unchanged.
     * Requires ManageGuild. Fluxer owns feature restrictions and validation beyond GuildEdit's local checks.
     * Dispatched mutations invalidate guild-cache observations even when the outcome is unknown.
     * Starts immediately, using guild REST deadlines and abort cleanup.
     * Success returns the server's observed configuration, not gateway acknowledgement or rollback guarantees.
     * Uncertain writes must be reconciled with fetch rather than blindly replayed
     */
    edit(
        guildId: string,
        input: GuildEdit,
        options?: DefaultModerationOptions,
    ): ResultAsync<Guild, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Ban a decimal guild/user target, including a user who is not currently a member.
     * Requires BanMembers and provider hierarchy/MFA rules. Defaults to permanent with no message deletion
     *
     * HTTP 204 returns no value, not event acknowledgement. Writes retry only confirmed 429 rejections.
     * Failure after dispatch may leave a ban and separately queued message deletion applied
     *
     * Dispatched actions invalidate this member's retained snapshot even on rejection.
     * Requested message cleanup deliberately evicts this author's cached messages across all guilds, including known unrelated scope, because messages need not carry guild IDs.
     * The cleanup job can finish later. A later cache hit does not establish that its message survived the job
     *
     * Bans may also block rejoining through provider-side IP/email checks. Unban restores neither messages nor membership.
     * Starts immediately. Cancellation awaits cleanup and returns CancelledError. Defects reject with SdkDefect.
     * Invalid input and HTTP failures use GuildOperationError, while a closed client uses ClientClosedError
     */
    ban(
        target: MemberReference,
        input?: BanInput,
        options?: DefaultModerationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Remove a ban after HTTP 204, without rejoining the user or cancelling queued message deletion.
     * Requires BanMembers. A user who is not banned is an API failure, not a successful no-op.
     * Uses ban's execution, failure, cleanup and member-cache invalidation rules
     */
    unban(
        target: MemberReference,
        options?: DefaultModerationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Fetch the provider's full ban list as frozen observations, requiring BanMembers.
     * Always remote, without a ban cache, pagination or guaranteed order. Separate reads are not a consistent snapshot.
     * Starts immediately. Uses shared guild read deadline/retry rules, rejecting malformed responses as a whole
     */
    fetchBans(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly GuildBan[], GuildOperationFailure | CancelledError | ConfigurationError>
    /** Synchronously read the enabled guild cache without HTTP or requiring a connection.
     * Returns undefined when disabled, absent, expired or evicted. Snapshots may be stale. Use fetch for a remote observation.
     * Invalid decimal IDs fail with GuildOperationError(input). Closing/closed clients fail with ClientClosedError.
     * Unexpected defects throw SdkDefect. Lookup updates LRU order but never extends expiry
     */
    get(guildId: string): Result<Guild | undefined, GuildOperationFailure>
    /** Fetch a frozen identity/configuration projection for a decimal guild ID. Fluxer requires guild membership.
     * No embedded member/role/channel state is retained and no counts or completeness guarantee are inferred
     */
    fetch(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<Guild, GuildOperationFailure | CancelledError | ConfigurationError>
}

/** Guild-channel REST operations, gateway member counts and optional local lookup.
 * The REST rules below exclude fetchMemberCounts, which requires gateway readiness and has its own documented contract
 *
 * DM operations are outside this API contract. Supply decimal guild-channel IDs. ID-targeted writes do not prefetch or verify their guild type.
 * Shares the client's four HTTP slots, 256 pending requests and 4 MiB pending JSON budget with guild/member/role/message operations, client-wide across locally owned shards.
 * Total deadline defaults to 30,000 ms, including admission, retry and rate waits. Reads retry transport failures and HTTP 500/502/503/504 at most twice.
 * Writes retry only confirmed 429 responses. Permission, input, 404 and malformed-response failures do not retry
 *
 * All dispatched channel mutations invalidate the whole enabled channel cache. Pre-dispatch input failures preserve it, and this API never follows a write with an implicit fetch.
 * Operation inputs are copied when the call starts and later caller mutations are not observed. Permission bits are bigint values encoded as decimal JSON strings.
 * Fluxer enforces channel permissions and grant restrictions. Targeted overwrite operations require ManageRoles for role and member targets.
 * Expected failures use ChannelOperationError or ClientClosedError. Abort returns CancelledError after cleanup. Unexpected defects reject with SdkDefect
 */
export interface Channels {
    /** Fetch fresh counts for 1–25 distinct channel IDs in one guild, using canonical positive uint64 decimal IDs over the connected gateway.
     * Starts immediately and copies IDs. Requires the guild's locally owned shard to be ready plus ViewChannel and ViewChannelMembers; no hidden connect or REST reads.
     * The guild must route to a locally owned ready shard. An unowned or unready guild fails notConnected instead of appearing in omittedChannelIds
     *
     * Returns frozen counts plus omittedChannelIds in input order. Omission never becomes zero or identifies its cause.
     * Counts are visibility-filtered observations, not a subscription or guaranteed cross-channel snapshot.
     * Uses guilds.fetchCounts' one-logical-slot four-call admission, default 30,000 ms overall deadline, no-retry, participant-shard recovery and failure/cleanup rules.
     * No channel/member cache writes. Cancellation cannot stop dispatched provider work
     */
    fetchMemberCounts(
        guildId: string,
        channelIds: readonly string[],
        options?: DefaultCountOperationOptions,
    ): ResultAsync<ChannelMemberCountsResult, CountOperationFailure | CancelledError | ConfigurationError>
    /** Synchronously read the enabled channel cache without HTTP or requiring a connection.
     * Returns undefined when disabled, absent, expired or evicted. Snapshots may be stale. Use fetch for a remote observation.
     * Invalid decimal IDs fail with ChannelOperationError(input). Closing/closed clients fail with ClientClosedError.
     * Unexpected defects throw SdkDefect. Lookup updates LRU order but never extends expiry
     */
    get(channelId: string): Result<GuildChannel | undefined, ChannelOperationFailure>
    /** Fetch one frozen guild-channel observation by decimal ID, without connecting or populating a complete guild list.
     * A non-guild response is a typed response failure. The result has explicit overwrites only, not inherited or effective permissions
     */
    fetch(
        channelId: string,
        options?: DefaultChannelOperationOptions,
    ): ResultAsync<GuildChannel, ChannelOperationFailure | CancelledError | ConfigurationError>
    /** Fetch Fluxer's visible guild-channel list for one decimal guild ID, without pagination or a completeness guarantee.
     * The response is a point-in-time observation, not a subscription. It does not fetch members, roles, DMs or missing permission-overwrite targets
     */
    fetchAll(
        guildId: string,
        options?: DefaultChannelOperationOptions,
    ): ResultAsync<readonly GuildChannel[], ChannelOperationFailure | CancelledError | ConfigurationError>
    /** Create one supported guild channel and return Fluxer's frozen observation. Fluxer chooses its initial position.
     * Omitted permissionOverwrites inherits the selected parent category's overrides. [] creates no explicit overrides, not private visibility.
     * Explicit overwrite bits include ViewChannelMembers through Fluxer's required feature opt-in
     * @example
     * ```ts
     * import { ChannelType, Permissions, type Client } from "@neontechspace/fluxerly"
     * export async function channelExample(client: Client, guildId: string, botId: string) {
     *     const result = await client.channels.create(guildId, {
     *         type: ChannelType.Text,
     *         name: "private-support",
     *         permissionOverwrites: [
     *             { id: guildId, type: "role", allow: 0n, deny: Permissions.ViewChannel },
     *             { id: botId, type: "member", allow: Permissions.ViewChannel | Permissions.SendMessages, deny: 0n },
     *         ],
     *     })
     *     if (result.isErr()) throw result.error
     *     return result.value
     * }
     * ```
     * The caller owns the created channel. The returned snapshot is not gateway confirmation. Reconcile an unknown outcome with fetchAll before deciding whether to create again
     */
    create(
        guildId: string,
        input: ChannelCreate,
        options?: DefaultChannelOperationOptions,
    ): ResultAsync<GuildChannel, ChannelOperationFailure | CancelledError | ConfigurationError>
    /** Patch only supplied channel settings and return Fluxer's frozen observation. Empty/unknown-field patches are input errors.
     * Channel type and parent are intentionally not editable here. Move a channel with reorder. Omitted permissionOverwrites preserves them, while [] clears them.
     * Explicit overwrite replacements opt into Fluxer's ViewChannelMembers permission handling, including clearing that bit
     */
    edit(
        channelId: string,
        input: ChannelEdit,
        options?: DefaultChannelOperationOptions,
    ): ResultAsync<GuildChannel, ChannelOperationFailure | CancelledError | ConfigurationError>
    /** Delete a guild channel and complete after HTTP 204, without waiting for a gateway event or proving a prior channel existed.
     * The SDK does not prefetch to verify the ID. A lost response or timeout after dispatch can leave deletion applied
     */
    delete(
        channelId: string,
        options?: DefaultChannelOperationOptions,
    ): ResultAsync<void, ChannelOperationFailure | CancelledError | ConfigurationError>
    /** Apply submitted guild-channel moves sequentially and complete after HTTP 204, without fabricating a reordered snapshot.
     * syncPermissionsOnMove copies the target category's overwrites. A bulk channel event can arrive before that permission copy completes.
     * Fluxer may normalize positions. This bulk mutation is not a transaction, so failures can leave partial movement. Refetch when final order matters
     */
    reorder(
        guildId: string,
        positions: readonly ChannelPosition[],
        options?: DefaultChannelOperationOptions,
    ): ResultAsync<void, ChannelOperationFailure | CancelledError | ConfigurationError>
    /** Replace one explicit role/member overwrite with its supplied raw bigint allow and deny bits, then complete after HTTP 204.
     * Sets and clears ViewChannelMembers through Fluxer's required feature opt-in, alongside the other raw bits.
     * Fluxer enforces ManageRoles. This does not calculate inherited/effective permissions or prefetch the target
     */
    setPermissionOverwrite(
        channelId: string,
        input: PermissionOverwrite,
        options?: DefaultChannelOperationOptions,
    ): ResultAsync<void, ChannelOperationFailure | CancelledError | ConfigurationError>
    /** Remove one explicit role/member overwrite by decimal target ID and complete after HTTP 204.
     * Fluxer enforces ManageChannels and ManageRoles. Other overwrites remain unchanged, and an unknown outcome requires an explicit follow-up read
     */
    removePermissionOverwrite(
        channelId: string,
        targetId: string,
        options?: DefaultChannelOperationOptions,
    ): ResultAsync<void, ChannelOperationFailure | CancelledError | ConfigurationError>
}

/** Guild membership reads, moderation and targeted role writes, sharing Guilds' REST admission, deadlines and failure rules.
 * iterateChunks uses the gateway and its own documented stream rules instead.
 * Returned members are frozen observations. Optional retention follows ClientOptions.cache.members, without permission prediction or automatic guild download.
 * Writes retry only confirmed 429 rejections, never uncertain outcomes. Cancellation cannot undo a dispatched write
 */
export interface Members {
    /** Lazily request one guild's members over the connected gateway, yielding frozen batches rather than accumulating a roster.
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
     * A gap, timeout, malformed reply or overflow discards unread batches and yields one terminal MemberChunkError, never a silent partial success.
     * Previously yielded batches stay caller-owned. Client closure fails with ClientClosedError and releases local buffers
     *
     * Abort releases intake even while paused and yields CancelledError on the next pull. break/return releases between pulls; abort interrupts a pending next.
     * Local cleanup cannot cancel Fluxer's dispatched work. Late/unmatched chunks are ignored and chunks are not replayed on Resume.
     * Unexpected defects reject with SdkDefect, preserving safe combined-failure diagnostics
     * @example
     * ```ts
     * import type { Client, MemberChunk } from "@neontechspace/fluxerly"
     * export async function memberChunksExample(client: Client, guildId: string, handleBatch: (chunk: MemberChunk) => Promise<void>) {
     *     for await (const result of client.members.iterateChunks(guildId, { all: true, presences: true })) {
     *         if (result.isErr()) return result
     *         await handleBatch(result.value)
     *     }
     * }
     * ```
     */
    iterateChunks(
        guildId: string,
        query: MemberChunkQuery,
        options?: DefaultMemberChunkOptions,
    ): AsyncIterable<Result<MemberChunk, MemberChunkFailure | CancelledError | ConfigurationError>>
    /** Replace the member's entire explicit role set with 0–250 distinct positive decimal role IDs in one PATCH.
     * Starts immediately, copies IDs and performs no prefetch or merge. [] clears assigned roles; the everyone role is implicit and rejected as input
     *
     * Requires provider ManageRoles and hierarchy permission for changes. This may overwrite concurrent role changes.
     * Fluxer can silently omit nonexistent or foreign role IDs. Returns its frozen actual member, not a promise that every requested role was accepted
     *
     * Uses shared guild write deadlines/failures and only confirmed 429 retries. No gateway readiness or event acknowledgement is required.
     * Eligible responses update member caching; uncertain dispatched writes evict it and need explicit fetch reconciliation.
     * Cancellation awaits cleanup but cannot undo the replacement; defects reject SdkDefect
     * @example
     * ```ts
     * import type { Client, MemberReference } from "@neontechspace/fluxerly"
     * export function roleSetExample(client: Client, member: MemberReference, desiredRoles: readonly string[]) {
     *     return client.members.setRoles(member, desiredRoles)
     * }
     * ```
     */
    setRoles(
        member: MemberReference,
        roleIds: readonly string[],
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Search indexed member observations remotely, not the local member cache.
     * Starts immediately. query defaults to an unfiltered page of 25, ordered by join time descending
     *
     * Results may lag membership changes. indexing=true is not an empty completed search; even indexing=false with
     * no hits can mean Fluxer's search service is unavailable. Counts are observations, not completeness guarantees
     *
     * Join-source/invite filters first fetch the bot's guild permissions and require ManageGuild, failing rather
     * than knowingly sending ignored filters. This preflight is not atomic with the search and permissions can change.
     * Other queries have no hidden reads. Search hits never populate the member cache or fetch full members
     *
     * The whole call shares timeoutMs (default 30,000), rate admission and abort cleanup. Preflight GETs use read retries,
     * but search POST retries only confirmed 429 rejection, since it may enqueue provider indexing
     *
     * Expected failures use GuildOperationError/ClientClosedError, cancellation uses CancelledError and defects reject
     * with SdkDefect. Local permission denial is members.search/rejected with outcome notDispatched and no HTTP status
     */
    search(
        guildId: string,
        filters?: MemberSearchQuery,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<MemberSearchPage, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Demand-driven best-effort search traversal, not a consistent or complete member snapshot.
     * Reusable lazy AsyncIterable with independent state per consumption. Copies filters at consumption, never prefetches
     *
     * maxItems is required; pageSize defaults to 100 (1–100), maxPages to 100. Offset advances by received hit count.
     * Emits each user at most once per consumption, retaining at most maxItems IDs. Concurrent index changes can skip users
     *
     * A provider indexing response fails with PaginationError indexing rather than claiming exhaustion.
     * An empty page before the observed total fails cursorStalled. Reaching maxItems is normal bounded completion
     *
     * Each page uses search's timeout, permission preflight, retry and cache rules. break/return releases retained state.
     * Abort interrupts a pending pull and awaits cleanup. One terminal Err follows any delivered hits on failure.
     * Failures also include PaginationError input/pageLimit/cursorStalled. Closing the client releases the page
     */
    iterateSearch(
        guildId: string,
        filters: Omit<MemberSearchQuery, "limit">,
        limits: MemberSearchIterationLimits,
        options?: DefaultGuildOperationOptions,
    ): AsyncIterable<
        Result<MemberSearchHit, GuildOperationFailure | PaginationError | CancelledError | ConfigurationError>
    >
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
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Set or clear one member nickname without replacing that member's roles or profile fields.
     * nickname is 1–32 Unicode code points; null clears it. Fluxer decides whether the bot may target this member,
     * including ManageNicknames, hierarchy and self rules. The returned frozen member is the HTTP observation, not an
     * event acknowledgement. This starts immediately, shares guild write retries/deadlines and cannot undo a dispatched write.
     * An uncertain result evicts the targeted member cache; a definite rejection preserves its prior snapshot
     * @example
     * ```ts
     * import type { Client, MemberReference } from "@neontechspace/fluxerly"
     * export async function nicknameExample(client: Client, target: MemberReference) {
     *     const set = await client.members.setNickname(target, "Renamed")
     *     if (set.isErr()) return set
     *     return await client.members.setNickname(target, null)
     * }
     * ```
     */
    setNickname(
        member: MemberReference,
        nickname: string | null,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Move an already-connected member to one positive decimal voice-channel ID.
     * Requires MoveMembers plus Fluxer's hierarchy and destination visibility/connect checks. Supplying target.connectionId
     * targets only that observed connection; omission targets every active connection for the member.
     * HTTP 200 returns a frozen member projection after Fluxer accepts the move, not proof that the participant reconnected.
     * A visible move can emit voiceStateUpdate first with channelId null, then with a new connection ID in the destination.
     * The request starts immediately. Do not retry an unknown result; cancellation cannot undo a dispatched move.
     * Shared moderation deadlines, auditReason validation, confirmed-429 retries and member-cache invalidation apply
     * @example
     * ```ts
     * import type { Client, VoiceConnectionReference } from "@neontechspace/fluxerly"
     * export function moveVoiceConnection(client: Client, target: VoiceConnectionReference, channelId: string) {
     *     return client.members.move(target, channelId, { auditReason: "Moved to support" })
     * }
     * ```
     */
    move(
        target: VoiceConnectionReference,
        channelId: string,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Disconnect one observed connection, or every active connection when target.connectionId is omitted.
     * Requires MoveMembers and returns the HTTP member projection without waiting for voiceStateUpdate.
     * Repeating after completion can fail because the target is no longer connected. Unknown outcomes must be reconciled from
     * later observations rather than retried. Uses move's execution, audit, permission and cache-invalidation rules
     */
    disconnect(
        target: VoiceConnectionReference,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Set or clear Fluxer's server mute flag for one currently connected member.
     * Requires MuteMembers and provider hierarchy rules. Returns an HTTP member projection with isMuted, without waiting for
     * a voice-state event. This does not control the participant's self-mute state or join a voice channel.
     * Starts immediately with move's deadline, audit, retry, cancellation and member-cache invalidation rules
     */
    setMute(
        target: MemberReference,
        muted: boolean,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Set or clear Fluxer's server deafen flag for one currently connected member.
     * Requires DeafenMembers and provider hierarchy rules. Returns an HTTP member projection with isDeafened, without waiting
     * for a voice-state event. This does not control the participant's self-deafen state or join a voice channel.
     * Starts immediately with move's deadline, audit, retry, cancellation and member-cache invalidation rules
     */
    setDeaf(
        target: MemberReference,
        deafened: boolean,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Set a timeout for integer durationMs in 1–31,536,000,000 milliseconds, calculated when execution starts
     *
     * Requires ModerateMembers and provider hierarchy rules. The provider rejects self and administrator targets.
     * Queue/network time consumes this duration. An expiry already past at processing time can clear the timeout
     *
     * Returns the frozen HTTP 200 member with communicationDisabledUntil, without waiting for an event.
     * Uses shared guild deadlines and failures. Writes retry only confirmed 429 rejections.
     * Starts immediately, with expected GuildOperationError results and SdkDefect rejections.
     * Cancellation and closure await owned cleanup but cannot undo a dispatched timeout
     *
     * Eligible responses update enabled member caching. Dispatched failures evict the member even on rejection
     * @example
     * ```ts
     * import type { Client, MemberReference } from "@neontechspace/fluxerly"
     * async function moderationExample(client: Client, target: MemberReference) {
     *     return await client.members.timeout(target, 5 * 60_000)
     * }
     * ```
     */
    timeout(
        target: MemberReference,
        durationMs: number,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Clear a timeout with timeout's permissions, execution, cache and failure rules.
     * Sends null, not a negative duration. Returns the HTTP 200 member without waiting for an event
     */
    clearTimeout(
        target: MemberReference,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Kick the selected guild member after HTTP 204, without waiting for a removal event.
     * Requires KickMembers and provider hierarchy rules. Does not ban the user or automatically restore membership.
     * Missing membership is a typed API failure. Dispatched actions invalidate the member cache even on rejection.
     * Uses timeout's execution/deadline/failure rules, with no automatic retry after an uncertain result
     */
    kick(
        target: MemberReference,
        options?: DefaultModerationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Traverse ascending remote user IDs without connecting or downloading the whole guild eagerly.
     * Reusable lazy AsyncIterable of frozen Ok members and at most one terminal Err, with independent state per consumption
     *
     * Copies inputs on consumption. maxItems is required, pageSize defaults to 100 and maxPages to 100.
     * Stop at maxItems or an empty page, not a short page. Pages are not a consistent membership snapshot
     *
     * timeoutMs applies per page. Remote failures keep members.fetchPage's GuildOperationError and shared retry policy.
     * PaginationError covers input, cursorStalled and pageLimit. Aborting the signal yields CancelledError after request cleanup
     *
     * break/return releases the page. Abort the signal to interrupt a pending next. SDK defects reject with SdkDefect.
     * Closing/Closed releases the page and fails the next pull with ClientClosedError. Delivered items remain caller-owned
     *
     * Enabled member caching follows fetchPage admission. Traversal keeps one page and does not fetch roles or predict permissions
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export async function paginationMembersExample(client: Client, guildId: string) {
     *     for await (const result of client.members.iterate(guildId, { maxItems: 1000 })) {
     *         if (result.isErr()) return result
     *         if (!result.value.isBot) return result
     *     }
     *     return undefined
     * }
     * ```
     */
    iterate(
        guildId: string,
        query: UserIterationQuery,
        options?: DefaultGuildOperationOptions,
    ): AsyncIterable<Result<GuildMember, GuildOperationFailure | PaginationError | CancelledError | ConfigurationError>>
    /** Local-only lookup by decimal guild/user IDs, with Guilds.get's miss, freshness, failure and LRU rules.
     * Enable cache.members and cache.roles when creating the client. Explicit fetches or subsequent events populate them
     * @example
     * ```ts
     * import type { Client, MemberReference } from "@neontechspace/fluxerly"
     * export function cachedRoleNamesExample(client: Client, target: MemberReference) {
     *     const member = client.members.get(target)
     *     if (member.isErr()) throw member.error
     *     return member.value?.roleIds.map(id => {
     *         const role = client.roles.get({ guildId: target.guildId, id })
     *         if (role.isErr()) throw role.error
     *         return role.value?.name ?? id
     *     })
     * }
     * ```
     * Repeated rendering makes no requests. A missing member returns undefined and missing role names fall back to IDs.
     * This displays observed names, not effective permissions or a completeness guarantee
     */
    get(member: MemberReference): Result<GuildMember | undefined, GuildOperationFailure>
    /** Fetch one member by decimal guild/user IDs; HTTP 404 uses notFound rather than an empty result */
    fetch(
        member: MemberReference,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Fetch the authenticated bot's membership directly, without requiring READY or a known bot ID */
    fetchSelf(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Fetch fresh guild, authenticated-bot member, target member and role observations in parallel, then evaluate canManageHierarchy.
     * One 30,000 ms default deadline covers the whole composition. Sibling cleanup is awaited on failure or cancellation.
     * This never reads a guild cache, retains no helper snapshot, evaluates no permissions or MFA, and does not authorize or perform an action.
     * Like its underlying explicit fetches, enabled guild-resource caches can receive these fresh responses.
     * A true result is only the hierarchy rule over four independently observed resources, which can change before an endpoint request
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export const hierarchyCheckExample = (client: Client, guildId: string, userId: string) =>
     *     client.members.fetchHierarchyCheck({ guildId, userId })
     * ```
     */
    fetchHierarchyCheck(
        target: MemberReference,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<boolean, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Fetch an ascending user-ID page; default limit 100, range 1–1000.
     * Use the last userId as after. An empty page ends traversal; separate pages are not a consistent snapshot.
     * No hasMore guarantee, automatic traversal or partial malformed page. Input is copied when this call starts
     */
    fetchPage(
        guildId: string,
        query?: MemberQuery,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly GuildMember[], GuildOperationFailure | CancelledError | ConfigurationError>
    /** Grant one decimal role ID without replacing other roles. Reject the implicit everyone role locally.
     * Fluxer enforces MANAGE_ROLES and hierarchy. HTTP 204 is completion, not event acknowledgement or proof the role was previously absent
     * @example
     * ```ts
     * import type { Client, MessageReference } from "@neontechspace/fluxerly"
     * export async function assignRoleExample(client: Client, message: MessageReference, guildId: string, roleId: string) {
     *     const opened = client.messages.collectReactions(message, {
     *         emoji: "✅",
     *         onReaction: async (reaction, signal) => {
     *             const assigned = await client.members.addRole({ guildId, userId: reaction.userId }, roleId, { signal })
     *             if (assigned.isErr()) throw assigned.error
     *         },
     *     })
     *     if (opened.isErr()) throw opened.error
     *     try {
     *         const result = await opened.value.waitForClose()
     *         if (result.isErr()) throw result.error
     *         return result.value
     *     } finally { opened.value.stop() }
     * }
     * ```
     * Supply a connected client, a message in this guild and a role the bot may assign. Timeout may collect nothing.
     * This bounded one-addition example is not a persistent reaction-role system and does not revoke on reaction removal
     */
    addRole(
        member: MemberReference,
        roleId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Revoke one role with addRole's permission/completion rules. Other roles remain untouched.
     * No local snapshot suppresses the request; success does not prove a previously assigned role was removed
     */
    removeRole(
        member: MemberReference,
        roleId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
}

/** Explicit permission-bit calculations, not channel visibility, role hierarchy, timeout or action-authorization checks */
export interface PermissionHelpers {
    /** Synchronous local calculation from supplied snapshots, without requests or cache reads.
     * Works independently of connection state, including after shutdown. Missing/inconsistent required data produces
     * GuildOperationError permissions.calculate/input. Returns unsigned 64-bit bigint, preserving unknown bits.
     * Owner/base Administrator grants all bits; otherwise applies everyone, aggregated roles, then member overrides.
     * Uses only the target channel's stored overrides, never a parent category. Defects throw SdkDefect
     */
    calculate(input: PermissionInput): Result<bigint, GuildOperationError>
    /** Fetch guild/member/roles and optional target channel, then calculate the same permission bits.
     * Starts immediately with no gateway requirement or cache-first lookup. Existing resource caches may admit the reads.
     * Sequential observations are not atomic. No permission result is retained and no later action is guaranteed.
     * timeoutMs defaults to 30,000 across the workflow, using shared read retries and awaited abort cleanup.
     * Invalid target/deadline uses GuildOperationError permissions.fetch/input; resource failures retain their original
     * GuildOperationError or ChannelOperationError. Closing uses ClientClosedError, cancellation CancelledError,
     * and defects reject with SdkDefect. A channel from another guild fails rather than calculating across guilds
     */
    fetch(
        target: PermissionTarget,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<bigint, GuildOperationFailure | ChannelOperationFailure | CancelledError | ConfigurationError>
}

/** Immediate role operations sharing Guilds' admission, deadlines and read retries.
 * Writes retry only confirmed 429 rejections. Server permissions/hierarchy apply; no local permission prediction.
 * Abort waits for owned cleanup but cannot undo dispatched writes. Success is not a gateway acknowledgement.
 * Expected failures use GuildOperationError or ClientClosedError; abort uses CancelledError and defects reject with SdkDefect.
 * Inputs are copied when the call starts; returned roles contain bigint permissions and require explicit JSON conversion
 */
export interface Roles {
    /** Local-only lookup by decimal guild/role IDs, including everyone, with Guilds.get's miss, freshness, failure and LRU rules */
    get(role: RoleReference): Result<GuildRole | undefined, GuildOperationFailure>
    /** Fetch the current role list, including everyone, in server order. Always remote, without pagination or automatic refresh */
    fetchAll(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly GuildRole[], GuildOperationFailure | CancelledError | ConfigurationError>
    /** Create a role with name, color and permissions. Permissions default to 0n, not Fluxer's inherited everyone grants.
     * Explicit permissions include ViewChannelMembers through Fluxer's required feature opt-in.
     * Returns the server's actual grants, which can differ from the request. Hoist/mentionable changes require a separate edit
     * @example
     * ```ts
     * import { Permissions, type Client } from "@neontechspace/fluxerly"
     * export async function createRoleExample(client: Client, guildId: string) {
     *     const result = await client.roles.create(guildId, {
     *         name: "Readers",
     *         permissions: Permissions.ViewChannel | Permissions.ReadMessageHistory,
     *     })
     *     if (result.isErr()) throw result.error
     *     return result.value
     * }
     * ```
     * The caller owns the created role. On an unknown outcome, reconcile with fetchAll before deciding whether to create again
     */
    create(
        guildId: string,
        input: RoleCreate,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<GuildRole, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Patch only defined fields and return the server's observation. Empty/unknown-field patches are input errors.
     * permissions replaces the raw grants, including setting or clearing ViewChannelMembers; it is not an additive grant.
     * The default/everyone role accepts only color and permissions. Other defined fields fail locally, including mixed patches */
    edit(
        role: RoleReference,
        input: RoleEdit,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<GuildRole, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Delete a role, also removing its assignments upstream. Everyone cannot be deleted.
     * HTTP 204 is completion, not proof of member-event delivery; old member/role observations remain unchanged */
    delete(
        role: RoleReference,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Reorder distinct role IDs using nonnegative safe-integer positions; everyone cannot move.
     * Fluxer normalizes manageable positions, so fetchAll afterward when final order matters. HTTP 204 carries no list.
     * This operation and multi-step workflows are not transactions: Failures can leave partial state; refetch before reconciliation */
    reorder(
        guildId: string,
        positions: readonly RolePosition[],
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Set display positions for distinct roles without changing permission hierarchy or enabling hoist.
     * Requires a nonempty list of signed 32-bit positions, excluding everyone. Fluxer enforces ManageRoles and hierarchy.
     * HTTP 204 returns no roles. Successful or uncertain writes invalidate retained guild roles, including pending reads.
     * Failures or cancellation can leave partial changes; refetch before reconciliation rather than replaying blindly
     * @example
     * ```ts
     * import { type Client } from "@neontechspace/fluxerly"
     * export function orderRoleDisplay(client: Client, guildId: string, roleId: string) {
     *     return client.roles.setHoistPositions(guildId, [{ id: roleId, hoistPosition: 0 }])
     * }
     * ```
     */
    setHoistPositions(
        guildId: string,
        positions: readonly RoleHoistPosition[],
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
    /** Clear display-position assignments for every role in the guild, not just roles below the bot.
     * Fluxer enforces ManageRoles. Permission hierarchy and hoist flags remain unchanged.
     * HTTP 204 has no role list. This is not transactional; a failure can leave partial changes.
     * Successful or uncertain writes invalidate retained guild roles. Refetch to reconcile an unknown outcome
     */
    resetHoistPositions(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
}

/** Bot-authenticated remote webhook management, available before connect.
 * No webhook cache, hidden credential persistence or synthesized events.
 * JSON responses are bounded to 1 MiB and malformed or larger responses fail with reason response.
 * Calls start immediately, with cancellation returning CancelledError and unexpected defects rejecting with SdkDefect.
 * Requests default to a 30-second total deadline, allow bounded read retries and retry writes only after confirmed rate-limit rejection.
 * Shutdown rejects new work and awaits admitted request cleanup. Separate clients do not coordinate rate limits
 */
export interface Webhooks {
    /** Create one webhook using bot permissions. Returns redacted credentials separately from metadata. An uncertain result may have created it */
    create(
        channelId: string,
        input: WebhookCreate,
        options?: DefaultWebhookOperationOptions,
    ): ResultAsync<CreatedWebhook, WebhookOperationFailure | CancelledError | ConfigurationError>
    /** Fetch metadata remotely by decimal ID, discarding the returned token. HTTP 404 reports notFound */
    fetch(
        id: string,
        options?: DefaultWebhookOperationOptions,
    ): ResultAsync<Webhook, WebhookOperationFailure | CancelledError | ConfigurationError>
    /** Read the channel's complete accessible webhook list remotely, without caching, token retention or pagination */
    fetchChannel(
        channelId: string,
        options?: DefaultWebhookOperationOptions,
    ): ResultAsync<readonly Webhook[], WebhookOperationFailure | CancelledError | ConfigurationError>
    /** Read the guild's accessible webhook list remotely. Server permissions determine visibility, and concurrent changes prevent snapshot guarantees */
    fetchGuild(
        guildId: string,
        options?: DefaultWebhookOperationOptions,
    ): ResultAsync<readonly Webhook[], WebhookOperationFailure | CancelledError | ConfigurationError>
    /** Update explicit settings, including destination moves. Returned metadata omits credentials. Failure does not guarantee rollback */
    edit(
        id: string,
        input: WebhookEdit,
        options?: DefaultWebhookOperationOptions,
    ): ResultAsync<Webhook, WebhookOperationFailure | CancelledError | ConfigurationError>
    /** Delete the webhook and revoke its credential. Does not delete its old messages or restore the credential after a failure */
    delete(
        id: string,
        options?: DefaultWebhookOperationOptions,
    ): ResultAsync<void, WebhookOperationFailure | CancelledError | ConfigurationError>
}

/** Token-only HTTP client, without a bot token, gateway, caches or persistent storage.
 * Operations start immediately and return expected failures, while unexpected defects reject with SdkDefect.
 * Cleanup defects stop retries and retain any operation failure or cancellation in SdkDefect's safe reasons.
 * Requests default to a 30-second total deadline across admission, rate waits, retries and HTTP.
 * Cancellation interrupts only that operation and awaits request/body cleanup, without rolling back remote effects
 *
 * Errors contain only safe categories and status, never credential-bearing paths or upstream bodies.
 * JSON responses exceeding 1 MiB fail with reason response. Other client caches are not updated by this token-only client
 */
export interface WebhookClient {
    /** Credential identity, never a token-bearing URL */
    readonly id: string
    /** Immutable endpoint discovery and pure URL helpers for this webhook client's selected instance */
    readonly instance: Instance
    /** Fetch this credential's current remote metadata without bot authentication or retaining creator/private fields */
    fetch(
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<Webhook, WebhookOperationFailure | CancelledError | ConfigurationError>
    /** Update only this webhook's name or avatar through its credential. Channel moves require bot webhooks.edit.
     * Returns the remote token-safe metadata. A failed or cancelled write can have applied and does not close this client
     */
    edit(
        input: WebhookTokenEdit,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<Webhook, WebhookOperationFailure | CancelledError | ConfigurationError>
    /** Delete this remote webhook through its credential. HTTP 204 does not close this client or erase its local credential reference.
     * Later remote operations normally receive notFound after revocation. Use shutdown separately to release local resources
     */
    delete(
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, WebhookOperationFailure | CancelledError | ConfigurationError>
    /** Send with wait=true and return the created message. Mentions default off. Reply references can include files; forwarded references preserve only their source snapshot and reject new content/uploads.
     * Files use bounded multipart streaming, with 50 MiB maximum per file. Image/thumbnail attachment URLs match a new upload in this request. flags accepts only the two non-voice MessageFlags bits.
     * Snapshot inputs at execution, including admitted file bytes. Never retry an uncertain send, which may already have posted */
    send(
        input: WebhookMessageInput,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<Message, WebhookOperationFailure | CancelledError | ConfigurationError>
    /** Fetch a decimal message ID authored by this webhook in its current channel, with bounded transient read retries */
    fetchMessage(
        messageId: string,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<Message, WebhookOperationFailure | CancelledError | ConfigurationError>
    /** Edit this webhook's message and return its snapshot. Omitted fields remain unchanged, mentions default off, and attachments cannot be replaced.
     * flags-only edits replace the two writable non-voice bits; zero clears them. Existing file references are not resolved for embed inputs
     */
    editMessage(
        messageId: string,
        input: WebhookMessageEdit,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<Message, WebhookOperationFailure | CancelledError | ConfigurationError>
    /** Delete this webhook's message. 204 is success without proving earlier existence, and uncertain failures may follow deletion */
    deleteMessage(
        messageId: string,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, WebhookOperationFailure | CancelledError | ConfigurationError>
    /** Permanently reject new work, cancel admitted work, await transport cleanup and release the owned token reference.
     * Does not delete the remote webhook or invalidate caller-held credentials. Concurrent calls share the same pending cleanup
     */
    shutdown(): Promise<void>
}

/** Local cache controls. They never fetch, refresh, mutate remote resources, or expose diagnostics through callbacks */
export interface ClientCache {
    /**
     * Return up to limit already-observed frozen projections from one configured cache category in current eviction order.
     * Entries use least-to-most-recent order. Local lookups promote recency, while enumeration does not
     *
     * Omit limit for 100 entries. A positive safe integer from 1 through 1,000 is required.
     * Expired entries are released before the snapshot. Enumeration does not refresh data or change the eviction order.
     * The frozen array can be partial because retention, expiry, conflicts, gaps, clear and shutdown discard observations.
     * Entries contain the requested cached data, unlike client.diagnostics. No network request or remote completeness claim is made.
     * A closed client returns an empty array. Invalid kind or limit returns ConfigurationError without exposing the rejected value.
     * It takes no cancellation signal and completes synchronously
     */
    entries<K extends CacheKind>(
        kind: K,
        options?: CacheEntriesOptions,
    ): Result<readonly CachedResources[K][], ConfigurationError>
    /**
     * Release every SDK-held cache observation without changing cache configuration, caller-held frozen projections, requests or remote resources.
     * In-flight reads that began before this call cannot repopulate cleared observations. Later reads can cache normally.
     * Existing mutation guards retain their conservative invalidation behavior. Safe to repeat, including after closure.
     * It takes no cancellation signal and completes synchronously
     */
    clear(): void
}

/**
 * Default client with SDK-owned execution of asynchronous operations.
 * Malformed operation signals return ConfigurationError with field signal before execution; valid cancellation returns CancelledError.
 * Expected failures use ResultAsync Err values, while SDK defects reject with SdkDefect.
 * Cleanup defects stop retries and retain any operation failure or cancellation in SdkDefect's safe reasons.
 * Use run for a managed lifetime, or pair connect with waitForClose and shutdown
 */
export interface Client extends ClientState {
    /** Immutable endpoint discovery and pure URL helpers for this client's selected instance */
    readonly instance: Instance
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
    /** Bounded attachment downloads from this instance's discovered media base path */
    readonly attachments: Attachments
    /** REST, local lookup and live collection owned by this client */
    readonly messages: Messages
    /** Local cache enumeration and release controls. Caching remains opt-in through ClientOptions.cache */
    readonly cache: ClientCache
    /**
     * Register a callback for one EventMap event before or after connect. No cached history or REST-generated events.
     * Enabled cache changes happen before user dispatch, independently of subscriptions and their overflow.
     * Each subscription receives only its event type. Bulk deletions do not also invoke messageDelete handlers
     *
     * Default concurrency is 1. Receive-order starts do not imply completion order when concurrency is increased.
     * Buffer defaults are 256 pending event payloads and 4 MiB of source JSON, not a process heap cap.
     * A bulk payload counts once, including its full bytes. Ordering is per subscription, not across event types
     *
     * Overflow stops only this subscription. Handler failure is reported without retrying the invocation.
     * Return/await callback work and inspect send Err values. Unawaited application work is not owned by the SDK
     *
     * For the original application exception and stack, catch inside your callback and inspect it locally before rethrowing.
     * onError receives only safe event/kind metadata. Neither that hook nor SDK logs retain the original exception.
     * Keep credentials, payloads and arbitrary exception text out of logs. Select reviewed fields in your own diagnostic sink
     *
     * The second argument requests cooperative cancellation on unsubscribe or shutdown.
     * Observe the returned subscription's terminal outcome as well as the client's run/waitForClose outcome.
     * Local registration failures use Result. Unexpected synchronous defects throw SdkDefect
     * @example
     * ```ts
     * import type { Client, Message } from "@neontechspace/fluxerly"
     * export function debugHandlerExample(
     *     client: Client,
     *     handle: (message: Message) => Promise<void>,
     *     inspectFailure: (error: unknown) => void,
     * ) {
     *     return client.on("messageCreate", async (message) => {
     *         try {
     *             await handle(message)
     *         } catch (error) {
     *             // Application-owned inspection, for example a local debugger breakpoint, not raw logging
     *             try {
     *                 inspectFailure(error)
     *             } finally {
     *                 throw error // Preserve normal SDK isolation and safe onError reporting
     *             }
     *         }
     *     })
     * }
     * ```
     */
    on<K extends EventName>(
        event: K,
        handler: (message: EventMap[K], signal: NonNullable<OperationOptions["signal"]>) => void | Promise<void>,
        options?: EventHandlerOptions,
    ): Result<Subscription, RegistrationError>
    /**
     * Open one event type's bounded pull subscription in receive order without subscription history or bulk fan-out.
     * Enabled cache changes happen before delivery, independently of this subscription and its overflow.
     * Local errors use Result and defects throw SdkDefect
     */
    events<K extends EventName>(event: K, options?: EventBufferOptions): Result<EventSubscription<K>, RegistrationError>
    /**
     * Start observing one event type immediately and return the first future payload accepted by a synchronous filter.
     * No connection, history lookup, cache read or remote request is initiated
     *
     * Pending intake uses the same count/byte budgets as events. Reconnection can miss events and does not reset the deadline.
     * The default deadline is 30,000 ms from registration. Timeout or an invalid/throwing filter returns EventWaitError without raw input or exception text.
     * Inspect application-owned filter exceptions inside the filter before rethrowing, as with on callbacks
     *
     * Overflow, invalid configuration and client closure remain distinct failures. Abort returns CancelledError after subscription cleanup.
     * Completion releases queued payloads, the filter, timer and subscription. Unexpected SDK or cleanup defects reject with SdkDefect
     *
     * This returns an event result, not a registration handle. Use events or a collector when registration must be confirmed before triggering an action
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
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
        options?: DefaultEventWaitOptions<K>,
    ): ResultAsync<EventMap[K], EventWaitFailure | CancelledError | ConfigurationError>
    /**
     * Read an immutable point-in-time local occupancy snapshot without network work, telemetry, persistence, tokens, remote routes, resource IDs or payloads.
     * Counts cover this client's owned shards and admitted local work only. Accounted bytes are cache/queue budgets, not heap, process memory or remote storage.
     * Configured cache bounds remain visible after closure, while retained counts report actual owner release progress. This does not establish remote completeness or readiness.
     * It takes no cancellation signal and completes synchronously
     */
    diagnostics(): ClientDiagnostics
    /**
     * Connect and complete after every locally assigned shard authenticates and completes READY.
     * Readiness does not wait for GUILD_CREATE, a guild roster, or every resource to load
     *
     * Owns startup only, using the client's connection settings.
     * Cancellation or an expected failure before initial group readiness waits for assigned-shard cleanup and leaves the client Disconnected for reuse.
     * The signal becomes inert after success, while automatic recovery continues independently.
     * After all assigned shards are ready, a permanent required-shard failure in a multi-shard plan closes the client. waitForClose retains `ShardConnectionError { shardId, failure }`
     *
     * @returns Success if ready, or a connection, busy, closed or cancellation Err.
     * An already connected unmanaged client succeeds without opening another socket.
     * A competing call returns ClientBusyError without affecting the active operation
     * @throws SdkDefect as a rejection for an unexpected SDK or cleanup defect
     */
    connect(options?: OperationOptions): ResultAsync<void, ConnectError | CancelledError | ConfigurationError>
    /**
     * Own startup, connection, recovery and permanent cleanup as one operation.
     * Remains pending while the client is connected or recovering.
     * An accepted run leaves the client Closed on shutdown, failure or cancellation.
     * After all assigned shards are ready, a permanent required-shard failure in a multi-shard plan closes the client and reports `ShardConnectionError { shardId, failure }`
     *
     * Accepts only a Disconnected client without competing work.
     * Rejection before admission does not acquire or close the client.
     * The signal controls the accepted run's full lifetime, with cleanup awaited before completion
     *
     * @returns Success after normal shutdown, or a connection, busy, closed or cancellation Err
     * @throws SdkDefect as a rejection, including when cancellation or failure also encounters a cleanup defect
     *
     * @example
     * ```ts
     * import { createClient } from "@neontechspace/fluxerly"
     *
     * export async function runBot(token: string, signal: AbortSignal): Promise<void> {
     *     const created = createClient({ token })
     *     if (created.isErr()) throw created.error
     *     try {
     *         const result = await created.value.run({ signal })
     *         if (result.isErr() && result.error._tag !== "CancelledError") {
     *             console.error(result.error.message)
     *         }
     *     } catch {
     *         console.error("Unexpected SDK failure")
     *     }
     * }
     * ```
     */
    run(options?: OperationOptions): ResultAsync<void, ConnectError | CancelledError | ConfigurationError>
    /**
     * Observe the retained terminal outcome without starting or owning a connection.
     * Recovery keeps this wait pending, and late observers receive the same terminal outcome.
     * Cancelling this wait releases only this caller, not the client or other waiters.
     * After all assigned shards are ready, a permanent required-shard failure in a multi-shard plan closes the client and is retained as `ShardConnectionError { shardId, failure }`
     *
     * @returns Success after normal shutdown, a permanent connection failure, or CancelledError for this wait
     * @throws SdkDefect as a rejection for a retained unexpected background or cleanup defect
     */
    waitForClose(options?: OperationOptions): ResultAsync<void, ConnectionFailure | CancelledError | ConfigurationError>
    /**
     * Permanently stop startup and recovery, release credentials and await owned-resource cleanup.
     * Release cached message references and expiry timers, without waiting for application-owned reporter promises.
     * Abort active message/reaction collector callbacks and await their returned promises. Non-cooperative callbacks can delay shutdown.
     * Repeated and concurrent calls wait for the same shutdown outcome.
     * A pending connection call reports ClientClosedError rather than caller cancellation
     *
     * Established sockets get up to 5,000 ms for graceful closure, then forced termination and an awaited close event.
     * Pending handshakes terminate immediately, and forced termination may discard unsent data.
     * Accepts no cancellation signal that could abandon cleanup and never exits the application.
     * Create a new client to connect again
     *
     * @returns Success after cleanup, without an expected-error channel
     * @throws SdkDefect as a rejection if shutdown encounters an SDK or cleanup defect
     */
    shutdown(): ResultAsync<void, never>
    /**
     * Subscribe to the current state first, then only the newest pending update.
     * Callbacks run asynchronously and sequentially per subscriber, awaiting a returned promise.
     * Slow subscribers may miss intermediate states without delaying connection recovery.
     * Callback failures are reported without private error details and do not close the client
     *
     * @returns An unsubscribe function that drops pending delivery without stopping the client.
     * Unsubscription cannot cancel callback code that is already running.
     * Use waitForClose rather than state changes to observe terminal failure
     */
    observeState(listener: (state: ConnectionState) => void | Promise<void>): () => void
}

/**
 * One client's selected instance discovery result
 *
 * `resolve` starts the unauthenticated well-known request only when needed and
 * shares it with concurrent callers. Cancellation releases only this caller;
 * the last departing caller waits for discovery cleanup. A successful result is
 * immutable and retained without refresh until client shutdown
 *
 * @example
 * ```ts
 * import type { Client } from "@neontechspace/fluxerly"
 * export async function instanceExample(client: Client) {
 *     const resolved = await client.instance.resolve({ timeoutMs: 10_000 })
 *     if (resolved.isErr()) return resolved
 *     const channel = resolved.value.links.channel({ id: "1750000000000000000" })
 *     return channel.isErr() ? channel : { api: resolved.value.endpoints.apiPublic, channel: channel.value }
 * }
 * ```
 */
export interface Instance {
    /** Resolve this client's immutable selected-instance endpoint map and pure asset/link helpers.
     * This unauthenticated bootstrap has a 30,000 ms caller-local deadline unless overridden. Abort interrupts only this wait; another resolve, REST request or gateway connection can keep the shared read alive.
     * Expected document, rate-limit, timeout, closure and local timeout-option failures are returned as Err. A cleanup defect rejects with SdkDefect and retains its accompanying failure or interruption
     */
    resolve(
        options?: DefaultInstanceResolveOptions,
    ): ResultAsync<ResolvedInstance, InstanceResolveError | CancelledError | ConfigurationError>
}

/** Default selected-instance resolution settings. Abort cancels only this caller's wait */
export interface DefaultInstanceResolveOptions extends InstanceResolveOptions, OperationOptions {}

/** One eager default event wait. The optional signal cancels only this wait and never shuts down its client */
export interface DefaultEventWaitOptions<K extends EventName> extends EventWaitOptions<K>, OperationOptions {}

const executeOperation = <
    A,
    E extends
        | ConfigurationError
        | ConnectError
        | InstanceResolveError
        | EventReadError
        | EventWaitFailure
        | MessageError
        | MessageOperationError
        | MessageCleanupError
        | CollectorError
        | GuildOperationError
        | ChannelOperationError
        | WebhookOperationError
        | UserOperationError
        | BotApplicationOperationError
        | CountOperationError
        | MemberChunkError
        | PresenceError
        | PaginationError
        | AttachmentDownloadFailure
        | OAuthOperationFailure,
>(
    effect: Effect.Effect<A, E>,
    operation: Operation,
    options?: OperationOptions,
) => {
    let signal: OperationOptions["signal"]
    let abort: (() => void) | undefined
    let registered = false
    try {
        signal = options?.signal
        const invalidSignal = operationSignalError(signal)
        if (invalidSignal)
            return new ResultAsync<A, E | CancelledError | ConfigurationError>(Promise.resolve(err(invalidSignal)))
        if (signal?.aborted)
            return new ResultAsync<A, E | CancelledError | ConfigurationError>(
                Promise.resolve(err(new CancelledError())),
            )
        const controller = signal ? new AbortController() : undefined
        abort = () => controller?.abort()
        if (signal?.aborted) abort()
        else if (signal) {
            // Treat registration as owned before calling it: A custom signal can attach then throw
            registered = true
            signal.addEventListener("abort", abort, { once: true })
        }
        // Interrupt the operation itself rather than discarding a losing race's cleanup cause
        return new ResultAsync(
            (async () => {
                let exit: Exit.Exit<A, E>
                try {
                    exit = await Effect.runPromiseExit(effect, controller ? { signal: controller.signal } : undefined)
                } catch (error) {
                    exit = Exit.failCause(Cause.die(error))
                }
                if (registered) {
                    registered = false
                    try {
                        signal!.removeEventListener("abort", abort!)
                    } catch (error) {
                        exit = Exit.failCause(
                            Cause.combine(Exit.isFailure(exit) ? exit.cause : Cause.empty, Cause.die(error)),
                        )
                    }
                }
                return fromExit(exit, operation)
            })(),
        )
    } catch {
        let cleanupDefect = false
        if (registered) {
            registered = false
            try {
                signal!.removeEventListener("abort", abort!)
            } catch {
                cleanupDefect = true
            }
        }
        return new ResultAsync<A, E | CancelledError | ConfigurationError>(
            Promise.reject(
                new SdkDefect(
                    operation,
                    cleanupDefect ? [{ kind: "Defect" }, { kind: "Defect" }] : [{ kind: "Defect" }],
                ),
            ),
        )
    }
}

function defaultCollector(source: MessageCollector): Collector {
    return Object.freeze({
        stop: () => source.stop(),
        waitForClose: (options?: OperationOptions) =>
            executeOperation(Deferred.await(source.closed), "collector.waitForClose", options),
    })
}

function collectorHandler<A>(
    handler: (item: A, signal: NonNullable<OperationOptions["signal"]>) => void | Promise<void>,
) {
    return (item: A) =>
        Effect.suspend(() => {
            const controller = new AbortController()
            let settled: Promise<void> = Promise.resolve()
            return Effect.callback<void, CollectorError>((resume) => {
                settled = Promise.resolve()
                    .then(() => handler(item, controller.signal))
                    .then(
                        () => {
                            resume(Effect.void)
                        },
                        () => {
                            resume(Effect.fail(new CollectorError("handler")))
                        },
                    )
            }).pipe(
                Effect.ensuring(
                    Effect.promise(async () => {
                        controller.abort()
                        await settled
                    }),
                ),
            )
        })
}

function defaultTypingTask<A>(task: (signal: NonNullable<OperationOptions["signal"]>) => PromiseLike<A>) {
    return Effect.suspend(() => {
        const controller = new AbortController()
        let settled: Promise<A> = Promise.resolve(undefined as A)
        return Effect.callback<A>((resume) => {
            settled = Promise.resolve().then(() => task(controller.signal))
            void settled.then(
                (value) => resume(Effect.succeed(value)),
                (error) => resume(Effect.die(error)),
            )
        }).pipe(
            Effect.onExit((exit) =>
                Effect.promise(async () => {
                    controller.abort()
                    // The callback already delivered a settled task rejection as this exit's defect
                    // Only a rejection that arrives while cancellation is cleaning up needs another Cause reason
                    if (Exit.isFailure(exit) && Cause.hasDies(exit.cause)) return
                    await settled
                }),
            ),
        )
    })
}

function fromExit<
    A,
    E extends
        | ConnectError
        | ConfigurationError
        | EventReadError
        | EventWaitFailure
        | MessageError
        | MessageOperationError
        | MessageCleanupError
        | CollectorError
        | GuildOperationError
        | ChannelOperationError
        | WebhookOperationError
        | UserOperationError
        | BotApplicationOperationError
        | CountOperationError
        | MemberChunkError
        | PresenceError
        | PaginationError
        | AttachmentDownloadFailure
        | OAuthOperationFailure,
>(exit: Exit.Exit<A, E>, operation: Operation): Result<A, E | CancelledError> {
    if (Exit.isSuccess(exit)) return ok(exit.value)
    if (Cause.hasDies(exit.cause)) {
        const reasons: DefectReason[] = exit.cause.reasons.map((reason) =>
            reason._tag === "Fail"
                ? { kind: "Failure", failure: reason.error }
                : { kind: reason._tag === "Die" ? "Defect" : "Interruption" },
        )
        throw new SdkDefect(operation, reasons)
    }
    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    return failure?._tag === "Fail" ? err(failure.error) : err(new CancelledError())
}

/**
 * Create a webhook-only client for hosted Fluxer or an explicitly selected self-hosted instance, from { id, token } or redacted creation credentials.
 * Validate locally without requests, copying the credential into an independently owned redacted reference.
 * Creation is synchronous and callers must await shutdown in finally.
 * No token storage, gateway or bot authentication. Keep one client per credential for shared admission and rate waits.
 * Returns ConfigurationError for invalid configuration, while unexpected creation defects throw SdkDefect
 * @example
 * ```ts
 * import { createWebhookClient } from "@neontechspace/fluxerly"
 * export async function webhookExample(id: string, token: string) {
 *     const created = createWebhookClient({ id, token })
 *     if (created.isErr()) return created
 *     const webhook = created.value
 *     try {
 *         const message = await webhook.send({ content: "Deploying…" })
 *         return message.isErr() ? message : await webhook.editMessage(message.value.id, { content: "Deployed" })
 *     } finally { await webhook.shutdown() }
 * }
 * ```
 */
export function createWebhookClient(options: WebhookClientOptions): Result<WebhookClient, ConfigurationError> {
    const result = fromExit(Effect.runSyncExit(makeWebhookClient(options)), "createWebhookClient")
    if (result.isErr()) {
        if (result.error instanceof ConfigurationError) return err(result.error)
        throw new SdkDefect("createWebhookClient")
    }
    const owner = result.value
    const execute = executeOperation
    return ok(
        Object.freeze({
            id: owner.id,
            instance: Object.freeze({
                resolve: (options?: DefaultInstanceResolveOptions) =>
                    execute(owner.instance.resolveInfo(options), "instance.resolve", options),
            }),
            fetch: (options?: DefaultMessageOperationOptions) =>
                execute(
                    owner.run("webhooks.fetchToken", () => webhookTokenFetch(owner.id), options),
                    "webhooks.fetchToken",
                    options,
                ),
            edit: (input: WebhookTokenEdit, options?: DefaultMessageOperationOptions) =>
                execute(
                    owner.run("webhooks.editToken", () => webhookTokenEdit(owner.id, input), options),
                    "webhooks.editToken",
                    options,
                ),
            delete: (options?: DefaultMessageOperationOptions) =>
                execute(
                    owner.run("webhooks.deleteToken", () => webhookTokenDelete(owner.id), options),
                    "webhooks.deleteToken",
                    options,
                ),
            send: (input: WebhookMessageInput, options?: DefaultMessageOperationOptions) =>
                execute(
                    owner.run("webhooks.send", () => webhookSend(owner.id, input), options),
                    "webhooks.send",
                    options,
                ),
            fetchMessage: (id: string, options?: DefaultMessageOperationOptions) =>
                execute(
                    owner.run("webhooks.fetchMessage", () => webhookMessage(owner.id, id, "GET"), options),
                    "webhooks.fetchMessage",
                    options,
                ),
            editMessage: (id: string, input: WebhookMessageEdit, options?: DefaultMessageOperationOptions) =>
                execute(
                    owner.run("webhooks.editMessage", () => webhookMessage(owner.id, id, "PATCH", input), options),
                    "webhooks.editMessage",
                    options,
                ),
            deleteMessage: (id: string, options?: DefaultMessageOperationOptions) =>
                execute(
                    owner.run("webhooks.deleteMessage", () => webhookMessageDelete(owner.id, id), options),
                    "webhooks.deleteMessage",
                    options,
                ),
            shutdown: async () => {
                const result = fromExit(await Effect.runPromiseExit(owner.shutdown()), "shutdown")
                if (result.isErr()) throw new SdkDefect("shutdown")
            },
        }),
    )
}

/** Process-local outgoing bot presence and explicitly selected inbound member-presence intent.
 * Outgoing status updates fan out to every live locally owned shard and are spaced by at least four seconds per shard. Member selections are separate bounded Op14 requests.
 * No provider acknowledgement or recipient-delivery guarantee is available. The SDK performs no remote membership lookup or self filtering; Fluxer owns access and filtering
 */
export interface Presence {
    /** Synchronously validate and freeze the latest requested status/custom status, including before connect.
     * Omitted customStatus preserves this client's previous request; null clears it, and expired custom statuses are not restored.
     * Success means local acceptance and scheduled per-shard fanout, not an atomic provider acknowledgement across shards. Shutdown releases the intent and pending timer
     * @example
     * ```ts
     * import { MemberMentionPreferences, type Client } from "@neontechspace/fluxerly"
     * export async function botProfileExample(client: Client, guildId: string) {
     *     const presence = client.presence.set({ status: "online", customStatus: { text: "Ready", emoji: { name: "🌱" } } })
     *     if (presence.isErr()) return presence
     *     return client.members.editSelf(guildId, { nickname: "Support", mentionFlags: MemberMentionPreferences.PreferNoMention })
     * }
     * ```
     * Unexpected defects throw SdkDefect
     */
    set(input: PresenceInput): Result<void, PresenceFailure>
    /**
     * Synchronously validate, copy and retain this guild's selected member IDs. Pass `[]` to clear its selection.
     * The SDK neither fetches members nor subscribes all guild members. Select accessible non-self members deliberately; Fluxer remains authoritative for access and filtering
     *
     * The guild must route to a shard assigned to this client. An unassigned guild returns PresenceError input instead of retaining an unsent selection
     *
     * Input accepts at most 1,000 distinct decimal IDs, but the full UTF-8 Op14 frame must be at most 4,096 bytes, so long IDs lower the effective per-guild maximum.
     * This client retains selections for at most 100 guilds and 10,000 IDs. A cleared selection that was already sent retains one bounded session slot until a fresh identify or a confirmed leave, because a local socket write has no provider acknowledgement. Clearing an unsent selection releases its slot immediately
     *
     * After READY or RESUMED, the latest selection or clear is coalesced and attempted at most once per 125 ms. Calling setMembers with the same list deliberately requests a caller-controlled refresh; matching guild creation also reattempts the latest selection or a previously sent clear. This neither establishes that Fluxer applied it nor that `on("presenceUpdate")` will deliver anything.
     * A subscription can yield an initial visible state or later transitions; recovery gaps can miss both. Presence is never cached or looked up.
     * Loss of shared channel visibility can drop provider subscriptions; resend the set after access returns
     *
     * Listener closure does not clear the selection. Clear explicitly or shut down the client to release its local intent.
     * Input and limit failures return PresenceError, while a closing client returns ClientClosedError. Unexpected defects throw SdkDefect
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export function watchSelectedMember(client: Client, guildId: string, memberId: string) {
     *     const subscription = client.on("presenceUpdate", (presence) => {
     *         if (presence.guildId === guildId && presence.userId === memberId) void presence.status
     *     })
     *     if (subscription.isErr()) return subscription
     *     const selected = client.presence.setMembers(guildId, [memberId])
     *     if (selected.isOk()) return subscription
     *     subscription.value.unsubscribe()
     *     return selected
     * }
     * ```
     */
    setMembers(guildId: string, memberIds: readonly string[]): Result<void, PresenceFailure>
}

/** Authenticated current-bot application read through GET `/oauth2/applications/@me`, independent of gateway readiness.
 * Starts immediately with the shared 30-second total deadline and at most two transient read retries; abort returns CancelledError after cleanup.
 * Returns a frozen no-cache allowlist only. Owner identity, redirect URIs, verification keys, client secrets, and nested bot fields are never exposed.
 * Fluxer remains authoritative for application visibility and installability; this read neither manages an application nor opens an authorization page.
 * Input, HTTP, and malformed-response failures use BotApplicationOperationError; closure uses ClientClosedError; unexpected defects reject with SdkDefect
 *
 * @example
 * ```ts
 * import { links, type Client } from "@neontechspace/fluxerly"
 * export async function applicationExample(client: Client) {
 *     const application = await client.application.fetchCurrent()
 *     return application.isErr() ? application : links.installation(application.value.id, { permissions: 0n })
 * }
 * ```
 */
export interface CurrentBotApplication {
    /** Fetch this token's frozen application allowlist remotely, without a cache write, gateway event, owner lookup, or hidden follow-up request */
    fetchCurrent(
        options?: DefaultBotApplicationOperationOptions,
    ): ResultAsync<BotApplication, BotApplicationOperationFailure | CancelledError | ConfigurationError>
}

/** Immediate ResultAsync operations with shared 30-second default deadlines and bounded read retries.
 * Writes retry only confirmed rate-limit rejection, never an unknown outcome. No gateway connection is required.
 * Abort returns CancelledError after cleanup; unexpected defects reject with SdkDefect
 */
export interface Users {
    /** Local optional-cache lookup by decimal ID, without a request. A hit promotes recency but not observation age. May miss or be stale; closed clients fail */
    get(id: string): Result<User | undefined, UserOperationFailure>
    /** Fetch a public account snapshot remotely by decimal ID; unknown IDs fail with notFound */
    fetch(
        id: string,
        options?: DefaultUserOperationOptions,
    ): ResultAsync<User, UserOperationFailure | CancelledError | ConfigurationError>
    /** Fetch one frozen privacy-filtered profile by decimal user ID, optionally in an explicit guild context.
     * Starts immediately without a gateway connection, hidden member fetch or account/profile cache read, write or invalidation.
     * Returns allowlisted account identity and profile fields. isLimited reports Fluxer's privacy restriction, not missing membership.
     * A null guildProfile means no contextual profile was supplied; it is not proof that the account is outside the guild.
     * Uses Users' shared deadline and bounded read retries. Fluxer may clear expired premium state while serving this GET.
     * Invalid IDs/query, denied access and malformed responses use UserOperationError operation users.fetchProfile.
     * Cancellation affects this request only and returns CancelledError after cleanup; SDK/cleanup defects reject with SdkDefect
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export function profileExample(client: Client, userId: string, guildId: string) {
     *     return client.users.fetchProfile(userId, { guildId })
     * }
     * ```
     */
    fetchProfile(
        id: string,
        query?: UserProfileQuery,
        options?: DefaultUserOperationOptions,
    ): ResultAsync<UserProfile, UserOperationFailure | CancelledError | ConfigurationError>
    /** Fetch the authenticated bot remotely, stripping private account fields */
    fetchSelf(
        options?: DefaultUserOperationOptions,
    ): ResultAsync<User, UserOperationFailure | CancelledError | ConfigurationError>
}

/** Immediate ResultAsync operations with shared 30-second default deadlines and bounded read retries.
 * Writes retry only confirmed rate-limit rejection, never an unknown outcome. No gateway connection is required.
 * Abort returns CancelledError after cleanup; unexpected defects reject with SdkDefect
 */
export interface DirectMessages {
    /** Open/reopen a DM and send using one total deadline, with mentions disabled by default and files snapshotted before opening.
     * MessageError(notSent) does not mean opening was undone. Unknown sends are never repeated automatically.
     * No reply reference is accepted here; use messages.reply after obtaining a channel/message reference
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     * export async function notifyUserExample(client: Client, userId: string) {
     *     const user = await client.users.fetch(userId)
     *     if (user.isErr()) return user
     *     return client.directMessages.send(user.value.id, { content: `Hello ${user.value.displayName ?? user.value.username}` })
     * }
     * ```
     */
    send(
        userId: string,
        input: ReplyInput,
        options?: DefaultSendOptions,
    ): ResultAsync<Message, SendError | CancelledError | ConfigurationError>
    /** Local optional-cache lookup by decimal ID, without a request. A hit promotes recency but not observation age. May miss or be stale; closed clients fail */
    get(id: string): Result<DirectMessageChannel | undefined, UserOperationFailure>
    /** Open or reopen a one-to-one conversation. Privacy checks may prevent delivery even after opening succeeds */
    open(
        userId: string,
        options?: DefaultUserOperationOptions,
    ): ResultAsync<DirectMessageChannel, UserOperationFailure | CancelledError | ConfigurationError>
    /** Fetch a private channel remotely. Guild channels are rejected as invalid responses */
    fetch(
        id: string,
        options?: DefaultUserOperationOptions,
    ): ResultAsync<DirectMessageChannel, UserOperationFailure | CancelledError | ConfigurationError>
    /** Read open one-to-one and group conversations remotely, excluding personal notes. This is not an atomic snapshot or a complete message history */
    fetchAll(
        options?: DefaultUserOperationOptions,
    ): ResultAsync<readonly DirectMessageChannel[], UserOperationFailure | CancelledError | ConfigurationError>
    /** Fetch the latest message for 1–100 explicitly selected distinct DM/group-DM IDs through Fluxer's batch endpoint.
     * POST is read-shaped but is not retried after a dispatched uncertain failure. It does not enumerate conversations or hydrate any cache.
     * Returned null is ambiguous. omittedChannelIds preserves requested IDs Fluxer omitted, rather than treating omission as null, an empty channel or access denial
     */
    fetchLatestMessages(
        channelIds: readonly string[],
        options?: DefaultUserOperationOptions,
    ): ResultAsync<DirectMessageLatestMessages, UserOperationFailure | CancelledError | ConfigurationError>
    /** Edit explicit group settings. Fluxer enforces member/owner permissions; failure does not guarantee rollback */
    editGroup(
        id: string,
        input: DirectMessageGroupEdit,
        options?: DefaultUserOperationOptions,
    ): ResultAsync<DirectMessageChannel, UserOperationFailure | CancelledError | ConfigurationError>
    /** Close a DM for this bot or leave a group. Does not erase another recipient's conversation; owner departure may transfer ownership */
    close(
        id: string,
        options?: DefaultUserOperationOptions,
    ): ResultAsync<void, UserOperationFailure | CancelledError | ConfigurationError>
    /** Remove a group recipient as owner, or remove self. Does not request deletion of that user's messages; a last-recipient departure deletes the group */
    removeRecipient(
        id: string,
        userId: string,
        options?: DefaultUserOperationOptions,
    ): ResultAsync<void, UserOperationFailure | CancelledError | ConfigurationError>
}

/**
 * Create a Disconnected client without sockets, timers or process-signal handlers
 *
 * Omit `instance` for hosted Fluxer, or select a self-hosted root whose unauthenticated well-known document supplies REST, gateway and projection endpoints lazily.
 * HTTPS and WSS are required unless that explicit instance sets `allowInsecure: true` for a local or self-hosted HTTP/WS deployment
 *
 * Validate configuration locally without authenticating the token
 *
 * Cache settings are copied and validated here without invoking retention policies or reporters.
 * Unknown cache or message-cache option keys fail validation. Caching is disabled by default.
 * Connection settings default to a 30,000 ms overall startup budget and three total attempts per assigned shard
 *
 * A sharded plan fixes this client's local IDs for its lifetime. Shard zero receives direct-message gateway traffic, and REST/cache budgets remain client-wide
 *
 * @example
 * ```ts
 * import { createClient } from "@neontechspace/fluxerly"
 *
 * export function shardingExample(token: string) {
 *     return createClient({ token, sharding: { totalShards: 4, shardIds: [0, 2] } })
 * }
 * ```
 *
 * @returns The client, or ConfigurationError without the rejected input value
 * @throws SdkDefect synchronously for an unexpected creation defect
 */
export function createClient(options: ClientOptions): Result<Client, ConfigurationError> {
    const scope = Scope.makeUnsafe()
    const exit = Effect.runSyncExit(makeClient(options, scope))
    if (Exit.isFailure(exit)) {
        if (Cause.hasDies(exit.cause)) throw new SdkDefect()
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
        if (failure?._tag === "Fail") return err(failure.error)
        throw new SdkDefect()
    }
    const owner = exit.value
    const execute = <
        A,
        E extends
            | ConfigurationError
            | ConnectError
            | InstanceResolveError
            | EventReadError
            | EventWaitFailure
            | MessageError
            | MessageOperationError
            | MessageCleanupError
            | CollectorError
            | GuildOperationError
            | ChannelOperationError
            | WebhookOperationError
            | UserOperationError
            | BotApplicationOperationError
            | CountOperationError
            | MemberChunkError
            | PresenceError
            | PaginationError
            | AttachmentDownloadFailure
            | OAuthOperationFailure,
    >(
        effect: Effect.Effect<A, E>,
        operation: Operation,
        options?: OperationOptions,
    ) => executeOperation(owner.logging.provide(effect), operation, options)
    const iterate = <A, E extends MessageOperationFailure | GuildOperationFailure | PaginationError>(
        create: (
            options: import("./messages.js").MessageOperationOptions,
        ) => Effect.Effect<Pagination<A, E>, PaginationError>,
        operation: PaginationOperation,
        options?: DefaultMessageOperationOptions,
    ): AsyncIterable<
        Result<A, E | PaginationError | CancelledError | ConfigurationError | import("./errors.js").ClientClosedError>
    > =>
        Object.freeze({
            async *[Symbol.asyncIterator]() {
                const opened = await execute(
                    Effect.gen(function* () {
                        const invalidSignal = operationSignalError(options?.signal)
                        if (invalidSignal) return yield* Effect.fail(invalidSignal)
                        const copied = iterationOptions(options)
                        if (copied instanceof InputValidationFailure)
                            return yield* Effect.fail(new PaginationError(operation, "input", copied.detail))
                        const source = yield* create(copied.request)
                        return { source, signal: copied.signal }
                    }),
                    operation,
                )
                if (opened.isErr()) {
                    yield err(opened.error)
                    return
                }
                const { source, signal } = opened.value
                try {
                    while (!source.done) {
                        const result = await execute(
                            source.next,
                            operation,
                            signal === undefined ? undefined : { signal },
                        )
                        if (result.isErr()) {
                            source.close()
                            yield err(result.error)
                            return
                        }
                        if (result.value === undefined) return
                        yield ok(result.value)
                    }
                } finally {
                    source.close()
                }
            },
        })
    const iterateMemberChunks = (
        guildId: string,
        query: MemberChunkQuery,
        options?: DefaultMemberChunkOptions,
    ): AsyncIterable<Result<MemberChunk, MemberChunkFailure | CancelledError | ConfigurationError>> =>
        Object.freeze({
            async *[Symbol.asyncIterator]() {
                const operation = "members.iterateChunks"
                const opened = await execute(
                    Effect.gen(function* () {
                        const invalidSignal = operationSignalError(options?.signal)
                        if (invalidSignal) return yield* Effect.fail(invalidSignal)
                        const copied = memberChunkIterationOptions(options)
                        if (copied instanceof InputValidationFailure)
                            return yield* Effect.fail(new MemberChunkError("input", null, copied.detail))
                        if (copied.signal?.aborted) return yield* Effect.interrupt
                        const source = yield* owner.memberChunks.open(guildId, query, copied.request)
                        if (copied.signal) source.bindSignal(copied.signal)
                        return source
                    }),
                    operation,
                )
                if (opened.isErr()) {
                    yield err(opened.error)
                    return
                }
                const source = opened.value
                try {
                    while (true) {
                        const result = await execute(source.next, operation)
                        if (result.isErr()) {
                            yield err(result.error)
                            return
                        }
                        if (result.value === undefined) return
                        yield ok(result.value)
                    }
                } finally {
                    await execute(source.close, operation)
                }
            },
        })
    const attachmentStream = (
        attachment: Attachment,
        options: DefaultAttachmentStreamOptions,
    ): AsyncIterable<Result<Uint8Array, AttachmentDownloadFailure | CancelledError | ConfigurationError>> => {
        let consumed = false
        return Object.freeze({
            [Symbol.asyncIterator](): AsyncIterator<
                Result<Uint8Array, AttachmentDownloadFailure | CancelledError | ConfigurationError>
            > {
                if (consumed) {
                    let delivered = false
                    return {
                        async next() {
                            if (delivered) return { done: true, value: undefined }
                            delivered = true
                            return { done: false, value: err(new AttachmentDownloadError("busy")) }
                        },
                        async return() {
                            return { done: true, value: undefined }
                        },
                        async throw(
                            error?: unknown,
                        ): Promise<
                            IteratorResult<
                                Result<Uint8Array, AttachmentDownloadFailure | CancelledError | ConfigurationError>
                            >
                        > {
                            throw error
                        },
                    }
                }
                consumed = true
                const controller = new AbortController()
                const signal = options?.signal
                let removeSignal: (() => void) | undefined
                let source: AttachmentDownloadSource | undefined
                let opening:
                    | ResultAsync<
                          AttachmentDownloadSource,
                          AttachmentDownloadFailure | CancelledError | ConfigurationError
                      >
                    | undefined
                let closed = false
                let bound = false
                let pulling = false
                const bindSignal = () => {
                    if (
                        removeSignal ||
                        !signal ||
                        typeof signal.aborted !== "boolean" ||
                        typeof signal.addEventListener !== "function" ||
                        typeof signal.removeEventListener !== "function"
                    )
                        return
                    const abort = () => controller.abort()
                    signal.addEventListener("abort", abort, { once: true })
                    removeSignal = () => signal.removeEventListener("abort", abort)
                    if (signal.aborted) abort()
                }
                const open = () => {
                    const invalidSignal = operationSignalError(signal)
                    if (invalidSignal)
                        return new ResultAsync<AttachmentDownloadSource, ConfigurationError>(
                            Promise.resolve(err(invalidSignal)),
                        )
                    bindSignal()
                    opening ??= execute(owner.streamAttachment(attachment, options), "attachments.stream", {
                        signal: controller.signal,
                    })
                    return opening
                }
                const detach = async () => {
                    removeSignal?.()
                    removeSignal = undefined
                    controller.abort()
                    const opened = opening && (await opening)
                    if (!opened || opened.isErr()) return
                    const cleaned = await execute((source ?? opened.value).closeEffect, "attachments.stream")
                    if (cleaned.isErr()) throw cleaned.error
                }
                const bind = () => {
                    if (bound) return
                    bound = true
                    source!.bindSignal(controller.signal, () => {
                        removeSignal?.()
                        removeSignal = undefined
                    })
                }
                return {
                    async next(): Promise<
                        IteratorResult<
                            Result<Uint8Array, AttachmentDownloadFailure | CancelledError | ConfigurationError>
                        >
                    > {
                        if (closed) return { done: true, value: undefined }
                        if (pulling) return { done: false, value: err(new AttachmentDownloadError("busy")) }
                        pulling = true
                        try {
                            const opened = await open()
                            if (opened.isErr()) {
                                closed = true
                                await detach()
                                return { done: false, value: err(opened.error) }
                            }
                            source = opened.value
                            bind()
                            if (closed) return { done: true, value: undefined }
                            const chunk = await execute(source.next, "attachments.stream")
                            if (chunk.isErr()) {
                                closed = true
                                await detach()
                                return { done: false, value: err(chunk.error) }
                            }
                            if (chunk.value === undefined) {
                                closed = true
                                await detach()
                                return { done: true, value: undefined }
                            }
                            return { done: false, value: ok(chunk.value) }
                        } catch (error) {
                            closed = true
                            await detach()
                            throw error
                        } finally {
                            pulling = false
                        }
                    },
                    async return(): Promise<
                        IteratorResult<
                            Result<Uint8Array, AttachmentDownloadFailure | CancelledError | ConfigurationError>
                        >
                    > {
                        if (!closed) {
                            closed = true
                            await detach()
                        }
                        return { done: true, value: undefined }
                    },
                    async throw(
                        error?: unknown,
                    ): Promise<
                        IteratorResult<
                            Result<Uint8Array, AttachmentDownloadFailure | CancelledError | ConfigurationError>
                        >
                    > {
                        if (!closed) {
                            closed = true
                            await detach()
                        }
                        throw error
                    },
                }
            },
        })
    }
    const subscription = (source: Pick<EventSource, "stop" | "closed">): Subscription =>
        Object.freeze({
            unsubscribe: () => source.stop(),
            waitForClose: (options?: OperationOptions) =>
                execute(Deferred.await(source.closed), "subscription.waitForClose", options),
        })
    const lookup = <
        A,
        E extends GuildOperationFailure | ChannelOperationFailure | UserOperationFailure | PresenceFailure,
    >(
        effect: Effect.Effect<A, E>,
        operation: Operation,
    ): Result<A, E> => {
        const result = Effect.runSyncExit(effect)
        if (Exit.isSuccess(result)) return ok(result.value)
        if (Cause.hasDies(result.cause) || Cause.hasInterrupts(result.cause)) throw new SdkDefect(operation)
        const failure = result.cause.reasons.find((reason) => reason._tag === "Fail")
        if (failure?._tag === "Fail") return err(failure.error)
        throw new SdkDefect(operation)
    }
    const register = <A>(
        effect: Effect.Effect<A, RegistrationError>,
        operation: "on" | "events",
    ): Result<A, RegistrationError> => {
        const exit = Effect.runSyncExit(owner.logging.provide(effect))
        if (Exit.isSuccess(exit)) return ok(exit.value)
        if (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause)) throw new SdkDefect(operation)
        const reason = exit.cause.reasons.find((reason) => reason._tag === "Fail")
        if (reason?._tag === "Fail") return err(reason.error)
        throw new SdkDefect(operation)
    }
    const cacheEntries = <K extends CacheKind>(
        kind: K,
        options?: CacheEntriesOptions,
    ): Result<readonly CachedResources[K][], ConfigurationError> => {
        const exit = Effect.runSyncExit(owner.cacheEntries(kind, options))
        if (Exit.isSuccess(exit)) return ok(exit.value)
        if (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause)) throw new SdkDefect("cache.entries")
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
        if (failure?._tag === "Fail") return err(failure.error)
        throw new SdkDefect("cache.entries")
    }
    return ok(
        Object.freeze({
            instance: Object.freeze({
                resolve: (options?: DefaultInstanceResolveOptions) =>
                    execute(owner.instance.resolveInfo(options), "instance.resolve", options),
            }),
            presence: Object.freeze({
                set: (input: PresenceInput) => lookup(owner.setPresence(input), "presence.set"),
                setMembers: (guildId: string, memberIds: readonly string[]) =>
                    lookup(owner.setPresenceMembers(guildId, memberIds), "presence.setMembers"),
            }),
            cache: Object.freeze({
                entries: <K extends CacheKind>(kind: K, options?: CacheEntriesOptions) => cacheEntries(kind, options),
                clear: () => owner.clearCache(),
            }),
            application: Object.freeze({
                fetchCurrent: (options?: DefaultBotApplicationOperationOptions) =>
                    execute(
                        owner.application("application.fetchCurrent", () => applicationCurrent(), options),
                        "application.fetchCurrent",
                        options,
                    ),
            }),
            users: Object.freeze({
                get: (id: string) => lookup(owner.getUserResource("users", id), "users.get"),
                fetch: (id: string, options?: DefaultUserOperationOptions) =>
                    execute(
                        owner.user("users.fetch", () => userFetch(id), options),
                        "users.fetch",
                        options,
                    ),
                fetchSelf: (options?: DefaultUserOperationOptions) =>
                    execute(
                        owner.user("users.fetchSelf", () => userFetch("@me"), options),
                        "users.fetchSelf",
                        options,
                    ),
                fetchProfile: (id: string, query?: UserProfileQuery, options?: DefaultUserOperationOptions) =>
                    execute(
                        owner.user("users.fetchProfile", () => userProfile(id, query), options),
                        "users.fetchProfile",
                        options,
                    ),
            }),
            directMessages: Object.freeze({
                send: (userId: string, input: ReplyInput, options?: DefaultSendOptions) =>
                    execute(owner.sendDirectMessage(userId, input, options), "directMessages.send", options),
                get: (id: string) => lookup(owner.getUserResource("directMessages", id), "directMessages.get"),
                open: (userId: string, options?: DefaultUserOperationOptions) =>
                    execute(
                        owner.user("directMessages.open", () => directMessageOpen(userId), options),
                        "directMessages.open",
                        options,
                    ),
                fetch: (id: string, options?: DefaultUserOperationOptions) =>
                    execute(
                        owner.user("directMessages.fetch", () => directMessageFetch(id), options),
                        "directMessages.fetch",
                        options,
                    ),
                fetchAll: (options?: DefaultUserOperationOptions) =>
                    execute(
                        owner.user("directMessages.fetchAll", () => directMessageList(), options),
                        "directMessages.fetchAll",
                        options,
                    ),
                fetchLatestMessages: (ids: readonly string[], options?: DefaultUserOperationOptions) =>
                    execute(
                        owner.user(
                            "directMessages.fetchLatestMessages",
                            () => directMessageLatestMessages(ids),
                            options,
                        ),
                        "directMessages.fetchLatestMessages",
                        options,
                    ),
                editGroup: (id: string, input: DirectMessageGroupEdit, options?: DefaultUserOperationOptions) =>
                    execute(
                        owner.user("directMessages.editGroup", () => directMessageEdit(id, input), options),
                        "directMessages.editGroup",
                        options,
                    ),
                close: (id: string, options?: DefaultUserOperationOptions) =>
                    execute(
                        owner.user("directMessages.close", () => directMessageClose(id), options),
                        "directMessages.close",
                        options,
                    ),
                removeRecipient: (id: string, userId: string, options?: DefaultUserOperationOptions) =>
                    execute(
                        owner.user("directMessages.removeRecipient", () => directMessageClose(id, userId), options),
                        "directMessages.removeRecipient",
                        options,
                    ),
            }),
            webhooks: Object.freeze({
                create: (id: string, input: WebhookCreate, options?: DefaultWebhookOperationOptions) =>
                    execute(
                        owner.webhook("webhooks.create", () => webhookCreate(id, input, options), options),
                        "webhooks.create",
                        options,
                    ),
                fetch: (id: string, options?: DefaultWebhookOperationOptions) =>
                    execute(
                        owner.webhook("webhooks.fetch", () => webhookFetch(id), options),
                        "webhooks.fetch",
                        options,
                    ),
                fetchChannel: (id: string, options?: DefaultWebhookOperationOptions) =>
                    execute(
                        owner.webhook("webhooks.fetchChannel", () => webhookList(id, "channels"), options),
                        "webhooks.fetchChannel",
                        options,
                    ),
                fetchGuild: (id: string, options?: DefaultWebhookOperationOptions) =>
                    execute(
                        owner.webhook("webhooks.fetchGuild", () => webhookList(id, "guilds"), options),
                        "webhooks.fetchGuild",
                        options,
                    ),
                edit: (id: string, input: WebhookEdit, options?: DefaultWebhookOperationOptions) =>
                    execute(
                        owner.webhook("webhooks.edit", () => webhookEdit(id, input, options), options),
                        "webhooks.edit",
                        options,
                    ),
                delete: (id: string, options?: DefaultWebhookOperationOptions) =>
                    execute(
                        owner.webhook("webhooks.delete", () => webhookDelete(id, options), options),
                        "webhooks.delete",
                        options,
                    ),
            }),
            emojis: Object.freeze({
                get: (target: ExpressionReference) => lookup(owner.getResource("emojis", target), "emojis.get"),
                fetchAll: (id: string, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("emojis.fetchAll", () => expressionList("emojis", id), options),
                        "emojis.fetchAll",
                        options,
                    ),
                fetchMetadata: (id: string, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("emojis.fetchMetadata", () => expressionMetadata("emojis", id), options),
                        "emojis.fetchMetadata",
                        options,
                    ),
                create: (id: string, input: EmojiCreate, options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild("emojis.create", () => expressionCreate("emojis", id, input, options), options),
                        "emojis.create",
                        options,
                    ),
                createMany: (id: string, input: readonly EmojiCreate[], options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild("emojis.createMany", () => expressionBatch("emojis", id, input, options), options),
                        "emojis.createMany",
                        options,
                    ),
                clone: (id: string, sourceId: string, options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild("emojis.clone", () => expressionClone("emojis", id, sourceId, options), options),
                        "emojis.clone",
                        options,
                    ),
                edit: (target: ExpressionReference, input: EmojiEdit, options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild("emojis.edit", () => expressionEdit("emojis", target, input, options), options),
                        "emojis.edit",
                        options,
                    ),
                delete: (target: ExpressionReference, options?: DefaultExpressionDeleteOptions) =>
                    execute(
                        owner.guild("emojis.delete", () => expressionDelete("emojis", target, options), options),
                        "emojis.delete",
                        options,
                    ),
            }),
            stickers: Object.freeze({
                edit: (target: ExpressionReference, input: StickerEdit, options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild("stickers.edit", () => expressionEdit("stickers", target, input, options), options),
                        "stickers.edit",
                        options,
                    ),
                get: (target: ExpressionReference) => lookup(owner.getResource("stickers", target), "stickers.get"),
                fetchAll: (id: string, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("stickers.fetchAll", () => expressionList("stickers", id), options),
                        "stickers.fetchAll",
                        options,
                    ),
                fetchMetadata: (id: string, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("stickers.fetchMetadata", () => expressionMetadata("stickers", id), options),
                        "stickers.fetchMetadata",
                        options,
                    ),
                create: (id: string, input: StickerCreate, options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild("stickers.create", () => expressionCreate("stickers", id, input, options), options),
                        "stickers.create",
                        options,
                    ),
                createMany: (id: string, input: readonly StickerCreate[], options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild(
                            "stickers.createMany",
                            () => expressionBatch("stickers", id, input, options),
                            options,
                        ),
                        "stickers.createMany",
                        options,
                    ),
                clone: (id: string, sourceId: string, options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild(
                            "stickers.clone",
                            () => expressionClone("stickers", id, sourceId, options),
                            options,
                        ),
                        "stickers.clone",
                        options,
                    ),
                delete: (target: ExpressionReference, options?: DefaultExpressionDeleteOptions) =>
                    execute(
                        owner.guild("stickers.delete", () => expressionDelete("stickers", target, options), options),
                        "stickers.delete",
                        options,
                    ),
            }),
            auditLogs: Object.freeze({
                fetchPage: (id: string, query: AuditLogQuery, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("auditLogs.fetchPage", () => auditLogPage(id, query), options),
                        "auditLogs.fetchPage",
                        options,
                    ),
                iterate: (id: string, query: AuditLogIterationQuery, options?: DefaultGuildOperationOptions) =>
                    iterate((request) => auditLogPagination(owner, id, query, request), "auditLogs.iterate", options),
            }),
            invites: Object.freeze({
                fetch: (code: string, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("invites.fetch", () => inviteFetch(code), options),
                        "invites.fetch",
                        options,
                    ),
                create: (channelId: string, input?: InviteCreate, options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild("invites.create", () => inviteCreate(channelId, input, options), options),
                        "invites.create",
                        options,
                    ),
                fetchChannel: (channelId: string, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("invites.fetchChannel", () => inviteList("channels", channelId), options),
                        "invites.fetchChannel",
                        options,
                    ),
                fetchGuild: (guildId: string, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("invites.fetchGuild", () => inviteList("guilds", guildId), options),
                        "invites.fetchGuild",
                        options,
                    ),
                delete: (code: string, options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild("invites.delete", () => inviteDelete(code, options), options),
                        "invites.delete",
                        options,
                    ),
            }),
            discovery: Object.freeze({
                search: (query?: DiscoverySearchQuery, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("discovery.search", () => discoverySearch(query), options),
                        "discovery.search",
                        options,
                    ),
                fetchStatus: (id: string, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("discovery.fetchStatus", () => discoveryStatus(id), options),
                        "discovery.fetchStatus",
                        options,
                    ),
                fetchCategories: (options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("discovery.fetchCategories", discoveryCategories, options),
                        "discovery.fetchCategories",
                        options,
                    ),
                apply: (id: string, input: DiscoveryApplicationInput, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("discovery.apply", () => discoveryWrite(id, input), options),
                        "discovery.apply",
                        options,
                    ),
                edit: (id: string, input: DiscoveryApplicationEdit, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("discovery.edit", () => discoveryWrite(id, input, true), options),
                        "discovery.edit",
                        options,
                    ),
                withdraw: (id: string, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("discovery.withdraw", () => discoveryWithdraw(id), options),
                        "discovery.withdraw",
                        options,
                    ),
            }),
            guilds: Object.freeze({
                fetchCounts: (ids: readonly string[], options?: DefaultCountOperationOptions) =>
                    execute(owner.counts.fetchGuilds(ids, options), "guilds.fetchCounts", options),
                fetchPage: (query?: GuildListQuery, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("guilds.fetchPage", () => guildList(query), options),
                        "guilds.fetchPage",
                        options,
                    ),
                iterate: (query: GuildIterationQuery, options?: DefaultGuildOperationOptions) =>
                    iterate((request) => guildPagination(owner, query, request), "guilds.iterate", options),
                leave: (id: string, options?: DefaultGuildOperationOptions) =>
                    execute(owner.leaveGuild(id, options), "guilds.leave", options),
                deleteMine: (id: string, options?: DefaultGuildOperationOptions) =>
                    execute(owner.deleteGuildMessages(id, options), "guilds.deleteMine", options),
                fetchVanityUrl: (id: string, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("guilds.fetchVanityUrl", () => vanityUrlFetch(id), options),
                        "guilds.fetchVanityUrl",
                        options,
                    ),
                editVanityUrl: (id: string, code: string | null, options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild("guilds.editVanityUrl", () => vanityUrlEdit(id, code, options), options),
                        "guilds.editVanityUrl",
                        options,
                    ),
                edit: (id: string, input: GuildEdit, options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild("guilds.edit", () => guildEdit(id, input, options), options),
                        "guilds.edit",
                        options,
                    ),
                ban: (target: MemberReference, input?: BanInput, options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild("guilds.ban", () => guildBan(target, input, options), options),
                        "guilds.ban",
                        options,
                    ),
                unban: (target: MemberReference, options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild("guilds.unban", () => guildUnban(target, options), options),
                        "guilds.unban",
                        options,
                    ),
                fetchBans: (id: string, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("guilds.fetchBans", () => guildBans(id), options),
                        "guilds.fetchBans",
                        options,
                    ),
                get: (id: string) => lookup(owner.getResource("guilds", id), "guilds.get"),
                fetch: (id: string, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("guilds.fetch", () => guildFetch(id), options),
                        "guilds.fetch",
                        options,
                    ),
            }),
            channels: Object.freeze({
                fetchMemberCounts: (guildId: string, ids: readonly string[], options?: DefaultCountOperationOptions) =>
                    execute(owner.counts.fetchChannels(guildId, ids, options), "channels.fetchMemberCounts", options),
                get: (id: string) => lookup(owner.getChannel(id), "channels.get"),
                fetch: (id: string, options?: DefaultChannelOperationOptions) =>
                    execute(
                        owner.channel("channels.fetch", () => channelFetch(id), options),
                        "channels.fetch",
                        options,
                    ),
                fetchAll: (id: string, options?: DefaultChannelOperationOptions) =>
                    execute(
                        owner.channel("channels.fetchAll", () => channelList(id), options),
                        "channels.fetchAll",
                        options,
                    ),
                create: (id: string, input: ChannelCreate, options?: DefaultChannelOperationOptions) =>
                    execute(
                        owner.channel("channels.create", () => channelCreate(id, input), options),
                        "channels.create",
                        options,
                    ),
                edit: (id: string, input: ChannelEdit, options?: DefaultChannelOperationOptions) =>
                    execute(
                        owner.channel("channels.edit", () => channelEdit(id, input), options),
                        "channels.edit",
                        options,
                    ),
                delete: (id: string, options?: DefaultChannelOperationOptions) =>
                    execute(
                        owner.channel("channels.delete", () => channelDelete(id), options),
                        "channels.delete",
                        options,
                    ),
                reorder: (
                    id: string,
                    positions: readonly ChannelPosition[],
                    options?: DefaultChannelOperationOptions,
                ) =>
                    execute(
                        owner.channel("channels.reorder", () => channelReorder(id, positions), options),
                        "channels.reorder",
                        options,
                    ),
                setPermissionOverwrite: (
                    id: string,
                    input: PermissionOverwrite,
                    options?: DefaultChannelOperationOptions,
                ) =>
                    execute(
                        owner.channel("channels.setPermissionOverwrite", () => permissionSet(id, input), options),
                        "channels.setPermissionOverwrite",
                        options,
                    ),
                removePermissionOverwrite: (id: string, targetId: string, options?: DefaultChannelOperationOptions) =>
                    execute(
                        owner.channel(
                            "channels.removePermissionOverwrite",
                            () => permissionRemove(id, targetId),
                            options,
                        ),
                        "channels.removePermissionOverwrite",
                        options,
                    ),
            }),
            members: Object.freeze({
                iterateChunks: iterateMemberChunks,
                setRoles: (
                    target: MemberReference,
                    roleIds: readonly string[],
                    options?: DefaultGuildOperationOptions,
                ) =>
                    execute(
                        owner.guild("members.setRoles", () => memberRolesSet(target, roleIds), options),
                        "members.setRoles",
                        options,
                    ),
                search: (id: string, query?: MemberSearchQuery, options?: DefaultGuildOperationOptions) =>
                    execute(searchMembers(owner, id, query, options), "members.search", options),
                iterateSearch: (
                    id: string,
                    filters: Omit<MemberSearchQuery, "limit">,
                    limits: MemberSearchIterationLimits,
                    options?: DefaultGuildOperationOptions,
                ) =>
                    iterate(
                        (request) => searchMemberPagination(owner, id, filters, limits, request),
                        "members.iterateSearch",
                        options,
                    ),
                editSelf: (guildId: string, input: MemberProfileEdit, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("members.editSelf", () => memberEditSelf(guildId, input), options),
                        "members.editSelf",
                        options,
                    ),
                setNickname: (
                    target: MemberReference,
                    nickname: string | null,
                    options?: DefaultGuildOperationOptions,
                ) =>
                    execute(
                        owner.guild("members.setNickname", () => memberNicknameEdit(target, nickname), options),
                        "members.setNickname",
                        options,
                    ),
                move: (target: VoiceConnectionReference, channelId: string, options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild("members.move", () => memberVoiceMove(target, channelId, options), options),
                        "members.move",
                        options,
                    ),
                disconnect: (target: VoiceConnectionReference, options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild("members.disconnect", () => memberVoiceMove(target, null, options), options),
                        "members.disconnect",
                        options,
                    ),
                setMute: (target: MemberReference, muted: boolean, options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild("members.setMute", () => memberVoiceFlag(target, "mute", muted, options), options),
                        "members.setMute",
                        options,
                    ),
                setDeaf: (target: MemberReference, deafened: boolean, options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild(
                            "members.setDeaf",
                            () => memberVoiceFlag(target, "deaf", deafened, options),
                            options,
                        ),
                        "members.setDeaf",
                        options,
                    ),
                timeout: (target: MemberReference, durationMs: number, options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild("members.timeout", () => memberTimeout(target, durationMs, options), options),
                        "members.timeout",
                        options,
                    ),
                clearTimeout: (target: MemberReference, options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild("members.clearTimeout", () => memberTimeout(target, null, options, true), options),
                        "members.clearTimeout",
                        options,
                    ),
                kick: (target: MemberReference, options?: DefaultModerationOptions) =>
                    execute(
                        owner.guild("members.kick", () => memberKick(target, options), options),
                        "members.kick",
                        options,
                    ),
                iterate: (id: string, query: UserIterationQuery, options?: DefaultGuildOperationOptions) =>
                    iterate((request) => memberPagination(owner, id, query, request), "members.iterate", options),
                get: (target: MemberReference) => lookup(owner.getResource("members", target), "members.get"),
                fetch: (target: MemberReference, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("members.fetch", () => memberFetch(target), options),
                        "members.fetch",
                        options,
                    ),
                fetchSelf: (id: string, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("members.fetchSelf", () => memberSelf(id), options),
                        "members.fetchSelf",
                        options,
                    ),
                fetchHierarchyCheck: (target: MemberReference, options?: DefaultGuildOperationOptions) =>
                    execute(fetchHierarchyCheck(owner, target, options), "members.fetchHierarchyCheck", options),
                fetchPage: (id: string, query?: MemberQuery, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("members.fetchPage", () => memberPage(id, query), options),
                        "members.fetchPage",
                        options,
                    ),
                addRole: (target: MemberReference, id: string, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("members.addRole", () => memberRole(target, id, true), options),
                        "members.addRole",
                        options,
                    ),
                removeRole: (target: MemberReference, id: string, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("members.removeRole", () => memberRole(target, id, false), options),
                        "members.removeRole",
                        options,
                    ),
            }),
            permissions: Object.freeze({
                calculate: (input: PermissionInput) => lookup(calculatePermissions(input), "permissions.calculate"),
                fetch: (target: PermissionTarget, options?: DefaultGuildOperationOptions) =>
                    execute(fetchPermissions(owner, target, options), "permissions.fetch", options),
            }),
            roles: Object.freeze({
                setHoistPositions: (
                    id: string,
                    positions: readonly RoleHoistPosition[],
                    options?: DefaultGuildOperationOptions,
                ) =>
                    execute(
                        owner.guild("roles.setHoistPositions", () => roleSetHoistPositions(id, positions), options),
                        "roles.setHoistPositions",
                        options,
                    ),
                resetHoistPositions: (id: string, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("roles.resetHoistPositions", () => roleResetHoistPositions(id), options),
                        "roles.resetHoistPositions",
                        options,
                    ),
                get: (target: RoleReference) => lookup(owner.getResource("roles", target), "roles.get"),
                fetchAll: (id: string, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("roles.fetchAll", () => roleList(id), options),
                        "roles.fetchAll",
                        options,
                    ),
                create: (id: string, input: RoleCreate, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("roles.create", () => roleCreate(id, input), options),
                        "roles.create",
                        options,
                    ),
                edit: (target: RoleReference, input: RoleEdit, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("roles.edit", () => roleEdit(target, input), options),
                        "roles.edit",
                        options,
                    ),
                delete: (target: RoleReference, options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("roles.delete", () => roleDelete(target), options),
                        "roles.delete",
                        options,
                    ),
                reorder: (id: string, positions: readonly RolePosition[], options?: DefaultGuildOperationOptions) =>
                    execute(
                        owner.guild("roles.reorder", () => roleReorder(id, positions), options),
                        "roles.reorder",
                        options,
                    ),
            }),
            attachments: Object.freeze({
                download: (attachment: Attachment, options: DefaultAttachmentDownloadOptions) =>
                    execute(owner.downloadAttachment(attachment, options), "attachments.download", options),
                stream: (attachment: Attachment, options: DefaultAttachmentStreamOptions) =>
                    attachmentStream(attachment, options),
            }),
            messages: Object.freeze({
                iterateHistory: (id: string, query: HistoryIterationQuery, options?: DefaultMessageOperationOptions) =>
                    iterate((request) => historyPagination(owner, id, query, request), "iterateHistory", options),
                search: (
                    context: MessageSearchContext,
                    query?: MessageSearchQuery,
                    options?: DefaultMessageSearchOptions,
                ) => execute(owner.searchMessages(context, query, options), "search", options),
                iterateSearch: (
                    context: MessageSearchContext,
                    filters: Omit<MessageSearchQuery, "limit" | "page" | "cursor">,
                    limits: MessageSearchIterationLimits,
                    options?: DefaultMessageSearchOptions,
                ) =>
                    iterate(
                        (request) => searchMessagePagination(owner, context, filters, limits, request),
                        "messages.iterateSearch",
                        options,
                    ),
                iterateReactionUsers: (
                    target: MessageReference,
                    emoji: ReactionEmojiInput,
                    query: UserIterationQuery,
                    options?: DefaultMessageOperationOptions,
                ) =>
                    iterate(
                        (request) => reactionUserPagination(owner, target, emoji, query, request),
                        "iterateReactionUsers",
                        options,
                    ),
                iteratePins: (id: string, query: PinIterationQuery, options?: DefaultMessageOperationOptions) =>
                    iterate((request) => pinPagination(owner, id, query, request), "iteratePins", options),
                removeUserReaction: (
                    target: MessageReference,
                    emoji: ReactionEmojiInput,
                    userId: string,
                    options?: DefaultMessageOperationOptions,
                ) =>
                    execute(
                        owner.reaction("removeUserReaction", target, emoji, options, userId),
                        "removeUserReaction",
                        options,
                    ),
                clearReaction: (
                    target: MessageReference,
                    emoji: ReactionEmojiInput,
                    options?: DefaultMessageOperationOptions,
                ) => execute(owner.reaction("clearReaction", target, emoji, options), "clearReaction", options),
                clearReactions: (target: MessageReference, options?: DefaultMessageOperationOptions) =>
                    execute(owner.reaction("clearReactions", target, undefined, options), "clearReactions", options),
                pin: (target: MessageReference, options?: DefaultMessageOperationOptions) =>
                    execute(owner.pin("pin", target, options), "pin", options),
                unpin: (target: MessageReference, options?: DefaultMessageOperationOptions) =>
                    execute(owner.pin("unpin", target, options), "unpin", options),
                fetchPins: (channel: string, query?: MessagePinsQuery, options?: DefaultMessageOperationOptions) =>
                    execute(owner.fetchPins(channel, query, options), "fetchPins", options),
                fetchReactionUsers: (
                    target: MessageReference,
                    emoji: ReactionEmojiInput,
                    query?: ReactionUsersQuery,
                    options?: DefaultMessageOperationOptions,
                ) => execute(owner.fetchReactionUsers(target, emoji, query, options), "fetchReactionUsers", options),
                addReaction: (
                    target: MessageReference,
                    emoji: ReactionEmojiInput,
                    options?: DefaultMessageOperationOptions,
                ) => execute(owner.reaction("addReaction", target, emoji, options), "addReaction", options),
                removeReaction: (
                    target: MessageReference,
                    emoji: ReactionEmojiInput,
                    options?: DefaultMessageOperationOptions,
                ) => execute(owner.reaction("removeReaction", target, emoji, options), "removeReaction", options),
                collect: (
                    channelId: string,
                    options?: DefaultCollectorOptions,
                ): Result<Collector, CollectorRegistrationError | CancelledError | ConfigurationError> => {
                    const opened = fromExit(
                        Effect.runSyncExit(
                            Effect.suspend(() =>
                                collect(
                                    owner,
                                    channelId,
                                    options,
                                    true,
                                    typeof options?.onMessage === "function"
                                        ? collectorHandler(options.onMessage)
                                        : undefined,
                                ),
                            ),
                        ),
                        "collect",
                    )
                    return opened.map(defaultCollector)
                },
                collectReactions: (
                    target: MessageReference,
                    options?: DefaultReactionCollectorOptions,
                ): Result<ReactionCollector, CollectorRegistrationError | CancelledError | ConfigurationError> => {
                    let callback: DefaultReactionCollectorOptions["onReaction"]
                    try {
                        callback = options?.onReaction
                    } catch {
                        throw new SdkDefect("collectReactions", [{ kind: "Defect" }])
                    }
                    const opened = fromExit(
                        Effect.runSyncExit(
                            collectReactions(
                                owner,
                                target,
                                options,
                                true,
                                typeof callback === "function" ? collectorHandler(callback) : undefined,
                            ),
                        ),
                        "collectReactions",
                    )
                    return opened.map((source) =>
                        Object.freeze({
                            stop: () => source.stop(),
                            waitForClose: (options?: OperationOptions) =>
                                executeOperation(
                                    Deferred.await(source.closed),
                                    "reactionCollector.waitForClose",
                                    options,
                                ),
                        }),
                    )
                },
                get: (target: MessageReference): Result<Message | undefined, MessageOperationFailure> => {
                    const exit = Effect.runSyncExit(owner.get(target))
                    if (Exit.isSuccess(exit)) return ok(exit.value)
                    if (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause)) throw new SdkDefect("get")
                    const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
                    if (failure?._tag === "Fail") return err(failure.error)
                    throw new SdkDefect("get")
                },
                send: (channelId: string, input: MessageInput, options?: DefaultSendOptions) =>
                    execute(owner.send(channelId, input, options), "send", options),
                forward: (channelId: string, input: ForwardMessageInput, options?: DefaultSendOptions) =>
                    execute(owner.forward(channelId, input, options), "forward", options),
                typing: (channelId: string, options?: DefaultMessageOperationOptions) =>
                    execute(owner.typing(channelId, options), "typing", options),
                keepTyping: <A>(
                    channelId: string,
                    task: (signal: NonNullable<OperationOptions["signal"]>) => PromiseLike<A>,
                    options?: DefaultMessageOperationOptions,
                ) =>
                    execute(
                        typeof task === "function"
                            ? owner.keepTyping(channelId, defaultTypingTask(task), options)
                            : Effect.fail(
                                  new MessageOperationError(
                                      "typing",
                                      "input",
                                      "notDispatched",
                                      null,
                                      null,
                                      null,
                                      inputValidationFailure(
                                          "task",
                                          "type",
                                          "Default keepTyping task must be a function",
                                      ).detail,
                                  ),
                              ),
                        "keepTyping",
                        options,
                    ),
                reply: (target: MessageReference, input: ReplyInput, options?: DefaultSendOptions) =>
                    execute(
                        Effect.suspend(() => {
                            const data = replyInput(target, input)
                            return data instanceof MessageError
                                ? Effect.fail(data)
                                : owner.send(target.channelId, data, options)
                        }),
                        "reply",
                        options,
                    ),
                fetch: (target: MessageReference, options?: DefaultMessageOperationOptions) =>
                    execute(owner.fetch(target, options), "fetch", options),
                fetchHistory: (
                    channelId: string,
                    query?: MessageHistoryQuery,
                    options?: DefaultMessageOperationOptions,
                ) => execute(owner.fetchHistory(channelId, query, options), "fetchHistory", options),
                previewCleanup: (
                    channelId: string,
                    selection: MessageCleanupSelection,
                    options?: DefaultMessageOperationOptions,
                ) => execute(previewCleanup(owner, channelId, selection, options), "previewCleanup", options),
                cleanup: (plan: MessageCleanupPlan, options?: DefaultMessageCleanupOptions) =>
                    execute(cleanup(owner, plan, options), "cleanup", options),
                edit: (target: MessageReference, input: EditMessageInput, options?: DefaultMessageOperationOptions) =>
                    execute(owner.edit(target, input, options), "edit", options),
                delete: (target: MessageReference, options?: DefaultMessageOperationOptions) =>
                    execute(owner.delete(target, options), "delete", options),
                deleteAttachment: (
                    target: MessageReference,
                    attachmentId: string,
                    options?: DefaultMessageOperationOptions,
                ) => execute(owner.deleteAttachment(target, attachmentId, options), "deleteAttachment", options),
                deleteMany: (channelId: string, ids: readonly string[], options?: DefaultMessageOperationOptions) =>
                    execute(owner.deleteMany(channelId, ids, options), "deleteMany", options),
                deleteMine: (channelId: string, options?: DefaultMessageOperationOptions) =>
                    execute(owner.deleteMine(channelId, options), "deleteMine", options),
            }),
            on: <K extends EventName>(
                event: K,
                handler: (
                    message: EventMap[K],
                    signal: NonNullable<OperationOptions["signal"]>,
                ) => void | Promise<void>,
                options?: EventHandlerOptions,
            ) => {
                return register(
                    Effect.suspend(() => {
                        if (typeof handler !== "function")
                            return Effect.fail(new ConfigurationError("handler", "Handler must be a function"))
                        const reporter = options?.onError
                        if (reporter !== undefined && typeof reporter !== "function")
                            return Effect.fail(new ConfigurationError("onError", "Error reporter must be a function"))
                        let reporting = false
                        const reportFailure = (kind: string) => {
                            Effect.runSyncExit(
                                owner.logging.provide(Effect.logError(`Fluxerly message subscription ${kind} failure`)),
                            )
                        }
                        return owner.events
                            .on(
                                event,
                                (message) =>
                                    Effect.tryPromise({
                                        try: (signal) => Promise.resolve(handler(message, signal)),
                                        catch: () => new Error("Event handler failed"),
                                    }),
                                options,
                                reporter
                                    ? (report) =>
                                          Effect.sync(() => {
                                              if (reporting) {
                                                  reportFailure(report.kind)
                                                  return
                                              }
                                              reporting = true
                                              void Promise.resolve()
                                                  .then(() => reporter(report))
                                                  .catch(() => reportFailure(`${report.kind}; reporter`))
                                                  .finally(() => {
                                                      reporting = false
                                                  })
                                          })
                                    : undefined,
                                scope,
                            )
                            .pipe(Effect.map(subscription))
                    }),
                    "on",
                )
            },
            events: <K extends EventName>(event: K, options?: EventBufferOptions) =>
                register(
                    owner.events.open(event, options).pipe(
                        Effect.map((source): EventSubscription<K> =>
                            Object.freeze({
                                ...subscription(source),
                                next: (options?: OperationOptions) => execute(source.next(), "next", options),
                            }),
                        ),
                    ),
                    "events",
                ),
            waitFor: <K extends EventName>(event: K, options?: DefaultEventWaitOptions<K>) =>
                execute(waitForEvent(owner.events, event, options, true), "waitFor", options),
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
            connect: (options?: OperationOptions) => execute(owner.connect(), "connect", options),
            run: (options?: OperationOptions) => execute(owner.run(), "run", options),
            waitForClose: (options?: OperationOptions) => execute(owner.waitForClose(), "waitForClose", options),
            shutdown: () =>
                new ResultAsync<void, never>(
                    Effect.runPromiseExit(
                        owner.logging.provide(owner.shutdown().pipe(Effect.ensuring(Scope.close(scope, Exit.void)))),
                    ).then((exit) => {
                        const result = fromExit(exit, "shutdown")
                        if (result.isErr()) throw new SdkDefect("shutdown")
                        return ok(undefined)
                    }),
                ),
            observeState: (listener: (state: ConnectionState) => void | Promise<void>) => {
                let active = true
                let busy = false
                let pending: ConnectionState | undefined
                const deliver = (state: ConnectionState) => {
                    if (!active) return
                    if (busy) {
                        pending = state
                        return
                    }
                    busy = true
                    Promise.resolve()
                        .then(() => (active ? listener(state) : undefined))
                        .catch(() => {
                            // Diagnostic delivery can fail too; never recurse into the user callback
                            Effect.runSyncExit(owner.logging.provide(Effect.logError("Fluxerly state observer failed")))
                        })
                        .finally(() => {
                            busy = false
                            if (pending !== undefined) {
                                const next = pending
                                pending = undefined
                                deliver(next)
                            }
                        })
                }
                const unsubscribe = owner.subscribe(deliver)
                return () => {
                    active = false
                    pending = undefined
                    unsubscribe()
                }
            },
        }),
    )
}

/**
 * Standalone delegated OAuth client with no browser, callback, token-store, or bot-transport ownership.
 * It copies the client secret until shutdown, admits at most eight concurrent operations with no queue, caps response bodies at 1 MiB, and never retries requests automatically.
 * Expected failures are Result errors; unexpected cleanup defects reject with SdkDefect without upstream text
 */
export interface OAuthClient {
    /** Build an S256 authorization URL from the selected instance's discovered web application base, including any advertised path. Bot target and permission parameters are consent hints, not installation or authorization proof. State and PKCE values remain caller-owned */
    authorizationUrl(
        input: OAuthAuthorizationInput,
        options?: DefaultOAuthOperationOptions,
    ): ResultAsync<string, OAuthOperationFailure | CancelledError | ConfigurationError>
    /** Exchange one callback code. Cancellation after dispatch cannot establish whether Fluxer consumed the code, so do not retry it */
    exchangeCode(
        input: OAuthCodeExchangeInput,
        options?: DefaultOAuthOperationOptions,
    ): ResultAsync<OAuthTokens, OAuthOperationFailure | CancelledError | ConfigurationError>
    /** Exchange one refresh token. Fluxer rotates refresh tokens, so the caller must atomically replace its stored pair only after success and never retry an unknown outcome */
    refresh(
        refreshToken: string,
        options?: DefaultOAuthOperationOptions,
    ): ResultAsync<OAuthTokens, OAuthOperationFailure | CancelledError | ConfigurationError>
    /** Revoke one access or refresh token. A lost response can still mean the token was revoked */
    revoke(
        input: { readonly token: string; readonly tokenTypeHint?: "access_token" | "refresh_token" },
        options?: DefaultOAuthOperationOptions,
    ): ResultAsync<void, OAuthOperationFailure | CancelledError | ConfigurationError>
    /** Read the identify-scoped identity with a bearer token, without retaining that token */
    fetchIdentity(
        accessToken: string,
        options?: DefaultOAuthOperationOptions,
    ): ResultAsync<OAuthIdentity, OAuthOperationFailure | CancelledError | ConfigurationError>
    /** Read one bounded guild-membership page with a bearer token that has Fluxer's guilds scope. This never uses bot authentication */
    fetchGuilds(
        accessToken: string,
        query?: GuildListQuery,
        options?: DefaultOAuthOperationOptions,
    ): ResultAsync<readonly GuildListSummary[], OAuthOperationFailure | CancelledError | ConfigurationError>
    /** Read the full delegated connections list with a bearer token that has Fluxer's connections scope. This does not create, verify, reorder, or retain connections */
    fetchConnections(
        accessToken: string,
        options?: DefaultOAuthOperationOptions,
    ): ResultAsync<readonly OAuthConnection[], OAuthOperationFailure | CancelledError | ConfigurationError>
    /** Confidentially inspect one access or refresh token using this client's Basic credentials. Inactive does not identify revocation, expiry, ownership, or token existence */
    introspect(
        token: string,
        options?: DefaultOAuthOperationOptions,
    ): ResultAsync<OAuthIntrospection, OAuthOperationFailure | CancelledError | ConfigurationError>
    /** Permanently reject new OAuth work, clear the copied client secret, abort active requests, and wait for their fetch and response-reader cleanup. Unexpected cleanup defects reject with SdkDefect */
    shutdown(): ResultAsync<void, never>
}

/**
 * Opt-in OAuth helpers and standalone confidential-client construction. Browser navigation, callback handling, state correlation, consent, token storage, installation policy, and refresh coordination remain application-owned
 *
 * @example
 * ```ts
 * import { oauth, OAuthScopes } from "@neontechspace/fluxerly"
 *
 * export async function oauthExample() {
 *     const created = oauth.create({ clientId: "123", clientSecret: "server-held-secret" })
 *     if (created.isErr()) return created.error
 *     const client = created.value
 *     try {
 *         const pkce = oauth.createPkce()
 *         return await client.authorizationUrl({
 *             redirectUri: "https://app.example.test/oauth/callback",
 *             scopes: [OAuthScopes.Identify, OAuthScopes.Bot],
 *             state: "caller-correlated-state",
 *             codeChallenge: pkce.challenge,
 *             guildId: "456",
 *             permissions: 0n,
 *         })
 *     } finally {
 *         await client.shutdown()
 *     }
 * }
 * ```
 */
export const oauth = Object.freeze({
    create(config: OAuthConfig): Result<OAuthClient, ConfigurationError> {
        const scope = Scope.makeUnsafe()
        const created = fromExit(Effect.runSyncExit(makeOAuthOwner(config, scope)), "oauth.authorizationUrl")
        if (created.isErr()) return err(created.error as ConfigurationError)
        const owner = created.value
        return ok(
            Object.freeze({
                authorizationUrl: (input: OAuthAuthorizationInput, options?: DefaultOAuthOperationOptions) =>
                    executeOperation(
                        owner.authorizationUrl(input, oauthOwnerOptions(options)),
                        "oauth.authorizationUrl",
                        options,
                    ),
                exchangeCode: (input: OAuthCodeExchangeInput, options?: DefaultOAuthOperationOptions) =>
                    executeOperation(
                        owner.exchangeCode(input, oauthOwnerOptions(options)),
                        "oauth.exchangeCode",
                        options,
                    ),
                refresh: (refreshToken: string, options?: DefaultOAuthOperationOptions) =>
                    executeOperation(owner.refresh(refreshToken, oauthOwnerOptions(options)), "oauth.refresh", options),
                revoke: (
                    input: { readonly token: string; readonly tokenTypeHint?: "access_token" | "refresh_token" },
                    options?: DefaultOAuthOperationOptions,
                ) => executeOperation(owner.revoke(input, oauthOwnerOptions(options)), "oauth.revoke", options),
                fetchIdentity: (accessToken: string, options?: DefaultOAuthOperationOptions) =>
                    executeOperation(
                        owner.fetchIdentity(accessToken, oauthOwnerOptions(options)),
                        "oauth.fetchIdentity",
                        options,
                    ),
                fetchGuilds: (accessToken: string, query?: GuildListQuery, options?: DefaultOAuthOperationOptions) =>
                    executeOperation(
                        owner.fetchGuilds(accessToken, query, oauthOwnerOptions(options)),
                        "oauth.fetchGuilds",
                        options,
                    ),
                fetchConnections: (accessToken: string, options?: DefaultOAuthOperationOptions) =>
                    executeOperation(
                        owner.fetchConnections(accessToken, oauthOwnerOptions(options)),
                        "oauth.fetchConnections",
                        options,
                    ),
                introspect: (token: string, options?: DefaultOAuthOperationOptions) =>
                    executeOperation(owner.introspect(token, oauthOwnerOptions(options)), "oauth.introspect", options),
                shutdown: () =>
                    new ResultAsync(
                        Effect.runPromiseExit(owner.shutdown()).then((exit) => {
                            const result = fromExit(exit, "shutdown")
                            if (result.isErr()) throw new SdkDefect("shutdown")
                            return ok(undefined)
                        }),
                    ),
            }),
        )
    },
    createPkce,
})
