/**
 * Guild channel projection: Decoders for REST and gateway channel, thread, thread member and forum tag data, shared by
 * channel operations, the channel cache, gateway dispatch and the message, search and audit-log projections.
 * Invariant: Each known ChannelType number decodes into its own frozen shape and any other number into "unknown" with
 * rawType. A thread needs its parent, owner, name and metadata. Unknown flag bits, enum numbers and tag-setting strings
 * are kept, and a malformed field rejects the whole payload rather than being dropped.
 * Implements [SDK contracts: Validation requirements](/docs/SDK-CONTRACTS.md#validation-requirements)
 */
import {
    ChannelType,
    isThreadChannel,
    type ForumDefaultReaction,
    type ForumTag,
    type GuildChannel,
    type GuildChannelUpdateBulk,
    type GuildThreadChannel,
    type PermissionOverwrite,
    type ThreadMember,
    type ThreadMembership,
} from "#sdk/channels"
import { count as nonNegativeInt32, identifier, int32, record } from "./decode/primitives.js"
import { timestamp } from "./decode/timestamp.js"
import { decodeMember } from "./guilds.js"

const maxUnsignedPermission = 18_446_744_073_709_551_615n

const nullableText = (value: unknown): value is string | null => value === null || typeof value === "string"
const nullableIdentifier = (value: unknown): value is string | null => value === null || identifier(value)
const unsignedPermission = (value: unknown): value is bigint =>
    typeof value === "bigint" && value >= 0n && value <= maxUnsignedPermission

export const channelEvents = {
    CHANNEL_CREATE: "guildChannelCreate",
    CHANNEL_UPDATE: "guildChannelUpdate",
    CHANNEL_DELETE: "guildChannelDelete",
    CHANNEL_UPDATE_BULK: "guildChannelUpdateBulk",
} as const

/** ChannelType numbers this SDK version decodes into a type-specific shape, and any other number becomes "unknown" */
const knownChannelTypes: ReadonlySet<number> = new Set(Object.values(ChannelType))
const threadTypes: ReadonlySet<number> = new Set([
    ChannelType.AnnouncementThread,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
])
const forumTypes: ReadonlySet<number> = new Set([ChannelType.Forum, ChannelType.Media])
/** Channels that can hold threads besides forum and media channels, on which Fluxer sends stored thread defaults */
const threadDefaultsTypes: ReadonlySet<number> = new Set([ChannelType.Text, ChannelType.Announcement])

/** An absolute URL. Channel validation shares this rule with decoding */
export function url(value: unknown): value is string {
    if (typeof value !== "string" || value.length === 0) return false
    try {
        new URL(value)
        return true
    } catch {
        // allow-silent: An unparsable URL is reported as invalid input or a malformed payload by the caller
        return false
    }
}

function text(value: unknown, minimum: number, maximum: number): value is string {
    // oxlint-disable-next-line typescript/no-misused-spread -- length limits count Unicode code points
    return typeof value === "string" && [...value].length >= minimum && [...value].length <= maximum
}

function decodeOverwrite(value: unknown): PermissionOverwrite | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        (value.type !== 0 && value.type !== 1) ||
        typeof value.allow !== "string" ||
        typeof value.deny !== "string" ||
        !/^(0|[1-9][0-9]{0,19})$/.test(value.allow) ||
        !/^(0|[1-9][0-9]{0,19})$/.test(value.deny)
    )
        return undefined
    const allow = BigInt(value.allow)
    const deny = BigInt(value.deny)
    if (!unsignedPermission(allow) || !unsignedPermission(deny)) return undefined
    return Object.freeze({ id: value.id, type: value.type === 0 ? "role" : "member", allow, deny })
}

