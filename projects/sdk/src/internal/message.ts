/**
 * Message encoding, projection and reference snapshots for the message operations that REST schedules.
 * Invariant: Fetch, edit and delete reuse REST admission with provisional route groups, learned buckets and shared global limits,
 * and their failures stay separate from the send and reply delivery contract. Repeated deletion or a missing target never proves a
 * prior operation succeeded. History pages are explicit requests, independent of cache reads and gateway events. Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import { EmbedBuilder } from "#sdk/builders"
import { MessageFlags } from "#sdk/messages"
import type {
    Message,
    CrosspostSource,
    CrosspostSourceGuild,
    MessageInput,
    MessageReference,
    MessageDeletion,
    MessageBulkDeletion,
    MessageUser,
    MessageChannelMention,
    MessageReactionSummary,
    MessageContextReference,
    MessageSnapshot,
    MessageSticker,
    MessageField,
    ReferencedMessage,
} from "#sdk/messages"
import type { GatewayMessageDispatch, MessageObservation } from "./message-fields.js"
import { MessageError } from "#sdk/message-errors"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"
import { decodeEmbeds, encodeEmbeds, type EmbedAttachmentFiles } from "./embeds.js"
import { decodeAttachments, encodeAttachments, type EncodedBody, type WaveformTarget } from "./attachments.js"
import { decodeThread } from "./channel-decode.js"
import { decodeDeletionMember, decodeDispatchMember } from "./guilds.js"
import { count, fieldsOnce, identifier, inputId, inputIds, int32, record } from "./decode/primitives.js"
import { timestamp } from "./decode/timestamp.js"
import { normalizedText } from "./field-text.js"

const writableMessageFlags = MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications
/** Whether a flags value is a whole number Fluxer reads as a nonnegative 32-bit integer */
const writableFlagRange = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647
const writableFlags = (value: unknown): value is number =>
    writableFlagRange(value) && (value & ~writableMessageFlags) === 0

/** Decode the public source snapshot separately from Guild so it cannot enter the guild cache */
export function decodeCrosspostSource(value: unknown): CrosspostSource | undefined {
    if (!record(value) || !record(value.guild)) return undefined
    const guild = value.guild
    if (
        !identifier(guild.id) ||
        typeof guild.name !== "string" ||
        (guild.description !== null && typeof guild.description !== "string") ||
        !Array.isArray(guild.features) ||
        (guild.approximate_member_count !== null && !count(guild.approximate_member_count)) ||
        (guild.approximate_presence_count !== null && !count(guild.approximate_presence_count)) ||
        typeof guild.discoverable !== "boolean" ||
        (guild.icon !== undefined && guild.icon !== null && typeof guild.icon !== "string") ||
        (guild.banner !== undefined && guild.banner !== null && typeof guild.banner !== "string") ||
        (guild.badge_ids !== undefined && !(Array.isArray(guild.badge_ids) && guild.badge_ids.every(identifier)))
    )
        return undefined
    const features: Array<CrosspostSourceGuild["features"][number]> = []
    for (const feature of guild.features) {
        if (typeof feature !== "string") return undefined
        features.push(feature)
    }
    return Object.freeze({
        guild: Object.freeze({
            id: guild.id,
            name: guild.name,
            description: guild.description,
            features: Object.freeze(features),
            approximateMemberCount: guild.approximate_member_count,
            approximatePresenceCount: guild.approximate_presence_count,
            discoverable: guild.discoverable,
            ...(guild.icon === undefined ? {} : { icon: guild.icon }),
            ...(guild.banner === undefined ? {} : { banner: guild.banner }),
            ...(guild.badge_ids === undefined ? {} : { badgeIds: Object.freeze([...(guild.badge_ids as string[])]) }),
        }),
    })
}

export function decodeMessage(value: unknown): Message | undefined
export function decodeMessage(
    value: unknown,
    fields: ReadonlySet<MessageField> | undefined,
): MessageObservation | undefined
/** Selection changes construction only. Every recognized wire field keeps the full decoder's validation rules */
export function decodeMessage(value: unknown, fields?: ReadonlySet<MessageField>): MessageObservation | undefined {
    const decoded = decodeMessageValue(value, fields, true, true)
    return decoded === true ? undefined : decoded
}

/**
 * Decode a MESSAGE_CREATE or MESSAGE_UPDATE body, which unlike a REST message can carry the author's member.
 * The member is a decoration, so one that does not decode is left out and never costs the message.
 * MESSAGE_CREATE alone adds mention_here, channel_type and nicks, which Fluxer's documents exclude from MESSAGE_UPDATE.
 * Like the REST fields they are validated whatever the selection, and a malformed value rejects the message
 */
export function decodeGatewayMessage(
    value: unknown,
    fields: ReadonlySet<MessageField> | undefined,
    type: GatewayMessageDispatch,
): MessageObservation | undefined {
    const decoded = decodeMessage(value, fields)
    if (decoded === undefined) return decoded
    const created = type === "MESSAGE_CREATE" ? decodeCreatedFields(value, fields) : {}
    if (created === undefined) return undefined
    const member = fields !== undefined && !fields.has("member") ? undefined : decodeDispatchMember(type, value)
    return Object.freeze({ ...decoded, ...created, ...(member === undefined ? {} : { member }) })
}

/** The fields only a created message carries, left out when absent or not selected */
function decodeCreatedFields(
    value: unknown,
    fields: ReadonlySet<MessageField> | undefined,
): Pick<Message, "mentionedHere" | "channelType" | "nicknames"> | undefined {
    if (!record(value)) return undefined
    if (
        (value.mention_here !== undefined && typeof value.mention_here !== "boolean") ||
        (value.channel_type !== undefined && !int32(value.channel_type))
    )
        return undefined
    let nicknames: Record<string, string> | undefined
    if (value.nicks !== undefined) {
        if (!record(value.nicks)) return undefined
        nicknames = {}
        for (const [id, nick] of Object.entries(value.nicks)) {
            if (!identifier(id) || typeof nick !== "string") return undefined
            nicknames[id] = nick
        }
    }
    const selected = (field: MessageField) => fields === undefined || fields.has(field)
    return {
        ...(!selected("mentionedHere") || value.mention_here === undefined
            ? {}
            : { mentionedHere: value.mention_here }),
        ...(!selected("channelType") || value.channel_type === undefined ? {} : { channelType: value.channel_type }),
        ...(!selected("nicknames") || nicknames === undefined ? {} : { nicknames: Object.freeze(nicknames) }),
    }
}

