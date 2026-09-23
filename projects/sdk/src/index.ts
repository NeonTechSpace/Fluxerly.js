/**
 * Build a Fluxer bot with JavaScript or TypeScript.
 * Import from @neontechspace/fluxerly and call its methods directly
 *
 * @example
 * ```ts
 * import { createClient } from "@neontechspace/fluxerly"
 *
 * const created = createClient({ token: "YOUR_BOT_TOKEN" })
 * if (created.isErr()) throw created.error
 * const client = created.value
 *
 * client.on("messageCreate", async (message) => {
 *     if (message.content === "!ping") {
 *         await client.messages.reply(message, { content: "Pong!" })
 *     }
 * })
 *
 * const connected = await client.connect()
 * if (connected.isErr()) throw connected.error
 * ```
 *
 * @remarks
 * This default API also includes webhooks, OAuth and local helpers, without requiring an Effect runtime.
 * Synchronous calls such as createClient return Result.
 * If isErr() is true, read error for the expected failure.
 * Otherwise, read value for the successful result.
 * Asynchronous calls return ResultAsync.
 * Await it to get the same Result shape.
 * Those calls start when called, not when awaited.
 * Methods returning AsyncIterable start work when a for await loop pulls its first item.
 * Expected failures are Err values, not thrown exceptions.
 * Unexpected SDK or cleanup failures throw or reject with SdkDefect.
 * Use try/finally to release client resources even when work fails
 *
 * A guild is a Fluxer server.
 * The gateway is the live connection that carries events.
 * A shard is one gateway connection assigned part of the bot's guilds.
 * Most resource reads and writes use HTTP requests and do not require that live connection.
 * A frozen snapshot is a copy that does not change when Fluxer data changes.
 * An uncertain write is a request that may have succeeded even though the SDK did not receive a clear result.
 * Check the current remote state before repeating such a request.
 * HTTP 204 is a successful response without a value.
 * HTTP 429 means Fluxer rejected work due to a rate limit.
 * Options named timeoutMs and durationMs use milliseconds.
 * Keep IDs as decimal strings rather than numbers
 *
 * @packageDocumentation
 */
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
    if (Array.isArray(options)) return options
    if (typeof options !== "object" || options === null || !("signal" in options)) return options
    const { signal: _signal, ...ownerOptions } = options
    return ownerOptions
}

/**
 * Create Fluxer markup for mentions, timestamps, custom emoji and Markdown escaping.
 * Use these helpers when building message content, without creating a client or making a request.
 * Most helpers return a Result. Check whether it contains Ok or Err.
 * The escapeMarkdown helper returns a string directly.
 * A mention in the text does not enable notifications, which are controlled by allowedMentions when sending
 */
export const format: typeof sharedFormat = sharedFormat

/**
 * Read and convert Fluxer's IDs, called snowflakes, without losing integer precision.
 * Keep IDs as decimal strings rather than JavaScript numbers.
 * Conversions that can fail return Result
 */
export const snowflakes: typeof sharedSnowflakes = sharedSnowflakes

/**
 * Choose a display name from supplied user or member data.
 * No account request or cache lookup is made
 */
export const display: typeof sharedDisplay = sharedDisplay

/**
 * Build and inspect raw permission flags with bigint values.
 * Use from to combine named permissions, missing to find absent names, and toDecimal to produce a decimal string.
 * These helpers inspect flags only, not whether Fluxer will allow a particular action
 */
export const permissionBits: typeof sharedPermissionBits = sharedPermissionBits

/**
 * Convert supported RGB numbers, six-digit hex strings and RGB tuples into colors.
 * Invalid input returns an Err rather than being converted automatically.
 * No client or network request is needed
 */
export const colors: typeof sharedColors = sharedColors

/**
 * Split a string into frozen pieces without dropping or changing its text.
 * The maxLength option counts UTF-16 code units, as JavaScript string.length does.
 * This helper neither sends the pieces nor repairs Markdown split across them
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

/**
 * Build links to Fluxer channels, direct messages, messages and bot installation pages.
 * These helpers use hosted Fluxer URLs.
 * Invalid route inputs return an Err.
 * Building a link does not check access or install the bot
 */
export const links: typeof sharedLinks = sharedLinks

/**
 * Build hosted Fluxer URLs for avatars, banners, guild images, emoji and stickers.
 * Calls return Result and do not download the image or need a client.
 * Use client.instance.resolve() for helpers tied to a self-hosted instance instead.
 * Member avatar and banner helpers read only guildId, userId and the chosen image hash.
 * The displayMemberAvatar helper also reads profileFlags to choose the fallback image
 */
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
    AttachmentRefreshFailure,
    DefaultAttachmentRefreshOptions,
    DefaultAttachmentDownloadOptions,
    DefaultAttachmentStreamOptions,
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
import { err, ok, ResultAsync, type Result } from "neverthrow"
import { CriticalWorkerStoppedError, type RunBotOptions } from "./bot-runner.js"
import { runBotCore } from "#sdk/internal/bot-runner"
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
 * Route prefixed messages such as !ping to registered handlers.
 * Create a router, register commands, then attach it to a client
 *
 * @remarks
 * Nothing listens until attach, which uses one bounded messageCreate subscription and does not connect the client.
 * Application handlers send replies and decide access.
 * The router does not fetch permissions or retry failed handlers
 *
 * Optional groups organize names and help text, but a protected command still needs its own guard.
 * A guard is an application callback that decides whether a matched command may run
 *
 * Optional argument schemas convert raw args into frozen typed values after the guard.
 * Conversion rejection calls onReject without consuming a cooldown.
 * The original args remain available
 *
 * Help pages are strings the application can send.
 * Hiding a command in help is not an access check
 *
 * Builders in the examples create independent plain message inputs, validated later by message operations
 *
 * @example
 * ```ts
 * import { commands, type Client } from "@neontechspace/fluxerly"
 * export function commandGroupExample(client: Client) {
 *     return commands.create({ prefix: "!" })
 *         .andThen(router => router.registerGroup({ name: "tools", aliases: ["t"] }))
 *         .andThen(router => router.register({
 *             name: "ping",
 *             execute: async ({ client, message }) => {
 *                 const reply = await client.messages.reply(message, { content: "Pong", allowedMentions: {} })
 *                 if (reply.isErr()) throw reply.error
 *             },
 *         }, { group: ["tools"] }))
 *         .andThen(router => router.attach(client))
 * }
 * ```
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
 * Run a fixed group of local Node.js child processes, each with its own client and assigned shards.
 * Use create to validate the assignments, then start to launch the children.
 * Each child entry module must call supervisor.child.run to create and run its client
 *
 * @remarks
 * The start method waits for assignment and configuration acknowledgements, not gateway READY.
 * Use waitForReady for all-child READY, and waitForClose to wait until this supervisor's children have exited.
 * The status method returns a frozen local report with the latest gateway state received from each current child.
 * Those states are separate observations, not an atomic health check across processes
 *
 * Fresh gateway Identify sends require a parent permit and are spaced by at least one second.
 * Identify authenticates a new session, while Resume reuses an earlier gateway session.
 * Session Resume sends do not need a permit.
 * A permit stays outstanding until the child confirms the send or cancels before sending.
 * A stalled child is stopped and must exit before another permit is issued, after a full spacing interval.
 * The child helper receives a stop signal.
 * A parent stop does not wait for an uncooperative configure promise or start its client afterward
 *
 * The parent can forcibly terminate only children it started after the graceful deadline, and still waits for their exit.
 * No process signal handlers are installed.
 * The child's stdout and stderr are ignored.
 * Optional restart settings limit child replacements and increase the delay exponentially between attempts.
 * The childEnvironment, args and execArgv options affect child launch but are omitted from status and failures.
 * This helper does not discover shard counts, coordinate other hosts, preserve replacement sessions or share REST rate limits
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
export const supervisor: import("./default-supervisor.js").DefaultSupervisorTools = makeDefaultSupervisor(createClient)
export { fromStructuredLogger } from "./logging.js"
export type {
    LoggingOptions,
    DefaultLoggingOptions,
    DefaultLogger,
    SdkLifecycleEvent,
    SdkLifecycleLogRecord,
    SdkLogLevel,
    SdkLogRecord,
    SdkMeasurementLogRecord,
    SdkMeasurementOperation,
    SdkMeasurementStage,
    SdkOperationalLogRecord,
    StructuredLogger,
} from "./logging.js"
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
    DefaultChannelAuditOperationOptions,
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
    ChannelAuditOperationOptions,
    DefaultChannelAuditOperationOptions,
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
    type DefaultGuildAuditOperationOptions,
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
    GuildAuditOperationOptions,
    DefaultGuildAuditOperationOptions,
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
import type { BanInput, GuildBan, DefaultModerationOptions, DefaultTimeoutOptions } from "./guilds.js"
export type {
    BanInput,
    GuildBan,
    ModerationOptions,
    DefaultModerationOptions,
    TimeoutOptions,
    DefaultTimeoutOptions,
} from "./guilds.js"
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
    MessageCore,
    MessageFields,
    SelectedMessage,
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

/**
 * Control one event subscription returned by on or events.
 * Closing this subscription leaves the client and its other subscriptions running
 */
export interface Subscription {
    /**
     * Stop new deliveries, drop queued events and signal running callbacks to stop.
     * This returns immediately.
     * JavaScript promises that ignore the signal cannot be forcibly stopped
     */
    unsubscribe(): void
    /**
     * Wait until this subscription has closed and the SDK has released its queue and listeners.
     * Normal closure returns Ok(undefined).
     * Overflow returns EventOverflowError even to a later waiter.
     * This does not wait for arbitrary application promises.
     * Aborting options.signal cancels only this wait, not the subscription.
     * Later waits see the same subscription outcome.
     * Unexpected cleanup failures reject with SdkDefect
     */
    waitForClose(
        options?: OperationOptions,
    ): ResultAsync<void, EventOverflowError | CancelledError | ConfigurationError>
}

/**
 * Read future events one at a time with next, then close the subscription with unsubscribe.
 * Each subscription receives the event type chosen in client.events and keeps no previously delivered history.
 * The default event type is messageCreate
 */
export interface EventSubscription<
    K extends EventName = "messageCreate",
    M extends MessageCore = Message,
> extends Subscription {
    /**
     * Wait for the next event, returning Ok(payload), or Ok(null) after normal closure.
     * Only one pending next call is allowed.
     * Another call returns EventReadBusyError.
     * Aborting options.signal cancels this read without closing the subscription.
     * Overflow discards the queue and remains an Err.
     * Unexpected SDK failures reject with SdkDefect
     */
    next(
        options?: OperationOptions,
    ): ResultAsync<EventMap<M>[K] | null, EventReadError | CancelledError | ConfigurationError>
}

/**
 * Configure how client.on schedules callbacks and reports their failures
 */
export interface EventHandlerOptions extends HandlerOptions {
    /**
     * Handle a report containing only the event name and failure kind, not the exception, stack or event payload.
     * To inspect an exception, catch it inside the event callback before rethrowing, as shown on Client.on.
     * Only one custom report runs at a time for this registration.
     * While it is busy, further failures go to the default logger.
     * A failed reporter produces one safe fallback log and is never retried.
     * The SDK does not wait for reporter promises when closing the subscription
     */
    readonly onError?: (report: HandlerErrorReport) => void | Promise<void>
}

/**
 * Refresh signed attachment URL strings explicitly, or download received Attachment data all at once or as chunks.
 * Refresh uses the selected instance's authenticated API. Downloads use its media path, with no gateway connection or cache required.
 * The SDK never sends bot credentials to a download URL or substitutes attachment.proxyUrl
 */
