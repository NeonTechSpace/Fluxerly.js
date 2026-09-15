import type { OperationOptions } from "./client.js"
import type { ClientClosedError } from "./errors.js"
import { operationErrorMessage, type ApiErrorDetail } from "./api-errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"

/** Choose what a new guild channel does: Text messages, voice calls, a category that groups channels, or a link.
 * Received GuildChannel.type values can also contain future numeric types that this SDK cannot create
 */
export const ChannelType: Readonly<{
    /** A guild text conversation */
    Text: 0
    /** A guild voice-call channel */
    Voice: 2
    /** A grouping parent for guild channels */
    Category: 4
    /** A channel that points to an external URL */
    Link: 998
}> = Object.freeze({
    Text: 0,
    Voice: 2,
    Category: 4,
    Link: 998,
})

/** Channel-specific grants and denials for one role or member.
 * A bit absent from both allow and deny leaves that permission to the other applicable roles and overwrites.
 * Use Permissions constants and bigint bitwise operators to build the bitfields. This is one explicit overwrite,
 * not the member's final permissions. SDK writes accept values through 9_223_372_036_854_775_807n and advertise
 * ViewChannelMembers replacements to Fluxer. Received values can use the full unsigned 64-bit range
 */
export interface PermissionOverwrite {
    /** Decimal role or member ID */
    readonly id: string
    /** Whether id identifies a role or a guild member */
    readonly type: "role" | "member"
    /** Permissions explicitly granted here. Writes accept 0n through 9_223_372_036_854_775_807n; responses can use unsigned 64-bit values. 0n grants nothing explicitly */
    readonly allow: bigint
    /** Permissions explicitly denied here. Writes accept 0n through 9_223_372_036_854_775_807n; responses can use unsigned 64-bit values. 0n denies nothing explicitly */
    readonly deny: bigint
}

/** Settings and identity of a channel inside a guild, as observed by a read or gateway event.
 * The object is frozen and does not update when the channel changes. Optional fields can be unavailable rather than
 * set to their creation defaults. This excludes private conversations, which use DirectMessageChannel
 */
export interface GuildChannel {
    /** Decimal channel ID */
    readonly id: string
    /** Decimal guild ID */
    readonly guildId: string
    /** Numeric Fluxer type, with unknown future guild types remaining readable but not creatable through ChannelCreate */
    readonly type: number
    /** Channel name, when Fluxer supplies one */
    readonly name?: string
    /** Topic, with null clearing it and omission meaning unavailable */
    readonly topic?: string | null
    /** Link URL, with null clearing it and omission meaning unavailable */
    readonly url?: string | null
    /** Server ordering position, not an immutable ordering guarantee */
    readonly position?: number
    /** Parent category ID, with null meaning top-level and omission meaning unavailable */
    readonly parentId?: string | null
    /** Voice bitrate in bits per second, with null meaning no voice setting */
    readonly bitrate?: number | null
    /** Voice user limit, with null meaning no voice setting */
    readonly userLimit?: number | null
    /** Voice connections permitted per user, with null meaning no voice setting */
    readonly voiceConnectionLimit?: number | null
    /** Voice region ID, with null selecting automatic routing */
    readonly rtcRegion?: string | null
    /** Last message ID, with null meaning no known message */
    readonly lastMessageId?: string | null
    /** ISO 8601 last-pin time, with null meaning no pins */
    readonly lastPinTimestamp?: string | null
    /** Explicit channel overwrites, not inherited or effective permissions */
    readonly permissionOverwrites?: readonly PermissionOverwrite[]
    /** Effective adult-content setting from Fluxer's older NSFW field, when supplied */
    readonly nsfw?: boolean
    /** Channel adult-content override, with null inheriting from its category then guild */
    readonly nsfwOverride?: boolean | null
    /** Channel content-warning override, when supplied */
    readonly contentWarningLevel?: number
    /** Custom content-warning text, with null inheriting */
    readonly contentWarningText?: string | null
    /** Slowmode delay in seconds */
    readonly rateLimitPerUser?: number
}

