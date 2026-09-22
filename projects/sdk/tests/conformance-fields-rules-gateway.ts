import {
    defineFieldRules,
    defineLocalFieldExclusions,
    type FieldRuleAnnotation,
    type LocalFieldExclusion,
} from "./conformance-fields-registry.js"

type RuleOptions = Readonly<{
    default?: FieldRuleAnnotation["default"]
    length?: FieldRuleAnnotation["length"]
    normalization?: FieldRuleAnnotation["normalization"]
}>

const required = { kind: "none", detail: "The field is required and has no SDK or provider default" } as const
const optional = { kind: "omitted", detail: "An absent optional field is not serialized" } as const
const observed = { kind: "none", detail: "A valid provider observation supplies this field" } as const
const unavailable = {
    kind: "omitted",
    detail: "The SDK preserves provider absence instead of substituting a scalar or empty collection",
} as const
const scalar = { kind: "not-applicable", detail: "This scalar or structured field has no length unit" } as const
const preserved = { kind: "preserved", detail: "The SDK preserves the validated value" } as const

function rule(
    target: string,
    direction: FieldRuleAnnotation["direction"],
    providerOwner: FieldRuleAnnotation["providerOwner"],
    sdkOwner: FieldRuleAnnotation["sdkOwner"],
    executableEvidence: FieldRuleAnnotation["executableEvidence"],
    options: RuleOptions = {},
): FieldRuleAnnotation {
    return {
        target,
        direction,
        providerOwner,
        sdkOwner,
        default: options.default ?? (direction === "request" ? optional : observed),
        length: options.length ?? scalar,
        normalization: options.normalization ?? preserved,
        executableEvidence,
    }
}

function local(
    targets: readonly string[],
    direction: LocalFieldExclusion["direction"],
    rationale: string,
    sdkOwner: LocalFieldExclusion["sdkOwner"],
    executableEvidence: LocalFieldExclusion["executableEvidence"],
): LocalFieldExclusion[] {
    return targets.map((target) => ({ target, direction, rationale, sdkOwner, executableEvidence }))
}

const gatewayCommands = "fluxer_docs/src/content/docs/gateway/commands.md" as const
const gatewayEvents = "fluxer_docs/src/content/docs/gateway/events.md" as const
const gatewayEvidence = [
    "tests/gateway-conformance.test.ts",
    "tests/guild-lifecycle.test.ts",
    "tests/administrative-events.test.ts",
    "tests/expression-events.test.ts",
    "tests/message-events.test.ts",
    "tests/presence.test.ts",
    "tests/voice.test.ts",
] as const
const presenceEvidence = ["tests/presence.test.ts", "tests/sharding-presence.test.ts"] as const
const chunkEvidence = ["tests/member-chunks.test.ts"] as const
const countEvidence = ["tests/counts.test.ts"] as const
const instanceEvidence = ["tests/instance.test.ts", "tests/instance-loopback.test.ts"] as const
const applicationEvidence = ["tests/applications.test.ts"] as const
const paginationEvidence = ["tests/pagination.test.ts", "tests/pagination-runtime.test.ts"] as const
const permissionEvidence = ["tests/permissions.test.ts"] as const

