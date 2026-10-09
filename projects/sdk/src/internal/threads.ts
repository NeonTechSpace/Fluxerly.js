/**
 * Thread operations: Request validation and encoding for client.threads, with thread data decoded by
 * [channel decoding](/projects/sdk/src/internal/channel-decode.ts).
 * Invariant: Only a request whose result is one thread or the active thread list carries a channel cache hint, so the
 * channel cache never stores a page or a forum post as a channel. A thread member's community membership is decoded
 * with the thread's own community, taken from the channel cache or from a thread read, never from caller input.
 * Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import * as Effect from "effect/Effect"
import {
    ChannelFlags,
    ChannelOperationError,
    ChannelType,
    type ChannelOperationFailure,
    type GuildThreadChannel,
    type ThreadMember,
} from "#sdk/channels"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"
import { MessageError } from "#sdk/message-errors"
import type { MessageCore, MessageReference } from "#sdk/messages"
import type {
    ArchivedThreadPage,
    ArchivedThreadQuery,
    ForumPost,
    ForumPostCreate,
    ThreadCreate,
    ThreadEdit,
    ThreadFromMessageCreate,
    ThreadSearchPage,
    ThreadSearchQuery,
} from "#sdk/threads"
import type { ClientOwner } from "./client.js"
import { channelFetch, type ChannelRequest } from "./channels.js"
import { decodeThread, decodeThreadList, decodeThreadMember } from "./channel-decode.js"
import { count, fieldsOnce, identifier, integerInRange, record, snapshotArray } from "./decode/primitives.js"
import { rejectCheck } from "./decode/trace.js"
import { timestamp } from "./decode/timestamp.js"
import { suspendInput } from "./defects.js"
import { normalizedText, rawText } from "./field-text.js"
import { encodeMessage, snapshotReference } from "./message.js"
import type { MessageDecoder } from "./message-fields.js"

type ThreadValidationResult<A> = ChannelRequest<A> | InputValidationFailure

/** Inactivity periods Fluxer accepts, in minutes */
const autoArchivePeriods: ReadonlySet<unknown> = new Set([60, 1440, 4320, 10_080])
const maxAppliedTags = 5
const maxSearchTags = 20

const channelIdFailure = () => inputValidationFailure("channelId", "format", "Channel IDs must be decimal strings")
const threadIdFailure = () => inputValidationFailure("threadId", "format", "Thread IDs must be decimal strings")

/** Validate the name, archive period and slowmode that thread creation and editing share, reading each field once */
function threadFields(
    field: (key: string) => unknown,
    nameRequired: boolean,
): Record<string, unknown> | InputValidationFailure {
    const name = field("name")
    if (nameRequired && name === undefined) return inputValidationFailure("name", "required", "Thread name is required")
    if (name !== undefined && !normalizedText(name, 1, 100))
        return inputValidationFailure(
            "name",
            "length",
            "Thread name must contain 1 through 100 UTF-16 code units after Fluxer's normalization",
        )
    const autoArchiveMinutes = field("autoArchiveMinutes")
    if (autoArchiveMinutes !== undefined && !autoArchivePeriods.has(autoArchiveMinutes))
        return inputValidationFailure(
            "autoArchiveMinutes",
            "allowedValue",
            "Thread autoArchiveMinutes must be 60, 1,440, 4,320 or 10,080, as in ThreadAutoArchiveMinutes",
        )
    const rateLimitPerUser = field("rateLimitPerUser")
    if (rateLimitPerUser !== undefined && !integerInRange(rateLimitPerUser, 0, 21_600))
        return inputValidationFailure(
            "rateLimitPerUser",
            "range",
            "Thread rateLimitPerUser must be an integer from 0 through 21,600 seconds",
        )
    return {
        ...(name === undefined ? {} : { name }),
        ...(autoArchiveMinutes === undefined ? {} : { auto_archive_duration: autoArchiveMinutes }),
        ...(rateLimitPerUser === undefined ? {} : { rate_limit_per_user: rateLimitPerUser }),
    }
}