/** Settings shared by new text, voice, category and link channels.
 * Supply the matching type through ChannelCreate. Fluxer decides which settings apply to that channel type and
 * enforces permissions. Omitted permissionOverwrites inherit from the parent category, while [] requests none.
 * Unknown input keys fail locally. The encoded request body must fit within 4,194,304 bytes
 */
export interface ChannelCreateBase {
    /** Nonblank channel name, 1–100 Unicode code points */
    readonly name: string
    /** Description shown for the channel, 1–1,024 Unicode code points, or null to clear */
    readonly topic?: string | null
    /** Absolute URL for a link channel, or null to clear. The SDK does not open or fetch the URL */
    readonly url?: string | null
    /** Parent category, with null or omission creating a top-level channel */
    readonly parentId?: string | null
    /** Voice audio bitrate in bits per second, integer 8,000–384,000 or null, default 64,000 for voice channels.
     * Fluxer clamps the requested value to the guild's enabled bitrate tier. Read the returned channel for the applied value
     */
    readonly bitrate?: number | null
    /** Maximum voice users from 0 through 99, with 0 unlimited and the voice default */
    readonly userLimit?: number | null
    /** Voice connections per user from 1 through 100, default 5 for voice channels */
    readonly voiceConnectionLimit?: number | null
    /** Explicit overrides, omitted to inherit a parent category and [] to create no overrides */
    readonly permissionOverwrites?: readonly PermissionOverwrite[]
    /** Adult-content setting using Fluxer's older NSFW field */
    readonly nsfw?: boolean
    /** Explicit adult-content override, with null inheriting */
    readonly nsfwOverride?: boolean | null
    /** 0 inherits the content-warning level, 1 requests a channel content warning */
    readonly contentWarningLevel?: number
    /** Warning shown before viewing content, at most 200 Unicode code points, with null inheriting */
    readonly contentWarningText?: string | null
    /** Delay between a user's messages in seconds, integer 0–21,600 or null. Zero disables slowmode */
    readonly rateLimitPerUser?: number | null
}

/** Creates a text channel */
export interface TextChannelCreate extends ChannelCreateBase {
    /** Text channel type */
    readonly type: typeof ChannelType.Text
}

/** Creates a voice channel */
export interface VoiceChannelCreate extends ChannelCreateBase {
    /** Voice channel type */
    readonly type: typeof ChannelType.Voice
}

/** Create a category to group guild channels */
export interface CategoryChannelCreate extends ChannelCreateBase {
    /** Category channel type */
    readonly type: typeof ChannelType.Category
}

/** Create a guild channel that points readers to a URL */
export interface LinkChannelCreate extends ChannelCreateBase {
    /** Link channel type */
    readonly type: typeof ChannelType.Link
}

/** One supported guild-channel creation request, with Fluxer positioning a new channel itself */
export type ChannelCreate = TextChannelCreate | VoiceChannelCreate | CategoryChannelCreate | LinkChannelCreate

/** Change settings of an existing guild channel without replacing the channel.
 * Omitted fields stay unchanged. permissionOverwrites replaces the whole explicit list, so preserve entries you
 * still need. Use channels.reorder for category moves and ordering. Unknown keys and an empty patch fail locally.
 * Fluxer checks channel-type compatibility and permissions after local validation
 */
export interface ChannelEdit {
    /** Nonblank channel name, 1–100 Unicode code points */
    readonly name?: string
    /** Channel description, 1–1,024 Unicode code points, or null to clear */
    readonly topic?: string | null
    /** Absolute link-channel URL, or null to clear. No URL is fetched by this request */
    readonly url?: string | null
    /** Voice bitrate in bits per second, integer 8,000–384,000, or null.
     * Fluxer clamps the requested value to the guild's enabled bitrate tier. Read the returned channel for the applied value
     */
    readonly bitrate?: number | null
    /** Maximum voice users, integer 0–99, or null. Zero requests unlimited users */
    readonly userLimit?: number | null
    /** Maximum simultaneous voice connections per user, integer 1–100, or null */
    readonly voiceConnectionLimit?: number | null
    /** Adult-content setting using Fluxer's older NSFW field, with null restoring inheritance */
    readonly nsfw?: boolean | null
    /** Explicit adult-content override, with null inheriting */
    readonly nsfwOverride?: boolean | null
    /** 0 inherits the content-warning level, 1 requests a channel content warning */
    readonly contentWarningLevel?: number
    /** Warning text of at most 200 Unicode code points, with null inheriting */
    readonly contentWarningText?: string | null
    /** Delay between a user's messages in seconds, integer 0–21,600, or null. Zero disables slowmode */
    readonly rateLimitPerUser?: number | null
    /** Replace all explicit overwrites, with [] clearing them and omission preserving them */
    readonly permissionOverwrites?: readonly PermissionOverwrite[]
    /** Voice region ID of 1–64 Unicode code points, with null selecting automatic routing */
    readonly rtcRegion?: string | null
}

