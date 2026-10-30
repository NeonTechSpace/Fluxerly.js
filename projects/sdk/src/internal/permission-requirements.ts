/**
 * Permissions that Fluxer checks for SDK operations, behind details.requiredPermissions and the missing-permission hint.
 * Invariant: Every entry comes from Fluxer's own permission check in fluxerapp/fluxer. Entries that name no other commit
 * come from a95172bf88da26dd877255ceee139bf84e6799fa, except the five entries that change channel permission overwrites
 * (channels.create, edit, reorder, setPermissionOverwrite and removePermissionOverwrite), whose references come from
 * 597116a0b4bf3a212789bdebe7f284babc33b445. The forum tag and threads.* entries come from the commit
 * 4749eb7f866ceba0c9622014a9824900d5be8172 that their comments name. Source references are relative to
 * fluxer_api/src/api.
 * An operation whose rejection the source does not tie to one set of permissions has no entry and keeps the generic hint.
 * Channel-authenticated routes first check View Channel in channel/services/BaseChannelAuthService.ts:213 and reject
 * it with MISSING_PERMISSIONS, so their entries include it.
 * Implements [SDK contracts: Validation requirements](/docs/SDK-CONTRACTS.md#validation-requirements)
 */
import type { Operation } from "#sdk/errors"
import type { PermissionName } from "#sdk/helpers"
import { channelScreenLabel, permissionLabel as label } from "./permission-labels.js"

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
// Fluxer's grant rule, utils/PermissionUtils.ts:55-64 at 597116a: A change grants the bits it newly allows and the bits
// it stops denying, and Fluxer refuses it with MISSING_PERMISSIONS when the bot lacks any of them in the channel it
// checks. The community owner and Administrator have every bit, because the gateway returns all of them without
// applying channel overwrites (fluxer_gateway/src/guild/guild_permissions.erl:79-80, 85-88 and 169-170 at 597116a)
const ownPermissions = "it can allow, or stop denying, only permissions it has in the channel"
const refusedGrantsHint = "The permissionBits.refusedGrants helper shows which bits Fluxer would refuse"

/** A permission label followed by the different title that a channel's permission screen shows for it, if any */
const withChannelTitle = (name: PermissionName): string => {
    const title = channelScreenLabel(name)
    return title === undefined ? label(name) : `${label(name)} (titled "${title}" in a channel's permission overrides)`
}