/** The wire fields a message's scalar checks establish */
type MessageWire = Record<string, unknown> & {
    readonly id: string
    readonly channel_id: string
    readonly content: string
    readonly pinned?: boolean
    readonly tts?: boolean
    readonly timestamp?: string
    readonly edited_timestamp?: string | null
    readonly type?: number
    readonly flags?: number
    readonly guild_id?: string
    readonly mention_everyone?: boolean
    readonly nonce?: string | null
    readonly webhook_id?: string | null
}

function validMessageFields(value: unknown): value is MessageWire {
    if (!record(value) || !identifier(value.id) || !identifier(value.channel_id) || typeof value.content !== "string")
        return false
    if (
        (value.pinned !== undefined && typeof value.pinned !== "boolean") ||
        (value.tts !== undefined && typeof value.tts !== "boolean") ||
        (value.timestamp !== undefined && !timestamp(value.timestamp)) ||
        (value.edited_timestamp !== undefined &&
            value.edited_timestamp !== null &&
            !timestamp(value.edited_timestamp)) ||
        (value.type !== undefined && !int32(value.type)) ||
        (value.flags !== undefined && !int32(value.flags)) ||
        (value.guild_id !== undefined && !identifier(value.guild_id)) ||
        (value.mention_everyone !== undefined && typeof value.mention_everyone !== "boolean") ||
        (value.nonce !== undefined && value.nonce !== null && typeof value.nonce !== "string")
    )
        return false
    return !(value.webhook_id != null && !identifier(value.webhook_id))
}

/** Decode a message's nested objects in wire order, returning undefined at the first invalid one. Each part is checked
 * before the next is read, so failingFieldPath names the part that failed rather than a later one
 */
function decodeMessageParts(
    value: MessageWire,
    selected: (field: MessageField) => boolean,
    allowReferencedMessage: boolean,
) {
    const embeds = decodeEmbeds(value.embeds, selected("embeds"))
    if (embeds === undefined) return undefined
    const attachments = decodeAttachments(value.attachments, selected("attachments"))
    if (attachments === undefined) return undefined
    const stickers = decodeStickers(value.stickers, selected("stickers"))
    if (stickers === undefined) return undefined
    const mentions = decodeMentions(value.mentions, selected("mentions"))
    if (mentions === undefined) return undefined
    const referencedUsers = decodeReferencedUsers(value.users, selected("referencedUsers"))
    if (referencedUsers === undefined) return undefined
    const mentionRoles = decodeIdentifiers(value.mention_roles, selected("mentionRoleIds"))
    if (mentionRoles === undefined) return undefined
    const nsfwEmojiIds = decodeIdentifiers(value.nsfw_emojis, selected("nsfwEmojiIds"))
    if (nsfwEmojiIds === undefined) return undefined
    const mentionChannels = decodeMentionChannels(value.mention_channels, selected("mentionChannels"))
    if (mentionChannels === undefined) return undefined
    const reactions = decodeReactionSummaries(value.reactions, selected("reactions"))
    if (reactions === undefined) return undefined
    const messageReference = decodeMessageReference(value.message_reference, selected("messageReference"))
    if (messageReference === undefined) return undefined
    const messageSnapshots = decodeMessageSnapshots(value.message_snapshots, selected("messageSnapshots"))
    if (messageSnapshots === undefined) return undefined
    const referencedMessage = allowReferencedMessage
        ? decodeReferencedMessage(value.referenced_message, selected("referencedMessage"))
        : "referenced_message" in value
          ? undefined
          : unobserved
    if (referencedMessage === undefined) return undefined
    const thread = value.thread === undefined ? undefined : decodeThread(value.thread)
    if (value.thread !== undefined && thread === undefined) return undefined
    return {
        embeds,
        attachments,
        stickers,
        mentions,
        referencedUsers,
        mentionRoles,
        nsfwEmojiIds,
        mentionChannels,
        reactions,
        messageReference,
        messageSnapshots,
        referencedMessage,
        thread,
    }
}

/** The selected scalar fields of a validated message */
function messageScalarFields(value: MessageWire, selected: (field: MessageField) => boolean) {
    return {
        ...(!selected("nonce") || value.nonce === undefined ? {} : { nonce: value.nonce }),
        ...(!selected("webhookId") || value.webhook_id == null ? {} : { webhookId: value.webhook_id }),
        ...(!selected("pinned") || value.pinned === undefined ? {} : { pinned: value.pinned }),
        ...(!selected("tts") || value.tts === undefined ? {} : { tts: value.tts }),
        ...(!selected("createdAt") || value.timestamp === undefined ? {} : { createdAt: value.timestamp }),
        ...(!selected("editedAt") || value.edited_timestamp === undefined ? {} : { editedAt: value.edited_timestamp }),
        ...(value.type === undefined ? {} : { type: value.type }),
        ...(!selected("flags") || value.flags === undefined ? {} : { flags: value.flags }),
        ...(value.guild_id === undefined ? {} : { guildId: value.guild_id }),
        ...(!selected("mentionedEveryone") || value.mention_everyone === undefined
            ? {}
            : { mentionedEveryone: value.mention_everyone }),
    }
}

/** The selected nested objects of a validated message */
function messagePartFields(
    parts: NonNullable<ReturnType<typeof decodeMessageParts>>,
    selected: (field: MessageField) => boolean,
) {
    const { embeds, attachments, stickers, mentions, referencedUsers, mentionRoles, nsfwEmojiIds } = parts
    const { mentionChannels, reactions, messageReference, messageSnapshots, referencedMessage, thread } = parts
    return {
        ...(embeds === true ? {} : { embeds }),
        ...(attachments === true ? {} : { attachments }),
        ...(stickers === true ? {} : { stickers }),
        ...(mentions.value === undefined ? {} : { mentions: mentions.value }),
        ...(referencedUsers.value === undefined ? {} : { referencedUsers: referencedUsers.value }),
        ...(mentionRoles.value === undefined ? {} : { mentionRoleIds: mentionRoles.value }),
        ...(nsfwEmojiIds.value === undefined ? {} : { nsfwEmojiIds: nsfwEmojiIds.value }),
        ...(mentionChannels.value === undefined ? {} : { mentionChannels: mentionChannels.value }),
        ...(reactions.value === undefined ? {} : { reactions: reactions.value }),
        ...(messageReference.value === undefined ? {} : { messageReference: messageReference.value }),
        ...(messageSnapshots.value === undefined ? {} : { messageSnapshots: messageSnapshots.value }),
        ...(referencedMessage.value === undefined ? {} : { referencedMessage: referencedMessage.value }),
        ...(!selected("thread") || thread === undefined ? {} : { thread }),
    }
}

