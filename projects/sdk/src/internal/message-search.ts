/**
 * Message search requests and page projection.
 * Invariant: Queries are validated locally, and every hit is decoded with the client's message selection.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import type { MessageCore } from "#sdk/messages"
import type { MessageDecoder } from "./message-fields.js"
import type {
    MessageSearchChannel,
    MessageSearchContentType,
    MessageSearchContext,
    MessageSearchEmbedType,
    MessageSearchPage,
    MessageSearchQuery,
} from "#sdk/message-search"
import { decodeThreadList } from "./channel-decode.js"
import { decodeMessage } from "./message.js"
import { identifier, integerInRange as integer, record } from "./decode/primitives.js"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"
import {
    booleanField,
    checkFields,
    choiceField,
    type FieldRules,
    idField,
    listField,
    oneOf,
    textField,
    textOf,
    wireFields,
} from "./field-rules.js"

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

const ids = (name: string, maximum: number) =>
    listField(
        maximum,
        identifier,
        "format",
        `Message search ${name} must be an array of at most ${maximum} decimal ID strings`,
    )
const texts = (name: string, maximum: number, length: number) =>
    listField(
        maximum,
        textOf(length),
        "format",
        `Message search ${name} must be an array of at most ${maximum} strings containing 1 through ${length.toLocaleString("en-US")} UTF-16 code units`,
    )
const kinds = (name: string, allowed: ReadonlySet<string>) =>
    listField(
        20,
        oneOf(allowed),
        "allowedValue",
        `Message search ${name} must be an array of at most 20 supported values`,
    )
const flag = (name: string) => booleanField(`Message search ${name} must be a boolean`)

/** Filter rules after limit and page, in the order Fluxerly checks them and sends them */
const filterRules: FieldRules = {
    maxId: idField("Maximum message ID must be a decimal string"),
    minId: idField("Minimum message ID must be a decimal string"),
    content: textField(1, 1024, "Message search content must contain 1 through 1,024 UTF-16 code units"),
    contents: texts("contents", 100, 1024),
    exactPhrases: texts("exactPhrases", 10, 1024),
    channelIds: ids("channelIds", 500),
    excludeChannelIds: ids("excludeChannelIds", 500),
    authorTypes: kinds("authorTypes", authorTypes),
    excludeAuthorTypes: kinds("excludeAuthorTypes", authorTypes),
    authorIds: ids("authorIds", 100),
    excludeAuthorIds: ids("excludeAuthorIds", 100),
    mentions: ids("mentions", 100),
    excludeMentions: ids("excludeMentions", 100),
    mentionedEveryone: flag("mentionedEveryone"),
    pinned: flag("pinned"),
    has: kinds("has", contentTypes),
    excludeHas: kinds("excludeHas", contentTypes),
    embedTypes: kinds("embedTypes", embedTypes),
    excludeEmbedTypes: kinds("excludeEmbedTypes", embedTypes),
    embedProviders: texts("embedProviders", 50, 256),
    excludeEmbedProviders: texts("excludeEmbedProviders", 50, 256),
    linkHostnames: texts("linkHostnames", 100, 255),
    excludeLinkHostnames: texts("excludeLinkHostnames", 100, 255),
    attachmentFilenames: texts("attachmentFilenames", 100, 1024),
    excludeAttachmentFilenames: texts("excludeAttachmentFilenames", 100, 1024),
    attachmentExtensions: texts("attachmentExtensions", 50, 32),
    excludeAttachmentExtensions: texts("excludeAttachmentExtensions", 50, 32),
    sortBy: choiceField(["timestamp", "relevance"], "Message search sortBy must be timestamp or relevance"),
    sortOrder: choiceField(["asc", "desc"], "Message search sortOrder must be asc or desc"),
    includeNsfw: flag("includeNsfw"),
}
const wireNames: Readonly<Record<string, string>> = {
    maxId: "max_id",
    minId: "min_id",
    content: "content",
    contents: "contents",
    exactPhrases: "exact_phrases",
    channelIds: "channel_id",
    excludeChannelIds: "exclude_channel_id",
    authorTypes: "author_type",
    excludeAuthorTypes: "exclude_author_type",
    authorIds: "author_id",
    excludeAuthorIds: "exclude_author_id",
    mentions: "mentions",
    excludeMentions: "exclude_mentions",
    mentionedEveryone: "mention_everyone",
    pinned: "pinned",
    has: "has",
    excludeHas: "exclude_has",
    embedTypes: "embed_type",
    excludeEmbedTypes: "exclude_embed_type",
    embedProviders: "embed_provider",
    excludeEmbedProviders: "exclude_embed_provider",
    linkHostnames: "link_hostname",
    excludeLinkHostnames: "exclude_link_hostname",
    attachmentFilenames: "attachment_filename",
    excludeAttachmentFilenames: "exclude_attachment_filename",
    attachmentExtensions: "attachment_extension",
    excludeAttachmentExtensions: "exclude_attachment_extension",
    sortBy: "sort_by",
    sortOrder: "sort_order",
    includeNsfw: "include_nsfw",
}
const queryKeys = ["limit", "page", ...Object.keys(filterRules)]

