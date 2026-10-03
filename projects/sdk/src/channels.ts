import type { OperationOptions } from "./client.js"
import type { ClientClosedError } from "./errors.js"
import { operationErrorFields, operationErrorSettings, operationErrorText, type ApiErrorDetail } from "./api-errors.js"
import { FluxerlyError, type OperationErrorOptions, type OperationOutcome, type OperationReason } from "./errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"

/** Choose what a new community channel does: Text messages, announcements, voice calls, a category that groups channels, or a link.
 * Received channels use the same constants in GuildChannel.type. A future Fluxer type that this SDK version does not
 * know arrives as a GuildUnknownChannel, whose type is "unknown" and whose rawType keeps the number
 *
 * @category Channels
 */
export const ChannelType: Readonly<{
    /** A community text conversation */
    Text: 0
    /** A community voice-call channel */
    Voice: 2
    /** A grouping parent for community channels */
    Category: 4
    /** A community announcement channel whose published messages can reach following channels */
    Announcement: 5
    /** A channel that points to an external URL */
    Link: 998
}> = Object.freeze({
    Text: 0,
    Voice: 2,
    Category: 4,
    Announcement: 5,
    Link: 998,
})

/** Give or deny channel permissions to one role or member.
 * A permission absent from both allow and deny remains subject to other applicable roles and overwrites.
 * Build these bitfields with Permissions constants and bigint bitwise operators. This is one explicit overwrite,
 * not the member's final permissions. SDK writes accept values through 9_223_372_036_854_775_807n and send
 * ViewChannelMembers replacements to Fluxer. Received values can use the full unsigned 64-bit range
 *
 * @category Roles and permissions
 */
export interface PermissionOverwrite {
    /** Decimal role or member ID */
    readonly id: string
    /** Whether id identifies a role or a community member */
    readonly type: "role" | "member"
    /** Permissions explicitly granted here. Writes accept 0n through 9_223_372_036_854_775_807n, and responses can use unsigned 64-bit values. 0n grants nothing explicitly */
    readonly allow: bigint
    /** Permissions explicitly denied here. Writes accept 0n through 9_223_372_036_854_775_807n, and responses can use unsigned 64-bit values. 0n denies nothing explicitly */
    readonly deny: bigint
}

/**
 * Fields every community channel shares, whatever its type
 *
 * @category Channels
 */
export interface GuildChannelBase {
    /** Decimal channel ID */
    readonly id: string
    /** Decimal community ID */
    readonly guildId: string
    /** A ChannelType constant, or "unknown" for a type this SDK version does not know. Compare it to select the
     * matching channel shape
     */
    readonly type: (typeof ChannelType)[keyof typeof ChannelType] | "unknown"
    /** Channel name, when Fluxer supplies one */
    readonly name?: string
    /** Server ordering position, not an immutable ordering guarantee */
    readonly position?: number
    /** Parent category ID, with null meaning top-level and omission meaning unavailable */
    readonly parentId?: string | null
    /** Explicit channel overwrites, not inherited or effective permissions */
    readonly permissionOverwrites?: readonly PermissionOverwrite[]
    /** Effective adult-content setting from Fluxer's older NSFW field, when supplied */
    readonly nsfw?: boolean
    /** Channel adult-content override, with null inheriting from its category then community */
    readonly nsfwOverride?: boolean | null
    /** Channel content-warning override, when supplied */
    readonly contentWarningLevel?: number
    /** Custom content-warning text, with null inheriting */
    readonly contentWarningText?: string | null
}

/**
 * Message and topic fields shared by community text and announcement channels
 *
 * @category Channels
 */
export interface GuildTextChannelBase extends GuildChannelBase {
    /** Text or announcement channel type. Each received shape has its own literal discriminant */
    readonly type: typeof ChannelType.Text | typeof ChannelType.Announcement
    /** Topic, with null clearing it and omission meaning unavailable */
    readonly topic?: string | null
    /** Last message ID, with null meaning no known message */
    readonly lastMessageId?: string | null
    /** ISO 8601 last-pin time, with null meaning no pins */
    readonly lastPinTimestamp?: string | null
    /** Slowmode delay in seconds */
    readonly rateLimitPerUser?: number
}

/**
 * A community text conversation, selected by `type === ChannelType.Text`
 *
 * @category Channels
 */