function decodeMessageValue(
    value: unknown,
    fields: ReadonlySet<MessageField> | undefined,
    allowReferencedMessage: boolean,
    construct: boolean,
): MessageObservation | true | undefined {
    if (!validMessageFields(value)) return undefined
    const author = decodeMessageUser(value.author, construct)
    if (!author) return undefined
    const selected = (field: MessageField) => construct && (fields === undefined || fields.has(field))
    const parts = decodeMessageParts(value, selected, allowReferencedMessage)
    if (!parts) return undefined
    if (!construct) return true
    return Object.freeze({
        id: value.id,
        channelId: value.channel_id,
        content: value.content,
        ...messageScalarFields(value, selected),
        ...messagePartFields(parts, selected),
        author: author as MessageUser,
    })
}

type Observed<A> = { readonly value: A | undefined }
const unobserved: Observed<never> = Object.freeze({ value: undefined })

function decodeStickers(value: unknown, construct = true): readonly MessageSticker[] | true | undefined {
    if (value === undefined || value === null) return construct ? Object.freeze([]) : true
    const rawStickers = value
    if (!Array.isArray(rawStickers)) return undefined
    const stickers: MessageSticker[] | undefined = construct ? [] : undefined
    for (const sticker of rawStickers) {
        if (
            !record(sticker) ||
            !identifier(sticker.id) ||
            typeof sticker.name !== "string" ||
            typeof sticker.animated !== "boolean"
        )
            return undefined
        if (stickers) stickers.push(Object.freeze({ id: sticker.id, name: sticker.name, animated: sticker.animated }))
    }
    return stickers ? Object.freeze(stickers) : true
}

/** Whether a reply mention preference is one this SDK knows. Users and message users leave out any other value instead
 * of failing, so a preference Fluxer adds later cannot break reads of a descriptive field
 */
export const mentionPreferenceKnown = (value: unknown): value is 0 | 1 | 2 => value === 0 || value === 1 || value === 2

/** Also decodes reaction-user page items, which carry the same partial user fields */
export function decodeMessageUser(value: unknown, construct = true): MessageUser | true | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        typeof value.username !== "string" ||
        (value.discriminator !== undefined && typeof value.discriminator !== "string") ||
        (value.global_name !== undefined && value.global_name !== null && typeof value.global_name !== "string") ||
        (value.avatar !== undefined && value.avatar !== null && typeof value.avatar !== "string") ||
        (value.avatar_color !== undefined && value.avatar_color !== null && !int32(value.avatar_color)) ||
        (value.bot !== undefined && typeof value.bot !== "boolean") ||
        (value.system !== undefined && typeof value.system !== "boolean") ||
        (value.flags !== undefined && !int32(value.flags))
    )
        return undefined
    if (!construct) return true
    return Object.freeze({
        id: value.id,
        username: value.username,
        isBot: value.bot === true,
        ...(value.discriminator === undefined ? {} : { discriminator: value.discriminator }),
        ...(value.global_name === undefined ? {} : { displayName: value.global_name }),
        ...(value.avatar === undefined ? {} : { avatar: value.avatar }),
        ...(value.avatar_color === undefined ? {} : { avatarColor: value.avatar_color }),
        ...(value.system === undefined ? {} : { isSystem: value.system }),
        ...(value.flags === undefined ? {} : { flags: value.flags }),
        ...(mentionPreferenceKnown(value.mention_flags) ? { mentionFlags: value.mention_flags } : {}),
    })
}

function decodeMessageUsers(value: unknown, construct = true): Observed<readonly MessageUser[]> | undefined {
    if (value === undefined) return unobserved
    if (!Array.isArray(value)) return undefined
    const users: MessageUser[] | undefined = construct ? [] : undefined
    for (const input of value) {
        const user = decodeMessageUser(input, construct)
        if (!user) return undefined
        if (users && user !== true) users.push(user)
    }
    return users ? { value: Object.freeze(users) } : unobserved
}

function decodeMentions(value: unknown, construct = true): Observed<readonly MessageUser[]> | undefined {
    return decodeMessageUsers(value, construct)
}

function decodeReferencedUsers(value: unknown, construct = true): Observed<readonly MessageUser[] | null> | undefined {
    if (value === null) return construct ? { value: null } : unobserved
    return decodeMessageUsers(value, construct)
}

function decodeIdentifiers(value: unknown, construct = true): Observed<readonly string[]> | undefined {
    if (value === undefined) return unobserved
    if (!Array.isArray(value) || !value.every(identifier)) return undefined
    return construct ? { value: Object.freeze([...value]) } : unobserved
}

function decodeMentionChannels(
    value: unknown,
    construct = true,
): Observed<readonly MessageChannelMention[] | null> | undefined {
    if (value === undefined) return unobserved
    if (value === null) return construct ? { value: null } : unobserved
    if (!Array.isArray(value)) return undefined
    const channels: MessageChannelMention[] | undefined = construct ? [] : undefined
    for (const channel of value) {
        if (!record(channel) || !identifier(channel.id) || typeof channel.name !== "string" || !int32(channel.type))
            return undefined
        if (channels) channels.push(Object.freeze({ id: channel.id, name: channel.name, type: channel.type }))
    }
    return channels ? { value: Object.freeze(channels) } : unobserved
}

function decodeReactionSummaries(
    value: unknown,
    construct = true,
): Observed<readonly MessageReactionSummary[] | null> | undefined {
    if (value === undefined) return unobserved
    if (value === null) return construct ? { value: null } : unobserved
    if (!Array.isArray(value)) return undefined
    const reactions: MessageReactionSummary[] | undefined = construct ? [] : undefined
    for (const reaction of value) {
        if (!record(reaction) || !record(reaction.emoji) || !count(reaction.count)) return undefined
        const emoji = reaction.emoji
        if (
            typeof emoji.name !== "string" ||
            (emoji.id !== undefined && emoji.id !== null && !identifier(emoji.id)) ||
            (emoji.animated !== undefined && emoji.animated !== null && typeof emoji.animated !== "boolean") ||
            (reaction.me !== undefined && reaction.me !== null && typeof reaction.me !== "boolean")
        )
            return undefined
        if (reactions)
            reactions.push(
                Object.freeze({
                    emoji: Object.freeze({
                        name: emoji.name,
                        ...(emoji.id === undefined ? {} : { id: emoji.id }),
                        ...(emoji.animated === undefined ? {} : { animated: emoji.animated }),
                    }),
                    count: reaction.count,
                    ...(reaction.me === undefined ? {} : { me: reaction.me }),
                }),
            )
    }
    return reactions ? { value: Object.freeze(reactions) } : unobserved
}