/** Requirement of each operation whose permission checks the pinned source ties to one set */
export const permissionRequirements: Readonly<Partial<Record<Operation, PermissionRequirement>>> = {
    // channel/services/channel_data/ChannelOperationsService.ts:114
    "channels.fetch": requires("channel", ["ViewChannel"]),
    // webhook/ChannelFollowService.ts:181
    "channels.fetchFollowerStats": requires("channel", ["ViewChannel"]),
    // guild/services/GuildChannelService.ts:92, guild/services/channel/ChannelOperationsService.ts:83-98 at 597116a, where
    // Manage Roles is checked community-wide and only the allow bits of each new overwrite are compared with the bot's
    // permissions in the parent category, or community-wide without one. Denies are not checked, and a channel created
    // without overwrites copies its category's without a check
    "channels.create": requires(
        "guild",
        ["ManageChannels"],
        `Setting permission overwrites also needs ${withChannelTitle("ManageRoles")}. Unless the bot has Administrator, it can allow only permissions it has in the parent category, or in the community when there is no parent. ${refusedGrantsHint}`,
    ),
    // channel/services/channel_data/ChannelOperationsService.ts:164, 189, 217-261 at 597116a, where every target of the old
    // or new overwrite list is compared and the community owner skips the comparison
    "channels.edit": requires(
        "channel",
        ["ViewChannel", "ManageChannels"],
        `Changing permission overwrites also needs ${withChannelTitle("ManageRoles")}. Unless the bot has Administrator, ${ownPermissions}. ${refusedGrantsHint}. Changing a voice region also needs ${label("UpdateRtcRegion")}`,
    ),
    // channel/services/channel_data/ChannelOperationsService.ts:418
    "channels.delete": requires("channel", ["ViewChannel", "ManageChannels"]),
    // guild/services/GuildChannelService.ts:115, guild/services/channel/ChannelOperationsService.ts:371-406 at 597116a,
    // where only a move into another category syncs, Manage Roles is checked in the moved channel and every target of the
    // channel's or the category's overwrites is compared with the bot's permissions in that channel. The move happens
    // before the sync
    "channels.reorder": requires(
        "guild",
        ["ManageChannels"],
        `Moving a channel into another category with syncPermissionsOnMove also needs ${withChannelTitle("ManageRoles")} in the moved channel. Unless the bot has Administrator, the category's overwrites can allow, or stop denying, only permissions the bot has in that channel. ${refusedGrantsHint}. Fluxer moves the channel first, so a refusal leaves it moved without the category's overwrites`,
    ),
    // channel/services/channel_data/ChannelOperationsService.ts:647-676 at 597116a
    "channels.setPermissionOverwrite": requires(
        "channel",
        ["ManageRoles"],
        `Also, unless the bot has Administrator, ${ownPermissions}. ${refusedGrantsHint}`,
    ),
    // channel/services/channel_data/ChannelOperationsService.ts:719-738 at 597116a
    "channels.removePermissionOverwrite": requires(
        "channel",
        ["ManageRoles"],
        `Also, unless the bot has Administrator, it can remove an overwrite only when it has every permission that the overwrite denies in the channel. ${refusedGrantsHint}`,
    ),
    // webhook/ChannelFollowService.ts:77-100, webhook/WebhookService.ts:614-634
    "channels.follow": requires(
        "guildAndChannel",
        ["ViewChannel", "ManageWebhooks"],
        `Fluxer checks ${label("ViewChannel")} in both channels and ${label("ManageWebhooks")} in the destination`,
    ),
    // Upstream 4749eb7f, channel/services/ChannelRequestService.ts:164-171, where the three tag routes in
    // channel/controllers/ForumController.ts check Manage Channels before changing the channel's tags
    "channels.createForumTag": requires("channel", ["ViewChannel", "ManageChannels"]),
    "channels.editForumTag": requires("channel", ["ViewChannel", "ManageChannels"]),
    "channels.deleteForumTag": requires("channel", ["ViewChannel", "ManageChannels"]),
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
        `Deleting an invite the bot created needs no ${label("ManageGuild")}. For a group direct message invite, only the group owner can delete it`,
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
        `${memberHierarchy}. The bot and the member also need ${label("Connect")} in the destination channel`,
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
        `Embeds also need ${label("EmbedLinks")}, files need ${label("AttachFiles")}, and a forward needs ${label("ViewChannel")} in its source channel`,
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
        `Adding embeds also needs ${label("EmbedLinks")}, and adding files needs ${label("AttachFiles")}`,
    ),
    // channel/services/message/MessageDeleteService.ts:67-77, channel/services/message/MessageValidationService.ts:249-255
    delete: requires(
        "channel",
        ["ViewChannel", "ManageMessages"],
        `Deleting the bot's own message needs no ${label("ManageMessages")}, and Fluxer does not allow deleting some system messages`,
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
        `Publishing another author's message also needs ${label("ManageMessages")}`,
    ),
    // channel/services/MessageInteractionService.ts:115, channel/services/interaction/MessagePinService.ts:155
    pin: requires("channel", ["ViewChannel", "PinMessages"]),
    // channel/services/MessageInteractionService.ts:136, channel/services/interaction/MessagePinService.ts:206
    unpin: requires("channel", ["ViewChannel", "PinMessages"]),
    // channel/services/MessageInteractionService.ts:98
    fetchPins: requires("channel", ["ViewChannel"]),
    // channel/services/MessageInteractionService.ts:162
    fetchReactionUsers: requires("channel", ["ViewChannel"]),
    fetchHasReaction: requires("channel", ["ViewChannel"]),
    // channel/services/MessageInteractionService.ts:227, channel/services/interaction/MessageReactionService.ts:221-222, 409-418
    addReaction: requires(
        "channel",
        ["ViewChannel", "AddReactions"],
        `Adding to an existing reaction needs no ${label("AddReactions")}, and a new reaction with a custom emoji from another community also needs ${label("UseExternalEmojis")}`,
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
    // The threads.* entries come from fluxerapp/fluxer commit 4749eb7f866ceba0c9622014a9824900d5be8172, where paths
    // starting with packages/ are relative to the repository root. Fluxer reads a thread's permissions in its parent
    // channel, and a thread it cannot view fails with MISSING_ACCESS instead, so thread-targeted entries leave out
    // View Channel. Join, leave, fetchActive and member reads have no entry because none of their checks fails with
    // MISSING_PERMISSIONS.
    // channel/services/BaseChannelAuthService.ts:248, channel/services/thread/ThreadCreationService.ts:378,
    // packages/constants/src/ThreadPermissionUtils.ts:214-231
    "threads.create": requires(
        "channel",
        ["ViewChannel", "CreatePublicThreads"],
        `A private thread needs ${label("CreatePrivateThreads")} instead`,
    ),
    // channel/services/BaseChannelAuthService.ts:248, channel/services/thread/ThreadCreationService.ts:120, 378,
    // packages/constants/src/ThreadPermissionUtils.ts:222-225
    "threads.createFromMessage": requires("channel", ["ViewChannel", "CreatePublicThreads", "ReadMessageHistory"]),
    // channel/services/BaseChannelAuthService.ts:248, channel/services/thread/ThreadCreationService.ts:228, 236,
    // channel/services/message/MessageSendService.ts:254-298
    "threads.createPost": requires(
        "channel",
        ["ViewChannel", "SendMessages"],
        `Embeds in the first message also need ${label("EmbedLinks")}, and files need ${label("AttachFiles")}`,
    ),
    // channel/services/thread/ThreadModifyService.ts:137, packages/constants/src/ThreadPermissionUtils.ts:124-158
    "threads.edit": requires(
        "channel",
        ["ManageThreads"],
        "The thread's creator needs it only to unlock the thread or change rateLimitPerUser, pinned or moderated tags, and every change in a locked thread needs it",
    ),
    // channel/services/BaseChannelAuthService.ts:248, channel/services/thread/ThreadListService.ts:144,
    // packages/constants/src/ThreadPermissionUtils.ts:233-241
    "threads.fetchArchived": requires(
        "channel",
        ["ViewChannel", "ReadMessageHistory"],
        `Listing private archived threads also needs ${label("ManageThreads")}`,
    ),
    // channel/services/BaseChannelAuthService.ts:248, channel/services/thread/ThreadForumService.ts:217
    "threads.search": requires("channel", ["ViewChannel", "ReadMessageHistory"]),
    // channel/services/thread/ThreadMemberService.ts:80, packages/constants/src/ThreadPermissionUtils.ts:179-193
    "threads.addMember": requires(
        "channel",
        ["SendMessagesInThreads"],
        `Adding to a private thread that is not invitable also needs ${label("ManageThreads")}, unless the added member has it`,
    ),
    // channel/services/thread/ThreadMemberService.ts:105, packages/constants/src/ThreadPermissionUtils.ts:195-201
    "threads.removeMember": requires(
        "channel",
        ["ManageThreads"],
        "The creator of a private thread can remove its members without it",
    ),
}