export interface GuildTextChannel extends GuildTextChannelBase {
    /** Always ChannelType.Text */
    readonly type: typeof ChannelType.Text
}

/**
 * A community announcement channel, selected by `type === ChannelType.Announcement`.
 * It has the same message and topic fields as a text channel
 *
 * @category Channels
 */
export interface GuildAnnouncementChannel extends GuildTextChannelBase {
    /** Always ChannelType.Announcement */
    readonly type: typeof ChannelType.Announcement
}

/**
 * A community voice-call channel, selected by `type === ChannelType.Voice`
 *
 * @category Channels
 */
export interface GuildVoiceChannel extends GuildChannelBase {
    /** Always ChannelType.Voice */
    readonly type: typeof ChannelType.Voice
    /** Voice bitrate in bits per second, with null meaning no voice setting */
    readonly bitrate?: number | null
    /** Voice user limit, with null meaning no voice setting */
    readonly userLimit?: number | null
    /** Voice connections permitted per user, with null meaning no voice setting */
    readonly voiceConnectionLimit?: number | null
    /** Voice region ID, with null selecting automatic routing */
    readonly rtcRegion?: string | null
    /** Last message ID in the channel's text chat, with null meaning no known message */
    readonly lastMessageId?: string | null
    /** Slowmode delay in seconds for the channel's text chat */
    readonly rateLimitPerUser?: number
}

/**
 * A grouping parent for community channels, selected by `type === ChannelType.Category`
 *
 * @category Channels
 */
export interface GuildCategoryChannel extends GuildChannelBase {
    /** Always ChannelType.Category */
    readonly type: typeof ChannelType.Category
}

/**
 * A channel that points to an external URL, selected by `type === ChannelType.Link`
 *
 * @category Channels
 */
export interface GuildLinkChannel extends GuildChannelBase {
    /** Always ChannelType.Link */
    readonly type: typeof ChannelType.Link
    /** Link URL, with null clearing it and omission meaning unavailable */
    readonly url?: string | null
}

/**
 * A community channel of a type this SDK version does not know, such as a type Fluxer adds later, selected by
 * `type === "unknown"`. No ChannelType constant equals "unknown", so a ChannelType comparison always excludes this
 * shape, and rawType keeps the number Fluxer sent. Every optional channel field stays readable, so the channel remains
 * usable without a type-specific shape. A later SDK version that knows the type returns the matching shape instead
 *
 * @category Channels
 */
export interface GuildUnknownChannel
    extends
        GuildChannelBase,
        Omit<GuildTextChannelBase, "type">,
        Omit<GuildVoiceChannel, "type">,
        Omit<GuildLinkChannel, "type"> {
    /** Always "unknown" */
    readonly type: "unknown"
    /** Numeric channel type Fluxer sent, outside the known ChannelType constants */
    readonly rawType: number
}

/** Settings and identity of a community channel returned by a read or gateway event, as one shape per channel type.
 * Compare `type` with ChannelType constants to narrow to exactly one shape, such as `channel.type === ChannelType.Voice`
 * before reading `bitrate`. A type this SDK version does not know is a GuildUnknownChannel with type "unknown", its
 * Fluxer number in rawType and every optional field, so a switch on type that also handles "unknown" is exhaustive.
 * The object is frozen and does not update when the channel changes. Optional fields may be unavailable rather than
 * set to their creation defaults. This excludes private conversations, which use DirectMessageChannel
 *
 * @category Channels
 */
export type GuildChannel =
    | GuildTextChannel
    | GuildAnnouncementChannel
    | GuildVoiceChannel
    | GuildCategoryChannel
    | GuildLinkChannel
    | GuildUnknownChannel

/** Settings shared by new text, announcement, voice, category and link channels.
 * Supply the matching ChannelCreate type. Fluxer decides which settings apply to that channel type and
 * enforces permissions. Omitted permissionOverwrites inherit from the parent category, while [] requests none.
 * Unknown input keys fail locally. The encoded request body must fit within 4,194,304 bytes
 *
 * @category Channels
 */
