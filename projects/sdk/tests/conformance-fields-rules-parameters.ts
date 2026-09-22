import {
    defineFieldRules,
    defineLocalFieldExclusions,
    type FieldRuleAnnotation,
} from "./conformance-fields-registry.js"

const identifierTargets = [
    "AuditLogs.fetchPage(guildId)",
    "AuditLogs.iterate(guildId)",
    "Channels.create(guildId)",
    "Channels.delete(channelId)",
    "Channels.edit(channelId)",
    "Channels.fetch(channelId)",
    "Channels.fetchAll(guildId)",
    "Channels.fetchMemberCounts(guildId)",
    "Channels.removePermissionOverwrite(channelId)",
    "Channels.removePermissionOverwrite(targetId)",
    "Channels.reorder(guildId)",
    "Channels.setPermissionOverwrite(channelId)",
    "DirectMessages.close(id)",
    "DirectMessages.editGroup(id)",
    "DirectMessages.fetch(id)",
    "DirectMessages.open(userId)",
    "DirectMessages.removeRecipient(id)",
    "DirectMessages.removeRecipient(userId)",
    "DirectMessages.send(userId)",
    "Discovery.apply(guildId)",
    "Discovery.edit(guildId)",
    "Discovery.fetchStatus(guildId)",
    "Discovery.withdraw(guildId)",
    "Emojis.clone(guildId)",
    "Emojis.clone(sourceId)",
    "Emojis.create(guildId)",
    "Emojis.createMany(guildId)",
    "Emojis.fetchAll(guildId)",
    "Emojis.fetchMetadata(id)",
    "Guilds.deleteMine(guildId)",
    "Guilds.edit(guildId)",
    "Guilds.editVanityUrl(guildId)",
    "Guilds.fetch(guildId)",
    "Guilds.fetchBans(guildId)",
    "Guilds.fetchVanityUrl(guildId)",
    "Guilds.leave(guildId)",
    "Invites.create(channelId)",
    "Invites.fetchChannel(channelId)",
    "Invites.fetchGuild(guildId)",
    "Members.addRole(roleId)",
    "Members.editSelf(guildId)",
    "Members.fetchPage(guildId)",
    "Members.fetchSelf(guildId)",
    "Members.iterate(guildId)",
    "Members.iterateChunks(guildId)",
    "Members.iterateSearch(guildId)",
    "Members.move(channelId)",
    "Members.removeRole(roleId)",
    "Members.search(guildId)",
    "Messages.collect(channelId)",
    "Messages.deleteAttachment(attachmentId)",
    "Messages.deleteMany(channelId)",
    "Messages.deleteMine(channelId)",
    "Messages.fetchHistory(channelId)",
    "Messages.fetchPins(channelId)",
    "Messages.forward(channelId)",
    "Messages.iterateHistory(channelId)",
    "Messages.iteratePins(channelId)",
    "Messages.keepTyping(channelId)",
    "Messages.removeUserReaction(userId)",
    "Messages.send(channelId)",
    "Messages.typing(channelId)",
    "Presence.setMembers(guildId)",
    "Roles.create(guildId)",
    "Roles.fetchAll(guildId)",
    "Roles.reorder(guildId)",
    "Roles.resetHoistPositions(guildId)",
    "Roles.setHoistPositions(guildId)",
    "Stickers.clone(guildId)",
    "Stickers.clone(sourceId)",
    "Stickers.create(guildId)",
    "Stickers.createMany(guildId)",
    "Stickers.fetchAll(guildId)",
    "Stickers.fetchMetadata(id)",
    "Users.fetch(id)",
    "Users.fetchProfile(id)",
    "WebhookClient.deleteMessage(messageId)",
    "WebhookClient.editMessage(messageId)",
    "WebhookClient.fetchMessage(messageId)",
    "Webhooks.create(channelId)",
    "Webhooks.delete(id)",
    "Webhooks.edit(id)",
    "Webhooks.fetch(id)",
    "Webhooks.fetchChannel(channelId)",
    "Webhooks.fetchGuild(guildId)",
] as const
const codeTargets = ["Guilds.editVanityUrl(code)", "Invites.delete(code)", "Invites.fetch(code)"] as const
const oauthTargets = [
    "OAuthClient.fetchConnections(accessToken)",
    "OAuthClient.fetchGuilds(accessToken)",
    "OAuthClient.fetchIdentity(accessToken)",
    "OAuthClient.introspect(token)",
    "OAuthClient.refresh(refreshToken)",
] as const

