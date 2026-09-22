import {
    defineFieldRules,
    defineLocalFieldExclusions,
    type FieldRuleAnnotation,
} from "./conformance-fields-registry.js"

type RuleOptions = Readonly<{
    default?: FieldRuleAnnotation["default"]
    length?: FieldRuleAnnotation["length"]
    normalization?: FieldRuleAnnotation["normalization"]
}>

const omitted = { kind: "omitted", detail: "An absent optional property is not serialized" } as const
const required = { kind: "none", detail: "The field is required and has no SDK or provider default" } as const
const unavailable = {
    kind: "omitted",
    detail: "The decoder preserves provider absence instead of substituting a creation or scalar default",
} as const
const observed = { kind: "none", detail: "A valid provider observation must supply this field" } as const
const owningContext = {
    kind: "none",
    detail: "The SDK supplies the validated owning-guild context; no scalar default is substituted",
} as const
const scalar = {
    kind: "not-applicable",
    detail: "No field-specific length bound applies or the pinned provider contract publishes none",
} as const
const preserved = { kind: "preserved", detail: "The SDK preserves the validated field value" } as const

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
        default: options.default ?? (direction === "request" ? omitted : observed),
        length: options.length ?? scalar,
        normalization: options.normalization ?? preserved,
        executableEvidence,
    }
}

const guildRequestOwner = "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildUpdateRequest" as const
const memberRequestOwner = "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildMemberUpdateRequest" as const
const roleRequestOwner = "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildRoleCreateRequest" as const
const channelRequestOwner = "packages/schema/src/domains/channel/ChannelRequestSchemas.ts:ChannelCreateRequest" as const
const auditRequestOwner = "packages/schema/src/domains/guild/GuildAuditLogSchemas.ts:GuildAuditLogListQuery" as const
const expressionRequestOwner =
    "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildEmojiCreateRequest" as const
const inviteRequestOwner = "packages/schema/src/domains/invite/InviteSchemas.ts:ChannelInviteCreateRequest" as const

const guildResponseOwner = "packages/schema/src/domains/guild/GuildResponseSchemas.ts:GuildResponse" as const
const memberResponseOwner = "packages/schema/src/domains/guild/GuildMemberSchemas.ts:GuildMemberResponse" as const
const banResponseOwner = "packages/schema/src/domains/guild/GuildMemberSchemas.ts:GuildBanResponse" as const
const roleResponseOwner = "packages/schema/src/domains/guild/GuildRoleSchemas.ts:GuildRoleResponse" as const
const channelResponseOwner = "packages/schema/src/domains/channel/ChannelSchemas.ts:ChannelResponse" as const
const auditResponseOwner =
    "packages/schema/src/domains/guild/GuildAuditLogSchemas.ts:GuildAuditLogListResponse" as const
const expressionResponseOwner = "packages/schema/src/domains/guild/GuildEmojiSchemas.ts:GuildEmojiResponse" as const
const inviteResponseOwner = "packages/schema/src/domains/invite/InviteSchemas.ts:InviteResponseSchema" as const

const guildEvidence = ["tests/guilds.test.ts", "tests/guild-settings.test.ts", "tests/text-validation.test.ts"] as const
const memberEvidence = [
    "tests/guilds.test.ts",
    "tests/member-profile.test.ts",
    "tests/text-validation.test.ts",
] as const
const roleEvidence = ["tests/guilds.test.ts", "tests/text-validation.test.ts"] as const
const moderationEvidence = ["tests/guilds.test.ts"] as const
const vanityEvidence = ["tests/vanity-url.test.ts"] as const
const channelEvidence = ["tests/channels.test.ts", "tests/text-validation.test.ts"] as const
const auditHeaderEvidence = ["tests/guilds.test.ts", "tests/channels.test.ts", "tests/expressions.test.ts"] as const
const auditEvidence = ["tests/audit-logs.test.ts", "tests/audit-pagination.test.ts"] as const
const gatewayAuditEvidence = ["tests/administrative-events.test.ts"] as const
const expressionEvidence = [
    "tests/expressions.test.ts",
    "tests/expression-events.test.ts",
    "tests/text-validation.test.ts",
] as const
const inviteEvidence = ["tests/invites.test.ts", "tests/administrative-events.test.ts"] as const

const normalizedText = (minimum: number, maximum: number): RuleOptions => ({
    length: {
        kind: "bounded",
        unit: "UTF-16-code-units",
        minimum,
        maximum,
        detail: "The bound applies to the provider-normalized validation view",
    },
    normalization: {
        kind: "provider-normalized-view",
        detail: "Validation removes U+000C and U+202E and trims outer whitespace without rewriting serialized text",
    },
})