export interface ChannelCreateBase {
    /** Channel name. Raw input may contain at most 10,000 UTF-16 code units. For validation, Fluxer's general-name
     * rules remove U+000C and U+202E, trim surrounding whitespace, strip provider-defined invisible characters,
     * normalize whitespace and collapse its runs, then require 1–100 UTF-16 code units. The SDK sends the original
     * string without lowercasing or hyphenating it
     */
    readonly name: string
    /** Description shown for the channel, 1–1,024 UTF-16 code units after U+000C and U+202E removal and
     * surrounding-whitespace trimming, or null to clear. The original string is sent unchanged
     */
    readonly topic?: string | null
    /** Absolute URL for a link channel, or null to clear. The SDK does not open or fetch the URL */
    readonly url?: string | null
    /** Parent category, with null or omission creating a top-level channel */
    readonly parentId?: string | null
    /** Voice audio bitrate in bits per second, integer 8,000–384,000 or null, default 64,000 for voice channels.
     * Fluxer clamps the requested value to the community's enabled bitrate tier. Read the returned channel for the applied value
     */
    readonly bitrate?: number | null
    /** Maximum voice users from 0 through 99, with 0 unlimited and the voice default */
    readonly userLimit?: number | null
    /** Voice connections per user from 1 through 100, default 5 for voice channels */
    readonly voiceConnectionLimit?: number | null
    /** Explicit overrides, omitted to inherit a parent category and [] to create no overrides */
    readonly permissionOverwrites?: readonly PermissionOverwrite[]
    /** Adult-content setting using Fluxer's older NSFW field. True marks the channel adult-only, while false inherits
     * the parent category or community setting like omission. Use nsfwOverride false to mark it not adult-only.
     * When both are present, nsfwOverride wins
     */
    readonly nsfw?: boolean
    /** Explicit adult-content override, with null inheriting */
    readonly nsfwOverride?: boolean | null
    /** 0 inherits the content-warning level, 1 requests a channel content warning */
    readonly contentWarningLevel?: number
    /** Warning shown before viewing content, with 0–200 raw UTF-16 code units and null inheriting.
     * No text normalization is applied before validation
     */
    readonly contentWarningText?: string | null
    /** Delay between a user's messages in seconds, integer 0–21,600 or null. Zero disables slowmode */
    readonly rateLimitPerUser?: number | null
}

/**
 * Creates a text channel
 *
 * @category Channels
 */
export interface TextChannelCreate extends ChannelCreateBase {
    /** Text channel type */
    readonly type: typeof ChannelType.Text
}

/**
 * Creates an announcement channel with the same settings as a text channel
 *
 * @category Channels
 */
export interface AnnouncementChannelCreate extends ChannelCreateBase {
    /** Announcement channel type */
    readonly type: typeof ChannelType.Announcement
}

/**
 * Creates a voice channel
 *
 * @category Channels
 */
export interface VoiceChannelCreate extends ChannelCreateBase {
    /** Voice channel type */
    readonly type: typeof ChannelType.Voice
}

/**
 * Create a category to group community channels
 *
 * @category Channels
 */
export interface CategoryChannelCreate extends ChannelCreateBase {
    /** Category channel type */
    readonly type: typeof ChannelType.Category
}

/**
 * Create a community channel that points readers to a URL
 *
 * @category Channels
 */
export interface LinkChannelCreate extends ChannelCreateBase {
    /** Link channel type */
    readonly type: typeof ChannelType.Link
}

/**
 * One supported community-channel creation request, with Fluxer positioning a new channel itself
 *
 * @category Channels
 */
export type ChannelCreate =
    TextChannelCreate | AnnouncementChannelCreate | VoiceChannelCreate | CategoryChannelCreate | LinkChannelCreate

/** Change an existing community channel's settings without replacing the channel.
 * Omitted fields stay unchanged. The permissionOverwrites list replaces the whole explicit list, so include entries that
 * must stay. Use channels.reorder to move a channel between categories or change its order. Unknown keys and an empty patch fail locally.
 * Fluxer checks channel-type compatibility and permissions after local validation
 *
 * @category Channels
 */
