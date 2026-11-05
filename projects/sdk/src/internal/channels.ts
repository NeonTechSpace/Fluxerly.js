/**
 * Guild channel operations: Request validation and encoding, with REST and gateway channel data projected by
 * [channel decoding](/projects/sdk/src/internal/channel-decode.ts).
 * Invariant: Guild and channel routes use separate rate-limit groups while sharing global limits and cleanup, omitted permission
 * overwrites stay distinct from an explicit empty list through input encoding, and channel deletion or visibility loss evicts
 * related cached messages without synthesizing message events or changing collector completion. Implements [SDK contracts: Delivery, requests and caches](/docs/SDK-CONTRACTS.md#delivery-requests-and-caches)
 */
import {
    ChannelFlags,
    ChannelType,
    ForumLayout,
    ForumSortOrder,
    ThreadAutoArchiveMinutes,
    type ChannelCreate,
    type ChannelEdit,
    type ChannelFollowInput,
    type ChannelFollowerStats,
    type FollowedChannel,
    type ForumTagInput,
    type ChannelPosition,
    type GuildChannel,
    type GuildForumChannel,
    type GuildMediaChannel,
    type PermissionOverwrite,
} from "#sdk/channels"
import { InputValidationFailure, inputValidationFailure, unsupportedKeyFailure } from "#sdk/input-validation"
import type { EncodedBody } from "./attachments.js"
import { decodeGuildChannel, decodeGuildChannels } from "./channel-decode.js"
import { count as nonNegativeInt32, fieldsOnce, identifier, inputId, record } from "./decode/primitives.js"
import { defaultBodyLimit } from "./request-body-limits.js"
import { rejectCheck } from "./decode/trace.js"
import { channelName, fluxerHttpUrl, normalizedText } from "./field-text.js"
import {
    booleanField,
    checkFields,
    choiceField,
    field,
    type FieldRules,
    idField,
    integerField,
    nullable,
    nullOrEmpty,
    textField,
} from "./field-rules.js"

/** Validated request description, with the shared REST owner retaining admission, cleanup and rate state */
export interface ChannelRequest<A> {
    /** Scheduler major resource, the guild for guild routes and otherwise the channel */
    readonly majorId: string
    readonly bucket: string
    readonly path: string
    readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
    readonly status: 200 | 201 | 204
    readonly json?: string
    /** A JSON body with attachment files, sent inline as multipart form data instead of json */
    readonly body?: EncodedBody
    /** Allows the shared REST owner to validate and send an operation audit reason */
    readonly audited?: true
    /** Private client capabilities required for one explicit provider-gated replacement */
    readonly features?: readonly string[]
    /** A POST that only reads, so its failures count as reads like those of a GET */
    readonly read?: true
    /** A read POST that is safe to send again, so its transient failures retry as a GET's do */
    readonly retryRead?: true
    readonly decode: (value: unknown) => A | undefined
    /** Decodes an HTTP 202 response, for a route that answers 202 instead of status while its result is not ready */
    readonly accepted?: (value: unknown) => A | undefined
    /**
     * Cache ownership hints consumed by the channel cache owner. Only a mutation, whose result the cache never stores, or
     * a request whose result is one channel or a list of channels may carry them
     */
    readonly cache?: {
        readonly channelId?: string
        readonly guildId?: string
        readonly mutation?: boolean
        readonly replace?: boolean
        /**
         * The result is one thread or a list of threads. A mutation changes only the thread named by channelId, or
         * creates a thread when channelId is absent
         */
        readonly thread?: boolean
        /**
         * The mutation can change the threads of the channel named by channelId without thread events, by deleting or
         * retyping them
         */
        readonly changesThreads?: boolean
        /** Which forum tags the mutation can remove from the channel named by channelId, and so from its posts */
        readonly removesTag?: (tagId: string) => boolean
    }
}

type ChannelValidationResult<A> = ChannelRequest<A> | InputValidationFailure

const maxWritablePermission = 9_223_372_036_854_775_807n
// Channel create and edit routes have no limit of their own, so Fluxer applies its default body limit
const maxRequestBytes = defaultBodyLimit
/** Fluxer refuses more than 10,000 permission overwrites on channel create and edit, and more than 10,000 entries in a
 * channel position update (packages/schema/src/domains/channel/ChannelRequestSchemas.ts:96-99, 464-476 at 0098958f).
 * 10,000 position entries stay far below the default body limit, so positions need no byte check of their own
 */
const maxListEntries = 10_000

/** Channel, position and forum routes read their body through Fluxer's Validator, which turns an empty string into null
 * (fluxer_api/src/api/Validator.ts:59-63 and fluxer_api/src/api/channel/threads/GatedJsonValidator.ts:21-22 at
 * 0098958f), so an empty ID is sent as given where null is accepted. Returns the value to send, which is null, the
 * empty string or the trimmed ID, or undefined when the value is none of them
 */
const absentOrInputId = (value: unknown): string | null | undefined =>
    value === null || value === "" ? value : inputId(value)
