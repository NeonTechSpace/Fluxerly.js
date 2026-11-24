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
 * Expected errors, such as invalid operation input or an HTTP rejection, use Effect's error channel.
 * Defects are unexpected faults, such as a throwing property getter or failed cleanup.
 * Misuse is a defect too: Invalid client, router or registration options, including a missing createClient token,
 * die with ConfigurationError, and a pure helper given invalid input throws its error, which becomes a defect inside an Effect.
 * Interruption is Effect's cancellation mechanism.
 * Cause can represent errors, defects and interruption together.
 * Cancellation waits for SDK-owned cleanup, but cannot undo a request already sent to Fluxer
 *
 * Scope is the cleanup lifetime required by client creation, subscriptions and collectors.
 * Wrap a program in Effect.scoped to provide that lifetime and close its resources when the program ends.
 * Keep a client and its listeners inside their scopes rather than returning handles after their scopes close.
 * Other required services come from the caller's Effect program, including services used by handlers
 *
 * The [glossary](https://fluxerly.neontechspace.com/docs/glossary/) defines terms such as guild, gateway,
 * shard, gateway gap and REST
 *
 * Stream values describe sequences. Requests and listeners start when the caller consumes the Stream.
 * Methods returning plain values act immediately: The diagnostics and cache.clear methods, pure helpers such as format.userMention,
 * permissions.calculate, and command router creation, registration and help
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
 *             return yield* client.messages.send(channelId, "Hello")
 *         }),
 *     )
 *     return Effect.runPromise(program)
 * }
 * ```
 *
 * This example sends through HTTP without connecting the gateway.
 * The returned Promise settles after the scoped client finishes cleanup
 *
 * Coding agents: Read node_modules/@neontechspace/fluxerly/agents/AGENTS.md before writing code with this package
 *
 * @packageDocumentation
 */
// Checked first, so an unsupported Node.js version fails with a clear message before any other SDK code runs
import "./internal/node-version.js"

// ---------------------------------------------------------------------------
// Core entry points: Bot runner, client, service layer, webhooks and OAuth
// ---------------------------------------------------------------------------
export { defineBot, runBot } from "./api/effect/bot.js"
export type {
    BotCommandCallbackServices,
    BotCommandEntries,
    BotCommandsOptions,
    BotEventContext,
    BotEventHandler,
    BotEventOptions,
    BotEventServices,
    BotEvents,
    BotOptions,
    HandlerServices,
} from "./api/effect/bot.js"
export { CriticalWorkerStoppedError } from "./bot-runner.js"
export type { RunBotOptions } from "./bot-runner.js"
export { createClient } from "./api/effect/client.js"
export type { Client, ClientOptions, ScheduledTask } from "./api/effect/client.js"
export { FluxerClient } from "./api/effect/service.js"
export type { FluxerClientConfigOptions } from "./api/effect/service.js"
export type {
    AuditedRequestOptions,
    CacheDiagnostic,
    CacheEntriesOptions,
    CachedResources,
    CacheKind,
    ClientDiagnostics,
    ConnectionRecoveryOptions,
    ConnectionState,
    GatewayOptions,
    OperationSignal,
    RequestOptions,
    RestRateLimitHold,
    ScheduleOptions,
    ShutdownOptions,
} from "./client.js"
export { createWebhookClient } from "./api/effect/webhook-client.js"
export type { WebhookClient } from "./api/effect/webhook-client.js"
export { oauth } from "./api/effect/oauth.js"
export type { OAuthClient } from "./api/effect/oauth.js"

// ---------------------------------------------------------------------------
// Commands, guards and builders
// ---------------------------------------------------------------------------
export { commands } from "./api/effect/commands.js"
export { guards } from "./api/effect/guards.js"
export type { Guards } from "./api/effect/guards.js"
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
    CommandArgumentOptionalValue,
    CommandArgumentParseOptions,
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
    PrefixCommandParseRejection,
    PrefixCommandPrefix,
    PrefixCommandRejection,
    PrefixCommandUnmatched,
} from "./commands.js"
export type {
    BatchRequirements,
    CommandRequirements,
    Commands,
    CooldownStore,
    EffectRequirements,
    MemoryCooldownStore,
    PrefixCommand,
    PrefixCommandBatch,
    PrefixCommandContext,
    PrefixCommandExecutionContext,
    PrefixCommandCooldown,
    PrefixCommandUnmatchedContext,
    PrefixCommandsOptions,
    PrefixCommandGuard,
    PrefixCommandMiddleware,
    PrefixCommandRejectionFeedback,
    PrefixCommandRouter,
} from "./native-commands.js"

// ---------------------------------------------------------------------------
// Errors, logging and observability
// ---------------------------------------------------------------------------
export { describeError, errors } from "./error-tools.js"
export type { DescribeErrorOptions, ErrorMatchHandlers, ErrorTools, NotFoundResource } from "./error-tools.js"
export {
    ApplicationError,
    AuthenticationError,
    ShardConnectionError,
    ClientBusyError,
    ClientClosedError,
    ConfigurationError,
    ConnectionError,
    ConnectionTimeoutError,
    FluxerlyError,
    RateLimitError,
} from "./errors.js"
export type {
    ConnectError,
    ConnectionFailure,
    FluxerlyErrorJson,
    FluxerlyErrorOptions,
    Operation,
    OperationErrorOptions,
    OperationOutcome,
    OperationReason,
} from "./errors.js"
export type {
    ApiErrorCode,
    ApiErrorDetail,
    ApiProviderCode,
    ApiValidationCode,
    ApiValidationErrorDetail,
} from "./api-errors.js"
export type { InputValidationConstraint, InputValidationDetail } from "./input-validation.js"
export type { FailureReport } from "./api/effect/failures.js"
export type { FailureKind, FailureMessageReference } from "./failures.js"
export type { ClientLogging } from "./api/effect/logging.js"
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

// ---------------------------------------------------------------------------
// Events, gateway and raw REST
// ---------------------------------------------------------------------------
export type { EventHandlerOptions, EventMiddleware, MiddlewareRegistration, Subscription } from "./api/effect/events.js"
export type {
    EventBufferOptions,
    HandlerOptions,
    EventMap,
    EventName,
    EventWaitOptions,
    EventContext,
    EventInvocation,
    EventInvocationOf,
    PreviousSnapshot,
    PreviousSnapshots,
    RawDispatch,
    RawDispatchEvent,
    DocumentedRawDispatch,
    UndocumentedRawDispatch,
    GatewayErrorEvent,
    TypingStart,
    PresenceUpdate,
    ObservedPresenceStatus,
    ObservedCustomStatus,
    ObservedCustomStatusEmoji,
    PresenceUpdateBulk,
    VoiceState,
    VoiceStateSnapshot,
    CallCreate,
    CallDelete,
    CallUpdate,
    CallVoiceState,
    EntranceSoundPlay,
    GuildCreate,
    GuildHealthUpdate,
    GuildEmojisUpdate,
    GuildStickersUpdate,
    GuildLifecycleEvents,
    WebhooksUpdate,
    InviteDeleteEvent,
    GuildAuditLogEntryCreate,
    ThreadCreateEvent,
    ThreadDeletion,
    ThreadListSync,
    ThreadMembersUpdate,
} from "./events.js"
export type { GatewayDispatchPayloads, GatewayErrorData, GatewayPayloadObjects } from "./gateway-payloads.js"
export type { GatewayCommands } from "./api/effect/gateway.js"
export { GatewaySendError } from "./gateway.js"
export type { GatewaySendFailure } from "./gateway.js"
export type { RestRequests } from "./api/effect/rest.js"
export { RestRequestError } from "./rest.js"
export type { RestRoutes } from "./rest-routes.js"
export type {
    RestCallArguments,
    RestCallInput,
    RestOperation,
    RestOptions,
    RestRequest,
    RestRequestFailure,
    RestResponse,
    RestRoute,
    RestRouteInput,
    RestRouteOptions,
    RestRouteResponse,
    TransportOptions,
    WebSocketLike,
    WebSocketOptions,
} from "./rest.js"

// ---------------------------------------------------------------------------
// Messages, embeds, attachments, reactions, pins and collectors
// ---------------------------------------------------------------------------
export type { Messages } from "./api/effect/messages.js"
export { MessageFlags, MessageType } from "./messages.js"
export type {
    Message,
    MessageBody,
    MessageContent,
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
    EditMessageInput,
    EditMessageOptions,
    OwnMessageDeletionOptions,
} from "./messages.js"
export {
    EventOverflowError,
    EventReadBusyError,
    EventWaitError,
    MessageError,
    MessageOperationError,
} from "./message-errors.js"
export type { EventReadError, EventWaitFailure, SendError, MessageOperationFailure } from "./message-errors.js"
export { MessageCleanupError } from "./message-cleanup.js"
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
} from "./message-cleanup.js"
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
export type { Attachments } from "./api/effect/attachments.js"
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
    AttachmentReference,
    AttachmentStreamInput,
    AttachmentStreamReadResult,
    AttachmentStreamReader,
    AttachmentStreamReaderOptions,
    AttachmentStreamSource,
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
export type { MessagePinsQuery, MessagePinsPage, MessagePin, ChannelPinsUpdate } from "./pins.js"
export type {
    Collector,
    CollectorOptions,
    ReactionCollector,
    ReactionCollectorOptions,
} from "./api/effect/collectors.js"
export { CollectorError } from "./collectors.js"
export type { CollectorResult, CollectorFailure, ReactionCollectorResult } from "./collectors.js"
export type {
    ChannelPaginateOptions,
    PageInput,
    PageTurners,
    PaginateFailure,
    PaginateOptions,
    PaginateResult,
} from "./reaction-pages.js"

// ---------------------------------------------------------------------------
// Channels, threads, forums and counts
// ---------------------------------------------------------------------------
export type { Channels } from "./api/effect/channels.js"
export {
    ChannelFlags,
    ChannelOperationError,
    ChannelType,
    ForumLayout,
    ForumSortOrder,
    ThreadAutoArchiveMinutes,
    isThreadChannel,
} from "./channels.js"
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
    ThreadParentDefaults,
    ForumTagInput,
    ForumDefaultReactionInput,
    ForumChannelCreateBase,
    ForumChannelCreate,
    MediaChannelCreate,
} from "./channels.js"
export type { Threads } from "./api/effect/threads.js"
export type {
    ThreadCreate,
    ThreadFromMessageCreate,
    ForumPostMessage,
    ForumPostCreate,
    ForumPost,
    ThreadEdit,
    ArchivedThreadScope,
    ArchivedThreadQuery,
    ArchivedThreadIterationQuery,
    ArchivedThreadPage,
    ThreadSearchQuery,
    ThreadSearchIndexingPage,
    ThreadSearchResultsPage,
    ThreadSearchPage,
    ForumPostData,
    ThreadMemberQuery,
    ThreadMemberPageQuery,
    ThreadMemberIterationQuery,
} from "./threads.js"
export { CountOperationError } from "./counts.js"
export type {
    CountOperation,
    CountOperationFailure,
    GuildCount,
    GuildCountsResult,
    ChannelMemberCount,
    ChannelMemberCountsResult,
} from "./counts.js"

// ---------------------------------------------------------------------------
// Communities (guilds), roles, members, permissions, expressions and moderation
// ---------------------------------------------------------------------------
export type { Guilds } from "./api/effect/guilds.js"
export type { Members } from "./api/effect/members.js"
export type { Roles } from "./api/effect/roles.js"
export type { PermissionHelpers } from "./api/effect/permissions.js"
export {
    GuildOperationError,
    Permissions,
    GuildSystemChannelFlags,
    GuildDefaultMessageNotifications,
    GuildVerificationLevels,
    GuildMfaLevels,
    GuildNsfwLevels,
    GuildExplicitContentFilters,
    GuildContentWarningLevels,
    GuildSplashCardAlignments,
    GuildFeatureToggles,
    GuildMemberProfileFlags,
    MemberMentionPreferences,
} from "./guilds.js"
export type {
    Guild,
    GuildDeletion,
    GuildEdit,
    GuildListQuery,
    GuildListSummary,
    GuildVanityUrl,
    GuildVanityUrlUsage,
    GuildSystemChannelFlag,
    GuildDefaultMessageNotification,
    GuildVerificationLevel,
    GuildMfaLevel,
    GuildNsfwLevel,
    GuildExplicitContentFilter,
    GuildContentWarningLevel,
    GuildSplashCardAlignment,
    GuildFeatureToggle,
    GuildRole,
    GuildRoleUpdateBulk,
    RoleReference,
    RolePosition,
    RoleHoistPosition,
    RoleCreate,
    RoleEdit,
    GuildMember,
    DeletedMessageMember,
    MemberReference,
    MemberProfileEdit,
    MemberMentionPreference,
    VoiceConnectionReference,
    VoiceMuteInput,
    VoiceDeafenInput,
    MemberQuery,
    BanInput,
    GuildBan,
    CanManageOptions,
    TimeoutOptions,
    TimeoutStateOptions,
    MemberTimeoutState,
    GuildOperation,
    GuildOperationFailure,
} from "./guilds.js"
export type { ChannelPermissions, PermissionFetchOptions, PermissionInput, PermissionTarget } from "./permissions.js"
export { hierarchy } from "./api/effect/hierarchy.js"
export type { HierarchyHelpers, RoleHierarchyInput, RoleManagementInput } from "./role-hierarchy.js"
export { MemberChunkError } from "./member-chunks.js"
export type { MemberChunk, MemberChunkQuery, MemberChunkFailure, MemberChunkOptions } from "./member-chunks.js"
export { GuildMemberJoinSourceTypes } from "./member-search.js"
export type {
    GuildMemberJoinSourceType,
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
    MessageSearchPage,
    MessageSearchQuery,
    MessageSearchResultsPage,
} from "./message-search.js"
export type { Emojis } from "./api/effect/emojis.js"
export type { Stickers } from "./api/effect/stickers.js"
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
} from "./expressions.js"
export type { Invites } from "./api/effect/invites.js"
export type { Invite, InviteCreate, InviteMetadata } from "./invites.js"
export type { Discovery } from "./api/effect/discovery.js"
export { DiscoveryCategories } from "./discovery.js"
export type {
    DiscoveryApplication,
    DiscoveryApplicationInput,
    DiscoveryApplicationEdit,
    DiscoveryCategory,
    DiscoveryCategoryCount,
    DiscoveryGuild,
    DiscoverySearchPage,
    DiscoverySearchQuery,
    DiscoveryStatus,
} from "./discovery.js"
export type { AuditLogs } from "./api/effect/audit-logs.js"
export { AuditLogActions } from "./audit-logs.js"
export type {
    AuditLogActionType,
    AuditLogEntry,
    AuditLogFilter,
    AuditLogIterationQuery,
    AuditLogIterationQueryBase,
    AuditLogPage,
    AuditLogPermissionsDiff,
    AuditLogQuery,
    AuditLogQueryBase,
    AuditLogChangeValue,
    AuditLogChange,
    AuditLogOptions,
    AuditLogWebhook,
} from "./audit-logs.js"

// ---------------------------------------------------------------------------
// Webhooks, OAuth, users, direct messages, application, instance and presence
// ---------------------------------------------------------------------------
export type { Webhooks } from "./api/effect/webhooks.js"
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
    WebhookMessageOperationOptions,
    WebhookMessageOptions,
    WebhookMessageReference,
    WebhookReplyReference,
    WebhookForwardReference,
    WebhookMessageEdit,
    WebhookForumPostOptions,
    WebhookClientOptions,
    WebhookOperation,
    WebhookOperationFailure,
} from "./webhooks.js"
export { OAuthOperationError, OAuthScopes } from "./oauth.js"
export type {
    OAuthAuthorizationInput,
    OAuthActiveIntrospection,
    OAuthAuthorization,
    OAuthConnection,
    OAuthCodeExchangeInput,
    OAuthConfig,
    OAuthIdentity,
    OAuthInactiveIntrospection,
    OAuthIntrospection,
    OAuthOperation,
    OAuthOperationFailure,
    OAuthPkce,
    OAuthScope,
    OAuthTokens,
} from "./oauth.js"
export type { Users } from "./api/effect/users.js"
export type { DirectMessages } from "./api/effect/direct-messages.js"
export { UserOperationError } from "./users.js"
export type {
    User,
    ProfileBadge,
    UserProfile,
    UserProfileFields,
    UserProfileQuery,
    DirectMessageChannel,
    DirectMessageGroupEdit,
    DirectMessageLatestMessages,
    DirectMessageRecipientChange,
    UserOperation,
    UserOperationFailure,
} from "./users.js"
export type { CurrentBotApplication } from "./api/effect/application.js"
export { BotApplicationOperationError } from "./application.js"
export type { BotApplication, BotApplicationOperation, BotApplicationOperationFailure } from "./application.js"
export type { Instance, ResolvedInstance } from "./api/effect/instance.js"
export type {
    InstanceBadge,
    InstanceBadgeLookup,
    InstanceBadgePage,
    InstanceBadgePageQuery,
    InstanceBadgeQuery,
    InstanceDomainMigration,
    InstanceEndpoints,
    InstanceOptions,
    InstanceResolveError,
} from "./instance.js"
export type { Presence } from "./api/effect/presence.js"
export { PresenceError } from "./presence.js"
export type {
    PresenceInput,
    PresenceStatus,
    CustomStatusInput,
    CustomStatusEmoji,
    PresenceFailure,
} from "./presence.js"

// ---------------------------------------------------------------------------
// Pure helpers: Formatting, snowflakes, permissions, colors, text, links and assets
// ---------------------------------------------------------------------------
export { format, snowflakes, display, permissionBits, colors, text, links, assets } from "./api/effect/helpers.js"
export type {
    AssetHelpers,
    ColorHelpers,
    FormatHelpers,
    LinkHelpers,
    PermissionBitHelpers,
    SnowflakeHelpers,
    TextHelpers,
} from "./api/effect/helpers.js"
export { HelperError, TimestampStyles } from "./helpers.js"
export type {
    ChannelLinkTarget,
    CustomEmojiMarkup,
    DisplayHelpers,
    InstallationLinkOptions,
    Mention,
    PermissionBitInspection,
    PermissionName,
    OverwritePatch,
    TimestampMarkup,
    TimestampStyle,
} from "./helpers.js"
export { AssetFormats, AssetUrlError } from "./assets.js"
export type { AssetFormat, AssetUrlOptions, StickerAssetUrlOptions } from "./assets.js"
export type { ColorInput, RgbColor } from "./colors.js"
export type { TextSplitOptions, TextTruncateOptions } from "./text.js"
export { voiceWaveform } from "./voice-notes.js"
export type { VoiceWaveform, VoiceWaveformOptions } from "./voice-notes.js"

// ---------------------------------------------------------------------------
// Sharding, supervisor, caching and pagination
// ---------------------------------------------------------------------------
export { fileSessionStore } from "./sharding.js"
export type {
    IdentifyCoordinator,
    SessionSnapshot,
    SessionStore,
    ShardingOptions,
    ShardRecoveryDiagnostic,
    ShardState,
} from "./sharding.js"
export { supervisor } from "./api/effect/supervisor.js"
export { SupervisorChildError, SupervisorError } from "./supervisor.js"
export type {
    SupervisorAssignment,
    SupervisorAssignmentOptions,
    SupervisorChildDiagnostics,
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
    Supervisor,
    SupervisorChildContext,
    SupervisorChildOptions,
    SupervisorTools,
} from "./native-supervisor.js"
export type { CacheObserver, ClientCache } from "./api/effect/cache.js"
export type {
    CacheChange,
    CacheObserverOptions,
    MessageCacheOptions,
    MessageCacheSettings,
    ResourceCacheSettings,
} from "./cache.js"
export { PaginationError } from "./pagination.js"
export type {
    GuildIterationQuery,
    HistoryIterationQuery,
    PaginationOperation,
    PaginationQuery,
    PinIterationQuery,
    UserIterationQuery,
} from "./pagination.js"