/** Copy a list of decimal forum tag IDs once by index */
function tagIds(value: unknown, path: string, maximum: number): readonly string[] | InputValidationFailure {
    if (!Array.isArray(value)) return inputValidationFailure(path, "type", "Forum tag IDs must be an array")
    const items = snapshotArray(value, maximum)
    if (items === undefined)
        return inputValidationFailure(path, "length", `At most ${maximum} forum tag IDs are accepted`)
    if (!items.every(identifier))
        return inputValidationFailure(`${path}[]`, "format", "Forum tag IDs must be decimal strings")
    return items as readonly string[]
}

function booleanField(field: (key: string) => unknown, key: string): boolean | undefined | InputValidationFailure {
    const value = field(key)
    if (value !== undefined && typeof value !== "boolean")
        return inputValidationFailure(key, "type", `Thread ${key} must be a boolean`)
    return value
}

export function threadCreate(channelId: string, input: ThreadCreate): ThreadValidationResult<GuildThreadChannel> {
    if (!identifier(channelId)) return channelIdFailure()
    if (!record(input)) return inputValidationFailure("input", "type", "Thread input must be an object")
    const unsupported = unsupportedKeyFailure(
        input,
        ["name", "type", "autoArchiveMinutes", "rateLimitPerUser", "invitable"],
        "input",
        "the thread create input",
    )
    if (unsupported) return unsupported
    const field = fieldsOnce(input)
    const fields = threadFields(field, true)
    if (fields instanceof InputValidationFailure) return fields
    const type = field("type") ?? ChannelType.PublicThread
    if (
        type !== ChannelType.AnnouncementThread &&
        type !== ChannelType.PublicThread &&
        type !== ChannelType.PrivateThread
    )
        return inputValidationFailure(
            "type",
            "allowedValue",
            "Thread type must be 10 (AnnouncementThread), 11 (PublicThread) or 12 (PrivateThread)",
        )
    const invitable = booleanField(field, "invitable")
    if (invitable instanceof InputValidationFailure) return invitable
    if (invitable !== undefined && type !== ChannelType.PrivateThread)
        return inputValidationFailure(
            "invitable",
            "relationship",
            "Thread invitable is accepted only with type 12 (PrivateThread)",
        )
    return {
        majorId: channelId,
        bucket: "channel:thread:create",
        audited: true,
        path: `/channels/${channelId}/threads`,
        method: "POST",
        status: 201,
        json: JSON.stringify({ ...fields, type, ...(invitable === undefined ? {} : { invitable }) }),
        // The new thread's ID is unknown until Fluxer answers
        cache: { mutation: true, thread: true },
        decode: (value) => {
            const thread = decodeThread(value)
            return thread?.parentId === channelId ? thread : undefined
        },
    }
}

export function threadCreateFromMessage(
    target: MessageReference,
    input: ThreadFromMessageCreate,
): ThreadValidationResult<GuildThreadChannel> {
    const message = snapshotReference(target)
    if (message === undefined)
        return inputValidationFailure("target", "format", "Message target requires decimal id and channelId strings")
    if (!record(input)) return inputValidationFailure("input", "type", "Thread input must be an object")
    const unsupported = unsupportedKeyFailure(
        input,
        ["name", "autoArchiveMinutes", "rateLimitPerUser"],
        "input",
        "the thread create input",
    )
    if (unsupported) return unsupported
    const fields = threadFields(fieldsOnce(input), true)
    if (fields instanceof InputValidationFailure) return fields
    return {
        majorId: message.channelId,
        bucket: "channel:thread:create",
        audited: true,
        path: `/channels/${message.channelId}/messages/${message.id}/threads`,
        method: "POST",
        status: 201,
        json: JSON.stringify(fields),
        // A thread started from a message takes the message's ID
        cache: { channelId: message.id, mutation: true, thread: true },
        decode: (value) => {
            const thread = decodeThread(value)
            return thread?.id === message.id && thread.parentId === message.channelId ? thread : undefined
        },
    }
}

/** Message input keys a post's first message accepts. A post cannot reply, and Fluxer drops a nonce and tts */
const postMessageKeys = ["content", "embeds", "attachments", "stickerIds", "allowedMentions", "flags"]