function decodeOverwrites(value: unknown): readonly PermissionOverwrite[] | undefined {
    if (!Array.isArray(value)) return undefined
    const overwrites: PermissionOverwrite[] = []
    const ids = new Set<string>()
    for (const item of value) {
        const overwrite = decodeOverwrite(item)
        if (!overwrite || ids.has(overwrite.id)) return undefined
        ids.add(overwrite.id)
        overwrites.push(overwrite)
    }
    return Object.freeze(overwrites)
}

/** Fields any community channel can carry, validated whatever its type */
function decodeCommonFields(value: Record<string, unknown>): Record<string, unknown> | undefined {
    if (
        !identifier(value.id) ||
        !identifier(value.guild_id) ||
        !nonNegativeInt32(value.type) ||
        (value.name !== undefined && typeof value.name !== "string") ||
        (value.topic !== undefined && !nullableText(value.topic)) ||
        (value.url !== undefined && value.url !== null && !url(value.url)) ||
        (value.position !== undefined && !int32(value.position)) ||
        (value.parent_id !== undefined && !nullableIdentifier(value.parent_id)) ||
        (value.bitrate !== undefined && value.bitrate !== null && !int32(value.bitrate)) ||
        (value.user_limit !== undefined && value.user_limit !== null && !int32(value.user_limit)) ||
        (value.voice_connection_limit !== undefined &&
            value.voice_connection_limit !== null &&
            !int32(value.voice_connection_limit)) ||
        (value.rtc_region !== undefined && !nullableText(value.rtc_region)) ||
        (value.last_message_id !== undefined && !nullableIdentifier(value.last_message_id)) ||
        (value.last_pin_timestamp !== undefined &&
            value.last_pin_timestamp !== null &&
            !timestamp(value.last_pin_timestamp)) ||
        (value.nsfw !== undefined && typeof value.nsfw !== "boolean") ||
        (value.nsfw_override !== undefined &&
            value.nsfw_override !== null &&
            typeof value.nsfw_override !== "boolean") ||
        (value.content_warning_level !== undefined &&
            value.content_warning_level !== 0 &&
            value.content_warning_level !== 1) ||
        (value.content_warning_text !== undefined &&
            value.content_warning_text !== null &&
            !text(value.content_warning_text, 0, 200)) ||
        (value.rate_limit_per_user !== undefined && !int32(value.rate_limit_per_user))
    )
        return undefined
    const permissionOverwrites =
        value.permission_overwrites === undefined ? undefined : decodeOverwrites(value.permission_overwrites)
    if (value.permission_overwrites !== undefined && permissionOverwrites === undefined) return undefined
    return {
        id: value.id,
        guildId: value.guild_id,
        ...(value.name === undefined ? {} : { name: value.name }),
        ...(value.topic === undefined ? {} : { topic: value.topic }),
        ...(value.url === undefined ? {} : { url: value.url }),
        ...(value.position === undefined ? {} : { position: value.position }),
        ...(value.parent_id === undefined ? {} : { parentId: value.parent_id }),
        ...(value.bitrate === undefined ? {} : { bitrate: value.bitrate }),
        ...(value.user_limit === undefined ? {} : { userLimit: value.user_limit }),
        ...(value.voice_connection_limit === undefined ? {} : { voiceConnectionLimit: value.voice_connection_limit }),
        ...(value.rtc_region === undefined ? {} : { rtcRegion: value.rtc_region }),
        ...(value.last_message_id === undefined ? {} : { lastMessageId: value.last_message_id }),
        ...(value.last_pin_timestamp === undefined ? {} : { lastPinTimestamp: value.last_pin_timestamp }),
        ...(permissionOverwrites === undefined ? {} : { permissionOverwrites }),
        ...(value.nsfw === undefined ? {} : { nsfw: value.nsfw }),
        ...(value.nsfw_override === undefined ? {} : { nsfwOverride: value.nsfw_override }),
        ...(value.content_warning_level === undefined ? {} : { contentWarningLevel: value.content_warning_level }),
        ...(value.content_warning_text === undefined ? {} : { contentWarningText: value.content_warning_text }),
        ...(value.rate_limit_per_user === undefined ? {} : { rateLimitPerUser: value.rate_limit_per_user }),
    }
}