const requestRules: FieldRuleAnnotation[] = [
    rule(
        "GuildEdit.name",
        "request",
        guildRequestOwner,
        "src/internal/guild-settings.ts:guildEdit",
        guildEvidence,
        normalizedText(1, 100),
    ),
    ...["GuildEdit.systemChannelId", "GuildEdit.afkChannelId", "GuildEdit.nsfw", "GuildEdit.messageHistoryCutoff"].map(
        (target) =>
            rule(target, "request", guildRequestOwner, "src/internal/guild-settings.ts:guildEdit", guildEvidence),
    ),
    ...["GuildEdit.icon", "GuildEdit.banner", "GuildEdit.splash", "GuildEdit.embedSplash"].map((target) =>
        rule(target, "request", guildRequestOwner, "src/internal/guild-settings.ts:guildEdit", guildEvidence, {
            length: {
                kind: "bounded",
                unit: "bytes",
                minimum: 1,
                maximum: 10_485_760,
                detail: "The pinned provider schema bounds decoded image data at 10 MiB; the SDK also validates the data-URI format and its stricter total request-byte budget",
            },
        }),
    ),
    rule(
        "GuildEdit.afkTimeoutSeconds",
        "request",
        guildRequestOwner,
        "src/internal/guild-settings.ts:guildEdit",
        guildEvidence,
        {
            length: {
                kind: "bounded",
                unit: "seconds",
                minimum: 60,
                maximum: 3600,
                detail: "Fluxer accepts integer AFK timeouts in this inclusive range",
            },
        },
    ),
    ...[
        "GuildEdit.systemChannelFlags",
        "GuildEdit.defaultMessageNotifications",
        "GuildEdit.verificationLevel",
        "GuildEdit.contentWarningLevel",
        "GuildEdit.explicitContentFilter",
        "GuildEdit.splashCardAlignment",
    ].map((target) =>
        rule(target, "request", guildRequestOwner, "src/internal/guild-settings.ts:guildEdit", guildEvidence),
    ),
    rule(
        "GuildEdit.contentWarningText",
        "request",
        guildRequestOwner,
        "src/internal/guild-settings.ts:guildEdit",
        guildEvidence,
        {
            length: {
                kind: "bounded",
                unit: "UTF-16-code-units",
                minimum: 0,
                maximum: 200,
                detail: "The raw nullable warning text is bounded before serialization",
            },
        },
    ),
    rule(
        "GuildEdit.featureToggles",
        "request",
        guildRequestOwner,
        "src/internal/guild-settings.ts:guildEdit",
        guildEvidence,
        {
            length: {
                kind: "bounded",
                unit: "items",
                maximum: 6,
                detail: "The SDK accepts each supported toggle at most once",
            },
        },
    ),
    rule(
        "MemberProfileEdit.nickname",
        "request",
        memberRequestOwner,
        "src/internal/guilds.ts:memberEditSelf",
        memberEvidence,
        {
            length: {
                kind: "bounded",
                unit: "UTF-16-code-units",
                minimum: 1,
                maximum: 32,
                detail: "Nonblank nicknames use the provider-normalized bound; nonempty trim-blank text is a clear value",
            },
            normalization: {
                kind: "provider-normalized-view",
                detail: "Validation uses member-nickname preprocessing without rewriting the serialized value",
            },
        },
    ),
    ...["MemberProfileEdit.avatar", "MemberProfileEdit.banner"].map((target) =>
        rule(target, "request", memberRequestOwner, "src/internal/guilds.ts:memberEditSelf", memberEvidence, {
            length: {
                kind: "bounded",
                unit: "bytes",
                minimum: 1,
                maximum: 10_485_760,
                detail: "The pinned provider schema bounds decoded image data at 10 MiB; the SDK also validates the data-URI format and its stricter total request-byte budget",
            },
        }),
    ),
    ...["MemberProfileEdit.accentColor", "MemberProfileEdit.profileFlags", "MemberProfileEdit.mentionFlags"].map(
        (target) =>
            rule(target, "request", memberRequestOwner, "src/internal/guilds.ts:memberEditSelf", memberEvidence),
    ),
    ...["MemberReference.guildId", "MemberReference.userId", "PermissionTarget.guildId", "PermissionTarget.userId"].map(
        (target) =>
            rule(target, "request", memberRequestOwner, "src/internal/guilds.ts:memberFetch", memberEvidence, {
                default: required,
            }),
    ),
    rule(
        "VoiceConnectionReference.connectionId",
        "request",
        memberRequestOwner,
        "src/internal/moderation.ts:voiceConnectionId",
        moderationEvidence,
        normalizedText(1, 32),
    ),
    ...["VoiceConnectionReference.guildId", "VoiceConnectionReference.userId"].map((target) =>
        rule(
            target,
            "request",
            memberRequestOwner,
            "src/internal/moderation.ts:voiceConnectionId",
            moderationEvidence,
            {
                default: required,
            },
        ),
    ),
    rule(
        "MemberQuery.limit",
        "request",
        "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildMemberListQuery",
        "src/internal/guilds.ts:memberPage",
        memberEvidence,
        {
            default: { kind: "value", value: "100", detail: "The SDK supplies 100 when the public option is absent" },
            length: {
                kind: "bounded",
                unit: "items",
                minimum: 1,
                maximum: 1000,
                detail: "The page size is an inclusive integer item bound",
            },
        },
    ),
    rule(
        "MemberQuery.after",
        "request",
        "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildMemberListQuery",
        "src/internal/guilds.ts:memberPage",
        memberEvidence,
    ),
    rule(
        "GuildListQuery.limit",
        "request",
        "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildListQuery",
        "src/internal/guild-lifecycle.ts:guildList",
        guildEvidence,
        {
            default: { kind: "value", value: "200", detail: "The SDK and provider use 200 when the option is absent" },
            length: {
                kind: "bounded",
                unit: "items",
                minimum: 1,
                maximum: 200,
                detail: "The page size is an inclusive integer item bound",
            },
        },
    ),
    ...["GuildListQuery.before", "GuildListQuery.after"].map((target) =>
        rule(
            target,
            "request",
            "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildListQuery",
            "src/internal/guild-lifecycle.ts:guildList",
            guildEvidence,
        ),
    ),
    rule(
        "GuildListQuery.withCounts",
        "request",
        "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildListQuery",
        "src/internal/guild-lifecycle.ts:guildList",
        guildEvidence,
        {
            default: {
                kind: "value",
                value: "false",
                detail: "The SDK always serializes false when the public option is absent",
            },
        },
    ),
    rule("RoleCreate.color", "request", roleRequestOwner, "src/internal/guilds.ts:roleBody", roleEvidence, {
        default: { kind: "value", value: "0", detail: "The SDK serializes zero for an omitted role color" },
    }),
    rule("RoleCreate.permissions", "request", roleRequestOwner, "src/internal/guilds.ts:roleBody", roleEvidence, {
        default: {
            kind: "value",
            value: "0n",
            detail: "The SDK serializes zero grants rather than inheriting everyone-role grants",
        },
        normalization: {
            kind: "canonicalized",
            detail: "The public bigint is serialized as the provider decimal permission string",
        },
    }),
    ...["RoleEdit.color", "RoleEdit.hoist", "RoleEdit.hoistPosition", "RoleEdit.mentionable"].map((target) =>
        rule(
            target,
            "request",
            "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildRoleUpdateRequest",
            "src/internal/guilds.ts:roleBody",
            roleEvidence,
        ),
    ),
    rule(
        "RoleEdit.permissions",
        "request",
        "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildRoleUpdateRequest",
        "src/internal/guilds.ts:roleBody",
        roleEvidence,
        {
            normalization: {
                kind: "canonicalized",
                detail: "The public bigint is serialized as the provider decimal permission string",
            },
        },
    ),
    ...["RoleReference.guildId", "RoleReference.id"].map((target) =>
        rule(target, "request", roleRequestOwner, "src/internal/guilds.ts:roleEdit", roleEvidence, {
            default: required,
        }),
    ),
    rule(
        "RolePosition.id",
        "request",
        "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildRolePositionsRequest",
        "src/internal/guilds.ts:roleReorder",
        roleEvidence,
        { default: required },
    ),
    rule(
        "RolePosition.position",
        "request",
        "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildRolePositionsRequest",
        "src/internal/guilds.ts:roleReorder",
        roleEvidence,
        { default: required },
    ),
    ...["RoleHoistPosition.id", "RoleHoistPosition.hoistPosition"].map((target) =>
        rule(
            target,
            "request",
            "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildRoleHoistPositionsRequest",
            "src/internal/guilds.ts:roleSetHoistPositions",
            roleEvidence,
            { default: required },
        ),
    ),
    rule(
        "BanInput.reason",
        "request",
        "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildBanCreateRequest",
        "src/internal/moderation.ts:guildBan",
        moderationEvidence,
        {
            ...normalizedText(0, 512),
            default: {
                kind: "omitted",
                detail: "Omission leaves the JSON reason absent; provider audit metadata can still record the separate auditReason header",
            },
        },
    ),
    rule(
        "BanInput.durationSeconds",
        "request",
        "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildBanCreateRequest",
        "src/internal/moderation.ts:guildBan",
        moderationEvidence,
        {
            default: { kind: "value", value: "0", detail: "Omission requests a permanent ban" },
            length: {
                kind: "bounded",
                unit: "seconds",
                minimum: 0,
                maximum: 63_072_000,
                detail: "Zero is permanent; nonzero duration must also be at least 60 seconds",
            },
        },
    ),
    rule(
        "BanInput.deleteMessageSeconds",
        "request",
        "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildBanCreateRequest",
        "src/internal/moderation.ts:guildBan",
        moderationEvidence,
        {
            default: { kind: "value", value: "0", detail: "Omission requests no message deletion" },
            length: {
                kind: "bounded",
                unit: "seconds",
                minimum: 0,
                maximum: 604_800,
                detail: "The destructive deletion window uses inclusive integer seconds",
            },
        },
    ),
    rule(
        "DefaultTimeoutOptions.timeoutReason",
        "request",
        memberRequestOwner,
        "src/internal/moderation.ts:memberTimeout",
        moderationEvidence,
        normalizedText(1, 512),
    ),
    ...[
        "DefaultGuildAuditOperationOptions.auditReason",
        "DefaultModerationOptions.auditReason",
        "DefaultTimeoutOptions.auditReason",
        "DefaultExpressionDeleteOptions.auditReason",
    ].map((target) =>
        rule(
            target,
            "request",
            "packages/schema/src/primitives/ChannelValidators.ts:AuditLogReasonType",
            "src/internal/audit.ts:auditSettings",
            auditHeaderEvidence,
            {
                length: {
                    kind: "bounded",
                    unit: "bytes",
                    minimum: 1,
                    maximum: 512,
                    detail: "Trimmed printable ASCII is one byte per character and is sent as a raw header",
                },
                normalization: {
                    kind: "canonicalized",
                    detail: "The SDK trims surrounding whitespace before sending the audit-log header",
                },
            },
        ),
    ),
    rule(
        "ChannelCreate.name",
        "request",
        channelRequestOwner,
        "src/internal/channels.ts:validateOptionalFields",
        channelEvidence,
        {
            default: required,
            length: {
                kind: "bounded",
                unit: "UTF-16-code-units",
                minimum: 1,
                maximum: 100,
                detail: "The provider-normalized view is 1 through 100 and raw input is capped at 10,000",
            },
            normalization: {
                kind: "provider-normalized-view",
                detail: "General channel-name preprocessing is validation-only; the original string is serialized",
            },
        },
    ),
    rule(
        "ChannelEdit.name",
        "request",
        "packages/schema/src/domains/channel/ChannelRequestSchemas.ts:ChannelUpdateRequestBody",
        "src/internal/channels.ts:validateOptionalFields",
        channelEvidence,
        {
            length: {
                kind: "bounded",
                unit: "UTF-16-code-units",
                minimum: 1,
                maximum: 100,
                detail: "The provider-normalized view is 1 through 100 and raw input is capped at 10,000",
            },
            normalization: {
                kind: "provider-normalized-view",
                detail: "General channel-name preprocessing is validation-only; the original string is serialized",
            },
        },
    ),
    ...["ChannelCreate.topic", "ChannelEdit.topic"].map((target) =>
        rule(
            target,
            "request",
            channelRequestOwner,
            "src/internal/channels.ts:validateOptionalFields",
            channelEvidence,
            normalizedText(1, 1024),
        ),
    ),
    ...["ChannelCreate.contentWarningText", "ChannelEdit.contentWarningText"].map((target) =>
        rule(
            target,
            "request",
            channelRequestOwner,
            "src/internal/channels.ts:validateOptionalFields",
            channelEvidence,
            {
                length: {
                    kind: "bounded",
                    unit: "UTF-16-code-units",
                    minimum: 0,
                    maximum: 200,
                    detail: "The raw nullable warning text is bounded without normalization",
                },
            },
        ),
    ),
    rule(
        "ChannelEdit.rtcRegion",
        "request",
        channelRequestOwner,
        "src/internal/channels.ts:validateOptionalFields",
        channelEvidence,
        normalizedText(1, 64),
    ),
    ...["ChannelCreate.type"].map((target) =>
        rule(target, "request", channelRequestOwner, "src/internal/channels.ts:channelBody", channelEvidence, {
            default: required,
        }),
    ),
    ...[
        "ChannelCreate.url",
        "ChannelCreate.parentId",
        "ChannelCreate.nsfw",
        "ChannelCreate.nsfwOverride",
        "ChannelCreate.contentWarningLevel",
        "ChannelEdit.url",
        "ChannelEdit.nsfw",
        "ChannelEdit.nsfwOverride",
        "ChannelEdit.contentWarningLevel",
    ].map((target) =>
        rule(target, "request", channelRequestOwner, "src/internal/channels.ts:channelBody", channelEvidence),
    ),
    ...["ChannelCreate.bitrate", "ChannelEdit.bitrate"].map((target) =>
        rule(
            target,
            "request",
            channelRequestOwner,
            "src/internal/channels.ts:validateOptionalFields",
            channelEvidence,
            {
                default: target.startsWith("ChannelCreate")
                    ? { kind: "provider", detail: "Fluxer applies the voice-channel default when omitted" }
                    : omitted,
                length: {
                    kind: "bounded",
                    unit: "items",
                    minimum: 8000,
                    maximum: 384000,
                    detail: "The integer bitrate is measured in bits per second and then capped by the guild tier",
                },
            },
        ),
    ),
    ...["ChannelCreate.userLimit", "ChannelEdit.userLimit"].map((target) =>
        rule(
            target,
            "request",
            channelRequestOwner,
            "src/internal/channels.ts:validateOptionalFields",
            channelEvidence,
            {
                default: target.startsWith("ChannelCreate")
                    ? { kind: "provider", detail: "Fluxer applies the voice-channel default when omitted" }
                    : omitted,
                length: {
                    kind: "bounded",
                    unit: "items",
                    minimum: 0,
                    maximum: 99,
                    detail: "Zero requests unlimited users",
                },
            },
        ),
    ),
    ...["ChannelCreate.voiceConnectionLimit", "ChannelEdit.voiceConnectionLimit"].map((target) =>
        rule(
            target,
            "request",
            channelRequestOwner,
            "src/internal/channels.ts:validateOptionalFields",
            channelEvidence,
            {
                default: target.startsWith("ChannelCreate")
                    ? { kind: "provider", detail: "Fluxer applies five for a voice channel when omitted" }
                    : omitted,
                length: {
                    kind: "bounded",
                    unit: "items",
                    minimum: 1,
                    maximum: 100,
                    detail: "The bound counts simultaneous connections per user",
                },
            },
        ),
    ),
    ...["ChannelCreate.rateLimitPerUser", "ChannelEdit.rateLimitPerUser"].map((target) =>
        rule(
            target,
            "request",
            channelRequestOwner,
            "src/internal/channels.ts:validateOptionalFields",
            channelEvidence,
            {
                length: {
                    kind: "bounded",
                    unit: "seconds",
                    minimum: 0,
                    maximum: 21600,
                    detail: "Zero disables per-user slowmode",
                },
            },
        ),
    ),
    ...["ChannelCreate.permissionOverwrites", "ChannelEdit.permissionOverwrites"].map((target) =>
        rule(
            target,
            "request",
            channelRequestOwner,
            "src/internal/channels.ts:validateOptionalFields",
            channelEvidence,
            {
                length: {
                    kind: "not-applicable",
                    detail: "No per-field overwrite count is invented; the encoded request instead has a 4,194,304-byte body limit",
                },
            },
        ),
    ),
    rule(
        "PermissionOverwrite.id",
        "request",
        "packages/schema/src/domains/channel/ChannelRequestSchemas.ts:ChannelOverwriteRequest",
        "src/internal/channels.ts:permissionSetBody",
        channelEvidence,
        { default: required },
    ),
    ...["PermissionOverwrite.type", "PermissionOverwrite.allow", "PermissionOverwrite.deny"].map((target) =>
        rule(
            target,
            "request",
            "packages/schema/src/domains/channel/ChannelRequestSchemas.ts:ChannelOverwriteRequest",
            "src/internal/channels.ts:permissionSetBody",
            channelEvidence,
            {
                default: required,
                normalization: {
                    kind: "canonicalized",
                    detail: target.endsWith(".type")
                        ? "The public role/member discriminator is serialized as provider value 0/1"
                        : "The public bigint is serialized as a provider decimal permission string",
                },
            },
        ),
    ),
    rule(
        "ChannelPosition.id",
        "request",
        "packages/schema/src/domains/channel/ChannelRequestSchemas.ts:ChannelPositionUpdateRequest",
        "src/internal/channels.ts:channelPositionBody",
        channelEvidence,
        { default: required },
    ),
    ...["ChannelPosition.position", "ChannelPosition.parentId", "ChannelPosition.precedingSiblingId"].map((target) =>
        rule(
            target,
            "request",
            "packages/schema/src/domains/channel/ChannelRequestSchemas.ts:ChannelPositionUpdateRequest",
            "src/internal/channels.ts:channelPositionBody",
            channelEvidence,
        ),
    ),
    rule(
        "ChannelPosition.syncPermissionsOnMove",
        "request",
        "packages/schema/src/domains/channel/ChannelRequestSchemas.ts:ChannelPositionUpdateRequest",
        "src/internal/channels.ts:channelPositionBody",
        channelEvidence,
        {
            default: omitted,
        },
    ),
    rule(
        "DefaultChannelAuditOperationOptions.auditReason",
        "request",
        "packages/schema/src/primitives/ChannelValidators.ts:AuditLogReasonType",
        "src/internal/audit.ts:auditSettings",
        channelEvidence,
        {
            length: {
                kind: "bounded",
                unit: "bytes",
                minimum: 1,
                maximum: 512,
                detail: "Trimmed printable ASCII is one byte per character and is sent as a raw header",
            },
            normalization: {
                kind: "canonicalized",
                detail: "The SDK trims surrounding whitespace before sending the audit-log header",
            },
        },
    ),
    ...["AuditLogQuery.limit"].map((target) =>
        rule(target, "request", auditRequestOwner, "src/internal/audit-logs.ts:encodeQuery", auditEvidence, {
            default: { kind: "value", value: "50", detail: "The SDK serializes a page size of 50 when omitted" },
            length: {
                kind: "bounded",
                unit: "items",
                minimum: 1,
                maximum: 100,
                detail: "The provider page-size bound is inclusive",
            },
        }),
    ),
    ...[
        "AuditLogQuery.before",
        "AuditLogQuery.after",
        "AuditLogQuery.userId",
        "AuditLogQuery.actionType",
        "AuditLogIterationQuery.before",
        "AuditLogIterationQuery.userId",
        "AuditLogIterationQuery.actionType",
    ].map((target) =>
        rule(target, "request", auditRequestOwner, "src/internal/audit-logs.ts:encodeQuery", auditEvidence),
    ),
    ...["ExpressionReference.guildId", "ExpressionReference.id"].map((target) =>
        rule(
            target,
            "request",
            expressionRequestOwner,
            "src/internal/expressions.ts:expressionEdit",
            expressionEvidence,
            { default: required },
        ),
    ),
    ...["EmojiCreate.name", "EmojiEdit.name"].map((target) =>
        rule(target, "request", expressionRequestOwner, "src/internal/expressions.ts:encode", expressionEvidence, {
            default: required,
            length: {
                kind: "bounded",
                unit: "UTF-16-code-units",
                minimum: 2,
                maximum: 32,
                detail: "Only ASCII letters, digits and underscores are accepted",
            },
        }),
    ),
    ...["EmojiCreate.image", "StickerCreate.image"].map((target) =>
        rule(target, "request", expressionRequestOwner, "src/internal/expressions.ts:encode", expressionEvidence, {
            default: required,
            length: {
                kind: "bounded",
                unit: "bytes",
                minimum: 1,
                maximum: 524288,
                detail: "The decoded base64 payload may contain at most 512 KiB",
            },
        }),
    ),
    ...["StickerCreate.name", "StickerEdit.name"].map((target) =>
        rule(
            target,
            "request",
            "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildStickerCreateRequest",
            "src/internal/expressions.ts:encode",
            expressionEvidence,
            { ...normalizedText(2, 30), default: required },
        ),
    ),
    rule(
        "StickerCreate.description",
        "request",
        "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildStickerCreateRequest",
        "src/internal/expressions.ts:encode",
        expressionEvidence,
        {
            ...normalizedText(1, 500),
            default: {
                kind: "value",
                value: "null",
                detail: "The SDK serializes null when the optional description is absent",
            },
        },
    ),
    rule(
        "StickerEdit.description",
        "request",
        "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildStickerUpdateRequest",
        "src/internal/expressions.ts:expressionEdit",
        expressionEvidence,
        {
            default: required,
            length: {
                kind: "bounded",
                unit: "UTF-16-code-units",
                minimum: 1,
                maximum: 500,
                detail: "The bound applies to nonempty provider-normalized text; null and empty input clear the description",
            },
            normalization: {
                kind: "canonicalized",
                detail: "An empty edit string is serialized as null; nonempty text is validation-normalized without rewriting",
            },
        },
    ),
    ...["StickerCreate.tags", "StickerEdit.tags"].map((target) =>
        rule(
            target,
            "request",
            "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildStickerCreateRequest",
            "src/internal/expressions.ts:encode",
            expressionEvidence,
            {
                default: target.startsWith("StickerCreate")
                    ? { kind: "value", value: "[]", detail: "The SDK serializes an empty list when omitted" }
                    : required,
                length: {
                    kind: "bounded",
                    unit: "items",
                    minimum: 0,
                    maximum: 10,
                    detail: "Every tag also has a provider-normalized 1 through 30 UTF-16-unit bound",
                },
                normalization: {
                    kind: "provider-normalized-view",
                    detail: "Each tag is validated through provider text preprocessing without rewriting the serialized entry",
                },
            },
        ),
    ),
    rule(
        "DefaultExpressionDeleteOptions.purge",
        "request",
        "packages/schema/src/domains/common/CommonQuerySchemas.ts:PurgeQuery",
        "src/internal/expressions.ts:expressionDelete",
        expressionEvidence,
        {
            default: { kind: "value", value: "false", detail: "Omission does not enqueue image-asset purging" },
        },
    ),
    rule(
        "InviteCreate.maxAgeSeconds",
        "request",
        inviteRequestOwner,
        "src/internal/invites.ts:inviteCreate",
        inviteEvidence,
        {
            default: {
                kind: "value",
                value: "86400",
                detail: "The SDK deliberately supplies one day instead of the provider schema's zero default",
            },
            length: {
                kind: "bounded",
                unit: "seconds",
                minimum: 0,
                maximum: 604800,
                detail: "Zero requests no expiry",
            },
        },
    ),
    rule(
        "InviteCreate.maxUses",
        "request",
        inviteRequestOwner,
        "src/internal/invites.ts:inviteCreate",
        inviteEvidence,
        {
            default: { kind: "value", value: "0", detail: "Zero means unlimited uses until expiry" },
            length: {
                kind: "bounded",
                unit: "items",
                minimum: 0,
                maximum: 100,
                detail: "The maximum-use bound is inclusive",
            },
        },
    ),
    rule("InviteCreate.unique", "request", inviteRequestOwner, "src/internal/invites.ts:inviteCreate", inviteEvidence, {
        default: {
            kind: "value",
            value: "true",
            detail: "The SDK deliberately requests a new code instead of the provider schema's false default",
        },
    }),
    rule(
        "InviteCreate.temporary",
        "request",
        inviteRequestOwner,
        "src/internal/invites.ts:inviteCreate",
        inviteEvidence,
        {
            default: { kind: "value", value: "false", detail: "Omission requests ordinary membership" },
        },
    ),
]