const sdkOwners = {
    Attachments: "src/index.ts:Attachments",
    AuditLogs: "src/index.ts:AuditLogs",
    Channels: "src/index.ts:Channels",
    DirectMessages: "src/index.ts:DirectMessages",
    Discovery: "src/index.ts:Discovery",
    Emojis: "src/index.ts:Emojis",
    Guilds: "src/index.ts:Guilds",
    Invites: "src/index.ts:Invites",
    Members: "src/index.ts:Members",
    Messages: "src/index.ts:Messages",
    OAuthClient: "src/index.ts:OAuthClient",
    Presence: "src/index.ts:Presence",
    Roles: "src/index.ts:Roles",
    Stickers: "src/index.ts:Stickers",
    Users: "src/index.ts:Users",
    WebhookClient: "src/index.ts:WebhookClient",
    Webhooks: "src/index.ts:Webhooks",
} as const

const evidenceByNamespace = {
    Attachments: ["tests/attachment-refresh.test.ts"],
    AuditLogs: ["tests/audit-logs.test.ts"],
    Channels: ["tests/channels.test.ts"],
    DirectMessages: ["tests/users.test.ts"],
    Discovery: ["tests/discovery.test.ts"],
    Emojis: ["tests/expressions.test.ts"],
    Guilds: ["tests/guilds.test.ts"],
    Invites: ["tests/invites.test.ts"],
    Members: ["tests/conformance-registry.test.ts"],
    Messages: ["tests/messages.test.ts"],
    OAuthClient: ["tests/oauth-input-boundaries.test.ts"],
    Presence: ["tests/presence.test.ts"],
    Roles: ["tests/guilds.test.ts"],
    Stickers: ["tests/expressions.test.ts"],
    Users: ["tests/users.test.ts"],
    WebhookClient: ["tests/webhooks.test.ts"],
    Webhooks: ["tests/webhooks.test.ts"],
} as const

function sdkOwner(target: string): FieldRuleAnnotation["sdkOwner"] {
    const namespace = target.slice(0, target.indexOf(".")) as keyof typeof sdkOwners
    const owner = sdkOwners[namespace]
    if (owner === undefined) throw new Error(`No direct-parameter SDK owner for ${target}`)
    return owner
}

const rule = (
    target: string,
    providerOwner: FieldRuleAnnotation["providerOwner"],
    detail: string,
    length: FieldRuleAnnotation["length"] = {
        kind: "not-applicable",
        detail: "This contract is semantic rather than a text-length rule",
    },
): FieldRuleAnnotation => ({
    target,
    direction: "request",
    providerOwner,
    sdkOwner: sdkOwner(target),
    default: { kind: "none", detail: "The direct operation parameter is required" },
    length,
    normalization: { kind: "preserved", detail },
    executableEvidence: evidenceByNamespace[target.slice(0, target.indexOf(".")) as keyof typeof evidenceByNamespace],
})

