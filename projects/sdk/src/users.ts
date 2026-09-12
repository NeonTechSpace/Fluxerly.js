import type { ClientClosedError } from "./errors.js"
import { operationErrorMessage, type ApiErrorDetail } from "./api-errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"
import type { MessageOperationOptions } from "./messages.js"
import type { Message } from "./messages.js"
import type { OperationOptions } from "./client.js"

/** Frozen public account identity, excluding private fields even when fetched through /users/@me */
export interface User {
    /** Decimal account ID */
    readonly id: string
    /** Account username, not unique by itself */
    readonly username: string
    /** Provider discriminator */
    readonly discriminator: string
    /** Global display name, or null */
    readonly displayName: string | null
    /** Avatar hash, not an image URL */
    readonly avatar: string | null
    /** Dominant avatar color, or null */
    readonly avatarColor: number | null
    /** Whether Fluxer identifies this account as a bot */
    readonly isBot: boolean
    /** Whether Fluxer identifies this account as a system user */
    readonly isSystem: boolean
    /** Public account flags returned by Fluxer */
    readonly flags: number
}

/** Optional explicit guild context for one remote profile read. It does not request mutuals, relationships, or member hydration */
export interface UserProfileQuery {
    /** Decimal guild ID whose returned guild-specific profile is projected when Fluxer supplies it */
    readonly guildId?: string
}

/** Frozen allowlisted account or guild-specific profile fields. Undefined bannerColor means Fluxer did not supply it */
export interface UserProfileFields {
    /** Biography, null when absent or hidden by profile privacy */
    readonly bio: string | null
    /** Pronouns, null when absent or hidden by profile privacy */
    readonly pronouns: string | null
    /** Banner hash, or null when absent or withheld by Fluxer */
    readonly banner: string | null
    /** Account-profile banner colour when Fluxer supplies it. Guild-specific profiles do not supply this field */
    readonly bannerColor?: number | null
    /** Packed profile accent colour, or null */
    readonly accentColor: number | null
}

/** Frozen privacy-aware profile observation without relationship, connection, timezone, premium, or cache state */
export interface UserProfile {
    /** Public account identity from this profile response, never a cache hydration */
    readonly user: User
    /** Account-wide allowlisted profile fields */
    readonly profile: UserProfileFields
    /** Explicit guild-context profile fields, or null when Fluxer did not supply them. Null does not establish membership */
    readonly guildProfile: UserProfileFields | null
    /** Whether Fluxer limited this read by profile privacy. Its omitted unrestricted marker becomes false */
    readonly isLimited: boolean
}

/** Frozen private-channel observation, not proof that a message can be delivered */
export interface DirectMessageChannel {
    /** Decimal channel ID, accepted by the existing messages API */
    readonly id: string
    /** Explicitly distinguishes one-to-one and group conversations */
    readonly type: "dm" | "group"
    /** Public recipient snapshots supplied by Fluxer, not necessarily including the current bot */
    readonly recipients: readonly User[]
    /** Group name, or null when absent */
    readonly name: string | null
    /** Group icon hash, or null */
    readonly icon: string | null
    /** Group owner ID, or null for a one-to-one DM */
    readonly ownerId: string | null
    /** Supplied nickname overrides, keyed by decimal user ID */
    readonly nicknames: Readonly<Record<string, string>>
    /** Last message ID supplied by Fluxer, or null */
    readonly lastMessageId: string | null
}

/** Explicit group updates. Omitted fields remain unchanged; Fluxer enforces membership and ownership */
export interface DirectMessageGroupEdit {
    /** Group name, 1–100 code points */
    readonly name?: string
    /** Image data URI, or null to clear. Fluxer validates the image */
    readonly icon?: string | null
    /** Transfer ownership to an existing non-bot recipient. Requires current ownership */
    readonly ownerId?: string
    /** Nicknames of 1–32 code points, or null to clear a nickname. Non-owners may change only their own */
    readonly nicknames?: Readonly<Record<string, string | null>> | null
}

/** IDs accompanying a private-channel recipient change; no automatic user fetch */
export interface DirectMessageRecipientChange {
    /** Affected private channel */
    readonly channelId: string
    /** Added or removed account */
    readonly userId: string
}

/** Frozen latest-message batch result for explicitly selected private channels */
export interface DirectMessageLatestMessages {
    /** Returned entries keyed by requested channel ID. Null is ambiguous and does not prove an empty channel or access denial */
    readonly messages: Readonly<Record<string, Message | null>>
    /** Requested IDs omitted by Fluxer, in input order. Omission is distinct from a returned null */
    readonly omittedChannelIds: readonly string[]
}

/** Request deadlines include queueing, rate waits and transport cleanup */
export interface UserOperationOptions extends MessageOperationOptions {}

/** Default operations begin immediately; abort interrupts only this operation and does not roll back remote changes */
export interface DefaultUserOperationOptions extends UserOperationOptions, OperationOptions {}

/** User/private-conversation operation named by safe failure metadata */
export type UserOperation =
    | "users.fetch"
    | "users.fetchSelf"
    | "users.fetchProfile"
    | "users.get"
    | "directMessages.open"
    | "directMessages.fetch"
    | "directMessages.fetchAll"
    | "directMessages.fetchLatestMessages"
    | "directMessages.get"
    | "directMessages.editGroup"
    | "directMessages.close"
    | "directMessages.removeRecipient"

/** Expected user/private-channel failure without upstream bodies or private input values */
export class UserOperationError extends Error {
    /** Stable failure discriminator */
    readonly _tag = "UserOperationError"
    /** SDK-owned local input detail, or null for non-input and unattributable failures */
    readonly inputValidation: InputValidationDetail | null
    constructor(
        /** Requested operation */
        readonly operation: UserOperation,
        /** HTTP failures retain status, not the provider's response body */
        readonly reason: "input" | "busy" | "notFound" | "rejected" | "network" | "response" | "timeout" | "rateLimit",
        /** Unknown writes may already have applied; do not blindly repeat a group edit, close, or recipient removal */
        readonly outcome: "notDispatched" | "rejected" | "unknown",
        /** HTTP status when received */
        readonly status: number | null = null,
        /** Provider retry delay in milliseconds when available */
        readonly retryAfterMs: number | null = null,
        /** Reviewed provider rejection detail, or null when no safe classification is available */
        readonly apiError: ApiErrorDetail | null = null,
        inputValidation: InputValidationDetail | null = null,
    ) {
        super(
            operationErrorMessage(
                "User",
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

/** Default interruption additionally returns CancelledError; native interruption remains in the Effect cause */
export type UserOperationFailure = UserOperationError | ClientClosedError
