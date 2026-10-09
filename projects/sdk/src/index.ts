/**
 * Build a Fluxer bot with JavaScript or TypeScript.
 * Import from @neontechspace/fluxerly and call its methods directly
 *
 * @example
 * ```ts
 * import { runBot } from "@neontechspace/fluxerly"
 *
 * // A failed run is logged and sets process.exitCode, and Ctrl+C stops the bot cleanly, so the returned Result needs
 * // no further handling here
 * await runBot({
 *     token: process.env.FLUXER_BOT_TOKEN,
 *     commands: { prefix: "!", commands: { ping: { execute: ({ reply }) => reply("Pong!") } } },
 * })
 * ```
 *
 * @example
 * ```ts
 * import { createClient, orThrow } from "@neontechspace/fluxerly"
 *
 * await using client = createClient({ token: process.env.FLUXER_BOT_TOKEN })
 *
 * client.on("messageCreate", (message) =>
 *     message.content === "!ping" ? client.messages.reply(message, "Pong!") : undefined,
 * )
 *
 * // Run connects, recovers and stays pending until the client ends, and await using shuts it down afterwards
 * orThrow(await client.run())
 * ```
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
 *
 * @remarks
 * This default API also includes webhooks, OAuth and local helpers, without requiring an Effect runtime.
 * Network and other I/O operations return ResultAsync, which starts when called, not when awaited.
 * Await it to get a Result: If isErr() is true, read error for the expected failure, otherwise read value.
 * Call orThrow to get the value and throw the error instead, and return a Result from a handler to report its failure.
 * Methods returning AsyncIterable start work when a for await loop pulls its first item.
 * Local work returns plain values: Creating clients and routers, registering handlers, cache lookups and pure helpers.
 * Misuse of those, such as invalid options or a missing token, throws ConfigurationError or the helper's own error at once.
 * Unexpected SDK or cleanup failures throw or reject with SdkDefect.
 * Use `await using` or try/finally to release client resources even when work fails
 *
 * The [glossary](https://preview.fluxerly.neontechspace.com/docs/latest/glossary/) defines terms such as guild, gateway,
 * shard, frozen snapshot and uncertain write
 *
 * Coding agents: read node_modules/@neontechspace/fluxerly/agents/AGENTS.md before writing code with this package
 *
 * @packageDocumentation
 */