function decodeMessageReference(
    value: unknown,
    construct = true,
): Observed<MessageContextReference | null> | undefined {
    if (value === undefined) return unobserved
    if (value === null) return construct ? { value: null } : unobserved
    if (
        !record(value) ||
        (value.message_id !== undefined && value.message_id !== null && !identifier(value.message_id)) ||
        !identifier(value.channel_id) ||
        (value.guild_id !== undefined && value.guild_id !== null && !identifier(value.guild_id)) ||
        (value.type !== undefined && !int32(value.type))
    )
        return undefined
    if (!construct) return unobserved
    return {
        value: Object.freeze({
            ...(value.message_id == null ? {} : { id: value.message_id }),
            channelId: value.channel_id,
            ...(value.guild_id === undefined ? {} : { guildId: value.guild_id }),
            ...(value.type === undefined ? {} : { type: value.type }),
        }),
    }
}

function decodeMessageSnapshots(
    value: unknown,
    construct = true,
): Observed<readonly MessageSnapshot[] | null> | undefined {
    if (value === undefined) return unobserved
    if (value === null) return construct ? { value: null } : unobserved
    if (!Array.isArray(value)) return undefined
    const snapshots: MessageSnapshot[] | undefined = construct ? [] : undefined
    for (const snapshot of value) {
        const decoded = decodeMessageSnapshot(snapshot, construct)
        if (!decoded) return undefined
        if (snapshots && decoded !== true) snapshots.push(decoded)
    }
    return snapshots ? { value: Object.freeze(snapshots) } : unobserved
}

function decodeMessageSnapshot(value: unknown, construct = true): MessageSnapshot | true | undefined {
    if (
        !record(value) ||
        !timestamp(value.timestamp) ||
        !int32(value.type) ||
        !int32(value.flags) ||
        (value.content !== undefined && value.content !== null && typeof value.content !== "string") ||
        (value.edited_timestamp !== undefined && value.edited_timestamp !== null && !timestamp(value.edited_timestamp))
    )
        return undefined
    // Each part is checked before the next is read, so failingFieldPath names the part that failed
    const mentionUserIds = decodeSnapshotField(value.mentions, decodeSnapshotIdentifiers, construct)
    if (mentionUserIds === undefined) return undefined
    const mentionRoleIds = decodeSnapshotField(value.mention_roles, decodeSnapshotIdentifiers, construct)
    if (mentionRoleIds === undefined) return undefined
    const mentionChannels = decodeSnapshotField(value.mention_channels, decodeSnapshotMentionChannels, construct)
    if (mentionChannels === undefined) return undefined
    const embeds = decodeSnapshotField(value.embeds, decodeEmbeds, construct)
    if (embeds === undefined) return undefined
    const attachments = decodeSnapshotField(value.attachments, decodeAttachments, construct)
    if (attachments === undefined) return undefined
    const stickers = decodeSnapshotField(value.stickers, decodeStickers, construct)
    if (stickers === undefined) return undefined
    if (!construct) return true
    return Object.freeze({
        ...(value.content === undefined ? {} : { content: value.content }),
        createdAt: value.timestamp,
        ...(value.edited_timestamp === undefined ? {} : { editedAt: value.edited_timestamp }),
        ...(mentionUserIds.value === undefined ? {} : { mentionUserIds: mentionUserIds.value }),
        ...(mentionRoleIds.value === undefined ? {} : { mentionRoleIds: mentionRoleIds.value }),
        ...(mentionChannels.value === undefined ? {} : { mentionChannels: mentionChannels.value }),
        ...(embeds.value === undefined ? {} : { embeds: embeds.value }),
        ...(attachments.value === undefined ? {} : { attachments: attachments.value }),
        ...(stickers.value === undefined ? {} : { stickers: stickers.value }),
        type: value.type,
        flags: value.flags,
    })
}

function decodeSnapshotField<A>(
    value: unknown,
    decode: (value: unknown, construct: boolean) => A | true | undefined,
    construct: boolean,
): Observed<A | null> | undefined {
    if (value === undefined) return unobserved
    if (value === null) return construct ? { value: null } : unobserved
    const decoded = decode(value, construct)
    return decoded === undefined ? undefined : decoded === true ? unobserved : { value: decoded }
}

function decodeSnapshotIdentifiers(value: unknown, construct = true): readonly string[] | true | undefined {
    if (!Array.isArray(value) || !value.every(identifier)) return undefined
    return construct ? Object.freeze([...value]) : true
}

function decodeSnapshotMentionChannels(
    value: unknown,
    construct = true,
): readonly MessageChannelMention[] | true | undefined {
    const decoded = decodeMentionChannels(value, construct)
    if (decoded === undefined) return undefined
    return construct ? (decoded.value ?? undefined) : true
}

function decodeReferencedMessage(value: unknown, construct = true): Observed<ReferencedMessage | null> | undefined {
    if (value === undefined) return unobserved
    if (value === null) return construct ? { value: null } : unobserved
    const message = decodeMessageValue(value, undefined, false, construct)
    if (!message) return undefined
    return construct && message !== true ? { value: message as ReferencedMessage } : unobserved
}

/** Read one message target without retaining a caller-controlled object across validation and dispatch */
export function snapshotReference(value: unknown): MessageReference | undefined {
    if (!record(value)) return undefined
    const id = value.id
    const channelId = value.channelId
    const trimmedId = inputId(id)
    const trimmedChannelId = inputId(channelId)
    return trimmedId !== undefined && trimmedChannelId !== undefined
        ? Object.freeze({ id: trimmedId, channelId: trimmedChannelId })
        : undefined
}