/** The stored defaults a parent channel gives new threads, sent only when stored on text and announcement channels */
function decodeThreadDefaults(value: Record<string, unknown>): Record<string, unknown> | undefined {
    if (
        (value.default_auto_archive_duration !== undefined &&
            value.default_auto_archive_duration !== null &&
            !nonNegativeInt32(value.default_auto_archive_duration)) ||
        (value.default_thread_rate_limit_per_user !== undefined &&
            !nonNegativeInt32(value.default_thread_rate_limit_per_user))
    )
        return undefined
    return {
        ...(value.default_auto_archive_duration === undefined
            ? {}
            : { defaultAutoArchiveMinutes: value.default_auto_archive_duration }),
        ...(value.default_thread_rate_limit_per_user === undefined
            ? {}
            : { defaultThreadRateLimitPerUser: value.default_thread_rate_limit_per_user }),
    }
}

/** Decode one forum or media channel tag */
export function decodeForumTag(value: unknown): ForumTag | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        typeof value.name !== "string" ||
        typeof value.moderated !== "boolean" ||
        !nullableIdentifier(value.emoji_id) ||
        !nullableText(value.emoji_name)
    )
        return undefined
    return Object.freeze({
        id: value.id,
        name: value.name,
        moderated: value.moderated,
        emojiId: value.emoji_id,
        emojiName: value.emoji_name,
    })
}

/** Decode the reaction a forum or media channel suggests on each post */
export function decodeForumDefaultReaction(value: unknown): ForumDefaultReaction | undefined {
    if (!record(value) || !nullableIdentifier(value.emoji_id) || !nullableText(value.emoji_name)) return undefined
    return Object.freeze({ emojiId: value.emoji_id, emojiName: value.emoji_name })
}

/**
 * Forum and media channel settings. Fluxer leaves them out of some payloads, such as CHANNEL_DELETE, so each one is
 * optional
 */
function decodeForumFields(value: Record<string, unknown>, type: number): Record<string, unknown> | undefined {
    const defaults = decodeThreadDefaults(value)
    if (
        !defaults ||
        (value.flags !== undefined && !int32(value.flags)) ||
        (value.available_tags !== undefined && !Array.isArray(value.available_tags)) ||
        (value.default_sort_order !== undefined &&
            value.default_sort_order !== null &&
            !int32(value.default_sort_order)) ||
        (value.default_forum_layout !== undefined && !int32(value.default_forum_layout)) ||
        (value.default_tag_setting !== undefined && typeof value.default_tag_setting !== "string")
    )
        return undefined
    const tags: ForumTag[] = []
    const tagIds = new Set<string>()
    for (const item of (value.available_tags as readonly unknown[] | undefined) ?? []) {
        const tag = decodeForumTag(item)
        if (!tag || tagIds.has(tag.id)) return undefined
        tagIds.add(tag.id)
        tags.push(tag)
    }
    const reaction =
        value.default_reaction_emoji === undefined || value.default_reaction_emoji === null
            ? value.default_reaction_emoji
            : decodeForumDefaultReaction(value.default_reaction_emoji)
    if (value.default_reaction_emoji !== undefined && reaction === undefined) return undefined
    return {
        ...defaults,
        ...(value.flags === undefined ? {} : { flags: value.flags }),
        ...(value.available_tags === undefined ? {} : { availableTags: Object.freeze(tags) }),
        ...(reaction === undefined ? {} : { defaultReactionEmoji: reaction }),
        ...(value.default_sort_order === undefined ? {} : { defaultSortOrder: value.default_sort_order }),
        ...(value.default_tag_setting === undefined ? {} : { defaultTagSetting: value.default_tag_setting }),
        ...(type !== ChannelType.Forum || value.default_forum_layout === undefined
            ? {}
            : { defaultForumLayout: value.default_forum_layout }),
    }
}

