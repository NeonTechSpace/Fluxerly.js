import { MessageFlags } from "#sdk/messages"
import type {
    Message,
    MessageInput,
    MessageReference,
    MessageDeletion,
    MessageBulkDeletion,
    MessageMention,
    MessageChannelMention,
    MessageReactionSummary,
    MessageContextReference,
    MessageSnapshot,
    MessageSticker,
} from "#sdk/messages"
import { MessageError } from "#sdk/message-errors"
import { decodeEmbeds, encodeEmbeds } from "./embeds.js"
import { decodeAttachments, encodeAttachments, type EncodedBody } from "./attachments.js"

export const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
export const identifier = (value: unknown): value is string =>
    typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)

const timestamp = (value: unknown): value is string =>
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
    Number.isFinite(Date.parse(value))
const int32 = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647
const count = (value: unknown): value is number => int32(value) && value >= 0
const writableMessageFlags = MessageFlags.SuppressEmbeds | MessageFlags.SuppressNotifications
const writableFlags = (value: unknown): value is number =>
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 2_147_483_647 &&
    (value & ~writableMessageFlags) === 0

export function decodeMessage(value: unknown): Message | undefined {
    if (!record(value) || !identifier(value.id) || !identifier(value.channel_id) || typeof value.content !== "string")
        return undefined
    if (
        (value.pinned !== undefined && typeof value.pinned !== "boolean") ||
        (value.timestamp !== undefined && !timestamp(value.timestamp)) ||
        (value.edited_timestamp !== undefined &&
            value.edited_timestamp !== null &&
            !timestamp(value.edited_timestamp)) ||
        (value.type !== undefined && !int32(value.type)) ||
        (value.flags !== undefined && !int32(value.flags)) ||
        (value.guild_id !== undefined && !identifier(value.guild_id)) ||
        (value.mention_everyone !== undefined && typeof value.mention_everyone !== "boolean")
    )
        return undefined
    if (value.webhook_id != null && !identifier(value.webhook_id)) return undefined
    const author = value.author
    if (
        !record(author) ||
        !identifier(author.id) ||
        typeof author.username !== "string" ||
        (author.bot !== undefined && typeof author.bot !== "boolean")
    )
        return undefined
    const embeds = decodeEmbeds(value.embeds)
    const attachments = decodeAttachments(value.attachments)
    const stickers = decodeStickers(value.stickers)
    if (embeds === undefined || attachments === undefined || stickers === undefined) return undefined
    const mentions = decodeMentions(value.mentions)
    const mentionRoles = decodeIdentifiers(value.mention_roles)
    const mentionChannels = decodeMentionChannels(value.mention_channels)
    const reactions = decodeReactionSummaries(value.reactions)
    const messageReference = decodeMessageReference(value.message_reference)
    const messageSnapshots = decodeMessageSnapshots(value.message_snapshots)
    const referencedMessage = decodeReferencedMessage(value.referenced_message)
    if (
        mentions === undefined ||
        mentionRoles === undefined ||
        mentionChannels === undefined ||
        reactions === undefined ||
        messageReference === undefined ||
        messageSnapshots === undefined ||
        referencedMessage === undefined
    )
        return undefined
    return Object.freeze({
        id: value.id,
        channelId: value.channel_id,
        content: value.content,
        ...(value.webhook_id == null ? {} : { webhookId: value.webhook_id }),
        ...(value.pinned === undefined ? {} : { pinned: value.pinned }),
        ...(value.timestamp === undefined ? {} : { createdAt: value.timestamp }),
        ...(value.edited_timestamp === undefined ? {} : { editedAt: value.edited_timestamp }),
        ...(value.type === undefined ? {} : { type: value.type }),
        ...(value.flags === undefined ? {} : { flags: value.flags }),
        ...(value.guild_id === undefined ? {} : { guildId: value.guild_id }),
        ...(value.mention_everyone === undefined ? {} : { mentionedEveryone: value.mention_everyone }),
        embeds,
        attachments,
        stickers,
        ...(mentions.value === undefined ? {} : { mentions: mentions.value }),
        ...(mentionRoles.value === undefined ? {} : { mentionRoleIds: mentionRoles.value }),
        ...(mentionChannels.value === undefined ? {} : { mentionChannels: mentionChannels.value }),
        ...(reactions.value === undefined ? {} : { reactions: reactions.value }),
        ...(messageReference.value === undefined ? {} : { messageReference: messageReference.value }),
        ...(messageSnapshots.value === undefined ? {} : { messageSnapshots: messageSnapshots.value }),
        ...(referencedMessage.value === undefined ? {} : { referencedMessage: referencedMessage.value }),
        author: Object.freeze({ id: author.id, username: author.username, isBot: author.bot === true }),
    })
}

type Observed<A> = { readonly value: A | undefined }