const eventMapOwners = {
    channelPinsUpdate: "channel-pins-update",
    directMessageCreate: "channel-create",
    directMessageDelete: "channel-delete",
    directMessageRecipientAdd: "channel-recipient-add",
    directMessageRecipientRemove: "channel-recipient-remove",
    directMessageUpdate: "channel-update",
    guildAuditLogEntryCreate: "guild-audit-log-entry-create",
    guildBanAdd: "guild-ban-add",
    guildBanRemove: "guild-ban-remove",
    guildChannelCreate: "channel-create",
    guildChannelDelete: "channel-delete",
    guildChannelUpdate: "channel-update",
    guildChannelUpdateBulk: "channel-update-bulk",
    guildCreate: "guild-create",
    guildDelete: "guild-delete",
    guildEmojisUpdate: "guild-emojis-update",
    guildMemberAdd: "guild-member-add",
    guildMemberRemove: "guild-member-remove",
    guildMemberUpdate: "guild-member-update",
    guildRoleCreate: "guild-role-create",
    guildRoleDelete: "guild-role-delete",
    guildRoleUpdate: "guild-role-update",
    guildRoleUpdateBulk: "guild-role-update-bulk",
    guildStickersUpdate: "guild-stickers-update",
    guildUpdate: "guild-update",
    inviteCreate: "invite-create",
    inviteDelete: "invite-delete",
    messageCreate: "message-create",
    messageDelete: "message-delete",
    messageDeleteBulk: "message-delete-bulk",
    messageReactionAdd: "message-reaction-add",
    messageReactionAddMany: "message-reaction-add-many",
    messageReactionRemove: "message-reaction-remove",
    messageReactionRemoveAll: "message-reaction-remove-all",
    messageReactionRemoveEmoji: "message-reaction-remove-emoji",
    messageUpdate: "message-update",
    presenceUpdate: "presence-update",
    presenceUpdateBulk: "presence-update-bulk",
    typingStart: "typing-start",
    userUpdate: "user-update",
    voiceStateSnapshot: "guild-create",
    voiceStateUpdate: "voice-state-update",
    webhooksUpdate: "webhooks-update",
} as const

const eventMapRules = Object.entries(eventMapOwners).map(([name, anchor]) =>
    rule(
        `EventMap.${name}`,
        "gateway",
        `${gatewayEvents}#${anchor}`,
        "src/internal/gateway.ts:runSelectedGateway",
        gatewayEvidence,
        {
            normalization: {
                kind: "provider-normalized-view",
                detail: "The SDK routes the named Dispatch through its event-specific decoder and exposes the frozen projection",
            },
        },
    ),
)