const responseRules: FieldRuleAnnotation[] = [
    ...["Guild", "GuildListSummary"].flatMap((type) => [
        ...["id", "name", "ownerId", "features"].map((field) =>
            rule(
                `${type}.${field}`,
                "response",
                guildResponseOwner,
                "src/internal/guilds.ts:decodeGuild",
                guildEvidence,
            ),
        ),
        ...[
            "icon",
            "banner",
            "splash",
            "embedSplash",
            "splashCardAlignment",
            "systemChannelId",
            "systemChannelFlags",
            "afkChannelId",
            "afkTimeoutSeconds",
            "defaultMessageNotifications",
            "verificationLevel",
            "nsfw",
            "contentWarningLevel",
            "contentWarningText",
            "explicitContentFilter",
            "messageHistoryCutoff",
        ].map((field) =>
            rule(
                `${type}.${field}`,
                "response",
                guildResponseOwner,
                "src/internal/guilds.ts:decodeGuild",
                guildEvidence,
                { default: unavailable },
            ),
        ),
    ]),
    rule(
        "GuildListSummary.permissions",
        "response",
        guildResponseOwner,
        "src/internal/guild-lifecycle.ts:decodeGuildListSummary",
        guildEvidence,
        {
            default: unavailable,
            normalization: {
                kind: "canonicalized",
                detail: "The provider decimal permission string is exposed as an unsigned bigint",
            },
        },
    ),
    ...["GuildListSummary.approximateMemberCount", "GuildListSummary.approximatePresenceCount"].map((target) =>
        rule(
            target,
            "response",
            guildResponseOwner,
            "src/internal/guild-lifecycle.ts:decodeGuildListSummary",
            guildEvidence,
            { default: unavailable },
        ),
    ),
    rule(
        "GuildMember.guildId",
        "response",
        memberResponseOwner,
        "src/internal/guilds.ts:decodeMember",
        memberEvidence,
        {
            default: owningContext,
            normalization: {
                kind: "canonicalized",
                detail: "The validated owning guild ID is attached from operation or event context",
            },
        },
    ),
    ...["GuildMember.userId", "GuildMember.username", "GuildMember.joinedAt"].map((target) =>
        rule(target, "response", memberResponseOwner, "src/internal/guilds.ts:decodeMember", memberEvidence),
    ),
    rule(
        "GuildMember.roleIds",
        "response",
        memberResponseOwner,
        "src/internal/guilds.ts:decodeMember",
        memberEvidence,
        {
            length: {
                kind: "bounded",
                unit: "items",
                maximum: 250,
                detail: "The decoder rejects oversized or duplicate explicit role-ID collections",
            },
        },
    ),
    rule("GuildMember.isBot", "response", memberResponseOwner, "src/internal/guilds.ts:decodeMember", memberEvidence, {
        default: { kind: "value", value: "false", detail: "An omitted provider bot marker decodes to false" },
    }),
    ...[
        "GuildMember.communicationDisabledUntil",
        "GuildMember.nickname",
        "GuildMember.avatar",
        "GuildMember.banner",
        "GuildMember.accentColor",
        "GuildMember.profileFlags",
        "GuildMember.mentionFlags",
        "GuildMember.isMuted",
        "GuildMember.isDeafened",
    ].map((target) =>
        rule(target, "response", memberResponseOwner, "src/internal/guilds.ts:decodeMember", memberEvidence, {
            default: unavailable,
        }),
    ),
    rule("GuildBan.guildId", "response", banResponseOwner, "src/internal/moderation.ts:guildBans", moderationEvidence, {
        default: owningContext,
        normalization: {
            kind: "canonicalized",
            detail: "The validated guild ID is attached from the ban-list operation context",
        },
    }),
    ...["GuildBan.userId", "GuildBan.username", "GuildBan.moderatorId", "GuildBan.bannedAt"].map((target) =>
        rule(target, "response", banResponseOwner, "src/internal/moderation.ts:guildBans", moderationEvidence),
    ),
    rule("GuildBan.isBot", "response", banResponseOwner, "src/internal/moderation.ts:guildBans", moderationEvidence, {
        default: { kind: "value", value: "false", detail: "An omitted provider bot marker decodes to false" },
    }),
    ...["GuildBan.reason", "GuildBan.expiresAt"].map((target) =>
        rule(target, "response", banResponseOwner, "src/internal/moderation.ts:guildBans", moderationEvidence, {
            default: unavailable,
        }),
    ),
    ...[
        "GuildRole.id",
        "GuildRole.name",
        "GuildRole.color",
        "GuildRole.position",
        "GuildRole.hoist",
        "GuildRole.mentionable",
    ].map((target) => rule(target, "response", roleResponseOwner, "src/internal/guilds.ts:decodeRole", roleEvidence)),
    rule("GuildRole.guildId", "response", roleResponseOwner, "src/internal/guilds.ts:decodeRole", roleEvidence, {
        default: owningContext,
        normalization: {
            kind: "canonicalized",
            detail: "The validated owning guild ID is attached from operation or event context",
        },
    }),
    rule("GuildRole.permissions", "response", roleResponseOwner, "src/internal/guilds.ts:decodeRole", roleEvidence, {
        normalization: {
            kind: "canonicalized",
            detail: "The provider decimal permission string is exposed as an unsigned bigint",
        },
    }),
    ...["GuildRole.hoistPosition", "GuildRole.unicodeEmoji"].map((target) =>
        rule(target, "response", roleResponseOwner, "src/internal/guilds.ts:decodeRole", roleEvidence, {
            default: unavailable,
        }),
    ),
    ...["GuildVanityUrl.code", "GuildVanityUrlUsage.code"].map((target) =>
        rule(
            target,
            "response",
            "packages/schema/src/domains/guild/GuildResponseSchemas.ts:GuildVanityURLResponse",
            "src/internal/vanity-url.ts:decode",
            vanityEvidence,
            {
                length: {
                    kind: "bounded",
                    unit: "UTF-16-code-units",
                    minimum: 2,
                    maximum: 32,
                    detail: "A non-null code is lowercase alphanumeric text with single separating hyphens",
                },
            },
        ),
    ),
    rule(
        "GuildVanityUrlUsage.uses",
        "response",
        "fluxer_api/src/api/guild/services/data/GuildVanityService.ts:getVanityURL",
        "src/internal/vanity-url.ts:decode",
        vanityEvidence,
        {
            length: {
                kind: "bounded",
                unit: "items",
                minimum: 0,
                maximum: 2_147_483_647,
                detail: "The observed use count is a nonnegative signed 32-bit integer",
            },
        },
    ),
    ...["GuildChannel.id", "GuildChannel.guildId", "GuildChannel.type"].map((target) =>
        rule(target, "response", channelResponseOwner, "src/internal/channels.ts:decodeGuildChannel", channelEvidence),
    ),
    ...[
        "GuildChannel.name",
        "GuildChannel.topic",
        "GuildChannel.url",
        "GuildChannel.position",
        "GuildChannel.parentId",
        "GuildChannel.bitrate",
        "GuildChannel.userLimit",
        "GuildChannel.voiceConnectionLimit",
        "GuildChannel.rtcRegion",
        "GuildChannel.lastMessageId",
        "GuildChannel.lastPinTimestamp",
        "GuildChannel.permissionOverwrites",
        "GuildChannel.nsfw",
        "GuildChannel.nsfwOverride",
        "GuildChannel.contentWarningLevel",
        "GuildChannel.rateLimitPerUser",
    ].map((target) =>
        rule(target, "response", channelResponseOwner, "src/internal/channels.ts:decodeGuildChannel", channelEvidence, {
            default: unavailable,
        }),
    ),
    rule(
        "GuildChannel.contentWarningText",
        "response",
        channelResponseOwner,
        "src/internal/channels.ts:decodeGuildChannel",
        channelEvidence,
        {
            default: unavailable,
            length: {
                kind: "bounded",
                unit: "UTF-16-code-units",
                minimum: 0,
                maximum: 200,
                detail: "The nullable provider warning text is checked against its raw response bound",
            },
        },
    ),
    rule(
        "PermissionOverwrite.id",
        "response",
        "packages/schema/src/domains/channel/ChannelSchemas.ts:ChannelOverwriteResponse",
        "src/internal/channels.ts:decodeOverwrite",
        channelEvidence,
    ),
    ...["PermissionOverwrite.allow", "PermissionOverwrite.deny"].map((target) =>
        rule(
            target,
            "response",
            "packages/schema/src/domains/channel/ChannelSchemas.ts:ChannelOverwriteResponse",
            "src/internal/channels.ts:decodeOverwrite",
            channelEvidence,
            {
                normalization: {
                    kind: "canonicalized",
                    detail: "The provider decimal permission string is exposed as an unsigned bigint",
                },
            },
        ),
    ),
    rule(
        "PermissionOverwrite.type",
        "response",
        "packages/schema/src/domains/channel/ChannelSchemas.ts:ChannelOverwriteResponse",
        "src/internal/channels.ts:decodeOverwrite",
        channelEvidence,
        {
            normalization: {
                kind: "canonicalized",
                detail: "The provider numeric overwrite discriminator is exposed as role or member",
            },
        },
    ),
    rule(
        "ChannelLinkTarget.id",
        "response",
        "packages/schema/src/domains/channel/ChannelSchemas.ts:ChannelPartialResponse",
        "src/helpers.ts:channelLink",
        ["tests/helpers.test.ts"],
    ),
    rule(
        "ChannelLinkTarget.guildId",
        "response",
        "packages/schema/src/domains/channel/ChannelSchemas.ts:ChannelPartialResponse",
        "src/helpers.ts:channelLink",
        ["tests/helpers.test.ts"],
        {
            default: {
                kind: "omitted",
                detail: "Absence selects the direct-message route instead of substituting a guild ID",
            },
        },
    ),
    ...["AuditLogChange.key"].map((target) =>
        rule(target, "response", auditResponseOwner, "src/internal/audit-logs.ts:changes", auditEvidence),
    ),
    ...["AuditLogChange.oldValue", "AuditLogChange.newValue"].map((target) =>
        rule(target, "response", auditResponseOwner, "src/internal/audit-logs.ts:changes", auditEvidence, {
            default: unavailable,
        }),
    ),
    ...["AuditLogChangeValue.added", "AuditLogChangeValue.removed"].map((target) =>
        rule(
            target,
            "response",
            "packages/schema/src/domains/guild/GuildAuditLogSchemas.ts:AuditLogChangeSchema",
            "src/internal/audit-logs.ts:changeValue",
            auditEvidence,
            { default: unavailable },
        ),
    ),
    ...["AuditLogEntry.id", "AuditLogEntry.actionType"].map((target) =>
        rule(target, "response", auditResponseOwner, "src/internal/audit-logs.ts:decodeAuditLogEntry", auditEvidence),
    ),
    ...[
        "AuditLogEntry.changes",
        "AuditLogEntry.options",
        "AuditLogEntry.reason",
        "AuditLogEntry.targetId",
        "AuditLogEntry.userId",
    ].map((target) =>
        rule(target, "response", auditResponseOwner, "src/internal/audit-logs.ts:decodeAuditLogEntry", auditEvidence, {
            default: unavailable,
        }),
    ),
    ...[
        "AuditLogOptions.channelId",
        "AuditLogOptions.count",
        "AuditLogOptions.deleteMemberDays",
        "AuditLogOptions.deleteMessageSeconds",
        "AuditLogOptions.id",
        "AuditLogOptions.integrationType",
        "AuditLogOptions.inviterId",
        "AuditLogOptions.maxAgeSeconds",
        "AuditLogOptions.maxUses",
        "AuditLogOptions.membersRemoved",
        "AuditLogOptions.messageId",
        "AuditLogOptions.roleName",
        "AuditLogOptions.temporary",
        "AuditLogOptions.type",
        "AuditLogOptions.uses",
    ].map((target) =>
        rule(
            target,
            "response",
            "packages/schema/src/domains/guild/GuildAuditLogSchemas.ts:AuditLogOptionsSchema",
            "src/internal/audit-logs.ts:options",
            auditEvidence,
            {
                default: unavailable,
                normalization: [
                    "count",
                    "deleteMessageSeconds",
                    "integrationType",
                    "maxAgeSeconds",
                    "maxUses",
                    "membersRemoved",
                    "temporary",
                    "type",
                    "uses",
                ].some((field) => target.endsWith(`.${field}`))
                    ? {
                          kind: "canonicalized",
                          detail: "Gateway string metadata is converted to the REST-shaped number or boolean view",
                      }
                    : preserved,
            },
        ),
    ),
    rule(
        "AuditLogPage.entries",
        "response",
        auditResponseOwner,
        "src/internal/audit-logs.ts:decodeAuditLogPage",
        auditEvidence,
        {
            length: {
                kind: "bounded",
                unit: "items",
                minimum: 0,
                maximum: 100,
                detail: "The decoder enforces the requested limit, whose provider maximum is 100",
            },
        },
    ),
    ...["AuditLogPage.users", "AuditLogPage.webhooks"].map((target) =>
        rule(target, "response", auditResponseOwner, "src/internal/audit-logs.ts:decodeAuditLogPage", auditEvidence),
    ),
    ...["AuditLogWebhook.id", "AuditLogWebhook.type", "AuditLogWebhook.name"].map((target) =>
        rule(
            target,
            "response",
            "packages/schema/src/domains/guild/GuildAuditLogSchemas.ts:AuditLogWebhookResponse",
            "src/internal/audit-logs.ts:webhook",
            auditEvidence,
        ),
    ),
    ...["AuditLogWebhook.guildId", "AuditLogWebhook.channelId", "AuditLogWebhook.avatarHash"].map((target) =>
        rule(
            target,
            "response",
            "packages/schema/src/domains/guild/GuildAuditLogSchemas.ts:AuditLogWebhookResponse",
            "src/internal/audit-logs.ts:webhook",
            auditEvidence,
            { default: unavailable },
        ),
    ),
    ...["GuildEmoji.id", "GuildEmoji.name", "GuildEmoji.animated"].map((target) =>
        rule(
            target,
            "response",
            expressionResponseOwner,
            "src/internal/expressions.ts:decodeExpression",
            expressionEvidence,
        ),
    ),
    rule(
        "GuildEmoji.guildId",
        "response",
        expressionResponseOwner,
        "src/internal/expressions.ts:decodeExpression",
        expressionEvidence,
        {
            default: owningContext,
            normalization: {
                kind: "canonicalized",
                detail: "The validated owning guild ID is attached from operation or event context",
            },
        },
    ),
    ...["GuildSticker.id", "GuildSticker.name", "GuildSticker.animated", "GuildSticker.description"].map((target) =>
        rule(
            target,
            "response",
            "packages/schema/src/domains/guild/GuildEmojiSchemas.ts:GuildStickerResponse",
            "src/internal/expressions.ts:decodeExpression",
            expressionEvidence,
        ),
    ),
    rule(
        "GuildSticker.guildId",
        "response",
        "packages/schema/src/domains/guild/GuildEmojiSchemas.ts:GuildStickerResponse",
        "src/internal/expressions.ts:decodeExpression",
        expressionEvidence,
        {
            default: owningContext,
            normalization: {
                kind: "canonicalized",
                detail: "The validated owning guild ID is attached from operation or event context",
            },
        },
    ),
    rule(
        "GuildSticker.tags",
        "response",
        "packages/schema/src/domains/guild/GuildEmojiSchemas.ts:GuildStickerResponse",
        "src/internal/expressions.ts:decodeExpression",
        expressionEvidence,
        {
            length: {
                kind: "bounded",
                unit: "items",
                maximum: 10,
                detail: "The decoder rejects more than ten provider tags",
            },
        },
    ),
    ...[
        "ExpressionMetadata.guildId",
        "ExpressionMetadata.id",
        "ExpressionMetadata.name",
        "ExpressionMetadata.animated",
        "ExpressionMetadata.allowCloning",
    ].map((target) =>
        rule(
            target,
            "response",
            "packages/schema/src/domains/guild/GuildEmojiSchemas.ts:GuildEmojiMetadataResponse",
            "src/internal/expressions.ts:expressionMetadata",
            expressionEvidence,
        ),
    ),
    ...["ExpressionBatch.success", "ExpressionBatch.failed"].map((target) =>
        rule(
            target,
            "response",
            "packages/schema/src/domains/guild/GuildEmojiSchemas.ts:GuildEmojiBulkCreateResponse",
            "src/internal/expressions.ts:expressionBatch",
            expressionEvidence,
            {
                length: {
                    kind: "bounded",
                    unit: "items",
                    maximum: 50,
                    detail: "Success and failure lengths together must equal the bounded input batch size",
                },
            },
        ),
    ),
    ...["Invite.code", "Invite.channel", "Invite.memberCount", "Invite.temporary"].map((target) =>
        rule(target, "response", inviteResponseOwner, "src/internal/invites.ts:decode", inviteEvidence),
    ),
    rule("Invite.type", "response", inviteResponseOwner, "src/internal/invites.ts:decode", inviteEvidence, {
        normalization: {
            kind: "canonicalized",
            detail: "Provider discriminator 0/1 is exposed as guild/group",
        },
    }),
    ...["Invite.guild", "Invite.inviterId", "Invite.presenceCount", "Invite.expiresAt"].map((target) =>
        rule(target, "response", inviteResponseOwner, "src/internal/invites.ts:decode", inviteEvidence, {
            default: unavailable,
        }),
    ),
    ...[
        "InviteMetadata.code",
        "InviteMetadata.channel",
        "InviteMetadata.memberCount",
        "InviteMetadata.temporary",
        "InviteMetadata.createdAt",
        "InviteMetadata.uses",
        "InviteMetadata.maxUses",
    ].map((target) =>
        rule(
            target,
            "response",
            "packages/schema/src/domains/invite/InviteSchemas.ts:InviteMetadataResponseSchema",
            "src/internal/invites.ts:metadata",
            inviteEvidence,
        ),
    ),
    rule(
        "InviteMetadata.type",
        "response",
        "packages/schema/src/domains/invite/InviteSchemas.ts:InviteMetadataResponseSchema",
        "src/internal/invites.ts:metadata",
        inviteEvidence,
        {
            normalization: {
                kind: "canonicalized",
                detail: "Provider discriminator 0/1 is exposed as guild/group",
            },
        },
    ),
    ...[
        "InviteMetadata.guild",
        "InviteMetadata.inviterId",
        "InviteMetadata.presenceCount",
        "InviteMetadata.expiresAt",
        "InviteMetadata.maxAgeSeconds",
    ].map((target) =>
        rule(
            target,
            "response",
            "packages/schema/src/domains/invite/InviteSchemas.ts:InviteMetadataResponseSchema",
            "src/internal/invites.ts:metadata",
            inviteEvidence,
            { default: unavailable },
        ),
    ),
]