export interface ChannelEdit {
    /** Convert between Text (0) and Announcement (5), alone or with other settings. Omission preserves the type.
     * Other values fail locally. Fluxer requires ManageChannels and rejects converting a text channel that receives
     * follows with CHANNEL_HAS_FOLLOWED_CHANNELS. Converting Announcement to Text queues asynchronous follower removal.
     * Fluxer emits a complete Channel Update with the new type, replacing any cached observation before handlers run.
     * The edit does not await that event or follower removal
     * @see https://github.com/fluxerapp/fluxer/blob/597116a0b4bf3a212789bdebe7f284babc33b445/fluxer_api/src/api/channel/services/channel_data/ChannelOperationsService.ts
     */
    readonly type?: typeof ChannelType.Text | typeof ChannelType.Announcement
    /** Channel name. Raw input may contain at most 10,000 UTF-16 code units. For validation, Fluxer's general-name
     * rules remove U+000C and U+202E, trim surrounding whitespace, strip provider-defined invisible characters,
     * normalize whitespace and collapse its runs, then require 1–100 UTF-16 code units. The SDK sends the original
     * string without lowercasing or hyphenating it
     */
    readonly name?: string
    /** Channel description, 1–1,024 UTF-16 code units after U+000C and U+202E removal and
     * surrounding-whitespace trimming, or null to clear. The original string is sent unchanged
     */
    readonly topic?: string | null
    /** Absolute link-channel URL, or null to clear. No URL is fetched by this request */
    readonly url?: string | null
    /** Voice bitrate in bits per second, integer 8,000–384,000, or null.
     * Fluxer clamps the requested value to the community's enabled bitrate tier. Read the returned channel for the applied value
     */
    readonly bitrate?: number | null
    /** Maximum voice users, integer 0–99, or null. Zero requests unlimited users */
    readonly userLimit?: number | null
    /** Maximum simultaneous voice connections per user, integer 1–100, or null */
    readonly voiceConnectionLimit?: number | null
    /** Adult-content setting using Fluxer's older NSFW field. True marks the channel adult-only, while false and null
     * restore inheritance from the parent category or community. Use nsfwOverride false to mark it not adult-only.
     * When both are present, nsfwOverride wins
     */
    readonly nsfw?: boolean | null
    /** Explicit adult-content override, with null inheriting */
    readonly nsfwOverride?: boolean | null
    /** 0 inherits the content-warning level, 1 requests a channel content warning */
    readonly contentWarningLevel?: number
    /** Warning text with 0–200 raw UTF-16 code units, with null inheriting.
     * No text normalization is applied before validation
     */
    readonly contentWarningText?: string | null
    /** Delay between a user's messages in seconds, integer 0–21,600, or null. Zero disables slowmode */
    readonly rateLimitPerUser?: number | null
    /** Replace all explicit overwrites, with [] clearing them and omission preserving them */
    readonly permissionOverwrites?: readonly PermissionOverwrite[]
    /** Voice region ID of 1–64 UTF-16 code units after U+000C and U+202E removal and surrounding-whitespace
     * trimming, with null selecting automatic routing. The original string is sent unchanged
     */
    readonly rtcRegion?: string | null
}

/** Move or reorder one community channel with channels.reorder.
 * Channels left out of the request are not explicit targets. Fluxer applies entries in order, so the requested position
 * may not be the final position if another change happens at the same time
 *
 * @category Channels
 */
export interface ChannelPosition {
    /** Decimal channel ID */
    readonly id: string
    /** Nonnegative requested sibling position */
    readonly position?: number
    /** New parent category, with null moving to the top level and omission preserving the parent */
    readonly parentId?: string | null
    /** Sibling directly preceding this channel, with null placing it first */
    readonly precedingSiblingId?: string | null
    /** Copy destination overwrites only when moving into a new category, default false and no sync for the same parent */
    readonly syncPermissionsOnMove?: boolean
}

/**
 * Visible channel updates delivered together, not a complete community channel list
 *
 * @category Events and collectors
 */
export interface GuildChannelUpdateBulk {
    /** Decimal community ID */
    readonly guildId: string
    /** Frozen channel snapshots delivered in this dispatch */
    readonly channels: readonly GuildChannel[]
}

/** Subscribe a text channel to messages published from an announcement channel.
 * Fluxer validates the source, target and permissions without an SDK prefetch
 *
 * @category Channels
 */
export interface ChannelFollowInput {
    /** Decimal ID of the receiving community text channel, whose type must be ChannelType.Text */
    readonly targetChannelId: string
}

/** A confirmed announcement-channel follow, returned as a frozen value.
 * Delete webhookId through client.webhooks.delete to stop following
 *
 * @category Channels
 */
export interface FollowedChannel {
    /** Decimal ID of the followed announcement channel, not the receiving channel */
    readonly channelId: string
    /** Decimal ID of the channel-follower webhook created in the receiving channel */
    readonly webhookId: string
}