const gatewayPayloadRules: FieldRuleAnnotation[] = [
    ...["WebhooksUpdate.guildId", "WebhooksUpdate.channelId"].map((target) =>
        rule(
            target,
            "gateway",
            `${gatewayEvents}#webhooks-update`,
            "src/internal/gateway.ts:runSelectedGateway",
            gatewayEvidence,
        ),
    ),
    rule(
        "InviteDeleteEvent.code",
        "gateway",
        `${gatewayEvents}#invite-delete`,
        "src/internal/invites.ts:decodeInviteDelete",
        gatewayEvidence,
    ),
    ...["InviteDeleteEvent.channelId", "InviteDeleteEvent.guildId"].map((target) =>
        rule(
            target,
            "gateway",
            `${gatewayEvents}#invite-delete`,
            "src/internal/invites.ts:decodeInviteDelete",
            gatewayEvidence,
            {
                default: unavailable,
            },
        ),
    ),
    ...["GuildAuditLogEntryCreate.guildId", "GuildAuditLogEntryCreate.userId", "GuildAuditLogEntryCreate.targetId"].map(
        (target) =>
            rule(
                target,
                "gateway",
                `${gatewayEvents}#guild-audit-log-entry-create`,
                "src/internal/gateway.ts:runSelectedGateway",
                gatewayEvidence,
            ),
    ),
    ...["TypingStart.channelId", "TypingStart.userId", "TypingStart.timestamp"].map((target) =>
        rule(
            target,
            "gateway",
            `${gatewayEvents}#typing-start`,
            "src/internal/gateway.ts:decodeTypingStart",
            gatewayEvidence,
        ),
    ),
    rule(
        "TypingStart.guildId",
        "gateway",
        `${gatewayEvents}#typing-start`,
        "src/internal/gateway.ts:decodeTypingStart",
        gatewayEvidence,
        {
            default: unavailable,
        },
    ),
    ...["GuildEmojisUpdate.guildId", "GuildEmojisUpdate.items"].map((target) =>
        rule(
            target,
            "gateway",
            `${gatewayEvents}#guild-emojis-update`,
            "src/internal/expressions.ts:decodeExpressionUpdate",
            gatewayEvidence,
        ),
    ),
    ...["GuildStickersUpdate.guildId", "GuildStickersUpdate.items"].map((target) =>
        rule(
            target,
            "gateway",
            `${gatewayEvents}#guild-stickers-update`,
            "src/internal/expressions.ts:decodeExpressionUpdate",
            gatewayEvidence,
        ),
    ),
    rule(
        "GuildCreate.isNewJoin",
        "gateway",
        `${gatewayEvents}#guild-create`,
        "src/internal/guilds.ts:decodeGuildLifecycleEvent",
        gatewayEvidence,
        {
            default: {
                kind: "value",
                value: "true",
                detail: "The SDK supplies true when the provider unavailable marker is absent, and false when it is explicitly false",
            },
            normalization: {
                kind: "canonicalized",
                detail: "An omitted unavailable marker maps to true and literal false maps to false",
            },
        },
    ),
    ...["PresenceUpdate.userId", "PresenceUpdate.status", "PresenceUpdate.mobile", "PresenceUpdate.afk"].map((target) =>
        rule(
            target,
            "gateway",
            `${gatewayEvents}#presence-object`,
            "src/internal/presence.ts:decodePresenceUpdate",
            presenceEvidence,
        ),
    ),
    rule(
        "PresenceUpdate.guildId",
        "gateway",
        `${gatewayEvents}#presence-object`,
        "src/internal/presence.ts:decodePresenceUpdate",
        presenceEvidence,
        { default: unavailable },
    ),
    rule(
        "PresenceUpdateBulk.guildId",
        "gateway",
        `${gatewayEvents}#presence-update-bulk`,
        "src/internal/presence.ts:decodePresenceUpdateBulk",
        presenceEvidence,
    ),
    rule(
        "PresenceUpdateBulk.presences",
        "gateway",
        `${gatewayEvents}#presence-update-bulk`,
        "src/internal/presence.ts:decodePresenceUpdateBulk",
        presenceEvidence,
        {
            length: {
                kind: "bounded",
                unit: "items",
                minimum: 1,
                maximum: 500,
                detail: "Fluxer splits nonempty recovery batches at 500 presences",
            },
        },
    ),
    ...[
        "VoiceState.guildId",
        "VoiceState.channelId",
        "VoiceState.userId",
        "VoiceState.isMuted",
        "VoiceState.isDeafened",
        "VoiceState.isSelfMuted",
        "VoiceState.isSelfDeafened",
        "VoiceState.isMobile",
        "VoiceState.isSuppressed",
    ].map((target) =>
        rule(
            target,
            "gateway",
            `${gatewayEvents}#voice-state-object`,
            "src/internal/guilds.ts:decodeVoiceState",
            gatewayEvidence,
        ),
    ),
    rule(
        "VoiceState.connectionId",
        "gateway",
        `${gatewayEvents}#voice-state-object`,
        "src/internal/guilds.ts:decodeVoiceState",
        gatewayEvidence,
        {
            length: {
                kind: "bounded",
                unit: "Unicode-code-points",
                minimum: 1,
                maximum: 32,
                detail: "The gateway decoder accepts one through 32 Unicode code points",
            },
        },
    ),
    rule(
        "VoiceState.sessionId",
        "gateway",
        `${gatewayEvents}#voice-state-object`,
        "src/internal/guilds.ts:decodeVoiceState",
        gatewayEvidence,
        { default: unavailable },
    ),
    ...["VoiceStateSnapshot.guildId", "VoiceStateSnapshot.voiceStates"].map((target) =>
        rule(
            target,
            "gateway",
            `${gatewayEvents}#guild-ready-object`,
            "src/internal/guilds.ts:decodeVoiceStateSnapshot",
            gatewayEvidence,
        ),
    ),
]