/** The bot's own membership supplied inline on a thread, whose id and user_id Fluxer can leave out */
function decodeThreadMembership(value: unknown): ThreadMembership | undefined {
    if (!record(value) || !timestamp(value.join_timestamp) || !int32(value.flags)) return undefined
    return Object.freeze({ joinedAt: value.join_timestamp, flags: value.flags })
}

/** Thread metadata and counters, flattened onto the thread shape */
function decodeThreadFields(value: Record<string, unknown>, type: number): Record<string, unknown> | undefined {
    const metadata = value.thread_metadata
    if (
        !identifier(value.parent_id) ||
        !identifier(value.owner_id) ||
        typeof value.name !== "string" ||
        !record(metadata) ||
        typeof metadata.archived !== "boolean" ||
        typeof metadata.locked !== "boolean" ||
        !nonNegativeInt32(metadata.auto_archive_duration) ||
        !timestamp(metadata.archive_timestamp) ||
        !timestamp(metadata.create_timestamp) ||
        (metadata.invitable !== undefined && typeof metadata.invitable !== "boolean") ||
        // Fluxer always reports invitable on a private thread
        (type === ChannelType.PrivateThread && metadata.invitable === undefined) ||
        (value.flags !== undefined && !int32(value.flags)) ||
        (value.message_count !== undefined && !nonNegativeInt32(value.message_count)) ||
        (value.total_message_sent !== undefined && !nonNegativeInt32(value.total_message_sent)) ||
        (value.member_count !== undefined && !nonNegativeInt32(value.member_count)) ||
        (value.applied_tags !== undefined &&
            (!Array.isArray(value.applied_tags) || !value.applied_tags.every(identifier)))
    )
        return undefined
    const membership = value.member === undefined ? undefined : decodeThreadMembership(value.member)
    if (value.member !== undefined && membership === undefined) return undefined
    return {
        parentId: value.parent_id,
        ownerId: value.owner_id,
        name: value.name,
        archived: metadata.archived,
        locked: metadata.locked,
        autoArchiveMinutes: metadata.auto_archive_duration,
        archiveTimestamp: metadata.archive_timestamp,
        createdAt: metadata.create_timestamp,
        ...(value.flags === undefined ? {} : { flags: value.flags }),
        ...(value.message_count === undefined ? {} : { messageCount: value.message_count }),
        ...(value.total_message_sent === undefined ? {} : { totalMessageSent: value.total_message_sent }),
        ...(value.member_count === undefined ? {} : { memberCount: value.member_count }),
        // Only a forum or media post, which is always a public thread, carries tags
        ...(type !== ChannelType.PublicThread || value.applied_tags === undefined
            ? {}
            : { appliedTagIds: Object.freeze([...(value.applied_tags as string[])]) }),
        ...(type === ChannelType.PrivateThread ? { invitable: metadata.invitable } : {}),
        ...(membership === undefined ? {} : { membership }),
    }
}

/** Decode a complete guild-channel response, with private channels and malformed payloads returning undefined */
export function decodeGuildChannel(value: unknown): GuildChannel | undefined {
    if (!record(value)) return undefined
    const decoded = decodeCommonFields(value)
    if (!decoded) return undefined
    const type = value.type as number
    // Fluxer sends last_pin_timestamp on forum and media channels, which hold no messages, so their shapes leave it out
    const { lastPinTimestamp: _lastPinTimestamp, ...withoutPins } = decoded
    const common = forumTypes.has(type) ? withoutPins : decoded
    const specific = threadTypes.has(type)
        ? decodeThreadFields(value, type)
        : forumTypes.has(type)
          ? decodeForumFields(value, type)
          : threadDefaultsTypes.has(type)
            ? decodeThreadDefaults(value)
            : {}
    if (!specific) return undefined
    return Object.freeze({
        ...common,
        ...specific,
        // An unknown number keeps its value in rawType, so a ChannelType comparison can never match this shape
        ...(knownChannelTypes.has(type) ? { type } : { type: "unknown" as const, rawType: type }),
    }) as GuildChannel
}

