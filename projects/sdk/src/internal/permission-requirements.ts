/**
 * Permissions that Fluxer checks for SDK operations, behind details.requiredPermissions and the missing-permission hint.
 * Invariant: Every entry comes from Fluxer's own permission check at fluxerapp/fluxer commit
 * a95172bf88da26dd877255ceee139bf84e6799fa, the commit pinned in the
 * [upstream manifest](/projects/release/upstream/manifest.json). Source references are relative to fluxer_api/src/api.
 * An operation whose rejection the source does not tie to one set of permissions has no entry and keeps the generic hint.
 * Channel-authenticated routes first check View Channel in channel/services/BaseChannelAuthService.ts:213 and reject
 * it with MISSING_PERMISSIONS, so their entries include it.
 * Implements [SDK contracts: Validation requirements](/docs/SDK-CONTRACTS.md#validation-requirements)
 */
import type { Operation } from "#sdk/errors"
import type { PermissionName } from "#sdk/helpers"

/**
 * Where Fluxer reads a permission: In the channel, where permission overrides apply, community-wide from the bot's
 * roles, or community-wide and again in the channel
 */
type PermissionScope = "channel" | "guild" | "guildAndChannel"

/** What one operation needs, as Fluxer's permission checks state it */
export interface PermissionRequirement {
    /** Permissions that Fluxer checks on the operation's usual path */
    readonly permissions: readonly PermissionName[]
    readonly scope: PermissionScope
    /** Other checks behind the same rejection, such as role hierarchy or permissions that only some inputs need */
    readonly also?: string
}

const requires = (scope: PermissionScope, permissions: readonly PermissionName[], also?: string) =>
    Object.freeze({
        permissions: Object.freeze([...permissions]),
        scope,
        ...(also === undefined ? {} : { also }),
    }) satisfies PermissionRequirement

const memberHierarchy =
    "Fluxer also requires the bot's highest role to be above the member's highest role, and never allows acting on the community owner"
const ownPermissions = "the bot can allow, or stop denying, only permissions it has"