/** What Fluxer requires for an operation, or undefined when its permission checks are not tied to one set */
export function permissionRequirement(operation: string): PermissionRequirement | undefined {
    return Object.hasOwn(permissionRequirements, operation) ? permissionRequirements[operation as Operation] : undefined
}

/** The suggested fix for a missing-permission rejection of an operation with a known requirement */
export function requiredPermissionsHint(requirement: PermissionRequirement): string {
    const labels = requirement.permissions.map((name) => label(name))
    const list = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`
    const them = labels.length === 1 ? "it" : "them"
    // A channel's permission overrides title some permissions differently, so name those titles to be found there
    const titled = requirement.permissions.flatMap((name) => {
        const title = channelScreenLabel(name)
        return title === undefined ? [] : [`${label(name)} is titled "${title}"`]
    })
    const channelTitles = titled.length === 0 ? "" : `, where ${titled.join(" and ")}`
    const where = {
        channel: `Grant ${them} to the bot's role in the community settings or the channel's permission overrides${channelTitles}`,
        guild: `Grant ${them} to the bot's role in the community settings`,
        guildAndChannel: `Grant ${them} to the bot's role in the community settings, and check that the channel's permission overrides do not deny ${them}${channelTitles}`,
    }[requirement.scope]
    return [`The bot needs ${list} for this operation`, where, requirement.also]
        .filter((part) => part !== undefined)
        .join(". ")
}