// Checked first, so an unsupported Node.js version fails with a clear message before any other SDK code runs
import "./internal/node-version.js"
export { MemberChunkError } from "./member-chunks.js"
export type {
    MemberChunk,
    MemberChunkQuery,
    MemberChunkFailure,
    MemberChunkOptions,
    DefaultMemberChunkOptions,
} from "./member-chunks.js"
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
export type { ColorInput, RgbColor } from "./colors.js"
export type { TextSplitOptions } from "./text.js"
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
export type { GuildListQuery, GuildListSummary } from "./guilds.js"
export type { GuildIterationQuery } from "./pagination.js"
export { GuildMemberJoinSourceTypes } from "./member-search.js"
export type { GuildMemberJoinSourceType } from "./member-search.js"
export type { PermissionInput, PermissionTarget } from "./permissions.js"
export { hierarchy } from "./role-hierarchy.js"
export type { HierarchyHelpers, RoleHierarchyInput } from "./role-hierarchy.js"
export { BotApplicationOperationError } from "./application.js"
export type {
    BotApplication,
    BotApplicationOperation,
    BotApplicationOperationFailure,
    BotApplicationOperationOptions,
    DefaultBotApplicationOperationOptions,
} from "./application.js"
export type {
    MemberSearchQuery,
    MemberSearchPage,
    MemberSearchHit,
    MemberSearchIterationLimits,
} from "./member-search.js"
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
export type { AuditLogEntry, AuditLogPage, AuditLogQuery, AuditLogIterationQuery } from "./audit-logs.js"
export type {
    GuildCreate,
    GuildHealthUpdate,
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
export type { GuildEdit, GuildVanityUrl, GuildVanityUrlUsage } from "./guilds.js"
export {
    GuildSystemChannelFlags,
    GuildDefaultMessageNotifications,
    GuildVerificationLevels,
    GuildMfaLevels,
    GuildExplicitContentFilters,
    GuildContentWarningLevels,
    GuildSplashCardAlignments,
    GuildFeatureToggles,
} from "./guilds.js"
export type {
    GuildSystemChannelFlag,
    GuildDefaultMessageNotification,
    GuildVerificationLevel,
    GuildMfaLevel,
    GuildExplicitContentFilter,
    GuildContentWarningLevel,
    GuildSplashCardAlignment,
    GuildFeatureToggle,
} from "./guilds.js"
export type { Invite, InviteCreate, InviteMetadata } from "./invites.js"
export type {
    GuildEmoji,
    GuildSticker,
    ExpressionReference,
    ExpressionMetadata,
    ExpressionSourceGuild,
    EmojiCreate,
    EmojiEdit,
    StickerCreate,
    StickerEdit,
    ExpressionBatch,
    ExpressionDeleteOptions,
    DefaultExpressionDeleteOptions,
} from "./expressions.js"
export { PresenceError } from "./presence.js"
export type {
    PresenceInput,
    PresenceStatus,
    CustomStatusInput,
    CustomStatusEmoji,
    PresenceFailure,
} from "./presence.js"
export type { MemberProfileEdit, MemberMentionPreference } from "./guilds.js"
export { GuildMemberProfileFlags, MemberMentionPreferences } from "./guilds.js"
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
export { WebhookOperationError, WebhookType } from "./webhooks.js"
export type {
    Webhook,
    WebhookBase,
    IncomingWebhook,
    ChannelFollowerWebhook,
    UnknownWebhook,
    WebhookSourceGuild,
    WebhookSourceChannel,
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
export { PaginationError } from "./pagination.js"
export type {
    PaginationQuery,
    HistoryIterationQuery,
    UserIterationQuery,
    PinIterationQuery,
    PaginationOperation,
} from "./pagination.js"
export type {
    EmbedInput,
    EmbedAuthorInput,
    EmbedFooterInput,
    EmbedMediaInput,
    EmbedFieldInput,
    Embed,
    EmbedChild,
    EmbedAuthor,
    EmbedProvider,
    EmbedFooter,
    EmbedMedia,
    EmbedField,
} from "./embeds.js"
export type { MessageBody } from "./messages.js"
export { AttachmentDownloadError, AttachmentRefreshError } from "./attachments.js"
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
export { CriticalWorkerStoppedError } from "./bot-runner.js"
export type { RunBotOptions } from "./bot-runner.js"
export { OAuthOperationError, OAuthScopes } from "./oauth.js"
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
export type { EmbedFieldOptions, MissingMessageBody } from "./builders.js"
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
    CommandArgumentMember,
    CommandArgumentDuration,
    CommandArgumentCustom,
    CommandArgumentValues,
    CommandArgumentValue,
    CommandArgumentRejectionReason,
} from "./command-arguments.js"
export type { CommandContextHelpOptions, CommandHelpOptions } from "./command-help.js"
export type {
    CommandCooldownClaim,
    CommandCooldownRequest,
    CommandCooldownPer,
    PrefixCommandGuardResult,
    PrefixCommandPrefixValue,
    PrefixCommandParsing,
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
    DefaultPrefixCommandGuard,
    DefaultPrefixCommandMiddleware,
    DefaultPrefixCommandRejectionFeedback,
    DefaultPrefixCommandRouter,
} from "./default-commands.js"
export { SupervisorChildError, SupervisorError } from "./supervisor.js"
export type {
    SupervisorAssignment,
    SupervisorAssignmentOptions,
    SupervisorChildDiagnostics,
    SupervisorChildOptions,
    SupervisorChildSharding,
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
export type {
    ClientCounters,
    ErrorInfo,
    LogCategory,
    LogLevel,
    LoggingOptions,
    LogLevelSettings,
    LogRecord,
    LogSink,
    LogThreshold,
} from "./logging.js"
export type {
    HandlerObservation,
    Observation,
    Observer,
    RateLimitObservation,
    ReconnectObservation,
    RestObservation,
    ResumeObservation,
} from "./observer.js"
export type { FailureKind, FailureMessageReference, FailureReport } from "./failures.js"
export { describeError, errors } from "./error-tools.js"
export type { DescribeErrorOptions, ErrorTools } from "./error-tools.js"
export type { MessageCacheSettings, MessageCacheOptions } from "./cache.js"
export type { ResourceCacheSettings } from "./cache.js"
export { ChannelOperationError, ChannelType } from "./channels.js"
export type {
    PermissionOverwrite,
    GuildChannel,
    GuildChannelBase,
    GuildTextChannelBase,
    GuildTextChannel,
    GuildAnnouncementChannel,
    GuildVoiceChannel,
    GuildCategoryChannel,
    GuildLinkChannel,
    GuildUnknownChannel,
    ChannelCreateBase,
    TextChannelCreate,
    AnnouncementChannelCreate,
    VoiceChannelCreate,
    CategoryChannelCreate,
    LinkChannelCreate,
    ChannelCreate,
    ChannelEdit,
    ChannelPosition,
    ChannelFollowInput,
    FollowedChannel,
    ChannelFollowerStats,
    GuildChannelUpdateBulk,
    ChannelOperation,
    ChannelOperationFailure,
    ChannelOperationOptions,
    DefaultChannelOperationOptions,
    ChannelAuditOperationOptions,
    DefaultChannelAuditOperationOptions,
} from "./channels.js"
export { ChannelFlags, ForumLayout, ForumSortOrder, ThreadAutoArchiveMinutes, isThreadChannel } from "./channels.js"
export type {
    GuildThreadChannelBase,
    GuildAnnouncementThreadChannel,
    GuildPublicThreadChannel,
    GuildPrivateThreadChannel,
    GuildThreadChannel,
    ThreadMembership,
    ThreadMember,
    GuildForumChannelBase,
    GuildForumChannel,
    GuildMediaChannel,
    ForumTag,
    ForumDefaultReaction,
} from "./channels.js"
// Threads: The client.threads namespace with its inputs, results and options
export type { Threads } from "./api/default/threads.js"
export type {
    ThreadCreate,
    ThreadFromMessageCreate,
    ForumPostMessage,
    ForumPostCreate,
    ForumPost,
    ThreadEdit,
    ArchivedThreadScope,
    ArchivedThreadQuery,
    ArchivedThreadPage,
    ThreadSearchQuery,
    ThreadSearchIndexingPage,
    ThreadSearchResultsPage,
    ThreadSearchPage,
    ThreadMemberQuery,
    ThreadMemberPageQuery,
    ThreadMemberIterationQuery,
} from "./threads.js"
// Forum channels and webhook threads: Forum channel and tag inputs and webhook thread options
export type {
    ThreadParentDefaults,
    ForumTagInput,
    ForumDefaultReactionInput,
    ForumChannelCreateBase,
    ForumChannelCreate,
    MediaChannelCreate,
} from "./channels.js"
export type {
    WebhookForumPostOptions,
    WebhookMessageOperationOptions,
    DefaultWebhookMessageOperationOptions,
} from "./webhooks.js"
// Thread events: Payloads of the thread gateway events
export type { ThreadCreateEvent, ThreadDeletion, ThreadListSync, ThreadMembersUpdate } from "./events.js"
// Thread permissions: Permission inputs for threads
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
    VoiceMuteInput,
    VoiceDeafenInput,
    MemberQuery,
    GuildOperation,
    GuildOperationFailure,
    GuildOperationOptions,
    DefaultGuildOperationOptions,
    CanManageOptions,
    DefaultCanManageOptions,
    GuildAuditOperationOptions,
    DefaultGuildAuditOperationOptions,
} from "./guilds.js"
export type {
    BanInput,
    GuildBan,
    ModerationOptions,
    DefaultModerationOptions,
    TimeoutOptions,
    DefaultTimeoutOptions,
} from "./guilds.js"
export type { MessagePinsQuery, MessagePinsPage, MessagePin, ChannelPinsUpdate } from "./pins.js"
export type {
    ReactionCollectorOptions,
    DefaultReactionCollectorOptions,
    ReactionCollectorResult,
} from "./collectors.js"
export { CollectorError } from "./collectors.js"
export type { CollectorOptions, DefaultCollectorOptions, CollectorResult, CollectorFailure } from "./collectors.js"
export type {
    PageInput,
    PageTurners,
    PaginateOptions,
    DefaultPaginateOptions,
    ChannelPaginateOptions,
    DefaultChannelPaginateOptions,
    PaginateResult,
    PaginateFailure,
} from "./reaction-pages.js"
export { EventOverflowError, EventReadBusyError, MessageError, MessageOperationError } from "./message-errors.js"
export { EventWaitError } from "./message-errors.js"
export type { EventWaitFailure } from "./message-errors.js"
export type { EventWaitOptions } from "./events.js"
export type {
    ApiErrorCode,
    ApiErrorDetail,
    ApiProviderCode,
    ApiValidationCode,
    ApiValidationErrorDetail,
} from "./api-errors.js"
export type { InputValidationConstraint, InputValidationDetail } from "./input-validation.js"
export { MessageCleanupError } from "./message-cleanup.js"
export { MessageFlags, MessageType } from "./messages.js"
export type { EventReadError, SendError, MessageOperationFailure } from "./message-errors.js"
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
    MessageUser,
    ReferencedMessage,
    MessageChannelMention,
    MessageReactionEmoji,
    MessageReactionSummary,
    MessageContextReference,
    CrosspostSource,
    CrosspostSourceGuild,
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
    MessageAuditOperationOptions,
    DefaultMessageAuditOperationOptions,
    OwnMessageDeletionOptions,
    DefaultOwnMessageDeletionOptions,
} from "./messages.js"
export type {
    EventBufferOptions,
    HandlerOptions,
    EventMap,
    EventName,
    RawDispatch,
    TypingStart,
    PresenceUpdate,
    ObservedPresenceStatus,
    PresenceUpdateBulk,
    VoiceState,
    VoiceStateSnapshot,
} from "./events.js"
export type {
    CacheDiagnostic,
    CacheEntriesOptions,
    CachedResources,
    CacheKind,
    ClientDiagnostics,
    ClientOptions,
    ConnectionRecoveryOptions,
    ConnectionState,
    OperationSignal,
    OperationOptions,
    ShutdownOptions,
} from "./client.js"
export type {
    InstanceDomainMigration,
    InstanceEndpoints,
    InstanceOptions,
    InstanceResolveError,
    InstanceResolveOptions,
    ResolvedInstance,
} from "./instance.js"
export {
    ApplicationError,
    AuthenticationError,
    ShardConnectionError,
    CancelledError,
    ClientBusyError,
    ClientClosedError,
    ConfigurationError,
    ConnectionError,
    ConnectionTimeoutError,
    FluxerlyError,
    RateLimitError,
    SdkDefect,
} from "./errors.js"
export type {
    ConnectError,
    ConnectionFailure,
    DefectReason,
    FluxerlyErrorJson,
    FluxerlyErrorOptions,
    OperationErrorOptions,
    OperationOutcome,
    OperationReason,
} from "./errors.js"
export type { ShardingOptions, ShardRecoveryDiagnostic, ShardState } from "./sharding.js"
export type {
    CallCreate,
    CallDelete,
    CallUpdate,
    CallVoiceState,
    EntranceSoundPlay,
    EventContext,
    EventInvocation,
    EventInvocationOf,
} from "./events.js"
export type { CacheChange } from "./cache.js"
export type { IdentifyCoordinator, SessionSnapshot, SessionStore } from "./sharding.js"
export { fileSessionStore } from "./sharding.js"
export type { GatewayOptions } from "./client.js"
export type { EventMiddleware, MiddlewareRegistration } from "./api/default/events.js"
export type { CacheObserver } from "./api/default/cache.js"
export { oauth } from "./api/default/oauth.js"
export type { OAuthClient } from "./api/default/oauth.js"
export { format, snowflakes, display, permissionBits, colors, text, links, assets } from "./api/default/helpers.js"
export { commands } from "./api/default/commands.js"
export { supervisor } from "./api/default/supervisor.js"
export type {
    Subscription,
    EventSubscription,
    EventHandlerOptions,
    DefaultEventWaitOptions,
    StateObserver,
} from "./api/default/events.js"
export type { Attachments } from "./api/default/attachments.js"
export type { Messages } from "./api/default/messages.js"
export type { Collector, ReactionCollector } from "./api/default/collectors.js"
export type { AuditLogs } from "./api/default/audit-logs.js"
export type { Invites } from "./api/default/invites.js"
export type { Emojis } from "./api/default/emojis.js"
export type { Stickers } from "./api/default/stickers.js"
export type { Discovery } from "./api/default/discovery.js"
export type { Guilds } from "./api/default/guilds.js"
export type { Channels } from "./api/default/channels.js"
export type { Members } from "./api/default/members.js"
export type { PermissionHelpers } from "./api/default/permissions.js"
export type { Roles } from "./api/default/roles.js"
export type { Webhooks } from "./api/default/webhooks.js"
export { createWebhookClient } from "./api/default/webhook-client.js"
export type { WebhookClient } from "./api/default/webhook-client.js"
export type { ClientCache } from "./api/default/cache.js"
export type { RestRequests } from "./api/default/rest.js"
export type { GatewayCommands } from "./api/default/gateway.js"
export type { ClientLogging } from "./api/default/logging.js"
export { RestRequestError } from "./rest.js"
export type {
    DefaultRestRequest,
    RestOperation,
    RestOptions,
    RestRequest,
    RestRequestFailure,
    RestResponse,
    TransportOptions,
    WebSocketLike,
    WebSocketOptions,
} from "./rest.js"
export { GatewaySendError } from "./gateway.js"
export type { GatewaySendFailure } from "./gateway.js"
export { createClient } from "./api/default/client.js"
export type { Client } from "./api/default/client.js"
export type { Instance, DefaultInstanceResolveOptions } from "./api/default/instance.js"
export type { Presence } from "./api/default/presence.js"
export type { CurrentBotApplication } from "./api/default/application.js"
export type { Users } from "./api/default/users.js"
export type { DirectMessages } from "./api/default/direct-messages.js"
export { runBot } from "./api/default/bot.js"
export type {
    BotCommandsOptions,
    BotEventContext,
    BotEventHandler,
    BotEventOptions,
    BotEvents,
    BotOptions,
} from "./api/default/bot.js"
export { guards } from "./api/default/guards.js"
export type { DefaultGuards } from "./api/default/guards.js"
export type { DisplayHelpers, FormatHelpers, LinkHelpers, PermissionBitHelpers, SnowflakeHelpers } from "./helpers.js"
export type { AssetHelpers } from "./assets.js"
export type { ColorHelpers } from "./colors.js"
export type { TextHelpers } from "./text.js"
export type { AuditLogFilter, AuditLogIterationQueryBase, AuditLogQueryBase } from "./audit-logs.js"
export type { CommandArgumentOptionalValue } from "./command-arguments.js"
export type { EditMessageOptions, MessageContent } from "./messages.js"
export type { WebhookMessageOptions } from "./webhooks.js"
export type { ErrorMatchHandlers } from "./error-tools.js"
export type { DefaultCommands, DefaultPrefixCommandBatch } from "./default-commands.js"
export type { Operation } from "./errors.js"
export { orThrow } from "./api/default/results.js"
// The neverthrow result types every default operation returns, so applications can name them without another import
export type { Result, ResultAsync } from "neverthrow"
