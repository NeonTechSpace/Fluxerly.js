import { MessageFlags } from "#sdk/messages"
import type {
    Message,
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
import type { MessageObservation } from "./message-fields.js"
import { MessageError } from "#sdk/message-errors"
import { InputValidationFailure, inputValidationFailure } from "#sdk/input-validation"
import { decodeEmbeds, encodeEmbeds } from "./embeds.js"
import { decodeAttachments, encodeAttachments, type EncodedBody } from "./attachments.js"
import { validCalendarTimestamp } from "./timestamp.js"

export const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
export const identifier = (value: unknown): value is string =>
    typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)

const timestamp = (value: unknown): value is string =>
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
    validCalendarTimestamp(value)
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

function decodeMessageValue(
    value: unknown,
    fields: ReadonlySet<MessageField> | undefined,
    allowReferencedMessage: boolean,
    construct: boolean,
): MessageObservation | true | undefined {
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
        (value.mention_everyone !== undefined && typeof value.mention_everyone !== "boolean") ||
        (value.nonce !== undefined && value.nonce !== null && typeof value.nonce !== "string")
    )
        return undefined
    if (value.webhook_id != null && !identifier(value.webhook_id)) return undefined
    const author = decodeMessageUser(value.author, construct)
    if (!author) return undefined
    const selected = (field: MessageField) => construct && (fields === undefined || fields.has(field))
    const embeds = decodeEmbeds(value.embeds, selected("embeds"))
    const attachments = decodeAttachments(value.attachments, selected("attachments"))
    const stickers = decodeStickers(value.stickers, selected("stickers"))
    if (embeds === undefined || attachments === undefined || stickers === undefined) return undefined
    const mentions = decodeMentions(value.mentions, selected("mentions"))
    const referencedUsers = decodeReferencedUsers(value.users, selected("referencedUsers"))
    const mentionRoles = decodeIdentifiers(value.mention_roles, selected("mentionRoleIds"))
    const nsfwEmojiIds = decodeIdentifiers(value.nsfw_emojis, selected("nsfwEmojiIds"))
    const mentionChannels = decodeMentionChannels(value.mention_channels, selected("mentionChannels"))
    const reactions = decodeReactionSummaries(value.reactions, selected("reactions"))
    const messageReference = decodeMessageReference(value.message_reference, selected("messageReference"))
    const messageSnapshots = decodeMessageSnapshots(value.message_snapshots, selected("messageSnapshots"))
    const referencedMessage = allowReferencedMessage
        ? decodeReferencedMessage(value.referenced_message, selected("referencedMessage"))
        : "referenced_message" in value
          ? undefined
          : unobserved
    if (
        mentions === undefined ||
        referencedUsers === undefined ||
        mentionRoles === undefined ||
        nsfwEmojiIds === undefined ||
        mentionChannels === undefined ||
        reactions === undefined ||
        messageReference === undefined ||
        messageSnapshots === undefined ||
        referencedMessage === undefined
    )
        return undefined
    if (!construct) return true
    return Object.freeze({
        id: value.id,
        channelId: value.channel_id,
        content: value.content,
        ...(!selected("nonce") || value.nonce === undefined ? {} : { nonce: value.nonce }),
        ...(!selected("webhookId") || value.webhook_id == null ? {} : { webhookId: value.webhook_id }),
        ...(!selected("pinned") || value.pinned === undefined ? {} : { pinned: value.pinned }),
        ...(!selected("createdAt") || value.timestamp === undefined ? {} : { createdAt: value.timestamp }),
        ...(!selected("editedAt") || value.edited_timestamp === undefined ? {} : { editedAt: value.edited_timestamp }),
        ...(!selected("type") || value.type === undefined ? {} : { type: value.type }),
        ...(!selected("flags") || value.flags === undefined ? {} : { flags: value.flags }),
        ...(value.guild_id === undefined ? {} : { guildId: value.guild_id }),
        ...(!selected("mentionedEveryone") || value.mention_everyone === undefined
            ? {}
            : { mentionedEveryone: value.mention_everyone }),
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

function decodeMessageUser(value: unknown, construct = true): MessageUser | true | undefined {
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
        (value.flags !== undefined && !int32(value.flags)) ||
        (value.mention_flags !== undefined &&
            value.mention_flags !== 0 &&
            value.mention_flags !== 1 &&
            value.mention_flags !== 2)
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
        ...(value.mention_flags === undefined ? {} : { mentionFlags: value.mention_flags as 0 | 1 | 2 }),
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
        !identifier(value.message_id) ||
        !identifier(value.channel_id) ||
        (value.guild_id !== undefined && value.guild_id !== null && !identifier(value.guild_id)) ||
        (value.type !== undefined && !int32(value.type))
    )
        return undefined
    if (!construct) return unobserved
    return {
        value: Object.freeze({
            id: value.message_id,
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
    const mentionUserIds = decodeSnapshotField(value.mentions, decodeSnapshotIdentifiers, construct)
    const mentionRoleIds = decodeSnapshotField(value.mention_roles, decodeSnapshotIdentifiers, construct)
    const mentionChannels = decodeSnapshotField(value.mention_channels, decodeSnapshotMentionChannels, construct)
    const embeds = decodeSnapshotField(value.embeds, decodeEmbeds, construct)
    const attachments = decodeSnapshotField(value.attachments, decodeAttachments, construct)
    const stickers = decodeSnapshotField(value.stickers, decodeStickers, construct)
    if (
        mentionUserIds === undefined ||
        mentionRoleIds === undefined ||
        mentionChannels === undefined ||
        embeds === undefined ||
        attachments === undefined ||
        stickers === undefined
    )
        return undefined
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
    return identifier(id) && identifier(channelId) ? Object.freeze({ id, channelId }) : undefined
}

export function encodeHistory(channelId: unknown, query: unknown) {
    if (!identifier(channelId))
        return inputValidationFailure("channelId", "format", "Channel IDs must be decimal strings")
    const input = query === undefined ? {} : query
    if (!record(input)) return inputValidationFailure("query", "type", "History query must be an object")
    if (Object.keys(input).some((key) => !["limit", "before", "after", "around"].includes(key)))
        return inputValidationFailure(
            "query",
            "allowedFields",
            "History query may contain only limit, before, after, and around",
        )
    const limit = input.limit === undefined ? 50 : input.limit
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100)
        return inputValidationFailure("query.limit", "range", "History limit must be an integer from 1 through 100")
    const cursors = ["before", "after", "around"].filter((key) => input[key] !== undefined)
    if (cursors.length > 1)
        return inputValidationFailure(
            "query",
            "relationship",
            "History query may contain at most one of before, after, and around",
        )
    const params = new URLSearchParams({ limit: String(limit) })
    for (const key of cursors) {
        const id = input[key]
        if (!identifier(id))
            return inputValidationFailure(`query.${key}`, "format", "History cursor IDs must be decimal strings")
        params.set(key, id)
    }
    return { limit, params }
}

export function decodeDeletion(value: unknown): MessageDeletion | undefined {
    if (!record(value) || !identifier(value.id) || !identifier(value.channel_id)) return undefined
    if (value.guild_id !== undefined && !identifier(value.guild_id)) return undefined
    if ("content" in value && value.content !== null && typeof value.content !== "string") return undefined
    if ("author_id" in value && !identifier(value.author_id)) return undefined
    return Object.freeze({
        id: value.id,
        channelId: value.channel_id,
        ...(value.guild_id === undefined ? {} : { guildId: value.guild_id as string }),
        ...(value.content === null || typeof value.content === "string" ? { content: value.content } : {}),
        ...(identifier(value.author_id) ? { authorId: value.author_id } : {}),
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

const messageInputKeys: readonly string[] = [
    "content",
    "nonce",
    "embeds",
    "attachments",
    "stickerIds",
    "allowedMentions",
    "messageReference",
    "flags",
]

/** Unknown input fields fail before dispatch; unknown wire response fields are not copied into snapshots */
export function encodeMessage(
    channelId: unknown,
    input: unknown,
    defaultNonce: string,
    replyTarget?: MessageReference,
): EncodedBody | MessageError {
    const invalid = (failure: InputValidationFailure) =>
        new MessageError("input", "notSent", null, null, null, failure.detail)
    if (!identifier(channelId))
        return invalid(inputValidationFailure("channelId", "format", "Channel IDs must be decimal strings"))
    if (!record(input)) return invalid(inputValidationFailure("input", "type", "Message input must be an object"))
    if (Object.keys(input).some((key) => !messageInputKeys.includes(key)))
        return invalid(
            inputValidationFailure(
                "input",
                "allowedFields",
                "Message input may contain only content, nonce, embeds, attachments, stickerIds, allowedMentions, messageReference, and flags",
            ),
        )
    const nonce = encodeNonce(input.nonce, defaultNonce)
    if (nonce instanceof InputValidationFailure) return invalid(nonce)
    const attachments = encodeAttachments(input.attachments, false)
    if (attachments instanceof InputValidationFailure) return invalid(attachments)
    const body = encodeBody(input, attachments.uploadedFilenames)
    if (body instanceof InputValidationFailure) return invalid(body)
    const stickerInput = input.stickerIds
    let stickerIds: readonly unknown[] | undefined
    if (stickerInput !== undefined) {
        if (!Array.isArray(stickerInput))
            return invalid(inputValidationFailure("stickerIds", "type", "Sticker IDs must be an array"))
        const count = stickerInput.length
        if (count > 3)
            return invalid(
                inputValidationFailure("stickerIds", "length", "A message may contain at most three sticker IDs"),
            )
        stickerIds = snapshotArray(stickerInput, count)
        if (!stickerIds.every(identifier))
            return invalid(inputValidationFailure("stickerIds[]", "format", "Sticker IDs must be decimal strings"))
    }
    if (input.flags !== undefined && !writableFlags(input.flags))
        return invalid(
            inputValidationFailure(
                "flags",
                "allowedValue",
                "Message flags may contain only SuppressEmbeds and SuppressNotifications",
            ),
        )
    if (body === undefined)
        return invalid(
            inputValidationFailure(
                "input",
                "required",
                "A message must contain non-empty content, an embed, an attachment, or a sticker",
            ),
        )
    if (
        !(typeof input.content === "string" && input.content.length > 0) &&
        !body.embeds?.length &&
        !attachments.files.length &&
        !stickerIds?.length
    )
        return invalid(
            inputValidationFailure(
                "input",
                "required",
                "A message must contain non-empty content, an embed, an attachment, or a sticker",
            ),
        )
    const mentions = encodeAllowedMentions(input.allowedMentions)
    if (mentions instanceof InputValidationFailure) return invalid(mentions)
    const rawReference = replyTarget ?? input.messageReference
    const ref = rawReference === undefined ? undefined : snapshotReference(rawReference)
    if (rawReference !== undefined && ref === undefined)
        return invalid(
            inputValidationFailure(
                "messageReference",
                "format",
                "Message references require decimal id and channelId strings",
            ),
        )
    if (ref !== undefined && ref.channelId !== channelId)
        return invalid(
            inputValidationFailure(
                "messageReference.channelId",
                "relationship",
                "A reply reference must use the destination channel ID",
            ),
        )
    return {
        files: attachments.files,
        json: JSON.stringify({
            ...body,
            ...(stickerIds === undefined ? {} : { sticker_ids: stickerIds }),
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
export function encodeForward(channelId: unknown, input: unknown, defaultNonce: string): EncodedBody | MessageError {
    const invalid = (failure: InputValidationFailure) =>
        new MessageError("input", "notSent", null, null, null, failure.detail)
    if (!identifier(channelId))
        return invalid(inputValidationFailure("channelId", "format", "Channel IDs must be decimal strings"))
    if (!record(input)) return invalid(inputValidationFailure("input", "type", "Forward input must be an object"))
    if (Object.keys(input).some((key) => !["source", "nonce", "attachmentIds", "embedIndices"].includes(key)))
        return invalid(
            inputValidationFailure(
                "input",
                "allowedFields",
                "Forward input may contain only source, nonce, attachmentIds, and embedIndices",
            ),
        )
    const nonce = encodeNonce(input.nonce, defaultNonce)
    if (nonce instanceof InputValidationFailure) return invalid(nonce)
    const source = snapshotReference(input.source)
    if (source === undefined)
        return invalid(
            inputValidationFailure("source", "format", "Forward source requires decimal id and channelId strings"),
        )
    const attachmentIdsInput = input.attachmentIds
    const embedIndicesInput = input.embedIndices
    let attachmentIds: readonly unknown[] | undefined
    if (attachmentIdsInput !== undefined) {
        if (!Array.isArray(attachmentIdsInput))
            return invalid(inputValidationFailure("attachmentIds", "type", "Forward attachment IDs must be an array"))
        const count = attachmentIdsInput.length
        if (count > 10)
            return invalid(
                inputValidationFailure("attachmentIds", "length", "A forward may select at most ten attachments"),
            )
        attachmentIds = snapshotArray(attachmentIdsInput, count)
        if (!attachmentIds.every(identifier))
            return invalid(
                inputValidationFailure("attachmentIds[]", "format", "Forward attachment IDs must be decimal strings"),
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
                    "Forward embed indices must be nonnegative 32-bit integers",
                ),
            )
    }
    return {
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

function encodeNonce(value: unknown, defaultNonce: string): string | InputValidationFailure {
    if (value === undefined) return defaultNonce
    if (typeof value === "string") {
        if (value.length >= 1 && value.length <= 32) return value
        return inputValidationFailure("nonce", "length", "Message nonces must contain from 1 through 32 characters")
    }
    if (typeof value === "number") {
        if (Number.isSafeInteger(value) && value >= 0) return String(value)
        return inputValidationFailure("nonce", "range", "Message nonce numbers must be nonnegative safe integers")
    }
    return inputValidationFailure("nonce", "type", "Message nonces must be strings or nonnegative safe integers")
}

function encodeAllowedMentions(value: unknown) {
    const mentions = value === undefined ? {} : value
    if (!record(mentions))
        return inputValidationFailure("allowedMentions", "type", "Allowed mentions must be an object")
    if (Object.keys(mentions).some((key) => !["users", "roles", "everyone", "repliedUser"].includes(key)))
        return inputValidationFailure(
            "allowedMentions",
            "allowedFields",
            "Allowed mentions may contain only users, roles, everyone, and repliedUser",
        )
    const selections: Record<"users" | "roles", readonly unknown[] | undefined> = { users: undefined, roles: undefined }
    for (const key of ["users", "roles"] as const) {
        const list = mentions[key]
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
        const selection = snapshotArray(list, count)
        if (!selection.every(identifier))
            return inputValidationFailure(
                `allowedMentions.${key}[]`,
                "format",
                "Mention selection IDs must be decimal strings",
            )
        selections[key] = selection
    }
    for (const key of ["everyone", "repliedUser"])
        if (mentions[key] !== undefined && typeof mentions[key] !== "boolean")
            return inputValidationFailure(`allowedMentions.${key}`, "type", "Mention switches must be booleans")
    return {
        parse: mentions.everyone === true ? ["everyone"] : [],
        users: selections.users ?? [],
        roles: selections.roles ?? [],
        replied_user: mentions.repliedUser ?? false,
    }
}

/** Copy already bounded indexed entries once, avoiding caller-defined iteration during validation or encoding */
function snapshotArray(value: readonly unknown[], count: number): readonly unknown[] {
    const result: unknown[] = []
    for (let index = 0; index < count; index += 1) result.push(value[index])
    return Object.freeze(result)
}

export function encodeEdit(input: unknown): EncodedBody | InputValidationFailure {
    if (!record(input)) return inputValidationFailure("input", "type", "Message edit input must be an object")
    if (
        Object.keys(input).some(
            (key) => !["content", "embeds", "attachments", "allowedMentions", "flags"].includes(key),
        )
    )
        return inputValidationFailure(
            "input",
            "allowedFields",
            "Message edit input may contain only content, embeds, attachments, allowedMentions, and flags",
        )
    const attachments = encodeAttachments(input.attachments, true)
    if (attachments instanceof InputValidationFailure) return attachments
    const body = encodeBody(input, attachments.uploadedFilenames)
    if (body instanceof InputValidationFailure) return body
    const mentions = encodeAllowedMentions(input.allowedMentions)
    if (mentions instanceof InputValidationFailure) return mentions
    const hasBodyInput = input.content !== undefined || input.embeds !== undefined || input.attachments !== undefined
    if (input.flags !== undefined && !writableFlags(input.flags))
        return inputValidationFailure(
            "flags",
            "allowedValue",
            "Message flags may contain only SuppressEmbeds and SuppressNotifications",
        )
    if (!body && (hasBodyInput || input.flags === undefined))
        return inputValidationFailure("input", "required", "A message edit must contain at least one editable field")
    if (attachments.metadata?.length === 0 && !input.content && !body?.embeds?.length)
        return inputValidationFailure(
            "input",
            "required",
            "A message edit must retain non-empty content, an embed, or an attachment",
        )
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

export function replyInput(
    target: unknown,
    input: unknown,
): { readonly target: MessageReference; readonly input: MessageInput } | MessageError {
    const invalid = (failure: InputValidationFailure) =>
        new MessageError("input", "notSent", null, null, null, failure.detail)
    const reference = snapshotReference(target)
    if (reference === undefined)
        return invalid(
            inputValidationFailure("target", "format", "Reply targets require decimal id and channelId strings"),
        )
    if (!record(input)) return invalid(inputValidationFailure("input", "type", "Reply input must be an object"))
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

function encodeBody(input: Record<string, unknown>, uploadedFilenames?: readonly string[]) {
    if (
        input.content === undefined &&
        input.embeds === undefined &&
        input.attachments === undefined &&
        input.stickerIds === undefined
    )
        return undefined
    if (input.content !== undefined && typeof input.content !== "string")
        return inputValidationFailure("content", "type", "Message content must be a string")
    const embeds = input.embeds === undefined ? undefined : encodeEmbeds(input.embeds, uploadedFilenames)
    if (embeds instanceof InputValidationFailure) return embeds
    return {
        ...(input.content === undefined ? {} : { content: input.content }),
        ...(embeds === undefined ? {} : { embeds }),
    }
}
