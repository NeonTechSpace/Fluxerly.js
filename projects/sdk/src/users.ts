import type { ClientClosedError } from "./errors.js"
import { operationErrorFields, operationErrorSettings, operationErrorText, type ApiErrorDetail } from "./api-errors.js"
import { FluxerlyError, type OperationErrorOptions, type OperationOutcome, type OperationReason } from "./errors.js"
import { freezeInputValidationDetail, type InputValidationDetail } from "./input-validation.js"
import type { Message, MessageCore } from "./messages.js"

/** Public identity of a Fluxer account, suitable for displaying who sent a message or belongs to a conversation.
 * This returned data cannot be changed and does not update when the account changes. It excludes private account fields even for users.fetchSelf.
 * Community nicknames and community-specific profile settings are separate from this account-wide identity
 *
 * @category Users and DMs
 */
export interface User {
    /** Decimal account ID */
    readonly id: string
    /** Account username, not unique by itself */
    readonly username: string
    /** Provider discriminator used with username to distinguish accounts with the same username */
    readonly discriminator: string
    /** Account-wide name shown instead of username where supported, or null when unset. Fluxer names it global_name */
    readonly displayName: string | null
    /** Avatar asset hash, not an image URL, or null when no avatar is supplied */
    readonly avatar: string | null
    /** Dominant avatar color, or null */
    readonly avatarColor: number | null
    /** Whether Fluxer identifies this account as a bot. Fluxer names it bot */
    readonly isBot: boolean
    /** Whether Fluxer identifies this account as a system user. Fluxer names it system */
    readonly isSystem: boolean
    /** Public account flags returned by Fluxer */
    readonly flags: number
    /** Account-wide reply mention preference: 0 for none, 1 to prefer a mention, or 2 to prefer no mention.
     * Absent when Fluxer omits it, which means no preference, and when Fluxer sends a value this SDK version does not
     * know, so a new preference never fails the read. This is descriptive only, and sending and replying keep using
     * explicit AllowedMentions
     */
    readonly mentionFlags?: 0 | 1 | 2
}

/** Choose whether users.fetchProfile also asks for profile customization in one community.
 * Omit guildId for the account-wide profile. This request does not list mutual communities or relationships and does not
 * fetch a GuildMember
 *
 * @category Users and DMs
 */
export interface UserProfileQuery {
    /** Decimal guild ID whose profile settings to include when Fluxer supplies them */
    readonly guildId?: string
}

/** Displayable biography, pronouns and visual customization from a profile read.
 * Null can mean either that the value is unset or that Fluxer hid it for privacy. These fields alone cannot distinguish those cases.
 * Undefined bannerColor means Fluxer did not supply it
 *
 * @category Users and DMs
 */
export interface UserProfileFields {
    /** Biography, null when absent or hidden by profile privacy */
    readonly bio: string | null
    /** Pronouns, null when absent or hidden by profile privacy */
    readonly pronouns: string | null
    /** Banner hash, or null when absent or withheld by Fluxer */
    readonly banner: string | null
    /** Account-profile banner color when Fluxer supplies it. Community-specific profiles do not supply this field */
    readonly bannerColor?: number | null
    /** Packed profile accent color, or null */
    readonly accentColor: number | null
}

/** One public badge from a profile read, with what a client needs to draw it.
 * Fluxer can add badge kinds, so draw an unknown kind from label, asset, assetUrl and caption like any other
 *
 * @category Users and DMs
 */