/** Requirement of each operation whose permission checks the pinned source ties to one set */
export const permissionRequirements: Readonly<Partial<Record<Operation, PermissionRequirement>>> = {
    // channel/services/channel_data/ChannelOperationsService.ts:114
    "channels.fetch": requires("channel", ["ViewChannel"]),
    // webhook/ChannelFollowService.ts:181
    "channels.fetchFollowerStats": requires("channel", ["ViewChannel"]),
    // guild/services/GuildChannelService.ts:92, guild/services/channel/ChannelOperationsService.ts:83-97
    "channels.create": requires(
        "guild",
        ["ManageChannels"],
        "Setting permission overwrites also needs Manage Roles, and the bot can allow only permissions it has",
    ),
    // channel/services/channel_data/ChannelOperationsService.ts:164, 189, 219-258
    "channels.edit": requires(
        "channel",
        ["ViewChannel", "ManageChannels"],
        `Changing permission overwrites also needs Manage Roles, and ${ownPermissions}. Changing a voice region also needs Update RTC Region`,
    ),
    // channel/services/channel_data/ChannelOperationsService.ts:418
    "channels.delete": requires("channel", ["ViewChannel", "ManageChannels"]),
    // guild/services/GuildChannelService.ts:115, guild/services/channel/ChannelOperationsService.ts:396-405
    "channels.reorder": requires(
        "guild",
        ["ManageChannels"],
        `Moving a channel with syncPermissionsOnMove also needs Manage Roles, and ${ownPermissions}`,
    ),
    // channel/services/channel_data/ChannelOperationsService.ts:647-676
    "channels.setPermissionOverwrite": requires("channel", ["ManageRoles"], `Also, ${ownPermissions}`),
    // channel/services/channel_data/ChannelOperationsService.ts:719-738
    "channels.removePermissionOverwrite": requires(
        "channel",
        ["ManageRoles"],
        "Also, the bot can remove an overwrite only when it has every permission that overwrite denies",
    ),
    // webhook/ChannelFollowService.ts:77-100, webhook/WebhookService.ts:614-634
    "channels.follow": requires(
        "guildAndChannel",
        ["ViewChannel", "ManageWebhooks"],
        "Fluxer checks View Channel in both channels and Manage Webhooks in the destination",
    ),
    // webhook/WebhookService.ts:197-204, 614-634
    "webhooks.create": requires("guildAndChannel", ["ViewChannel", "ManageWebhooks"]),
    // webhook/WebhookService.ts:177-184
    "webhooks.fetchForChannel": requires("guildAndChannel", ["ViewChannel", "ManageWebhooks"]),
    // webhook/WebhookService.ts:163-164
    "webhooks.fetchForGuild": requires("guild", ["ManageWebhooks"]),
    // webhook/WebhookService.ts:154-155, 506-518
    "webhooks.fetch": requires("guildAndChannel", ["ViewChannel", "ManageWebhooks"]),
    // webhook/WebhookService.ts:241-275
    "webhooks.edit": requires(
        "guildAndChannel",
        ["ViewChannel", "ManageWebhooks"],
        "Moving the webhook to another channel also needs them in that channel",
    ),
    // webhook/WebhookService.ts:362-365
    "webhooks.delete": requires("guildAndChannel", ["ViewChannel", "ManageWebhooks"]),
    // invite/InviteService.ts:151, 189-198
    "invites.create": requires("channel", ["ViewChannel", "CreateInstantInvite"]),
    // invite/InviteService.ts:117-129
    "invites.fetchForChannel": requires(
        "guildAndChannel",
        ["ViewChannel", "ManageChannels"],
        "For a group direct message, only its owner can list them",
    ),
    // invite/InviteService.ts:135-139
    "invites.fetchForGuild": requires("guild", ["ManageGuild"]),
    // invite/InviteService.ts:364-392
    "invites.delete": requires(
        "guild",
        ["ManageGuild"],
        "Deleting an invite the bot created needs no Manage Guild. For a group direct message invite, only the group owner can delete it",
    ),
    // guild/services/content/EmojiService.ts:102. Editing and deleting need Create Expressions for the bot's own
    // emoji and Manage Expressions otherwise, so they have no entry
    "emojis.create": requires("guild", ["CreateExpressions"]),
    // guild/services/content/EmojiService.ts:219
    "emojis.createMany": requires("guild", ["CreateExpressions"]),
    // guild/services/content/EmojiService.ts:164
    "emojis.clone": requires("guild", ["CreateExpressions"]),
    // guild/services/content/StickerService.ts:118
    "stickers.create": requires("guild", ["CreateExpressions"]),
    // guild/services/content/StickerService.ts:238
    "stickers.createMany": requires("guild", ["CreateExpressions"]),
    // guild/services/content/StickerService.ts:178
    "stickers.clone": requires("guild", ["CreateExpressions"]),
    // guild/services/data/GuildOperationsService.ts:462
    "guilds.edit": requires("guild", ["ManageGuild"]),
    // guild/services/data/GuildVanityService.ts:34
    "guilds.fetchVanityUrl": requires("guild", ["ManageGuild"]),
    // guild/services/data/GuildVanityService.ts:61
    "guilds.editVanityUrl": requires("guild", ["ManageGuild"]),
    // guild/services/GuildService.ts:306-318
    "auditLogs.fetchPage": requires("guild", ["ViewAuditLog"]),
    // guild/controllers/GuildDiscoveryController.ts:163
    "discovery.apply": requires("guild", ["ManageGuild"]),
    // guild/controllers/GuildDiscoveryController.ts:198
    "discovery.edit": requires("guild", ["ManageGuild"]),
    // guild/controllers/GuildDiscoveryController.ts:228
    "discovery.withdraw": requires("guild", ["ManageGuild"]),
    // guild/controllers/GuildDiscoveryController.ts:252
    "discovery.fetchStatus": requires("guild", ["ManageGuild"]),
    // guild/services/member/GuildMemberOperationsService.ts:395-401
    "members.kick": requires("guild", ["KickMembers"], memberHierarchy),
    // guild/services/GuildModerationService.ts:83-92
    "members.ban": requires("guild", ["BanMembers"], memberHierarchy),
    // guild/services/GuildModerationService.ts:184
    "members.unban": requires("guild", ["BanMembers"]),
    // guild/services/GuildModerationService.ts:170
    "members.fetchBans": requires("guild", ["BanMembers"]),
    // guild/services/member/GuildMemberOperationsService.ts:577-586
    "members.timeout": requires(
        "guild",
        ["ModerateMembers"],
        `${memberHierarchy}, the bot itself or a member with Administrator`,
    ),
    "members.clearTimeout": requires(
        "guild",
        ["ModerateMembers"],
        `${memberHierarchy}, the bot itself or a member with Administrator`,
    ),
    // guild/services/member/GuildMemberOperationsService.ts:289-291
    "members.setNickname": requires("guild", ["ManageNicknames"], memberHierarchy),
    // guild/services/member/GuildMemberOperationsService.ts:880-887
    "members.setMute": requires("guild", ["MuteMembers"], memberHierarchy),
    // guild/services/member/GuildMemberOperationsService.ts:880-891
    "members.setDeaf": requires("guild", ["DeafenMembers"], memberHierarchy),
    // guild/services/member/GuildMemberOperationsService.ts:880-917
    "members.move": requires(
        "guild",
        ["MoveMembers"],
        `${memberHierarchy}. The bot and the member also need Connect in the destination channel`,
    ),
    // guild/services/member/GuildMemberOperationsService.ts:880-896
    "members.disconnect": requires("guild", ["MoveMembers"], memberHierarchy),
    // guild/services/member/GuildMemberValidationService.ts:50-62
    "members.setRoles": requires(
        "guild",
        ["ManageRoles"],
        "Fluxer also requires the bot's highest role to be above every role it adds or removes",
    ),
    // guild/services/member/GuildMemberValidationService.ts:84-89
    "members.addRole": requires(
        "guild",
        ["ManageRoles"],
        "Fluxer also requires the bot's highest role to be above the role",
    ),
    "members.removeRole": requires(
        "guild",
        ["ManageRoles"],
        "Fluxer also requires the bot's highest role to be above the role",
    ),
    // guild/services/GuildRoleService.ts:121, 180-185
    "roles.create": requires("guild", ["ManageRoles"], "Also, the bot can grant only permissions it has"),
    // guild/services/GuildRoleService.ts:202-222
    "roles.edit": requires(
        "guild",
        ["ManageRoles"],
        "Fluxer also requires the bot's highest role to be above the role, and the bot can grant only permissions it has",
    ),
    // guild/services/GuildRoleService.ts:265-274
    "roles.delete": requires(
        "guild",
        ["ManageRoles"],
        "Fluxer also requires the bot's highest role to be above the role",
    ),
    // guild/services/GuildRoleService.ts:317, 612-624
    "roles.reorder": requires("guild", ["ManageRoles"], "Also, the bot can move only roles below its highest role"),
    // guild/services/GuildRoleService.ts:354, 372-389
    "roles.setHoistPositions": requires(
        "guild",
        ["ManageRoles"],
        "Also, the bot can change only roles below its highest role",
    ),
    // guild/services/GuildRoleService.ts:432
    "roles.resetHoistPositions": requires("guild", ["ManageRoles"]),
    // channel/services/message/MessageSendService.ts:268-291, 679-682, channel/services/AttachmentUploadService.ts:491.
    // Every send, reply, forward and direct message reports this operation, and direct messages never check these
    send: requires(
        "channel",
        ["ViewChannel", "SendMessages"],
        "Embeds also need Embed Links, files need Attach Files, and a forward needs View Channel in its source channel",
    ),
    // channel/services/MessageInteractionService.ts:75-76
    typing: requires("channel", ["ViewChannel", "SendMessages"]),
    // channel/services/message/MessageRetrievalService.ts:76
    fetch: requires("channel", ["ViewChannel"]),
    fetchHistory: requires("channel", ["ViewChannel"]),
    // channel/services/message/MessageEditService.ts:71-93
    edit: requires(
        "channel",
        ["ViewChannel"],
        "Adding embeds also needs Embed Links, and adding files needs Attach Files",
    ),
    // channel/services/message/MessageDeleteService.ts:67-77, channel/services/message/MessageValidationService.ts:249-255
    delete: requires(
        "channel",
        ["ViewChannel", "ManageMessages"],
        "Deleting the bot's own message needs no Manage Messages, and Fluxer does not allow deleting some system messages",
    ),
    // channel/services/message/MessageDeleteService.ts:179-184
    deleteMany: requires("channel", ["ViewChannel", "ManageMessages"]),
    // channel/services/AttachmentUploadService.ts:357-369
    deleteAttachment: requires(
        "channel",
        ["ViewChannel"],
        "Also, Fluxer lets only the message's author remove its attachments",
    ),
    // channel/controllers/MessageController.ts:478
    deleteOwnMessages: requires("channel", ["ViewChannel"]),
    // channel/services/message/MessageCrosspostService.ts:70-92
    publish: requires(
        "channel",
        ["ViewChannel", "SendMessages"],
        "Publishing another author's message also needs Manage Messages",
    ),
    // channel/services/MessageInteractionService.ts:115, channel/services/interaction/MessagePinService.ts:155
    pin: requires("channel", ["ViewChannel", "PinMessages"]),
    // channel/services/MessageInteractionService.ts:136, channel/services/interaction/MessagePinService.ts:206
    unpin: requires("channel", ["ViewChannel", "PinMessages"]),
    // channel/services/MessageInteractionService.ts:98
    fetchPins: requires("channel", ["ViewChannel"]),
    // channel/services/MessageInteractionService.ts:162
    fetchReactionUsers: requires("channel", ["ViewChannel"]),
    // channel/services/MessageInteractionService.ts:180, channel/services/interaction/MessageReactionService.ts:208-209, 431-433
    addReaction: requires(
        "channel",
        ["ViewChannel", "AddReactions"],
        "Adding to an existing reaction needs no Add Reactions, and a new reaction with a custom emoji also needs Use External Emojis",
    ),
    // channel/services/MessageInteractionService.ts:227, channel/services/interaction/MessageReactionService.ts:276-278
    removeReaction: requires("channel", ["ViewChannel"]),
    // channel/services/interaction/MessageReactionService.ts:276-278, 363-376
    removeUserReaction: requires(
        "channel",
        ["ViewChannel", "ManageMessages"],
        "Fluxer allows it only in community channels",
    ),
    // channel/services/MessageInteractionService.ts:260, channel/services/interaction/MessageReactionService.ts:316
    clearReaction: requires("channel", ["ViewChannel", "ManageMessages"]),
    // channel/services/MessageInteractionService.ts:273, channel/services/interaction/MessageReactionService.ts:347
    clearReactions: requires("channel", ["ViewChannel", "ManageMessages"]),
}

/** What Fluxer requires for an operation, or undefined when its permission checks are not tied to one set */
export function permissionRequirement(operation: string): PermissionRequirement | undefined {
    return Object.hasOwn(permissionRequirements, operation) ? permissionRequirements[operation as Operation] : undefined
}

/** Readable name of a permission, such as Manage Channels for ManageChannels */
const permissionLabel = (name: PermissionName) => name.replace(/([a-z])([A-Z])/g, "$1 $2")

/** The suggested fix for a missing-permission rejection of an operation with a known requirement */
export function requiredPermissionsHint(requirement: PermissionRequirement): string {
    const labels = requirement.permissions.map(permissionLabel)
    const list = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`
    const them = labels.length === 1 ? "it" : "them"
    const where = {
        channel: `Grant ${them} to the bot's role in the community settings or the channel's permission overrides`,
        guild: `Grant ${them} to the bot's role in the community settings`,
        guildAndChannel: `Grant ${them} to the bot's role in the community settings, and check that the channel's permission overrides do not deny ${them}`,
    }[requirement.scope]
    return [`The bot needs ${list} for this operation`, where, requirement.also]
        .filter((part) => part !== undefined)
        .join(". ")
}