function decodeStickers(value: unknown): readonly MessageSticker[] | undefined {
    const rawStickers = value ?? []
    if (!Array.isArray(rawStickers)) return undefined
    const stickers: MessageSticker[] = []
    for (const sticker of rawStickers) {
        if (
            !record(sticker) ||
            !identifier(sticker.id) ||
            typeof sticker.name !== "string" ||
            typeof sticker.animated !== "boolean"
        )
            return undefined
        stickers.push(Object.freeze({ id: sticker.id, name: sticker.name, animated: sticker.animated }))
    }
    return Object.freeze(stickers)
}

function decodeMentions(value: unknown): Observed<readonly MessageMention[]> | undefined {
    if (value === undefined) return { value: undefined }
    if (!Array.isArray(value)) return undefined
    const mentions: MessageMention[] = []
    for (const mention of value) {
        if (
            !record(mention) ||
            !identifier(mention.id) ||
            typeof mention.username !== "string" ||
            (mention.bot !== undefined && typeof mention.bot !== "boolean")
        )
            return undefined
        mentions.push(Object.freeze({ id: mention.id, username: mention.username, isBot: mention.bot === true }))
    }
    return { value: Object.freeze(mentions) }
}

function decodeIdentifiers(value: unknown): Observed<readonly string[]> | undefined {
    if (value === undefined) return { value: undefined }
    return Array.isArray(value) && value.every(identifier) ? { value: Object.freeze([...value]) } : undefined
}

function decodeMentionChannels(value: unknown): Observed<readonly MessageChannelMention[] | null> | undefined {
    if (value === undefined) return { value: undefined }
    if (value === null) return { value: null }
    if (!Array.isArray(value)) return undefined
    const channels: MessageChannelMention[] = []
    for (const channel of value) {
        if (!record(channel) || !identifier(channel.id) || typeof channel.name !== "string" || !int32(channel.type))
            return undefined
        channels.push(Object.freeze({ id: channel.id, name: channel.name, type: channel.type }))
    }
    return { value: Object.freeze(channels) }
}

function decodeReactionSummaries(value: unknown): Observed<readonly MessageReactionSummary[] | null> | undefined {
    if (value === undefined) return { value: undefined }
    if (value === null) return { value: null }
    if (!Array.isArray(value)) return undefined
    const reactions: MessageReactionSummary[] = []
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
    return { value: Object.freeze(reactions) }
}

function decodeMessageReference(value: unknown): Observed<MessageContextReference | null> | undefined {
    if (value === undefined) return { value: undefined }
    if (value === null) return { value: null }
    if (
        !record(value) ||
        !identifier(value.message_id) ||
        !identifier(value.channel_id) ||
        (value.guild_id !== undefined && value.guild_id !== null && !identifier(value.guild_id)) ||
        (value.type !== undefined && !int32(value.type))
    )
        return undefined
    return {
        value: Object.freeze({
            id: value.message_id,
            channelId: value.channel_id,
            ...(value.guild_id === undefined ? {} : { guildId: value.guild_id }),
            ...(value.type === undefined ? {} : { type: value.type }),
        }),
    }
}

function decodeMessageSnapshots(value: unknown): Observed<readonly MessageSnapshot[] | null> | undefined {
    if (value === undefined) return { value: undefined }
    if (value === null) return { value: null }
    if (!Array.isArray(value)) return undefined
    const snapshots: MessageSnapshot[] = []
    for (const snapshot of value) {
        const decoded = decodeMessageSnapshot(snapshot)
        if (!decoded) return undefined
        snapshots.push(decoded)
    }
    return { value: Object.freeze(snapshots) }
}

function decodeMessageSnapshot(value: unknown): MessageSnapshot | undefined {
    if (
        !record(value) ||
        !timestamp(value.timestamp) ||
        !int32(value.type) ||
        !int32(value.flags) ||
        (value.content !== undefined && value.content !== null && typeof value.content !== "string") ||
        (value.edited_timestamp !== undefined && value.edited_timestamp !== null && !timestamp(value.edited_timestamp))
    )
        return undefined
    const mentionUserIds = decodeSnapshotField(value.mentions, decodeSnapshotIdentifiers)
    const mentionRoleIds = decodeSnapshotField(value.mention_roles, decodeSnapshotIdentifiers)
    const mentionChannels = decodeSnapshotField(value.mention_channels, decodeSnapshotMentionChannels)
    const embeds = decodeSnapshotField(value.embeds, decodeEmbeds)
    const attachments = decodeSnapshotField(value.attachments, decodeAttachments)
    const stickers = decodeSnapshotField(value.stickers, decodeStickers)
    if (
        mentionUserIds === undefined ||
        mentionRoleIds === undefined ||
        mentionChannels === undefined ||
        embeds === undefined ||
        attachments === undefined ||
        stickers === undefined
    )
        return undefined
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
    decode: (value: unknown) => A | undefined,
): Observed<A | null> | undefined {
    if (value === undefined) return { value: undefined }
    if (value === null) return { value: null }
    const decoded = decode(value)
    return decoded === undefined ? undefined : { value: decoded }
}

