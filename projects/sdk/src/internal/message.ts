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
import { InputValidationFailure, inputValidationFailure } from "#sdk/input-validation"
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
        (value.mention_everyone !== undefined && typeof value.mention_everyone !== "boolean") ||
        (value.nonce !== undefined && value.nonce !== null && typeof value.nonce !== "string")
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
        ...(value.nonce === undefined ? {} : { nonce: value.nonce }),
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
export function encodeMessage(channelId: unknown, input: unknown, defaultNonce: string): EncodedBody | MessageError {
    const invalid = (failure: InputValidationFailure) =>
        new MessageError("input", "notSent", null, null, null, failure.detail)
    if (!identifier(channelId))
        return invalid(inputValidationFailure("channelId", "format", "Channel IDs must be decimal strings"))
    if (!record(input)) return invalid(inputValidationFailure("input", "type", "Message input must be an object"))
    if (
        Object.keys(input).some(
            (key) =>
                ![
                    "content",
                    "nonce",
                    "embeds",
                    "attachments",
                    "stickerIds",
                    "allowedMentions",
                    "messageReference",
                    "flags",
                ].includes(key),
        )
    )
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
    const stickerIds = input.stickerIds
    if (stickerIds !== undefined && !Array.isArray(stickerIds))
        return invalid(inputValidationFailure("stickerIds", "type", "Sticker IDs must be an array"))
    if (Array.isArray(stickerIds) && stickerIds.length > 3)
        return invalid(
            inputValidationFailure("stickerIds", "length", "A message may contain at most three sticker IDs"),
        )
    if (Array.isArray(stickerIds) && !Array.from(stickerIds).every(identifier))
        return invalid(inputValidationFailure("stickerIds[]", "format", "Sticker IDs must be decimal strings"))
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
        !(Array.isArray(stickerIds) && stickerIds.length)
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
    const ref = input.messageReference
    if (ref !== undefined && !reference(ref))
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
    const source = input.source
    if (!reference(source))
        return invalid(
            inputValidationFailure("source", "format", "Forward source requires decimal id and channelId strings"),
        )
    const attachmentIds = input.attachmentIds
    const embedIndices = input.embedIndices
    if (attachmentIds !== undefined && !Array.isArray(attachmentIds))
        return invalid(inputValidationFailure("attachmentIds", "type", "Forward attachment IDs must be an array"))
    if (Array.isArray(attachmentIds) && attachmentIds.length > 10)
        return invalid(
            inputValidationFailure("attachmentIds", "length", "A forward may select at most ten attachments"),
        )
    if (Array.isArray(attachmentIds) && !Array.from(attachmentIds).every(identifier))
        return invalid(
            inputValidationFailure("attachmentIds[]", "format", "Forward attachment IDs must be decimal strings"),
        )
    if (embedIndices !== undefined && !Array.isArray(embedIndices))
        return invalid(inputValidationFailure("embedIndices", "type", "Forward embed indices must be an array"))
    if (Array.isArray(embedIndices) && embedIndices.length > 10)
        return invalid(inputValidationFailure("embedIndices", "length", "A forward may select at most ten embeds"))
    if (
        Array.isArray(embedIndices) &&
        !Array.from(embedIndices).every(
            (index) => typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && index <= 2_147_483_647,
        )
    )
        return invalid(
            inputValidationFailure(
                "embedIndices[]",
                "range",
                "Forward embed indices must be nonnegative 32-bit integers",
            ),
        )
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
    for (const key of ["users", "roles"]) {
        const list = mentions[key]
        if (list !== undefined && !Array.isArray(list))
            return inputValidationFailure(`allowedMentions.${key}`, "type", "Mention selections must be arrays")
        if (Array.isArray(list) && list.length > 100)
            return inputValidationFailure(
                `allowedMentions.${key}`,
                "length",
                "Mention selections may contain at most 100 IDs",
            )
        if (Array.isArray(list) && !Array.from(list).every(identifier))
            return inputValidationFailure(
                `allowedMentions.${key}[]`,
                "format",
                "Mention selection IDs must be decimal strings",
            )
    }
    for (const key of ["everyone", "repliedUser"])
        if (mentions[key] !== undefined && typeof mentions[key] !== "boolean")
            return inputValidationFailure(`allowedMentions.${key}`, "type", "Mention switches must be booleans")
    return {
        parse: mentions.everyone === true ? ["everyone"] : [],
        users: mentions.users ?? [],
        roles: mentions.roles ?? [],
        replied_user: mentions.repliedUser ?? false,
    }
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

export function replyInput(target: unknown, input: unknown): MessageInput | MessageError {
    const invalid = (failure: InputValidationFailure) =>
        new MessageError("input", "notSent", null, null, null, failure.detail)
    if (!reference(target))
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
    const attachments = encodeAttachments(input.attachments, false)
    if (attachments instanceof InputValidationFailure) return invalid(attachments)
    const body = encodeBody(input, attachments.uploadedFilenames)
    if (body instanceof InputValidationFailure) return invalid(body)
    if (!body)
        return invalid(
            inputValidationFailure("input", "required", "A reply must contain content, an embed, or an attachment"),
        )
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
    if (input.content !== undefined && typeof input.content !== "string")
        return inputValidationFailure("content", "type", "Message content must be a string")
    const embeds = input.embeds === undefined ? undefined : encodeEmbeds(input.embeds, uploadedFilenames)
    if (embeds instanceof InputValidationFailure) return embeds
    return {
        ...(input.content === undefined ? {} : { content: input.content }),
        ...(embeds === undefined ? {} : { embeds }),
    }
}