const gatewayRules: FieldRuleAnnotation[] = [
    ...["id", "name", "ownerId", "features"].map((field) =>
        rule(
            `GuildCreate.${field}`,
            "gateway",
            guildResponseOwner,
            "src/internal/guilds.ts:decodeGuildLifecycleEvent",
            guildEvidence,
        ),
    ),
    ...[
        "icon",
        "banner",
        "splash",
        "embedSplash",
        "splashCardAlignment",
        "systemChannelId",
        "systemChannelFlags",
        "afkChannelId",
        "afkTimeoutSeconds",
        "defaultMessageNotifications",
        "verificationLevel",
        "nsfw",
        "contentWarningLevel",
        "contentWarningText",
        "explicitContentFilter",
        "messageHistoryCutoff",
    ].map((field) =>
        rule(
            `GuildCreate.${field}`,
            "gateway",
            guildResponseOwner,
            "src/internal/guilds.ts:decodeGuildLifecycleEvent",
            guildEvidence,
            { default: unavailable },
        ),
    ),
    rule(
        "GuildDeletion.id",
        "gateway",
        guildResponseOwner,
        "src/internal/guilds.ts:decodeGuildLifecycleEvent",
        guildEvidence,
    ),
    ...["GuildDeletion.unavailable", "GuildDeletion.unavailableHidden"].map((target) =>
        rule(target, "gateway", guildResponseOwner, "src/internal/guilds.ts:decodeGuildLifecycleEvent", guildEvidence, {
            default: {
                kind: "value",
                value: "false",
                detail: "The gateway decoder substitutes false when the provider marker is absent",
            },
        }),
    ),
    ...["MemberReference.guildId", "MemberReference.userId"].map((target) =>
        rule(target, "gateway", memberResponseOwner, "src/internal/guilds.ts:decodeGuildEvent", guildEvidence, {
            ...(target.endsWith(".guildId")
                ? {
                      default: owningContext,
                      normalization: {
                          kind: "canonicalized" as const,
                          detail: "The validated owning guild ID is attached from the gateway event envelope",
                      },
                  }
                : {}),
        }),
    ),
    ...["RoleReference.guildId", "RoleReference.id"].map((target) =>
        rule(target, "gateway", roleResponseOwner, "src/internal/guilds.ts:decodeGuildEvent", guildEvidence, {
            ...(target.endsWith(".guildId")
                ? {
                      default: owningContext,
                      normalization: {
                          kind: "canonicalized" as const,
                          detail: "The validated owning guild ID is attached from the gateway event envelope",
                      },
                  }
                : {}),
        }),
    ),
    ...["GuildRoleUpdateBulk.guildId", "GuildRoleUpdateBulk.roles"].map((target) =>
        rule(target, "gateway", roleResponseOwner, "src/internal/guilds.ts:decodeGuildEvent", guildEvidence),
    ),
    ...["GuildChannelUpdateBulk.guildId", "GuildChannelUpdateBulk.channels"].map((target) =>
        rule(target, "gateway", channelResponseOwner, "src/internal/channels.ts:decodeChannelEvent", channelEvidence),
    ),
    ...["GuildAuditLogEntryCreate.id", "GuildAuditLogEntryCreate.actionType"].map((target) =>
        rule(
            target,
            "gateway",
            auditResponseOwner,
            "src/internal/audit-logs.ts:decodeAuditLogEntry",
            gatewayAuditEvidence,
        ),
    ),
    ...["GuildAuditLogEntryCreate.changes", "GuildAuditLogEntryCreate.options", "GuildAuditLogEntryCreate.reason"].map(
        (target) =>
            rule(
                target,
                "gateway",
                auditResponseOwner,
                "src/internal/audit-logs.ts:decodeAuditLogEntry",
                gatewayAuditEvidence,
                { default: unavailable },
            ),
    ),
]