/** Copy one strict contextual request into Fluxer's bot-permitted current scope */
export function encodeMessageSearch(contextInput: unknown, query?: unknown) {
    const supplied = query === undefined ? {} : query
    if (!record(contextInput))
        return inputValidationFailure("context", "type", "Message search context must be an object")
    const unsupported = unsupportedKeyFailure(
        contextInput,
        ["guildId", "channelId"],
        "context",
        "the message search context",
    )
    if (unsupported) return unsupported
    const guildId = contextInput.guildId
    const channelId = contextInput.channelId
    if (guildId === undefined && channelId === undefined)
        return inputValidationFailure("context", "required", "Message search context requires guildId or channelId")
    if (guildId !== undefined && !identifier(guildId))
        return inputValidationFailure("context.guildId", "format", "Guild IDs must be decimal strings")
    if (channelId !== undefined && !identifier(channelId))
        return inputValidationFailure("context.channelId", "format", "Channel IDs must be decimal strings")
    const context: MessageSearchContext =
        guildId === undefined
            ? Object.freeze({ channelId: channelId! })
            : channelId === undefined
              ? Object.freeze({ guildId })
              : Object.freeze({ guildId, channelId })
    if (!record(supplied)) return inputValidationFailure("query", "type", "Message search query must be an object")
    const unsupportedQuery = unsupportedKeyFailure(supplied, queryKeys, "query", "the message search query")
    if (unsupportedQuery) return unsupportedQuery
    // Read recognized properties once, regardless of ownership or enumerability
    const input = Object.fromEntries(queryKeys.map((key) => [key, supplied[key]]))
    const limit = input.limit === undefined ? 25 : input.limit
    const page = input.page === undefined ? 1 : input.page
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
    const filters = checkFields(input, filterRules, "query.")
    if (filters instanceof InputValidationFailure) return filters
    Object.assign(input, filters)
    return Object.freeze({
        context,
        limit,
        query: Object.freeze(input) as MessageSearchQuery,
        json: JSON.stringify({
            scope: "current",
            ...(context.guildId === undefined ? {} : { context_guild_id: context.guildId }),
            ...(context.channelId === undefined ? {} : { context_channel_id: context.channelId }),
            hits_per_page: limit,
            page,
            ...wireFields(filters, wireNames),
        }),
    })
}

function channel(value: unknown): MessageSearchChannel | undefined {
    if (
        !record(value) ||
        !identifier(value.id) ||
        (value.guild_id !== undefined && !identifier(value.guild_id)) ||
        (value.name !== undefined && value.name !== null && typeof value.name !== "string") ||
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
export function decodeMessageSearchPage(value: unknown): MessageSearchPage | undefined
export function decodeMessageSearchPage<M extends MessageCore>(
    value: unknown,
    decode: MessageDecoder<M>,
): MessageSearchPage<M> | undefined
export function decodeMessageSearchPage(
    value: unknown,
    decode: MessageDecoder<MessageCore> = decodeMessage,
): MessageSearchPage<MessageCore> | undefined {
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
        const message = decode(item)
        if (!message) return undefined
        messages.push(message)
    }
    const channels: MessageSearchChannel[] = []
    const channelIds = new Set<string>()
    for (const item of value.channels) {
        const decoded = channel(item)
        if (!decoded || channelIds.has(decoded.id)) return undefined
        channelIds.add(decoded.id)
        channels.push(decoded)
    }
    // Fluxer lists the channel of a hit inside a thread in threads, with the bot's memberships of those threads beside it
    const threads = decodeThreadList(
        value.threads === undefined ? [] : value.threads,
        value.members === undefined ? [] : value.members,
    )
    if (!threads) return undefined
    for (const thread of threads) {
        if (channelIds.has(thread.id)) return undefined
        channelIds.add(thread.id)
    }
    const messageChannelIds = new Set(messages.map((message) => message.channelId))
    if (
        messageChannelIds.size !== channelIds.size ||
        Array.from(messageChannelIds).some((channelId) => !channelIds.has(channelId))
    )
        return undefined
    return Object.freeze({
        indexing: false,
        messages: Object.freeze(messages),
        channels: Object.freeze(channels),
        threads,
        total: value.total,
        hitsPerPage: value.hits_per_page,
        page: value.page,
    })
}