const providerRequestRules: FieldRuleAnnotation[] = [
    rule(
        "PresenceInput.status",
        "request",
        `${gatewayCommands}#presence-update`,
        "src/internal/presence.ts:presenceInput",
        presenceEvidence,
        { default: required },
    ),
    rule(
        "PresenceInput.customStatus",
        "request",
        `${gatewayCommands}#presence-update`,
        "src/internal/presence.ts:presenceInput",
        presenceEvidence,
        {
            default: {
                kind: "omitted",
                detail: "Omission keeps the current custom status, while null explicitly clears it",
            },
        },
    ),
    rule(
        "CustomStatusInput.text",
        "request",
        `${gatewayCommands}#custom-status-object`,
        "src/internal/presence.ts:customStatus",
        presenceEvidence,
        {
            length: {
                kind: "bounded",
                unit: "UTF-16-code-units",
                minimum: 1,
                maximum: 128,
                detail: "The SDK enforces the documented custom-status text range",
            },
        },
    ),
    rule(
        "CustomStatusInput.emoji",
        "request",
        `${gatewayCommands}#custom-status-object`,
        "src/internal/presence.ts:customStatusEmoji",
        presenceEvidence,
        {
            normalization: {
                kind: "canonicalized",
                detail: "The SDK canonicalizes the one-of public object into the provider's emoji_id or emoji_name wire field",
            },
        },
    ),
    rule(
        "CustomStatusEmoji.id",
        "request",
        `${gatewayCommands}#custom-status-object`,
        "src/internal/presence.ts:customStatusEmoji",
        presenceEvidence,
        { default: required },
    ),
    rule(
        "CustomStatusEmoji.name",
        "request",
        `${gatewayCommands}#custom-status-object`,
        "src/internal/presence.ts:customStatusEmoji",
        presenceEvidence,
        {
            default: required,
            length: {
                kind: "bounded",
                unit: "UTF-16-code-units",
                minimum: 1,
                maximum: 32,
                detail: "The SDK enforces the documented Unicode emoji text range",
            },
        },
    ),
    rule(
        "CustomStatusInput.expiresAt",
        "request",
        `${gatewayCommands}#custom-status-object`,
        "src/internal/presence.ts:customStatus",
        presenceEvidence,
    ),
    rule(
        "MemberChunkQuery.userIds",
        "request",
        `${gatewayCommands}#request-guild-members`,
        "src/internal/member-chunks.ts:settings",
        chunkEvidence,
        {
            default: required,
            length: {
                kind: "bounded",
                unit: "items",
                minimum: 1,
                maximum: 100,
                detail: "The explicit-ID selection accepts one through 100 unique IDs",
            },
        },
    ),
    rule(
        "MemberChunkQuery.query",
        "request",
        `${gatewayCommands}#request-guild-members`,
        "src/internal/member-chunks.ts:settings",
        chunkEvidence,
        {
            default: required,
            length: {
                kind: "bounded",
                unit: "UTF-16-code-units",
                minimum: 0,
                maximum: 4096,
                detail: "The SDK bounds the prefix and separately enforces the 4,096-byte encoded gateway frame",
            },
        },
    ),
    rule(
        "MemberChunkQuery.limit",
        "request",
        `${gatewayCommands}#request-guild-members`,
        "src/internal/member-chunks.ts:settings",
        chunkEvidence,
        {
            default: {
                kind: "value",
                value: "25",
                detail: "The SDK sends 25 when the text-query selection omits limit",
            },
        },
    ),
    rule(
        "MemberChunkQuery.presences",
        "request",
        `${gatewayCommands}#request-guild-members`,
        "src/internal/member-chunks.ts:settings",
        chunkEvidence,
        { default: { kind: "value", value: "false", detail: "The SDK serializes false when presences is omitted" } },
    ),
    rule(
        "GuildIterationQuery.after",
        "request",
        "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildListQuery",
        "src/internal/pagination.ts:guildPagination",
        paginationEvidence,
    ),
    rule(
        "GuildIterationQuery.withCounts",
        "request",
        "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildListQuery",
        "src/internal/pagination.ts:guildPagination",
        paginationEvidence,
        {
            default: {
                kind: "value",
                value: "false",
                detail: "The iterator serializes with_counts=false when the caller omits withCounts",
            },
        },
    ),
    rule(
        "HistoryIterationQuery.before",
        "request",
        "packages/schema/src/domains/message/MessageRequestSchemas.ts:MessagesQuery",
        "src/internal/pagination.ts:historyPagination",
        paginationEvidence,
    ),
    rule(
        "PinIterationQuery.before",
        "request",
        "packages/schema/src/domains/message/MessageRequestSchemas.ts:ChannelPinsQuerySchema",
        "src/internal/pagination.ts:pinPagination",
        paginationEvidence,
        { default: { kind: "provider", detail: "Omission lets Fluxer choose its current-time starting point" } },
    ),
    rule(
        "UserIterationQuery.after",
        "request",
        "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildMemberListQuery; packages/schema/src/domains/message/MessageRequestSchemas.ts:ReactionUsersQuerySchema",
        "src/internal/pagination.ts:memberPagination and reactionUserPagination",
        [
            "tests/pagination.test.ts",
            "tests/pagination-runtime.test.ts",
            "tests/guilds.test.ts",
            "tests/reactions.test.ts",
        ],
    ),
    rule(
        "PermissionTarget.channelId",
        "request",
        "fluxer_api/src/api/channel/controllers/ChannelController.ts:ChannelController",
        "src/internal/permissions.ts:validateTarget",
        permissionEvidence,
    ),
]