export const guildFieldRules = defineFieldRules([...requestRules, ...responseRules, ...gatewayRules])

export const guildLocalFieldExclusions = defineLocalFieldExclusions([
    ...[
        "DefaultGuildOperationOptions.timeoutMs",
        "DefaultGuildAuditOperationOptions.timeoutMs",
        "DefaultModerationOptions.timeoutMs",
        "DefaultTimeoutOptions.timeoutMs",
        "DefaultExpressionDeleteOptions.timeoutMs",
        "DefaultChannelOperationOptions.timeoutMs",
        "DefaultChannelAuditOperationOptions.timeoutMs",
    ].map((target) => ({
        target,
        direction: "request" as const,
        rationale: "This is an SDK-owned local deadline and is never sent as a provider field",
        sdkOwner: "src/internal/client.ts:makeClient" as const,
        executableEvidence: ["tests/guilds.test.ts", "tests/channels.test.ts"] as const,
    })),
    ...["GuildVanityUrl.url", "GuildVanityUrlUsage.url"].map((target) => ({
        target,
        direction: "response" as const,
        rationale: "The SDK derives the hosted invite URL from the provider code and selected instance endpoint",
        sdkOwner: "src/internal/vanity-url.ts:decode" as const,
        executableEvidence: vanityEvidence,
    })),
    ...["Invite.url", "InviteMetadata.url"].map((target) => ({
        target,
        direction: "response" as const,
        rationale: "The SDK derives the hosted invite URL from the provider code and selected instance endpoint",
        sdkOwner: "src/internal/invites.ts:decode" as const,
        executableEvidence: inviteEvidence,
    })),
])
