import type { ClientClosedError } from "./errors.js"
import { operationErrorMessage, type ApiErrorDetail } from "./api-errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"
import type { MessageOperationOptions } from "./messages.js"
import type { Message, MessageCore } from "./messages.js"
import type { OperationOptions } from "./client.js"

/** Public identity of a Fluxer account, suitable for displaying who sent a message or belongs to a conversation.
 * This frozen snapshot does not update in place. It excludes private account fields even for users.fetchSelf.
 * Guild nicknames and guild-specific profile settings are separate from this account-wide identity
 */
export interface User {
    /** Decimal account ID */
    readonly id: string
    /** Account username, not unique by itself */
    readonly username: string
    /** Provider discriminator used with username to distinguish accounts with the same username */
    readonly discriminator: string
    /** Account-wide name shown instead of username where supported, or null when unset */
    readonly displayName: string | null
    /** Avatar asset hash, not an image URL, or null when no avatar is supplied */
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

/** Choose whether users.fetchProfile also asks for profile customization in one guild.
 * Omit guildId for the account-wide profile. This request does not list mutual guilds or relationships and does not
 * fetch a GuildMember for you
 */
export interface UserProfileQuery {
    /** Decimal guild ID whose profile settings to include when Fluxer supplies them */
    readonly guildId?: string
}

/** Displayable biography, pronouns and visual customization from a profile read.
 * Null can mean either unset or withheld by profile privacy. These fields alone cannot distinguish those cases.
 * Undefined bannerColor means Fluxer did not supply it
 */
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

/** Result of users.fetchProfile, combining public identity with the profile information Fluxer allowed this caller to see.
 * Account-wide and guild-specific settings remain separate. The frozen result excludes relationships, connections,
 * timezone and premium details, and does not populate user or member caches
 */
export interface UserProfile {
    /** Public account identity returned with this profile, without updating the cache */
    readonly user: User
    /** Account-wide profile fields the SDK includes */
    readonly profile: UserProfileFields
    /** Explicit guild-context profile fields, or null when Fluxer did not supply them. Null does not establish membership */
    readonly guildProfile: UserProfileFields | null
    /** Whether Fluxer limited this read by profile privacy. Its omitted unrestricted marker becomes false */
    readonly isLimited: boolean
}

/** A one-to-one direct message or group conversation outside a guild.
 * Pass id to the messages API to address this conversation. The frozen snapshot describes returned settings and
 * recipients, not current access or proof that a later message can be delivered
 */
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

/** Rename a group conversation, change its icon or nicknames, or transfer its ownership.
 * Omitted fields remain unchanged. This does not create a group or add recipients. Fluxer enforces membership and
 * ownership, and an error after dispatch does not prove that earlier changes were rolled back
 */
export interface DirectMessageGroupEdit {
    /** Group name, 1–100 code points, or null to clear it */
    readonly name?: string | null
    /** Image data URI, or null to clear. Fluxer validates the image */
    readonly icon?: string | null
    /** Transfer ownership to an existing non-bot recipient. Requires current ownership */
    readonly ownerId?: string
    /** Nicknames of 1–32 code points, or null to clear a nickname. Non-owners may change only their own */
    readonly nicknames?: Readonly<Record<string, string | null>> | null
}

/** IDs accompanying a private-channel recipient change. No automatic user fetch */
export interface DirectMessageRecipientChange {
    /** Affected private channel */
    readonly channelId: string
    /** Added or removed account */
    readonly userId: string
}

/** Latest-message lookup results for the private channel IDs you selected.
 * Look in messages for returned IDs and omittedChannelIds for requested IDs missing from the response.
 * A returned null is a different result from an omitted ID and does not establish why no message was returned
 */
export interface DirectMessageLatestMessages<M extends MessageCore = Message> {
    /** Returned entries keyed by requested channel ID. Null is ambiguous and does not prove an empty channel or access denial */
    readonly messages: Readonly<Record<string, M | null>>
    /** Requested IDs omitted by Fluxer, in input order. Omission is distinct from a returned null */
    readonly omittedChannelIds: readonly string[]
}

/** Request deadline settings shared with message operations.
 * timeoutMs defaults to 30,000 milliseconds across local queueing, rate waits, retries and transport.
 * Cleanup is awaited after the deadline and can make completion take longer
 */
export interface UserOperationOptions extends MessageOperationOptions {}

/** Default API operations begin immediately. Abort interrupts only this operation and does not roll back remote changes */
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

/** Expected failure from account reads or private-conversation operations.
 * Inspect operation to identify the failed step and outcome before repeating a write. Metadata excludes private
 * input values and upstream bodies. Default API methods return this error in an Err, while Effect-native methods fail
 * in the typed error channel
 */
export class UserOperationError extends Error {
    /** Stable failure discriminator */
    readonly _tag = "UserOperationError"
    /** Safe explanation of the locally invalid property, or null when no input problem could be identified */
    readonly inputValidation: InputValidationDetail | null
    constructor(
        /** Requested operation */
        readonly operation: UserOperation,
        /** input is local validation failure, busy is full local request capacity, notFound is HTTP 404, and rejected is an API rejection.
         * network is transport failure, response is unusable success data, timeout is an expired deadline,
         * and rateLimit means a required provider wait could not be completed. HTTP failures retain status, not bodies
         */
        readonly reason: "input" | "busy" | "notFound" | "rejected" | "network" | "response" | "timeout" | "rateLimit",
        /** notDispatched means no request was submitted, rejected means an API rejection was observed,
         * and unknown means the remote result is uncertain. Unknown writes may already have applied, so reconcile
         * before repeating a group edit, close or recipient removal. A rejection does not prove rollback
         */
        readonly outcome: "notDispatched" | "rejected" | "unknown",
        /** HTTP status when received */
        readonly status: number | null = null,
        /** Provider retry delay in milliseconds when available */
        readonly retryAfterMs: number | null = null,
        /** Safe classification of why Fluxer rejected the request, or null when the response could not be classified */
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

/** Cancellation in the default API additionally returns CancelledError. Native interruption remains in the Effect cause */
export type UserOperationFailure = UserOperationError | ClientClosedError