const writablePermission = (value: unknown): value is bigint =>
    typeof value === "bigint" && value >= 0n && value <= maxWritablePermission

const threadDefaultKeys = ["defaultAutoArchiveMinutes", "defaultThreadRateLimitPerUser"]
const forumSettingKeys = ["availableTags", "defaultReactionEmoji", "defaultSortOrder", "defaultTagSetting", "flags"]
/** Fluxer's limit on the tags of one forum or media channel */
const maxForumTags = 20
const forumTopicMaxLength = 4096
const textTopicMaxLength = 1024
const threadAutoArchiveValues: readonly unknown[] = Object.values(ThreadAutoArchiveMinutes)
const forumSortOrderValues: readonly unknown[] = Object.values(ForumSortOrder)
const forumLayoutValues: readonly unknown[] = Object.values(ForumLayout)
const forumFlagBits = ChannelFlags.RequireTag
const mediaFlagBits = ChannelFlags.RequireTag | ChannelFlags.HideMediaDownloadOptions

/**
 * The link channel URL to send. Fluxer reads it as URLType and checks its normalized value: 1 through 2,048 UTF-16 code
 * units, a start of http:// or https:// that parses as a URL with that protocol, then validator.isURL with a required
 * TLD outside development mode, no credentials and no protocol-relative form
 * (packages/schema/src/domains/channel/ChannelRequestSchemas.ts:66 with packages/schema/src/primitives/UrlValidators.ts:28-31,
 * 44-49 and 77-80 at 0098958f). fluxerHttpUrl applies all of these rules, the TLD rule only for hosted Fluxer. Received
 * channel URLs keep the looser decoding rule
 */
const linkUrl = fluxerHttpUrl

const topic = (maximum: number) =>
    nullOrEmpty(
        field(
            (value) => normalizedText(value, 1, maximum),
            "length",
            `Channel topic must be null, empty or contain 1 through ${maximum.toLocaleString("en-US")} UTF-16 code units after Fluxer's normalization`,
        ),
    )
const createName = field(
    channelName,
    "length",
    "Channel name must contain 1 through 100 UTF-16 code units after Fluxer's normalization, and at most 10,000 before it",
)
const flags = (settable: number, explanation: string) =>
    field((value) => nonNegativeInt32(value) && (value & ~settable) === 0, "allowedValue", explanation)
const nsfwExplanation = "Channel nsfw must be boolean, or null when editing"

/**
 * Rules for the optional fields of a channel edit, in the order Fluxerly checks them. An edit cannot tell the type of
 * the channel, so it accepts the longer forum topic and the flags of either forum type, and Fluxer checks them
 */
const editRules: FieldRules = {
    // Fluxer reads an empty name in an edit as null and then leaves the name unchanged
    // (fluxer_api/src/api/channel/services/ChannelDataService.ts:191 at 0098958f)
    name: {
        ...createName,
        accept: (value) => (value === "" ? value : createName.accept(value)),
        explanation:
            "Channel name must be empty, which Fluxer ignores, or contain 1 through 100 UTF-16 code units after Fluxer's normalization, and at most 10,000 before it",
    },
    topic: topic(forumTopicMaxLength),
    url: nullOrEmpty(
        field(
            linkUrl,
            "format",
            "Channel URL must be null, empty or an http or https URL of 1 through 2,048 UTF-16 code units after Fluxer's normalization, without credentials, whose host is an IP address or a domain name, with a top-level domain on hosted Fluxer",
        ),
    ),
    parentId: nullOrEmpty(
        idField(
            "Channel parentId must be null, empty or a decimal string, because JavaScript numbers cannot hold Fluxer IDs exactly",
        ),
    ),
    bitrate: nullable(
        integerField(
            8_000,
            384_000,
            "Channel bitrate must be null or an integer from 8,000 through 384,000 bits per second",
        ),
    ),
    userLimit: nullable(integerField(0, 99, "Channel userLimit must be null or an integer from 0 through 99")),
    voiceConnectionLimit: nullable(
        integerField(1, 100, "Channel voiceConnectionLimit must be null or an integer from 1 through 100"),
    ),
    nsfw: nullable(booleanField(nsfwExplanation)),
    nsfwOverride: nullable(booleanField("Channel nsfwOverride must be boolean or null")),
    contentWarningLevel: choiceField([0, 1], "Channel contentWarningLevel must be 0 or 1"),
    contentWarningText: nullable(
        textField(0, 200, "Channel contentWarningText must be null or contain at most 200 raw UTF-16 code units"),
    ),
    rateLimitPerUser: nullable(
        integerField(0, 21_600, "Channel rateLimitPerUser must be null or an integer from 0 through 21,600 seconds"),
    ),
    rtcRegion: nullOrEmpty(
        field(
            (value) => normalizedText(value, 1, 64),
            "length",
            "Channel rtcRegion must be null, empty or contain 1 through 64 UTF-16 code units after Fluxer's normalization",
        ),
    ),
    defaultAutoArchiveMinutes: nullable(
        choiceField(
            threadAutoArchiveValues,
            "Channel defaultAutoArchiveMinutes must be null, or 60, 1440, 4320 or 10080 minutes",
        ),
    ),
    defaultThreadRateLimitPerUser: nullable(
        integerField(
            0,
            21_600,
            "Channel defaultThreadRateLimitPerUser must be null or an integer from 0 through 21,600 seconds",
        ),
    ),
    defaultSortOrder: nullable(
        choiceField(
            forumSortOrderValues,
            "Channel defaultSortOrder must be null, 0 (latest activity) or 1 (creation time)",
        ),
    ),
    defaultForumLayout: nullable(
        choiceField(forumLayoutValues, "Channel defaultForumLayout must be null, 0 (default), 1 (list) or 2 (grid)"),
    ),
    defaultTagSetting: nullable(
        choiceField(["match_some", "match_all"], 'Channel defaultTagSetting must be null, "match_some" or "match_all"'),
    ),
    flags: flags(
        mediaFlagBits,
        "Channel flags must be a nonnegative integer that sets only ChannelFlags.RequireTag or ChannelFlags.HideMediaDownloadOptions",
    ),
}
/** A created channel cannot set nsfw to null and needs a name. A created media channel keeps the longer topic and both
 * flag bits
 */