const providerResponseRules: FieldRuleAnnotation[] = [
    ...["PresenceUpdate.userId", "PresenceUpdate.status", "PresenceUpdate.mobile", "PresenceUpdate.afk"].map((target) =>
        rule(target, "response", `${gatewayEvents}#presence-object`, "src/internal/presence.ts:decodePresenceUpdate", [
            "tests/presence.test.ts",
            "tests/member-chunks.test.ts",
        ]),
    ),
    rule(
        "PresenceUpdate.guildId",
        "response",
        `${gatewayEvents}#presence-object`,
        "src/internal/presence.ts:decodePresenceUpdate",
        ["tests/presence.test.ts", "tests/member-chunks.test.ts"],
        { default: unavailable },
    ),
    ...["MemberChunk.guildId", "MemberChunk.index", "MemberChunk.count"].map((target) =>
        rule(
            target,
            "response",
            `${gatewayEvents}#guild-members-chunk`,
            "src/internal/member-chunks.ts:MemberChunkSource.receive",
            chunkEvidence,
        ),
    ),
    rule(
        "MemberChunk.members",
        "response",
        `${gatewayEvents}#guild-members-chunk`,
        "src/internal/member-chunks.ts:MemberChunkSource.receive",
        chunkEvidence,
        {
            length: {
                kind: "bounded",
                unit: "items",
                minimum: 0,
                maximum: 1000,
                detail: "A provider member chunk contains at most 1,000 members",
            },
        },
    ),
    rule(
        "MemberChunk.presences",
        "response",
        `${gatewayEvents}#guild-members-chunk`,
        "src/internal/member-chunks.ts:MemberChunkSource.receive",
        chunkEvidence,
        {
            default: unavailable,
            length: {
                kind: "bounded",
                unit: "items",
                minimum: 0,
                maximum: 1000,
                detail: "Presence observations are limited to members in the same at-most-1,000-member chunk",
            },
        },
    ),
    ...["GuildCount.guildId", "GuildCount.memberCount", "GuildCount.onlineCount"].map((target) =>
        rule(
            target,
            "response",
            `${gatewayEvents}#guild-count-entry-object`,
            "src/internal/counts.ts:guildCounts",
            countEvidence,
        ),
    ),
    rule(
        "GuildCountsResult.counts",
        "response",
        `${gatewayEvents}#guild-counts-update`,
        "src/internal/counts.ts:CountOwner.guildResult",
        countEvidence,
        {
            length: {
                kind: "bounded",
                unit: "items",
                minimum: 0,
                maximum: 100,
                detail: "The provider command accepts at most 100 requested guild IDs",
            },
        },
    ),
    ...[
        "ChannelMemberCount.channelId",
        "ChannelMemberCount.guildId",
        "ChannelMemberCount.memberCount",
        "ChannelMemberCount.onlineCount",
    ].map((target) =>
        rule(
            target,
            "response",
            `${gatewayEvents}#channel-count-entry-object`,
            "src/internal/counts.ts:channelCounts",
            countEvidence,
        ),
    ),
    rule(
        "ChannelMemberCountsResult.counts",
        "response",
        `${gatewayEvents}#channel-member-counts-update`,
        "src/internal/counts.ts:CountOwner.channelResult",
        countEvidence,
        {
            length: {
                kind: "bounded",
                unit: "items",
                minimum: 0,
                maximum: 25,
                detail: "The provider command accepts at most 25 requested channel IDs",
            },
        },
    ),
    ...[
        "InstanceEndpoints.apiPublic",
        "InstanceEndpoints.gateway",
        "InstanceEndpoints.invite",
        "InstanceEndpoints.media",
        "InstanceEndpoints.staticCdn",
        "InstanceEndpoints.webapp",
    ].map((target) =>
        rule(
            target,
            "response",
            "packages/schema/src/domains/instance/InstanceSchemas.ts:WellKnownFluxerResponse",
            "src/internal/instance.ts:parseDocument",
            instanceEvidence,
            {
                normalization: {
                    kind: "canonicalized",
                    detail: "The SDK parses the advertised absolute URL and removes one trailing slash",
                },
            },
        ),
    ),
    ...["ResolvedInstance.apiCodeVersion", "ResolvedInstance.presignedAttachmentUploads"].map((target) =>
        rule(
            target,
            "response",
            "packages/schema/src/domains/instance/InstanceSchemas.ts:WellKnownFluxerResponse",
            "src/internal/instance.ts:parseDocument",
            instanceEvidence,
        ),
    ),
    rule(
        "ResolvedInstance.endpoints",
        "response",
        "packages/schema/src/domains/instance/InstanceSchemas.ts:WellKnownFluxerResponse",
        "src/internal/instance.ts:parseDocument",
        instanceEvidence,
        {
            normalization: {
                kind: "canonicalized",
                detail: "The SDK composes and freezes this aggregate from the individually validated endpoint URL projections",
            },
        },
    ),
    ...[
        "BotApplication.botPublic",
        "BotApplication.botRequireCodeGrant",
        "BotApplication.description",
        "BotApplication.icon",
        "BotApplication.id",
        "BotApplication.name",
    ].map((target) =>
        rule(
            target,
            "response",
            "packages/schema/src/domains/oauth/OAuthSchemas.ts:ApplicationsMeResponse",
            "src/internal/application.ts:decodeApplication",
            applicationEvidence,
        ),
    ),
]