/** Validate the channel and query. The result carries the trimmed channel ID, which the request and its decoding use */
export function encodeHistory(rawChannelId: unknown, query: unknown) {
    const channelId = inputId(rawChannelId)
    if (channelId === undefined)
        return inputValidationFailure(
            "channelId",
            "format",
            "Channel IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    const input = query === undefined ? {} : query
    if (!record(input)) return inputValidationFailure("query", "type", "History query must be an object")
    const unsupported = unsupportedKeyFailure(
        input,
        ["limit", "before", "after", "around"],
        "query",
        "the history query",
    )
    if (unsupported) return unsupported
    const limit = input.limit === undefined ? 50 : input.limit
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100)
        return inputValidationFailure("query.limit", "range", "History limit must be an integer from 1 through 100")
    // Fluxer returns the window between before and after when both are sent, and ignores both for the page when around
    // is present (fluxer_messages/src/shard_impl.rs:792-809 at 0098958f). In a thread they still decide whether the
    // starter message is added (fluxer_api/src/api/channel/services/message/ThreadMessageResponses.ts:170-193), so every
    // cursor is sent as given
    const cursors = ["before", "after", "around"].filter((key) => input[key] !== undefined)
    const params = new URLSearchParams({ limit: String(limit) })
    for (const key of cursors) {
        const id = inputId(input[key])
        if (id === undefined)
            return inputValidationFailure(
                `query.${key}`,
                "format",
                "History cursor IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
            )
        params.set(key, id)
    }
    return { channelId, limit, params }
}

export function decodeDeletion(value: unknown): MessageDeletion | undefined {
    if (!record(value) || !identifier(value.id) || !identifier(value.channel_id)) return undefined
    if (value.guild_id !== undefined && !identifier(value.guild_id)) return undefined
    if ("content" in value && value.content !== null && typeof value.content !== "string") return undefined
    if ("author_id" in value && !identifier(value.author_id)) return undefined
    const member = decodeDeletionMember(value)
    return Object.freeze({
        id: value.id,
        channelId: value.channel_id,
        ...(value.guild_id === undefined ? {} : { guildId: value.guild_id as string }),
        ...(value.content === null || typeof value.content === "string" ? { content: value.content } : {}),
        ...(identifier(value.author_id) ? { authorId: value.author_id } : {}),
        ...(member === undefined ? {} : { member }),
    })
}

export function decodeBulkDeletion(value: unknown): MessageBulkDeletion | undefined {
    if (
        !record(value) ||
        !identifier(value.channel_id) ||
        !Array.isArray(value.ids) ||
        !value.ids.every(identifier) ||
        (value.guild_id !== undefined && !identifier(value.guild_id))
    )
        return undefined
    return Object.freeze({
        channelId: value.channel_id,
        ids: Object.freeze([...value.ids]),
        ...(value.guild_id === undefined ? {} : { guildId: value.guild_id as string }),
    })
}

/**
 * Fluxer's message, webhook and forum post schemas take null stickers as none, so the SDK sends null as given
 * (packages/schema/src/domains/message/MessageRequestSchemas.ts:354, WebhookRequestSchemas.ts:104 and
 * ForumRequestSchemas.ts:126 at 0098958f)
 */