const mediaCreateRules: FieldRules = { ...editRules, name: createName, nsfw: booleanField(nsfwExplanation) }
/** Other created channels have the shorter text topic */
const createRules: FieldRules = { ...mediaCreateRules, topic: topic(textTopicMaxLength) }
/** A created forum channel can set only the flag bits of its own type */
const forumCreateRules: FieldRules = {
    ...mediaCreateRules,
    flags: flags(
        forumFlagBits,
        "Channel flags must be a nonnegative integer that sets only ChannelFlags.RequireTag on a forum channel",
    ),
}

/** The kept values of the optional fields that have rules, such as the trimmed parentId, or the first failure */
function validateOptionalFields(
    input: Record<string, unknown>,
    create: boolean,
): Record<string, unknown> | InputValidationFailure {
    // A created channel's type selects which thread and forum settings it can have. An edit cannot tell the type of
    // the channel, so it accepts every setting and leaves the type check to Fluxer
    const type = input.type
    const threadParent =
        type === ChannelType.Text ||
        type === ChannelType.Announcement ||
        type === ChannelType.Forum ||
        type === ChannelType.Media
    const forumParent = type === ChannelType.Forum || type === ChannelType.Media
    const allowed = create
        ? [
              "type",
              "name",
              "topic",
              "url",
              "parentId",
              "bitrate",
              "userLimit",
              "voiceConnectionLimit",
              "permissionOverwrites",
              "nsfw",
              "nsfwOverride",
              "contentWarningLevel",
              "contentWarningText",
              "rateLimitPerUser",
              ...(threadParent ? threadDefaultKeys : []),
              ...(forumParent ? forumSettingKeys : []),
              ...(type === ChannelType.Forum ? ["defaultForumLayout"] : []),
          ]
        : [
              "type",
              "name",
              "topic",
              "url",
              "bitrate",
              "userLimit",
              "voiceConnectionLimit",
              "nsfw",
              "nsfwOverride",
              "contentWarningLevel",
              "contentWarningText",
              "rateLimitPerUser",
              "permissionOverwrites",
              "rtcRegion",
              ...threadDefaultKeys,
              ...forumSettingKeys,
              "defaultForumLayout",
          ]
    const unsupported = unsupportedKeyFailure(
        input,
        allowed,
        "input",
        create ? "the channel create input" : "the channel edit input",
    )
    if (unsupported) return unsupported
    if (
        create &&
        type !== 0 &&
        type !== 2 &&
        type !== 4 &&
        type !== 5 &&
        type !== ChannelType.Forum &&
        type !== ChannelType.Media &&
        type !== 998
    )
        return inputValidationFailure(
            "type",
            "allowedValue",
            "Channel type must be 0 (Text), 2 (Voice), 4 (Category), 5 (Announcement), 15 (Forum), 16 (Media), or 998 (Link)",
        )
    if (
        !create &&
        input.type !== undefined &&
        input.type !== ChannelType.Text &&
        input.type !== ChannelType.Announcement
    )
        return inputValidationFailure(
            "type",
            "allowedValue",
            "Channel conversion type must be 0 (Text) or 5 (Announcement)",
        )
    if (create && input.name === undefined)
        return inputValidationFailure("name", "required", "Channel name is required")
    const rules = create
        ? type === ChannelType.Forum
            ? forumCreateRules
            : forumParent
              ? mediaCreateRules
              : createRules
        : editRules
    const checked = checkFields(input, rules, "")
    return checked
}

/**
 * Encode one forum tag, reading each field once. The `listed` argument is true for an entry of a channel's tag list, and allowId is
 * false where an ID is certain to fail, which is the tag list of a new channel because it has no tags. The single-tag
 * routes accept an ID so that a received tag is valid input, and their callers keep it out of the body
 */