export function threadPost<M extends MessageCore>(
    channelId: string,
    input: ForumPostCreate,
    decodeMessage: MessageDecoder<M>,
): ThreadValidationResult<ForumPost<M>> {
    if (!identifier(channelId)) return channelIdFailure()
    if (!record(input)) return inputValidationFailure("input", "type", "Forum post input must be an object")
    const unsupported = unsupportedKeyFailure(
        input,
        ["name", "message", "appliedTagIds", "autoArchiveMinutes", "rateLimitPerUser"],
        "input",
        "the forum post input",
    )
    if (unsupported) return unsupported
    const field = fieldsOnce(input)
    const fields = threadFields(field, true)
    if (fields instanceof InputValidationFailure) return fields
    const appliedTagsInput = field("appliedTagIds")
    const appliedTags =
        appliedTagsInput === undefined ? undefined : tagIds(appliedTagsInput, "appliedTagIds", maxAppliedTags)
    if (appliedTags instanceof InputValidationFailure) return appliedTags
    const message = field("message")
    if (message === undefined)
        return inputValidationFailure("message", "required", "A forum post needs its first message")
    if (!record(message)) return inputValidationFailure("message", "type", "Forum post message must be an object")
    const unsupportedMessage = unsupportedKeyFailure(message, postMessageKeys, "message", "the forum post message")
    if (unsupportedMessage) return unsupportedMessage
    // Reuse the message encoding, with its attachment files, then send the encoded message inside the post
    const encoded = encodeMessage(channelId, message, "")
    if (encoded instanceof MessageError) {
        const detail = encoded.inputValidation!
        return inputValidationFailure(
            detail.path === "input" ? "message" : `message.${detail.path}`,
            detail.constraint,
            detail.explanation,
        )
    }
    const { nonce: _nonce, ...payload } = JSON.parse(encoded.json) as Record<string, unknown>
    return {
        majorId: channelId,
        bucket: "channel:thread:create",
        audited: true,
        path: `/channels/${channelId}/threads`,
        method: "POST",
        status: 201,
        body: {
            json: JSON.stringify({
                ...fields,
                ...(appliedTags === undefined ? {} : { applied_tags: appliedTags }),
                message: payload,
            }),
            files: encoded.files,
        },
        // No channel cache hint, because the result is a thread with its message, which the cache would store as a channel
        decode: (value) => {
            if (!record(value)) return undefined
            const thread = decodeThread(value)
            if (thread?.type !== ChannelType.PublicThread || thread.parentId !== channelId) return undefined
            const first = decodeMessage(value.message)
            return first?.channelId === thread.id ? Object.freeze({ thread, message: first }) : undefined
        },
    }
}

export function threadEdit(threadId: string, input: ThreadEdit): ThreadValidationResult<GuildThreadChannel> {
    if (!identifier(threadId)) return threadIdFailure()
    if (!record(input)) return inputValidationFailure("input", "type", "Thread edit input must be an object")
    const unsupported = unsupportedKeyFailure(
        input,
        [
            "name",
            "archived",
            "locked",
            "autoArchiveMinutes",
            "rateLimitPerUser",
            "invitable",
            "pinned",
            "appliedTagIds",
        ],
        "input",
        "the thread edit input",
    )
    if (unsupported) return unsupported
    const field = fieldsOnce(input)
    const fields = threadFields(field, false)
    if (fields instanceof InputValidationFailure) return fields
    const flags: Record<string, boolean> = {}
    for (const key of ["archived", "locked", "invitable", "pinned"]) {
        const value = booleanField(field, key)
        if (value instanceof InputValidationFailure) return value
        if (value !== undefined) flags[key] = value
    }
    const appliedTagsInput = field("appliedTagIds")
    const appliedTags =
        appliedTagsInput === undefined ? undefined : tagIds(appliedTagsInput, "appliedTagIds", maxAppliedTags)
    if (appliedTags instanceof InputValidationFailure) return appliedTags
    const json = JSON.stringify({
        ...fields,
        ...(flags.archived === undefined ? {} : { archived: flags.archived }),
        ...(flags.locked === undefined ? {} : { locked: flags.locked }),
        ...(flags.invitable === undefined ? {} : { invitable: flags.invitable }),
        // Pinned is the only flag a thread can set, so the whole field follows it
        ...(flags.pinned === undefined ? {} : { flags: flags.pinned ? ChannelFlags.Pinned : 0 }),
        ...(appliedTags === undefined ? {} : { applied_tags: appliedTags }),
    })
    if (json === "{}") return inputValidationFailure("input", "required", "Thread edit must contain a change")
    return {
        majorId: threadId,
        bucket: "channel:update",
        audited: true,
        path: `/channels/${threadId}`,
        method: "PATCH",
        status: 200,
        json,
        cache: { channelId: threadId, mutation: true, thread: true },
        decode: (value) => {
            const thread = decodeThread(value)
            return thread?.id === threadId ? thread : undefined
        },
    }
}