function encodeStickerIds(stickerInput: unknown): readonly string[] | null | undefined | InputValidationFailure {
    if (stickerInput === undefined || stickerInput === null) return stickerInput
    if (!Array.isArray(stickerInput))
        return inputValidationFailure("stickerIds", "type", "Sticker IDs must be an array")
    const count = stickerInput.length
    if (count > 3)
        return inputValidationFailure("stickerIds", "length", "A message may contain at most three sticker IDs")
    const stickerIds = inputIds(stickerInput, count)
    if (stickerIds === undefined)
        return inputValidationFailure(
            "stickerIds[]",
            "format",
            "Sticker IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    return stickerIds
}

/**
 * Fluxer's voice-note rules, checked in its order: No content, embeds or stickers, and exactly one new attachment with
 * a waveform and a duration (fluxer_api/src/api/channel/services/message/MessageValidationService.ts:202 at 5f3fc0b1).
 * Fluxer also checks that the file is audio and that the duration is within the instance's limit, 1,200 seconds by
 * default, which it can configure, so those stay with Fluxer
 */
function voiceNoteFailure(
    content: unknown,
    body: { readonly embeds?: readonly unknown[] } | undefined,
    stickerIds: readonly unknown[] | null | undefined,
    attachments: readonly Record<string, unknown>[] | undefined,
): InputValidationFailure | undefined {
    if (visibleContent(content))
        return inputValidationFailure("content", "relationship", "A voice note cannot have visible message content")
    if (body?.embeds?.length) return inputValidationFailure("embeds", "relationship", "A voice note cannot have embeds")
    if (stickerIds?.length)
        return inputValidationFailure("stickerIds", "relationship", "A voice note cannot have stickers")
    if (attachments?.length !== 1)
        return inputValidationFailure("attachments", "length", "A voice note needs exactly one attachment")
    const [attachment] = attachments
    // Fluxer needs a waveform and a duration that are present and not null
    // (fluxer_api/src/api/channel/services/message/MessageValidationService.ts:223-234 at 0098958f)
    if (attachment!.waveform === undefined || attachment!.waveform === null)
        return inputValidationFailure(
            "attachments[].waveform",
            "required",
            "A voice note's attachment needs a waveform",
        )
    if (attachment!.duration === undefined || attachment!.duration === null)
        return inputValidationFailure(
            "attachments[].duration",
            "required",
            "A voice note's attachment needs a duration",
        )
    return undefined
}

/** Code points Fluxer does not count as visible content (packages/schema/src/primitives/MessageValidators.ts:60-80 at
 * 0098958f)
 */
function invisibleCodePoint(codePoint: number): boolean {
    return (
        codePoint === 0x0000 ||
        codePoint === 0x00ad ||
        codePoint === 0x034f ||
        codePoint === 0x061c ||
        codePoint === 0x115f ||
        codePoint === 0x1160 ||
        codePoint === 0x17b4 ||
        codePoint === 0x17b5 ||
        codePoint === 0x180e ||
        (codePoint >= 0x200b && codePoint <= 0x200f) ||
        (codePoint >= 0x202a && codePoint <= 0x202e) ||
        (codePoint >= 0x2060 && codePoint <= 0x2069) ||
        codePoint === 0x2800 ||
        codePoint === 0x3164 ||
        (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
        codePoint === 0xfeff ||
        codePoint === 0xffa0 ||
        (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
    )
}

/** Whether Fluxer counts message content as present: A string with a character that is neither whitespace nor
 * invisible. An empty, blank or invisible string counts as no content, as null does
 * (packages/schema/src/primitives/MessageValidators.ts:82-94 and
 * fluxer_api/src/api/channel/services/message/MessageValidationService.ts:47 at 0098958f)
 */
function visibleContent(content: unknown): boolean {
    if (typeof content !== "string") return false
    for (const character of content)
        if (character.trim().length > 0 && !invisibleCodePoint(character.codePointAt(0)!)) return true
    return false
}

function hasMessageContent(
    content: unknown,
    body: { readonly embeds?: readonly unknown[] },
    fileCount: number,
    stickerIds: readonly unknown[] | null | undefined,
): boolean {
    return visibleContent(content) || !!body.embeds?.length || !!fileCount || !!stickerIds?.length
}

/** An encoded message request with the trimmed destination channel ID, which the request path and result decoding use */
export type EncodedMessage = EncodedBody & { readonly channelId: string }

function encodeReplyReference(rawReference: unknown, channelId: string) {
    const ref = rawReference === undefined ? undefined : snapshotReference(rawReference)
    if (rawReference !== undefined && ref === undefined)
        return inputValidationFailure(
            "messageReference",
            "format",
            "Message references require decimal id and channelId strings",
        )
    if (ref !== undefined && ref.channelId !== channelId)
        return inputValidationFailure(
            "messageReference.channelId",
            "relationship",
            "A reply reference must point to a message in the destination channel",
        )
    return ref
}

const messageInputKeys: readonly string[] = [
    "content",
    "nonce",
    "embeds",
    "attachments",
    "stickerIds",
    "allowedMentions",
    "messageReference",
    "flags",
    "tts",
]

/**
 * Unknown input fields fail before dispatch, and unknown wire response fields are not copied into snapshots.
 * Each top-level input field is read at most once, in validation order, so the validated value is the one sent.
 * A direct message rejects its own messageReference before the other fields are checked. Voice notes are where the
 * message is sent, which sets the longest waveform, or false for a webhook forward, which carries no voice note
 */
export function encodeMessage(
    rawChannelId: unknown,
    input: unknown,
    defaultNonce: string,
    replyTarget?: MessageReference,
    directMessage = false,
    voiceNotes: WaveformTarget | false = "message",
): EncodedMessage | MessageError {
    const invalid = (failure: InputValidationFailure) =>
        new MessageError({ reason: "input", outcome: "notDispatched", inputValidation: failure.detail })
    const channelId = inputId(rawChannelId)
    if (channelId === undefined)
        return invalid(
            inputValidationFailure(
                "channelId",
                "format",
                "Channel IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
            ),
        )
    input = messageObject(input)
    if (!record(input))
        return invalid(inputValidationFailure("input", "type", "Message input must be a string or an object"))
    const field = fieldsOnce(input)
    if (directMessage && field("messageReference") !== undefined)
        return invalid(
            inputValidationFailure(
                "messageReference",
                "relationship",
                "Direct messages cannot include a message reference",
            ),
        )
    const unsupported = unsupportedKeyFailure(input, messageInputKeys, "input", "the message input")
    if (unsupported) return invalid(unsupported)
    const nonce = encodeNonce(field("nonce"), defaultNonce)
    if (nonce instanceof InputValidationFailure) return invalid(nonce)
    const attachments = encodeAttachments(field("attachments"), false, voiceNotes === false ? "message" : voiceNotes)
    if (attachments instanceof InputValidationFailure) return invalid(attachments)
    const body = encodeBody(field, attachments.uploadedFilenames)
    if (body instanceof InputValidationFailure) return invalid(body)
    const stickerIds = encodeStickerIds(field("stickerIds"))
    if (stickerIds instanceof InputValidationFailure) return invalid(stickerIds)
    const flags = field("flags")
    // The range is checked on the value sent, before the VoiceMessage bit is removed by 32-bit arithmetic that would
    // drop a fraction or the bits above 32
    const voiceNote = voiceNotes !== false && writableFlagRange(flags) && (flags & MessageFlags.VoiceMessage) !== 0
    if (
        flags !== undefined &&
        !(writableFlagRange(flags) && writableFlags(voiceNote ? flags & ~MessageFlags.VoiceMessage : flags))
    )
        return invalid(
            inputValidationFailure(
                "flags",
                "allowedValue",
                voiceNotes !== false
                    ? "Message sends support only SuppressEmbeds, SuppressNotifications and VoiceMessage"
                    : "Webhook forwards support only SuppressEmbeds and SuppressNotifications",
            ),
        )
    if (voiceNote) {
        const failure = voiceNoteFailure(field("content"), body, stickerIds, attachments.metadata)
        if (failure) return invalid(failure)
    }
    const tts = field("tts")
    if (tts !== undefined && typeof tts !== "boolean")
        return invalid(inputValidationFailure("tts", "type", "Message tts must be a boolean"))
    if (body === undefined)
        return invalid(
            inputValidationFailure(
                "input",
                "required",
                "A message must contain visible content, an embed, an attachment, or a sticker",
            ),
        )
    if (!hasMessageContent(field("content"), body, attachments.files.length, stickerIds))
        return invalid(
            inputValidationFailure(
                "input",
                "required",
                "A message must contain visible content, an embed, an attachment, or a sticker",
            ),
        )
    // Fluxer reads the mention settings of a send only when it has content or a reply reference
    // (fluxer_api/src/api/channel/services/message/MessageSendService.ts:757-759, 1083-1085 at 0098958f)
    const mentions = encodeAllowedMentions(
        field("allowedMentions"),
        field("content") !== undefined || (replyTarget ?? field("messageReference")) !== undefined,
    )
    if (mentions instanceof InputValidationFailure) return invalid(mentions)
    const ref = encodeReplyReference(replyTarget ?? field("messageReference"), channelId)
    if (ref instanceof InputValidationFailure) return invalid(ref)
    return {
        channelId,
        files: attachments.files,
        json: JSON.stringify({
            ...body,
            ...(stickerIds === undefined ? {} : { sticker_ids: stickerIds }),
            ...(attachments.metadata === undefined ? {} : { attachments: attachments.metadata }),
            nonce,
            allowed_mentions: mentions,
            ...(flags === undefined ? {} : { flags }),
            ...(tts === undefined ? {} : { tts }),
            ...(ref === undefined
                ? {}
                : { message_reference: { message_id: ref.id, channel_id: ref.channelId, type: 0 } }),
        }),
    }
}

/** Forward inputs encode only Fluxer's source reference and optional media selectors */
export function encodeForward(
    rawChannelId: unknown,
    input: unknown,
    defaultNonce: string,
): EncodedMessage | MessageError {
    const invalid = (failure: InputValidationFailure) =>
        new MessageError({ reason: "input", outcome: "notDispatched", inputValidation: failure.detail })
    const channelId = inputId(rawChannelId)
    if (channelId === undefined)
        return invalid(
            inputValidationFailure(
                "channelId",
                "format",
                "Channel IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
            ),
        )
    if (!record(input)) return invalid(inputValidationFailure("input", "type", "Forward input must be an object"))
    const unsupported = unsupportedKeyFailure(
        input,
        ["source", "nonce", "attachmentIds", "embedIndices"],
        "input",
        "the forward input",
    )
    if (unsupported) return invalid(unsupported)
    const nonce = encodeNonce(input.nonce, defaultNonce)
    if (nonce instanceof InputValidationFailure) return invalid(nonce)
    const source = snapshotReference(input.source)
    if (source === undefined)
        return invalid(
            inputValidationFailure("source", "format", "Forward source requires decimal id and channelId strings"),
        )
    const attachmentIdsInput = input.attachmentIds
    const embedIndicesInput = input.embedIndices
    let attachmentIds: readonly string[] | undefined
    if (attachmentIdsInput !== undefined) {
        if (!Array.isArray(attachmentIdsInput))
            return invalid(inputValidationFailure("attachmentIds", "type", "Forward attachment IDs must be an array"))
        const count = attachmentIdsInput.length
        if (count > 10)
            return invalid(
                inputValidationFailure("attachmentIds", "length", "A forward may select at most ten attachments"),
            )
        attachmentIds = inputIds(attachmentIdsInput, count)
        if (attachmentIds === undefined)
            return invalid(
                inputValidationFailure(
                    "attachmentIds[]",
                    "format",
                    "Forward attachment IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
                ),
            )
    }
    let embedIndices: readonly unknown[] | undefined
    if (embedIndicesInput !== undefined) {
        if (!Array.isArray(embedIndicesInput))
            return invalid(inputValidationFailure("embedIndices", "type", "Forward embed indices must be an array"))
        const count = embedIndicesInput.length
        if (count > 10)
            return invalid(inputValidationFailure("embedIndices", "length", "A forward may select at most ten embeds"))
        embedIndices = snapshotArray(embedIndicesInput, count)
        if (
            !embedIndices.every(
                (index) =>
                    typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && index <= 2_147_483_647,
            )
        )
            return invalid(
                inputValidationFailure(
                    "embedIndices[]",
                    "range",
                    "Forward embed indices must be integers from 0 through 2,147,483,647",
                ),
            )
    }
    return {
        channelId,
        files: [],
        json: JSON.stringify({
            nonce,
            message_reference: {
                message_id: source.id,
                channel_id: source.channelId,
                type: 1,
                ...(attachmentIds === undefined ? {} : { attachment_ids: attachmentIds }),
                ...(embedIndices === undefined ? {} : { embed_indices: embedIndices }),
            },
        }),
    }
}

/** Fluxer checks a nonce string after removing U+000C and U+202E and trimming it, so a blank nonce fails and surrounding
 * whitespace does not count toward the 32 units. The string is sent as given
 * (packages/schema/src/domains/message/MessageRequestSchemas.ts:314-324 at 0098958f)
 */
function encodeNonce(value: unknown, defaultNonce: string): string | InputValidationFailure {
    if (value === undefined) return defaultNonce
    if (typeof value === "string") {
        if (normalizedText(value, 1, 32)) return value
        return inputValidationFailure(
            "nonce",
            "length",
            "Message nonces must contain 1 through 32 UTF-16 code units after Fluxer removes form feeds and U+202E and trims surrounding whitespace, so a blank nonce fails",
        )
    }
    if (typeof value === "number") {
        if (Number.isSafeInteger(value) && value >= 0) return String(value)
        return inputValidationFailure("nonce", "range", "Message nonce numbers must be nonnegative safe integers")
    }
    return inputValidationFailure("nonce", "type", "Message nonces must be strings or nonnegative safe integers")
}

/** Encode the mention settings. Mixed is whether Fluxer reads them on this request, where it refuses everyone together
 * with users or roles
 */
function encodeAllowedMentions(value: unknown, mixedChecked: boolean) {
    const mentions = value === undefined ? {} : value
    if (!record(mentions))
        return inputValidationFailure("allowedMentions", "type", "Allowed mentions must be an object")
    const unsupported = unsupportedKeyFailure(
        mentions,
        ["users", "roles", "everyone", "repliedUser"],
        "allowedMentions",
        "the allowedMentions setting",
    )
    if (unsupported) return unsupported
    const field = fieldsOnce(mentions)
    const selections: Record<"users" | "roles", readonly string[] | undefined> = { users: undefined, roles: undefined }
    for (const key of ["users", "roles"] as const) {
        const list = field(key)
        if (list !== undefined && !Array.isArray(list))
            return inputValidationFailure(`allowedMentions.${key}`, "type", "Mention selections must be arrays")
        if (list === undefined) continue
        const count = list.length
        if (count > 100)
            return inputValidationFailure(
                `allowedMentions.${key}`,
                "length",
                "Mention selections may contain at most 100 IDs",
            )
        const selection = inputIds(list, count)
        if (selection === undefined)
            return inputValidationFailure(
                `allowedMentions.${key}[]`,
                "format",
                "Mention selection IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
            )
        selections[key] = selection
    }
    for (const key of ["everyone", "repliedUser"])
        if (field(key) !== undefined && typeof field(key) !== "boolean")
            return inputValidationFailure(`allowedMentions.${key}`, "type", "Mention switches must be booleans")
    // Where Fluxer reads them, it refuses parse together with users or roles, PARSE_AND_USERS_OR_ROLES_CANNOT_BE_USED_TOGETHER
    // (fluxer_api/src/api/channel/services/message/MessageMentionService.ts:231-236 at 0098958f)
    if (
        mixedChecked &&
        field("everyone") === true &&
        ((selections.users?.length ?? 0) > 0 || (selections.roles?.length ?? 0) > 0)
    )
        return inputValidationFailure(
            "allowedMentions",
            "relationship",
            "Fluxer doesn't accept everyone together with users or roles. Allow everyone alone, or list IDs without everyone",
        )
    return {
        parse: field("everyone") === true ? ["everyone"] : [],
        users: selections.users ?? [],
        roles: selections.roles ?? [],
        replied_user: field("repliedUser") ?? false,
    }
}

/** Copy already bounded indexed entries once, avoiding caller-defined iteration during validation or encoding */
function snapshotArray(value: readonly unknown[], count: number): readonly unknown[] {
    const result: unknown[] = []
    for (let index = 0; index < count; index += 1) result.push(value[index])
    return Object.freeze(result)
}

/** Each top-level edit field is read at most once, in validation order, so the validated value is the one sent */
/** EmptyIsAbsent applies the empty-string handling of Fluxer's webhook message edit route to embeds, see encodeEmbeds */
export function encodeEdit(input: unknown, emptyIsAbsent = false): EncodedBody | InputValidationFailure {
    input = messageObject(input)
    if (!record(input))
        return inputValidationFailure("input", "type", "Message edit input must be a string or an object")
    const unsupported = unsupportedKeyFailure(
        input,
        ["content", "embeds", "attachments", "allowedMentions", "flags"],
        "input",
        "the message edit input",
    )
    if (unsupported) return unsupported
    const field = fieldsOnce(input)
    const attachments = encodeAttachments(field("attachments"), true)
    if (attachments instanceof InputValidationFailure) return attachments
    // Without an attachments list, an attachment:// URL may name a file the message already has
    const body = encodeBody(
        field,
        field("attachments") === undefined ? "existing" : attachments.uploadedFilenames,
        emptyIsAbsent,
    )
    if (body instanceof InputValidationFailure) return body
    // A channel message edit always sends allowed_mentions, so Fluxer always reads them
    // (fluxer_api/src/api/channel/services/message/MessageEditService.ts:128-130 at 0098958f). A webhook message edit,
    // the only caller with emptyIsAbsent, never reads them (MessageSendService.ts:1178-1240)
    const mentions = encodeAllowedMentions(field("allowedMentions"), !emptyIsAbsent)
    if (mentions instanceof InputValidationFailure) return mentions
    const hasBodyInput =
        field("content") !== undefined || field("embeds") !== undefined || field("attachments") !== undefined
    const flags = field("flags")
    if (flags !== undefined && !writableFlags(flags))
        return inputValidationFailure(
            "flags",
            "allowedValue",
            "Message edits support only SuppressEmbeds and SuppressNotifications. A message cannot become a voice note by an edit",
        )
    if (!body && (hasBodyInput || flags === undefined))
        return inputValidationFailure("input", "required", "A message edit must contain at least one editable field")
    // Fluxer checks the edit request, not the message it leaves: Without flags, the request itself needs visible
    // content, an embed or an attachment, so empty content alone, which would clear the text, is refused
    // (fluxer_api/src/api/channel/services/message/MessageValidationService.ts:47-68 at 0098958f). On a webhook message
    // edit Fluxer reads empty content as null first, with the same result
    if (
        flags === undefined &&
        !visibleContent(field("content")) &&
        !body?.embeds?.length &&
        !attachments.metadata?.length
    )
        return inputValidationFailure(
            "input",
            "required",
            "A message edit without flags must contain visible content, an embed or an attachment, as Fluxer checks the edit itself rather than the message it leaves",
        )
    return {
        files: attachments.files,
        json: JSON.stringify({
            ...body,
            allowed_mentions: mentions,
            ...(flags === undefined ? {} : { flags }),
            ...(attachments.metadata === undefined ? {} : { attachments: attachments.metadata }),
        }),
    }
}

export function replyInput(
    target: unknown,
    input: unknown,
): { readonly target: MessageReference; readonly input: MessageInput } | MessageError {
    const invalid = (failure: InputValidationFailure) =>
        new MessageError({ reason: "input", outcome: "notDispatched", inputValidation: failure.detail })
    const reference = snapshotReference(target)
    if (reference === undefined)
        return invalid(
            inputValidationFailure("target", "format", "Reply targets require decimal id and channelId strings"),
        )
    input = messageObject(input)
    if (!record(input))
        return invalid(inputValidationFailure("input", "type", "Reply input must be a string or an object"))
    if ("messageReference" in input)
        return invalid(
            inputValidationFailure(
                "messageReference",
                "relationship",
                "Reply input must not provide its own messageReference",
            ),
        )
    // The send owner validates the original structural body in its normal order after accepting the lifetime
    return Object.freeze({ target: reference, input: input as MessageInput })
}

/** A plain string is shorthand for a message whose only field is its content */
export function messageObject(input: unknown): unknown {
    return typeof input === "string" ? { content: input } : input
}

/** Build each EmbedBuilder in an embeds array once, reading every index once, so later validation sees plain objects */
function builtEmbeds(value: unknown): unknown {
    if (!Array.isArray(value)) return value
    const count = value.length
    const embeds: unknown[] = []
    for (let index = 0; index < count; index += 1) {
        const embed: unknown = value[index]
        embeds.push(embed instanceof EmbedBuilder ? embed.build() : embed)
    }
    return embeds
}

/** Encode content and embeds from fields read through the caller's single-read field reader */
function encodeBody(field: (key: string) => unknown, uploadedFilenames?: EmbedAttachmentFiles, emptyIsAbsent = false) {
    if (
        field("content") === undefined &&
        field("embeds") === undefined &&
        field("attachments") === undefined &&
        field("stickerIds") === undefined
    )
        return undefined
    // Fluxer accepts null content on sends, edits and webhook messages. A send then has no text and an edit clears it, as
    // with an empty string, and Fluxer still reads the mention settings because content is present
    // (packages/schema/src/domains/message/MessageRequestSchemas.ts:336, WebhookRequestSchemas.ts:90, 158-160,
    // fluxer_api/src/api/channel/services/message/MessagePersistenceService.ts:435-449 at 0098958f)
    const content = field("content")
    if (content !== undefined && content !== null && typeof content !== "string")
        return inputValidationFailure("content", "type", "Message content must be a string or null")
    const embedInput = field("embeds")
    const embeds =
        embedInput === undefined ? undefined : encodeEmbeds(builtEmbeds(embedInput), uploadedFilenames, emptyIsAbsent)
    if (embeds instanceof InputValidationFailure) return embeds
    return {
        ...(content === undefined ? {} : { content }),
        ...(embeds === undefined ? {} : { embeds }),
    }
}