function decodeSnapshotIdentifiers(value: unknown): readonly string[] | undefined {
    return Array.isArray(value) && value.every(identifier) ? Object.freeze([...value]) : undefined
}

function decodeSnapshotMentionChannels(value: unknown): readonly MessageChannelMention[] | undefined {
    const decoded = decodeMentionChannels(value)
    return decoded?.value === null || decoded?.value === undefined ? undefined : decoded.value
}

function decodeReferencedMessage(value: unknown): Observed<MessageReference | null> | undefined {
    if (value === undefined) return { value: undefined }
    if (value === null) return { value: null }
    if (!record(value) || !identifier(value.id) || !identifier(value.channel_id)) return undefined
    return { value: Object.freeze({ id: value.id, channelId: value.channel_id }) }
}

export function reference(value: unknown): value is MessageReference {
    return record(value) && identifier(value.id) && identifier(value.channelId)
}

export function encodeHistory(channelId: unknown, query: unknown) {
    if (!identifier(channelId)) return undefined
    const input = query === undefined ? {} : query
    if (!record(input) || Object.keys(input).some((key) => !["limit", "before", "after", "around"].includes(key)))
        return undefined
    const limit = input.limit === undefined ? 50 : input.limit
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) return undefined
    const cursors = ["before", "after", "around"].filter((key) => input[key] !== undefined)
    if (cursors.length > 1) return undefined
    const params = new URLSearchParams({ limit: String(limit) })
    for (const key of cursors) {
        const id = input[key]
        if (!identifier(id)) return undefined
        params.set(key, id)
    }
    return { limit, params }
}

export function decodeDeletion(value: unknown): MessageDeletion | undefined {
    if (!record(value) || !identifier(value.id) || !identifier(value.channel_id)) return undefined
    if ("content" in value && value.content !== null && typeof value.content !== "string") return undefined
    if ("author_id" in value && !identifier(value.author_id)) return undefined
    return Object.freeze({
        id: value.id,
        channelId: value.channel_id,
        ...(value.content === null || typeof value.content === "string" ? { content: value.content } : {}),
        ...(identifier(value.author_id) ? { authorId: value.author_id } : {}),
    })
}

export function decodeBulkDeletion(value: unknown): MessageBulkDeletion | undefined {
    if (!record(value) || !identifier(value.channel_id) || !Array.isArray(value.ids) || !value.ids.every(identifier))
        return undefined
    return Object.freeze({ channelId: value.channel_id, ids: Object.freeze([...value.ids]) })
}

/** Unknown input fields fail before dispatch; unknown wire response fields are not copied into snapshots */
export function encodeMessage(channelId: unknown, input: unknown, nonce: string): EncodedBody | MessageError {
    const invalid = () => new MessageError("input", "notSent")
    if (!identifier(channelId) || !record(input)) return invalid()
    if (
        Object.keys(input).some(
            (key) =>
                ![
                    "content",
                    "embeds",
                    "attachments",
                    "stickerIds",
                    "allowedMentions",
                    "messageReference",
                    "flags",
                ].includes(key),
        )
    )
        return invalid()
    const attachments = encodeAttachments(input.attachments, false)
    const body = encodeBody(input, attachments?.uploadedFilenames)
    const stickerIds = input.stickerIds
    if (
        stickerIds !== undefined &&
        (!Array.isArray(stickerIds) || stickerIds.length > 3 || !Array.from(stickerIds).every(identifier))
    )
        return invalid()
    if (
        !attachments ||
        !body ||
        (input.flags !== undefined && !writableFlags(input.flags)) ||
        (!(typeof input.content === "string" && input.content.length > 0) &&
            !body.embeds?.length &&
            !attachments.files.length &&
            !stickerIds?.length)
    )
        return invalid()
    const mentions = encodeAllowedMentions(input.allowedMentions)
    if (!mentions) return invalid()
    const ref = input.messageReference
    if (ref !== undefined && (!reference(ref) || ref.channelId !== channelId)) return invalid()
    return {
        files: attachments.files,
        json: JSON.stringify({
            ...body,
            ...(stickerIds === undefined ? {} : { sticker_ids: [...stickerIds] }),
            ...(attachments.metadata === undefined ? {} : { attachments: attachments.metadata }),
            nonce,
            allowed_mentions: mentions,
            ...(input.flags === undefined ? {} : { flags: input.flags }),
            ...(ref === undefined
                ? {}
                : { message_reference: { message_id: ref.id, channel_id: ref.channelId, type: 0 } }),
        }),
    }
}

