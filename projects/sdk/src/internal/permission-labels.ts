/**
 * Fluxer's English permission labels, shared by permissionBits.label, missing-permission hints and guard denials.
 * Invariant: Each label is the title that Fluxer's own client shows for the permission, from
 * fluxer_app/src/features/permissions/utils/PermissionLabelDescriptors.ts at commit 8a7c791, never derived from the
 * identifier. Fluxer's client fills the mention-everyone title from its @everyone, @here and @roles placeholders
 * Implements [SDK contracts: Validation requirements](/docs/SDK-CONTRACTS.md#validation-requirements)
 */
import type { PermissionName } from "#sdk/helpers"

/** The label of every permission, checked against the permission names at compile time */
const permissionLabels = Object.freeze({
    CreateInstantInvite: "Create invite links",
    KickMembers: "Kick members",
    BanMembers: "Ban members",
    Administrator: "Administrator",
    ManageChannels: "Manage channels",
    ManageGuild: "Manage community",
    AddReactions: "Add reactions",
    ViewAuditLog: "View activity log",
    PrioritySpeaker: "Priority speaker",
    Stream: "Stream video",
    ViewChannel: "View channel",
    SendMessages: "Send messages",
    SendTtsMessages: "Send TTS messages",
    ManageMessages: "Manage messages",
    EmbedLinks: "Embed links",
    AttachFiles: "Attach files",
    ReadMessageHistory: "Read message history",
    MentionEveryone: "Use @everyone/@here and @roles",
    UseExternalEmojis: "Use external emoji",
    Connect: "Connect to voice",
    Speak: "Speak",
    MuteMembers: "Mute members",
    DeafenMembers: "Deafen members",
    MoveMembers: "Move members",
    UseVad: "Use voice activity",
    ChangeNickname: "Change own nickname",
    ManageNicknames: "Manage nicknames",
    ManageRoles: "Manage roles",
    ManageWebhooks: "Manage webhooks",
    ManageExpressions: "Manage emoji & stickers",
    ManageThreads: "Manage threads",
    CreatePublicThreads: "Create public threads",
    CreatePrivateThreads: "Create private threads",
    UseExternalStickers: "Use external stickers",
    SendMessagesInThreads: "Send messages in threads",
    ModerateMembers: "Time out members",
    CreateExpressions: "Create emoji & stickers",
    PinMessages: "Pin messages",
    BypassSlowmode: "Bypass slowmode",
    UpdateRtcRegion: "Set voice region",
    ViewChannelMembers: "View channel members",
} satisfies Record<PermissionName, string>)

/** The label of a permission name already known to be valid */
export const permissionLabel = (name: PermissionName): string => permissionLabels[name]

/**
 * The titles that differ inside a channel's own permission screen, where Fluxer shows ManageChannels as "Manage channel" and
 * ManageRoles as "Manage permissions" (CHANNEL_PERMISSION_TITLE_OVERRIDES in the same file). Every other title is the same there
 */
const channelScreenLabels: Readonly<Partial<Record<PermissionName, string>>> = Object.freeze({
    ManageChannels: "Manage channel",
    ManageRoles: "Manage permissions",
})

/** The title of a permission in a channel's permission screen, or undefined when it matches the community-wide label */
export const channelScreenLabel = (name: PermissionName): string | undefined => channelScreenLabels[name]