/** Exact direct operation parameters not represented by exported request object fields. */
export const directParameterFieldRules = defineFieldRules([
    ...identifierTargets.map((target) =>
        rule(
            target,
            "fluxer_docs/src/content/docs/snowflakes.md#snowflake-identifiers",
            "Decimal snowflake spelling is preserved after signed-63 range validation",
        ),
    ),
    rule(
        "Channels.fetchMemberCounts(channelIds)",
        "fluxer_docs/src/content/docs/gateway/commands.md#request-channel-member-counts",
        "The validated unique ID order is preserved",
        {
            kind: "bounded",
            unit: "items",
            minimum: 1,
            maximum: 25,
            detail: "A channel-count gateway request accepts 1 through 25 unique channel IDs",
        },
    ),
    rule(
        "DirectMessages.fetchLatestMessages(channelIds)",
        "packages/schema/src/domains/user/UserRequestSchemas.ts:BulkGetRecentDMMessagesRequest",
        "The validated unique ID order is preserved",
        {
            kind: "bounded",
            unit: "items",
            minimum: 1,
            maximum: 100,
            detail: "The bulk latest-message request accepts 1 through 100 unique channel IDs",
        },
    ),
    rule(
        "Guilds.fetchCounts(guildIds)",
        "fluxer_docs/src/content/docs/gateway/commands.md#request-guild-counts",
        "The validated unique ID order is preserved",
        {
            kind: "bounded",
            unit: "items",
            minimum: 1,
            maximum: 100,
            detail: "A guild-count gateway request accepts 1 through 100 unique guild IDs",
        },
    ),
    rule(
        "Members.setRoles(roleIds)",
        "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildMemberUpdateRequest",
        "The validated unique role order is preserved; duplicates are rejected",
        {
            kind: "bounded",
            unit: "items",
            minimum: 0,
            maximum: 250,
            detail: "A member role set accepts zero through 250 unique non-default-role IDs",
        },
    ),
    rule(
        "Messages.deleteMany(messageIds)",
        "packages/schema/src/domains/message/MessageRequestSchemas.ts:BulkDeleteMessagesRequest",
        "The validated unique message order is preserved",
        {
            kind: "bounded",
            unit: "items",
            minimum: 1,
            maximum: 100,
            detail: "Bulk deletion accepts 1 through 100 unique message IDs",
        },
    ),
    rule(
        "Presence.setMembers(memberIds)",
        "fluxer_docs/src/content/docs/gateway/commands.md#lazy-request",
        "The validated unique member order is preserved; an empty list clears the guild selection",
        {
            kind: "bounded",
            unit: "items",
            minimum: 0,
            maximum: 1000,
            detail: "One guild selection accepts zero through 1,000 unique member IDs",
        },
    ),
    ...codeTargets.map((target) =>
        rule(
            target,
            "packages/schema/src/domains/invite/InviteRequestSchemas.ts:InviteCodeType",
            "The route code is preserved",
        ),
    ),
    ...oauthTargets.map((target) =>
        rule(
            target,
            "packages/schema/src/domains/oauth/OAuthSchemas.ts:OAuth token request fields",
            "Opaque OAuth token bytes are preserved",
            {
                kind: "bounded",
                unit: "UTF-16-code-units",
                minimum: 1,
                maximum: 256,
                detail: "OAuth token inputs use the pinned provider canonical text bound",
            },
        ),
    ),
    rule(
        "OAuthClient.revoke(input.token)",
        "packages/schema/src/domains/oauth/OAuthSchemas.ts:RevokeTokenRequest.token",
        "Opaque OAuth token bytes are preserved",
        {
            kind: "bounded",
            unit: "UTF-16-code-units",
            minimum: 1,
            maximum: 256,
            detail: "OAuth token inputs use the pinned provider canonical text bound",
        },
    ),
    {
        ...rule(
            "OAuthClient.revoke(input.tokenTypeHint)",
            "packages/schema/src/domains/oauth/OAuthSchemas.ts:RevokeTokenRequest.token_type_hint",
            "The optional protocol enum is preserved",
        ),
        default: { kind: "omitted", detail: "An absent token type hint is omitted from the form body" },
    },
    rule(
        "Members.setNickname(nickname)",
        "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildMemberUpdateRequest",
        "Null clears the nickname; non-null text is preserved after provider text validation",
        {
            kind: "bounded",
            unit: "UTF-16-code-units",
            maximum: 32,
            detail: "The provider nickname maximum is 32 UTF-16 code units",
        },
    ),
    rule(
        "Members.setDeaf(deafened)",
        "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildMemberUpdateRequest",
        "The boolean is preserved",
    ),
    rule(
        "Members.setMute(muted)",
        "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildMemberUpdateRequest",
        "The boolean is preserved",
    ),
    {
        ...rule(
            "Members.timeout(durationMs)",
            "packages/schema/src/domains/guild/GuildRequestSchemas.ts:GuildMemberUpdateRequest",
            "The integer duration is converted to an absolute provider timestamp",
            {
                kind: "bounded",
                unit: "milliseconds",
                minimum: 1,
                maximum: 31536000000,
                detail: "The SDK accepts one millisecond through 365 days",
            },
        ),
        normalization: {
            kind: "canonicalized",
            detail: "The SDK converts the relative millisecond duration to an absolute ISO timestamp at execution",
        },
    },
    rule(
        "Attachments.refreshUrls(urls)",
        "packages/schema/src/domains/attachment/AttachmentRequestSchemas.ts:AttachmentRefreshUrlsRequest",
        "URL strings are preserved in input order",
        {
            kind: "bounded",
            unit: "items",
            minimum: 1,
            maximum: 50,
            detail: "The refresh request accepts 1 through 50 URLs; each URL is separately bounded to 2,048 UTF-16 code units",
        },
    ),
])

export const directParameterLocalExclusions = defineLocalFieldExclusions([
    {
        target: "Client.events(event)",
        direction: "request",
        rationale:
            "The generic event selector is an SDK-local keyof EventMap constraint; gateway payload fields are indexed separately",
        sdkOwner: "src/client.ts:Client",
        executableEvidence: ["tests/events.test.ts"],
    },
    {
        target: "Client.on(event)",
        direction: "request",
        rationale:
            "The generic event selector is an SDK-local keyof EventMap constraint; gateway payload fields are indexed separately",
        sdkOwner: "src/client.ts:Client",
        executableEvidence: ["tests/events.test.ts"],
    },
    {
        target: "Client.waitFor(event)",
        direction: "request",
        rationale:
            "The generic event selector is an SDK-local keyof EventMap constraint; gateway payload fields are indexed separately",
        sdkOwner: "src/client.ts:Client",
        executableEvidence: ["tests/events.test.ts"],
    },
] as const)

export const nativeDirectParameterLocalExclusions = defineLocalFieldExclusions([
    {
        target: "Messages.keepTyping(task)",
        direction: "request",
        rationale: "The native Effect implementation task is an SDK-local scheduler boundary and is never serialized",
        sdkOwner: "src/effect.ts:MessagesClient.keepTyping",
        executableEvidence: ["tests/messages.test.ts"],
    },
] as const)