export interface Attachments {
    /**
     * Ask Fluxer's bot-authenticated API to reissue signatures for 1 through 50 URL strings.
     * Each string may contain at most 2,048 UTF-16 code units. Strings, duplicate entries and query parameters are sent unchanged
     *
     * The frozen result has one original/refreshed pair per input in the same order.
     * A string outside this instance's attachment URL space is returned unchanged by Fluxer.
     * Refreshing does not check attachment existence, guild or channel membership, permission to download, or media availability
     *
     * This method never downloads media and never sends the bot credential to a requested or refreshed URL.
     * The credentialed POST follows no redirect. Use download explicitly afterward for a returned URL that belongs to this instance
     *
     * The timeoutMs option defaults to 30,000 for endpoint discovery, waiting for a REST request slot, rate-limit waits and the limited response read.
     * A confirmed 429 can retry after its required wait. An uncertain POST or malformed success is not retried automatically.
     * Aborting options.signal cancels only this refresh and waits for request cleanup.
     * HTTP 404 cannot distinguish an older unsupported deployment from an unavailable route or denied access.
     * No refresh happens automatically when reading messages or downloading attachments
     */
    refreshUrls(
        urls: readonly string[],
        options?: DefaultAttachmentRefreshOptions,
    ): ResultAsync<readonly RefreshedAttachmentUrl[], AttachmentRefreshFailure | CancelledError | ConfigurationError>
    /**
     * Download attachment.url into one Uint8Array
     *
     * Pass maxBytes explicitly, from 1 through 52,428,800 bytes (50 MiB).
     * The limit caps the returned bytes, not total memory, because response chunks can coexist with the packed result
     *
     * The URL must match this instance's discovered media /attachments/ path.
     * The GET sends no Authorization header, follows no redirects and stores no cached copy
     *
     * The timeoutMs option defaults to 30,000 for endpoint discovery, waiting for a media slot and downloading.
     * Four media downloads can run at once, separately from REST and uploads, without waiting for bot API rate limits
     *
     * Aborting options.signal waits for response-reader cleanup, but cannot undo bytes already received
     *
     * Size and expiry metadata do not prove that the URL is available or the bytes are safe.
     * Expected failures contain a safe reason and status, including busy, without the URL or response body
     */
    download(
        attachment: Attachment,
        options: DefaultAttachmentDownloadOptions,
    ): ResultAsync<Uint8Array, AttachmentDownloadFailure | CancelledError | ConfigurationError>
    /**
     * Read attachment.url as chunks in a for await loop without combining the file into one array.
     * Pass maxBytes explicitly, from 1 through 52,428,800 bytes (50 MiB), for the total bytes delivered
     *
     * Each item is a Result containing one Uint8Array.
     * An expected failure yields one Err and ends the loop
     *
     * The first pull reads the inputs, resolves endpoints, waits for one of four media slots and starts the GET.
     * Later pulls read at most one response chunk.
     * No spooling, automatic retry or durable storage is added
     *
     * The URL must match this instance's media /attachments/ path.
     * The GET sends no Authorization header, follows no redirects, caches nothing and never uses proxyUrl
     *
     * A Content-Length above maxBytes fails before any chunk, but actual byte counting is still enforced
     *
     * This iterable can be consumed only once.
     * Overlapping next calls return busy without cancelling the pending read.
     * The timeoutMs option defaults to 30,000 for the whole download, including pauses between chunks.
     * Breaking the loop, return, throw, signal cancellation, failure and client shutdown cancel the body.
     * The SDK then waits for reader cleanup and releases the media slot.
     * Listener or cleanup failures reject with SdkDefect after independent cleanup is attempted.
     * Size and expiry metadata do not establish availability or byte safety
     *
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
 * Read, send and change messages with client.messages, or collect future messages and reactions.
 * HTTP operations and local get lookups do not need a gateway connection.
 * Received messages are frozen copies. They do not update when Fluxer changes.
 * Their fields follow this client's messageFields selection, which defaults to the full Message.
 * That selection also applies to nested messages, callbacks and cached snapshots
 *
 * @remarks
 * Remote calls start when called and normally return ResultAsync. Await one to get Ok or Err.
 * The default timeoutMs is 30,000 for the whole call, including queue, rate-limit and retry waits.
 * The SDK waits for request cleanup afterward, so the timeout is not a hard cleanup time limit.
 * This client runs four REST or upload requests at once and four separate attachment downloads.
 * Both pools together allow at most 256 waiting requests or 4 MiB of queued JSON bodies.
 * These limits apply across the shards assigned to this client
 *
 * The fetch, fetchHistory, fetchReactionUsers and fetchPins methods retry transport failures and HTTP 500, 502, 503 or 504 at most twice.
 * The retry delays are 125–250 ms, then 250–500 ms, or a longer valid Retry-After.
 * Retries use the same target and query and never reset the deadline.
 * Results can change between attempts.
 * Confirmed HTTP 429 rejections have separate route and global waits and do not consume those two retries.
 * Writes retry only confirmed rate-limit rejections. A write with no clear result may already have succeeded and is not retried.
 * Other rejections and malformed successes are not retried.
 * Successful JSON bodies are limited to 16 MiB before parsing, not total memory usage
 *
 * Expected failures return Err.
 * Unexpected SDK or cleanup failures reject with SdkDefect, or throw from synchronous get.
 * An aborted signal returns CancelledError.
 * Closing the client makes pending and new operations fail with ClientClosedError.
 * After a write was sent, either failure can leave the change applied.
 * Neither proves rollback.
 * Collectors need a ready gateway connection as described on collect and collectReactions
 */

export interface Messages<M extends MessageCore = Message> {
    /**
     * Read older messages in a for await loop, newest first.
     * Pass maxItems to bound the scan.
     * The pageSize and maxPages options use the limits in PaginationQuery
     *
     * Creating the iterable makes no request.
     * Each consumption copies the inputs and has independent progress.
     * The SDK keeps one page at a time and fetches the next only when needed
     *
     * Each item is Ok(frozenMessage).
     * One expected failure or cancellation yields Err, then ends iteration
     *
     * The timeoutMs option applies to each page, not to the whole scan.
     * Remote errors identify fetchHistory.
     * PaginationError reports invalid input, cursorStalled or pageLimit
     *
     * An empty page or maxItems ends the scan.
     * A short page does not, and pages are not a consistent snapshot
     *
     * If message caching is enabled, page reads can populate it as fetchHistory does
     *
     * Breaking the loop releases buffered messages.
     * To interrupt a pending next, abort the supplied signal and await it.
     * Client closure releases the buffer and fails the next pull.
     * Completion and early exit leave no listener registered
     *
     * Unexpected SDK or combined operation and cleanup failures reject with SdkDefect.
     * Messages already delivered to the caller are not rolled back
     *
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
    ): AsyncIterable<Result<M, MessageOperationFailure | PaginationError | CancelledError | ConfigurationError>>
    /**
     * Search messages in one explicit guild or channel and return one page from Fluxer's search index.
     * This starts immediately and always sends the current search scope (`scope: "current"`).
     * It neither connects the gateway nor reads or fills a cache
     *
     * The result is a frozen page or an indexing state.
     * The indexing result means Fluxer accepted the search but is not ready.
     * Decide yourself whether and when to try again
     *
     * Use page numbers from 1 through 400 for later requests, keeping limit unchanged.
     * Fluxer does not honor returned cursors, so the SDK exposes no cursor continuation
     *
     * Query arrays are copied when called.
     * Recognized inherited and nonenumerable fields are read too.
     * The results and their channel context can change and are not a stable snapshot
     *
     * Invalid input, POST failure or malformed success returns MessageOperationError with operation search.
     * Search does not use the transient read retries described on Messages.
     * Confirmed rate-limit handling still applies within the deadline.
     * An abort returns CancelledError
     *
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
    ): ResultAsync<MessageSearchPage<M>, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Read indexed search hits in a for await loop, using the supplied guild or channel context.
     * Pass maxItems.
     * The pageSize option accepts 1–25, and maxPages defaults to 100.
     * Each consumption copies the filters, including recognized inherited and nonenumerable fields and their arrays.
     * The SDK retains one page and requests later numbered pages only as needed.
     * Request capacity stays at the smaller of pageSize and maxItems throughout the scan. At most maxItems hits are delivered.
     * Reaching maxPages or Fluxer's 400-page ceiling with more matches yields PaginationError pageLimit.
     * An unexpected echoed page number or capacity yields cursorStalled. Index changes can still skip or repeat observations.
     * An indexing response yields PaginationError with reason indexing rather than polling or claiming an empty result.
     * Search hits do not populate the message cache or trigger full-message fetches.
     * Expected operation, pagination and cancellation failures yield one terminal Err after any delivered hits.
     * Unexpected failures reject with SdkDefect
     *
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
        filters: Omit<MessageSearchQuery, "limit" | "page">,
        limits: MessageSearchIterationLimits,
        options?: DefaultMessageSearchOptions,
    ): AsyncIterable<Result<M, MessageOperationFailure | PaginationError | CancelledError | ConfigurationError>>
    /**
     * Read users who reacted with one selected emoji, in ascending user-ID order.
     * Pass a literal Unicode emoji or custom emoji input, plus maxItems to bound the scan.
     * Like iterateHistory, this is lazy, keeps bounded results and yields Ok items or one terminal Err.
     * The timeoutMs option applies to each fetchReactionUsers page.
     * Abort the signal to interrupt a pending pull.
     * Breaking the loop releases buffered items.
     * Unexpected SDK failures reject with SdkDefect.
     * The scan ends at maxItems or hasMore=false, without caching reactors or fetching members.
     * Reactions may change during the scan.
     * Not finding a user within the bound does not prove they never reacted
     *
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
    /**
     * Read pinned messages newest-pin-first in a for await loop.
     * Pass maxItems to bound the scan.
     * PinIterationQuery defines the remaining limits.
     * Like iterateHistory, this is lazy and yields Ok items or one terminal Err, with timeoutMs per fetchPins page.
     * Breaking the loop releases buffered items.
     * Abort the signal to interrupt a pending pull.
     * No message cache entries are added.
     * At most maxItems IDs are kept to skip duplicates.
     * Valid items on a stalled page can be delivered before cursorStalled on the next pull.
     * The scan stops at maxItems or hasMore=false.
     * Pins with equal timestamps can prevent a complete scan even without concurrent edits
     *
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
            import("./pins.js").MessagePin<M>,
            MessageOperationFailure | PaginationError | CancelledError | ConfigurationError
        >
    >
    /**
     * Pin a message using its decimal id and channelId.
     * Success is Ok(undefined) after HTTP 204, not after gateway notification.
     * No gateway connection is required
     *
     * Fluxer checks channel access and PIN_MESSAGES for guild pins.
     * A new pin creates a system message and notifications.
     * An already-pinned message stays unchanged
     *
     * The pin, unpin and fetchPins methods share the per-channel pins rate limit and the client's request limits.
     * The default deadline is 30,000 ms.
     * Only confirmed HTTP 429 rejections are retried
     *
     * Invalid local input returns MessageOperationError with operation pin and outcome notDispatched.
     * Cancellation or a lost response after sending the request can leave the pin applied
     *
     * Successful or uncertain writes remove the cached target without guessing its new pinned status.
     * The SDK does not fetch to confirm, create events itself, unpin automatically or roll back the change.
     * The example's steps are separate operations, not a transaction
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
     */
    pin(
        message: MessageReference,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Remove a pin without deleting the message or its pin-created system message.
     * Supply a decimal message id and channelId.
     * Fluxer checks the same permissions as pin.
     * Success is Ok(undefined) after HTTP 204, including when the message is already unpinned.
     * The last-pin timestamp is not reset.
     * The pin method's request limits, deadline, rate-limit retries, cancellation and cache removal also apply.
     * Expected failures identify operation unpin.
     * Client closure returns ClientClosedError.
     * No gateway connection, confirmation fetch or automatic rollback is performed
     */
    unpin(
        message: MessageReference,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch one frozen page of pinned messages in descending pin-time order.
     * Use a decimal channel ID
     *
     * The limit option defaults to 50 and accepts 1–50.
     * The before option is an ISO timestamp and defaults to the server's current time
     *
     * Use nextBefore for the next page and pinnedAt for each pin's time.
     * Equal timestamps can repeat messages, so skip duplicate IDs and stop if the cursor does not advance.
     * This call neither traverses further pages nor reads or populates the message cache
     *
     * Visibility and history permissions can limit the page.
     * An empty page does not prove there are no pins
     *
     * The call uses the pins rate limit, default 30,000 ms deadline and Messages' bounded read retries.
     * Invalid input or malformed responses return MessageOperationError with operation fetchPins, not a partial page.
     * Client closure returns ClientClosedError.
     * An aborted signal cancels this request only
     */
    fetchPins(
        channelId: string,
        query?: MessagePinsQuery,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<MessagePinsPage<M>, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Remove one user's reaction for one emoji, leaving other users and emoji groups unchanged.
     * The userId input is required as a decimal string.
     * Use the bot's own ID to remove its reaction.
     * Accepts the same ReactionEmojiInput forms as addReaction
     *
     * Fluxer checks visibility and history access.
     * For another user, the bot must have authored the message or have MANAGE_MESSAGES in its guild
     *
     * Success is Ok(undefined) after HTTP 204, whether the reaction was present or already absent.
     * The call uses addReaction's request limits, deadline, confirmed rate-limit retries and cancellation rules.
     * Expected failures identify removeUserReaction
     *
     * No reaction cache is changed or retained
     *
     * After dispatch, cancellation or a lost response can leave the reaction removed.
     * The bot cannot restore another user's reaction as that user.
     * No restoration is attempted
     *
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
     * Remove all users' reactions for one emoji on the message.
     * Other emoji groups remain.
     * Success is Ok(undefined) after HTTP 204, even if no matching reactions existed.
     * The removeUserReaction method's permissions, request limits, deadline, failure and cleanup rules apply.
     * Expected failures identify clearReaction.
     * Fluxer emits a clear-emoji event, not individual removals.
     * The SDK does not create or wait for that event.
     * Other users' reactions cannot be restored by the bot as those users
     */
    clearReaction(
        message: MessageReference,
        emoji: ReactionEmojiInput,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Remove all users' reactions for all emoji on the message, without deleting the message.
     * No emoji selector is needed.
     * HTTP 204 returns Ok(undefined), whether reactions existed or not.
     * The clearReaction method's permissions, request limits, deadline, failure and cleanup rules apply.
     * Expected failures identify clearReactions.
     * Fluxer emits one clear-all event.
     * The SDK does not create per-user events or wait for notification.
     * Other users' reactions cannot be restored by the bot as those users
     */
    clearReactions(
        message: MessageReference,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch one page of users who currently have a selected reaction on the message.
     * Accepts the same ReactionEmojiInput forms as addReaction
     *
     * The limit option defaults to 25 and accepts 1–100.
     * The after option is an exclusive user-ID cursor.
     * Users are ordered by ascending ID, not reaction time.
     * Use nextAfter for another page
     *
     * An empty reaction returns an empty terminal page.
     * No automatic page traversal, user cache or message cache update is performed.
     * Pages can change between requests, so they are not a stable voter list
     *
     * This call shares the channel reaction rate limit and the default 30,000 ms deadline.
     * Messages' bounded read retries apply within the original deadline
     *
     * Invalid input, malformed pages, HTTP failures and timeout return MessageOperationError for fetchReactionUsers.
     * HTTP 404 is notFound.
     * Fluxer decides visibility and history access
     *
     * No gateway connection is needed.
     * Abort cancels this request and waits for cleanup
     *
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
     * Add the bot's own reaction to a message.
     * Pass Unicode such as "👍", custom markup such as "<a:party:123>", a parsed custom emoji, or a received emoji snapshot.
     * ReactionEmojiInput defines accepted identities and local validation. Custom emoji are encoded as name:id.
     * Fluxer decides emoji availability and permissions.
     * Adding the same own reaction again leaves it present.
     * Success is Ok(undefined) after HTTP 204, without waiting for a gateway event.
     * No gateway connection is required.
     * The request uses a per-channel reaction rate limit, the client's request limits and a 30,000 ms default deadline.
     * Only confirmed rate-limit rejections retry.
     * Cancellation after dispatch cannot undo the reaction.
     * Expected failures use MessageOperationError, or ClientClosedError after closure.
     * Unexpected SDK or cleanup failures reject with SdkDefect.
     * The SDK does not retain reaction state, counts or reactor lists
     *
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
     * Remove only the bot's own reaction for the selected emoji.
     * Other users' reactions stay unchanged.
     * HTTP 204 returns Ok(undefined), even if the bot had not reacted.
     * The addReaction method's emoji inputs, request limits, deadline, retry, failure and cancellation rules apply.
     * Neither this operation nor gateway reaction events change the message cache
     */
    removeReaction(
        message: MessageReference,
        emoji: ReactionEmojiInput,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Collect a bounded set of future messageCreate events from one channel.
     * Call this before sending a prompt.
     * It returns Result with a ready Collector handle synchronously.
     * It does not fetch history, read the cache or connect the client.
     * With guildId, only that guild's ready shard assigned to this client can feed the collector.
     * Events with a known conflicting guild are discarded without a channel lookup.
     * Without guildId, the client must be Connected, and any gateway gap ends collection because the guild is unknown.
     * A gap returns CollectorError connectionLost, even if the client later resumes.
     * Collection is not restarted
     *
     * Defaults are one accepted message, a 30,000 ms lifetime and 4 MiB of retained selected-message JSON.
     * After channel selection and before filtering, the pending queue allows 256 payloads or 4 MiB of source JSON
     *
     * Options are copied at registration.
     * Budgets must be positive safe integers.
     * The timeoutMs and optional idleMs values must be at most 2,147,483,647 ms
     *
     * The total timeout starts at registration and never resets.
     * The idleMs timer also starts at registration, then resets after each newly accepted message ID, before its callback.
     * Rejected, queued or duplicate messages do not reset idleMs.
     * Callback time counts toward both deadlines.
     * The earlier deadline wins, with timeout winning ties.
     * Messages processed at or after the deadline are excluded
     *
     * Each accepted ID counts once.
     * Later edits and deletions do not change collected snapshots
     *
     * The synchronous filter decides acceptance.
     * Filter failure or queue or retained-byte overflow ends this collector with an Err, without partial messages.
     * Optional onMessage runs sequentially after filtering, duplicate removal and the retained-byte check.
     * Return or await callback work.
     * Reaching maxMessages waits for the final callback.
     * Idle, timeout or stop can retain a message whose callback was cancelled.
     * Later messages are ignored while the final callback completes.
     * Pending budgets exclude the active message.
     * Callback failure ends collection with CollectorError and reason handler.
     * Closure waits for the callback promise.
     * Callbacks are not retried and their effects are not undone.
     * Filter the bot out when callbacks send acknowledgements, to avoid collecting those acknowledgements
     *
     * Not-ready registration returns CollectorError notConnected.
     * Closing clients return ClientClosedError.
     * Invalid options return ConfigurationError.
     * The options.signal value controls the collection itself.
     * Abort returns CancelledError, and a pre-aborted signal starts no collection.
     * Unexpected registration failures throw SdkDefect.
     * A timeout can succeed with no messages.
     * The application still manages the client's lifetime
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
     *         const sent = await client.messages.send(channelId, { content: "What name should the bot use?" })
     *         if (sent.isErr()) throw sent.error
     *         const result = await collector.waitForClose()
     *         if (result.isErr()) throw result.error
     *         return result.value
     *     } finally {
     *         collector.stop()
     *     }
     * }
     * ```
     *
     * @example
     * ```ts
     * import type { Client } from "@neontechspace/fluxerly"
     *
     * export async function messageCollectorProgressExample(client: Client, channelId: string, userId: string) {
     *     const opened = client.messages.collect(channelId, {
     *         filter: message => message.author.id === userId,
     *         maxMessages: 3,
     *         idleMs: 5_000,
     *         onMessage: async (message, signal) => {
     *             const reply = await client.messages.reply(message, { content: "Received your reply" }, { signal })
     *             if (reply.isErr()) throw reply.error
     *         },
     *     })
     *     if (opened.isErr()) throw opened.error
     *     return await opened.value.waitForClose()
     * }
     * ```
     */
    collect(
        channelId: string,
        options?: DefaultCollectorOptions<M>,
    ): Result<Collector<M>, CollectorRegistrationError | CancelledError | ConfigurationError>
    /**
     * Collect future reaction additions for one message and return a ready ReactionCollector synchronously.
     * Use decimal id and channelId, and register before the expected reaction.
     * This does not fetch existing reactors, verify the message remotely, read the cache or connect the client.
     * With guildId, only that guild's ready shard assigned to this client feeds the collector.
     * Known conflicting event guilds are discarded without a membership lookup.
     * Without guildId, the client must be Connected and any gateway gap ends collection.
     * A gap returns connectionLost without restarting collection
     *
     * Defaults are one accepted addition, a 30,000 ms lifetime and 4 MiB of retained reaction JSON.
     * The target and options are copied at registration.
     * After message selection, the pending queue allows 256 payloads or 4 MiB of full source JSON
     *
     * Optional emoji is checked before the synchronous filter, after queueing.
     * Unicode emoji match exact text without a custom ID.
     * Custom emoji match by ID, ignoring name changes.
     * An invalid emoji selector returns ConfigurationError for emoji
     *
     * Single events and batch entries follow receive order.
     * A batch uses one pending slot and its entries count individually.
     * Repeated user and emoji pairs count again.
     * No batching flag is enabled
     *
     * Removals, clears and message deletion neither undo additions nor stop collection.
     * This is not a vote tally
     *
     * The total timeout starts at registration and never resets, including while a filter runs.
     * Optional idleMs starts then too and resets after each accepted addition, before its callback.
     * Rejected, queued and unprocessed batch entries do not reset it.
     * Callback time counts.
     * The earlier deadline wins, with timeout winning ties.
     * The timeoutMs and idleMs values must be integers from 1 through 2,147,483,647 ms
     *
     * Optional onReaction runs sequentially after acceptance and the retained-byte check.
     * Limit completion waits for the final callback.
     * Idle, timeout or stop can retain an addition whose callback was cancelled
     *
     * Pending budgets exclude the active payload and its unprocessed batch entries
     *
     * Callback failure returns CollectorError with reason handler.
     * Closure waits for the callback's returned promise.
     * No callback is retried and no earlier effect is undone
     *
     * Filter or overflow failure returns CollectorError without partial results.
     * Invalid target or options return ConfigurationError.
     * Closing clients return ClientClosedError.
     * The options.signal value controls collection.
     * Abort returns CancelledError, and a pre-aborted signal starts nothing.
     * Unexpected registration failures throw SdkDefect.
     * Supply a connected client and an existing message.
     * Idle or timeout may succeed with no reactions
     *
     * @example
     * ```ts
     * import type { Client, MessageReference } from "@neontechspace/fluxerly"
     *
     * export async function reactionCollectorExample(client: Client, message: MessageReference, userId: string) {
     *     let count = 0
     *     const opened = client.messages.collectReactions(message, {
     *         maxReactions: 3,
     *         idleMs: 5_000,
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
     */
    collectReactions(
        message: MessageReference,
        options?: DefaultReactionCollectorOptions,
    ): Result<ReactionCollector, CollectorRegistrationError | CancelledError | ConfigurationError>
    /**
     * Look up a message in this client's cache synchronously, without an HTTP request.
     * Pass decimal id and channelId, or an existing message with those fields.
     * Ok(undefined) means caching is disabled or the entry is absent, expired, evicted or in a different channel.
     * It does not mean Fluxer has no such message.
     * Use fetch for a remote read.
     * A hit is a frozen snapshot that can be stale.
     * Lookup makes it more recently used without extending its age.
     * Invalid references return MessageOperationError with operation get, reason input and outcome notDispatched.
     * Closing clients return ClientClosedError.
     * Unexpected failures throw SdkDefect
     */
    get(message: MessageReference): Result<M | undefined, MessageOperationFailure>
    /**
     * Send text, embeds, files or stickers to a channel and return the created message.
     * Success follows the decoded HTTP response, not gateway notification or recipient acknowledgement.
     * Mentions are disabled by default.
     * Use allowedMentions to opt in.
     * Embed image and thumbnail URLs can use attachment://filename for a matching new image upload.
     * The flags input accepts only MessageFlags' non-voice bits.
     * Suppressing previews is different from omitting embeds
     *
     * Attachments accept data bytes, a sized Blob or File source, or a finite stream with its exact byte count.
     * The data bytes are copied when called
     *
     * File and stream bytes are read after upload planning without copying or spooling.
     * Keep a file source stable while it is read.
     * A finite stream is consumed at most once and must match its declared size
     *
     * All sources have a 50 MiB per-file maximum and share the client uploads.maxBytes reservation budget.
     * A full upload budget returns busy before copying or reading.
     * A path string or URL alone is not accepted.
     * Fluxer can impose lower limits
     *
     * Cleanup releases copied bytes and cancels and releases acquired readers on failure.
     * Failed uploads can leave temporary server data, without a guarantee of physical erasure
     *
     * Eligible created messages can enter an enabled cache, independently of send completion
     *
     * The default 30,000 ms total deadline includes waiting for request capacity and rate limits.
     * The request uses the shared limits and failure rules on Messages
     *
     * Only confirmed rate-limit rejections can retry automatically.
     * With inline multipart uploads, a confirmed HTTP 429 can replay copied data bytes only.
     * File and stream inputs return rateLimit instead of being read again
     *
     * The nonce input can be a 1–32 character string or a nonnegative safe integer.
     * If omitted, the SDK creates one nonce per send.
     * The same nonce is reused for confirmed rate-limit retries
     *
     * Fluxer tries to suppress duplicate sends for five minutes after saving a message.
     * This does not guarantee that a repeated or concurrent send posts only one message
     *
     * A lost response or cancellation after dispatch can leave a message posted.
     * The SDK neither retries nor rolls it back
     *
     * Expected failures return Err.
     * Unexpected SDK or cleanup failures reject with SdkDefect
     */
    send(
        channelId: string,
        input: MessageInput,
        options?: DefaultSendOptions,
    ): ResultAsync<M, SendError | CancelledError | ConfigurationError>
    /**
     * Copy an accessible source message into the destination channel and return the new message.
     * Pass the source reference in input.source.
     * No source fetch or cache lookup is performed
     *
     * Optional media selections must belong to the source.
     * Extra content, files, mentions and flags are rejected
     *
     * The result's messageSnapshots are frozen copies, not live views of later source edits
     *
     * Fluxer checks source access and destination permissions.
     * This uses send's shared request limits, default 30,000 ms deadline and optional destination-message caching
     *
     * The nonce input follows send's accepted values, generated default and reuse on confirmed rate-limit retries.
     * Fluxer's five-minute duplicate suppression is best effort, not exactly-once delivery
     *
     * Success follows HTTP, not recipient acknowledgement.
     * A lost response or abort can leave the forward posted.
     * Only confirmed rate-limit rejection retries.
     * No uncertain write is replayed or rolled back
     *
     * Expected failures are MessageError or ClientClosedError.
     * Abort returns CancelledError after cleanup.
     * Unexpected SDK or cleanup failures reject with SdkDefect
     *
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
    ): ResultAsync<M, SendError | CancelledError | ConfigurationError>
    /**
     * Show this bot's temporary typing indicator in a channel.
     * Pass a decimal channel ID.
     * HTTP 204 returns Ok(undefined), without waiting for another client to see it.
     * No gateway connection, cache entry or presence change is made.
     * Fluxer decides delivery and when the indicator expires.
     * This uses the client's request limits, a dedicated per-channel typing rate limit and a 30,000 ms default deadline.
     * Only confirmed rate-limit rejection retries.
     * A lost response, timeout or abort can leave the notice shown.
     * Input, capacity and HTTP failures return MessageOperationError with operation typing.
     * Client closure returns ClientClosedError.
     * Abort waits for request cleanup.
     * Unexpected failures reject with SdkDefect
     */
    typing(
        channelId: string,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Keep the bot's typing indicator active while an asynchronous task runs, returning the task's value.
     * The first typing request must succeed before task starts.
     * An initial failure returns Err without calling task
     *
     * Typing refreshes run no sooner than every 8,000 ms until task settles.
     * A later typing or client-close failure stops refreshes and is reported after the task settles
     *
     * The task callback receives a signal aborted on caller cancellation or helper cleanup.
     * The task must cooperate with that signal.
     * A promise that ignores it can delay cancellation
     *
     * A thrown or rejected task rejects with SdkDefect rather than returning an expected Err.
     * If task failure and refresh cleanup both fail, SdkDefect retains safe details for both
     *
     * Client shutdown stops and waits for the helper's refresh work, not arbitrary application work.
     * No detached refresh loop, cache entry, presence change or gateway state change is created
     *
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
     * Send a reply that references an existing message and return the new reply.
     * Pass the target's id and channelId, plus the reply content or files.
     * A missing target fails instead of silently sending an unreferenced message.
     * Target and explicit reference checks run first.
     * After client-closure checks, body validation follows send.
     * The send method's mention defaults, file copying, size limits, deadline, nonce and retry rules apply.
     * Eligible replies can enter the message cache.
     * A lost response can leave the reply posted.
     * The SDK does not replay an uncertain send
     */
    reply(
        message: MessageReference,
        input: ReplyInput,
        options?: DefaultSendOptions,
    ): ResultAsync<M, SendError | CancelledError | ConfigurationError>
    /**
     * Fetch one message from Fluxer, rather than reading the cache.
     * Pass a reference with id and channelId, or an existing Message.
     * The result is a frozen snapshot after response decoding and target-ID checks.
     * A missing target returns MessageOperationError with reason notFound, not an empty value.
     * An enabled cache can retain eligible results, but a full cache does not prevent the read from succeeding.
     * Messages' bounded read retries apply.
     * Cancellation stops this request only and waits for cleanup
     *
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
    ): ResultAsync<M, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch one page of channel messages from Fluxer, newest first.
     * Pass a decimal channel ID
     *
     * With no query, this reads the latest 50 messages.
     * The limit option accepts 1–100.
     * Choose at most one before, after or around message-ID cursor.
     * Use the oldest returned ID as before to request an older page
     *
     * The entire page is validated before returning a frozen array of frozen snapshots.
     * No gateway connection, cache read, automatic traversal or prefetch is required
     *
     * An empty or short page describes currently accessible results, not necessarily complete history.
     * Pages are separate observations, not a consistent point-in-time snapshot
     *
     * An enabled cache receives eligible messages oldest first, so tight limits keep the newest
     *
     * Invalid input, malformed pages or HTTP failures return MessageOperationError for fetchHistory.
     * HTTP 404 remains notFound.
     * Messages' shared limits, default deadline and bounded read retries apply
     *
     * Abort affects only this request and waits for cleanup.
     * Client closure returns ClientClosedError.
     * Unexpected failures reject with SdkDefect
     */
    fetchHistory(
        channelId: string,
        query?: MessageHistoryQuery,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<readonly M[], MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Preview a bounded message-deletion selection without deleting anything.
     * Pass authorId, a synchronous filter, or both.
     * When both are supplied, a message must match both
     *
     * The maxScanned and maxSelected values are required integers from 1 through 10,000.
     * History is scanned newest first until an empty page or either bound, without prefetch.
     * A short page does not end the scan.
     * History reads can populate an enabled message cache
     *
     * The result is an in-memory plan with frozen selected messages, usable once by this client only.
     * It cannot be reconstructed from JSON or given to another client
     *
     * A thrown filter, non-boolean return or promise-like return fails with MessageCleanupError before deletion.
     * A blocking synchronous filter cannot be interrupted
     *
     * One default 30,000 ms deadline covers the history scan.
     * Abort returns CancelledError and submits no deletion.
     * No gateway connection or cache reread is needed
     */
    previewCleanup(
        channelId: string,
        selection: MessageCleanupSelection<M>,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<MessageCleanupPlan<M>, MessageCleanupFailure | CancelledError | ConfigurationError>
    /**
     * Delete the exact IDs in a plan returned by previewCleanup, in sequential batches of at most 100.
     * No history reread or filter rerun is performed
     *
     * A plan is single-use even when cleanup fails or is cancelled.
     * To resolve an uncertain result, preview again or call deleteMany with separately recorded IDs
     *
     * One default 30,000 ms deadline covers all batch submissions.
     * The submittedBatches field records only earlier HTTP-success submissions, in the report or MessageCleanupError.
     * The rejected or uncertain terminal batch is reported separately.
     * These records do not prove each deletion, a deletion count, atomicity or that retrying is safe
     *
     * The onProgress callback runs synchronously on a best-effort basis.
     * Throws and promise-like rejections are ignored
     *
     * Abort returns CancelledError and can leave the batch being submitted uncertain.
     * Batches retry only confirmed rate-limit rejections as deleteMany does, never an unknown outcome
     *
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
        plan: MessageCleanupPlan<M>,
        options?: DefaultMessageCleanupOptions,
    ): ResultAsync<MessageCleanupReport, MessageCleanupFailure | CancelledError | ConfigurationError>
    /**
     * Change a message's supplied fields and return its frozen updated snapshot after HTTP.
     * Omitted fields remain unchanged.
     * No hidden fetch or cache merge is performed.
     * Mentions default off.
     * Existing stickers cannot be replaced here.
     * An empty content string requests removal of text, subject to Fluxer's validation.
     * To remove embeds, send nonempty content with embeds: [].
     * An otherwise empty edit is rejected by Fluxer.
     * Omitted rich embeds remain, but link previews may be regenerated
     *
     * To keep existing files while adding new uploads, include their IDs in attachments.
     * The supplied list replaces the old one.
     * [] clears files when nonempty text or embeds remain.
     * Retained file title or description can be replaced or cleared with null.
     * Unknown IDs may be ignored, and a stale list can remove concurrent additions.
     * An attachment:// image or thumbnail URL must match a new image upload, not a retained attachment.
     * New uploads use send's copying, size, budget and cleanup rules.
     * A flags-only edit is allowed.
     * Omission preserves flags, supplied flags replace writable bits, and 0 clears both non-voice bits
     *
     * Eligible responses can enter the cache.
     * An uncertain dispatched edit removes the old cached copy.
     * A missing message returns notFound.
     * A lost response, timeout, cancellation or closure can leave the edit applied.
     * The SDK does not automatically retry uncertain edits or wait for gateway notification
     */
    edit(
        message: MessageReference,
        input: EditMessageInput,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<M, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Delete one message and return Ok(undefined) after HTTP 204.
     * No gateway notification is awaited.
     * A missing message returns MessageOperationError with reason notFound, including a repeated delete.
     * Successful or uncertain dispatched deletion removes the cached message.
     * A lost response, timeout, cancellation or closure can leave the deletion applied.
     * Request cleanup is awaited, but the deletion cannot be undone.
     * Uncertain deletes are never retried automatically
     */
    delete(
        message: MessageReference,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
    /**
     * Delete one attachment by its decimal ID from a message authored by this bot.
     * The request copies the target, starts immediately and does not fetch or replace the attachment list
     *
     * No gateway connection is needed
     *
     * HTTP 204 returns Ok(undefined), without waiting for an event.
     * If the last attachment is removed, Fluxer can also delete a message it considers otherwise empty
     *
     * Successful or uncertain deletion removes this message's cached copy.
     * No events are created locally
     *
     * A notFound result can mean the attachment is missing without proving the message is absent
     *
     * Message request limits and deadlines apply
     *
     * Only confirmed HTTP 429 rejection retries.
     * Storage removal and message updates are separate changes, so a lost response can leave either applied
     *
     * Abort waits for cleanup but cannot undo deletion or guarantee physical erasure.
     * Unexpected failures reject with SdkDefect
     *
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
     * Delete 1–100 distinct decimal message IDs from one guild channel.
     * Fluxer requires ManageMessages.
     * IDs are copied when execution starts.
     * HTTP 204 returns Ok(undefined), not a deletion count or proof that each ID existed.
     * Missing messages are ignored.
     * No gateway connection, automatic selection, chunking or age filter is added.
     * Dispatched requests remove selected cache entries even on rejection, because partial deletion is possible.
     * Only confirmed rate-limit rejection retries.
     * A lost response, timeout, cancellation or closure can leave deletions applied.
     * Input, capacity and HTTP failures return MessageOperationError.
     * Abort returns CancelledError after request cleanup.
     * Unexpected failures reject with SdkDefect
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
    /**
     * Irreversibly delete this bot's entire authored message history in one channel.
     * Use a decimal channel ID.
     * Other authors' messages are preserved
     *
     * Success is Ok(undefined) after Fluxer's empty HTTP 202 response.
     * It is not a completed-job report, deletion count or proof the channel is empty.
     * Deletion can be partial and can leave new or concurrent messages.
     * There is no recovery token, automatic reconciliation or atomicity guarantee
     *
     * Bot credentials satisfy Fluxer's extra authentication checks, called sudo checks.
     * No extra sudo input is accepted.
     * Fluxer handles attachment removal without guaranteeing physical provider-storage or CDN erasure
     *
     * The default 30,000 ms deadline includes capacity and rate-limit waits
     *
     * Only confirmed HTTP 429 rejection retries.
     * A 5xx or lost response never causes an uncertain replay
     *
     * After dispatch, the entire enabled message cache is cleared and older pending reads cannot restore it.
     * No gateway events are created locally
     *
     * Abort or closure waits for request cleanup but cannot undo deletion.
     * Input, capacity and HTTP failures return MessageOperationError for deleteMine.
     * Unexpected failures reject with SdkDefect
     *
     * No gateway connection, guild leave or role change is performed
     */
    deleteMine(
        channelId: string,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, MessageOperationFailure | CancelledError | ConfigurationError>
}

/**
 * Wait for the bounded message collection created by messages.collect.
 * Use stop to end intake early and waitForClose to obtain its final result
 */
export interface Collector<M extends MessageCore = Message> {
    /**
     * Stop accepting messages now, keeping accepted replies for a successful partial result.
     * This returns immediately.
     * Await waitForClose for callback cleanup.
     * Repeated calls preserve whichever terminal outcome was recorded first
     */
    stop(): void
    /**
     * Wait for the final frozen collection result after timer, queue, filter, listener and callback cleanup.
     * Idle, timeout or stop can succeed with no messages or a partial collection.
     * Collection abort, filter or callback failure, overflow, gateway loss and client closure return Err without partial replies.
     * Multiple or later waiters receive the same collection outcome.
     * Aborting this wait cancels only the waiter, not collection.
     * Unexpected SDK failures reject with SdkDefect.
     * Keeping the handle or successful result keeps its message snapshots in memory
     */
    waitForClose(
        options?: OperationOptions,
    ): ResultAsync<CollectorResult<M>, CollectorFailure | CancelledError | ConfigurationError>
}

/**
 * Wait for the reaction-addition collection created by messages.collectReactions.
 * Use stop to end intake early.
 * Collected additions are observations, not current votes
 */
export interface ReactionCollector {
    /**
     * Stop accepting additions now and keep accepted observations for a successful partial result.
     * Await waitForClose to finish cleanup.
     * Repeated calls preserve the first recorded outcome
     */
    stop(): void
    /**
     * Wait for the final frozen reaction result after queue, timer, filter, listener and callback cleanup.
     * Idle, timeout or stop can succeed with empty or partial observations.
     * Collection abort, filter or callback failure, overflow, gateway loss and client shutdown return Err without partial observations.
     * Multiple or later waiters receive the same outcome.
     * Aborting this wait cancels only the waiter, not collection.
     * Unexpected failures reject with SdkDefect.
     * Keeping the handle or successful result retains its snapshots in memory
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

/**
 * Read a guild's audit log with ViewAuditLog permission, without connecting the gateway.
 * The fetchPage method starts immediately.
 * The iterate method reads pages only when the loop requests them.
 * The SDK does not cache audit records or create a permanent archive.
 * Guilds' shared request limits, deadlines and eligible read retries apply.
 * Input, permission and malformed-response failures return GuildOperationError.
 * Abort waits for cleanup and returns CancelledError.
 * Closing clients return ClientClosedError.
 * Unexpected failures reject with SdkDefect.
 * Records can change independently between reads
 */
export interface AuditLogs {
    /**
     * Fetch one filtered audit page with referenced users and webhook metadata that excludes tokens.
     * Supply cursors and filters in AuditLogQuery.
     * The returned page is frozen and remains in memory while the caller retains it
     */
    fetchPage(
        guildId: string,
        query: AuditLogQuery,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<AuditLogPage, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Read audit entries newest first in a for await loop.
     * Pass maxItems.
     * The pageSize option defaults to 50 and accepts 1–100. The maxPages option defaults to 100.
     * The timeoutMs option applies to each page
     *
     * The SDK buffers one page without prefetching.
     * An empty page or maxItems ends the scan, not a short page
     *
     * Invalid traversal input, a stalled cursor or reaching the page budget returns PaginationError.
     * Remote failures keep auditLogs.fetchPage's error.
     * An expected failure yields one Err and ends iteration
     *
     * Each consumption is independent.
     * Breaking the loop releases the buffer.
     * Abort interrupts pending request work and waits for cleanup.
     * Client closure releases the page and fails the next pull
     *
     * Already delivered entries remain with the caller.
     * Concurrent changes can prevent a complete scan
     *
     * Use fetchPage instead to also receive referenced users or webhooks
     */
    iterate(
        guildId: string,
        query: AuditLogIterationQuery,
        options?: DefaultGuildOperationOptions,
    ): AsyncIterable<
        Result<AuditLogEntry, GuildOperationFailure | PaginationError | CancelledError | ConfigurationError>
    >
}

/**
 * Inspect, create, list and revoke invite codes with the bot's credentials.
 * No gateway connection or invite cache is needed.
 * Fluxer checks destination visibility, invite permissions and capacity.
 * Shared guild request limits and deadlines apply.
 * Eligible reads retry at most twice.
 * Writes retry only confirmed HTTP 429 rejections
 *
 * Expected failures return GuildOperationError or ClientClosedError.
 * Abort returns CancelledError after cleanup.
 * Unexpected failures reject with SdkDefect.
 * A lost write response can leave the invite change applied.
 * Check remote state before retrying
 */
export interface Invites {
    /**
     * Look up an invite code without using it or joining its destination.
     * Pass the code, not its full URL.
     * Expired, revoked or inaccessible codes fail remotely.
     * Fluxer may normalize the case of a vanity code
     */
    fetch(
        code: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<Invite, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Create an invite for an accessible channel, including an existing group direct message.
     * Defaults are a new code, 86,400 seconds, unlimited uses and non-temporary membership.
     * The result is invite metadata.
     * The SDK does not send the code, create a group or add members.
     * Cancellation cannot revoke an invite that was already created.
     * For an uncertain result, list the destination's invites before deciding whether to create again
     */
    create(
        channelId: string,
        input?: InviteCreate,
        options?: DefaultModerationOptions,
    ): ResultAsync<InviteMetadata, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * List a channel's management-visible invites in Fluxer's order.
     * Channel permissions determine access.
     * Concurrent changes can make the list stale
     */
    fetchChannel(
        channelId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly InviteMetadata[], GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * List a guild's management-visible invites with ManageGuild permission.
     * The guild's vanity invite is excluded
     */
    fetchGuild(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly InviteMetadata[], GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Revoke an invite code and return Ok(undefined) after HTTP 204.
     * Fluxer checks creator or management permissions.
     * Existing members remain.
     * A missing code is an error, not proof a previous delete succeeded
     */
    delete(
        code: string,
        options?: DefaultModerationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
}

/**
 * Create, list, copy, rename and delete guild emoji.
 * Use get for an optional local cache lookup, or fetchAll and fetchMetadata for remote reads.
 * Shared guild request limits, deadlines and read retries apply.
 * Writes retry only confirmed HTTP 429 rejections.
 * Input, permission, not-found and malformed-response errors are not retried.
 * A lost response can leave a write applied.
 * Results are frozen snapshots, not gateway acknowledgement
 *
 * Expected failures return GuildOperationError or ClientClosedError.
 * Abort returns CancelledError after cleanup.
 * Unexpected failures reject with SdkDefect
 */
export interface Emojis {
    /**
     * Look up cached emoji metadata using decimal guildId and id, without an HTTP request.
     * Ok(undefined) means caching is disabled or the entry is absent, expired or invalidated by a conflicting change.
     * A hit becomes more recently used without extending expiry.
     * Unexpected failures throw SdkDefect
     */
    get(target: ExpressionReference): Result<GuildEmoji | undefined, GuildOperationFailure>
    /**
     * Fetch a guild's emoji list in Fluxer's order, without pagination.
     * The list can change after the response and is not an ongoing completeness guarantee.
     * An enabled metadata cache can retain results, but not image bytes or creator accounts
     */
    fetchAll(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly GuildEmoji[], GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch minimal emoji metadata by decimal ID, without requiring source-guild membership.
     * This read does not populate the cache
     */
    fetchMetadata(
        id: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<ExpressionMetadata, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Upload one guild emoji and return its metadata.
     * Inputs are copied when execution starts.
     * No image URL is fetched automatically.
     * Fluxer checks image format, dimensions, permissions and capacity.
     * An uncertain write is not replayed
     */
    create(
        guildId: string,
        input: EmojiCreate,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildEmoji, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Upload 1–50 guild emoji in one batch and return separate successes and failures.
     * The input array is copied by index, then its entries are copied when execution starts.
     * Some uploads can succeed while others fail.
     * No rollback or automatic chunking is performed.
     * Failures named by duplicate emoji names cannot be matched reliably to input positions.
     * For an uncertain result, fetch fresh remote data rather than blindly replaying the batch
     */
    createMany(
        guildId: string,
        input: readonly EmojiCreate[],
        options?: DefaultModerationOptions,
    ): ResultAsync<ExpressionBatch<GuildEmoji>, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Copy an emoji into a guild by its source ID, using Fluxer's server-side copy.
     * Source metadata is preserved.
     * Fluxer enforces source copying restrictions
     */
    clone(
        guildId: string,
        sourceId: string,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildEmoji, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Rename a guild emoji without changing its image or fetching its old metadata first
     */
    edit(
        target: ExpressionReference,
        input: EmojiEdit,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildEmoji, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Remove an emoji and return Ok(undefined) after HTTP 204.
     * Retained metadata is invalidated.
     * A missing target returns an error, not proof of an earlier deletion.
     * The purge option defaults to false.
     * Setting it to true also queues irreversible media removal, subject to Fluxer's restrictions
     */
    delete(
        target: ExpressionReference,
        options?: DefaultExpressionDeleteOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
}

/**
 * Create, list, copy, edit and delete guild stickers.
 * Use get for an optional local cache lookup, or fetchAll and fetchMetadata for remote reads.
 * Shared guild request limits, deadlines and read retries apply.
 * Writes retry only confirmed HTTP 429 rejections.
 * Input, permission, not-found and malformed-response errors are not retried.
 * A lost response can leave a write applied.
 * Results are frozen snapshots, not gateway acknowledgement
 *
 * Expected failures return GuildOperationError or ClientClosedError.
 * Abort returns CancelledError after cleanup.
 * Unexpected failures reject with SdkDefect
 */
export interface Stickers {
    /**
     * Replace a sticker's name, description and tags without changing its image or fetching it first.
     * A fetched sticker can be spread into input if its identity matches the target.
     * Unknown fields fail locally.
     * An empty or null description clears it, and [] clears tags.
     * Shared sticker write, failure and cancellation rules apply
     */
    edit(
        target: ExpressionReference,
        input: StickerEdit,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildSticker, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Look up cached sticker metadata using decimal guildId and id, without an HTTP request.
     * Ok(undefined) means caching is disabled or the entry is absent, expired or invalidated by a conflicting change.
     * A hit becomes more recently used without extending expiry.
     * Unexpected failures throw SdkDefect
     */
    get(target: ExpressionReference): Result<GuildSticker | undefined, GuildOperationFailure>
    /**
     * Fetch a guild's sticker list in Fluxer's order, without pagination.
     * The list can change after the response and is not an ongoing completeness guarantee.
     * An enabled metadata cache can retain results, but not image bytes or creator accounts
     */
    fetchAll(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly GuildSticker[], GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch minimal sticker metadata by decimal ID, without requiring source-guild membership.
     * This read does not populate the cache
     */
    fetchMetadata(
        id: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<ExpressionMetadata, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Upload one guild sticker and return its metadata.
     * Inputs are copied when execution starts.
     * No image URL is fetched automatically.
     * Fluxer checks image format, dimensions, permissions and capacity.
     * An uncertain write is not replayed
     */
    create(
        guildId: string,
        input: StickerCreate,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildSticker, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Upload 1–50 guild stickers in one batch and return separate successes and failures.
     * The input array is copied by index, then its entries are copied when execution starts.
     * Some uploads can succeed while others fail.
     * No rollback or automatic chunking is performed.
     * Failures named by duplicate sticker names cannot be matched reliably to input positions.
     * For an uncertain result, fetch fresh remote data rather than blindly replaying the batch
     */
    createMany(
        guildId: string,
        input: readonly StickerCreate[],
        options?: DefaultModerationOptions,
    ): ResultAsync<ExpressionBatch<GuildSticker>, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Copy a sticker into a guild by its source ID, using Fluxer's server-side copy.
     * Source metadata is preserved.
     * Fluxer enforces source copying restrictions
     */
    clone(
        guildId: string,
        sourceId: string,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildSticker, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Remove a sticker and return Ok(undefined) after HTTP 204.
     * Retained metadata is invalidated.
     * A missing target returns an error, not proof of an earlier deletion.
     * The purge option defaults to false.
     * Setting it to true also queues irreversible media removal, subject to Fluxer's restrictions
     */
    delete(
        target: ExpressionReference,
        options?: DefaultExpressionDeleteOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
}

/**
 * Search Fluxer's public server directory and manage a guild's directory application.
 * This is separate from finding the instance's API and gateway endpoints.
 * Calls start immediately without a gateway connection or directory cache.
 * The default 30,000 ms deadline includes request-capacity and rate-limit waits.
 * Eligible GET failures retry at most twice
 *
 * Writes retry only confirmed HTTP 429 rejection.
 * Input, HTTP and malformed-response failures return GuildOperationError.
 * Client closure returns ClientClosedError.
 * Abort waits for cleanup and returns CancelledError.
 * Unexpected failures reject with SdkDefect.
 * Application writes may publish or remove a listing and invalidate cached guild data.
 * No eligibility check, approval, resubmission or joining is performed automatically.
 * A failed write does not guarantee rollback
 */
export interface Discovery {
    /**
     * Fetch one page from the current public guild directory.
     * The limit option defaults to 24, and offset defaults to 0.
     * Later pages can change, so offset-based scans are not a stable snapshot.
     * This neither joins a guild nor caches its directory entry.
     * Shared eligible GET retries apply
     */
    search(
        query?: DiscoverySearchQuery,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<DiscoverySearchPage, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch a guild's current directory eligibility and application state.
     * Use a decimal guild ID with ManageGuild permission.
     * An eligible=false result can mean discovery is disabled or the member threshold is unmet, without distinguishing them.
     * Eligibility can change before application.
     * Available review or removal reasons are included
     */
    fetchStatus(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<DiscoveryStatus, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch category IDs and Fluxer's category labels in provider order.
     * This requires an authenticated client, not membership of a particular guild or ManageGuild.
     * No category copy is cached
     */
    fetchCategories(
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly DiscoveryCategory[], GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Submit a guild's application to the public directory.
     * ManageGuild, enabled discovery and current Fluxer eligibility are required.
     * An existing pending or approved application fails remotely.
     * Eligible verified or partnered guilds may be approved immediately.
     * The returned stored application does not guarantee approval or search visibility.
     * An uncertain result may have submitted or published the listing.
     * Check fetchStatus before trying again
     */
    apply(
        guildId: string,
        input: DiscoveryApplicationInput,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<DiscoveryApplication, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Change supplied fields of a pending or approved directory application.
     * ManageGuild and enabled discovery are required.
     * At least one field must be supplied.
     * Omitted fields remain unchanged.
     * Tags use the input type's normalization and replacement rules.
     * No old application is fetched or merged automatically.
     * Updates to an approved listing can become public, while search-index updates can lag or partially fail
     */
    edit(
        guildId: string,
        input: DiscoveryApplicationEdit,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<DiscoveryApplication, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Withdraw a pending application or remove an approved directory listing.
     * ManageGuild and enabled discovery are required.
     * HTTP 204 returns Ok(undefined).
     * A missing application returns an error.
     * Fluxer removes the application record and may separately remove its feature or search entry.
     * The guild and its members remain.
     * The prior application is not restored.
     * An uncertain or partial result needs remote inspection and may require operator recovery, not blind replay
     */
    withdraw(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
}

/**
 * Read guild settings and bot memberships, manage bans, or use the optional guild cache.
 * Most operations use HTTP and do not need a gateway connection.
 * The fetchCounts method differs because it requires a ready gateway, as described on that method
 *
 * @remarks
 * Requests share the client's four REST or upload slots across all assigned shards.
 * Four attachment-download slots are separate.
 * Both pools together allow 256 waiting requests or 4 MiB of queued JSON
 *
 * The timeoutMs option defaults to 30,000 for the whole request, including waits.
 * Reads retry transport failures and HTTP 500, 502, 503 or 504 at most twice.
 * Delays are 125–250 ms, then 250–500 ms, or a longer Retry-After.
 * Confirmed HTTP 429 waits are separate and never reset the deadline.
 * Input, not-found, permission and malformed-success failures are not retried
 *
 * Successful JSON is limited to 16 MiB before parsing, not total memory.
 * A write's malformed or lost response can leave the write applied, without rollback
 *
 * Expected failures return GuildOperationError or ClientClosedError.
 * Abort returns CancelledError after cleanup.
 * Unexpected SDK or cleanup failures reject with SdkDefect
 */
export interface Guilds {
    /**
     * Request fresh, visibility-filtered counts for 1–100 guilds over the connected gateway.
     * Use distinct positive decimal IDs without leading zeros, no greater than "18446744073709551615".
     * The IDs are copied when called.
     * Every guild must belong to a ready shard assigned to this client.
     * An unassigned or unready shard returns notConnected, not an omitted result.
     * The result contains frozen counts and omittedGuildIds in requested order.
     * An omitted entry is unavailable, not zero, and does not explain why it is missing.
     * Guild counts are separate observations, not one consistent snapshot.
     * A missing whole reply returns timeout
     *
     * One call uses one of four client-wide gateway request slots until all shard commands and replies finish.
     * The channels.fetchMemberCounts and members.iterateChunks methods share those slots.
     * There is no local queue, so excess calls return busy.
     * The default 30,000 ms deadline includes registration, commands and all reply fragments.
     * Fluxer also limits member and presence work, so a local slot does not guarantee a reply.
     * Only a gateway gap on a participating shard returns connectionLost.
     * Late replies are ignored.
     * No REST fallback, connection, caching, polling or retries are performed.
     * Expected failures use CountOperationError or ClientClosedError.
     * Abort returns CancelledError after local cleanup but cannot cancel Fluxer's dispatched work.
     * Unexpected failures reject with SdkDefect
     *
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
    /**
     * Fetch one page of guilds this bot belongs to, ordered by ascending guild ID.
     * The limit option defaults to 200 and accepts 1–200.
     * Choose either before or after, not both.
     * Those cursors refer to existing memberships.
     * If a cursor guild was removed, Fluxer may restart the page.
     * The withCounts option defaults to false.
     * Permission bits or requested approximate counts may be omitted.
     * An omitted value means unavailable, not zero.
     * The frozen summaries do not read or populate the guild cache.
     * No gateway connection or further page traversal is performed.
     * Shared guild deadlines, retries and failures apply.
     * This page is not a complete membership inventory or proof of matching gateway state
     *
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
    /**
     * Read the bot's guild memberships in ascending ID order with a for await loop.
     * Pass maxItems.
     * The pageSize option defaults to 200, and maxPages defaults to 100
     *
     * The SDK retains one page without prefetch, ending at maxItems or an empty page, not a short page.
     * A repeated or backward ID after a removed cursor returns PaginationError cursorStalled before delivering that page.
     * Other traversal failures include input and pageLimit.
     * Remote failures preserve fetchPage's error
     *
     * Each consumption copies inputs independently and yields Ok guilds or one terminal Err.
     * The timeoutMs option applies to each page
     *
     * Abort interrupts a pending next and waits for cleanup.
     * Breaking the loop releases the page.
     * Client closure releases it and fails the next pull
     *
     * The withCounts option applies to every page, but missing permission bits or counts remain unavailable, not zero.
     * No gateway connection or cache fill is needed.
     * Already delivered guilds remain with the caller.
     * Separate pages do not guarantee a consistent inventory
     *
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
    /**
     * Remove this bot from one guild while preserving its authored messages.
     * HTTP 204 returns Ok(undefined), without waiting for a gateway event.
     * The client remains usable for other guilds
     *
     * Fluxer rejects owners or restricted memberships
     *
     * Only confirmed HTTP 429 rejection retries.
     * A lost response or abort can leave membership removed.
     * Check fetch or the membership list to resolve an uncertain result.
     * Rejoining needs separate authorization
     *
     * Successful or uncertain writes invalidate cached guild resources and conflicting pending reads.
     * A confirmed leave also forgets this client's selected member presences.
     * An uncertain result keeps that selection.
     * Any dispatched attempt clears channel and message caches, because messages need not identify their guild
     *
     * Objects already returned to the caller stay unchanged.
     * This neither deletes the guild nor shuts down the client
     */
    leave(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Irreversibly delete this bot's entire authored message history across one guild.
     * Use a decimal guild ID.
     * Other authors' messages are preserved, and the bot stays in the guild with the same roles
     *
     * Success is Ok(undefined) after Fluxer's empty HTTP 202 response, not a completed-job report or deletion count.
     * The guild may still contain new or concurrent messages.
     * Deletion can be partial and is not atomic.
     * There is no recovery token or automatic reconciliation
     *
     * Bot credentials satisfy Fluxer's extra authentication checks, called sudo checks.
     * No extra sudo fields or audit reason are accepted.
     * Fluxer handles attachment removal without guaranteeing physical provider-storage or CDN erasure
     *
     * The default 30,000 ms deadline includes capacity and rate-limit waits
     *
     * Only confirmed HTTP 429 rejection retries.
     * A 5xx or lost response never causes an uncertain replay
     *
     * After dispatch, the entire enabled message cache is cleared and older pending reads cannot restore it.
     * No gateway events are created locally
     *
     * Abort or closure waits for request cleanup but cannot undo deletion.
     * Input, capacity and HTTP failures return GuildOperationError for guilds.deleteMine.
     * Unexpected failures reject with SdkDefect
     *
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
    /**
     * Fetch a guild's custom invite code, URL and use count with ManageGuild permission.
     * A null code and URL means the guild has no custom invite.
     * The read is remote, without a vanity cache or gateway connection.
     * Shared guild read retries, deadline, cancellation and failure rules apply
     */
    fetchVanityUrl(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<GuildVanityUrlUsage, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Set a guild's custom invite code, replace it, or pass null to remove it.
     * The code must already be lowercase, 2–32 ASCII letters or digits with single internal hyphens.
     * No automatic normalization is performed
     *
     * ManageGuild is required.
     * Setting a code also requires the guild's VANITY_URL feature.
     * Reserved or taken codes fail remotely
     *
     * Changing a code releases the old code and starts a new use count.
     * Reclaiming the old code is not guaranteed
     *
     * Success returns the code and URL without a hidden use-count read, access check or gateway acknowledgement
     *
     * Shared guild deadlines and cleanup apply
     *
     * Only confirmed HTTP 429 rejection retries.
     * Dispatched writes invalidate guild snapshots
     *
     * For an uncertain result, call fetchVanityUrl before deciding how to recover.
     * Provider-side partial changes may need operator recovery and are not rolled back automatically
     */
    editVanityUrl(
        guildId: string,
        code: string | null,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildVanityUrl, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Change only supplied server settings that a bot may edit.
     * Omitted fields remain unchanged.
     * No old settings are fetched or merged automatically
     *
     * ManageGuild is required.
     * Fluxer checks feature restrictions and constraints beyond local GuildEdit validation.
     * Success returns the server's observed configuration, not gateway acknowledgement.
     * Shared guild write deadlines and abort cleanup apply.
     * Dispatched writes invalidate cached guild data even when the outcome is uncertain.
     * For a lost response, fetch before deciding to retry.
     * No rollback is guaranteed
     */
    edit(
        guildId: string,
        input: GuildEdit,
        options?: DefaultModerationOptions,
    ): ResultAsync<Guild, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Ban a user from a guild, including a user who is not currently a member.
     * Pass decimal guildId and userId.
     * The default ban is permanent and deletes no messages
     *
     * Fluxer requires BanMembers and checks role hierarchy and MFA rules
     *
     * HTTP 204 returns Ok(undefined), without waiting for an event
     *
     * Only confirmed HTTP 429 rejection retries.
     * A dispatched failure can leave the ban or queued message deletion applied
     *
     * Dispatched actions invalidate the cached member even on rejection.
     * If message cleanup was requested, this author's cached messages are removed across all guilds.
     * That broad removal includes unrelated guilds because message data need not contain guild IDs.
     * The deletion job can finish later, so a later cache hit does not prove a message survived
     *
     * Fluxer bans can also block rejoining through IP or email checks.
     * Unbanning restores neither deleted messages nor membership
     *
     * Shared guild deadlines, failures and cleanup apply.
     * Abort cannot undo a dispatched ban
     */
    ban(
        target: MemberReference,
        input?: BanInput,
        options?: DefaultModerationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Remove a user's guild ban and return Ok(undefined) after HTTP 204.
     * BanMembers is required.
     * A user who is not banned returns an API error, not a successful no-op.
     * The user is not rejoined and queued message deletion is not cancelled.
     * The ban method's execution, failures, cleanup and cached-member invalidation apply
     */
    unban(
        target: MemberReference,
        options?: DefaultModerationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch a guild's current full ban list with BanMembers permission.
     * Results are frozen.
     * There is no ban cache, pagination or guaranteed order.
     * Separate reads are not one consistent snapshot.
     * Shared guild deadlines and read retries apply.
     * A malformed response fails rather than returning a partial list
     */
    fetchBans(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly GuildBan[], GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Look up a guild synchronously in the enabled guild cache, without a request or gateway connection.
     * Ok(undefined) means caching is disabled or the entry is absent, expired or evicted.
     * Cached data may be stale.
     * Use fetch for a remote read.
     * A hit becomes more recently used without extending expiry.
     * Invalid decimal IDs return GuildOperationError with reason input.
     * Closing clients return ClientClosedError.
     * Unexpected failures throw SdkDefect
     */
    get(guildId: string): Result<Guild | undefined, GuildOperationFailure>
    /**
     * Fetch a guild's identity and settings by decimal ID.
     * Fluxer requires membership.
     * The result is a frozen snapshot.
     * This does not fetch or keep nested members, roles or channels, or infer counts or completeness
     */
    fetch(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<Guild, GuildOperationFailure | CancelledError | ConfigurationError>
}

/**
 * Read, create and change guild channels, with optional local cache lookup.
 * Use directMessages for private conversations instead.
 * Most methods use HTTP without a gateway connection.
 * The fetchMemberCounts method requires a ready gateway
 *
 * @remarks
 * Supply decimal guild-channel IDs.
 * ID-based writes do not fetch first to verify channel type.
 * Requests share the client's four REST or upload slots across assigned shards.
 * Four attachment-download slots are separate.
 * Both pools together allow 256 waiting requests or 4 MiB of queued JSON.
 * The default 30,000 ms deadline includes capacity, rate-limit and retry waits.
 * Eligible reads retry transport and HTTP 500, 502, 503 or 504 failures at most twice
 *
 * Writes retry only confirmed HTTP 429 rejection.
 * Input, permission, not-found and malformed responses do not retry
 *
 * Inputs are copied when called.
 * Permission values use bigint and are sent as decimal JSON strings.
 * Fluxer enforces permissions and restrictions on granting flags.
 * Targeted role and member overwrites require ManageRoles.
 * Any dispatched channel change clears the enabled channel cache.
 * Local input failure before dispatch preserves it.
 * No write is followed by an automatic confirmation fetch.
 * The create, edit, delete, reorder and permission-overwrite mutations accept a raw audit reason through
 * DefaultChannelAuditOperationOptions. Read operations reject auditReason instead of sending a meaningless header.
 * Expected failures return ChannelOperationError or ClientClosedError.
 * Abort returns CancelledError after cleanup.
 * Unexpected failures reject with SdkDefect
 */
export interface Channels {
    /**
     * Request fresh member counts for 1–25 channels in one guild over the connected gateway.
     * Use distinct positive decimal IDs without leading zeros, no greater than "18446744073709551615"
     *
     * The guild must have a ready shard assigned to this client, or the call fails with notConnected.
     * Fluxer requires ViewChannel and ViewChannelMembers
     *
     * The copied IDs produce frozen counts and omittedChannelIds in requested order.
     * Omission means unavailable, not zero, and does not explain access or other causes
     *
     * The guilds.fetchCounts method's four shared gateway slots, default 30,000 ms deadline and failure rules apply.
     * There is no queue, implicit connection, REST fallback, cache write or retry.
     * Only a gap on this guild's shard fails the request
     *
     * Counts are separate visibility-filtered observations, not a cross-channel snapshot.
     * Cancellation releases local work but cannot stop the dispatched provider request
     */
    fetchMemberCounts(
        guildId: string,
        channelIds: readonly string[],
        options?: DefaultCountOperationOptions,
    ): ResultAsync<ChannelMemberCountsResult, CountOperationFailure | CancelledError | ConfigurationError>
    /**
     * Look up a guild channel synchronously in the enabled cache, without an HTTP request.
     * Ok(undefined) means caching is disabled or the entry is absent, expired or evicted.
     * A hit may be stale and becomes more recently used without extending expiry.
     * Use fetch for a remote read.
     * Invalid decimal IDs return ChannelOperationError with reason input.
     * Closing clients return ClientClosedError.
     * Unexpected failures throw SdkDefect
     */
    get(channelId: string): Result<GuildChannel | undefined, ChannelOperationFailure>
    /**
     * Fetch a guild channel by decimal ID and return a frozen snapshot.
     * A private-channel response fails with a typed response error.
     * Permission overwrites describe explicit settings, not inherited or effective permissions.
     * This neither connects the gateway nor populates a complete guild-channel list
     */
    fetch(
        channelId: string,
        options?: DefaultChannelOperationOptions,
    ): ResultAsync<GuildChannel, ChannelOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch the guild channels currently visible to the bot, without pagination.
     * The returned list is a snapshot, not a subscription or completeness guarantee.
     * No members, roles, private channels or missing overwrite targets are fetched
     */
    fetchAll(
        guildId: string,
        options?: DefaultChannelOperationOptions,
    ): ResultAsync<readonly GuildChannel[], ChannelOperationFailure | CancelledError | ConfigurationError>
    /**
     * Create a supported guild channel and return its frozen server snapshot.
     * Fluxer chooses the initial position.
     * Omitting permissionOverwrites inherits the selected parent category's overwrites.
     * An empty [] creates no explicit overwrites, which does not make a channel private.
     * Explicit overwrites use Fluxer's required feature opt-in for ViewChannelMembers.
     * Each allow and deny mask must be from 0n through 9_223_372_036_854_775_807n. Invalid masks fail before dispatch.
     * The example denies ViewChannel to everyone and grants access to the named bot.
     * The application manages the created channel afterward.
     * For an uncertain create result, use fetchAll before deciding whether to create again.
     * The result does not confirm gateway delivery
     *
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
     */
    create(
        guildId: string,
        input: ChannelCreate,
        options?: DefaultChannelAuditOperationOptions,
    ): ResultAsync<GuildChannel, ChannelOperationFailure | CancelledError | ConfigurationError>
    /**
     * Change only the supplied channel settings and return the frozen server snapshot.
     * An empty input or unknown field fails locally.
     * Use reorder to change a parent or position.
     * Channel type cannot be edited here.
     * Omitted permissionOverwrites keeps the old list.
     * Each replacement allow and deny mask must be from 0n through 9_223_372_036_854_775_807n.
     * [] clears it.
     * Explicit replacement handles setting and clearing ViewChannelMembers through Fluxer's required feature opt-in
     */
    edit(
        channelId: string,
        input: ChannelEdit,
        options?: DefaultChannelAuditOperationOptions,
    ): ResultAsync<GuildChannel, ChannelOperationFailure | CancelledError | ConfigurationError>
    /**
     * Delete a guild channel and return Ok(undefined) after HTTP 204.
     * No gateway event is awaited and no prior channel existence is proven.
     * The SDK does not fetch the ID first.
     * A lost response or timeout after dispatch can leave it deleted
     */
    delete(
        channelId: string,
        options?: DefaultChannelAuditOperationOptions,
    ): ResultAsync<void, ChannelOperationFailure | CancelledError | ConfigurationError>
    /**
     * Submit guild-channel moves and return Ok(undefined) after HTTP 204.
     * Fluxer applies moves sequentially and may normalize positions.
     * The syncPermissionsOnMove option copies the destination category's overwrites.
     * A bulk channel event can arrive before that copy finishes.
     * Failures can leave partial movement because this is not a transaction.
     * Use fetchAll afterward when final order matters.
     * Fluxer currently accepts auditReason on this route without retaining it in an audit entry.
     * No reordered list is invented locally
     */
    reorder(
        guildId: string,
        positions: readonly ChannelPosition[],
        options?: DefaultChannelAuditOperationOptions,
    ): ResultAsync<void, ChannelOperationFailure | CancelledError | ConfigurationError>
    /**
     * Replace one explicit role or member permission overwrite.
     * Supply the target ID and raw bigint allow and deny flags.
     * Each mask must be from 0n through 9_223_372_036_854_775_807n. Larger received masks cannot be written unchanged.
     * HTTP 204 returns Ok(undefined).
     * Fluxer requires ManageRoles and uses a feature opt-in to set or clear ViewChannelMembers.
     * No target fetch or inherited-permission calculation is performed
     */
    setPermissionOverwrite(
        channelId: string,
        input: PermissionOverwrite,
        options?: DefaultChannelAuditOperationOptions,
    ): ResultAsync<void, ChannelOperationFailure | CancelledError | ConfigurationError>
    /**
     * Remove one explicit permission overwrite by decimal role or member target ID.
     * Other overwrites remain unchanged.
     * HTTP 204 returns Ok(undefined).
     * Fluxer requires ManageChannels and ManageRoles.
     * An uncertain result needs an explicit follow-up read
     */
    removePermissionOverwrite(
        channelId: string,
        targetId: string,
        options?: DefaultChannelAuditOperationOptions,
    ): ResultAsync<void, ChannelOperationFailure | CancelledError | ConfigurationError>
}

/**
 * Read guild members, search indexed members, moderate them and change role assignments.
 * HTTP methods use Guilds' shared request limits, deadlines and failure rules.
 * The iterateChunks method uses the connected gateway instead
 *
 * Returned members are frozen snapshots, not live objects.
 * The cache.members setting can retain observations, without downloading the guild automatically or predicting permissions
 *
 * Writes retry only confirmed HTTP 429 rejection.
 * Cancellation cannot undo a dispatched change
 * The setRoles, editSelf, setNickname, addRole and removeRole methods accept DefaultGuildAuditOperationOptions.
 * Member reads and searches reject auditReason. Moderation methods keep their more specific audited option types
 */
export interface Members {
    /**
     * Read one guild's members in gateway-delivered batches using a for await loop.
     * Choose explicit userIds, a query prefix, or `all: true`.
     * Each consumption copies the input and sends one request.
     * The guild must have a ready shard assigned to this client, otherwise notConnected is returned.
     * Full-list mode is capped by Fluxer at 100,000 members.
     * Fluxer's server-enforced 30-second limit per bot and guild also applies.
     * Only one member stream runs per client.
     * It also uses one of four gateway slots shared with counts.
     * Only a gap on this guild's shard ends the stream.
     * Work on healthy shards continues.
     * No connection, REST fallback, cache fill, presence subscription or retries are added
     *
     * Batches are frozen and follow provider chunk order.
     * The SDK checks batch indices, advertised batch count, unique members and matching presence data
     *
     * Successful completion means all advertised batches arrived, not a complete or atomic guild snapshot.
     * Missing selected user IDs are listed on the final batch
     *
     * Optional presence data can omit unavailable, offline or invisible users.
     * Omission does not prove offline status
     *
     * The timeoutMs option defaults to 30,000 for the whole reply.
     * The maxPendingBytes option defaults to 4 MiB of source-JSON bytes counted for unread gateway batches.
     * This bounds the SDK's byte accounting, not total memory use
     *
     * Fluxer sends batches without waiting for the loop, so slow readers can overflow.
     * Pausing the loop does not pause intake or the deadline
     *
     * Gateway loss, timeout, malformed replies or overflow drop unread batches and yield one terminal MemberChunkError.
     * Already yielded batches remain with the caller
     *
     * Client closure releases buffers and returns ClientClosedError.
     * Abort releases intake even while paused, returning CancelledError on the next pull.
     * Breaking the loop releases between pulls.
     * Abort the signal to interrupt a pending next
     *
     * Local cleanup cannot cancel Fluxer's dispatched work.
     * Late replies are ignored and Resume does not replay batches.
     * Unexpected failures reject with SdkDefect, retaining safe combined-failure details
     *
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
    /**
     * Replace one member's entire assigned role list in a single PATCH request.
     * Use 0–250 distinct positive decimal role IDs no greater than 9,223,372,036,854,775,807.
     * [] clears assigned roles.
     * Do not include the implicit everyone role
     *
     * IDs are copied by index when called, without fetching or merging the old roles.
     * Fluxer requires ManageRoles and checks hierarchy.
     * This can overwrite concurrent role changes
     *
     * Nonexistent or foreign role IDs may be silently omitted.
     * The returned frozen member reports the actual role set, not a guarantee that every requested role was accepted
     *
     * Shared guild write deadlines and confirmed HTTP 429 retries apply, without a gateway connection or event wait.
     * Eligible results can update the member cache.
     * Uncertain writes remove the old entry and need explicit fetch reconciliation
     *
     * Abort waits for cleanup but cannot undo the replacement.
     * Unexpected failures reject with SdkDefect
     *
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
        options?: DefaultGuildAuditOperationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Search Fluxer's member index for a guild, without using or populating the member cache.
     * Without filters, this reads 25 members ordered by newest join time first.
     * Recognized fields, including inherited and nonenumerable fields, are read and filter arrays copied when called.
     * Results can lag membership changes.
     * An indexing=true result means the search is not complete, not that it found no members.
     * Even an empty indexing=false result can mean Fluxer's search service is unavailable.
     * Counts do not guarantee completeness
     *
     * Join-source and invite filters first fetch the bot's guild permissions and require ManageGuild.
     * The three independent precheck reads run concurrently under the same total deadline. A failure cancels sibling reads.
     * Known permission denial returns members.search/rejected with outcome notDispatched and no HTTP status.
     * The precheck prevents knowingly sending ignored filters, but permissions can still change before search.
     * Other queries have no hidden reads.
     * Hits do not trigger full-member fetches.
     * The default 30,000 ms deadline covers the whole call, including that precheck.
     * Precheck GETs use eligible read retries.
     * Search POST retries only confirmed HTTP 429 rejection because it may queue indexing.
     * Shared guild capacity and cleanup apply
     *
     * Expected failures return GuildOperationError or ClientClosedError.
     * Abort returns CancelledError.
     * Unexpected SDK or cleanup failures reject with SdkDefect
     */
    search(
        guildId: string,
        filters?: MemberSearchQuery,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<MemberSearchPage, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Read indexed member-search hits in a for await loop with a bounded scan.
     * Pass maxItems.
     * The pageSize option defaults to 100 and accepts 1–100. The maxPages option defaults to 100
     *
     * Each consumption copies filters and their arrays, including recognized inherited and nonenumerable fields.
     * Pages are requested only as needed
     *
     * Offset advances by the number of hits received.
     * Each user is emitted at most once, keeping at most maxItems IDs to skip duplicates.
     * Index changes can still skip users, so the result is not a complete or consistent membership snapshot
     *
     * An indexing response returns PaginationError indexing instead of pretending the scan ended.
     * An empty page before the observed total returns cursorStalled.
     * Reaching maxItems is normal completion
     *
     * Each page uses search's timeout, permission precheck, retry and cache rules.
     * Input, pageLimit and cursorStalled are other PaginationError reasons.
     * One terminal Err follows previously delivered hits on expected failure
     *
     * Breaking the loop releases retained state.
     * Abort interrupts a pending pull and waits for cleanup.
     * Client closure releases the page
     */
    iterateSearch(
        guildId: string,
        filters: Omit<MemberSearchQuery, "limit">,
        limits: MemberSearchIterationLimits,
        options?: DefaultGuildOperationOptions,
    ): AsyncIterable<
        Result<MemberSearchHit, GuildOperationFailure | PaginationError | CancelledError | ConfigurationError>
    >
    /**
     * Change this bot's guild profile, not its global account or another member.
     * Omitted fields stay unchanged.
     * Passing null clears an override.
     * An empty input or unknown key fails locally.
     * Fluxer checks permissions and field-specific rate limits.
     * Avatar, banner, bio and accentColor can be silently ignored without the guild-profile entitlement.
     * The returned member excludes bio and pronouns, so success does not prove those fields were stored.
     * Uncertain writes or interruption remove the affected cache entry.
     * A definite rejection preserves the old snapshot
     */
    editSelf(
        guildId: string,
        input: MemberProfileEdit,
        options?: DefaultGuildAuditOperationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Set one member's nickname, or pass null to clear it.
     * A raw empty string fails. A nonempty string containing only trim whitespace is accepted as Fluxer's clear value.
     * Otherwise, validation removes U+000C and U+202E, trims surrounding whitespace, and requires 1–32 UTF-16 code units.
     * The original string is sent unchanged.
     * Other profile fields and roles stay unchanged.
     * Fluxer checks ManageNicknames, role hierarchy and self-target rules.
     * The frozen result follows HTTP, not a gateway event.
     * Shared guild write deadlines and retries apply.
     * Cancellation cannot undo a dispatched change.
     * An uncertain result removes the target's cache entry.
     * A definite rejection preserves it
     *
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
        options?: DefaultGuildAuditOperationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Move a member who is already in voice to a positive decimal voice-channel ID.
     * The target.connectionId value selects one observed connection.
     * Omit it to move every active connection for that member.
     * Fluxer requires MoveMembers and checks hierarchy, destination visibility and permission to connect.
     * The frozen HTTP member result means Fluxer accepted the move, not that the participant has reconnected.
     * A voiceStateUpdate event can first show channelId null, then a new connection ID in the destination.
     * Shared moderation deadlines, auditReason validation, confirmed HTTP 429 retries and member-cache invalidation apply.
     * A lost response or cancellation can leave the move applied.
     * Inspect later observations rather than retrying blindly
     *
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
    /**
     * Disconnect one observed voice connection, or all active connections if target.connectionId is omitted.
     * MoveMembers is required.
     * The returned member follows HTTP, without waiting for voiceStateUpdate.
     * A repeated call can fail because the member is no longer connected.
     * Use move's deadline, audit, permissions and cache rules.
     * An uncertain result needs later observations rather than blind replay
     */
    disconnect(
        target: VoiceConnectionReference,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Set or clear the server mute flag for a member currently connected to voice.
     * Pass true to mute or false to unmute.
     * Fluxer requires MuteMembers and checks hierarchy.
     * The returned member contains isMuted, without waiting for a voice event.
     * This does not control self-mute or connect the bot to voice.
     * The move method's deadline, audit, retry, cancellation and member-cache rules apply
     */
    setMute(
        target: MemberReference,
        muted: boolean,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Set or clear the server deafen flag for a member currently connected to voice.
     * Pass true to deafen or false to undeafen.
     * Fluxer requires DeafenMembers and checks hierarchy.
     * The returned member contains isDeafened, without waiting for a voice event.
     * This does not control self-deafen or connect the bot to voice.
     * The move method's deadline, audit, retry, cancellation and member-cache rules apply
     */
    setDeaf(
        target: MemberReference,
        deafened: boolean,
        options?: DefaultModerationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Temporarily restrict a guild member for durationMs milliseconds.
     * The duration must be an integer from 1 through 31,536,000,000 ms.
     * Expiry is calculated when the call starts, so queue and network time consume part of the duration.
     * If expiry is past when Fluxer processes it, the request can clear the timeout
     *
     * ModerateMembers and Fluxer's hierarchy rules apply.
     * Self and administrator targets are rejected
     *
     * The returned frozen member contains communicationDisabledUntil after HTTP 200, without waiting for an event
     *
     * Optional timeoutReason is provider audit metadata, separate from auditReason.
     * It is not a member field or a guarantee that an audit entry is retained
     *
     * Shared guild deadlines and failures apply
     *
     * Only confirmed HTTP 429 rejection retries.
     * Abort or closure waits for cleanup but cannot undo a dispatched timeout
     *
     * Eligible results update an enabled member cache.
     * Dispatched failures remove the member even on rejection.
     * Unexpected failures reject with SdkDefect
     *
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
        options?: DefaultTimeoutOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Clear a member's timeout and return the HTTP member snapshot.
     * This sends null rather than a negative duration.
     * The timeout method's permissions, deadline, execution, cache and failure rules apply.
     * No gateway event is awaited
     */
    clearTimeout(
        target: MemberReference,
        options?: DefaultTimeoutOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Remove a member from the guild and return Ok(undefined) after HTTP 204.
     * Fluxer requires KickMembers and checks hierarchy.
     * This does not ban the user, restore membership automatically or wait for a removal event.
     * Missing membership returns an API error.
     * Dispatched actions invalidate the member cache even on rejection.
     * The timeout method's execution, deadline and failure rules apply.
     * Uncertain results are not replayed
     */
    kick(
        target: MemberReference,
        options?: DefaultModerationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Read guild members by ascending user ID in a for await loop, without connecting the gateway.
     * Pass maxItems.
     * The pageSize and maxPages options both default to 100
     *
     * Each consumption copies inputs and keeps one page, requested only when needed.
     * An empty page or maxItems ends the scan, not a short page.
     * Items are frozen Ok members, followed by at most one terminal Err
     *
     * The timeoutMs option applies to each fetchPage call.
     * Remote failures keep that method's error and read retry policy.
     * PaginationError covers input, cursorStalled and pageLimit
     *
     * Abort interrupts a pending next and waits for cleanup.
     * Breaking the loop releases the buffer.
     * Client closure releases the page and fails the next pull with ClientClosedError.
     * Unexpected failures reject with SdkDefect
     *
     * Delivered members remain with the caller.
     * An enabled cache can receive page members.
     * No roles or permission decisions are fetched.
     * Separate pages are not a consistent membership snapshot
     *
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
    /**
     * Look up a guild member synchronously by decimal guildId and userId, without a request.
     * Enable cache.members to retain members. Enable cache.roles for local role-name lookup.
     * Explicit fetches or later gateway events can fill those caches.
     * Guilds.get's cache-miss, stale-snapshot, error and recency rules apply.
     * The example makes no requests when rendering observed role names.
     * A missing member gives undefined, and missing role names fall back to IDs.
     * Observed names are not effective permissions or proof of a complete role list
     *
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
     */
    get(member: MemberReference): Result<GuildMember | undefined, GuildOperationFailure>
    /**
     * Fetch one guild member by decimal guildId and userId.
     * A missing member returns a notFound error rather than an empty result
     */
    fetch(
        member: MemberReference,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch this bot's membership in a guild without knowing its user ID.
     * No gateway READY event or connection is required
     */
    fetchSelf(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<GuildMember, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Check whether the bot is above a target member in the guild's role hierarchy.
     * The helper fetches fresh guild, bot member, target member and role data in parallel, then applies canManageHierarchy.
     * One default 30,000 ms deadline covers those reads.
     * Failure or abort waits for sibling request cleanup.
     * No cache is read first and no helper result is retained.
     * Underlying reads can still populate enabled resource caches.
     * A true result covers only hierarchy using four separate observations that may change before an action.
     * It does not check permission bits or MFA, authorize an action or perform it
     *
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
    /**
     * Fetch one page of members ordered by ascending user ID.
     * The limit option defaults to 100 and accepts 1–1,000.
     * Use the last returned userId as after for another page.
     * Inputs are copied when called.
     * A malformed page fails as a whole.
     * An empty page ends a scan, but no hasMore guarantee or automatic traversal is provided.
     * Separate pages are not one consistent membership snapshot
     */
    fetchPage(
        guildId: string,
        query?: MemberQuery,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly GuildMember[], GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Grant one role to a member without replacing their other roles.
     * Use a decimal role ID, excluding the implicit everyone role.
     * Fluxer requires MANAGE_ROLES and checks hierarchy.
     * HTTP 204 returns Ok(undefined), not an event acknowledgement or proof the role was previously absent.
     * The example collects one future reaction addition before assigning the role.
     * Supply a connected client, an existing message in this guild and a role the bot can assign.
     * A timeout can collect nothing.
     * Fluxer currently accepts auditReason on member-role add/remove routes without retaining it in an audit entry.
     * This is not a persistent reaction-role system and does not revoke roles on removal
     *
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
     */
    addRole(
        member: MemberReference,
        roleId: string,
        options?: DefaultGuildAuditOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Remove one role from a member while leaving other roles unchanged.
     * The addRole method's permissions and completion rules apply.
     * The SDK sends the request even if a local snapshot lacks the role.
     * Success does not prove the role was previously assigned
     */
    removeRole(
        member: MemberReference,
        roleId: string,
        options?: DefaultGuildAuditOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
}

/**
 * Calculate permission flags from supplied data or fresh reads.
 * A permission value alone does not determine channel visibility, role hierarchy, timeouts or authorization for an action
 */
export interface PermissionHelpers {
    /**
     * Calculate permission flags synchronously from supplied guild, member, role and optional channel data.
     * No request or cache read is made.
     * This also works after client shutdown.
     * The bigint result ranges from 0n through 18_446_744_073_709_551_615n and preserves unknown flags.
     * Guild owner or base Administrator gets all flags.
     * Otherwise the calculation applies everyone, combined roles, then member overwrites.
     * Only the target channel's stored overwrites are used, not its parent category's.
     * Missing or inconsistent input returns GuildOperationError for permissions.calculate with reason input.
     * Unexpected failures throw SdkDefect
     */
    calculate(input: PermissionInput): Result<bigint, GuildOperationError>
    /**
     * Fetch guild, member, role and optional channel data, then calculate their permission flags.
     * No gateway connection or cache-first lookup is needed.
     * Underlying reads can enter enabled caches, but the calculated result is not cached.
     * The sequential reads are separate observations, so the result does not guarantee a later action will succeed.
     * The default 30,000 ms deadline covers the whole helper with shared read retries and awaited abort cleanup.
     * Invalid target or deadline returns permissions.fetch/input.
     * Resource errors retain their GuildOperationError or ChannelOperationError.
     * A channel from another guild fails instead of mixing guild data.
     * Client closure returns ClientClosedError.
     * Abort returns CancelledError.
     * Unexpected failures reject with SdkDefect
     */
    fetch(
        target: PermissionTarget,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<bigint, GuildOperationFailure | ChannelOperationFailure | CancelledError | ConfigurationError>
}

/**
 * Create, edit, order and delete guild roles, or read their current or cached data.
 * Shared Guilds request limits, deadlines and read retries apply.
 * Fluxer enforces permissions and hierarchy.
 * No local permission prediction is performed
 *
 * Writes retry only confirmed HTTP 429 rejection.
 * Abort waits for request cleanup but cannot undo a dispatched write
 *
 * Expected failures return GuildOperationError or ClientClosedError.
 * Unexpected failures reject with SdkDefect.
 * Inputs are copied when called.
 * Results are snapshots, not gateway acknowledgement.
 * Role permissions use bigint, which requires explicit conversion before JSON serialization
 * Every remote role mutation accepts DefaultGuildAuditOperationOptions. The fetchAll method rejects auditReason
 */
export interface Roles {
    /**
     * Look up a role synchronously by decimal guildId and id, including the everyone role.
     * No request is made.
     * Guilds.get's cache misses, stale-snapshot warnings, errors and recency rules apply
     */
    get(role: RoleReference): Result<GuildRole | undefined, GuildOperationFailure>
    /**
     * Fetch the guild's current role list, including everyone, in server order.
     * This always reads remotely, without pagination or background refresh
     */
    fetchAll(
        guildId: string,
        options?: DefaultGuildOperationOptions,
    ): ResultAsync<readonly GuildRole[], GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Create a role with a name, optional color and permission flags.
     * The permissions input defaults to 0n, rather than copying the everyone role's grants.
     * Supplied permissions must be from 0n through 9_223_372_036_854_775_807n.
     * Explicit permissions use Fluxer's feature opt-in for ViewChannelMembers.
     * The result reports the actual server grants, which can differ from the request.
     * Use a separate edit to change hoist or mentionable settings.
     * The application manages the created role afterward.
     * For an uncertain result, use fetchAll before deciding whether to create again
     *
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
     */
    create(
        guildId: string,
        input: RoleCreate,
        options?: DefaultGuildAuditOperationOptions,
    ): ResultAsync<GuildRole, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Change only supplied role fields and return the server's snapshot.
     * Empty inputs and unknown fields fail locally.
     * The permissions input replaces all raw grants rather than adding flags.
     * The replacement must be from 0n through 9_223_372_036_854_775_807n. Larger received masks cannot be written unchanged.
     * The replacement can set or clear ViewChannelMembers.
     * The everyone role accepts only color and permissions.
     * Other supplied fields fail, even in a mixed input
     */
    edit(
        role: RoleReference,
        input: RoleEdit,
        options?: DefaultGuildAuditOperationOptions,
    ): ResultAsync<GuildRole, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Delete a role and remove its member assignments in Fluxer.
     * The everyone role cannot be deleted.
     * HTTP 204 returns Ok(undefined), without proving member-event delivery.
     * Snapshots already returned to the caller remain unchanged
     */
    delete(
        role: RoleReference,
        options?: DefaultGuildAuditOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Change role hierarchy positions using distinct role IDs and nonnegative safe-integer positions.
     * The everyone role cannot move.
     * HTTP 204 returns Ok(undefined), without a new role list.
     * Fluxer normalizes manageable positions, so use fetchAll if final order matters.
     * This is not a transaction.
     * A failure can leave partial changes, requiring a fresh read before recovery
     */
    reorder(
        guildId: string,
        positions: readonly RolePosition[],
        options?: DefaultGuildAuditOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Set roles' display positions without changing their permission hierarchy or enabling hoist.
     * Pass a nonempty list of distinct role IDs with integer hoistPosition values from -2,147,483,648 through 2,147,483,647.
     * The everyone role is excluded.
     * Fluxer checks ManageRoles and hierarchy.
     * HTTP 204 returns Ok(undefined), not a role list.
     * Successful or uncertain writes invalidate cached guild roles and conflicting pending reads.
     * Failure or abort can leave partial changes.
     * Refetch before deciding to replay
     *
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
        options?: DefaultGuildAuditOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
    /**
     * Clear display-position assignments across the guild, including roles above the bot.
     * Fluxer requires ManageRoles.
     * Permission hierarchy and hoist flags remain unchanged.
     * HTTP 204 returns Ok(undefined), not a role list.
     * Changes are not transactional and a failure can be partial.
     * Successful or uncertain writes invalidate cached guild roles.
     * Refetch to resolve an uncertain result
     */
    resetHoistPositions(
        guildId: string,
        options?: DefaultGuildAuditOperationOptions,
    ): ResultAsync<void, GuildOperationFailure | CancelledError | ConfigurationError>
}

/**
 * Manage webhooks with this bot's credentials, without connecting the gateway.
 * Use createWebhookClient for a separate client that sends using a webhook's own token.
 * Metadata excludes tokens.
 * There is no webhook cache or hidden credential storage.
 * The default 30,000 ms total deadline includes capacity, rate-limit and retry waits.
 * Eligible reads have bounded retries.
 * Writes retry only confirmed rate-limit rejection.
 * Success JSON is limited to 16 MiB before parsing, not total memory.
 * Malformed or larger successes return reason response.
 * After dispatch, a failed response can leave the write applied and is not retried automatically.
 * Abort returns CancelledError after cleanup.
 * Unexpected failures reject with SdkDefect.
 * Client shutdown rejects new work and waits for active request cleanup.
 * Separate clients do not coordinate rate limits
 */
export interface Webhooks {
    /**
     * Create a webhook in a channel using the bot's permissions.
     * The result separates metadata from credentials, which expose the token only through revealToken.
     * Credentials passed to createWebhookClient must remain private.
     * An uncertain response may have left the webhook created
     */
    create(
        channelId: string,
        input: WebhookCreate,
        options?: DefaultWebhookOperationOptions,
    ): ResultAsync<CreatedWebhook, WebhookOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch webhook metadata by decimal ID, excluding the returned token.
     * A missing webhook returns notFound
     */
    fetch(
        id: string,
        options?: DefaultWebhookOperationOptions,
    ): ResultAsync<Webhook, WebhookOperationFailure | CancelledError | ConfigurationError>
    /**
     * List the channel's accessible webhook metadata without pagination.
     * No tokens are retained and no webhook cache is filled
     */
    fetchChannel(
        channelId: string,
        options?: DefaultWebhookOperationOptions,
    ): ResultAsync<readonly Webhook[], WebhookOperationFailure | CancelledError | ConfigurationError>
    /**
     * List the guild's accessible webhook metadata.
     * Fluxer permissions determine visibility.
     * Concurrent changes mean this is not a stable snapshot
     */
    fetchGuild(
        guildId: string,
        options?: DefaultWebhookOperationOptions,
    ): ResultAsync<readonly Webhook[], WebhookOperationFailure | CancelledError | ConfigurationError>
    /**
     * Change the supplied webhook settings, including its destination channel.
     * Returned metadata excludes credentials.
     * A failed response does not guarantee the changes were rolled back
     */
    edit(
        id: string,
        input: WebhookEdit,
        options?: DefaultWebhookOperationOptions,
    ): ResultAsync<Webhook, WebhookOperationFailure | CancelledError | ConfigurationError>
    /**
     * Delete a webhook and revoke its credential.
     * Existing webhook messages remain.
     * A failure does not restore a credential that was already revoked
     */
    delete(
        id: string,
        options?: DefaultWebhookOperationOptions,
    ): ResultAsync<void, WebhookOperationFailure | CancelledError | ConfigurationError>
}

/**
 * Send and manage messages with one webhook's token, without a bot token or gateway.
 * Create this with createWebhookClient and always await shutdown when finished
 *
 * @remarks
 * No cache or persistent token store is created, and other clients' caches are not updated.
 * Calls start immediately and return ResultAsync for expected successes and failures.
 * The default 30,000 ms total deadline includes capacity, rate-limit, retry and HTTP waits.
 * Confirmed HTTP 429 responses use this client's shared rate-limit state as described on Client.
 * Abort cancels only the operation and waits for request and body cleanup, without reversing remote changes.
 * Errors include safe categories and status, not token-bearing paths or response bodies.
 * Successful JSON is capped at 16 MiB before parsing, not total memory.
 * A failed response after sending a write leaves an uncertain result and is not retried automatically.
 * Unexpected SDK or cleanup failures reject with SdkDefect.
 * Cleanup failure stops retries and keeps safe details of any accompanying operation failure or cancellation
 */
export interface WebhookClient {
    /**
     * The webhook's ID, without its token or a token-bearing URL
     */
    readonly id: string
    /**
     * Resolve this webhook client's selected instance and get URL helpers for it
     */
    readonly instance: Instance
    /**
     * Fetch this webhook's current metadata using its token, not bot authentication.
     * Creator and private fields are not retained
     */
    fetch(
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<Webhook, WebhookOperationFailure | CancelledError | ConfigurationError>
    /**
     * Change this webhook's name or avatar using its token and return metadata without credentials.
     * To move it to another channel, use a bot client's webhooks.edit.
     * A failed or cancelled write can still have applied.
     * This method does not close the client
     */
    edit(
        input: WebhookTokenEdit,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<Webhook, WebhookOperationFailure | CancelledError | ConfigurationError>
    /**
     * Delete this webhook remotely using its token and return after HTTP 204.
     * This does not close the client or release its local credential reference.
     * Later requests normally return notFound because the token was revoked.
     * Call shutdown separately to release the client's local resources
     */
    delete(
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, WebhookOperationFailure | CancelledError | ConfigurationError>
    /**
     * Send a webhook message and return the created message after Fluxer's HTTP response.
     * The SDK uses wait=true.
     * Mentions are disabled by default
     *
     * Reply references can include files.
     * Forward references preserve only the source snapshot and reject new content or uploads
     *
     * Metadata and data-byte inputs are copied when called.
     * Sized file sources and finite exact-size streams are read later without copying or spooling.
     * Keep file data stable and do not reuse a consumed stream
     *
     * Multipart file uploads are streamed with a maximum of 50 MiB per file.
     * An attachment:// image or thumbnail URL must match a new upload in this request.
     * The flags input accepts only the two non-voice MessageFlags bits
     *
     * An uncertain failure can leave the message posted and is never replayed automatically.
     * A confirmed inline HTTP 429 can replay copied data bytes, but file and stream inputs return rateLimit without rereading
     */
    send(
        input: WebhookMessageInput,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<Message, WebhookOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch a message authored by this webhook in its current channel, using a decimal message ID.
     * Eligible transient read failures have bounded retries
     */
    fetchMessage(
        messageId: string,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<Message, WebhookOperationFailure | CancelledError | ConfigurationError>
    /**
     * Change this webhook's message and return its updated snapshot.
     * Omitted fields stay unchanged.
     * Mentions default off and attachments cannot be replaced.
     * A flags-only edit replaces the two writable non-voice flags.
     * 0 clears them.
     * Embed input cannot resolve existing file references
     */
    editMessage(
        messageId: string,
        input: WebhookMessageEdit,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<Message, WebhookOperationFailure | CancelledError | ConfigurationError>
    /**
     * Delete this webhook's message and return Ok(undefined) after HTTP 204.
     * Success does not prove it previously existed.
     * An uncertain failure can follow a completed deletion
     */
    deleteMessage(
        messageId: string,
        options?: DefaultMessageOperationOptions,
    ): ResultAsync<void, WebhookOperationFailure | CancelledError | ConfigurationError>
    /**
     * Permanently stop this local client, cancel active work and await transport cleanup.
     * The client's token reference is released, but the remote webhook and caller-held credentials remain.
     * Concurrent calls wait for the same pending cleanup.
     * No expected Err is returned.
     * Unexpected cleanup failures reject with SdkDefect
     */
    shutdown(): ResultAsync<void, never>
}

/**
 * Inspect or clear data already held in this client's caches.
 * These methods do not fetch, refresh or change remote resources
 */
export interface ClientCache<M extends MessageCore = Message> {
    /**
     * Return frozen snapshots from one configured cache category, ordered least to most recently used.
     * The limit option defaults to 100 and accepts a positive safe integer from 1 through 1,000.
     * Expired entries are released first.
     * Enumeration neither refreshes them nor changes eviction order.
     * Unlike diagnostics, the array contains actual cached resource data.
     * It may be partial because cache limits, expiry, conflicts, gateway gaps, clear or shutdown can discard entries.
     * A closed client returns an empty array.
     * Invalid kind or limit returns ConfigurationError without exposing the rejected value.
     * This is synchronous and takes no signal
     */
    entries<K extends CacheKind>(
        kind: K,
        options?: CacheEntriesOptions,
    ): Result<readonly CachedResources<M>[K][], ConfigurationError>
    /**
     * Release data held by this client's caches without changing which caches are enabled.
     * Objects already returned to the caller, requests and remote resources stay unchanged.
     * Older in-flight reads cannot refill the cleared entries.
     * Later reads can cache normally.
     * Existing write-related invalidation remains in effect.
     * This is synchronous, takes no signal and can be repeated, including after closure
     */
    clear(): void
}

/**
 * Use a bot client for messages, guild resources, HTTP requests and gateway events.
 * Call methods directly.
 * The SDK runs asynchronous work and returns ResultAsync. Await it to receive Ok or Err.
 * If isErr() is true, read error.
 * Otherwise, read value.
 * Expected failures are Err values.
 * Unexpected SDK or cleanup failures reject with SdkDefect.
 * Use run for a connection lifetime controlled by its signal.
 * Alternatively, connect for startup, waitForClose for terminal failure, and shutdown for final cleanup
 *
 * @remarks
 * A malformed options.signal returns ConfigurationError for signal before work starts.
 * A valid aborted signal returns CancelledError.
 * Cleanup failure stops retries and preserves safe details of an accompanying failure or cancellation.
 * Shared REST success JSON is limited to 16 MiB before parsing, not total memory.
 * Upload-plan and completion responses have a separate 1 MiB limit
 *
 * Confirmed HTTP 429 responses with a valid retry delay pause all of this client's API routes when
 * X-RateLimit-Global is true, X-RateLimit-Scope is global, or the bounded JSON body has global: true.
 * A valid global assertion wins over conflicting local metadata. Malformed scope values are ignored.
 * A global header with a valid Retry-After starts the pause before body inspection, including when
 * the body is missing, malformed, oversized or too slow. Body inspection stays bounded to 8 KiB and 100 ms before awaited cleanup.
 * Without global metadata, only requests in the same rate-limit group wait. Without a usable delay, the rejection fails instead of guessing how long to wait.
 * Waits remain within each call's original deadline. Cancelling a queued call removes only that call, not the shared pause.
 * Separate clients do not coordinate these waits. Attachment downloads do not wait for API rate limits.
 * Writes retry only confirmed rate-limit rejection, never an uncertain outcome
 *
 * Valid X-RateLimit-Bucket metadata tells the client which requests share a rate limit, without application configuration.
 * For known Fluxer routes, requests remain grouped by their channel, guild, user, webhook or invite resource.
 * Unknown routes reporting the same bucket identifier share one rate-limit group within this client.
 * Initial requests can still receive 429 before the server's grouping is learned.
 * Each client tracks at most 2,048 route aliases and 2,048 rate-limit groups. Unused aliases expire after five minutes unless a pause is still active.
 * An older response cannot replace a newer grouping or lift a rate-limit pause early. Regrouping preserves an existing pause until it expires.
 * When tracking is full, the client discards groups without active pauses first. If active pauses fill capacity or a request cannot be grouped safely,
 * the client waits rather than ignoring a known limit. Closing the client clears this temporary tracking data
 *
 * Each gateway connection accepts complete uncompressed text messages up to 100 MiB (104,857,600 bytes), including fragments combined.
 * The transport enforces this fixed receive ceiling before UTF-8 decoding and JSON parsing. It preserves the previous transport default.
 * This is not a Fluxer server-to-client maximum, an outbound command limit, a subscription budget or a JavaScript heap bound.
 * Larger messages fail with ConnectionError, phase gateway, reason protocol and status 1009. Invalid UTF-8 uses status 1007.
 * Neither rejection retries automatically. Standalone connect failure awaits cleanup and permits another explicit connect,
 * while a managed run or an established connection ends the client lifetime. Later failures are observable through waitForClose
 */
export interface Client<M extends MessageCore = Message> extends ClientState {
    /**
     * Find this client's instance endpoints and get asset and link helpers for that instance
     */
    readonly instance: Instance
    /**
     * Search the public guild directory and manage listings, without joining guilds
     */
    readonly discovery: Discovery
    /**
     * Set bot status or select member presence updates, restored after reconnect but not process restart
     */
    readonly presence: Presence
    /**
     * Read selected fields for the authenticated bot's application, without owner or management access
     */
    readonly application: CurrentBotApplication
    /**
     * Fetch public account data or look up an account in the optional local cache
     */
    readonly users: Users
    /**
     * Open and manage one-to-one or group conversations.
     * Use messages for content operations once the channel IDs are known
     */
    readonly directMessages: DirectMessages<M>
    /**
     * Manage webhooks with the bot's permissions, returning metadata without tokens
     */
    readonly webhooks: Webhooks
    /**
     * Manage guild roles or look up roles in an explicitly enabled local cache
     */
    readonly roles: Roles
    /**
     * Calculate permission flags locally or from fresh resource reads, without caching decisions
     */
    readonly permissions: PermissionHelpers
    /**
     * Read guild data and memberships, manage bans, or use the optional local guild cache
     */
    readonly guilds: Guilds
    /**
     * Inspect, create, list and revoke invite codes, without using them to join
     */
    readonly invites: Invites
    /**
     * Read filtered audit pages or bounded entry scans, without retaining an audit cache
     */
    readonly auditLogs: AuditLogs
    /**
     * Manage custom emoji and optionally look up their cached metadata
     */
    readonly emojis: Emojis
    /**
     * Manage custom stickers and optionally look up their cached metadata
     */
    readonly stickers: Stickers
    /**
     * Read or change guild channels and optionally look up cached channel data
     */
    readonly channels: Channels
    /**
     * Read or moderate guild members and change their assigned roles
     */
    readonly members: Members
    /**
     * Refresh signed attachment URLs explicitly or download from this instance's discovered media path with byte limits
     */
    readonly attachments: Attachments
    /**
     * Read, send, edit and delete messages, or collect future messages and reactions
     */
    readonly messages: Messages<M>
    /**
     * Enumerate or release locally cached data.
     * Caching is disabled unless enabled in ClientOptions.cache
     */
    readonly cache: ClientCache<M>
    /**
     * Register a callback for future events of one type, before or after connecting the client.
     * Use the returned Subscription to unsubscribe and observe waitForClose.
     * No history is replayed and HTTP operations do not create events locally.
     * Bulk deletion events do not also call messageDelete handlers.
     * Enabled cache updates happen before callbacks and do not depend on a subscription succeeding
     *
     * Callbacks run one at a time by default.
     * Increasing concurrency keeps receive-order starts, but not completion order.
     * Each subscription has its own ordering and queue.
     * Default pending limits are 256 payloads or 4 MiB of full source JSON, not total process memory.
     * A bulk payload counts once, including all its bytes.
     * Overflow closes only this subscription.
     * Callback failure is reported without retrying that invocation
     *
     * Return or await asynchronous callback work, and inspect Err results from message operations.
     * The second callback argument is a signal requesting cancellation on unsubscribe or shutdown.
     * The SDK cannot stop promises that ignore it or manage work the callback did not return.
     * Observe the subscription's outcome as well as the client's run or waitForClose outcome.
     * Catch callback exceptions locally to inspect their original error and stack.
     * The onError callback and SDK logs keep only safe event and failure-kind data, not the original exception.
     * Keep credentials, event payloads and arbitrary exception text out of logs.
     * Local registration failures return Err.
     * Unexpected synchronous failures throw SdkDefect
     *
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
     *             // Inspect here, such as at a debugger breakpoint, rather than logging the raw exception
     *             try {
     *                 inspectFailure(error)
     *             } finally {
     *                 throw error // Let the SDK report the failure without exposing the original exception
     *             }
     *         }
     *     })
     * }
     * ```
     */
    on<K extends EventName>(
        event: K,
        handler: (message: EventMap<M>[K], signal: NonNullable<OperationOptions["signal"]>) => void | Promise<void>,
        options?: EventHandlerOptions,
    ): Result<Subscription, RegistrationError>
    /**
     * Open a subscription to request future events one at a time.
     * Call next for each payload and unsubscribe when finished.
     * Payloads follow receive order, with bounded buffering and no history replay or splitting of bulk events.
     * Enabled cache changes happen before delivery and remain independent of subscription overflow.
     * Registration failures return Err.
     * Unexpected failures throw SdkDefect
     */
    events<K extends EventName>(
        event: K,
        options?: EventBufferOptions,
    ): Result<EventSubscription<K, M>, RegistrationError>
    /**
     * Wait for the first future event of one type that passes the supplied synchronous filter.
     * Observation starts immediately, without connecting the client, reading history or making a remote request
     *
     * The default timeout is 30,000 ms from registration.
     * A timeout or invalid or throwing filter returns EventWaitError without input or exception text.
     * Inspect a filter exception inside the filter before rethrowing if needed
     *
     * Buffer limits match events.
     * Reconnection can miss events and does not reset the deadline.
     * Overflow, invalid configuration and client closure remain distinct failures
     *
     * Abort returns CancelledError after subscription cleanup.
     * Completion releases the queue, filter, timer and subscription.
     * Unexpected SDK or cleanup failures reject with SdkDefect
     *
     * This returns an event, not a registration handle.
     * Use events or a collector to confirm registration before triggering an action
     *
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
        options?: DefaultEventWaitOptions<K, M>,
    ): ResultAsync<EventMap<M>[K], EventWaitFailure | CancelledError | ConfigurationError>
    /**
     * Read a frozen local report of active work, queues and cache occupancy.
     * No request, telemetry or persistent record is created.
     * The report excludes tokens, routes, resource IDs and payloads.
     * Counts cover only this client's assigned shards and local work.
     * Event counts include open sources, message/reaction collectors and executing subscription handlers, not an enforced client-wide admission quota.
     * Accounted cache and queue bytes are not heap memory, process memory or remote storage.
     * After closure, configured limits remain visible and retained counts show cleanup progress.
     * These values do not prove remote completeness or gateway readiness.
     * This is synchronous and takes no signal
     */
    diagnostics(): ClientDiagnostics
    /**
     * Connect the gateway and return when every shard assigned to this client has authenticated and received READY.
     * This does not wait for GUILD_CREATE, a full guild roster or all resources to load.
     * After success, the connection and automatic recovery continue until shutdown or permanent failure.
     * Use waitForClose to observe that later outcome
     *
     * The call controls startup only, using the client's connection settings.
     * Abort or expected failure before initial readiness waits for shard cleanup and leaves the client Disconnected for reuse.
     * After success, the startup signal no longer affects the session.
     * An already-connected client not managed by run succeeds without opening another socket.
     * A competing call returns ClientBusyError without disturbing active work.
     * Closing clients return ClientClosedError.
     * After initial readiness, permanent failure of a required shard in a multi-shard plan closes the client.
     * The waitForClose method retains ShardConnectionError with shardId and failure.
     * Unexpected SDK or cleanup failures reject with SdkDefect
     */
    connect(options?: OperationOptions): ResultAsync<void, ConnectError | CancelledError | ConfigurationError>
    /**
     * Start and maintain a gateway connection until shutdown, permanent failure or cancellation.
     * Use this when one AbortSignal should control the whole connection lifetime.
     * The call stays pending while connected or recovering.
     * Once run is accepted, its end always leaves the client Closed after cleanup.
     * Success means normal shutdown, not merely reaching READY.
     * A permanent required-shard failure after readiness closes a multi-shard client with ShardConnectionError
     *
     * The run method requires a Disconnected client with no competing connection work.
     * A rejected or pre-cancelled call does not take over or close the client.
     * Expected connection, busy, closed and cancellation failures return Err.
     * Unexpected SDK or cleanup failures reject with SdkDefect, including failures during cancellation cleanup
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
     *     } finally {
     *         await created.value.shutdown()
     *     }
     * }
     * ```
     */
    run(options?: OperationOptions): ResultAsync<void, ConnectError | CancelledError | ConfigurationError>
    /**
     * Wait for this client's final shutdown or permanent connection failure, without starting a connection.
     * Recovery keeps the wait pending.
     * An expected connect failure before initial readiness also leaves this wait pending. The client can connect again.
     * Multiple or later waiters receive the same terminal outcome.
     * Normal shutdown returns Ok(undefined).
     * A permanent connection failure returns Err.
     * After initial readiness, required-shard failure in a multi-shard plan is retained as ShardConnectionError.
     * Aborting this wait cancels only this wait, not the client or other waiters.
     * Unexpected background or cleanup failures reject with SdkDefect
     */
    waitForClose(options?: OperationOptions): ResultAsync<void, ConnectionFailure | CancelledError | ConfigurationError>
    /**
     * Permanently close this client and wait for startup, recovery, sockets and request cleanup.
     * Credentials, cached references, presence intent and expiry timers are released.
     * Active message and reaction collector callbacks receive cancellation, and their returned promises are awaited.
     * A callback that ignores its signal can delay shutdown.
     * Application reporter promises are not awaited.
     * Repeated and concurrent calls share the shutdown outcome.
     * A pending connection call returns ClientClosedError rather than caller cancellation
     *
     * Established sockets get up to 5,000 ms to close gracefully, then are terminated and their close events awaited.
     * Pending handshakes are terminated immediately.
     * Forced termination can discard unsent data.
     * No signal is accepted that could abandon cleanup, and this method never exits the application.
     * Create a new client to connect again.
     * Success is Ok(undefined) after cleanup.
     * Unexpected SDK or cleanup failures reject with SdkDefect.
     * Its sanitized reasons retain interruption and defect classifications without exposing raw cleanup values
     */
    shutdown(): ResultAsync<void, never>
    /**
     * Receive the current connection state, then later state updates.
     * Callbacks run asynchronously, one at a time per subscriber, awaiting a returned promise.
     * While a callback is busy, only the newest pending state is kept.
     * Slow listeners can miss intermediate states without delaying recovery.
     * A failed callback produces a safe report and does not close the client.
     * The returned function unsubscribes and drops pending delivery, without stopping the client.
     * It cannot cancel callback code already running.
     * Use waitForClose, not state changes, to observe the client's terminal failure
     */
    observeState(listener: (state: ConnectionState) => void | Promise<void>): () => void
}

/**
 * Find the selected Fluxer instance's endpoints and build links and asset URLs for it.
 * The resolve method fetches the unauthenticated well-known document only when needed.
 * Concurrent callers share that request.
 * A successful frozen result is retained until client shutdown, without background refresh.
 * Cancelling one caller leaves other callers using the request.
 * The last departing caller waits for discovery cleanup
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
    /**
     * Return this client's instance endpoints and its pure link and asset URL helpers.
     * The unauthenticated discovery request is shared with other resolves, REST work or gateway startup.
     * The timeoutMs option defaults to 30,000 for this wait only.
     * Abort cancels this wait, not other users of discovery.
     * Document, rate-limit, timeout, closure and invalid timeout-option failures return Err.
     * Unexpected cleanup failures reject with SdkDefect, retaining safe details of accompanying failure or interruption
     */
    resolve(
        options?: DefaultInstanceResolveOptions,
    ): ResultAsync<ResolvedInstance, InstanceResolveError | CancelledError | ConfigurationError>
}

/**
 * Set the discovery-wait timeout in milliseconds and optionally pass an AbortSignal.
 * The signal cancels only this caller's wait
 */
export interface DefaultInstanceResolveOptions extends InstanceResolveOptions, OperationOptions {}

/**
 * Configure a single client.waitFor call with a filter, limits and optional AbortSignal.
 * The signal cancels this event wait, not the client
 */
export interface DefaultEventWaitOptions<K extends EventName, M extends MessageCore = Message>
    extends EventWaitOptions<K, M>, OperationOptions {}

type OperationFailure =
    | ConfigurationError
    | CancelledError
    | ConnectError
    | CriticalWorkerStoppedError
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
    | AttachmentRefreshFailure
    | OAuthOperationFailure

const executeOperation = <A, E extends OperationFailure>(
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

function defaultCollector<M extends MessageCore>(source: MessageCollector<M>): Collector<M> {
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

function fromExit<A, E extends OperationFailure>(
    exit: Exit.Exit<A, E>,
    operation: Operation,
): Result<A, E | CancelledError> {
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
 * Create a client that uses one webhook's token rather than bot authentication.
 * Pass { id, token } or the credentials returned by a bot client's webhooks.create.
 * Creation is synchronous, validates locally and makes no request.
 * It copies the credential into a separate reference that hides the token when displayed.
 * Reuse one client per credential to share its request limits and rate waits.
 * The default instance is hosted Fluxer.
 * A self-hosted instance can be selected explicitly.
 * No token store or gateway is created.
 * Always await shutdown in finally when finished.
 * Invalid settings return ConfigurationError.
 * Unexpected creation failures throw SdkDefect
 *
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
}

/**
 * Set the bot's displayed status or request updates for selected guild members.
 * Outgoing status is sent to live shards assigned to this client, at least four seconds apart per shard.
 * Member selections use separate bounded gateway requests.
 * Neither operation has a provider acknowledgement or recipient-delivery guarantee.
 * The SDK does not fetch membership or filter out self.
 * Fluxer decides access and which updates are visible
 */
export interface Presence {
    /**
     * Set the bot's requested status and optional custom status, including before connecting.
     * The input is validated and frozen synchronously.
     * Omitted customStatus keeps the previous request.
     * Passing null clears it.
     * Expired custom statuses are not restored after reconnect.
     * Ok(undefined) means the request was accepted locally and scheduled for each shard, not acknowledged by Fluxer.
     * Shutdown releases this intent and its timer.
     * Unexpected failures throw SdkDefect
     *
     * @example
     * ```ts
     * import { MemberMentionPreferences, type Client } from "@neontechspace/fluxerly"
     * export async function botProfileExample(client: Client, guildId: string) {
     *     const presence = client.presence.set({ status: "online", customStatus: { text: "Ready", emoji: { name: "🌱" } } })
     *     if (presence.isErr()) return presence
     *     return client.members.editSelf(guildId, { nickname: "Support", mentionFlags: MemberMentionPreferences.PreferNoMention })
     * }
     * ```
     */
    set(input: PresenceInput): Result<void, PresenceFailure>
    /**
     * Request presence updates for selected members in one guild.
     * Register a presenceUpdate listener, then pass accessible non-self member IDs.
     * Pass [] to clear the selection.
     * Closing the listener does not clear it.
     * No full-member subscription, member lookup or presence cache is created.
     * The guild must belong to a shard assigned to this client, or PresenceError input is returned
     *
     * Inputs are copied and retained synchronously.
     * Up to 1,000 distinct decimal IDs are accepted, but the full UTF-8 gateway frame must fit 4,096 bytes.
     * Long IDs therefore reduce the effective per-guild maximum.
     * The client retains selections for at most 100 guilds and 10,000 IDs.
     * Clearing an unsent selection releases its slot immediately.
     * Clearing a selection already sent keeps one bounded session slot until fresh Identify or confirmed guild leave.
     * A local socket write cannot confirm that Fluxer applied a clear
     *
     * After READY or RESUMED, the latest selection or clear is combined and attempted at most once per 125 ms.
     * Sending the same list again deliberately requests a refresh.
     * A matching guild creation also retries the latest selection or a previously sent clear.
     * None of these attempts guarantees an event or proves provider acceptance.
     * Initial state and transitions can be missed during recovery.
     * Loss of shared channel visibility can remove the provider subscription.
     * Resend the selection after access returns.
     * Clear explicitly or shut down the client to release local intent.
     * Input or limit failures return PresenceError.
     * Closing clients return ClientClosedError.
     * Unexpected failures throw SdkDefect
     *
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

/**
 * Read the authenticated bot's application identity and selected public settings.
 * No gateway connection, application management or authorization-page navigation is performed.
 * The GET uses shared request limits, a 30,000 ms default deadline and at most two transient read retries.
 * The frozen result is not cached.
 * Owner identity, redirect URIs, verification keys, client secrets and nested bot fields are excluded.
 * Fluxer decides application visibility and installability.
 * Input, HTTP and malformed-response failures return BotApplicationOperationError.
 * Closure returns ClientClosedError.
 * Abort waits for cleanup and returns CancelledError.
 * Unexpected failures reject with SdkDefect
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
    /**
     * Fetch this bot token's application data from /oauth2/applications/@me.
     * Only the documented fields are returned, frozen, without cache storage, owner lookup or follow-up requests
     */
    fetchCurrent(
        options?: DefaultBotApplicationOperationOptions,
    ): ResultAsync<BotApplication, BotApplicationOperationFailure | CancelledError | ConfigurationError>
}

/**
 * Read public user account and profile data, without connecting the gateway.
 * Use get for an explicitly enabled local account cache, or fetch for a remote read.
 * HTTP calls start immediately with a 30,000 ms default deadline and bounded eligible read retries.
 * Any writes retry only confirmed rate-limit rejection, not an uncertain outcome.
 * Abort waits for cleanup and returns CancelledError.
 * Unexpected failures reject with SdkDefect
 */
export interface Users {
    /**
     * Look up a public account synchronously in the optional cache using its decimal ID.
     * A hit may be stale and becomes more recently used without extending its age.
     * A miss returns Ok(undefined), without a request.
     * A closed client returns an error
     */
    get(id: string): Result<User | undefined, UserOperationFailure>
    /**
     * Fetch a public account snapshot by decimal user ID.
     * An unknown user returns notFound rather than an empty result.
     * An enabled user cache admits this ID independently of unrelated targeted user reads
     */
    fetch(
        id: string,
        options?: DefaultUserOperationOptions,
    ): ResultAsync<User, UserOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch a user's privacy-filtered profile, optionally for the guild specified in query.guildId.
     * The frozen result includes only documented identity and profile fields.
     * The isLimited field reports Fluxer's privacy restriction, not missing guild membership.
     * A guildProfile=null result means no contextual profile was supplied, not proof the user is outside the guild.
     * No gateway connection, hidden member fetch or account or profile cache use is performed.
     * Users' shared deadlines and eligible read retries apply.
     * Fluxer may clear expired premium state while serving this GET.
     * Invalid input, denied access or malformed response returns UserOperationError for users.fetchProfile.
     * Abort affects this request only and waits for cleanup.
     * Unexpected failures reject with SdkDefect
     *
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
    /**
     * Fetch the authenticated bot's public account data remotely.
     * Private account fields are excluded.
     * Because its ID is not known before the response, enabled user-cache conflict handling is collection-wide
     */
    fetchSelf(
        options?: DefaultUserOperationOptions,
    ): ResultAsync<User, UserOperationFailure | CancelledError | ConfigurationError>
}

/**
 * Open and manage private one-to-one or group conversations with the bot's credentials.
 * Use directMessages.send for open-and-send, or messages with a known private channel ID.
 * No gateway connection is required.
 * HTTP calls start immediately with shared 30,000 ms default deadlines and eligible read retries.
 * Writes retry only confirmed rate-limit rejection, never an uncertain outcome.
 * Abort waits for cleanup and returns CancelledError.
 * Unexpected failures reject with SdkDefect
 */
export interface DirectMessages<M extends MessageCore = Message> {
    /**
     * Open or reopen a one-to-one conversation with a user, then send a message.
     * The whole operation uses one deadline.
     * Mentions are disabled by default.
     * Attachment metadata and data bytes are prepared before opening the conversation.
     * Sized file and finite stream bytes are read later, using messages.send's source limits and cleanup rules.
     * MessageError with delivery notSent does not mean opening the conversation was undone.
     * An uncertain send is never replayed automatically.
     * Opening by user ID uses collection-wide direct-message cache conflict handling because the channel ID is not known yet.
     * Reply references are not accepted here.
     * Use messages.reply with an existing channel and message reference
     *
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
    ): ResultAsync<M, SendError | CancelledError | ConfigurationError>
    /**
     * Look up a private channel synchronously in the optional cache using its decimal ID.
     * A hit may be stale and becomes more recently used without extending its age.
     * A miss returns Ok(undefined), without a request.
     * A closed client returns an error
     */
    get(id: string): Result<DirectMessageChannel | undefined, UserOperationFailure>
    /**
     * Open or reopen a one-to-one conversation with the selected user.
     * The result is a private channel, not proof a message can be delivered.
     * Privacy checks can still prevent sending after opening succeeds.
     * Because the channel ID is not known before the response, enabled direct-message cache conflict handling is collection-wide
     */
    open(
        userId: string,
        options?: DefaultUserOperationOptions,
    ): ResultAsync<DirectMessageChannel, UserOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch a private channel by decimal ID.
     * A guild-channel response is rejected as invalid.
     * An enabled cache admits this ID independently of unrelated targeted private-channel reads
     */
    fetch(
        id: string,
        options?: DefaultUserOperationOptions,
    ): ResultAsync<DirectMessageChannel, UserOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch this bot's currently open one-to-one and group conversations.
     * Personal notes are excluded.
     * The list is neither an atomic snapshot nor complete message history.
     * Enabled cache replacement is skipped when a later targeted request or channel observation conflicts
     */
    fetchAll(
        options?: DefaultUserOperationOptions,
    ): ResultAsync<readonly DirectMessageChannel[], UserOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch the latest messages for 1–100 selected, distinct private channel IDs.
     * IDs are copied by index when called.
     * This does not enumerate conversations or fill a cache.
     * A null message is ambiguous.
     * The omittedChannelIds field separately lists IDs not returned by Fluxer.
     * Do not treat omission as null, an empty channel or denied access.
     * The batch uses POST and is not retried after a dispatched uncertain failure, even though it reads data
     */
    fetchLatestMessages(
        channelIds: readonly string[],
        options?: DefaultUserOperationOptions,
    ): ResultAsync<DirectMessageLatestMessages<M>, UserOperationFailure | CancelledError | ConfigurationError>
    /**
     * Change supplied settings of an existing group conversation.
     * A null name clears it.
     * Omitted fields remain unchanged.
     * Fluxer enforces member and owner permissions.
     * A failed response does not guarantee rollback.
     * Enabled cache invalidation remains scoped to this conversation unless a collection-wide fence occurs
     */
    editGroup(
        id: string,
        input: DirectMessageGroupEdit,
        options?: DefaultUserOperationOptions,
    ): ResultAsync<DirectMessageChannel, UserOperationFailure | CancelledError | ConfigurationError>
    /**
     * Close a one-to-one conversation for this bot, or leave a group conversation.
     * Another recipient's conversation is not erased.
     * If the group owner leaves, ownership may transfer.
     * Enabled cache invalidation remains scoped to this conversation unless a collection-wide fence occurs
     */
    close(
        id: string,
        options?: DefaultUserOperationOptions,
    ): ResultAsync<void, UserOperationFailure | CancelledError | ConfigurationError>
    /**
     * Remove a group recipient as owner, or remove the bot itself.
     * This does not request deletion of that user's messages.
     * If the last recipient leaves, Fluxer deletes the group.
     * Enabled cache invalidation remains scoped to this conversation unless a collection-wide fence occurs
     */
    removeRecipient(
        id: string,
        userId: string,
        options?: DefaultUserOperationOptions,
    ): ResultAsync<void, UserOperationFailure | CancelledError | ConfigurationError>
}

/**
 * Create a bot client from a token, initially Disconnected
 *
 * Use `run` or `connect` to receive gateway events. HTTP requests work without connecting.
 * Always finish with `shutdown` unless an accepted `run` already manages the client's full lifetime
 *
 * @remarks
 * **Creation and configuration**
 *
 * Creation validates configuration synchronously without authenticating the token or opening sockets.
 * No timers or process signal handlers are started.
 * Invalid options return `ConfigurationError` without the rejected value. Unexpected creation failures throw `SdkDefect`
 *
 * **Instance and caching**
 *
 * Hosted Fluxer is selected by default.
 * For a self-hosted instance, pass its root and let the SDK discover API, gateway and URL endpoints when first needed.
 * HTTPS and WSS are required unless that explicit instance enables allowInsecure for HTTP and WS
 *
 * Caching is disabled by default.
 * Cache settings are copied and validated without calling retention policies or reporters.
 * Unknown cache or message-cache keys fail validation.
 * The messageFields option selects received message fields once for this client's lifetime
 *
 * **Connection and sharding**
 *
 * Gateway startup defaults to a 30,000 ms overall budget and three total attempts per assigned shard.
 * A sharding plan fixes this client's assigned IDs for its lifetime.
 * Shard zero receives direct-message gateway traffic.
 * Request and cache limits still apply across the whole client, not separately to each shard
 *
 * @example
 * ```ts
 * import { createClient } from "@neontechspace/fluxerly"
 *
 * export function shardingExample(token: string) {
 *     return createClient({ token, sharding: { totalShards: 4, shardIds: [0, 2] } })
 * }
 * ```
 */
export function createClient<const F extends MessageFields | undefined = undefined>(
    options: ClientOptions<F>,
): Result<Client<SelectedMessage<F>>, ConfigurationError> {
    type M = SelectedMessage<F>
    const scope = Scope.makeUnsafe()
    const exit = Effect.runSyncExit(makeClient<F>(options, scope))
    if (Exit.isFailure(exit)) {
        if (Cause.hasDies(exit.cause)) throw new SdkDefect()
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
        if (failure?._tag === "Fail") return err(failure.error)
        throw new SdkDefect()
    }
    const owner = exit.value
    const execute = <A, E extends OperationFailure>(
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
                let removeSignal: (() => void) | undefined
                let source: AttachmentDownloadSource | undefined
                let opening:
                    | Promise<Exit.Exit<AttachmentDownloadSource, AttachmentDownloadFailure | ConfigurationError>>
                    | undefined
                let cleanup: Promise<Exit.Exit<void>> | undefined
                let closed = false
                let bound = false
                let pulling = false
                const releaseSignal = () => {
                    const remove = removeSignal
                    removeSignal = undefined
                    remove?.()
                }
                const open = () =>
                    (opening ??= Effect.runPromiseExit(
                        owner.logging.provide(
                            Effect.suspend<
                                AttachmentDownloadSource,
                                AttachmentDownloadFailure | ConfigurationError,
                                never
                            >(() => {
                                const signal = options?.signal
                                const invalidSignal = operationSignalError(signal)
                                if (invalidSignal) return Effect.fail(invalidSignal)
                                if (signal) {
                                    const abort = () => controller.abort()
                                    // Record ownership before invoking a caller-controlled registration method
                                    removeSignal = () => signal.removeEventListener("abort", abort)
                                    signal.addEventListener("abort", abort, { once: true })
                                    if (signal.aborted) {
                                        abort()
                                        return Effect.interrupt
                                    }
                                }
                                return owner.streamAttachment(attachment, options)
                            }),
                        ),
                        { signal: controller.signal },
                    ))
                const detach = () =>
                    (cleanup ??= (async () => {
                        // Listener failure must not prevent cancellation, body closure or reservation release
                        const removed = await Effect.runPromiseExit(Effect.sync(releaseSignal))
                        const aborted = await Effect.runPromiseExit(Effect.sync(() => controller.abort()))
                        const opened = opening && (await opening)
                        const cleaned =
                            opened && Exit.isSuccess(opened)
                                ? await Effect.runPromiseExit((source ?? opened.value).closeEffect)
                                : Exit.void
                        const cause = [removed, aborted, cleaned].reduce(
                            (cause, exit) => (Exit.isFailure(exit) ? Cause.combine(cause, exit.cause) : cause),
                            Cause.empty as Cause.Cause<never>,
                        )
                        return cause.reasons.length ? Exit.failCause(cause) : Exit.void
                    })())
                const bind = () => {
                    if (bound) return
                    bound = true
                    source!.bindSignal(controller.signal, releaseSignal)
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
                            let chunk: Exit.Exit<Uint8Array | undefined, AttachmentDownloadFailure | ConfigurationError>
                            if (Exit.isFailure(opened)) chunk = Exit.failCause(opened.cause)
                            else {
                                source = opened.value
                                chunk = await Effect.runPromiseExit(
                                    owner.logging.provide(
                                        Effect.suspend(() => {
                                            bind()
                                            return closed ? Effect.succeed(undefined) : source!.next
                                        }),
                                    ),
                                )
                            }
                            if (Exit.isFailure(chunk) || chunk.value === undefined || closed) {
                                closed = true
                                const cleaned = await detach()
                                if (Exit.isFailure(cleaned))
                                    chunk = Exit.failCause(
                                        Cause.combine(Exit.isFailure(chunk) ? chunk.cause : Cause.empty, cleaned.cause),
                                    )
                            }
                            const result = fromExit(chunk, "attachments.stream")
                            if (result.isErr()) return { done: false, value: err(result.error) }
                            return result.value === undefined || closed
                                ? { done: true, value: undefined }
                                : { done: false, value: ok(result.value) }
                        } finally {
                            pulling = false
                        }
                    },
                    async return(): Promise<
                        IteratorResult<
                            Result<Uint8Array, AttachmentDownloadFailure | CancelledError | ConfigurationError>
                        >
                    > {
                        closed = true
                        fromExit(await detach(), "attachments.stream")
                        return { done: true, value: undefined }
                    },
                    async throw(
                        error?: unknown,
                    ): Promise<
                        IteratorResult<
                            Result<Uint8Array, AttachmentDownloadFailure | CancelledError | ConfigurationError>
                        >
                    > {
                        closed = true
                        const cleaned = await detach()
                        if (Exit.isFailure(cleaned))
                            fromExit(
                                Exit.failCause(Cause.combine(Cause.die(error), cleaned.cause)),
                                "attachments.stream",
                            )
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
    ): Result<readonly CachedResources<M>[K][], ConfigurationError> => {
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
                            () => directMessageLatestMessages(ids, owner.decodeMessage),
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
                create: (id: string, input: ChannelCreate, options?: DefaultChannelAuditOperationOptions) =>
                    execute(
                        owner.channel("channels.create", () => channelCreate(id, input), options),
                        "channels.create",
                        options,
                    ),
                edit: (id: string, input: ChannelEdit, options?: DefaultChannelAuditOperationOptions) =>
                    execute(
                        owner.channel("channels.edit", () => channelEdit(id, input), options),
                        "channels.edit",
                        options,
                    ),
                delete: (id: string, options?: DefaultChannelAuditOperationOptions) =>
                    execute(
                        owner.channel("channels.delete", () => channelDelete(id), options),
                        "channels.delete",
                        options,
                    ),
                reorder: (
                    id: string,
                    positions: readonly ChannelPosition[],
                    options?: DefaultChannelAuditOperationOptions,
                ) =>
                    execute(
                        owner.channel("channels.reorder", () => channelReorder(id, positions), options),
                        "channels.reorder",
                        options,
                    ),
                setPermissionOverwrite: (
                    id: string,
                    input: PermissionOverwrite,
                    options?: DefaultChannelAuditOperationOptions,
                ) =>
                    execute(
                        owner.channel("channels.setPermissionOverwrite", () => permissionSet(id, input), options),
                        "channels.setPermissionOverwrite",
                        options,
                    ),
                removePermissionOverwrite: (
                    id: string,
                    targetId: string,
                    options?: DefaultChannelAuditOperationOptions,
                ) =>
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
                    options?: DefaultGuildAuditOperationOptions,
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
                editSelf: (guildId: string, input: MemberProfileEdit, options?: DefaultGuildAuditOperationOptions) =>
                    execute(
                        owner.guild("members.editSelf", () => memberEditSelf(guildId, input), options),
                        "members.editSelf",
                        options,
                    ),
                setNickname: (
                    target: MemberReference,
                    nickname: string | null,
                    options?: DefaultGuildAuditOperationOptions,
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
                timeout: (target: MemberReference, durationMs: number, options?: DefaultTimeoutOptions) =>
                    execute(
                        owner.guild("members.timeout", () => memberTimeout(target, durationMs, options), options),
                        "members.timeout",
                        options,
                    ),
                clearTimeout: (target: MemberReference, options?: DefaultTimeoutOptions) =>
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
                addRole: (target: MemberReference, id: string, options?: DefaultGuildAuditOperationOptions) =>
                    execute(
                        owner.guild("members.addRole", () => memberRole(target, id, true), options),
                        "members.addRole",
                        options,
                    ),
                removeRole: (target: MemberReference, id: string, options?: DefaultGuildAuditOperationOptions) =>
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
                    options?: DefaultGuildAuditOperationOptions,
                ) =>
                    execute(
                        owner.guild("roles.setHoistPositions", () => roleSetHoistPositions(id, positions), options),
                        "roles.setHoistPositions",
                        options,
                    ),
                resetHoistPositions: (id: string, options?: DefaultGuildAuditOperationOptions) =>
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
                create: (id: string, input: RoleCreate, options?: DefaultGuildAuditOperationOptions) =>
                    execute(
                        owner.guild("roles.create", () => roleCreate(id, input), options),
                        "roles.create",
                        options,
                    ),
                edit: (target: RoleReference, input: RoleEdit, options?: DefaultGuildAuditOperationOptions) =>
                    execute(
                        owner.guild("roles.edit", () => roleEdit(target, input), options),
                        "roles.edit",
                        options,
                    ),
                delete: (target: RoleReference, options?: DefaultGuildAuditOperationOptions) =>
                    execute(
                        owner.guild("roles.delete", () => roleDelete(target), options),
                        "roles.delete",
                        options,
                    ),
                reorder: (
                    id: string,
                    positions: readonly RolePosition[],
                    options?: DefaultGuildAuditOperationOptions,
                ) =>
                    execute(
                        owner.guild("roles.reorder", () => roleReorder(id, positions), options),
                        "roles.reorder",
                        options,
                    ),
            }),
            attachments: Object.freeze({
                refreshUrls: (urls: readonly string[], options?: DefaultAttachmentRefreshOptions) =>
                    execute(owner.refreshAttachmentUrls(urls, options), "attachments.refreshUrls", options),
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
                    filters: Omit<MessageSearchQuery, "limit" | "page">,
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
                    options?: DefaultCollectorOptions<M>,
                ): Result<Collector<M>, CollectorRegistrationError | CancelledError | ConfigurationError> => {
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
                get: (target: MessageReference): Result<M | undefined, MessageOperationFailure> => {
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
                    execute(owner.reply(target, input, options), "reply", options),
                fetch: (target: MessageReference, options?: DefaultMessageOperationOptions) =>
                    execute(owner.fetch(target, options), "fetch", options),
                fetchHistory: (
                    channelId: string,
                    query?: MessageHistoryQuery,
                    options?: DefaultMessageOperationOptions,
                ) => execute(owner.fetchHistory(channelId, query, options), "fetchHistory", options),
                previewCleanup: (
                    channelId: string,
                    selection: MessageCleanupSelection<M>,
                    options?: DefaultMessageOperationOptions,
                ) => execute(previewCleanup(owner, channelId, selection, options), "previewCleanup", options),
                cleanup: (plan: MessageCleanupPlan<M>, options?: DefaultMessageCleanupOptions) =>
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
                    message: EventMap<M>[K],
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
                        const reportFailure = (kind: string, reporterFailed = false) => {
                            Effect.runSyncExit(
                                owner.logging.provide(
                                    Effect.logError(
                                        `Fluxerly event subscription ${event} ${kind} failure${reporterFailed ? " (error reporter also failed)" : ""}`,
                                    ),
                                ),
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
                                                  .catch(() => reportFailure(report.kind, true))
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
                        Effect.map((source): EventSubscription<K, M> =>
                            Object.freeze({
                                ...subscription(source),
                                next: (options?: OperationOptions) => execute(source.next(), "next", options),
                            }),
                        ),
                    ),
                    "events",
                ),
            waitFor: <K extends EventName>(event: K, options?: DefaultEventWaitOptions<K, M>) =>
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
 * Use a standalone OAuth client to exchange authorization codes, refresh or revoke tokens, and read delegated user data.
 * This confidential client requires a server-held client secret, not a bot token.
 * It does not open a browser, handle callbacks, compare state, store tokens or run a gateway.
 * The application owns those steps and coordinates refreshes
 *
 * @remarks
 * The secret is copied until shutdown.
 * Calls start immediately and return ResultAsync.
 * At most eight operations run concurrently, without a queue.
 * The timeoutMs option defaults to 30,000 for discovery and the operation, with request cleanup awaited afterward.
 * Responses are capped at 1 MiB and requests are never retried automatically.
 * Discovery throttling returns OAuthOperationError with rateLimit, notDispatched, status 429 and available retryAfterMs
 *
 * Expected failures return Err.
 * Unexpected failures when reading input properties or cleaning up reject with SdkDefect without response text
 */
export interface OAuthClient {
    /**
     * Build an authorization URL for the selected instance using its discovered web application URL, including its path.
     * Supply the redirect URI, scopes, state and S256 PKCE challenge.
     * The application must retain state correlation and the PKCE verifier.
     * Bot guild and permission parameters are consent hints, not proof of installation or authorization.
     * This returns the URL without opening it
     */
    authorizationUrl(
        input: OAuthAuthorizationInput,
        options?: DefaultOAuthOperationOptions,
    ): ResultAsync<string, OAuthOperationFailure | CancelledError | ConfigurationError>
    /**
     * Exchange the code from an authorization callback for tokens.
     * Supply the matching redirect URI and PKCE verifier.
     * After dispatch, cancellation or a lost response cannot tell whether Fluxer consumed the one-use code.
     * Do not retry that uncertain exchange
     */
    exchangeCode(
        input: OAuthCodeExchangeInput,
        options?: DefaultOAuthOperationOptions,
    ): ResultAsync<OAuthTokens, OAuthOperationFailure | CancelledError | ConfigurationError>
    /**
     * Exchange a refresh token for a new token pair.
     * Form tokens must contain 1–256 well-formed UTF-16 units without surrounding whitespace, U+000C or U+202E.
     * Invalid values fail locally rather than being normalized. This also applies to revoke and introspect tokens.
     * Fluxer rotates refresh tokens. The application must coordinate refreshes and atomically replace both stored tokens after success, so it never stores a mixed pair.
     * An uncertain result must not be retried
     */
    refresh(
        refreshToken: string,
        options?: DefaultOAuthOperationOptions,
    ): ResultAsync<OAuthTokens, OAuthOperationFailure | CancelledError | ConfigurationError>
    /**
     * Revoke an access or refresh token, with an optional token-type hint.
     * The token and hint are captured once, then validated and transmitted from that snapshot.
     * A lost response can still mean the token was revoked
     */
    revoke(
        input: {
            /** Access or refresh token to invalidate. Keep this secret out of logs */
            readonly token: string
            /** Identify the token as an access token or a refresh token. Omit when the kind is unknown */
            readonly tokenTypeHint?: "access_token" | "refresh_token"
        },
        options?: DefaultOAuthOperationOptions,
    ): ResultAsync<void, OAuthOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch the delegated user's identity with an access token granted the identify scope.
     * The access token is not retained by this client
     */
    fetchIdentity(
        accessToken: string,
        options?: DefaultOAuthOperationOptions,
    ): ResultAsync<OAuthIdentity, OAuthOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch one bounded page of the delegated user's guild memberships.
     * Use an access token with Fluxer's guilds scope.
     * Optionally supply pagination settings in GuildListQuery.
     * This uses bearer authentication, never the bot token
     */
    fetchGuilds(
        accessToken: string,
        query?: GuildListQuery,
        options?: DefaultOAuthOperationOptions,
    ): ResultAsync<readonly GuildListSummary[], OAuthOperationFailure | CancelledError | ConfigurationError>
    /**
     * Fetch the delegated user's full connections list with a connections-scoped access token.
     * The client neither creates, verifies, reorders nor retains those connections
     */
    fetchConnections(
        accessToken: string,
        options?: DefaultOAuthOperationOptions,
    ): ResultAsync<readonly OAuthConnection[], OAuthOperationFailure | CancelledError | ConfigurationError>
    /**
     * Inspect an access or refresh token using this client's ID and secret through HTTP Basic authentication.
     * An inactive result does not explain expiry or revocation, prove token ownership or establish whether it ever existed
     */
    introspect(
        token: string,
        options?: DefaultOAuthOperationOptions,
    ): ResultAsync<OAuthIntrospection, OAuthOperationFailure | CancelledError | ConfigurationError>
    /**
     * Permanently stop OAuth work, release the client's secret reference and abort active requests.
     * Waits for fetch and response-reader cleanup.
     * An active operation's response-cleanup failure rejects that operation with SdkDefect.
     * The shutdown method waits for it but may itself succeed.
     * A failure in shutdown's own discovery cleanup rejects shutdown with SdkDefect
     */
    shutdown(): ResultAsync<void, never>
}

/**
 * Create confidential OAuth clients and generate PKCE values for authorization-code flows.
 * Use these helpers on a trusted server where the client secret is not exposed to a browser
 *
 * @remarks
 * The application handles browser navigation, callbacks, state correlation, consent and token storage.
 * It also decides installation policy and coordinates refreshes.
 * The create method returns Result synchronously without making a request.
 * The createPkce method returns a new verifier and S256 challenge for the same authorization flow.
 * PKCE links authorization to the code exchange using a private random verifier and its public SHA-256 hash challenge.
 * Keep the verifier private and send only the challenge to authorizationUrl
 *
 * @example
 * ```ts
 * import { oauth, OAuthScopes } from "@neontechspace/fluxerly"
 *
 * export async function oauthExample(clientId: string, clientSecret: string, redirectUri: string, state: string) {
 *     const created = oauth.create({ clientId, clientSecret })
 *     if (created.isErr()) return created.error
 *     const client = created.value
 *     try {
 *         const pkce = oauth.createPkce()
 *         return await client.authorizationUrl({
 *             redirectUri,
 *             scopes: [OAuthScopes.Identify, OAuthScopes.Bot],
 *             state,
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
export const oauth: Readonly<{
    /**
     * Create a standalone OAuth client with a clientId and server-held clientSecret.
     * Creation checks configuration synchronously without requests and copies the secret until shutdown.
     * Invalid settings return ConfigurationError.
     * Unexpected creation failures throw SdkDefect with operation oauth.create and without configuration details
     */
    create(config: OAuthConfig): Result<OAuthClient, ConfigurationError>
    /**
     * Generate a private verifier and matching S256 challenge for an authorization-code flow.
     * Send challenge to authorizationUrl and keep verifier for exchangeCode.
     * This creates local random values without a request or token storage
     */
    createPkce: typeof createPkce
}> = Object.freeze({
    create(config: OAuthConfig): Result<OAuthClient, ConfigurationError> {
        const scope = Scope.makeUnsafe()
        const created = fromExit(Effect.runSyncExit(makeOAuthOwner(config, scope)), "oauth.create")
        if (created.isErr()) return err(created.error as ConfigurationError)
        const owner = created.value
        return ok(
            Object.freeze({
                authorizationUrl: (input: OAuthAuthorizationInput, options?: DefaultOAuthOperationOptions) =>
                    executeOperation(
                        Effect.suspend(() => owner.authorizationUrl(input, oauthOwnerOptions(options))),
                        "oauth.authorizationUrl",
                        options,
                    ),
                exchangeCode: (input: OAuthCodeExchangeInput, options?: DefaultOAuthOperationOptions) =>
                    executeOperation(
                        Effect.suspend(() => owner.exchangeCode(input, oauthOwnerOptions(options))),
                        "oauth.exchangeCode",
                        options,
                    ),
                refresh: (refreshToken: string, options?: DefaultOAuthOperationOptions) =>
                    executeOperation(
                        Effect.suspend(() => owner.refresh(refreshToken, oauthOwnerOptions(options))),
                        "oauth.refresh",
                        options,
                    ),
                revoke: (
                    input: { readonly token: string; readonly tokenTypeHint?: "access_token" | "refresh_token" },
                    options?: DefaultOAuthOperationOptions,
                ) =>
                    executeOperation(
                        Effect.suspend(() => owner.revoke(input, oauthOwnerOptions(options))),
                        "oauth.revoke",
                        options,
                    ),
                fetchIdentity: (accessToken: string, options?: DefaultOAuthOperationOptions) =>
                    executeOperation(
                        Effect.suspend(() => owner.fetchIdentity(accessToken, oauthOwnerOptions(options))),
                        "oauth.fetchIdentity",
                        options,
                    ),
                fetchGuilds: (accessToken: string, query?: GuildListQuery, options?: DefaultOAuthOperationOptions) =>
                    executeOperation(
                        Effect.suspend(() => owner.fetchGuilds(accessToken, query, oauthOwnerOptions(options))),
                        "oauth.fetchGuilds",
                        options,
                    ),
                fetchConnections: (accessToken: string, options?: DefaultOAuthOperationOptions) =>
                    executeOperation(
                        Effect.suspend(() => owner.fetchConnections(accessToken, oauthOwnerOptions(options))),
                        "oauth.fetchConnections",
                        options,
                    ),
                introspect: (token: string, options?: DefaultOAuthOperationOptions) =>
                    executeOperation(
                        Effect.suspend(() => owner.introspect(token, oauthOwnerOptions(options))),
                        "oauth.introspect",
                        options,
                    ),
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

type BotFailure = ConfigurationError | ConnectError | CancelledError | EventOverflowError | CriticalWorkerStoppedError

function restoreTrustedSdkDefect<A, E extends OperationFailure>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return effect.pipe(
        Effect.catchCause((cause) => {
            const reason = cause.reasons.length === 1 ? cause.reasons[0] : undefined
            if (reason?._tag !== "Die" || !(reason.defect instanceof SdkDefect)) return Effect.failCause(cause)
            if (reason.defect.reasons.length === 0) return Effect.failCause(Cause.die(undefined))
            const restored = reason.defect.reasons.reduce<Cause.Cause<E>>(
                (combined, detail) =>
                    Cause.combine(
                        combined,
                        detail.kind === "Failure"
                            ? Cause.fail(detail.failure as E)
                            : detail.kind === "Interruption"
                              ? Cause.interrupt()
                              : Cause.die(undefined),
                    ),
                Cause.empty,
            )
            return Effect.failCause(restored)
        }),
    )
}

function botOperation<A, E extends BotFailure>(
    start: (signal: AbortSignal) => ResultAsync<A, E>,
    trustedSdkDefects = false,
): Effect.Effect<A, E> {
    const controller = new AbortController()
    const operation = Promise.resolve(start(controller.signal))
    const awaited = Effect.promise(() => operation)
    const observed = trustedSdkDefects ? restoreTrustedSdkDefect(awaited) : awaited
    return observed.pipe(
        Effect.flatMap((result) => (result.isErr() ? Effect.fail(result.error) : Effect.succeed(result.value))),
        Effect.onInterrupt(() =>
            Effect.sync(() => controller.abort()).pipe(
                Effect.andThen(observed),
                Effect.flatMap((result) =>
                    result.isErr() &&
                    result.error._tag !== "CancelledError" &&
                    result.error._tag !== "ClientClosedError"
                        ? Effect.fail(result.error)
                        : Effect.void,
                ),
            ),
        ),
    )
}

/**
 * Start a bot and watch its connection and required subscriptions. The returned ResultAsync starts immediately.
 * The install callback runs before the gateway starts. Its returned subscriptions must stay open.
 * If one closes normally while the bot is still running, the result fails with CriticalWorkerStoppedError.
 * The runner does not restart handlers or wait for unrelated Promises started by application callbacks
 *
 * Aborting the optional signal requests a normal stop, not a cancellation Err. Success means the client has
 * stopped and cleanup has finished. The runner always shuts down its client, including after a failure.
 * Expected creation, connection and subscription failures return Err. Unexpected SDK failures or exceptions
 * thrown by install reject with SdkDefect after cleanup. Its reasons include combined operation and
 * cleanup failures without exposing raw exception values. Process signals are handled only when enabled, and
 * their listeners are removed when the run finishes. The runner never exits the process
 *
 * @example
 * ```ts
 * import { runBot } from "@neontechspace/fluxerly"
 *
 * const result = await runBot({ token: "YOUR_BOT_TOKEN" }, (client) => {
 *     const subscribed = client.on("messageCreate", () => undefined)
 *     if (subscribed.isErr()) throw subscribed.error
 *     return [subscribed.value]
 * }, { processSignals: true })
 * if (result.isErr()) console.error(result.error.message)
 * ```
 */
export function runBot<const F extends MessageFields | undefined = undefined>(
    options: ClientOptions<F>,
    install: (client: Client<SelectedMessage<F>>) => readonly Subscription[],
    runOptions: RunBotOptions = {},
): ResultAsync<
    void,
    ConfigurationError | ConnectError | CancelledError | EventOverflowError | CriticalWorkerStoppedError
> {
    const program = runBotCore(
        Effect.sync(() => createClient(options)).pipe(
            Effect.flatMap((created) =>
                created.isErr()
                    ? Effect.fail(created.error)
                    : Effect.succeed({
                          source: created.value,
                          get state() {
                              return created.value.state
                          },
                          run: () => botOperation((signal) => created.value.run({ signal }), true),
                          shutdown: () =>
                              restoreTrustedSdkDefect(Effect.promise(() => created.value.shutdown())).pipe(
                                  Effect.asVoid,
                              ),
                      }),
            ),
        ),
        (client) =>
            Effect.sync(() => {
                const workers = install(client.source)
                if (!Array.isArray(workers))
                    throw new TypeError("Bot installation must return an array of subscriptions")
                return workers.map((worker) => ({
                    waitForClose: () => botOperation((signal) => worker.waitForClose({ signal })),
                }))
            }),
        runOptions,
    )
    return new ResultAsync(
        Effect.runPromiseExit(program as Effect.Effect<void, BotFailure>).then((exit) =>
            fromExit<void, BotFailure>(exit, "runBot"),
        ),
    )
}