export function threadActive(guildId: string): ThreadValidationResult<readonly GuildThreadChannel[]> {
    if (!identifier(guildId)) return inputValidationFailure("guildId", "format", "Guild IDs must be decimal strings")
    return {
        majorId: guildId,
        bucket: "guild:threads:active",
        path: `/guilds/${guildId}/threads/active`,
        method: "GET",
        status: 200,
        cache: { guildId, thread: true },
        decode: (value) => {
            if (!record(value)) return undefined
            const threads = decodeThreadList(value.threads, value.members)
            return threads?.every((thread) => thread.guildId === guildId) ? threads : undefined
        },
    }
}

const archivedPaths = {
    public: "threads/archived/public",
    private: "threads/archived/private",
    joinedPrivate: "users/@me/threads/archived/private",
} as const

export function threadArchived(
    channelId: string,
    query?: ArchivedThreadQuery,
): ThreadValidationResult<ArchivedThreadPage> {
    if (!identifier(channelId)) return channelIdFailure()
    const input = query === undefined ? {} : query
    if (!record(input)) return inputValidationFailure("query", "type", "Archived thread query must be an object")
    const unsupported = unsupportedKeyFailure(input, ["scope", "before", "limit"], "query", "the archived thread query")
    if (unsupported) return unsupported
    const field = fieldsOnce(input)
    const scope = field("scope") ?? "public"
    if (scope !== "public" && scope !== "private" && scope !== "joinedPrivate")
        return inputValidationFailure(
            "query.scope",
            "allowedValue",
            'Archived thread scope must be "public", "private" or "joinedPrivate"',
        )
    const limit = field("limit") ?? 50
    if (!integerInRange(limit, 2, 100))
        return inputValidationFailure(
            "query.limit",
            "range",
            "Archived thread limit must be an integer from 2 through 100",
        )
    const before = field("before")
    if (before !== undefined && (scope === "joinedPrivate" ? !identifier(before) : !timestamp(before)))
        return inputValidationFailure(
            "query.before",
            "format",
            scope === "joinedPrivate"
                ? 'Archived thread cursor must be a decimal thread ID for scope "joinedPrivate"'
                : "Archived thread cursor must be an ISO 8601 timestamp with a timezone",
        )
    const params = new URLSearchParams({ limit: String(limit) })
    if (before !== undefined) params.set("before", before as string)
    return {
        majorId: channelId,
        bucket: "channel:threads:archived:list",
        path: `/channels/${channelId}/${archivedPaths[scope]}?${params}`,
        method: "GET",
        status: 200,
        // A page is not a channel, so it carries no channel cache hint
        decode: (value) => {
            if (!record(value) || typeof value.has_more !== "boolean") return undefined
            const threads = decodeThreadList(value.threads, value.members)
            if (!threads || threads.length > limit || threads.some((thread) => thread.parentId !== channelId))
                return undefined
            return Object.freeze({ threads, hasMore: value.has_more })
        },
    }
}

const searchSortBy: ReadonlySet<unknown> = new Set(["last_message_time", "archive_time", "relevance", "creation_time"])

