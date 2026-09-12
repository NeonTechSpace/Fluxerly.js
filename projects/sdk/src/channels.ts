import type { OperationOptions } from "./client.js"
import type { ClientClosedError } from "./errors.js"
import { operationErrorMessage, type ApiErrorDetail } from "./api-errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"

/** Numeric Fluxer channel types this SDK can create, with received guild-channel types remaining numeric for forward compatibility */
export const ChannelType = Object.freeze({
    Text: 0,
    Voice: 2,
    Category: 4,
    Link: 998,
})

/** One explicit role or member replacement, not an effective permission calculation. SDK writes advertise ViewChannelMembers replacements to Fluxer */
export interface PermissionOverwrite {
    /** Decimal role or member ID */
    readonly id: string
    /** Whether id identifies a role or a guild member */
    readonly type: "role" | "member"
    /** Unsigned 64-bit raw allow bits */
    readonly allow: bigint
    /** Unsigned 64-bit raw deny bits */
    readonly deny: bigint
}

/** Frozen guild-channel observation from an explicit read or guild channel event, not a live object or permission decision */
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
    /** Effective legacy NSFW setting, when supplied */
    readonly nsfw?: boolean
    /** Channel NSFW override, with null inheriting from its category then guild */
    readonly nsfwOverride?: boolean | null
    /** Channel content-warning override, when supplied */
    readonly contentWarningLevel?: number
    /** Custom content-warning text, with null inheriting */
    readonly contentWarningText?: string | null
    /** Slowmode delay in seconds */
    readonly rateLimitPerUser?: number
}

/** Common fields accepted by Fluxer's supported guild-channel create schemas, with omitted permissionOverwrites inheriting and [] explicitly clearing */
export interface ChannelCreateBase {
    /** Nonblank channel name, 1–100 Unicode code points */
    readonly name: string
    /** Topic, or null to clear */
    readonly topic?: string | null
    /** Link URL, or null to clear */
    readonly url?: string | null
    /** Parent category, with null or omission creating a top-level channel */
    readonly parentId?: string | null
    /** Voice bitrate from 8,000 through 320,000, default 64,000 for voice channels */
    readonly bitrate?: number | null
    /** Maximum voice users from 0 through 99, with 0 unlimited and the voice default */
    readonly userLimit?: number | null
    /** Voice connections per user from 1 through 100, default 5 for voice channels */
    readonly voiceConnectionLimit?: number | null
    /** Explicit overrides, omitted to inherit a parent category and [] to create no overrides */
    readonly permissionOverwrites?: readonly PermissionOverwrite[]
    /** Legacy NSFW setting */
    readonly nsfw?: boolean
    /** Explicit NSFW override, with null inheriting */
    readonly nsfwOverride?: boolean | null
    /** Content-warning override */
    readonly contentWarningLevel?: number
    /** Custom content-warning text, with null inheriting */
    readonly contentWarningText?: string | null
    /** Slowmode seconds, from 0 through 21,600 */
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

/** Creates a category channel */
export interface CategoryChannelCreate extends ChannelCreateBase {
    /** Category channel type */
    readonly type: typeof ChannelType.Category
}

/** Creates a link channel */
export interface LinkChannelCreate extends ChannelCreateBase {
    /** Link channel type */
    readonly type: typeof ChannelType.Link
}

/** One supported guild-channel creation request, with Fluxer positioning a new channel itself */
export type ChannelCreate = TextChannelCreate | VoiceChannelCreate | CategoryChannelCreate | LinkChannelCreate

/** Explicit guild-channel settings patch, with every omitted field unchanged and moves owned by reorder */
export interface ChannelEdit {
    /** Nonblank channel name, 1–100 Unicode code points */
    readonly name?: string
    /** Topic, or null to clear */
    readonly topic?: string | null
    /** Link URL, or null to clear */
    readonly url?: string | null
    /** Voice bitrate in bits per second, or null */
    readonly bitrate?: number | null
    /** Voice user limit, or null */
    readonly userLimit?: number | null
    /** Voice connections permitted per user, or null */
    readonly voiceConnectionLimit?: number | null
    /** Legacy NSFW setting, with null restoring inheritance */
    readonly nsfw?: boolean | null
    /** Explicit NSFW override, with null inheriting */
    readonly nsfwOverride?: boolean | null
    /** Content-warning override */
    readonly contentWarningLevel?: number
    /** Custom content-warning text, with null inheriting */
    readonly contentWarningText?: string | null
    /** Slowmode seconds, or null */
    readonly rateLimitPerUser?: number | null
    /** Replace all explicit overwrites, with [] clearing them and omission preserving them */
    readonly permissionOverwrites?: readonly PermissionOverwrite[]
    /** Voice region ID, with null selecting automatic routing */
    readonly rtcRegion?: string | null
}

/** One partial guild-channel reordering or move request, with Fluxer applying submitted entries sequentially */
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

/** A visibility-filtered bulk guild channel notification, never a complete guild channel list */
export interface GuildChannelUpdateBulk {
    /** Decimal guild ID */
    readonly guildId: string
    /** Frozen channel snapshots delivered in this dispatch */
    readonly channels: readonly GuildChannel[]
}

/** Settings shared by remote guild-channel operations */
export interface ChannelOperationOptions {
    /** Total milliseconds across admission, rate waits, retries and HTTP, integer 1–2,147,483,647, default 30,000 */
    readonly timeoutMs?: number
}

/** Default calls start immediately, with abort cancelling only this call and awaiting owned cleanup */
export interface DefaultChannelOperationOptions extends ChannelOperationOptions, OperationOptions {}

/** Guild-channel operation identified by expected failures and default defects */
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

/** Expected guild-channel failure with safe metadata, never a token, input value or upstream response body */
export class ChannelOperationError extends Error {
    /** Stable expected-failure discriminator */
    readonly _tag = "ChannelOperationError"
    /** SDK-owned local input detail, or null for non-input and unattributable failures */
    readonly inputValidation: InputValidationDetail | null
    constructor(
        /** Requested operation */
        readonly operation: ChannelOperation,
        /** notFound is HTTP 404, not proof that an earlier deletion succeeded */
        readonly reason: "input" | "busy" | "notFound" | "rejected" | "network" | "response" | "timeout" | "rateLimit",
        /** unknown means a write may have applied, rejected is an API rejection and not rollback proof */
        readonly outcome: "notDispatched" | "rejected" | "unknown",
        /** HTTP status when available, otherwise null */
        readonly status: number | null = null,
        /** Usable server-required retry wait in milliseconds, otherwise null */
        readonly retryAfterMs: number | null = null,
        /** Reviewed provider rejection detail, or null when no safe classification is available */
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

/** Native interruption is outside this union, with default methods additionally returning CancelledError */
export type ChannelOperationFailure = ChannelOperationError | ClientClosedError
