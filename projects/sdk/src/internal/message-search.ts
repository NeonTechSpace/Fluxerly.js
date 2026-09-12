import type {
    MessageSearchChannel,
    MessageSearchContentType,
    MessageSearchEmbedType,
    MessageSearchPage,
} from "#sdk/message-search"
import { decodeMessage, identifier, record } from "./message.js"
import { inputValidationFailure } from "#sdk/input-validation"

const queryKeys = new Set([
    "limit",
    "page",
    "cursor",
    "maxId",
    "minId",
    "content",
    "contents",
    "exactPhrases",
    "channelIds",
    "excludeChannelIds",
    "authorTypes",
    "excludeAuthorTypes",
    "authorIds",
    "excludeAuthorIds",
    "mentions",
    "excludeMentions",
    "mentionedEveryone",
    "pinned",
    "has",
    "excludeHas",
    "embedTypes",
    "excludeEmbedTypes",
    "embedProviders",
    "excludeEmbedProviders",
    "linkHostnames",
    "excludeLinkHostnames",
    "attachmentFilenames",
    "excludeAttachmentFilenames",
    "attachmentExtensions",
    "excludeAttachmentExtensions",
    "sortBy",
    "sortOrder",
    "includeNsfw",
])
const contentTypes = new Set<MessageSearchContentType>([
    "image",
    "sound",
    "video",
    "file",
    "sticker",
    "embed",
    "link",
    "poll",
    "snapshot",
])
const embedTypes = new Set<MessageSearchEmbedType>(["image", "video", "sound", "article"])
const authorTypes = new Set(["user", "bot", "webhook"])

const integer = (value: unknown, minimum: number, maximum: number): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum

function identifiers(value: unknown, maximum: number): value is readonly string[] {
    return Array.isArray(value) && value.length <= maximum && Array.from(value).every(identifier)
}

function texts(value: unknown, maximum: number, length: number): value is readonly string[] {
    return (
        Array.isArray(value) &&
        value.length <= maximum &&
        Array.from(value).every((item) => typeof item === "string" && item.length >= 1 && item.length <= length)
    )
}

function literals(value: unknown, maximum: number, allowed: ReadonlySet<string>): value is readonly string[] {
    return (
        Array.isArray(value) &&
        value.length <= maximum &&
        Array.from(value).every((item) => typeof item === "string" && allowed.has(item))
    )
}