export const gatewayFieldRules = defineFieldRules([
    ...eventMapRules,
    ...gatewayPayloadRules,
    ...providerRequestRules,
    ...providerResponseRules,
])

const signalTargets = [
    "DefaultAttachmentDownloadOptions.signal",
    "DefaultAttachmentRefreshOptions.signal",
    "DefaultAttachmentStreamOptions.signal",
    "DefaultBotApplicationOperationOptions.signal",
    "DefaultChannelAuditOperationOptions.signal",
    "DefaultChannelOperationOptions.signal",
    "DefaultCountOperationOptions.signal",
    "DefaultEventWaitOptions.signal",
    "DefaultExpressionDeleteOptions.signal",
    "DefaultGuildAuditOperationOptions.signal",
    "DefaultGuildOperationOptions.signal",
    "DefaultInstanceResolveOptions.signal",
    "DefaultMemberChunkOptions.signal",
    "DefaultMessageCleanupOptions.signal",
    "DefaultMessageOperationOptions.signal",
    "DefaultMessageSearchOptions.signal",
    "DefaultModerationOptions.signal",
    "DefaultOAuthOperationOptions.signal",
    "DefaultSendOptions.signal",
    "DefaultTimeoutOptions.signal",
    "DefaultUserOperationOptions.signal",
    "DefaultWebhookOperationOptions.signal",
    "OperationOptions.signal",
    "OperationSignal.aborted",
    "OperationSignal.addEventListener",
    "OperationSignal.removeEventListener",
] as const