export function decodeGuildChannels(value: unknown, guildId: string): readonly GuildChannel[] | undefined {
    if (!Array.isArray(value)) return undefined
    const channels: GuildChannel[] = []
    const ids = new Set<string>()
    for (const item of value) {
        const channel = decodeGuildChannel(item)
        if (!channel || channel.guildId !== guildId || ids.has(channel.id)) return undefined
        ids.add(channel.id)
        channels.push(channel)
    }
    return Object.freeze(channels)
}

/** Decode only guild-scoped channel events, with private-channel events intentionally returning undefined */
export function decodeChannelEvent(event: keyof typeof channelEvents, value: unknown) {
    if (event !== "CHANNEL_UPDATE_BULK") return decodeGuildChannel(value)
    if (!record(value) || !identifier(value.guild_id)) return undefined
    const channels = decodeGuildChannels(value.channels, value.guild_id)
    return channels === undefined
        ? undefined
        : Object.freeze({ guildId: value.guild_id, channels } satisfies GuildChannelUpdateBulk)
}

/** Decode one thread, with any other channel type or a malformed payload returning undefined */
export function decodeThread(value: unknown): GuildThreadChannel | undefined {
    const channel = decodeGuildChannel(value)
    return isThreadChannel(channel) ? channel : undefined
}

/**
 * Decode one thread member. The nested guild member needs the thread's guild ID, which thread member payloads do not
 * carry. A payload without its thread ID takes threadId, and one that has it must match threadId when given. A null
 * member, which Fluxer sends for a user without a guild membership, leaves member out
 */
export function decodeThreadMember(value: unknown, guildId: string, threadId?: string): ThreadMember | undefined {
    if (!record(value) || !identifier(value.user_id) || !timestamp(value.join_timestamp) || !int32(value.flags))
        return undefined
    const id = value.id === undefined ? threadId : value.id
    if (!identifier(id) || (threadId !== undefined && id !== threadId)) return undefined
    const member = value.member === undefined || value.member === null ? undefined : decodeMember(value.member, guildId)
    if (value.member !== undefined && value.member !== null && member === undefined) return undefined
    return Object.freeze({
        threadId: id,
        userId: value.user_id,
        joinedAt: value.join_timestamp,
        flags: value.flags,
        ...(member === undefined ? {} : { member }),
    })
}

/**
 * Decode a thread list together with the bot's memberships that Fluxer lists beside it, folding each membership into
 * its thread. A duplicate thread, a membership naming no listed thread and a second membership for one thread are
 * malformed, so the whole list is rejected rather than losing or mixing memberships
 */
export function decodeThreadList(threads: unknown, members: unknown): readonly GuildThreadChannel[] | undefined {
    if (!Array.isArray(threads) || !Array.isArray(members)) return undefined
    const decoded = new Map<string, GuildThreadChannel>()
    for (const item of threads) {
        const thread = decodeThread(item)
        if (!thread || decoded.has(thread.id)) return undefined
        decoded.set(thread.id, thread)
    }
    const folded = new Set<string>()
    for (const item of members) {
        const thread = record(item) && identifier(item.id) ? decoded.get(item.id) : undefined
        if (!thread || folded.has(thread.id)) return undefined
        const member = decodeThreadMember(item, thread.guildId, thread.id)
        if (!member) return undefined
        folded.add(thread.id)
        const membership: ThreadMembership = Object.freeze({ joinedAt: member.joinedAt, flags: member.flags })
        decoded.set(thread.id, Object.freeze({ ...thread, membership }))
    }
    return Object.freeze([...decoded.values()])
}