function encodeForumTag(
    value: unknown,
    listed: boolean,
    allowId: boolean,
): Record<string, string | boolean | null> | InputValidationFailure {
    const container = listed ? "availableTags[]" : "input"
    const field = (name: string) => (listed ? `availableTags[].${name}` : name)
    if (!record(value)) return inputValidationFailure(container, "type", "A forum tag must be an object")
    const unsupported = unsupportedKeyFailure(
        value,
        allowId ? ["id", "name", "moderated", "emojiId", "emojiName"] : ["name", "moderated", "emojiId", "emojiName"],
        container,
        listed ? "a forum tag list entry" : "the forum tag input",
    )
    if (unsupported) return unsupported
    const read = fieldsOnce(value)
    const rawId = read("id")
    const name = read("name")
    const moderated = read("moderated")
    const emojiId = read("emojiId")
    const emojiName = read("emojiName")
    const id = rawId === undefined ? undefined : inputId(rawId)
    if (rawId !== undefined && id === undefined)
        return inputValidationFailure(
            field("id"),
            "format",
            "Forum tag IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    if (name === undefined) return inputValidationFailure(field("name"), "required", "A forum tag needs a name")
    if (!normalizedText(name, 1, 50))
        return inputValidationFailure(
            field("name"),
            "length",
            "Forum tag name must contain 1 through 50 UTF-16 code units after Fluxer's normalization",
        )
    if (moderated !== undefined && typeof moderated !== "boolean")
        return inputValidationFailure(field("moderated"), "type", "Forum tag moderated must be boolean")
    const emoji = encodeEmoji(emojiId, emojiName, field, container)
    if (emoji instanceof InputValidationFailure) return emoji
    return {
        ...(id === undefined ? {} : { id }),
        name,
        ...(moderated === undefined ? {} : { moderated }),
        ...emoji,
    }
}

/** Validate and encode the emoji pair of a forum tag or a default reaction, where at most one of the two may be set */
function encodeEmoji(
    emojiId: unknown,
    emojiName: unknown,
    path: (field: string) => string,
    container: string,
): Record<string, string | null> | InputValidationFailure {
    // Fluxer reads an empty emoji ID or name as null on these routes, so it counts as unset
    // (fluxer_api/src/api/Validator.ts:59-63 and fluxer_api/src/api/channel/services/thread/ThreadParentSettings.ts:126-127,
    // 162-168 at 0098958f)
    const emojiIdToSend = emojiId === undefined ? undefined : absentOrInputId(emojiId)
    if (emojiId !== undefined && emojiIdToSend === undefined)
        return inputValidationFailure(
            path("emojiId"),
            "format",
            "Emoji IDs must be null, empty or decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    if (emojiName !== undefined && !(emojiName === null || emojiName === "" || normalizedText(emojiName, 1, 64)))
        return inputValidationFailure(
            path("emojiName"),
            "length",
            "An emoji name must be null, empty or contain 1 through 64 UTF-16 code units after Fluxer's normalization",
        )
    if (emojiIdToSend != null && emojiIdToSend !== "" && emojiName != null && emojiName !== "")
        return inputValidationFailure(container, "relationship", "Set at most one of emojiId and emojiName")
    return {
        ...(emojiIdToSend === undefined ? {} : { emoji_id: emojiIdToSend }),
        ...(emojiName === undefined ? {} : { emoji_name: emojiName }),
    }
}

function encodeForumTags(
    value: unknown,
    allowId: boolean,
): readonly Record<string, string | boolean | null>[] | InputValidationFailure {
    if (!Array.isArray(value))
        return inputValidationFailure("availableTags", "type", "Forum channel availableTags must be an array")
    if (value.length > maxForumTags)
        return inputValidationFailure("availableTags", "length", "A forum channel can have at most 20 tags")
    const tags: Array<Record<string, string | boolean | null>> = []
    for (const item of value) {
        const tag = encodeForumTag(item, true, allowId)
        if (tag instanceof InputValidationFailure) return tag
        tags.push(tag)
    }
    return tags
}

function encodeDefaultReaction(value: unknown): Record<string, string | null> | null | InputValidationFailure {
    if (value === null) return null
    if (!record(value))
        return inputValidationFailure(
            "defaultReactionEmoji",
            "type",
            "Channel defaultReactionEmoji must be null or an object",
        )
    const unsupported = unsupportedKeyFailure(
        value,
        ["emojiId", "emojiName"],
        "defaultReactionEmoji",
        "the default reaction",
    )
    if (unsupported) return unsupported
    const read = fieldsOnce(value)
    return encodeEmoji(
        read("emojiId"),
        read("emojiName"),
        (field) => `defaultReactionEmoji.${field}`,
        "defaultReactionEmoji",
    )
}

function encodeOverwrites(value: unknown): readonly Record<string, string | number>[] | InputValidationFailure {
    if (!Array.isArray(value))
        return inputValidationFailure("permissionOverwrites", "type", "Permission overwrites must be an array")
    if (value.length > maxListEntries)
        return inputValidationFailure(
            "permissionOverwrites",
            "length",
            "A channel may contain at most 10,000 permission overwrites",
        )
    const overwrites: Array<Record<string, string | number>> = []
    const ids = new Set<string>()
    for (const item of value) {
        if (!record(item))
            return inputValidationFailure("permissionOverwrites[]", "type", "Permission overwrites must be objects")
        const unsupported = unsupportedKeyFailure(
            item,
            ["id", "type", "allow", "deny"],
            "permissionOverwrites[]",
            "A permission overwrite",
        )
        if (unsupported) return unsupported
        const id = inputId(item.id)
        if (id === undefined)
            return inputValidationFailure(
                "permissionOverwrites[].id",
                "format",
                "Permission overwrite IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
            )
        if (ids.has(id))
            return inputValidationFailure(
                "permissionOverwrites[].id",
                "unique",
                "Permission overwrite IDs must be unique",
            )
        if (item.type !== "role" && item.type !== "member")
            return inputValidationFailure(
                "permissionOverwrites[].type",
                "allowedValue",
                "Permission overwrite type must be role or member",
            )
        if (!writablePermission(item.allow))
            return inputValidationFailure(
                "permissionOverwrites[].allow",
                "range",
                "Permission overwrite allow must be a bigint from 0 through 9,223,372,036,854,775,807",
            )
        if (!writablePermission(item.deny))
            return inputValidationFailure(
                "permissionOverwrites[].deny",
                "range",
                "Permission overwrite deny must be a bigint from 0 through 9,223,372,036,854,775,807",
            )
        ids.add(id)
        overwrites.push({
            id,
            type: item.type === "role" ? 0 : 1,
            allow: item.allow.toString(),
            deny: item.deny.toString(),
        })
    }
    return overwrites
}

// oxlint-disable-next-line complexity -- a flat encoder, one wire field per channel input field
function channelBody(input: ChannelCreate | ChannelEdit, create: boolean): string | InputValidationFailure {
    if (!record(input)) return inputValidationFailure("input", "type", "Channel input must be an object")
    const validated = validateOptionalFields(input, create)
    if (validated instanceof InputValidationFailure) return validated
    const parentId = validated.parentId
    const permissionOverwrites =
        input.permissionOverwrites === undefined ? undefined : encodeOverwrites(input.permissionOverwrites)
    if (permissionOverwrites instanceof InputValidationFailure) return permissionOverwrites
    const availableTags = input.availableTags === undefined ? undefined : encodeForumTags(input.availableTags, !create)
    if (availableTags instanceof InputValidationFailure) return availableTags
    const defaultReaction =
        input.defaultReactionEmoji === undefined ? undefined : encodeDefaultReaction(input.defaultReactionEmoji)
    if (defaultReaction instanceof InputValidationFailure) return defaultReaction
    const body = {
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.topic === undefined ? {} : { topic: input.topic }),
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(create && parentId !== undefined ? { parent_id: parentId } : {}),
        ...(input.bitrate === undefined ? {} : { bitrate: input.bitrate }),
        ...(input.userLimit === undefined ? {} : { user_limit: input.userLimit }),
        ...(input.voiceConnectionLimit === undefined ? {} : { voice_connection_limit: input.voiceConnectionLimit }),
        ...(permissionOverwrites === undefined ? {} : { permission_overwrites: permissionOverwrites }),
        ...(input.nsfw === undefined ? {} : { nsfw: input.nsfw }),
        ...(input.nsfwOverride === undefined ? {} : { nsfw_override: input.nsfwOverride }),
        ...(input.contentWarningLevel === undefined ? {} : { content_warning_level: input.contentWarningLevel }),
        ...(input.contentWarningText === undefined ? {} : { content_warning_text: input.contentWarningText }),
        ...(input.rateLimitPerUser === undefined ? {} : { rate_limit_per_user: input.rateLimitPerUser }),
        ...(!create && input.rtcRegion !== undefined ? { rtc_region: input.rtcRegion } : {}),
        ...(input.defaultAutoArchiveMinutes === undefined
            ? {}
            : { default_auto_archive_duration: input.defaultAutoArchiveMinutes }),
        ...(input.defaultThreadRateLimitPerUser === undefined
            ? {}
            : { default_thread_rate_limit_per_user: input.defaultThreadRateLimitPerUser }),
        ...(availableTags === undefined ? {} : { available_tags: availableTags }),
        ...(defaultReaction === undefined ? {} : { default_reaction_emoji: defaultReaction }),
        ...(input.defaultSortOrder === undefined ? {} : { default_sort_order: input.defaultSortOrder }),
        ...(input.defaultForumLayout === undefined ? {} : { default_forum_layout: input.defaultForumLayout }),
        ...(input.defaultTagSetting === undefined ? {} : { default_tag_setting: input.defaultTagSetting }),
        ...(input.flags === undefined ? {} : { flags: input.flags }),
    }
    const json = JSON.stringify(body)
    if (json === "{}") return inputValidationFailure("input", "required", "Channel edit must contain a change")
    return Buffer.byteLength(json) > maxRequestBytes
        ? inputValidationFailure("input", "size", "Channel input must not exceed 15,029,592 encoded bytes")
        : json
}

export function channelFetch(rawChannelId: string): ChannelValidationResult<GuildChannel> {
    const channelId = inputId(rawChannelId)
    if (channelId === undefined)
        return inputValidationFailure(
            "channelId",
            "format",
            "Channel IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    return {
        majorId: channelId,
        bucket: "channel:read",
        path: `/channels/${channelId}`,
        method: "GET",
        status: 200,
        cache: { channelId },
        decode: (value) => {
            const channel = decodeGuildChannel(value)
            return channel === undefined || channel.id === channelId ? channel : rejectCheck("targetMismatch")
        },
    }
}

export function channelFollow(
    rawChannelId: string,
    input: ChannelFollowInput,
): ChannelValidationResult<FollowedChannel> {
    const channelId = inputId(rawChannelId)
    if (channelId === undefined)
        return inputValidationFailure(
            "channelId",
            "format",
            "Channel IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    if (!record(input)) return inputValidationFailure("input", "type", "Channel follow input must be an object")
    const unsupported = unsupportedKeyFailure(input, ["targetChannelId"], "input", "the channel follow input")
    if (unsupported) return unsupported
    const targetChannelId = inputId(input.targetChannelId)
    if (targetChannelId === undefined)
        return inputValidationFailure(
            "targetChannelId",
            "format",
            "Target channel IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    return {
        majorId: channelId,
        bucket: "channel:follow",
        audited: true,
        path: `/channels/${channelId}/followers`,
        method: "POST",
        status: 200,
        json: JSON.stringify({ webhook_channel_id: targetChannelId }),
        cache: { channelId: targetChannelId, mutation: true },
        decode: (value) =>
            record(value) && value.channel_id === channelId && identifier(value.webhook_id)
                ? Object.freeze({ channelId, webhookId: value.webhook_id })
                : undefined,
    }
}

export function channelFollowerStats(rawChannelId: string): ChannelValidationResult<ChannelFollowerStats> {
    const channelId = inputId(rawChannelId)
    if (channelId === undefined)
        return inputValidationFailure(
            "channelId",
            "format",
            "Channel IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    return {
        majorId: channelId,
        bucket: "channel:follower_stats",
        path: `/channels/${channelId}/follower-stats`,
        method: "GET",
        status: 200,
        decode: (value) =>
            record(value) && nonNegativeInt32(value.channel_count) && nonNegativeInt32(value.guild_count)
                ? Object.freeze({ channelCount: value.channel_count, guildCount: value.guild_count })
                : undefined,
    }
}

export function channelList(rawGuildId: string): ChannelValidationResult<readonly GuildChannel[]> {
    const guildId = inputId(rawGuildId)
    if (guildId === undefined)
        return inputValidationFailure(
            "guildId",
            "format",
            "Guild IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    return {
        majorId: guildId,
        bucket: "guild:channels:list",
        path: `/guilds/${guildId}/channels`,
        method: "GET",
        status: 200,
        cache: { guildId, replace: true },
        decode: (value) => decodeGuildChannels(value, guildId),
    }
}

export function channelCreate(rawGuildId: string, input: ChannelCreate): ChannelValidationResult<GuildChannel> {
    const guildId = inputId(rawGuildId)
    if (guildId === undefined)
        return inputValidationFailure(
            "guildId",
            "format",
            "Guild IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    const json = channelBody(input, true)
    if (json instanceof InputValidationFailure) return json
    return {
        majorId: guildId,
        bucket: "guild:channel:create",
        audited: true,
        path: `/guilds/${guildId}/channels`,
        method: "POST",
        status: 200,
        json,
        ...(input.permissionOverwrites === undefined ? {} : { features: ["view_channel_members_permission"] }),
        cache: { guildId, mutation: true },
        decode: (value) => {
            const channel = decodeGuildChannel(value)
            return channel?.guildId === guildId ? channel : undefined
        },
    }
}

/** The tags an edit's availableTags removes: Every existing tag that no entry names by ID */
function tagsRemovedBy(tags: readonly ForumTagInput[]) {
    const kept = new Set(
        tags.flatMap((tag) => {
            const id = inputId(tag.id)
            return id === undefined ? [] : [id]
        }),
    )
    return (tagId: string) => !kept.has(tagId)
}

export function channelEdit(rawChannelId: string, input: ChannelEdit): ChannelValidationResult<GuildChannel> {
    const channelId = inputId(rawChannelId)
    if (channelId === undefined)
        return inputValidationFailure(
            "channelId",
            "format",
            "Channel IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    const json = channelBody(input, false)
    if (json instanceof InputValidationFailure) return json
    return {
        majorId: channelId,
        bucket: "channel:update",
        audited: true,
        path: `/channels/${channelId}`,
        method: "PATCH",
        status: 200,
        json,
        ...(input.permissionOverwrites === undefined ? {} : { features: ["view_channel_members_permission"] }),
        // Converting a channel's type also retypes its threads, and replacing a forum's tags drops every tag the list does
        // not name by ID from its posts, which Fluxer filters on read without a thread update
        cache: {
            channelId,
            mutation: true,
            ...(input.type === undefined ? {} : { changesThreads: true }),
            ...(input.availableTags === undefined ? {} : { removesTag: tagsRemovedBy(input.availableTags) }),
        },
        decode: (value) => {
            const channel = decodeGuildChannel(value)
            return channel === undefined || channel.id === channelId ? channel : rejectCheck("targetMismatch")
        },
    }
}

function forumTagRequest(
    channelId: string,
    tagId: string | undefined,
    method: "POST" | "PUT" | "DELETE",
    json?: string,
): ChannelRequest<GuildForumChannel | GuildMediaChannel> {
    return {
        majorId: channelId,
        bucket: "channel:forum_tags",
        audited: true,
        path: tagId === undefined ? `/channels/${channelId}/tags` : `/channels/${channelId}/tags/${tagId}`,
        method,
        status: 200,
        ...(json === undefined ? {} : { json }),
        // Deleting a tag drops it from the forum's posts, which Fluxer filters on read without a thread update
        cache: {
            channelId,
            mutation: true,
            ...(method === "DELETE" && tagId !== undefined ? { removesTag: (id: string) => id === tagId } : {}),
        },
        // Fluxer answers with the updated channel, so any other shape is a malformed response
        decode: (value) => {
            const channel = decodeGuildChannel(value)
            return channel?.id === channelId &&
                (channel.type === ChannelType.Forum || channel.type === ChannelType.Media)
                ? channel
                : undefined
        },
    }
}

export function forumTagCreate(
    rawChannelId: string,
    input: ForumTagInput,
): ChannelValidationResult<GuildForumChannel | GuildMediaChannel> {
    const channelId = inputId(rawChannelId)
    if (channelId === undefined)
        return inputValidationFailure(
            "channelId",
            "format",
            "Channel IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    const tag = encodeForumTag(input, false, true)
    if (tag instanceof InputValidationFailure) return tag
    // Fluxer assigns the ID of a new tag, so a received tag's own ID is dropped instead of sent
    const { id: _ignored, ...body } = tag
    return forumTagRequest(channelId, undefined, "POST", JSON.stringify(body))
}

export function forumTagEdit(
    rawChannelId: string,
    rawTagId: string,
    input: ForumTagInput,
): ChannelValidationResult<GuildForumChannel | GuildMediaChannel> {
    const channelId = inputId(rawChannelId)
    if (channelId === undefined)
        return inputValidationFailure(
            "channelId",
            "format",
            "Channel IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    const tagId = inputId(rawTagId)
    if (tagId === undefined)
        return inputValidationFailure(
            "tagId",
            "format",
            "Forum tag IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    const tag = encodeForumTag(input, false, true)
    if (tag instanceof InputValidationFailure) return tag
    // The route names the tag, and Fluxer would ignore another ID in the body, so a different one is a mistake
    const { id, ...body } = tag
    if (id !== undefined && id !== tagId)
        return inputValidationFailure("id", "relationship", "A forum tag's id must equal the tagId argument")
    return forumTagRequest(channelId, tagId, "PUT", JSON.stringify(body))
}

export function forumTagDelete(
    rawChannelId: string,
    rawTagId: string,
): ChannelValidationResult<GuildForumChannel | GuildMediaChannel> {
    const channelId = inputId(rawChannelId)
    if (channelId === undefined)
        return inputValidationFailure(
            "channelId",
            "format",
            "Channel IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    const tagId = inputId(rawTagId)
    if (tagId === undefined)
        return inputValidationFailure(
            "tagId",
            "format",
            "Forum tag IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    return forumTagRequest(channelId, tagId, "DELETE")
}

export function channelDelete(rawChannelId: string): ChannelValidationResult<void> {
    const channelId = inputId(rawChannelId)
    if (channelId === undefined)
        return inputValidationFailure(
            "channelId",
            "format",
            "Channel IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    return {
        majorId: channelId,
        bucket: "channel:delete",
        audited: true,
        path: `/channels/${channelId}`,
        method: "DELETE",
        status: 204,
        cache: { channelId, mutation: true, changesThreads: true },
        decode: () => undefined,
    }
}

function channelPositionBody(positions: readonly ChannelPosition[]): string | InputValidationFailure {
    if (!Array.isArray(positions))
        return inputValidationFailure("positions", "type", "Channel positions must be an array")
    if (positions.length === 0)
        return inputValidationFailure("positions", "length", "Channel positions must contain at least one entry")
    if (positions.length > maxListEntries)
        return inputValidationFailure("positions", "length", "Channel positions must contain at most 10,000 entries")
    const ids = new Set<string>()
    const updates: Array<Record<string, string | number | boolean | null>> = []
    for (const item of positions) {
        const unsupported = record(item)
            ? unsupportedKeyFailure(
                  item,
                  ["id", "position", "parentId", "precedingSiblingId", "syncPermissionsOnMove"],
                  "positions[]",
                  "a channel position entry",
              )
            : undefined
        if (unsupported) return unsupported
        const id = record(item) ? inputId(item.id) : undefined
        const parentId = record(item) && item.parentId !== undefined ? absentOrInputId(item.parentId) : undefined
        const precedingSiblingId =
            record(item) && item.precedingSiblingId !== undefined ? absentOrInputId(item.precedingSiblingId) : undefined
        if (
            !record(item) ||
            id === undefined ||
            ids.has(id) ||
            (item.position !== undefined &&
                (typeof item.position !== "number" || !Number.isSafeInteger(item.position) || item.position < 0)) ||
            (item.parentId !== undefined && parentId === undefined) ||
            (item.precedingSiblingId !== undefined && precedingSiblingId === undefined) ||
            (item.syncPermissionsOnMove !== undefined && typeof item.syncPermissionsOnMove !== "boolean")
        )
            return inputValidationFailure(
                "positions[]",
                "format",
                "Each channel position entry must be an object with a unique decimal id, and may also contain only position (a nonnegative integer), parentId and precedingSiblingId (decimal IDs, null or empty), and syncPermissionsOnMove (a boolean)",
            )
        const update = {
            id,
            ...(item.position === undefined ? {} : { position: item.position }),
            ...(parentId === undefined ? {} : { parent_id: parentId }),
            ...(precedingSiblingId === undefined ? {} : { preceding_sibling_id: precedingSiblingId }),
            ...(item.syncPermissionsOnMove === undefined ? {} : { lock_permissions: item.syncPermissionsOnMove }),
        }
        ids.add(id)
        updates.push(update)
    }
    return JSON.stringify(updates)
}

export function channelReorder(
    rawGuildId: string,
    positions: readonly ChannelPosition[],
): ChannelValidationResult<void> {
    const guildId = inputId(rawGuildId)
    if (guildId === undefined)
        return inputValidationFailure(
            "guildId",
            "format",
            "Guild IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    const json = channelPositionBody(positions)
    if (json instanceof InputValidationFailure) return json
    return {
        majorId: guildId,
        bucket: "guild:channel:positions",
        audited: true,
        path: `/guilds/${guildId}/channels`,
        method: "PATCH",
        status: 204,
        json,
        cache: { guildId, mutation: true },
        decode: () => undefined,
    }
}

/** The trimmed overwrite ID and the request body */
function permissionSetBody(input: PermissionOverwrite): { id: string; json: string } | InputValidationFailure {
    const unsupported = record(input)
        ? unsupportedKeyFailure(
              input,
              ["id", "type", "allow", "deny"],
              "permissionOverwrite",
              "the permission overwrite",
          )
        : undefined
    if (unsupported) return unsupported
    const id = record(input) ? inputId(input.id) : undefined
    if (
        !record(input) ||
        id === undefined ||
        (input.type !== "role" && input.type !== "member") ||
        !writablePermission(input.allow) ||
        !writablePermission(input.deny)
    )
        return inputValidationFailure(
            "permissionOverwrite",
            "format",
            "Permission overwrite requires a decimal ID, role or member type, and allow and deny values from 0 through 9,223,372,036,854,775,807",
        )
    return {
        id,
        json: JSON.stringify({
            type: input.type === "role" ? 0 : 1,
            allow: input.allow.toString(),
            deny: input.deny.toString(),
        }),
    }
}

export function permissionSet(rawChannelId: string, input: PermissionOverwrite): ChannelValidationResult<void> {
    const channelId = inputId(rawChannelId)
    if (channelId === undefined)
        return inputValidationFailure(
            "channelId",
            "format",
            "Channel IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    const body = permissionSetBody(input)
    if (body instanceof InputValidationFailure) return body
    const { id, json } = body
    return {
        majorId: channelId,
        bucket: "channel:update",
        audited: true,
        path: `/channels/${channelId}/permissions/${id}`,
        method: "PUT",
        status: 204,
        json,
        features: ["view_channel_members_permission"],
        cache: { channelId, mutation: true },
        decode: () => undefined,
    }
}

export function permissionRemove(rawChannelId: string, rawTargetId: string): ChannelValidationResult<void> {
    const channelId = inputId(rawChannelId)
    if (channelId === undefined)
        return inputValidationFailure(
            "channelId",
            "format",
            "Channel IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    const targetId = inputId(rawTargetId)
    if (targetId === undefined)
        return inputValidationFailure(
            "targetId",
            "format",
            "Permission target IDs must be decimal strings, because JavaScript numbers cannot hold Fluxer IDs exactly",
        )
    return {
        majorId: channelId,
        bucket: "channel:update",
        audited: true,
        path: `/channels/${channelId}/permissions/${targetId}`,
        method: "DELETE",
        status: 204,
        cache: { channelId, mutation: true },
        decode: () => undefined,
    }
}