const paginationLocalTargets = [
    "AuditLogIterationQuery.maxItems",
    "AuditLogIterationQuery.maxPages",
    "AuditLogIterationQuery.pageSize",
    "GuildIterationQuery.maxItems",
    "GuildIterationQuery.maxPages",
    "GuildIterationQuery.pageSize",
    "HistoryIterationQuery.maxItems",
    "HistoryIterationQuery.maxPages",
    "HistoryIterationQuery.pageSize",
    "PinIterationQuery.maxItems",
    "PinIterationQuery.maxPages",
    "PinIterationQuery.pageSize",
    "UserIterationQuery.maxItems",
    "UserIterationQuery.maxPages",
    "UserIterationQuery.pageSize",
] as const

export const gatewayLocalFieldExclusions = defineLocalFieldExclusions([
    ...local(
        [
            "DefaultCollectorOptions.maxPendingBytes",
            "DefaultCollectorOptions.maxPendingMessages",
            "DefaultEventWaitOptions.filter",
            "DefaultEventWaitOptions.maxPendingBytes",
            "DefaultEventWaitOptions.maxPendingMessages",
            "DefaultEventWaitOptions.timeoutMs",
            "DefaultReactionCollectorOptions.maxPendingBytes",
            "DefaultReactionCollectorOptions.maxPendingMessages",
            "EventBufferOptions.maxPendingBytes",
            "EventBufferOptions.maxPendingMessages",
            "EventHandlerOptions.concurrency",
            "EventHandlerOptions.maxPendingBytes",
            "EventHandlerOptions.maxPendingMessages",
        ],
        "request",
        "Local event scheduling, queue, filter, deadline, and backpressure settings are not provider payload fields",
        "src/internal/events.ts:eventWaitSettings and limits",
        ["tests/event-waits.test.ts", "tests/event-accounting.test.ts"],
    ),
    ...local(
        ["DefaultMemberChunkOptions.maxPendingBytes", "DefaultMemberChunkOptions.timeoutMs"],
        "request",
        "The SDK owns stream intake capacity and the total local response deadline; neither setting is serialized",
        "src/internal/member-chunks.ts:settings",
        chunkEvidence,
    ),
    ...local(
        ["MemberChunkQuery.all"],
        "request",
        "The SDK-only full-list selector is encoded as the provider query empty string and limit zero",
        "src/internal/member-chunks.ts:settings",
        chunkEvidence,
    ),
    ...local(
        ["MemberChunk.omittedUserIds"],
        "response",
        "The SDK derives missing explicit IDs by comparing the final response with the frozen request selection",
        "src/internal/member-chunks.ts:MemberChunkSource.receive",
        chunkEvidence,
    ),
    ...local(
        ["DefaultCountOperationOptions.timeoutMs"],
        "request",
        "The SDK owns the total local nonce-correlation deadline and does not serialize it",
        "src/internal/counts.ts:timeout",
        countEvidence,
    ),
    ...local(
        ["GuildCountsResult.omittedGuildIds", "ChannelMemberCountsResult.omittedChannelIds"],
        "response",
        "The SDK derives omitted IDs by comparing correlated provider entries with the frozen requested order",
        "src/internal/counts.ts:CountOwner.guildResult and channelResult",
        countEvidence,
    ),
    ...local(
        ["DefaultInstanceResolveOptions.timeoutMs"],
        "request",
        "The SDK applies this discovery deadline locally and never sends it to the instance endpoint",
        "src/internal/instance.ts:resolveInstance",
        instanceEvidence,
    ),
    ...local(
        ["ResolvedInstance.assets", "ResolvedInstance.links"],
        "response",
        "These are SDK-created helper bundles bound to validated discovered origins, not fields in the discovery document",
        "src/internal/instance.ts:parseDocument",
        instanceEvidence,
    ),
    ...local(
        signalTargets,
        "request",
        "AbortSignal-compatible state and listener methods control local cancellation and are never serialized",
        "src/internal/operation-signal.ts:operationSignalError",
        ["tests/operation-signals.test.ts", "tests/stream-signal-cleanup.test.ts"],
    ),
    ...local(
        [
            "DefaultCollectorOptions.filter",
            "DefaultCollectorOptions.guildId",
            "DefaultCollectorOptions.idleMs",
            "DefaultCollectorOptions.maxBytes",
            "DefaultCollectorOptions.maxMessages",
            "DefaultCollectorOptions.onMessage",
            "DefaultCollectorOptions.signal",
            "DefaultCollectorOptions.timeoutMs",
        ],
        "request",
        "Message collection filters, limits, callbacks, cancellation, and timers are local intake policy, not gateway command fields",
        "src/internal/collector.ts:settings",
        ["tests/collectors.test.ts", "tests/message-collector-progress.test.ts"],
    ),
    ...local(
        [
            "DefaultReactionCollectorOptions.emoji",
            "DefaultReactionCollectorOptions.filter",
            "DefaultReactionCollectorOptions.guildId",
            "DefaultReactionCollectorOptions.idleMs",
            "DefaultReactionCollectorOptions.maxBytes",
            "DefaultReactionCollectorOptions.maxReactions",
            "DefaultReactionCollectorOptions.onReaction",
            "DefaultReactionCollectorOptions.signal",
            "DefaultReactionCollectorOptions.timeoutMs",
        ],
        "request",
        "Reaction collection selectors, filters, limits, callbacks, cancellation, and timers are local intake policy",
        "src/internal/reaction-collector.ts:settings",
        ["tests/collectors.test.ts", "tests/sharding-collectors.test.ts"],
    ),
    ...local(
        ["EventHandlerOptions.onError"],
        "request",
        "The callback reports local handler or overflow failures and is never serialized",
        "src/internal/events.ts:EventBus.on",
        ["tests/event-accounting.test.ts"],
    ),
    ...local(
        [
            "Collector.stop",
            "Collector.waitForClose",
            "EventSubscription.next",
            "EventSubscription.unsubscribe",
            "EventSubscription.waitForClose",
            "ReactionCollector.stop",
            "ReactionCollector.waitForClose",
            "Subscription.unsubscribe",
            "Subscription.waitForClose",
        ],
        "response",
        "These callable handle members control or await SDK-owned local lifetimes and are not provider response fields",
        "src/index.ts:Subscription, EventSubscription, Collector, and ReactionCollector",
        ["tests/event-waits.test.ts", "tests/collectors.test.ts"],
    ),
    ...local(
        [
            "AssetUrlError._tag",
            "AssetUrlError.operation",
            "AssetUrlError.reason",
            "AssetUrlOptions.animated",
            "AssetUrlOptions.format",
            "AssetUrlOptions.size",
            "StickerAssetUrlOptions.animated",
            "StickerAssetUrlOptions.size",
        ],
        "response",
        "Asset transform options and typed validation errors belong to pure SDK URL construction, not provider responses",
        "src/assets.ts:imageOptions, stickerOptions, and AssetUrlError",
        ["tests/assets.test.ts"],
    ),
    ...local(
        ["HelperError._tag", "HelperError.operation", "HelperError.reason", "InstallationLinkOptions.permissions"],
        "response",
        "Pure helper input and typed error fields construct local markup or links and are not provider response fields",
        "src/helpers.ts:HelperError and links.installation",
        ["tests/helpers.test.ts", "tests/pure-helper-workflows.test.ts"],
    ),
    ...local(
        paginationLocalTargets,
        "request",
        "Iterator delivery and page caps are SDK traversal policy; only the derived page limit and cursor reach provider queries",
        "src/internal/pagination.ts:prepare",
        paginationEvidence,
    ),
])