export function threadSearch<M extends MessageCore>(
    channelId: string,
    query: ThreadSearchQuery | undefined,
    decodeMessage: MessageDecoder<M>,
): ThreadValidationResult<ThreadSearchPage<M>> {
    if (!identifier(channelId)) return channelIdFailure()
    const input = query === undefined ? {} : query
    if (!record(input)) return inputValidationFailure("query", "type", "Thread search query must be an object")
    const unsupported = unsupportedKeyFailure(
        input,
        ["name", "tagIds", "tagSetting", "archived", "sortBy", "sortOrder", "limit", "offset", "maxId", "minId"],
        "query",
        "the thread search query",
    )
    if (unsupported) return unsupported
    const field = fieldsOnce(input)
    const params = new URLSearchParams()
    const name = field("name")
    if (name !== undefined && !rawText(name, 0, 100))
        return inputValidationFailure(
            "query.name",
            "length",
            "Thread search name must contain at most 100 UTF-16 code units",
        )
    if (name !== undefined) params.set("name", name)
    const tagsInput = field("tagIds")
    const tags = tagsInput === undefined ? undefined : tagIds(tagsInput, "query.tagIds", maxSearchTags)
    if (tags instanceof InputValidationFailure) return tags
    for (const tag of tags ?? []) params.append("tag", tag)
    const tagSetting = field("tagSetting")
    if (tagSetting !== undefined && tagSetting !== "match_some" && tagSetting !== "match_all")
        return inputValidationFailure(
            "query.tagSetting",
            "allowedValue",
            'Thread search tagSetting must be "match_some" or "match_all"',
        )
    if (tagSetting !== undefined) params.set("tag_setting", tagSetting)
    const archived = field("archived")
    if (archived !== undefined && typeof archived !== "boolean")
        return inputValidationFailure("query.archived", "type", "Thread search archived must be a boolean")
    if (archived !== undefined) params.set("archived", String(archived))
    const sortBy = field("sortBy")
    if (sortBy !== undefined && !searchSortBy.has(sortBy))
        return inputValidationFailure(
            "query.sortBy",
            "allowedValue",
            'Thread search sortBy must be "last_message_time", "archive_time", "relevance" or "creation_time"',
        )
    if (sortBy !== undefined) params.set("sort_by", sortBy as string)
    const sortOrder = field("sortOrder")
    if (sortOrder !== undefined && sortOrder !== "asc" && sortOrder !== "desc")
        return inputValidationFailure(
            "query.sortOrder",
            "allowedValue",
            'Thread search sortOrder must be "asc" or "desc"',
        )
    if (sortOrder !== undefined) params.set("sort_order", sortOrder)
    const limit = field("limit") ?? 25
    if (!integerInRange(limit, 1, 25))
        return inputValidationFailure(
            "query.limit",
            "range",
            "Thread search limit must be an integer from 1 through 25",
        )
    if (field("limit") !== undefined) params.set("limit", String(limit))
    const offset = field("offset")
    if (offset !== undefined && !integerInRange(offset, 0, 9975))
        return inputValidationFailure(
            "query.offset",
            "range",
            "Thread search offset must be an integer from 0 through 9,975",
        )
    if (offset !== undefined) params.set("offset", String(offset))
    for (const [key, wire] of [
        ["maxId", "max_id"],
        ["minId", "min_id"],
    ] as const) {
        const id = field(key)
        if (id !== undefined && !identifier(id))
            return inputValidationFailure(`query.${key}`, "format", "Thread search cursor IDs must be decimal strings")
        if (id !== undefined) params.set(wire, id)
    }
    const search = params.toString()
    return {
        majorId: channelId,
        bucket: "channel:threads:search",
        path: `/channels/${channelId}/threads/search${search === "" ? "" : `?${search}`}`,
        method: "GET",
        status: 200,
        // Fluxer answers 202 with SEARCH_INDEX_NOT_READY while it builds the community's search index, and the SDK does
        // not retry it. Any other 202 answer is malformed
        accepted: (value) =>
            record(value) && value.code === "SEARCH_INDEX_NOT_READY"
                ? Object.freeze({ indexing: true as const })
                : undefined,
        decode: (value) => {
            if (!record(value) || typeof value.has_more !== "boolean" || !count(value.total_results)) return undefined
            const threads = decodeThreadList(value.threads, value.members)
            if (!threads || threads.length > limit || threads.some((thread) => thread.parentId !== channelId))
                return undefined
            // Fluxer sends first messages only in forum and media channels, one per post whose message still exists
            const listed = value.first_messages === undefined ? [] : value.first_messages
            if (!Array.isArray(listed) || listed.length > threads.length) return undefined
            const threadIds = new Set(threads.map((thread) => thread.id))
            const firstMessages: M[] = []
            for (const item of listed) {
                const message = decodeMessage(item)
                if (!message || !threadIds.has(message.channelId)) return undefined
                firstMessages.push(message)
            }
            return Object.freeze({
                indexing: false as const,
                threads,
                firstMessages: Object.freeze(firstMessages),
                total: value.total_results,
                hasMore: value.has_more,
            })
        },
    }
}