/** Move or reorder one existing guild channel as part of channels.reorder.
 * Unlisted channels are not explicit targets. Fluxer applies submitted entries sequentially, so this describes the
 * requested placement rather than a guaranteed final index during concurrent changes
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

/** Visible channel updates delivered together, not a complete guild channel list */
export interface GuildChannelUpdateBulk {
    /** Decimal guild ID */
    readonly guildId: string
    /** Frozen channel snapshots delivered in this dispatch */
    readonly channels: readonly GuildChannel[]
}

/** Settings shared by remote guild-channel operations */
export interface ChannelOperationOptions {
    /** Total milliseconds across local queueing, rate waits, retries and HTTP, integer 1–2,147,483,647, default 30,000.
     * Owned cleanup is awaited afterward, so the call can finish later than this deadline
     */
    readonly timeoutMs?: number
}

/** Default API calls start immediately, with abort cancelling only this call and awaiting owned cleanup */
export interface DefaultChannelOperationOptions extends ChannelOperationOptions, OperationOptions {}

/** The channel action named in an expected failure or SdkDefect */
export type ChannelOperation =
    | "channels.get"
    | "channels.fetch"
    | "channels.fetchAll"
    | "channels.create"
    | "channels.edit"
    | "channels.delete"
    | "channels.reorder"
    | "channels.setPermissionOverwrite"
    | "channels.removePermissionOverwrite"

/** Expected failure when reading or changing guild channels.
 * Read reason to identify the failure and check outcome before retrying a change. Metadata excludes tokens, private
 * input values and upstream response bodies. Default API calls return this error in an Err, while Effect-native calls
 * fail in the typed error channel
 */
export class ChannelOperationError extends Error {
    /** Stable expected-failure discriminator */
    readonly _tag = "ChannelOperationError"
    /** Safe explanation of the locally invalid property, or null when no input problem could be identified */
    readonly inputValidation: InputValidationDetail | null
    constructor(
        /** Requested operation */
        readonly operation: ChannelOperation,
        /** input is local validation failure, busy is full local request capacity, notFound is HTTP 404, and rejected is an API rejection.
         * network is transport failure, response is unusable success data, timeout is an expired deadline,
         * and rateLimit means a required provider wait could not be completed. A 404 is not deletion-success proof
         */
        readonly reason: "input" | "busy" | "notFound" | "rejected" | "network" | "response" | "timeout" | "rateLimit",
        /** notDispatched means no request was submitted, rejected means an API rejection was observed,
         * and unknown means the remote result is uncertain. A write with an unknown outcome may have applied,
         * so inspect remote state before repeating it. A rejection does not prove rollback
         */
        readonly outcome: "notDispatched" | "rejected" | "unknown",
        /** HTTP status when available, otherwise null */
        readonly status: number | null = null,
        /** Usable server-required retry wait in milliseconds, otherwise null */
        readonly retryAfterMs: number | null = null,
        /** Safe classification of why Fluxer rejected the request, or null when the response could not be classified */
        readonly apiError: ApiErrorDetail | null = null,
        inputValidation: InputValidationDetail | null = null,
    ) {
        super(
            operationErrorMessage(
                "Channel",
                operation,
                reason,
                outcome,
                status,
                apiError,
                inputValidation?.explanation ?? null,
                retryAfterMs,
            ),
        )
        this.name = this._tag
        this.inputValidation = freezeInputValidationDetail(inputValidation)
    }
}

/** Native interruption is outside this union, with default API methods additionally returning CancelledError */
export type ChannelOperationFailure = ChannelOperationError | ClientClosedError