export interface ProfileBadge {
    /** Stable identity, unique within the list. It equals kind for a built-in badge and is custom:{id} for a custom badge */
    readonly key: string
    /** Badge type, such as staff, partner, bug_hunter, operator_pass, visionary, visionary_number, plutonium, custom or premium.
     * Other strings are kinds this SDK version does not know, kept as Fluxer sent them
     */
    readonly kind:
        | "staff"
        | "partner"
        | "bug_hunter"
        | "operator_pass"
        | "visionary"
        | "visionary_number"
        | "plutonium"
        | "custom"
        | "premium"
        | (string & {})
    /** Full description localized for the viewer, for a tooltip, and alt text when caption is null */
    readonly label: string
    /** Image hash served at the instance's static CDN as badges/{asset}.webp, or null for a text badge or one with assetUrl */
    readonly asset: string | null
    /** Absolute image URL for a badge without a static image hash, such as a custom badge, or null */
    readonly assetUrl: string | null
    /** Image hash to use instead of asset at 20 pixels and smaller, when Fluxer supplies one */
    readonly smallAsset?: string
    /** Image width divided by its height, or null for a square badge */
    readonly aspectRatio: number | null
    /** Short text such as #42: Alt text for a badge with an image, and the shown text for one without. Null when label covers it */
    readonly caption: string | null
    /** Absolute URL to open when the badge is clicked, or null */
    readonly href: string | null
    /** How many passes the badge stands for, from 2. The badge art already shows it, so do not draw it again */
    readonly count?: number
    /** Screen reader label with the full count, used instead of label when present */
    readonly accessibleLabel?: string
    /** Richer tooltip content, absent when label is the whole tooltip */
    readonly details?: {
        /** First line of the tooltip, shown under the larger badge art */
        readonly title: string
        /** Further tooltip lines, in order */
        readonly lines: readonly string[]
    }
    /** The holder's quote from Fluxer's Operators' wall, absent while the wall does not show it or Fluxer sends null.
     * It is plain text: Show it in straight double quotes after the other tooltip lines and never parse it as markup
     */
    readonly quote?: string
}

/** Result of users.fetchProfile, combining public identity with the profile information Fluxer allowed this caller to see.
 * Account-wide and community-specific settings remain separate. The frozen result excludes relationships, connections,
 * timezone and premium details, and does not populate user or member caches
 *
 * @category Users and DMs
 */
export interface UserProfile {
    /** Public account identity returned with this profile, without updating the cache.
     * Fluxer's guild_member field, sent for a read with guildId, is checked against the requested account and community
     * and then left out, because this result does not decode community members. Use members.fetch for the member, or a
     * raw client.rest.request GET of /users/{user_id}/profile with query guild_id for Fluxer's complete body
     */
    readonly user: User
    /** Account-wide profile fields the SDK includes */
    readonly profile: UserProfileFields
    /** Explicit community-context profile fields, or null when Fluxer did not supply them. Null does not establish membership */
    readonly guildProfile: UserProfileFields | null
    /** Whether Fluxer limited this read by profile privacy. Its omitted unrestricted marker becomes false */
    readonly isLimited: boolean
    /** Public badges in Fluxer's display order, when supplied by the instance. Fluxer applies profile visibility before
     * returning this list, and an empty list means there is nothing to show
     */
    readonly profileBadges?: readonly ProfileBadge[]
}

/** A one-to-one direct message or group conversation outside a community.
 * Pass id to the messages API to address this conversation. The frozen snapshot describes returned settings and
 * recipients, not current access or proof that a later message can be delivered
 *
 * @category Users and DMs
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
    /** Supplied nickname overrides, keyed by decimal user ID. Fluxer names it nicks */
    readonly nicknames: Readonly<Record<string, string>>
    /** Last message ID supplied by Fluxer, or null. Kept from when the conversation was observed. Sending messages does not
     * update a cached conversation's value, so fetch it for a current value
     */
    readonly lastMessageId: string | null
    /** ISO 8601 time of the most recent pin, or null when nothing was ever pinned. Unpinning does not clear it. Absent when
     * Fluxer omits it
     */
    readonly lastPinTimestamp?: string | null
    /** Whether the group is marked as adult content. Fluxer sends it only for groups, so it is absent for a one-to-one DM */
    readonly nsfw?: boolean
}

/** Rename a group conversation, change its icon or nicknames, or transfer its ownership.
 * Omitted fields remain unchanged. This does not create a group or add recipients. Fluxer enforces membership and
 * ownership, and an error after dispatch does not prove that earlier changes were rolled back
 *
 * @category Users and DMs
 */