/** Join or leave a thread as the bot, or add or remove another member */
export function threadMembership(
    threadId: string,
    userId: string | undefined,
    method: "PUT" | "DELETE",
): ThreadValidationResult<void> {
    if (!identifier(threadId)) return threadIdFailure()
    if (userId !== undefined && !identifier(userId))
        return inputValidationFailure("userId", "format", "User IDs must be decimal strings")
    return {
        majorId: threadId,
        bucket: method === "PUT" ? "channel:thread:member:put" : "channel:thread:member:delete",
        path: `/channels/${threadId}/thread-members/${userId ?? "@me"}`,
        method,
        status: 204,
        // The cached thread's membership and memberCount change, and without a gateway no event replaces them
        cache: { channelId: threadId, mutation: true, thread: true },
        decode: () => undefined,
    }
}

/**
 * Decode one thread member. With guildId the community membership is decoded with that community. Without it, a
 * membership that was not requested is left out, and the guild ID is never read
 */
function threadMember(value: unknown, threadId: string, guildId: string | undefined): ThreadMember | undefined {
    if (guildId !== undefined) return decodeThreadMember(value, guildId, threadId)
    if (!record(value)) return undefined
    const { member: _member, ...rest } = value
    return decodeThreadMember(rest, "", threadId)
}

function memberQuery(query: unknown, keys: readonly string[]) {
    const input = query === undefined ? {} : query
    if (!record(input)) return inputValidationFailure("query", "type", "Thread member query must be an object")
    const unsupported = unsupportedKeyFailure(input, keys, "query", "the thread member query")
    if (unsupported) return unsupported
    const field = fieldsOnce(input)
    const withMember = field("withMember") ?? false
    if (typeof withMember !== "boolean")
        return inputValidationFailure("query.withMember", "type", "Thread member query withMember must be a boolean")
    return { field, withMember }
}

/** A validated thread member read. Its request needs the thread's community only when withMember is set */
interface MemberRead<A> {
    readonly withMember: boolean
    readonly request: (guildId: string | undefined) => ChannelRequest<A>
}

function threadMemberFetch(
    threadId: string,
    userId: string,
    query: unknown,
): MemberRead<ThreadMember> | InputValidationFailure {
    if (!identifier(threadId)) return threadIdFailure()
    if (!identifier(userId)) return inputValidationFailure("userId", "format", "User IDs must be decimal strings")
    const validated = memberQuery(query, ["withMember"])
    if (validated instanceof InputValidationFailure) return validated
    const { withMember } = validated
    return {
        withMember,
        request: (guildId) => ({
            majorId: threadId,
            bucket: "channel:thread:member:get",
            path: `/channels/${threadId}/thread-members/${userId}${withMember ? "?with_member=true" : ""}`,
            method: "GET",
            status: 200,
            decode: (value) => {
                const member = threadMember(value, threadId, guildId)
                return member?.userId === userId ? member : undefined
            },
        }),
    }
}

export function threadMemberPage(
    threadId: string,
    query: unknown,
): MemberRead<readonly ThreadMember[]> | InputValidationFailure {
    if (!identifier(threadId)) return threadIdFailure()
    const validated = memberQuery(query, ["after", "limit", "withMember"])
    if (validated instanceof InputValidationFailure) return validated
    const { field, withMember } = validated
    const limit = field("limit") ?? 100
    if (!integerInRange(limit, 1, 100))
        return inputValidationFailure(
            "query.limit",
            "range",
            "Thread member limit must be an integer from 1 through 100",
        )
    const after = field("after")
    if (after !== undefined && !identifier(after))
        return inputValidationFailure("query.after", "format", "Thread member cursor must be a decimal user ID string")
    const params = new URLSearchParams({ limit: String(limit) })
    if (after !== undefined) params.set("after", after)
    if (withMember) params.set("with_member", "true")
    return {
        withMember,
        request: (guildId) => ({
            majorId: threadId,
            bucket: "channel:thread:members:list",
            path: `/channels/${threadId}/thread-members?${params}`,
            method: "GET",
            status: 200,
            decode: (value) => {
                if (!Array.isArray(value) || value.length > limit) return undefined
                const members: ThreadMember[] = []
                let previous = after === undefined ? undefined : BigInt(after)
                for (const item of value) {
                    const member = threadMember(item, threadId, guildId)
                    if (!member) return undefined
                    if (previous !== undefined && BigInt(member.userId) <= previous) return rejectCheck("order")
                    previous = BigInt(member.userId)
                    members.push(member)
                }
                return Object.freeze(members)
            },
        }),
    }
}