/** Copy one strict contextual request into Fluxer's bot-permitted current scope */
export function encodeMessageSearch(contextInput: unknown, query?: unknown) {
    const input = query === undefined ? {} : query
    if (!record(contextInput))
        return inputValidationFailure("context", "type", "Message search context must be an object")
    if (Object.keys(contextInput).some((key) => key !== "guildId" && key !== "channelId"))
        return inputValidationFailure(
            "context",
            "allowedFields",
            "Message search context may contain only guildId and channelId",
        )
    if (contextInput.guildId === undefined && contextInput.channelId === undefined)
        return inputValidationFailure("context", "required", "Message search context requires guildId or channelId")
    if (contextInput.guildId !== undefined && !identifier(contextInput.guildId))
        return inputValidationFailure("context.guildId", "format", "Guild IDs must be decimal strings")
    if (contextInput.channelId !== undefined && !identifier(contextInput.channelId))
        return inputValidationFailure("context.channelId", "format", "Channel IDs must be decimal strings")
    if (!record(input)) return inputValidationFailure("query", "type", "Message search query must be an object")
    if (Object.keys(input).some((key) => !queryKeys.has(key)))
        return inputValidationFailure(
            "query",
            "allowedFields",
            "Message search query may contain only documented search fields",
        )
    const limit = input.limit === undefined ? 25 : input.limit
    const page = input.page === undefined ? 1 : input.page
    const cursor = input.cursor
    if (!integer(limit, 1, 25))
        return inputValidationFailure(
            "query.limit",
            "range",
            "Message search limit must be an integer from 1 through 25",
        )
    if (!integer(page, 1, 400))
        return inputValidationFailure(
            "query.page",
            "range",
            "Message search page must be an integer from 1 through 400",
        )
    if (
        cursor !== undefined &&
        (!Array.isArray(cursor) || !Array.from(cursor).every((item) => typeof item === "string"))
    )
        return inputValidationFailure("query.cursor[]", "type", "Message search cursor entries must be strings")
    if (cursor !== undefined && input.page !== undefined)
        return inputValidationFailure("query", "relationship", "Message search query cannot combine cursor and page")
    if (input.maxId !== undefined && !identifier(input.maxId))
        return inputValidationFailure("query.maxId", "format", "Maximum message ID must be a decimal string")
    if (input.minId !== undefined && !identifier(input.minId))
        return inputValidationFailure("query.minId", "format", "Minimum message ID must be a decimal string")
    if (
        input.content !== undefined &&
        (typeof input.content !== "string" || input.content.length < 1 || input.content.length > 1024)
    )
        return inputValidationFailure(
            "query.content",
            "length",
            "Search content must contain 1 through 1,024 UTF-16 code units",
        )
    if (input.contents !== undefined && !texts(input.contents, 100, 1024))
        return inputValidationFailure(
            "query.contents[]",
            "format",
            "contents must be an array of at most 100 strings containing 1 through 1,024 UTF-16 code units",
        )
    if (input.exactPhrases !== undefined && !texts(input.exactPhrases, 10, 1024))
        return inputValidationFailure(
            "query.exactPhrases[]",
            "format",
            "exactPhrases must be an array of at most 10 strings containing 1 through 1,024 UTF-16 code units",
        )
    if (input.channelIds !== undefined && !identifiers(input.channelIds, 500))
        return inputValidationFailure(
            "query.channelIds[]",
            "format",
            "channelIds must be an array of at most 500 decimal ID strings",
        )
    if (input.excludeChannelIds !== undefined && !identifiers(input.excludeChannelIds, 500))
        return inputValidationFailure(
            "query.excludeChannelIds[]",
            "format",
            "excludeChannelIds must be an array of at most 500 decimal ID strings",
        )
    if (input.authorTypes !== undefined && !literals(input.authorTypes, 20, authorTypes))
        return inputValidationFailure(
            "query.authorTypes[]",
            "allowedValue",
            "authorTypes must be an array of at most 20 supported values",
        )
    if (input.excludeAuthorTypes !== undefined && !literals(input.excludeAuthorTypes, 20, authorTypes))
        return inputValidationFailure(
            "query.excludeAuthorTypes[]",
            "allowedValue",
            "excludeAuthorTypes must be an array of at most 20 supported values",
        )
    if (input.authorIds !== undefined && !identifiers(input.authorIds, 100))
        return inputValidationFailure(
            "query.authorIds[]",
            "format",
            "authorIds must be an array of at most 100 decimal ID strings",
        )
    if (input.excludeAuthorIds !== undefined && !identifiers(input.excludeAuthorIds, 100))
        return inputValidationFailure(
            "query.excludeAuthorIds[]",
            "format",
            "excludeAuthorIds must be an array of at most 100 decimal ID strings",
        )
    if (input.mentions !== undefined && !identifiers(input.mentions, 100))
        return inputValidationFailure(
            "query.mentions[]",
            "format",
            "mentions must be an array of at most 100 decimal ID strings",
        )
    if (input.excludeMentions !== undefined && !identifiers(input.excludeMentions, 100))
        return inputValidationFailure(
            "query.excludeMentions[]",
            "format",
            "excludeMentions must be an array of at most 100 decimal ID strings",
        )
    if (input.mentionedEveryone !== undefined && typeof input.mentionedEveryone !== "boolean")
        return inputValidationFailure("query.mentionedEveryone", "type", "mentionedEveryone must be a boolean")
    if (input.pinned !== undefined && typeof input.pinned !== "boolean")
        return inputValidationFailure("query.pinned", "type", "pinned must be a boolean")
    if (input.has !== undefined && !literals(input.has, 20, contentTypes))
        return inputValidationFailure(
            "query.has[]",
            "allowedValue",
            "has must be an array of at most 20 supported values",
        )
    if (input.excludeHas !== undefined && !literals(input.excludeHas, 20, contentTypes))
        return inputValidationFailure(
            "query.excludeHas[]",
            "allowedValue",
            "excludeHas must be an array of at most 20 supported values",
        )
    if (input.embedTypes !== undefined && !literals(input.embedTypes, 20, embedTypes))
        return inputValidationFailure(
            "query.embedTypes[]",
            "allowedValue",
            "embedTypes must be an array of at most 20 supported values",
        )
    if (input.excludeEmbedTypes !== undefined && !literals(input.excludeEmbedTypes, 20, embedTypes))
        return inputValidationFailure(
            "query.excludeEmbedTypes[]",
            "allowedValue",
            "excludeEmbedTypes must be an array of at most 20 supported values",
        )
    if (input.embedProviders !== undefined && !texts(input.embedProviders, 50, 256))
        return inputValidationFailure(
            "query.embedProviders[]",
            "format",
            "embedProviders must be an array of at most 50 strings containing 1 through 256 UTF-16 code units",
        )
    if (input.excludeEmbedProviders !== undefined && !texts(input.excludeEmbedProviders, 50, 256))
        return inputValidationFailure(
            "query.excludeEmbedProviders[]",
            "format",
            "excludeEmbedProviders must be an array of at most 50 strings containing 1 through 256 UTF-16 code units",
        )
    if (input.linkHostnames !== undefined && !texts(input.linkHostnames, 100, 255))
        return inputValidationFailure(
            "query.linkHostnames[]",
            "format",
            "linkHostnames must be an array of at most 100 strings containing 1 through 255 UTF-16 code units",
        )
    if (input.excludeLinkHostnames !== undefined && !texts(input.excludeLinkHostnames, 100, 255))
        return inputValidationFailure(
            "query.excludeLinkHostnames[]",
            "format",
            "excludeLinkHostnames must be an array of at most 100 strings containing 1 through 255 UTF-16 code units",
        )
    if (input.attachmentFilenames !== undefined && !texts(input.attachmentFilenames, 100, 1024))
        return inputValidationFailure(
            "query.attachmentFilenames[]",
            "format",
            "attachmentFilenames must be an array of at most 100 strings containing 1 through 1,024 UTF-16 code units",
        )
    if (input.excludeAttachmentFilenames !== undefined && !texts(input.excludeAttachmentFilenames, 100, 1024))
        return inputValidationFailure(
            "query.excludeAttachmentFilenames[]",
            "format",
            "excludeAttachmentFilenames must be an array of at most 100 strings containing 1 through 1,024 UTF-16 code units",
        )
    if (input.attachmentExtensions !== undefined && !texts(input.attachmentExtensions, 50, 32))
        return inputValidationFailure(
            "query.attachmentExtensions[]",
            "format",
            "attachmentExtensions must be an array of at most 50 strings containing 1 through 32 UTF-16 code units",
        )
    if (input.excludeAttachmentExtensions !== undefined && !texts(input.excludeAttachmentExtensions, 50, 32))
        return inputValidationFailure(
            "query.excludeAttachmentExtensions[]",
            "format",
            "excludeAttachmentExtensions must be an array of at most 50 strings containing 1 through 32 UTF-16 code units",
        )
    if (input.sortBy !== undefined && input.sortBy !== "timestamp" && input.sortBy !== "relevance")
        return inputValidationFailure("query.sortBy", "allowedValue", "sortBy must be timestamp or relevance")
    if (input.sortOrder !== undefined && input.sortOrder !== "asc" && input.sortOrder !== "desc")
        return inputValidationFailure("query.sortOrder", "allowedValue", "sortOrder must be asc or desc")
    if (input.includeNsfw !== undefined && typeof input.includeNsfw !== "boolean")
        return inputValidationFailure("query.includeNsfw", "type", "includeNsfw must be a boolean")
    const list = (value: readonly unknown[] | undefined) => (value === undefined ? undefined : [...value])
    return Object.freeze({
        limit,
        json: JSON.stringify({
            scope: "current",
            ...(contextInput.guildId === undefined ? {} : { context_guild_id: contextInput.guildId }),
            ...(contextInput.channelId === undefined ? {} : { context_channel_id: contextInput.channelId }),
            hits_per_page: limit,
            ...(cursor === undefined ? { page } : { cursor: [...cursor] }),
            ...(input.maxId === undefined ? {} : { max_id: input.maxId }),
            ...(input.minId === undefined ? {} : { min_id: input.minId }),
            ...(input.content === undefined ? {} : { content: input.content }),
            ...(input.contents === undefined ? {} : { contents: list(input.contents as readonly unknown[]) }),
            ...(input.exactPhrases === undefined
                ? {}
                : { exact_phrases: list(input.exactPhrases as readonly unknown[]) }),
            ...(input.channelIds === undefined ? {} : { channel_id: list(input.channelIds as readonly unknown[]) }),
            ...(input.excludeChannelIds === undefined
                ? {}
                : { exclude_channel_id: list(input.excludeChannelIds as readonly unknown[]) }),
            ...(input.authorTypes === undefined ? {} : { author_type: list(input.authorTypes as readonly unknown[]) }),
            ...(input.excludeAuthorTypes === undefined
                ? {}
                : { exclude_author_type: list(input.excludeAuthorTypes as readonly unknown[]) }),
            ...(input.authorIds === undefined ? {} : { author_id: list(input.authorIds as readonly unknown[]) }),
            ...(input.excludeAuthorIds === undefined
                ? {}
                : { exclude_author_id: list(input.excludeAuthorIds as readonly unknown[]) }),
            ...(input.mentions === undefined ? {} : { mentions: list(input.mentions as readonly unknown[]) }),
            ...(input.excludeMentions === undefined
                ? {}
                : { exclude_mentions: list(input.excludeMentions as readonly unknown[]) }),
            ...(input.mentionedEveryone === undefined ? {} : { mention_everyone: input.mentionedEveryone }),
            ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
            ...(input.has === undefined ? {} : { has: list(input.has as readonly unknown[]) }),
            ...(input.excludeHas === undefined ? {} : { exclude_has: list(input.excludeHas as readonly unknown[]) }),
            ...(input.embedTypes === undefined ? {} : { embed_type: list(input.embedTypes as readonly unknown[]) }),
            ...(input.excludeEmbedTypes === undefined
                ? {}
                : { exclude_embed_type: list(input.excludeEmbedTypes as readonly unknown[]) }),
            ...(input.embedProviders === undefined
                ? {}
                : { embed_provider: list(input.embedProviders as readonly unknown[]) }),
            ...(input.excludeEmbedProviders === undefined
                ? {}
                : { exclude_embed_provider: list(input.excludeEmbedProviders as readonly unknown[]) }),
            ...(input.linkHostnames === undefined
                ? {}
                : { link_hostname: list(input.linkHostnames as readonly unknown[]) }),
            ...(input.excludeLinkHostnames === undefined
                ? {}
                : { exclude_link_hostname: list(input.excludeLinkHostnames as readonly unknown[]) }),
            ...(input.attachmentFilenames === undefined
                ? {}
                : { attachment_filename: list(input.attachmentFilenames as readonly unknown[]) }),
            ...(input.excludeAttachmentFilenames === undefined
                ? {}
                : { exclude_attachment_filename: list(input.excludeAttachmentFilenames as readonly unknown[]) }),
            ...(input.attachmentExtensions === undefined
                ? {}
                : { attachment_extension: list(input.attachmentExtensions as readonly unknown[]) }),
            ...(input.excludeAttachmentExtensions === undefined
                ? {}
                : { exclude_attachment_extension: list(input.excludeAttachmentExtensions as readonly unknown[]) }),
            ...(input.sortBy === undefined ? {} : { sort_by: input.sortBy }),
            ...(input.sortOrder === undefined ? {} : { sort_order: input.sortOrder }),
            ...(input.includeNsfw === undefined ? {} : { include_nsfw: input.includeNsfw }),
        }),
    })
}