/** A frozen count of channels and communities following one announcement channel.
 * Fluxer can cache these counts for up to 60 seconds. They are not live subscriptions
 *
 * @category Channels
 */
export interface ChannelFollowerStats {
    /** Number of following channels */
    readonly channelCount: number
    /** Number of distinct communities containing following channels */
    readonly guildCount: number
}

/**
 * Settings shared by remote community-channel operations
 *
 * @category Options
 */
export interface ChannelOperationOptions {
    /** Total milliseconds across local queueing, rate waits, retries and HTTP, integer 1–2,147,483,647, default the client's rest.defaultTimeoutMs, 30,000 unless configured.
     * Owned cleanup is awaited afterward, so the call can finish later than this deadline
     */
    readonly timeoutMs?: number
}

/**
 * Default API calls start immediately, with abort cancelling only this call and awaiting owned cleanup
 *
 * @category Options
 */
export interface DefaultChannelOperationOptions extends ChannelOperationOptions, OperationOptions {}

/**
 * Settings for a channel mutation whose provider handler consumes an audit-log reason
 *
 * @category Options
 */
export interface ChannelAuditOperationOptions extends ChannelOperationOptions {
    /** Optional audit-log reason, 1–512 printable ASCII characters after trimming.
     * Sent as a raw header because Fluxer does not decode URL escapes. Non-ASCII and control characters fail before dispatch.
     * Omission sends no header. Never included in SDK errors or diagnostics.
     * Header delivery does not guarantee provider retention. Fluxer's channel-reorder path currently does not persist it in an audit entry
     */
    readonly auditReason?: string
}

/**
 * Default API audited channel mutations start immediately. Abort cannot roll back a dispatched mutation
 *
 * @category Options
 */
export interface DefaultChannelAuditOperationOptions extends ChannelAuditOperationOptions, OperationOptions {}

/**
 * The channel action named in an expected failure or SdkDefect
 *
 * @category Errors
 */
export type ChannelOperation =
    | "channels.get"
    | "channels.fetch"
    | "channels.fetchAll"
    | "channels.follow"
    | "channels.fetchFollowerStats"
    | "channels.create"
    | "channels.edit"
    | "channels.delete"
    | "channels.reorder"
    | "channels.setPermissionOverwrite"
    | "channels.removePermissionOverwrite"

/** Expected failure when reading or changing community channels.
 * Check reason to identify the failure. Check outcome before retrying a change because an uncertain write may have happened.
 * The error contains no token, private input value or server response body. The default API returns it in an Err.
 * The Effect API fails with it in its typed error channel
 *
 * @category Errors
 */
export class ChannelOperationError extends FluxerlyError {
    /** Stable expected-failure discriminator */
    readonly _tag = "ChannelOperationError"
    /** Requested operation */
    readonly operation: ChannelOperation
    /** Failure category, described by {@link OperationReason} */
    readonly reason: OperationReason
    /** Whether the request may have reached Fluxer, described by {@link OperationOutcome} */
    readonly outcome: OperationOutcome
    /** HTTP status when available, otherwise null */
    readonly status: number | null
    /** Usable server-required retry wait in milliseconds, otherwise null */
    readonly retryAfterMs: number | null
    /** Safe classification of why Fluxer rejected the request, or null when the response could not be classified */
    readonly apiError: ApiErrorDetail | null
    /** Safe explanation of the locally invalid property, or null when no input problem could be identified */
    readonly inputValidation: InputValidationDetail | null
    /** Create the failure from its operation, reason and outcome, with optional status, retry wait, API detail, input detail and cause */
    constructor(options: OperationErrorOptions<ChannelOperation>) {
        const fields = operationErrorFields(options)
        super(operationErrorText("Channel", fields), operationErrorSettings("channel", fields, options.cause))
        this.operation = fields.operation
        this.reason = fields.reason
        this.outcome = fields.outcome
        this.status = fields.status
        this.retryAfterMs = fields.retryAfterMs
        this.apiError = fields.apiError
        this.inputValidation = freezeInputValidationDetail(fields.inputValidation)
        this.name = this._tag
    }
}

/**
 * Native interruption is outside this union, with default API methods additionally returning CancelledError
 *
 * @category Errors
 */
export type ChannelOperationFailure = ChannelOperationError | ClientClosedError