/** Forward inputs encode only Fluxer's source reference and optional media selectors */
export function encodeForward(channelId: unknown, input: unknown, nonce: string): EncodedBody | MessageError {
    const invalid = () => new MessageError("input", "notSent")
    if (
        !identifier(channelId) ||
        !record(input) ||
        Object.keys(input).some((key) => !["source", "attachmentIds", "embedIndices"].includes(key))
    )
        return invalid()
    const source = input.source
    if (!reference(source)) return invalid()
    const attachmentIds = input.attachmentIds
    const embedIndices = input.embedIndices
    if (
        (attachmentIds !== undefined &&
            (!Array.isArray(attachmentIds) ||
                attachmentIds.length > 10 ||
                !Array.from(attachmentIds).every(identifier))) ||
        (embedIndices !== undefined &&
            (!Array.isArray(embedIndices) ||
                embedIndices.length > 10 ||
                !Array.from(embedIndices).every(
                    (index) =>
                        typeof index === "number" &&
                        Number.isSafeInteger(index) &&
                        index >= 0 &&
                        index <= 2_147_483_647,
                )))
    )
        return invalid()
    return {
        files: [],
        json: JSON.stringify({
            nonce,
            message_reference: {
                message_id: source.id,
                channel_id: source.channelId,
                type: 1,
                ...(attachmentIds === undefined ? {} : { attachment_ids: [...attachmentIds] }),
                ...(embedIndices === undefined ? {} : { embed_indices: [...embedIndices] }),
            },
        }),
    }
}

function encodeAllowedMentions(value: unknown) {
    const mentions = value === undefined ? {} : value
    if (
        !record(mentions) ||
        Object.keys(mentions).some((key) => !["users", "roles", "everyone", "repliedUser"].includes(key))
    )
        return undefined
    for (const key of ["users", "roles"]) {
        const list = mentions[key]
        if (list !== undefined && (!Array.isArray(list) || list.length > 100 || !list.every(identifier)))
            return undefined
    }
    for (const key of ["everyone", "repliedUser"])
        if (mentions[key] !== undefined && typeof mentions[key] !== "boolean") return undefined
    return {
        parse: mentions.everyone === true ? ["everyone"] : [],
        users: mentions.users ?? [],
        roles: mentions.roles ?? [],
        replied_user: mentions.repliedUser ?? false,
    }
}

export function encodeEdit(input: unknown): EncodedBody | undefined {
    if (!record(input)) return undefined
    if (
        Object.keys(input).some(
            (key) => !["content", "embeds", "attachments", "allowedMentions", "flags"].includes(key),
        )
    )
        return undefined
    const attachments = encodeAttachments(input.attachments, true)
    const body = encodeBody(input, attachments?.uploadedFilenames)
    const mentions = encodeAllowedMentions(input.allowedMentions)
    const hasBodyInput = input.content !== undefined || input.embeds !== undefined || input.attachments !== undefined
    if (
        !mentions ||
        !attachments ||
        (input.flags !== undefined && !writableFlags(input.flags)) ||
        (!body && (hasBodyInput || input.flags === undefined)) ||
        (attachments.metadata?.length === 0 && !input.content && !body?.embeds?.length)
    )
        return undefined
    return {
        files: attachments.files,
        json: JSON.stringify({
            ...body,
            allowed_mentions: mentions,
            ...(input.flags === undefined ? {} : { flags: input.flags }),
            ...(attachments.metadata === undefined ? {} : { attachments: attachments.metadata }),
        }),
    }
}

export function replyInput(target: unknown, input: unknown): MessageInput | MessageError {
    const attachments = record(input) ? encodeAttachments(input.attachments, false) : undefined
    if (
        !reference(target) ||
        !record(input) ||
        "messageReference" in input ||
        !attachments ||
        !encodeBody(input, attachments.uploadedFilenames)
    )
        return new MessageError("input", "notSent")
    // Body presence/types were checked above; send performs complete validation of mentions and unknown keys
    return { ...input, messageReference: target } as MessageInput
}

function encodeBody(input: Record<string, unknown>, uploadedFilenames?: readonly string[]) {
    if (
        input.content === undefined &&
        input.embeds === undefined &&
        input.attachments === undefined &&
        input.stickerIds === undefined
    )
        return undefined
    if (input.content !== undefined && typeof input.content !== "string") return undefined
    const embeds = input.embeds === undefined ? undefined : encodeEmbeds(input.embeds, uploadedFilenames)
    if (input.embeds !== undefined && embeds === undefined) return undefined
    return {
        ...(input.content === undefined ? {} : { content: input.content }),
        ...(embeds === undefined ? {} : { embeds }),
    }
}