function channel(value: unknown): MessageSearchChannel | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        (value.guild_id !== undefined && !identifier(value.guild_id)) ||
        (value.name !== undefined && typeof value.name !== "string") ||
        !integer(value.type, 0, 2_147_483_647)
    )
        return undefined
    return Object.freeze({
        id: value.id,
        type: value.type,
        ...(value.guild_id === undefined ? {} : { guildId: value.guild_id }),
        ...(value.name === undefined ? {} : { name: value.name }),
    })
}

/** Decode only the frozen search page projections Fluxerly exposes. No search result enters the message or channel cache */
export function decodeMessageSearchPage(value: unknown): MessageSearchPage | undefined {
    if (!record(value)) return undefined
    if (value.indexing === true) return Object.freeze({ indexing: true })
    if (
        value.indexing !== undefined ||
        !Array.isArray(value.messages) ||
        !Array.isArray(value.channels) ||
        !integer(value.total, 0, 2_147_483_647) ||
        !integer(value.hits_per_page, 1, 25) ||
        !integer(value.page, 1, 2_147_483_647) ||
        (value.cursor !== undefined &&
            (!Array.isArray(value.cursor) || !value.cursor.every((item) => typeof item === "string"))) ||
        value.messages.length > value.hits_per_page
    )
        return undefined
    const messages = []
    for (const item of value.messages) {
        const message = decodeMessage(item)
        if (!message) return undefined
        messages.push(message)
    }
    const channels: MessageSearchChannel[] = []
    const ids = new Set<string>()
    for (const item of value.channels) {
        const decoded = channel(item)
        if (!decoded || ids.has(decoded.id)) return undefined
        ids.add(decoded.id)
        channels.push(decoded)
    }
    return Object.freeze({
        indexing: false,
        messages: Object.freeze(messages),
        channels: Object.freeze(channels),
        total: value.total,
        hitsPerPage: value.hits_per_page,
        page: value.page,
        ...(value.cursor === undefined ? {} : { cursor: Object.freeze([...value.cursor]) }),
    })
}
