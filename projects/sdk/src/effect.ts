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
 * Misuse is a defect too: Invalid client, router or registration options, including a missing token, die with
 * ConfigurationError, and a pure helper given invalid input throws its error, which becomes a defect inside an Effect.
 * Interruption is Effect's cancellation mechanism.
 * Cause can represent errors, defects and interruption together.
 * Cancellation waits for SDK-owned cleanup, but cannot undo a request already sent to Fluxer
 *
 * Scope is the cleanup lifetime required by client creation, subscriptions and collectors.
 * Wrap a program in Effect.scoped to provide that lifetime and close its resources when the program ends.
 * Keep a client and its listeners inside their scopes rather than returning handles after their scopes close.
 * Other required services come from the caller's Effect program, including services used by handlers
 *
 * The [glossary](https://preview.fluxerly.neontechspace.com/docs/latest/glossary/) defines terms such as guild, gateway,
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
 * Coding agents: read node_modules/@neontechspace/fluxerly/agents/AGENTS.md before writing code with this package
 *
 * @packageDocumentation
 */
// Checked first, so an unsupported Node.js version fails with a clear message before any other SDK code runs
import "./internal/node-version.js"
export { MemberChunkError } from "./member-chunks.js"
export type { MemberChunk, MemberChunkQuery, MemberChunkFailure, MemberChunkOptions } from "./member-chunks.js"
export { CountOperationError } from "./counts.js"
export type {
    CountOperation,
    CountOperationFailure,
    CountOperationOptions,
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
export type { HierarchyHelpers, RoleHierarchyInput } from "./role-hierarchy.js"
export { BotApplicationOperationError } from "./application.js"
export type {
    BotApplication,
    BotApplicationOperation,
    BotApplicationOperationFailure,
    BotApplicationOperationOptions,
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
    WebhookOperationFailure,
} from "./webhooks.js"
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
    NativeCooldownStore,
    MemoryCooldownStore,
    NativePrefixCommand,
    NativePrefixCommandContext,
    NativePrefixCommandExecutionContext,
    NativePrefixCommandCooldown,
    NativePrefixCommandUnmatchedContext,
    NativePrefixCommandsOptions,
    NativePrefixCommandGuard,
    NativePrefixCommandMiddleware,
    NativePrefixCommandRejectionFeedback,
    NativePrefixCommandRouter,
} from "./native-commands.js"
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
    NativeSupervisor,
    NativeSupervisorChildContext,
    NativeSupervisorChildOptions,
    NativeSupervisorTools,
} from "./native-supervisor.js"
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
    ChannelAuditOperationOptions,
} from "./channels.js"
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
    CanManageOptions,
    GuildAuditOperationOptions,
} from "./guilds.js"
export type { BanInput, GuildBan, ModerationOptions, TimeoutOptions } from "./guilds.js"
export type { MessageCacheOptions, MessageCacheSettings } from "./cache.js"
export type { ResourceCacheSettings } from "./cache.js"
export type {
    InstanceDomainMigration,
    InstanceEndpoints,
    InstanceOptions,
    InstanceResolveError,
    InstanceResolveOptions,
} from "./instance.js"
export type { MessagePinsQuery, MessagePinsPage, MessagePin, ChannelPinsUpdate } from "./pins.js"
export type { ReactionCollectorResult } from "./collectors.js"
export { CollectorError } from "./collectors.js"
export type { CollectorResult, CollectorFailure } from "./collectors.js"
export type { FailureKind, FailureMessageReference } from "./failures.js"
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
    EditMessageInput,
    MessageOperationOptions,
    MessageAuditOperationOptions,
    OwnMessageDeletionOptions,
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
    ConnectionRecoveryOptions,
    ConnectionState,
    OperationSignal,
    ShutdownOptions,
} from "./client.js"
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
    OperationErrorOptions,
    OperationOutcome,
    OperationReason,
} from "./errors.js"
export { describeError, errors } from "./error-tools.js"
export type { DescribeErrorOptions, ErrorTools } from "./error-tools.js"
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
export type { EventMiddleware, MiddlewareRegistration } from "./api/effect/events.js"
export type { CacheObserver } from "./api/effect/cache.js"
export { FluxerClient } from "./api/effect/service.js"
export type { FluxerClientConfigOptions } from "./api/effect/service.js"
export { format, snowflakes, display, permissionBits, colors, text, links, assets } from "./api/effect/helpers.js"
export type { ResolvedInstance, Instance } from "./api/effect/instance.js"
export { oauth } from "./api/effect/oauth.js"
export type { OAuthClient } from "./api/effect/oauth.js"
export { commands } from "./api/effect/commands.js"
export { supervisor } from "./api/effect/supervisor.js"
export { hierarchy } from "./api/effect/hierarchy.js"
export { createClient } from "./api/effect/client.js"
export type { ClientOptions, Client } from "./api/effect/client.js"
export type {
    ReactionCollectorOptions,
    CollectorOptions,
    Collector,
    ReactionCollector,
} from "./api/effect/collectors.js"
export type { FailureReport } from "./api/effect/failures.js"
export type { Subscription, EventHandlerOptions } from "./api/effect/events.js"
export type { Attachments } from "./api/effect/attachments.js"
export type { Messages } from "./api/effect/messages.js"
export type { AuditLogs } from "./api/effect/audit-logs.js"
export type { Invites } from "./api/effect/invites.js"
export type { Emojis } from "./api/effect/emojis.js"
export type { Stickers } from "./api/effect/stickers.js"
export type { Discovery } from "./api/effect/discovery.js"
export type { Guilds } from "./api/effect/guilds.js"
export type { Channels } from "./api/effect/channels.js"
export type { Members } from "./api/effect/members.js"
export type { PermissionHelpers } from "./api/effect/permissions.js"
export type { Roles } from "./api/effect/roles.js"
export type { Webhooks } from "./api/effect/webhooks.js"
export { createWebhookClient } from "./api/effect/webhook-client.js"
export type { WebhookClient } from "./api/effect/webhook-client.js"
export type { ClientCache } from "./api/effect/cache.js"
export type { RestRequests } from "./api/effect/rest.js"
export type { GatewayCommands } from "./api/effect/gateway.js"
export type { ClientLogging } from "./api/effect/logging.js"
export { RestRequestError } from "./rest.js"
export type {
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
export type { Presence } from "./api/effect/presence.js"
export type { CurrentBotApplication } from "./api/effect/application.js"
export type { Users } from "./api/effect/users.js"
export type { DirectMessages } from "./api/effect/direct-messages.js"
export { runBot } from "./api/effect/bot.js"
export type {
    BotCommandEntries,
    BotCommandsOptions,
    BotEventContext,
    BotEventHandler,
    BotEventOptions,
    BotEvents,
    BotOptions,
} from "./api/effect/bot.js"
export { guards } from "./api/effect/guards.js"
export type { NativeGuards } from "./api/effect/guards.js"
export type {
    AssetHelpers,
    ColorHelpers,
    FormatHelpers,
    LinkHelpers,
    PermissionBitHelpers,
    SnowflakeHelpers,
    TextHelpers,
} from "./api/effect/helpers.js"
export type { DisplayHelpers } from "./helpers.js"
export type { AuditLogFilter, AuditLogIterationQueryBase, AuditLogQueryBase } from "./audit-logs.js"
export type { CommandArgumentOptionalValue } from "./command-arguments.js"
export type { EditMessageOptions, MessageContent } from "./messages.js"
export type { WebhookMessageOptions } from "./webhooks.js"
export type { ErrorMatchHandlers } from "./error-tools.js"
export type {
    NativeBatchRequirements,
    NativeCommandRequirements,
    NativeCommands,
    NativeEffectRequirements,
    NativePrefixCommandBatch,
} from "./native-commands.js"
export type { BotEventServices, HandlerServices } from "./api/effect/bot.js"
export type { Operation } from "./errors.js"