type ThreadOwner = Pick<ClientOwner<MessageCore>, "channel" | "channelCache" | "logical"> & {
    readonly defaultTimeoutMs?: number
}

/** The timeout of operation options, which may also hold the default API's signal */
function operationTimeout(value: unknown): { readonly timeoutMs?: number } | InputValidationFailure {
    if (value === undefined) return {}
    if (!record(value)) return inputValidationFailure("options", "type", "Operation options must be an object")
    const unsupported = unsupportedKeyFailure(value, ["timeoutMs", "signal"], "options", "the operation options")
    if (unsupported) return unsupported
    const timeoutMs = value.timeoutMs
    if (timeoutMs === undefined) return {}
    return integerInRange(timeoutMs, 1, 2_147_483_647)
        ? { timeoutMs }
        : inputValidationFailure(
              "options.timeoutMs",
              "range",
              "Operation timeoutMs must be an integer from 1 through 2,147,483,647 ms",
          )
}

/**
 * Run a thread member read. With withMember, the thread's community comes from the channel cache when the thread is
 * cached there, otherwise from one thread read, and both requests share the caller's deadline. A pagination
 * consumption passes resolved to read the community at most once
 */
export function readThreadMembers<A>(
    owner: ThreadOwner,
    operation: "threads.fetchMember" | "threads.fetchMembers",
    threadId: string,
    validate: () => MemberRead<A> | InputValidationFailure,
    options: unknown,
    resolved: { guildId?: string } = {},
): Effect.Effect<A, ChannelOperationFailure> {
    // Reading and validating the caller query and options is marked as application input
    return suspendInput(() => {
        const invalid = (failure: InputValidationFailure) =>
            Effect.fail(
                new ChannelOperationError({
                    operation,
                    reason: "input",
                    outcome: "notDispatched",
                    inputValidation: failure.detail,
                }),
            )
        const read = validate()
        if (read instanceof InputValidationFailure) return invalid(read)
        const timeout = operationTimeout(options)
        if (timeout instanceof InputValidationFailure) return invalid(timeout)
        if (!read.withMember) return owner.channel(operation, () => read.request(undefined), timeout)
        return Effect.gen(function* () {
            const now = () => owner.logical.now()
            const deadline = now() + (timeout.timeoutMs ?? owner.defaultTimeoutMs ?? 30_000)
            const remaining = () =>
                Effect.suspend(() => {
                    const left = Math.floor(deadline - now())
                    return left > 0
                        ? Effect.succeed({ timeoutMs: left })
                        : Effect.fail(
                              new ChannelOperationError({ operation, reason: "timeout", outcome: "notDispatched" }),
                          )
                })
            // Thread member payloads carry no community ID, and a thread never moves to another community
            let guildId = resolved.guildId ?? owner.channelCache?.get(threadId)?.guildId
            if (guildId === undefined) {
                const thread = yield* owner.channel(operation, () => channelFetch(threadId), yield* remaining())
                guildId = thread.guildId
            }
            resolved.guildId = guildId
            const community = guildId
            return yield* owner.channel(operation, () => read.request(community), yield* remaining())
        })
    })
}

export const fetchThreadMember = (
    owner: ThreadOwner,
    threadId: string,
    userId: string,
    query: unknown,
    options: unknown,
) =>
    readThreadMembers(owner, "threads.fetchMember", threadId, () => threadMemberFetch(threadId, userId, query), options)

export const fetchThreadMembers = (owner: ThreadOwner, threadId: string, query: unknown, options: unknown) =>
    readThreadMembers(owner, "threads.fetchMembers", threadId, () => threadMemberPage(threadId, query), options)