export interface DirectMessageGroupEdit {
    /** Group name, or null or an empty string to clear it, as Fluxer reads an empty string as null here. Raw input may
     * contain at most 10,000 UTF-16 code units. For validation,
     * Fluxer's general-name rules remove U+000C and U+202E, trim surrounding whitespace, strip provider-defined
     * invisible characters, normalize whitespace and collapse its runs, then require 1–100 UTF-16 code units. The SDK
     * sends the original string without lowercasing or hyphenating it
     */
    readonly name?: string | null
    /** Base64 image data or data URI, or null or an empty string to clear. Fluxer validates the image, and base64 with nonzero bits before
     * its = padding fails locally. The encoded edit may hold up to 15,029,592 bytes,
     * the most Fluxer accepts for this route, so the icon can be as large as Fluxer allows, 10 MiB by default
     */
    readonly icon?: string | null
    /** Transfer ownership to an existing non-bot recipient. Requires current ownership. Fluxer reads an empty string
     * as null and then ignores the field, so it changes nothing
     */
    readonly ownerId?: string
    /** Nicknames keyed by user ID. A nickname must contain at most 32 UTF-16 code units after U+000C and U+202E removal
     * and surrounding-whitespace trimming. The original string is sent unchanged, and null, an empty string or a blank
     * string clears that nickname. Non-owners may change only their own.
     * Fluxer reads an empty object, or one whose values are all null or empty strings, as null for the whole field,
     * which clears every nickname in the group and needs ownership, so a non-owner's request then fails with reason
     * `rejected`. To clear only the listed nicknames, use a blank string such as `" "`, which Fluxer keeps until it
     * trims it and clears that nickname. Fluxer names it nicks
     */
    readonly nicknames?: Readonly<Record<string, string | null>> | null
}

/**
 * The account added to or removed from a group conversation, as Fluxer sent it. No automatic user fetch
 *
 * @category Events and collectors
 */
export interface DirectMessageRecipientChange {
    /** Affected private channel */
    readonly channelId: string
    /** Added or removed account */
    readonly userId: string
    /** Public identity of that account at the time of the change, absent when Fluxer's account data is incomplete */
    readonly user?: User
}

/** Latest-message lookup results for the selected private channel IDs.
 * Look in messages for returned IDs and omittedChannelIds for requested IDs missing from the response.
 * A channel returned with null differs from a channel missing from the response. Neither explains why no message was returned
 *
 * @category Users and DMs
 */
export interface DirectMessageLatestMessages<M extends MessageCore = Message> {
    /** Returned entries keyed by requested channel ID. Null is ambiguous and does not prove an empty channel or access denial */
    readonly messages: Readonly<Record<string, M | null>>
    /** Requested IDs omitted by Fluxer, in input order. Omission is distinct from a returned null */
    readonly omittedChannelIds: readonly string[]
}

/**
 * User/private-conversation operation named by safe failure metadata
 *
 * @category Errors
 */
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
 * input values and upstream bodies. Default API methods return this error in an Err, while Effect methods fail
 * in the typed error channel
 *
 * @category Errors
 */
export class UserOperationError extends FluxerlyError {
    /** Stable failure discriminator */
    readonly _tag = "UserOperationError"
    /** Requested operation */
    readonly operation: UserOperation
    /** Failure category, described by {@link OperationReason} */
    readonly reason: OperationReason
    /** Whether the request may have reached Fluxer, described by {@link OperationOutcome}.
     * Reconcile an unknown group edit, close or recipient removal before repeating it
     */
    readonly outcome: OperationOutcome
    /** HTTP status when received */
    readonly status: number | null
    /** Fluxer's retry delay in milliseconds when available */
    readonly retryAfterMs: number | null
    /** Safe classification of why Fluxer rejected the request, or null when the response could not be classified */
    readonly apiError: ApiErrorDetail | null
    /** Safe explanation of the locally invalid property, or null when no input problem could be identified */
    readonly inputValidation: InputValidationDetail | null
    /** Create the failure from its operation, reason and outcome, with optional status, retry wait, API detail, input detail and cause */
    constructor(options: OperationErrorOptions<UserOperation>) {
        const fields = operationErrorFields(options)
        super(operationErrorText("User", fields), operationErrorSettings("user", fields, options.cause))
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
 * Cancellation in the default API additionally returns CancelledError. Native interruption remains in the Effect cause
 *
 * @category Errors
 */
export type UserOperationFailure = UserOperationError | ClientClosedError
